// office_exec 실행기. 한 호출 한 문서, office.save(h)는 표시만 하고 실제 저장은 코드가 끝까지 성공한 뒤 한 번 한다.
// 저장 전에 같은 엔진으로 결과를 다시 읽어 확인하고(AGENT_VERIFY_MISMATCH면 디스크 무변경), persistDocument로 커밋한다.
// 문서 잠금은 어떤 경로로 끝나든 finally에서 푼다. 커밋 뒤 그 문서를 연 오피스 탭에 office.changed를 알린다.
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { persistDocument } from '../../lib/persist.mjs';
import { lastCommit } from '../../lib/git.mjs';
import { FORMATS, familyOf, isEditable, labelOf } from '../../lib/formats.mjs';
import { convert as sofficeConvert } from '../../lib/office/soffice.mjs';
import { openSheet, sheetNames, readRange, setCells, sheetBytes, sheetWarnings, verifySheet } from '../../lib/office/agent-sheet.mjs';
import { openDoc, docParagraphs, docFind, docReplace, docAppend, verifyDoc, docBytes, docWarnings } from '../../lib/office/agent-doc.mjs';
import { wireError } from './wire-error.mjs';

const fail = (code, details, status = 400) => { throw Object.assign(new Error(code), { code, status, ...(details !== undefined ? { details } : {}) }); };
export const OFFICE_HELP = [
  'office_exec runs an async JavaScript body with one global, office, against one document of the Jongi (종이) library.',
  'office.docs() lists documents: [{id, format, family, editable}]. family is sheet, doc or slides (HWP/HWPX use hwp_exec).',
  'const h = await office.open(id) locks the document for this call. One document per call.',
  'office.info(h) → {id, format, family, editable, sheets?, paragraphs?}.',
  "Sheets: office.sheets(h) → names; office.read(h,{sheet?, range:'A1:C10'}) → 2D values (formula cells are {value, formula}); office.setCells(h,{sheet?, start:'B2', values:[[1,'text','=B2*2'],[null]]}) — a string starting with '=' is a formula (xlsx and ods keep formulas; xls, numbers and csv reject them with FORMULA_NOT_SAVED), null clears a cell.",
  'Documents (docx; odt, rtf and doc round-trip through LibreOffice): office.paragraphs(h) → [{index, text}]; office.find(h,{query}) → [{paragraph, count}]; office.replaceText(h,{find, replace, expectedCount?}) → {count}; office.appendParagraph(h,{text}).',
  'Finish with await office.save(h). The result is written only if the whole call succeeds; before writing, the saved bytes are reopened and checked (AGENT_VERIFY_MISMATCH otherwise, nothing written). Slides (pptx, ppt, odp, key) and Pages are read-only: info works, edits and save fail with FORMAT_READ_ONLY.',
  'Return a small value (<=64 KiB). No imports or filesystem.',
].join('\n');

