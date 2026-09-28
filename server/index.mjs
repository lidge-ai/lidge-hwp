import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, HOST, PORT, DOCS_ROOT, BUILD_DIR, STATE_DIR } from '../lib/config.mjs';
import { createLibrary } from '../lib/library.mjs';
import { ensureRepo } from '../lib/git.mjs';
import { createTabs } from './tabs.mjs';
import { createDocsApi } from './api-docs.mjs';
import { pickFolder as defaultPickFolder } from '../lib/folder-picker.mjs';
import { startAgentSocket as startAgentSocketImpl } from './agent/socket.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
function requiresOrigin(pathname, method) {
  return (method === 'POST' && pathname === '/api/roots/pick')
    || (method === 'DELETE' && pathname.startsWith('/api/roots/'))
    || (method === 'POST' && pathname.startsWith('/api/docs/') && pathname.endsWith('/rename'))
    || (method === 'POST' && pathname === '/api/docs');
}
async function readSmallJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw Object.assign(new Error('TOO_LARGE'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export const STUDIO_SW_KILL_SWITCH = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) await caches.delete(key);
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
})()));
`;
async function staticFile(res, base, name) {
  const root = resolve(base);
  let decoded;
  try { decoded = decodeURIComponent(name); }
  catch { json(res, 400, { error: { code: 'INVALID_PATH', message: 'INVALID_PATH' } }); return; }
  const file = resolve(root, decoded);
  if (!(file === root || file.startsWith(root + sep))) {
    json(res, 403, { error: { code: 'INVALID_PATH', message: 'INVALID_PATH' } }); return;
  }
  try {
    const actual = await realpath(file);
    const realRoot = await realpath(root); // 루트 경로에 심볼릭 링크가 있어도(/var → /private/var) 같은 기준으로 비교한다
    if (!(actual === realRoot || actual.startsWith(realRoot + sep)) || !(await stat(actual)).isFile()) throw new Error('not file');
    const bytes = await readFile(actual);
    res.writeHead(200, { 'Content-Type': mime[extname(actual)] || 'application/octet-stream',
      'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(bytes);
  } catch { json(res, 404, { error: { code: 'NOT_FOUND', message: 'NOT_FOUND' } }); }
}

export async function createServer({ docsRoot = DOCS_ROOT, buildDir = BUILD_DIR,
    stateDir = STATE_DIR, startAgentSocket = startAgentSocketImpl, agentConfig = {},
    pickFolder = defaultPickFolder, renameOps = {} } = {}) {
  await ensureRepo(docsRoot);
  const store = await createLibrary({ docsRoot, stateDir, renameOps });
  if (typeof pickFolder !== 'function') throw new TypeError('pickFolder');
  const tabs = createTabs();
  const docsApi = createDocsApi({ store, tabs, pickFolder });
  const server = http.createServer((req, res) => {
    void (async () => {
      const host = req.headers.host;
      if (!host || !/^(localhost|127\.0\.0\.1):\d+$/.test(host)) {
        json(res, 403, { error: { code: 'BAD_HOST', message: 'BAD_HOST' } }); return;
      }
      const url = new URL(req.url || '/', `http://${host}`);
      if (requiresOrigin(url.pathname, req.method) && req.headers.origin !== `http://${host}`) {
        json(res, 403, { error: { code: 'BAD_ORIGIN', message: 'BAD_ORIGIN' } }); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin
          && req.headers.origin !== `http://${host}`) {
        json(res, 403, { error: { code: 'BAD_ORIGIN', message: 'BAD_ORIGIN' } }); return;
      }
      if (await docsApi.handle(req, res, url.pathname)) return;
      if (url.pathname.startsWith('/api/agent/saves/') && req.method === 'GET') {
        let requestId;
        try { requestId = decodeURIComponent(url.pathname.slice('/api/agent/saves/'.length)); }
        catch { json(res, 400, { error: { code: 'INVALID_ID', message: 'INVALID_ID' } }); return; }
        const { status, body } = tabs.saveStatus(requestId, req.headers['x-lease']);
        json(res, status, body); return;
      }
      if (url.pathname.startsWith('/api/agent/replies/') && req.method === 'POST') {
        try {
          const requestId = decodeURIComponent(url.pathname.slice('/api/agent/replies/'.length));
          const parts = []; let size = 0;
          for await (const part of req) {
            size += part.length;
            if (size > 32 * 1024 * 1024) throw Object.assign(new Error('REPLY_TOO_LARGE'), { code: 'REPLY_TOO_LARGE' });
            parts.push(part);
          }
          const body = Buffer.concat(parts);
          const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
          const split = mime === 'application/vnd.lidge.agent-reply' ? body.indexOf(10) : -1;
          if (mime !== 'application/json' && (mime !== 'application/vnd.lidge.agent-reply' || split < 0))
            throw Object.assign(new Error('INVALID_REPLY_MIME'), { code: 'INVALID_REPLY_MIME' });
          const header = JSON.parse(body.subarray(0, split < 0 ? body.length : split).toString('utf8'));
          const bytes = split < 0 ? Buffer.alloc(0) : body.subarray(split + 1);
          tabs.acceptReply(requestId, req.headers['x-lease'], header, bytes);
          res.writeHead(204); res.end();
        } catch (cause) {
          const code = cause.code || 'INVALID_REPLY';
          const status = code === 'REPLY_TOO_LARGE' ? 413
            : ['INVALID_AGENT_REPLY', 'AGENT_SAVE_MISSING'].includes(code) ? 409 : 400;
          json(res, status, { error: { code, message: code } });
        }
        return;
      }
      if (url.pathname === '/api/tabs' && req.method === 'POST') {
        try {
          const data = await readSmallJson(req);
          if (store.isQuarantined(data.docId)) {
            json(res, 423, { error: { code: 'DOCUMENT_QUARANTINED', message: 'DOCUMENT_QUARANTINED' } }); return;
          }
          await store.resolveId(data.docId);
          const reservation = typeof data.reservation === 'string' ? data.reservation : null;
          // 에이전트가 이 문서의 잠금을 쥔 동안(디스크 경로 저장 포함)에는 탭을 새로 열 수 없다. 열면 저장 전 바이트를
          // 들고 편집을 시작하게 된다. 예외는 runner가 만든 예약의 토큰을 가진 따라가기 claim 하나뿐이다(wp5).
          if (store.isLocked(data.docId) && !tabs.reservedFor(data.docId, reservation)) {
            json(res, 423, { error: { code: 'DOCUMENT_LOCKED', message: 'DOCUMENT_LOCKED' } }); return;
          }
          if (store.isRootRemoving(data.docId)) {
            json(res, 423, { error: { code: 'ROOT_BUSY', message: 'ROOT_BUSY' } }); return;
          }
          // 예약 중인 문서는 그 토큰으로 한 번만 claim된다(409 DOC_RESERVED, 만료 토큰은 409 RESERVATION_EXPIRED).
          const lease = tabs.claim(data.docId, reservation);
          if (!lease) { json(res, 409, { error: { code: 'LEASE_BUSY', message: 'LEASE_BUSY' } }); return; }
          json(res, 201, { lease, docId: data.docId });
        } catch (cause) { json(res, cause.status || 400, { error: { code: cause.code || 'INVALID_TAB', message: cause.message } }); }
        return;
      }
      if (url.pathname.startsWith('/api/tabs/reservations/') && req.method === 'DELETE') {
        // 셸이 수락한 전환을 마치지 못했을 때 예약을 돌려준다. 토큰은 agent.follow로 그 셸에만 간 값이다.
        let token;
        try { token = decodeURIComponent(url.pathname.slice('/api/tabs/reservations/'.length)); }
        catch { json(res, 400, { error: { code: 'INVALID_ID', message: 'INVALID_ID' } }); return; }
        json(res, tabs.cancelReservation(token) ? 200 : 404, { ok: true }); return;
      }
      if (url.pathname.startsWith('/api/tabs/') && req.method === 'DELETE') {
        json(res, tabs.release(url.pathname.slice('/api/tabs/'.length)) ? 200 : 404, { ok: true }); return;
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!tabs.events(url.searchParams.get('lease'), res)) json(res, 404, { error: { code: 'LEASE_NOT_FOUND', message: 'LEASE_NOT_FOUND' } });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        json(res, 404, { error: { code: 'NOT_FOUND', message: 'NOT_FOUND' } }); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'METHOD_NOT_ALLOWED' } }); return;
      }
      if (url.pathname === '/') return staticFile(res, join(ROOT, 'web'), 'index.html');
      if (url.pathname === '/doc-name.mjs') return staticFile(res, join(ROOT, 'lib'), 'doc-name.mjs');
      // 로컬 편집기는 Studio의 PWA 오프라인 캐시를 쓰지 않는다. 캐시된 옛 Studio가 새 lidge RPC를 모르는 채로
      // 떠서 에이전트 편집이 'Unknown method'로 실패한 적이 있다(wp3 B). sw.js는 스스로 해제하고 캐시를 비운 뒤
      // 열린 창을 다시 불러오는 스크립트로, registerSW.js는 빈 스크립트로 바꿔 준다.
      if (url.pathname === '/studio/sw.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(STUDIO_SW_KILL_SWITCH); return;
      }
      if (url.pathname === '/studio/registerSW.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('// lidge-hwp: service worker disabled\n'); return;
      }
      for (const [prefix, dir] of [['/studio/', 'studio'], ['/editor/', 'editor'], ['/wasm/', 'wasm']]) {
        if (url.pathname.startsWith(prefix)) {
          const name = url.pathname.slice(prefix.length) || 'index.html';
          return staticFile(res, join(buildDir, dir), name);
        }
      }
      return staticFile(res, join(ROOT, 'web'), url.pathname.slice(1));
    })().catch((cause) => {
      console.error('[server]', cause);
      if (!res.headersSent) json(res, 500, { error: { code: 'INTERNAL', message: 'INTERNAL' } });
      else res.destroy(cause);
    });
  });
  const socket = startAgentSocket ? await startAgentSocket({ store, tabs, config: agentConfig }) : null;
  server.on('close', () => { tabs.close(); socket?.close(); });
  server.store = store; // test-only inspection; production callers use the HTTP/socket boundaries.
  server.tabs = tabs;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createServer();
  server.listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT}`));
}
