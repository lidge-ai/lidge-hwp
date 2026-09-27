import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { persistDocument } from '../../lib/persist.mjs';
import { lastCommit } from '../../lib/git.mjs';
import { openDocument, exportWithReport } from '../../lib/rhwp-node.mjs';
import { fallbackPatch } from '../../lib/kordoc-fallback.mjs';
import { applyOp, applyCall, readApi, newBatch, readView, validateBatch, sha } from '../../lib/ops.mjs';
import { apiHelp, REGISTRY, HELPERS } from '../../lib/api-registry.mjs';
import { format, paraFormat, getFormat, styles, applyStyle } from '../../lib/format.mjs';
import { selectAll } from '../../lib/scope.mjs';
import { STRUCTURE } from '../../lib/structure.mjs';
import { insertTextHelper, setCellHelper } from '../../lib/text-helpers.mjs';
import { wireError } from './wire-error.mjs';
import { renderDocument, cliPageCountOf } from '../../lib/render.mjs';
import { createPageView } from '../../lib/page-view.mjs';
import { EXPORTS_ROOT, RHWP_BIN } from '../../lib/config.mjs';
const MUTATE_HELPERS = { format, paraFormat, applyStyle, ...STRUCTURE };
import { contentSignature } from '../../lib/signature.mjs';
// 탭이 agent.release에 답할 한도. 채널은 진행 중인 apply가 확정될 때까지 release를 미루므로 apply 뒤처리 시간을 덮는다.
const RELEASE_DEADLINE_MS = 45000;
// wp5 시간 예산: 따라가기·여는 중 탭 기다림·prepare·에이전트 코드가 한 마감(start + timeoutMs)을 나눠 쓴다(아래 "시간 예산").
// 기다림은 마감에서 5초(prepare와 코드 몫)를 남긴 만큼, prepare는 2초(코드 몫)를 남긴 만큼만 쓴다.
const FOLLOW_MAX_MS = 15000, FOLLOW_CODE_RESERVE_MS = 5000, FOLLOW_MIN_MS = 2000;
const PREPARE_MAX_MS = 30000, PREPARE_CODE_RESERVE_MS = 2000, PREPARE_MIN_MS = 1000;

export function followCompletion({ saved, source, disk, diskError, applySave, tabConfirmed }) {
  if (saved.length || applySave === 'committed') return 'committed';
  if (applySave === 'pending' || applySave === 'unknown') return 'unknown';
  if (!source) return 'none';
  if (diskError || !disk) return 'unknown';
  if (disk.sha256 !== source.sha256) return 'committed';
  return tabConfirmed === false ? 'unknown' : 'none';
}

export function projectResult(result, follow) {
  if (!follow) return result;
  const { from, to, outcome, code, completion } = follow;
  return { ...result, follow: { from, to, outcome,
    ...(code !== undefined ? { code } : {}), ...(completion !== undefined ? { completion } : {}) } };
}

