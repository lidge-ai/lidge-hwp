import { persistDocument, indexEntry, restoreIndex } from '../lib/persist.mjs';
import { commitFile } from '../lib/git.mjs';
import { matchesFormat } from '../lib/docstore.mjs';
import { AGENT_PUT_HOLD_MS } from '../lib/config.mjs';
import { verifyAgentBytes } from '../lib/signature.mjs';
const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const error = (res, status, code) => send(res, status, { error: { code, message: code } });
const formatFor = (id) => id.toLowerCase().endsWith('.hwpx') ? 'hwpx' : 'hwp';

async function body(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('TOO_LARGE'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createDocsApi({ store, tabs }) {
  async function handle(req, res, pathname) {
    if (pathname === '/api/docs' && req.method === 'GET') {
      const roots = await store.roots();
      send(res, 200, { docs: await store.list(), projects: await store.listProjects(),
        roots, rootsWarning: roots.warning });
      return true;
    }
    if (pathname === '/api/projects') {
      if (req.method !== 'POST') { error(res, 405, 'METHOD_NOT_ALLOWED'); return true; }
      try {
        const data = JSON.parse((await body(req, 8192)).toString('utf8'));
        send(res, 201, { project: await store.createProject(data?.name) });
      } catch (cause) {
        const code = cause instanceof SyntaxError ? 'INVALID_JSON' : cause.code || 'CREATE_FAILED';
        error(res, cause.status || (code === 'INVALID_JSON' ? 400 : 500), code);
      }
      return true;
    }
    if (pathname.startsWith('/api/projects/')) {
      // POST /api/projects/<name>/docs — 파일명은 X-File-Name(encodeURIComponent) 헤더, 본문은 문서 바이트.
      try {
        const rest = pathname.slice('/api/projects/'.length);
        if (req.method !== 'POST' || !rest.endsWith('/docs')) { error(res, 404, 'NOT_FOUND'); return true; }
        const project = decodeURIComponent(rest.slice(0, -'/docs'.length));
        const fileName = decodeURIComponent(req.headers['x-file-name'] || '');
        // 커밋과 실패 복구는 docstore가 문서 잠금을 쥔 채로 부른다. 복구가 확인되지 않으면 RECOVERY_FAILED(격리).
        const imported = await store.importDocument(project, fileName, await body(req, 32 * 1024 * 1024), {
          commit: (id) => commitFile({ workTree: store.root, gitDir: null, path: id }, id, `Add ${id}`),
          indexSnapshot: (id) => indexEntry({ workTree: store.root, gitDir: null, path: id }, id),
          indexRestore: (id, before) => restoreIndex({ workTree: store.root, gitDir: null, path: id }, id, before),
        });
        send(res, 201, imported);
      } catch (cause) { error(res, cause.status || 500, cause.code || 'IMPORT_FAILED'); }
      return true;
    }
    if (!pathname.startsWith('/api/docs/')) return false;
    let id;
    try { id = decodeURIComponent(pathname.slice('/api/docs/'.length)); }
    catch { error(res, 400, 'INVALID_ID'); return true; }
    if (req.method === 'GET') {
      try {
        const doc = await store.read(id);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream',
          'Content-Length': doc.bytes.length, ETag: `"${doc.sha256}"`,
          'X-Document-Format': doc.format, 'Cache-Control': 'no-store' });
        res.end(doc.bytes);
      } catch (cause) { error(res, cause.status || 500, cause.code || 'READ_FAILED'); }
      return true;
    }
    if (req.method !== 'PUT') { error(res, 405, 'METHOD_NOT_ALLOWED'); return true; }
    let agentRequestId, lockToken, outcome = null;
    try {
      // wp3 resolves a pending agent.apply request to its server-held lock token.
      // An arbitrary header cannot authorize the write.
      agentRequestId = req.headers['x-agent-request-id'];
      lockToken = agentRequestId
        ? tabs.agentLockFor?.(id, req.headers['x-lease'], agentRequestId) : null;
      if (store.isLocked(id) && !lockToken) { error(res, 423, 'DOCUMENT_LOCKED'); return true; }
      if (agentRequestId && !lockToken) { error(res, 403, 'AGENT_AUTH_REQUIRED'); return true; }
      if (tabs.isIsolated?.(req.headers['x-lease'])) { error(res, 409, 'LEASE_ISOLATED'); return true; }
      const before = await store.read(id);
      if (req.headers['if-match'] !== `"${before.sha256}"`) {
        error(res, 412, 'ETAG_MISMATCH'); return true;
      }
      if (!tabs.owns(req.headers['x-lease'], id)) { error(res, 409, 'LEASE_REQUIRED'); return true; }
      if (req.headers['x-document-format'] !== formatFor(id)) { error(res, 400, 'FORMAT_MISMATCH'); return true; }
      let report;
      try { report = JSON.parse(Buffer.from(req.headers['x-content-loss-report'] || '', 'base64').toString('utf8')); }
      catch { error(res, 400, 'INVALID_REPORT'); return true; }
      if (report?.schemaVersion !== 1 || report.outputFormat !== formatFor(id)
          || !Number.isSafeInteger(report.count) || !Array.isArray(report.losses)
          || report.count !== report.losses.length) { error(res, 400, 'INVALID_REPORT'); return true; }
      if (report.count > 0) { error(res, 422, 'CONTENT_LOSS'); return true; }
      const bytes = await body(req, 32 * 1024 * 1024);
      if (!matchesFormat(bytes, formatFor(id))) { error(res, 400, 'INVALID_BYTES'); return true; }
      // wp5: 에이전트 저장은 탭 바이트를 Node에서 다시 열어 서버 쪽 손실 보고와 내용 서명을 확인한다.
      // 다르면 409 AGENT_VERIFY_MISMATCH(아래 catch → outcome failed → 채널 saveStatus 되돌리기 경로).
      const verify = lockToken ? await verifyAgentBytes(bytes, formatFor(id), tabs.agentExpected?.(agentRequestId)) : null;
      if (lockToken && AGENT_PUT_HOLD_MS > 0) {
        // c-7 증거용 테스트 훅. 잠금·강조가 화면에 있는 동안 저장을 잠시 멈춘다. 기본 0.
        console.log(`[agent-put-hold] ${agentRequestId} ${AGENT_PUT_HOLD_MS}ms`);
        await new Promise(resolve => setTimeout(resolve, AGENT_PUT_HOLD_MS));
      }
      const saved = await persistDocument(store, { id, bytes, expectedSha256: before.sha256,
        contentLoss: report, message: `Edit ${id}`, author: lockToken ? 'agent' : 'human', lockToken });
      outcome = { state: 'committed', commit: saved.commit, diskSha256: saved.sha256, ...(verify ? { verify } : {}) };
      send(res, 200, verify ? { ...saved, verify } : saved);
    } catch (cause) {
      if (cause.code === 'AGENT_VERIFY_MISMATCH' || cause.code === 'AGENT_VERIFY_MISSING') {
        console.warn(`[agent-verify] ${agentRequestId} ${id} ${cause.code}: ${cause.detail ?? ''}`);
      }
      if (lockToken && !outcome) { // committed 뒤 응답 전송 예외는 커밋 결과를 덮지 않는다
        const disk = await store.read(id).catch(() => null);
        outcome = { state: 'failed', code: cause.code || 'SAVE_FAILED', diskSha256: disk?.sha256 ?? null };
      }
      error(res, cause.status || 500, cause.code || 'SAVE_FAILED');
    }
    finally {
      if (lockToken) {
        // 이른 거부(412·409·400·422 등)는 persistDocument 전이므로 디스크는 그대로다. 그 해시를 실제로 읽어 기록한다.
        if (!outcome) {
          const disk = await store.read(id).catch(() => null);
          outcome = { state: 'failed', code: `HTTP_${res.statusCode || 0}`, diskSha256: disk?.sha256 ?? null };
        }
        tabs.finishAgentSave?.(agentRequestId, outcome);
      }
    }
    return true;
  }
  return { handle };
}