export async function runOfficeAgent({ code, timeoutMs = 30000 }, { store, tabs, config = {} }) {
  const start = Date.now();
  const convert = config.convert ?? sofficeConvert;
  if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 65536
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    return { ok: false, error: 'invalid code or timeoutMs', logs: [], elapsedMs: 0, saved: [] };
  let state = null, lockToken = null, opened = false, worker, timer, closed = false;
  const saved = [];
  const needState = handle => {
    if (!state || handle !== state.handle) fail('INVALID_HANDLE');
    return state;
  };
  const needEditable = (s, family) => {
    if (!s.editable) fail('FORMAT_READ_ONLY', { format: s.format, hint: labelOf(s.format) + ' is read-only' });
    if (family && s.family !== family) fail('WRONG_FAMILY', { expected: family, actual: s.family });
    if (s.saveRequested) fail('EDIT_AFTER_SAVE');
  };
  const host = async (name, args) => {
    if (closed) throw new Error('invocation closed');
    if (name === 'help') return OFFICE_HELP;
    if (name === 'docs') return (await store.list()).filter(d => familyOf(d.format) !== 'hwp')
      .map(d => ({ id: d.id, format: d.format, family: familyOf(d.format), editable: isEditable(d.format) }));
    if (name === 'open') {
      const id = args[0];
      if (opened) { if (state && id === state.id) return state.handle; throw new Error('one document per invocation'); }
      opened = true;
      const { format } = await store.resolveId(id);
      const family = familyOf(format);
      if (family === 'hwp') fail('FORMAT_UNSUPPORTED', { use: 'hwp_exec' });
      lockToken = store.lock(id);
      if (!lockToken) fail('DOCUMENT_LOCKED', undefined, 423);
      const source = await store.read(id);
      const editable = isEditable(format);
      let model = null;
      if (editable && family === 'sheet') model = await openSheet(source.bytes, format);
      else if (editable && family === 'doc') model = await openDoc(source.bytes, format, { convert });
      state = { id, handle: randomUUID(), format, family, editable, source, model, saveRequested: false };
      return state.handle;
    }
    const s = needState(args[0]);
    const opts = args[1];
    if (name === 'info') {
      const info = { id: s.id, format: s.format, family: s.family, editable: s.editable };
      if (s.model && s.family === 'sheet') info.sheets = sheetNames(s.model);
      if (s.model && s.family === 'doc') info.paragraphs = docParagraphs(s.model).length;
      return info;
    }
    if (name === 'sheets') { needEditable(s, 'sheet'); return sheetNames(s.model); }
    if (name === 'read') { needEditable(s, 'sheet'); return readRange(s.model, opts ?? {}); }
    if (name === 'setCells') { needEditable(s, 'sheet'); return setCells(s.model, opts ?? {}); }
    if (name === 'paragraphs') { needEditable(s, 'doc'); return docParagraphs(s.model); }
    if (name === 'find') { needEditable(s, 'doc'); return docFind(s.model, opts ?? {}); }
    if (name === 'replaceText') { needEditable(s, 'doc'); return docReplace(s.model, opts ?? {}); }
    if (name === 'appendParagraph') { needEditable(s, 'doc'); return docAppend(s.model, opts ?? {}); }
    if (name === 'save') { needEditable(s); s.saveRequested = true; return { pending: true }; }
    throw new Error('unknown office helper ' + name);
  };
  let chain = Promise.resolve();
  const serial = (name, args) => { const next = chain.then(() => host(name, args)); chain = next.catch(() => {}); return next; };
  let result;
  try {
    const active = new Set();
    const out = await new Promise(resolve => {
      worker = new Worker(new URL('./office-worker.mjs', import.meta.url),
        { workerData: { code, timeoutMs }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
      let done = false;
      const finish = x => { if (!done) { done = true; resolve(x); } };
      timer = setTimeout(() => finish({ ok: false, error: 'EXEC_TIMEOUT', code: 'EXEC_TIMEOUT', logs: [] }), timeoutMs);
      worker.on('message', msg => {
        if (done) return;
        if (msg.type === 'done') return finish(msg.out);
        if (msg.type === 'call') {
          const task = serial(msg.name, msg.args)
            .then(value => { if (!done) worker.postMessage({ type: 'reply', id: msg.id, value }); })
            .catch(e => { if (!done) worker.postMessage({ type: 'reply', id: msg.id, ...wireError(e) }); });
          active.add(task); task.finally(() => active.delete(task)).catch(() => {});
        }
      });
      worker.on('error', e => finish({ ok: false, error: String(e.message), logs: [] }));
      worker.on('exit', c => finish({ ok: false, error: 'worker exit ' + c, logs: [] }));
    });
    closed = true; clearTimeout(timer);
    await Promise.allSettled([...active]);
    if (!out.ok) {
      result = { ...out, logs: out.logs ?? [], elapsedMs: Date.now() - start, saved };
    } else {
      if (state?.saveRequested) {
        // 저장: 바이트 만들기 → 같은 엔진으로 다시 읽어 확인 → (필요하면 되돌림 변환) → 커밋.
        let bytes, warnings;
        if (state.family === 'sheet') {
          bytes = await sheetBytes(state.model);
          await (config.verifySheet ?? verifySheet)(bytes, state.model);
          warnings = sheetWarnings(state.model);
        } else {
          verifyDoc(state.model);
          bytes = await docBytes(state.model, { convert });
          warnings = docWarnings(state.model);
        }
        await config.beforePersist?.(state.id);
        const persisted = await persistDocument(store, { id: state.id, bytes, expectedSha256: state.source.sha256,
          contentLoss: { schemaVersion: 2, outputFormat: state.format, count: 0, losses: [], warnings },
          message: 'office_exec: ' + state.id, author: 'agent', lockToken });
        saved.push({ docId: state.id, commit: persisted.commit, sha256: persisted.sha256, engine: FORMATS[state.format].family, ...(warnings.length ? { warnings } : {}) });
      }
      result = { ok: true, result: out.result ?? null, logs: out.logs ?? [], elapsedMs: Date.now() - start, saved };
    }
  } catch (e) {
    const id = state?.id ?? null;
    const disk = id ? await store.read(id).catch(() => null) : null;
    const commit = id ? await (store.historyFor ? store.historyFor(id) : Promise.resolve({ workTree: store.root, gitDir: null, path: id }))
      .then(history => lastCommit(history, id)).catch(() => null) : null;
    result = { ok: false, ...wireError(e), logs: [], elapsedMs: Date.now() - start, saved,
      reconciliation: { diskSha256: disk?.sha256 ?? null, lastCommit: commit } };
  } finally {
    closed = true; clearTimeout(timer);
    if (worker) await worker.terminate().catch(() => {});
    lockToken?.release();
  }
  if (saved.length) tabs?.notify?.(saved[0].docId, 'office.changed', { sha256: saved[0].sha256, commit: saved[0].commit });
  return result;
}