export async function runAgent({ code, timeoutMs = 30000 },
    { store, tabs, config }) {
  const start = Date.now();
  const exporter = config.exporter ?? exportWithReport;
  const openDoc = config.openDocument ?? openDocument;
  const rhwpBin = config.rhwpBin ?? RHWP_BIN;
  const historyFor = store.historyFor ? id => store.historyFor(id)
    : async id => ({ workTree: store.root, gitDir: null, path: id });
  const exportRoots = store.exportRoots ? () => store.exportRoots() : () => [store.root];
  const exportPath = store.exportPath ? id => store.exportPath(id) : id => id;
  if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 65536 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    return { ok: false, error: 'invalid code or timeoutMs', logs: [], elapsedMs: Date.now() - start, saved: [] };
  let state, lockToken, closed = false, worker, timer, attemptedDocId = null, applyRequestId = null;
  let opened = false; // 한 invocation에 open은 성공·실패와 무관하게 한 번만 허용한다
  let prepareLease = null, prepareToken = null; // 탭 잠금 토큰(= prepare requestId). 실패해도 finally가 release한다
  // 탭 해제는 한 번만. 성공 반환 전과 finally가 같은 promise를 쓰고, 문서 잠금은 이것이 끝난 뒤에만 푼다.
  let releasing = null;
  const releaseTab = () => releasing ??= (async () => {
    if (state?.lease) await tabs.waitAgentSave?.(state.lease);
    if (!prepareLease || !prepareToken) return { confirmed: true, reloadRequired: false };
    try {
      const released = await tabs.requestAgent(prepareLease, 'agent.release', {
        token: prepareToken, reason: 'finished', ...(state?.reload ? { reload: state.reload } : {}),
      }, config.releaseDeadlineMs ?? RELEASE_DEADLINE_MS); // 테스트만 config로 줄인다
      return { confirmed: released.tab?.isolated !== true, reloadRequired: released.tab?.reloadRequired === true };
    } catch (error) {
      // 탭이 제때 답하지 않았다(apply를 아직 마무리 중일 수 있다). 임대를 격리해 늦은 PUT·새 prepare·사람 PUT을
      // 409로 막은 뒤에만 문서 잠금을 푼다. SSE가 이미 끊겼으면(TAB_DISCONNECTED) 임대는 이미 해제됐다.
      if (error.code === 'AGENT_REPLY_TIMEOUT') tabs.isolate?.(prepareLease);
      return { confirmed: false, reloadRequired: Boolean(state?.reload) };
    }
  })();
  // 한 마감. 코드 타이머(102행)와 같은 timeoutMs에서 시작하므로, 이 마감 안의 기다림은 코드 타이머보다 늦게 끝나지 않는다.
  // (코드 타이머가 먼저 울려도 runner는 진행 중인 host 호출을 기다린다(117행). 예전 prepare 30초는 그래서 코드 한도를 넘길 수 있었다.)
  const deadline = start + timeoutMs;
  const left = reserveMs => deadline - Date.now() - reserveMs;
  // wp5 따라가기. 문서 잠금(store.lock)은 이미 쥐고 있어 사람 PUT은 423, 일반 claim도 423이다(index.mjs). 예약 claim만 통과한다.
  // 붙은 임대를 돌려주거나, null(디스크 경로)을 돌려주거나, 셸이 X를 쥔 채 남았으면 TAB_CONNECTING을 던진다.
  let follow = null; // 결과에 싣는다: {from, to, outcome: followed|declined|failed|skipped, code?}
  async function followShell(id, ms) {
    const target = tabs.followTarget?.(id);
    if (!target) return null;
    follow = { from: target.docId, to: id, outcome: 'skipped' };
    if (ms < (config.followMinMs ?? FOLLOW_MIN_MS)) { follow.code = 'NO_TIME'; return null; }
    const followEnd = Date.now() + ms; // ms는 이미 한 마감에서 잘라 온 값이다(waitMs)
    const reservation = tabs.reserve(id, ms + 1000);
    if (!reservation) { follow.code = 'RESERVE_FAILED'; return null; }
    try {
      try {
        await tabs.requestAgent(target.lease, 'agent.follow', { targetDocId: id, reservation }, ms);
      } catch (error) {
        // DIRTY·SAVING·BUSY·ISOLATED(셸 거절), AGENT_REPLY_TIMEOUT, TAB_DISCONNECTED → 디스크 경로
        follow.outcome = 'declined'; follow.code = error.code || error.message;
        return null;
      }
      const lease = await tabs.waitConnected(id, { reservation, ms: followEnd - Date.now() });
      follow.lease = lease;
      follow.outcome = 'followed';
      return lease;
    } catch (error) {
      // 수락 뒤 불러오기 실패·예약 반납·시간 초과. prepare 전이라 탭에도 디스크에도 적용한 것이 없다.
      follow.outcome = 'failed'; follow.code = error.code || error.message;
      if (tabs.owner(id) || tabs.claimed?.(id)) throw new Error('TAB_CONNECTING'); // 셸이 X를 쥔 채 남았다: 디스크에 쓰지 않는다
      return null;
    } finally {
      follow.lease ??= tabs.reservationLease?.(reservation) ?? null;
      tabs.cancelReservation(reservation);
    }
  }
  const waitMs = () => Math.min(config.followMaxMs ?? FOLLOW_MAX_MS, left(FOLLOW_CODE_RESERVE_MS));
  async function prepareAndVerify(lease, disk, expectedReadSha = null) {
    if (tabs.isIsolated?.(lease)) throw new Error('LEASE_ISOLATED');
    const prepareMs = Math.min(PREPARE_MAX_MS, left(PREPARE_CODE_RESERVE_MS));
    if (prepareMs < PREPARE_MIN_MS) throw new Error('NO_TIME_FOR_PREPARE');
    prepareLease = lease;
    let prepared;
    try { prepared = await tabs.requestAgent(lease, 'agent.prepare', { format: disk.format }, prepareMs); }
    catch (error) { prepareToken = error.requestId ?? null; throw error; }
    prepareToken = prepared.requestId;
    if (prepared.state?.format !== disk.format) throw new Error('FORMAT_MISMATCH');
    if (expectedReadSha && (prepared.state.dirty || prepared.exportSha256 !== expectedReadSha
      || sha(prepared.bytes) !== expectedReadSha)) {
      throw Object.assign(new Error('TAB_CHANGED_DURING_FOLLOW'), {
        code: 'TAB_CHANGED_DURING_FOLLOW', retryable: true,
        hashes: { snapshotSha256: prepared.state?.documentSha256 ?? null,
          exportSha256: prepared.exportSha256, tabDiskSha256: prepared.diskSha256 },
      });
    }
    if (prepared.contentLoss.count > 0 && prepared.state.dirty) throw new Error('DIRTY_TAB_KORDOC_UNSAFE');
    if (prepared.diskSha256 !== disk.sha256) throw new Error('ETAG_MISMATCH');
    if (sha(prepared.bytes) !== prepared.exportSha256) {
      throw Object.assign(new Error('SNAPSHOT_HASH_MISMATCH'), { code: 'SNAPSHOT_HASH_MISMATCH', retryable: false,
        hashes: { snapshotSha256: prepared.state?.documentSha256 ?? null,
          exportSha256: sha(prepared.bytes), tabDiskSha256: prepared.diskSha256 } });
    }
    return prepared;
  }
  async function followBeforeMutation() {
    if (state.followPrepareFailed) throw new Error('FOLLOW_PREPARE_FAILED');
    if (!state.pendingFollow || state.batch.ops.length) return;
    state.pendingFollow = false;
    if (!state.followAllowed) return;
    if (!tabs.followTarget?.(state.id)) return;
    try {
      const disk = await store.read(state.id);
      if (disk.sha256 !== state.source.sha256) throw new Error('ETAG_MISMATCH');
      const lease = await followShell(state.id, waitMs());
      if (!lease) return;
      const currentDisk = await store.read(state.id);
      if (currentDisk.sha256 !== disk.sha256) throw new Error('ETAG_MISMATCH');
      const prepared = await prepareAndVerify(lease, currentDisk, state.source.sha256);
      const source = { bytes: prepared.contentLoss.count > 0 ? disk.bytes : prepared.bytes,
        sha256: disk.sha256, format: disk.format };
      const doc = await openDoc(source.bytes);
      state.pages.close();
      state.doc.free();
      state.doc = doc;
      state.source = source;
      state.lease = lease;
      state.prepared = prepared;
      state.batch = newBatch({ diskSha256: source.sha256,
        documentEpoch: prepared.state.documentEpoch, changeSeq: prepared.state.changeSeq,
        exportSha256: prepared.exportSha256 });
      state.pages = createPageView({ source, getGen: () => state.batch.ops.length, getDoc: () => state.doc,
        format: source.format, exporter, openDocument: openDoc, cliPageCount: config.cliPageCount ?? cliPageCountOf,
        rhwpBin, deadline });
    } catch (error) {
      state.followPrepareFailed = true;
      throw error;
    }
  }
  const active = new Set();
  const saved = [];
  // host 호출은 한 invocation 안에서 하나씩 순서대로 실행한다. 겹친 open이 서로의 state·lockToken을
  // 덮어쓰지 못하게 하고, timeout 때는 closed=true 뒤 대기 중인 호출이 시작 시점에 거절된다.
  let hostChain = Promise.resolve();
  const hostSerial = (name, args) => { const next = hostChain.then(() => host(name, args)); hostChain = next.catch(() => {}); return next; };
  const host = async (name, args) => {
    if (closed) throw new Error('invocation closed');
    if (name === 'docs') return store.list();
    if (name === 'help') return apiHelp(HELPERS);
    if (name === 'selectAll') return selectAll();
    if (name === 'open') {
      const id = args[0];
      const options = args[1] ?? {};
      if (!options || typeof options !== 'object' || Array.isArray(options)
          || Object.keys(options).some(key => key !== 'follow')
          || (options.follow !== undefined && typeof options.follow !== 'boolean'))
        throw new Error('OPEN_OPTIONS_INVALID');
      if (opened) {
        // 같은 호출에서 같은 문서를 다시 열면 기존 핸들을 준다(잠금·follow·prepare를 다시 하지 않는다). 다른 문서와 실패한 첫 open 뒤는 거절한다.
        if (state && id === state.id) {
          if ((options.follow !== false) !== state.followAllowed) throw new Error('OPEN_FOLLOW_CONFLICT');
          return state.handle;
        }
        throw new Error('one document per invocation');
      }
      opened = true; // 비동기 작업 전에 자리를 먼저 잡는다
      await store.resolveId(id);
      attemptedDocId = id;
      lockToken = store.lock(id);
      if (!lockToken) throw new Error('DOCUMENT_LOCKED');
      let source, doc, lease = null, prepared = null;
      try {
        // 기다림 한도: 한 마감에서 prepare와 코드 몫(5초)을 남긴 나머지, 최대 15초.
        if (tabs.claimed?.(id)) {
          // 여는 중인 탭: 붙기를 기다린다. 끝내 못 붙으면 디스크에 쓰지 않고 실패한다(곧 사람 편집이 시작될 바이트다).
          lease = await tabs.waitConnected(id, { ms: waitMs() }).catch(() => { throw new Error('TAB_CONNECTING'); });
        } else lease = tabs.owner(id);
        if (lease && tabs.isIsolated?.(lease)) throw new Error('LEASE_ISOLATED');
        const disk = await store.read(id);
        if (lease) {
          prepared = await prepareAndVerify(lease, disk);
          source = { bytes: prepared.contentLoss.count > 0 ? disk.bytes : prepared.bytes,
            sha256: disk.sha256, format: disk.format };
        } else source = disk;
        doc = await openDoc(source.bytes);
      } catch (error) {
        // open 실패. prepare가 탭에 닿았으면(prepareToken 있음) 문서 잠금을 여기서 풀지 않는다.
        // finally의 releaseTab()이 끝난 뒤 lockToken.release()가 푼다. 탭에 닿지 않은 실패만 즉시 푼다.
        // opened는 true로 남아 두 번째 open도 거절되고, state가 없어 뒤따르는 hwp.* 호출은 invalid handle이다.
        if (!prepareToken) { lockToken.release(); lockToken = null; }
        throw error;
      }
      const handle = randomUUID();
      state = { id, handle, source, doc, lease, prepared, pendingFollow: !lease,
        followAllowed: options.follow !== false, batch: newBatch({ diskSha256: source.sha256,
        documentEpoch: prepared?.state.documentEpoch ?? null, changeSeq: prepared?.state.changeSeq ?? null,
        exportSha256: prepared?.exportSha256 ?? null }), save: false };
      state.pages = createPageView({ source, getGen: () => state.batch.ops.length, getDoc: () => state.doc,
        format: source.format, exporter, openDocument: openDoc, cliPageCount: config.cliPageCount ?? cliPageCountOf,
        rhwpBin, deadline });
      return handle;
    }
    if (!state || args[0] !== state.handle) throw new Error('invalid handle');
    if (name === 'save') { state.save = true; return { queued: true }; }
    if (Object.hasOwn(MUTATE_HELPERS, name)) {
      if (state.save) throw new Error('mutation after save');
      await followBeforeMutation();
      return MUTATE_HELPERS[name](state.doc, state.batch, args[1], args[2]);
    }
    if (name === 'getFormat') return getFormat(state.doc, args[1]);
    if (name === 'styles') return styles(state.doc);
    if (name === 'snapshot' || name === 'exportPdf') {
      // 읽기 전용 렌더. 이번 호출에서 편집했으면 편집 결과를, 아니면 연 바이트(탭이 있으면 탭의 현재 내용)를 그린다.
      const { bytes, cliPageCount } = await state.pages.current();
      const origin = state.batch.ops.length ? 'edited' : state.prepared && state.prepared.contentLoss.count === 0 ? 'tab' : 'disk';
      const out = await renderDocument({ kind: name === 'snapshot' ? 'snapshot' : 'pdf', bytes, format: state.source.format,
        docId: exportPath(state.id), options: args[1], exportsRoot: config.exportsRoot ?? EXPORTS_ROOT,
        docsRoots: exportRoots(),
        rhwpBin, deadline });
      if (out.pageCount !== cliPageCount) console.warn('[page-view] CLI dump-pages/render mismatch',
        { docId: state.id, api: cliPageCount, snapshot: out.pageCount });
      return { docId: state.id, origin, ...out,
        ...(out.pageCount !== cliPageCount ? { pageCountMismatch: { api: cliPageCount, snapshot: out.pageCount } } : {}) };
    }
    if (name === 'api') {
      const method = args[1], rest = args.slice(2);
      if (typeof method !== 'string') throw new Error('API_METHOD_DENIED: method name required');
      if (Object.hasOwn(REGISTRY, method) && REGISTRY[method].mode === 'mutate') {
        if (state.save) throw new Error('mutation after save');
        await followBeforeMutation();
        return applyCall(state.doc, state.batch, method, rest);
      }
      if (['pageCount', 'getPageText', 'getDocumentInfo'].includes(method)) return state.pages.read(method, rest);
      return readApi(state.doc, method, rest); // 목록에 없으면 여기서 API_METHOD_DENIED
    }
    if (name === 'setCell' || name === 'insertText') {
      // splitLines(#28)·format(#30) 옵션을 기존 op로 풀어 쓴다(lib/text-helpers.mjs). 옵션이 없으면 applyOp와 같다.
      if (state.save) throw new Error('mutation after save');
      await followBeforeMutation();
      return (name === 'setCell' ? setCellHelper : insertTextHelper)(state.doc, state.batch, args[1]);
    }
    if (['insertTextInCell','replaceText','setCheckbox'].includes(name)) {
      if (state.save) throw new Error('mutation after save');
      await followBeforeMutation();
      return applyOp(state.doc, state.batch, name, args[1]);
    }
    if (name === 'info' || name === 'text') return state.pages.read(name, [args[1]]);
    return readView(state.doc, name, args[1]);
  };
  let result = null, releasedTab = null;
  try {
    const out = await new Promise(resolve => {
      worker = new Worker(new URL('./worker.mjs', import.meta.url),
        { workerData: { code, timeoutMs }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
      let done = false;
      const finish = x => { if (!done) { done = true; resolve(x); } };
      // Code deadline ends when the worker replies. Tab apply/commit has its own 120 s deadline.
      timer = setTimeout(() => finish({ ok: false, error: 'EXEC_TIMEOUT', logs: [] }), timeoutMs);
      worker.on('message', msg => {
        if (done) return;
        if (msg.type === 'done') return finish(msg.out);
        if (msg.type === 'call') {
          const task = hostSerial(msg.name, msg.args)
            .then(value => { if (!done) worker.postMessage({ type: 'reply', id: msg.id, value }); })
            .catch(e => { if (!done) worker.postMessage({ type: 'reply', id: msg.id, ...wireError(e) }); }); // code·details까지(R2-1)
          active.add(task); task.finally(() => active.delete(task)).catch(() => {});
        }
      });
      worker.on('error', e => finish({ ok: false, error: String(e.message), logs: [] }));
      worker.on('exit', c => finish({ ok: false, error: `worker exit ${c}`, logs: [] }));
    });
    closed = true; clearTimeout(timer);
    await Promise.allSettled([...active]);
    if (!out.ok) {
      if (state?.lease) await tabs.waitAgentSave?.(state.lease);
      const id = state?.id ?? attemptedDocId;
      let diskReadError = null;
      const disk = id ? await store.read(id).catch(error => { diskReadError = error.code ?? error.message; return null; }) : null;
      const commit = id ? await historyFor(id).then(history => lastCommit(history, id)).catch(() => null) : null;
      result = { ...out, logs: out.logs ?? [], elapsedMs: Date.now() - start, saved,
        ...(out.code ? { errorCode: out.code } : {}),
        ...(out.hashes ? { hashes: { ...out.hashes, diskSha256: disk?.sha256 ?? null } } : {}),
        reconciliation: { diskSha256: disk?.sha256 ?? null, lastCommit: commit,
          ...(diskReadError ? { diskReadError } : {}) } };
    } else {
    if (state?.save) {
      validateBatch(state.batch);
      if (!state.batch.ops.length) throw new Error('save requires an edit');
      if (state.prepared) {
        let reported = null;
        try { reported = exporter(state.doc, state.source.format); } catch { reported = null; }
        if (state.prepared.contentLoss.count > 0 || !reported || reported.report.count > 0) {
          // kordoc 보조: clean 탭만. 원본 디스크 바이트에 논리 op를 다시 적용하고 탭은 reload한다.
          if (state.prepared.state.dirty) throw new Error('DIRTY_TAB_KORDOC_UNSAFE');
          const original = await store.read(state.id);
          if (original.sha256 !== state.source.sha256) throw new Error('ETAG_MISMATCH');
          const bytes = await fallbackPatch(original.bytes, state.source.format, state.batch.ops);
          const persisted = await persistDocument(store, { id: state.id, bytes,
            expectedSha256: original.sha256, contentLoss: { count: 0, losses: [] },
            message: `hwp_exec: ${state.id}`, author: 'agent', lockToken });
          state.reload = { diskSha256: persisted.sha256, commit: persisted.commit };
          saved.push({ docId: state.id, commit: persisted.commit, engine: 'kordoc', undo: 'git' });
        } else {
          // rhwp 정상 경로: 탭이 같은 op를 재생하고 wp1 PUT 하나로 저장한다. 서버는 이 apply에만 저장 토큰을 준다.
          // wp5: 탭 export는 브라우저 조판 값(글꼴 측정 → 줄 정보)이 달라 Node export와 바이트가 다를 수 있다(.hwp 실측).
          // 그래서 기대값은 Node 문서의 내용 서명이다. 탭에는 보내지 않고 서버 PUT만 읽는다(api-docs → verifyAgentBytes).
          // 기대값은 Node가 저장할 바이트(reported.bytes)를 다시 연 문서로 잰다. 저장 때 rhwp가 채우는 값(새 표의 바깥 여백 등)을
          // 탭 바이트(verifyAgentBytes도 다시 열어서 잰다)와 같은 조건에서 비교하려는 것이다(030).
          const reopened = await openDoc(reported.bytes);
          let signature;
          try { signature = contentSignature(reopened); } finally { reopened.free(); }
          if (signature.status !== 'ok') throw new Error(`SIGNATURE_UNSUPPORTED: ${signature.reasons.slice(0, 3).join('; ')}`);
          const token = state.prepared.requestId;
          let applied;
          try {
            applied = await tabs.requestAgent(state.lease, 'agent.apply', {
              format: state.source.format, token, batch: { ...state.batch, token },
            }, config.applyDeadlineMs ?? 120000, lockToken, { exportSha256: sha(reported.bytes), signature });
          } catch (error) { applyRequestId = error.requestId ?? null; throw error; }
          applyRequestId = applied.requestId;
          saved.push({ docId: state.id, commit: applied.save.commit, engine: 'rhwp', verify: applied.save.verify });
        }
      } else {
      // 탭 없이 연 뒤 실행 중에 탭이 claim했으면 쓰지 않는다(그 탭은 옛 바이트를 보고 있을 수 있다).
      if (tabs.owner(state.id) || tabs.claimed?.(state.id)) throw new Error('TAB_OPENED_DURING_RUN');
      let bytes, engine = 'rhwp';
      try {
        const exported = exporter(state.doc, state.source.format);
        if (exported.report.count > 0) throw new Error('rhwp contentLoss');
        bytes = exported.bytes;
      } catch {
        bytes = await fallbackPatch(state.source.bytes, state.source.format, state.batch.ops);
        engine = 'kordoc';
      }
      await config.beforeDiskPersist?.(state.id); // 테스트 전용 훅(wp5 R1): 문서 잠금을 쥔 채 여기서 멈춘다. 운영 설정에는 없다
      const persisted = await persistDocument(store, { id: state.id, bytes,
        expectedSha256: state.source.sha256,
        contentLoss: { count: 0, losses: [] }, message: `hwp_exec: ${state.id}`,
        author: 'agent', lockToken });
      saved.push({ docId: state.id, commit: persisted.commit, engine,
        ...(engine === 'kordoc' ? { undo: 'git' } : {}) });
      }
    }
    // 결과를 돌려주기 전에 탭 해제를 끝낸다. 커밋은 됐는데 탭이 옛 문서이거나 해제가 확인되지 않으면 알린다.
    const tab = await releaseTab();
    result = { ok: true, result: out.result ?? null, logs: out.logs ?? [],
      elapsedMs: Date.now() - start, saved,
      ...(saved.length && (tab.reloadRequired || !tab.confirmed) ? { reloadRequired: true } : {}) };
    }
  } catch (e) {
    // A timed-out reply may follow a successful commit. Reconcile; never replay the batch.
    if (state?.lease) await tabs.waitAgentSave?.(state.lease);
    const id = state?.id ?? attemptedDocId;
    let diskReadError = null;
    const disk = id ? await store.read(id).catch(error => { diskReadError = error.code ?? error.message; return null; }) : null;
    const commit = id ? await historyFor(id).then(history => lastCommit(history, id)).catch(() => null) : null;
    result = { ok: false, ...wireError(e), ...(e?.code ? { errorCode: e.code } : {}),
      ...(e?.hashes ? { hashes: { ...e.hashes, diskSha256: disk?.sha256 ?? null } } : {}),
      logs: [], elapsedMs: Date.now() - start,
      saved, reconciliation: { diskSha256: disk?.sha256 ?? null, lastCommit: commit,
        ...(diskReadError ? { diskReadError } : {}) } };
  } finally {
    closed = true; clearTimeout(timer);
    if (worker) await worker.terminate().catch(() => {});
    // prepare가 성공했든 실패했든(requestId가 있으면) 탭 해제가 끝난 뒤에만 문서 잠금을 푼다.
    // releaseTab()이 waitAgentSave를 먼저 기다린다. 격리된 임대에도 release를 보낸다.
    releasedTab = await releaseTab();
    if (follow && (follow.outcome === 'followed' || follow.outcome === 'failed')) {
      if (follow.outcome === 'failed') follow.completion = 'none';
      else {
        let disk = null, diskError = null;
        if (state) disk = await store.read(state.id).catch(error => { diskError = error.code ?? error.message; return null; });
        const applySave = applyRequestId && state?.lease
          ? (tabs.saveStatus?.(applyRequestId, state.lease)?.body?.state ?? null) : null;
        follow.completion = followCompletion({ saved, source: state?.source ?? null, disk, diskError,
          applySave, tabConfirmed: releasedTab.confirmed });
      }
    }
    try { state?.pages?.close(); }
    finally { state?.doc.free(); lockToken?.release(); }
    if (follow?.lease && follow.completion) {
      tabs.followEnd?.(follow.lease, { from: follow.from, to: follow.to, completion: follow.completion,
        ok: result?.ok === true, error: result?.ok ? null : (result?.error ?? 'EXEC_ABORTED'),
        commit: saved.at(-1)?.commit ?? result?.reconciliation?.lastCommit ?? null });
    }
  }
  return projectResult(result ?? { ok: false, error: 'EXEC_ABORTED', logs: [], elapsedMs: Date.now() - start, saved }, follow);
}
