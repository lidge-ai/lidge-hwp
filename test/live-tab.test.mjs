import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
import { createTabs } from '../server/tabs.mjs';
import { openDocument, exportWithReport } from '../lib/rhwp-node.mjs';
import { applyOp, newBatch } from '../lib/ops.mjs';
const git = promisify(execFile);
const HWP_STUB = Buffer.from('d0cf11e0a1b11ae100010203', 'hex');

async function seed(t, { id = 'a.hwp', bytes = HWP_STUB, agentConfig = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lidge-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, id), bytes);
  await git('git', ['-C', root, 'init', '-q']);
  await git('git', ['-C', root, 'add', '--', id]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed']);
  const server = await createServer({ docsRoot: root, agentConfig: { ...agentConfig, socketPath: join(root, 'agent.sock') } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  // SSE 연결이 열려 있으면 server.close()가 끝나지 않는다. 남은 연결을 닫아 'close'(tabs.close·socket.close)까지 가게 한다.
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { root, base: `http://127.0.0.1:${server.address().port}`, socketPath: join(root, 'agent.sock'), server };
}
function runCode(socketPath, code) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath); let text = '';
    conn.once('connect', () => conn.write(JSON.stringify({ id: 'test', code }) + '\n'));
    conn.on('data', chunk => { text += chunk; });
    conn.once('end', () => resolve(JSON.parse(text.trim())));
    conn.once('error', reject);
  });
}
const head = async root => (await git('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
const claimLease = async (base, docId = 'a.hwp') => (await (await fetch(`${base}/api/tabs`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId }) })).json()).lease;

test('reply header의 bytesLength는 실제 이진 길이와 같아야 한다', () => {
  const bytes = Buffer.from([0, 10, 255]);
  const frame = Buffer.concat([Buffer.from(JSON.stringify({ bytesLength: bytes.length }) + '\n'), bytes]);
  const split = frame.indexOf(10);
  assert.equal(frame.subarray(split + 1).length, JSON.parse(frame.subarray(0, split).toString('utf8')).bytesLength);
});

test('tabs: 여는 중·살아 있음·없음을 구분한다', () => {
  const tabs = createTabs();
  const lease = tabs.claim('a.hwp');
  assert.equal(tabs.claimed('a.hwp'), true);
  assert.equal(tabs.owner('a.hwp'), null);
  const res = { writeHead() {}, write() {}, on() {}, end() { this.writableEnded = true; }, writableEnded: false };
  assert.equal(tabs.events(lease, res), true);
  assert.equal(tabs.claimed('a.hwp'), false);
  assert.equal(tabs.owner('a.hwp'), lease);
  tabs.release(lease);
  assert.equal(tabs.claimed('a.hwp'), false);
  assert.equal(tabs.owner('a.hwp'), null);
  tabs.close();
});

test('tabs: 대기 요청은 timeout·release 모두 requestId를 달고 reject된다', async () => {
  const tabs = createTabs();
  const lease = tabs.claim('a.hwp');
  const res = { writeHead() {}, write() {}, on() {}, end() { this.writableEnded = true; }, writableEnded: false };
  tabs.events(lease, res);
  const timedOut = await tabs.requestAgent(lease, 'agent.prepare', { format: 'hwp' }, 20).catch(e => e);
  assert.equal(timedOut.code, 'AGENT_REPLY_TIMEOUT');
  assert.match(timedOut.requestId, /^[0-9a-f-]{36}$/);
  const pending = tabs.requestAgent(lease, 'agent.apply', {}, 60000, { id: 'a.hwp' }).catch(e => e);
  tabs.release(lease);
  const released = await pending;
  assert.equal(released.code, 'TAB_DISCONNECTED');
  assert.match(released.requestId, /^[0-9a-f-]{36}$/);
  tabs.close();
});

test('claim 뒤 SSE가 끝내 붙지 않으면 기다린 뒤 TAB_CONNECTING이고 디스크에 커밋하지 않는다', async t => {
  const { root, base, socketPath } = await seed(t, { agentConfig: { followMaxMs: 200 } }); // 기본 15초 대신 짧은 예산
  const lease = await claimLease(base);          // SSE는 열지 않는다(셸이 loadFile 중인 상태)
  const before = await head(root);
  const out = await runCode(socketPath, "const h = await hwp.open('a.hwp'); await hwp.save(h); return 'x'");
  assert.equal(out.ok, false);
  assert.match(out.error, /TAB_CONNECTING/);
  assert.equal(await head(root), before);
  assert.deepEqual(await readFile(join(root, 'a.hwp')), HWP_STUB);
  assert.equal((await git('git', ['-C', root, 'status', '--porcelain', '--', 'a.hwp'])).stdout, '');
  await fetch(`${base}/api/tabs/${lease}`, { method: 'DELETE' });
});

test('MCP socket이 열린 합성 탭까지 도달하고, 실패해도 같은 토큰으로 release한다', async t => {
  const { base, socketPath } = await seed(t);
  const lease = await claimLease(base);
  const events = await fetch(`${base}/api/events?lease=${lease}`);
  const reader = events.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  let frames = '';
  async function frame(type) {
    while (true) {
      const boundary = frames.indexOf('\n\n');
      if (boundary >= 0) {
        const chunk = frames.slice(0, boundary); frames = frames.slice(boundary + 2);
        if (chunk.startsWith(`event: ${type}\n`)) return JSON.parse(chunk.split('\ndata: ')[1]);
      } else {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE closed');
        frames += new TextDecoder().decode(value);
      }
    }
  }
  await frame('hello');
  const response = runCode(socketPath, "await hwp.open('a.hwp'); return 'ok'");
  const prepare = await frame('agent.prepare');
  assert.equal(prepare.docId, 'a.hwp');
  const replied = await fetch(`${base}/api/agent/replies/${prepare.requestId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lease': lease },
    body: JSON.stringify({ schemaVersion: 1, requestId: prepare.requestId, ok: false,
      error: { code: 'SIMULATED_TAB_STOP', message: 'SIMULATED_TAB_STOP' } }),
  });
  assert.equal(replied.status, 204);
  const release = await frame('agent.release');
  assert.equal(release.token, prepare.requestId);
  const released = await fetch(`${base}/api/agent/replies/${release.requestId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lease': lease },
    body: JSON.stringify({ schemaVersion: 1, requestId: release.requestId, ok: true }),
  });
  assert.equal(released.status, 204);
  const duplicate = await fetch(`${base}/api/agent/replies/${release.requestId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lease': lease },
    body: JSON.stringify({ schemaVersion: 1, requestId: release.requestId, ok: true }),
  });
  assert.equal(duplicate.status, 409);
  const out = await response;
  assert.equal(out.ok, false);
  assert.match(out.error, /SIMULATED_TAB_STOP/);
});

// ── 아래는 030 "같은 파일에 다음 case를 더한다" (1)~(4) ──
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const noLoss = format => ({ schemaVersion: 1, outputFormat: format, count: 0, losses: [] });
const oneLoss = format => ({ schemaVersion: 1, outputFormat: format, count: 1, losses: [{}] });
const tabState = (format, dirty = false) => ({ schemaVersion: 1, format, dirty, documentEpoch: 1, changeSeq: 0 });

// 합성 탭: SSE를 읽고 reply를 보낸다. 받은 이벤트 종류는 seen에 쌓인다.
async function connectTab(t, base, lease) {
  const events = await fetch(`${base}/api/events?lease=${lease}`);
  const reader = events.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  let frames = '';
  const seen = [];
  async function frame(type) {
    while (true) {
      const boundary = frames.indexOf('\n\n');
      if (boundary >= 0) {
        const chunk = frames.slice(0, boundary); frames = frames.slice(boundary + 2);
        const name = chunk.split('\n')[0].slice('event: '.length);
        if (name !== 'heartbeat') seen.push(name);
        if (name === type) return JSON.parse(chunk.split('\ndata: ')[1]);
      } else {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE closed');
        frames += new TextDecoder().decode(value);
      }
    }
  }
  async function reply(requestId, header, bytes) {
    const full = { schemaVersion: 1, requestId, ...header, ...(bytes ? { bytesLength: bytes.length } : {}) };
    const body = bytes ? Buffer.concat([Buffer.from(JSON.stringify(full) + '\n'), bytes]) : JSON.stringify(full);
    return fetch(`${base}/api/agent/replies/${requestId}`, { method: 'POST', body, headers: {
      'Content-Type': bytes ? 'application/vnd.lidge.agent-reply' : 'application/json', 'X-Lease': lease } });
  }
  await frame('hello');
  return { frame, reply, reader, seen };
}
async function humanPut(base, root, id, lease) {
  const bytes = await readFile(join(root, id));
  const format = id.endsWith('.hwpx') ? 'hwpx' : 'hwp';
  return fetch(`${base}/api/docs/${encodeURIComponent(id)}`, { method: 'PUT', body: bytes, headers: {
    'Content-Type': 'application/octet-stream', 'If-Match': `"${sha(bytes)}"`, 'X-Lease': lease,
    'X-Document-Format': format, 'X-Content-Loss-Report': Buffer.from(JSON.stringify(noLoss(format))).toString('base64') } });
}
async function unchanged(root, id, bytes, seedHead) {
  assert.equal(await head(root), seedHead);
  assert.deepEqual(await readFile(join(root, id)), bytes);
  assert.equal((await git('git', ['-C', root, 'status', '--porcelain'])).stdout, '');
}
const OPEN_EDIT_SAVE = "const h = await hwp.open('a.hwp'); await hwp.setCell(h,{table:0,row:0,col:0,text:'x'}); await hwp.save(h); return 'x'";

test('(1) prepare 대기 중 SSE가 끊기면 TAB_DISCONNECTED이고 디스크·HEAD는 그대로다', async t => {
  const { root, base, socketPath } = await seed(t);
  const lease = await claimLease(base);
  const tab = await connectTab(t, base, lease);
  const seedHead = await head(root);
  const response = runCode(socketPath, OPEN_EDIT_SAVE);
  await tab.frame('agent.prepare');
  await tab.reader.cancel();
  const out = await response;
  assert.equal(out.ok, false);
  assert.match(out.error, /TAB_DISCONNECTED/);
  await unchanged(root, 'a.hwp', HWP_STUB, seedHead);
});

test('(2) 에이전트 잠금 중 유효 lease/ETag의 사람 PUT은 423이다', async t => {
  const { root, base, socketPath } = await seed(t);
  const lease = await claimLease(base);
  const tab = await connectTab(t, base, lease);
  const seedHead = await head(root);
  const response = runCode(socketPath, OPEN_EDIT_SAVE);
  const prepare = await tab.frame('agent.prepare');
  assert.equal((await humanPut(base, root, 'a.hwp', lease)).status, 423);
  assert.equal((await tab.reply(prepare.requestId, { ok: false, error: { code: 'SIMULATED_TAB_STOP', message: 'x' } })).status, 204);
  const release = await tab.frame('agent.release');
  assert.equal((await tab.reply(release.requestId, { ok: true })).status, 204);
  assert.equal((await response).ok, false);
  await unchanged(root, 'a.hwp', HWP_STUB, seedHead);
});

test('(3a) prepare가 탭에 닿은 뒤 ETAG_MISMATCH여도 release 응답 전까지 문서 잠금을 쥔다', async t => {
  const { root, base, socketPath } = await seed(t);
  const lease = await claimLease(base);
  const tab = await connectTab(t, base, lease);
  const seedHead = await head(root);
  const response = runCode(socketPath, OPEN_EDIT_SAVE);
  const prepare = await tab.frame('agent.prepare');
  assert.equal((await tab.reply(prepare.requestId, { ok: true, state: tabState('hwp'), diskSha256: '0'.repeat(64),
    exportSha256: sha(HWP_STUB), contentLoss: noLoss('hwp') }, HWP_STUB)).status, 204);
  const release = await tab.frame('agent.release');
  assert.equal(release.token, prepare.requestId);
  assert.equal((await humanPut(base, root, 'a.hwp', lease)).status, 423);
  assert.equal((await tab.reply(release.requestId, { ok: true })).status, 204);
  const out = await response;
  assert.equal(out.ok, false);
  assert.match(out.error, /ETAG_MISMATCH/);
  await unchanged(root, 'a.hwp', HWP_STUB, seedHead);
  assert.notEqual((await humanPut(base, root, 'a.hwp', lease)).status, 423);
});

test('(3b) release에 답하지 않으면 deadline 뒤 임대를 격리하고 그 lease의 PUT은 409 LEASE_ISOLATED', async t => {
  const { root, base, socketPath } = await seed(t, { agentConfig: { releaseDeadlineMs: 300 } });
  const lease = await claimLease(base);
  const tab = await connectTab(t, base, lease);
  const seedHead = await head(root);
  const response = runCode(socketPath, OPEN_EDIT_SAVE);
  const prepare = await tab.frame('agent.prepare');
  await tab.reply(prepare.requestId, { ok: false, error: { code: 'SIMULATED_TAB_STOP', message: 'x' } });
  await tab.frame('agent.release'); // 답하지 않는다
  const out = await response;
  assert.equal(out.ok, false);
  const put = await humanPut(base, root, 'a.hwp', lease);
  assert.equal(put.status, 409);
  assert.equal((await put.json()).error.code, 'LEASE_ISOLATED');
  await unchanged(root, 'a.hwp', HWP_STUB, seedHead);
});

// 실문서 fixture가 있어야 Node rhwp가 prepare bytes를 열 수 있다.
async function fixtureTab(t, agentConfig = {}) {
  const fixture = process.env.LIDGE_HWP_KU_FIXTURE;
  if (!fixture) { t.skip('set LIDGE_HWP_KU_FIXTURE to a private KU .hwpx form'); return null; }
  const bytes = await readFile(fixture);
  const id = 'form' + (fixture.toLowerCase().endsWith('.hwpx') ? '.hwpx' : '.hwp');
  const env = await seed(t, { id, bytes, agentConfig });
  const lease = await claimLease(env.base, id);
  const tab = await connectTab(t, env.base, lease);
  const format = id.endsWith('.hwpx') ? 'hwpx' : 'hwp';
  const cell = { table: Number(process.env.LIDGE_HWP_KU_TABLE ?? 0), row: Number(process.env.LIDGE_HWP_KU_ROW ?? 0),
    col: Number(process.env.LIDGE_HWP_KU_COL ?? 0), text: '라이브검증' };
  const code = `const h = await hwp.open(${JSON.stringify(id)}); await hwp.setCell(h, ${JSON.stringify(cell)}); await hwp.save(h); return 'ok'`;
  return { ...env, id, bytes, format, lease, tab, code, seedHead: await head(env.root) };
}
const preparedReply = (f, { dirty = false, loss = false } = {}) => ({ ok: true, state: tabState(f.format, dirty),
  diskSha256: sha(f.bytes), exportSha256: sha(f.bytes), contentLoss: loss ? oneLoss(f.format) : noLoss(f.format) });

test('(3) agent.apply에 PUT 없이 ok:true를 보내면 409 AGENT_SAVE_MISSING이고 runner도 실패한다', async t => {
  const f = await fixtureTab(t); if (!f) return;
  const response = runCode(f.socketPath, f.code);
  const prepare = await f.tab.frame('agent.prepare');
  assert.equal((await f.tab.reply(prepare.requestId, preparedReply(f), f.bytes)).status, 204);
  const apply = await f.tab.frame('agent.apply');
  assert.equal(apply.token, prepare.requestId);
  assert.equal(apply.batch.token, prepare.requestId);
  assert.equal(apply.expectedAfterSha256, undefined); // wp5: 기대값(서명)은 서버에만 둔다
  assert.equal(apply.expected, undefined);
  const faked = await f.tab.reply(apply.requestId, { ok: true, commit: 'deadbeef' });
  assert.equal(faked.status, 409);
  assert.equal((await faked.json()).error.code, 'AGENT_SAVE_MISSING');
  const release = await f.tab.frame('agent.release');
  assert.equal((await f.tab.reply(release.requestId, { ok: true })).status, 204);
  const out = await response;
  assert.equal(out.ok, false);
  assert.match(out.error, /AGENT_SAVE_MISSING/);
  await unchanged(f.root, f.id, f.bytes, f.seedHead);
});

test('(4) clean 탭의 prepare 손실 → kordoc 커밋, apply·PUT 0회, release.reload.commit 일치', async t => {
  const f = await fixtureTab(t); if (!f) return;
  const response = runCode(f.socketPath, f.code);
  const prepare = await f.tab.frame('agent.prepare');
  await f.tab.reply(prepare.requestId, preparedReply(f, { loss: true }), f.bytes);
  const release = await f.tab.frame('agent.release');
  assert.equal((await f.tab.reply(release.requestId, { ok: true })).status, 204);
  const out = await response;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.reloadRequired, undefined);
  assert.deepEqual(Object.keys(out.saved[0]).sort(), ['commit', 'docId', 'engine', 'undo']);
  assert.equal(out.saved[0].docId, f.id);
  assert.equal(out.saved[0].engine, 'kordoc');
  assert.equal(out.saved[0].undo, 'git');
  assert.equal(out.saved[0].commit, await head(f.root));
  assert.notEqual(out.saved[0].commit, f.seedHead);
  assert.equal(release.reload.commit, out.saved[0].commit);
  assert.equal(release.reload.diskSha256, sha(await readFile(join(f.root, f.id))));
  assert.equal(f.tab.seen.includes('agent.apply'), false);
  assert.equal((await git('git', ['-C', f.root, 'rev-list', '--count', 'HEAD'])).stdout.trim(), '2');
});

test('(4) dirty 탭에서 kordoc이 필요하면 DIRTY_TAB_KORDOC_UNSAFE, worktree·index·HEAD 불변', async t => {
  const f = await fixtureTab(t); if (!f) return;
  const response = runCode(f.socketPath, f.code);
  const prepare = await f.tab.frame('agent.prepare');
  await f.tab.reply(prepare.requestId, preparedReply(f, { dirty: true, loss: true }), f.bytes);
  const release = await f.tab.frame('agent.release');
  assert.equal(release.reload, undefined);
  await f.tab.reply(release.requestId, { ok: true });
  const out = await response;
  assert.equal(out.ok, false);
  assert.match(out.error, /DIRTY_TAB_KORDOC_UNSAFE/);
  assert.equal(f.tab.seen.includes('agent.apply'), false);
  await unchanged(f.root, f.id, f.bytes, f.seedHead);
});

test('(4) 역방향: prepare 손실 0, Node export 손실 → 같은 kordoc 결과', async t => {
  const f = await fixtureTab(t, { exporter: () => ({ bytes: new Uint8Array(1), report: { count: 1 } }) }); if (!f) return;
  const response = runCode(f.socketPath, f.code);
  const prepare = await f.tab.frame('agent.prepare');
  await f.tab.reply(prepare.requestId, preparedReply(f), f.bytes);
  const release = await f.tab.frame('agent.release');
  await f.tab.reply(release.requestId, { ok: true });
  const out = await response;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.saved[0].engine, 'kordoc');
  assert.equal(out.saved[0].undo, 'git');
  assert.equal(out.saved[0].commit, await head(f.root));
  assert.equal(release.reload.commit, out.saved[0].commit);
  assert.equal(f.tab.seen.includes('agent.apply'), false);
});

test('(3c) kordoc 커밋 뒤 탭이 release에 isolated·reloadRequired로 답하면 ok:true, reloadRequired:true, 커밋 유지', async t => {
  const f = await fixtureTab(t); if (!f) return;
  const response = runCode(f.socketPath, f.code);
  const prepare = await f.tab.frame('agent.prepare');
  await f.tab.reply(prepare.requestId, preparedReply(f, { loss: true }), f.bytes);
  const release = await f.tab.frame('agent.release');
  assert.equal((await f.tab.reply(release.requestId, { ok: true, tab: { isolated: true, reloadRequired: true },
    error: { code: 'RELOAD_FAILED', message: 'x', recovered: null } })).status, 204);
  const out = await response;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.reloadRequired, true);
  assert.equal(out.saved[0].engine, 'kordoc');
  assert.equal(out.saved[0].commit, await head(f.root));
  const put = await humanPut(f.base, f.root, f.id, f.lease);
  assert.equal(put.status, 409);
  assert.equal((await put.json()).error.code, 'LEASE_ISOLATED');
});

// ── wp5 A: 에이전트 PUT의 서버 내용 서명 확인 ──
// 실문서 .hwp(LIDGE_HWP_SIG_FIXTURE). 합성 탭의 applyOps는 Node에서 같은 op를 재생한다.
const SIG_CELLS = [{ table: 1, row: 3, col: 1, text: 'WP5_A' }, { table: 1, row: 4, col: 1, text: 'WP5_B' }];
async function sigTab(t) {
  const fixture = process.env.LIDGE_HWP_SIG_FIXTURE;
  if (!fixture) { t.skip('set LIDGE_HWP_SIG_FIXTURE to samples/wp5-hwp-repro.hwp'); return null; }
  const bytes = await readFile(fixture);
  const env = await seed(t, { id: 'form.hwp', bytes });
  const lease = await claimLease(env.base, 'form.hwp');
  const tab = await connectTab(t, env.base, lease);
  const edits = SIG_CELLS.map(c => `await hwp.setCell(h, ${JSON.stringify(c)});`).join(' ');
  const code = `const h = await hwp.open('form.hwp'); ${edits} await hwp.save(h); return 'ok'`;
  return { ...env, id: 'form.hwp', bytes, format: 'hwp', lease, tab, code, seedHead: await head(env.root) };
}
async function tabExport(f, batch, tamper = null) {
  const doc = await openDocument(f.bytes);
  try {
    for (const op of batch.ops) applyOp(doc, newBatch({}), op.kind, op.args);
    if (tamper) applyOp(doc, newBatch({}), 'setCell', tamper); // 탭이 다른 칸까지 바꾼 경우
    return Buffer.from(exportWithReport(doc, 'hwp').bytes);
  } finally { doc.free(); }
}
const agentPut = (f, apply, body) => fetch(`${f.base}/api/docs/${encodeURIComponent(f.id)}`, { method: 'PUT', body, headers: {
  'Content-Type': 'application/octet-stream', 'If-Match': `"${sha(f.bytes)}"`, 'X-Lease': f.lease,
  'X-Document-Format': 'hwp', 'X-Content-Loss-Report': Buffer.from(JSON.stringify(noLoss('hwp'))).toString('base64'),
  'X-Agent-Request-Id': apply.requestId } });

test('(V1) .hwp 두 칸: 서버가 탭 바이트를 내용 서명으로 확인하고 커밋한다(verify=bytes)', async t => {
  const f = await sigTab(t); if (!f) return;
  const response = runCode(f.socketPath, f.code);
  const prepare = await f.tab.frame('agent.prepare');
  await f.tab.reply(prepare.requestId, preparedReply(f), f.bytes);
  const apply = await f.tab.frame('agent.apply');
  assert.equal(apply.expected, undefined);
  const put = await agentPut(f, apply, await tabExport(f, apply.batch));
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.equal(saved.verify, 'bytes'); // Node 재생 바이트라 바이트까지 같다. 브라우저 바이트(content)는 c-11에서 본다
  assert.equal((await f.tab.reply(apply.requestId, { ok: true, diskSha256: saved.sha256, commit: saved.commit })).status, 204);
  const release = await f.tab.frame('agent.release');
  await f.tab.reply(release.requestId, { ok: true });
  const out = await response;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.saved[0].verify, 'bytes');
  assert.equal(out.saved[0].commit, await head(f.root));
});

test('(V2) 다른 칸까지 바뀐 탭 바이트는 409 AGENT_VERIFY_MISMATCH, 저장 상태 failed, 디스크·HEAD 불변', async t => {
  const f = await sigTab(t); if (!f) return;
  const response = runCode(f.socketPath, f.code);
  const prepare = await f.tab.frame('agent.prepare');
  await f.tab.reply(prepare.requestId, preparedReply(f), f.bytes);
  const apply = await f.tab.frame('agent.apply');
  const put = await agentPut(f, apply, await tabExport(f, apply.batch, { table: 1, row: 3, col: 10, text: '변조' }));
  assert.equal(put.status, 409);
  assert.equal((await put.json()).error.code, 'AGENT_VERIFY_MISMATCH');
  const status = await (await fetch(`${f.base}/api/agent/saves/${apply.requestId}`, { headers: { 'X-Lease': f.lease } })).json();
  assert.equal(status.state, 'failed');
  assert.equal(status.code, 'AGENT_VERIFY_MISMATCH');
  assert.equal(status.diskSha256, sha(f.bytes)); // 채널은 이 값으로 되돌리기(agent-channel.mjs:100-102)를 고른다
  await f.tab.reply(apply.requestId, { ok: false, error: { code: 'AGENT_VERIFY_MISMATCH', message: 'AGENT_VERIFY_MISMATCH' },
    tab: { applied: true, committed: false, rollback: { ok: true }, isolated: false } });
  const release = await f.tab.frame('agent.release');
  await f.tab.reply(release.requestId, { ok: true });
  const out = await response;
  assert.equal(out.ok, false);
  assert.match(out.error, /AGENT_VERIFY_MISMATCH/);
  await unchanged(f.root, f.id, f.bytes, f.seedHead);
});

// ── wp5 B: 따라가기 ──
async function seedTwo(t, agentConfig = {}) {
  const env = await seed(t, { id: 'y.hwp', agentConfig: { followMinMs: 0, ...agentConfig } });
  await writeFile(join(env.root, 'x.hwp'), HWP_STUB);
  await git('git', ['-C', env.root, 'add', '--', 'x.hwp']);
  await git('git', ['-C', env.root, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed x']);
  const y = await connectTab(t, env.base, await claimLease(env.base, 'y.hwp'));
  return { ...env, y };
}
const claimWith = (base, docId, reservation) => fetch(`${base}/api/tabs`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(reservation === undefined ? { docId } : { docId, reservation }) });
// 디스크 경로는 HWP_STUB을 못 연다(CFB 오류). worker는 코드가 잡은 host 실패도 invocation 실패로 세므로(worker.mjs:18,34)
// 결과는 ok:false다. 볼 것은 follow 결과, 탭 이벤트, 그리고 디스크 경로에 닿았다는 증거인 CFB 오류다.
const OPEN_X = "try { await hwp.open('x.hwp'); return 'opened'; } catch (e) { return 'open-failed'; }";
const tabStop = async (tab, prepare) => {
  await tab.reply(prepare.requestId, { ok: false, error: { code: 'SIMULATED_TAB_STOP', message: 'SIMULATED_TAB_STOP' } });
  const release = await tab.frame('agent.release');
  await tab.reply(release.requestId, { ok: true });
};

test('(F0) tabs: 예약 중에는 그 토큰의 claim 한 번만 통과하고, 연결·해제·반납을 waitConnected가 구분한다', async () => {
  const tabs = createTabs();
  const res = () => ({ writeHead() {}, write() {}, on() {}, end() { this.writableEnded = true; }, writableEnded: false });
  const token = tabs.reserve('x.hwp', 60000);
  assert.throws(() => tabs.claim('x.hwp'), { code: 'DOC_RESERVED' });
  assert.throws(() => tabs.claim('x.hwp', 'other'), { code: 'DOC_RESERVED' });
  const waiting = tabs.waitConnected('x.hwp', { reservation: token, ms: 60000 });
  const lease = tabs.claim('x.hwp', token);
  assert.throws(() => tabs.claim('x.hwp', token), { code: 'DOC_RESERVED' });
  tabs.events(lease, res());
  assert.equal(await waiting, lease);
  tabs.cancelReservation(token);
  assert.throws(() => tabs.claim('z.hwp', token), { code: 'RESERVATION_EXPIRED' });
  const token2 = tabs.reserve('w.hwp', 60000);
  const failed = tabs.waitConnected('w.hwp', { reservation: token2, ms: 60000 }).catch(e => e.code);
  tabs.release(tabs.claim('w.hwp', token2));
  assert.equal(await failed, 'FOLLOW_LOAD_FAILED');
  const token3 = tabs.reserve('v.hwp', 60000);
  const cancelled = tabs.waitConnected('v.hwp', { reservation: token3, ms: 60000 }).catch(e => e.code);
  tabs.cancelReservation(token3);
  assert.equal(await cancelled, 'FOLLOW_CANCELLED');
  const plain = tabs.claim('u.hwp');
  const gone = tabs.waitConnected('u.hwp', { ms: 60000 }).catch(e => e.code);
  tabs.release(plain);
  assert.equal(await gone, 'TAB_CONNECTING');
  assert.deepEqual(tabs.followTarget('x.hwp'), null); // x를 보는 탭은 따라가기 대상이 아니다
  tabs.close();
});

test('(F1) 셸이 y를 볼 때 x를 열면 agent.follow → 예약 claim → x 탭으로 prepare (수락)', async t => {
  const { base, socketPath, y } = await seedTwo(t);
  const response = runCode(socketPath, "await hwp.open('x.hwp'); return 'ok'");
  const follow = await y.frame('agent.follow');
  assert.equal(follow.docId, 'y.hwp');
  assert.equal(follow.targetDocId, 'x.hwp');
  assert.match(follow.reservation, /^[0-9a-f-]{36}$/);
  assert.equal((await y.reply(follow.requestId, { ok: true })).status, 204);
  const claimed = await claimWith(base, 'x.hwp', follow.reservation);
  assert.equal(claimed.status, 201);
  const x = await connectTab(t, base, (await claimed.json()).lease);
  const prepare = await x.frame('agent.prepare'); // 탭 경로로 들어왔다
  assert.equal(prepare.docId, 'x.hwp');
  await tabStop(x, prepare);
  const out = await response;
  assert.match(out.error, /SIMULATED_TAB_STOP/);
  assert.deepEqual(out.follow, { from: 'y.hwp', to: 'x.hwp', outcome: 'followed' });
  assert.equal(y.seen.includes('agent.prepare'), false);
});

test('(F2) 저장 안 한 편집이 있는 셸은 DIRTY로 거절하고 runner는 디스크 경로로 간다', async t => {
  const { base, socketPath, y } = await seedTwo(t);
  const response = runCode(socketPath, OPEN_X);
  const follow = await y.frame('agent.follow');
  await y.reply(follow.requestId, { ok: false, error: { code: 'DIRTY', message: 'DIRTY' } });
  const out = await response;
  assert.match(out.error, /CFB/, JSON.stringify(out)); // 디스크 경로로 stub을 열다 실패(탭 경로가 아님)
  assert.deepEqual(out.follow, { from: 'y.hwp', to: 'x.hwp', outcome: 'declined', code: 'DIRTY' });
  assert.equal((await claimWith(base, 'x.hwp')).status, 201); // 예약은 풀렸다
});

test('(F3) 셸이 답하지 않으면 예산 뒤 디스크 경로, 늦은 수락은 409, 옛 예약 토큰은 RESERVATION_EXPIRED', async t => {
  const { base, socketPath, y } = await seedTwo(t, { followMaxMs: 300 });
  const response = runCode(socketPath, OPEN_X);
  const follow = await y.frame('agent.follow');
  const out = await response;
  assert.deepEqual(out.follow, { from: 'y.hwp', to: 'x.hwp', outcome: 'declined', code: 'AGENT_REPLY_TIMEOUT' });
  assert.equal((await y.reply(follow.requestId, { ok: true })).status, 409);
  const stale = await claimWith(base, 'x.hwp', follow.reservation);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'RESERVATION_EXPIRED');
  assert.equal((await claimWith(base, 'x.hwp')).status, 201);
});

test('(F4) 잠금·예약 중 다른 셸 claim·틀린 토큰·사람 PUT은 막히고, 수락 뒤 불러오기 실패면 FOLLOW_LOAD_FAILED → 디스크 경로', async t => {
  const { root, base, socketPath, y } = await seedTwo(t);
  const response = runCode(socketPath, OPEN_X);
  const follow = await y.frame('agent.follow');
  const other = await claimWith(base, 'x.hwp');
  assert.equal(other.status, 423); // runner가 X의 문서 잠금을 쥐고 있다: 예약 토큰 없는 claim은 잠금 검사에서 먼저 막힌다
  assert.equal((await other.json()).error.code, 'DOCUMENT_LOCKED');
  assert.equal((await claimWith(base, 'x.hwp', 'not-the-token')).status, 423);
  assert.equal((await humanPut(base, root, 'x.hwp', 'no-lease')).status, 423); // runner가 X의 문서 잠금을 쥐고 있다
  await y.reply(follow.requestId, { ok: true });
  const mine = await claimWith(base, 'x.hwp', follow.reservation);
  assert.equal(mine.status, 201);
  assert.equal((await claimWith(base, 'x.hwp', follow.reservation)).status, 423); // 한 번만(쓰인 예약은 잠금 예외가 아니다)
  const { lease } = await mine.json();
  await fetch(`${base}/api/tabs/${lease}`, { method: 'DELETE' }); // 셸의 loadFile 실패(app.mjs catch의 release(next))
  const out = await response;
  assert.deepEqual(out.follow, { from: 'y.hwp', to: 'x.hwp', outcome: 'failed', code: 'FOLLOW_LOAD_FAILED' });
  assert.match(out.error, /CFB/, JSON.stringify(out)); // 탭이 없으니 디스크 경로로 열려다 stub에서 실패(탭 경로가 아님)
});

test('(F5) 수락 뒤 claim 전에 셸이 예약을 돌려주면 FOLLOW_CANCELLED → 디스크 경로', async t => {
  const { base, socketPath, y } = await seedTwo(t);
  const response = runCode(socketPath, OPEN_X);
  const follow = await y.frame('agent.follow');
  await y.reply(follow.requestId, { ok: true });
  const back = await fetch(`${base}/api/tabs/reservations/${follow.reservation}`, { method: 'DELETE' });
  assert.equal(back.status, 200);
  const out = await response;
  assert.deepEqual(out.follow, { from: 'y.hwp', to: 'x.hwp', outcome: 'failed', code: 'FOLLOW_CANCELLED' });
});

test('(F6) 여는 중인 탭은 붙을 때까지 기다렸다가 그 탭으로 prepare한다', async t => {
  const { base, socketPath } = await seed(t);
  const lease = await claimLease(base);          // SSE 없이 claim만(셸이 loadFile 중)
  const response = runCode(socketPath, "await hwp.open('a.hwp'); return 'ok'");
  await new Promise(resolve => setTimeout(resolve, 500)); // runner가 open에 들어가 기다리는 동안
  const tab = await connectTab(t, base, lease);
  const prepare = await tab.frame('agent.prepare');
  await tabStop(tab, prepare);
  const out = await response;
  assert.match(out.error, /SIMULATED_TAB_STOP/);
  assert.equal(out.follow, undefined);
});

// ── wp5 잠금 중 claim(아키텍트 major 1) ──
test('(R0) 문서 잠금 중 예약 없는 claim은 423 DOCUMENT_LOCKED, 잠금이 풀리면 201', async t => {
  const { base, server } = await seed(t);
  const token = server.store.lock('a.hwp'); // runner가 hwp.open에서 잡는 것과 같은 잠금(runner.mjs:52)
  const locked = await claimWith(base, 'a.hwp');
  assert.equal(locked.status, 423);
  assert.equal((await locked.json()).error.code, 'DOCUMENT_LOCKED');
  token.release();
  assert.equal((await claimWith(base, 'a.hwp')).status, 201);
});

test('(R1) 디스크 경로 저장 중 X의 claim은 423, 커밋 뒤 claim은 되고 새 바이트를 연다', async t => {
  const fixture = process.env.LIDGE_HWP_SIG_FIXTURE;
  if (!fixture) { t.skip('set LIDGE_HWP_SIG_FIXTURE to samples/wp5-hwp-repro.hwp'); return; }
  const bytes = await readFile(fixture);
  let baseUrl = null, during = null;
  const env = await seed(t, { id: 'form.hwp', bytes, agentConfig: {
    // 디스크 저장 직전(runner.mjs:163, 문서 잠금을 쥔 채)에 셸이 이 문서를 열려는 상황을 만든다.
    beforeDiskPersist: async id => {
      const response = await claimWith(baseUrl, id);
      during = { status: response.status, code: (await response.json()).error?.code ?? null };
    } } });
  baseUrl = env.base;
  const out = await runCode(env.socketPath,
    "const h = await hwp.open('form.hwp'); await hwp.setCell(h, {table:1,row:3,col:1,text:'WP5_R1'}); await hwp.save(h); return 'ok'");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(during, { status: 423, code: 'DOCUMENT_LOCKED' });
  assert.equal(out.saved[0].commit, await head(env.root));
  const after = await claimWith(env.base, 'form.hwp');
  assert.equal(after.status, 201);
  const got = await fetch(`${env.base}/api/docs/form.hwp`);
  const fresh = Buffer.from(await got.arrayBuffer());
  assert.equal(got.headers.get('etag'), `"${sha(fresh)}"`);
  assert.equal(sha(fresh), sha(await readFile(join(env.root, 'form.hwp'))));
  assert.notEqual(sha(fresh), sha(bytes)); // 커밋된 새 바이트다
});

// ── wp5 한 마감(아키텍트 major 2) ──
function runCodeWithTimeout(socketPath, code, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath); let text = '';
    conn.once('connect', () => conn.write(JSON.stringify({ id: 'test', code, timeoutMs }) + '\n'));
    conn.on('data', chunk => { text += chunk; });
    conn.once('end', () => resolve(JSON.parse(text.trim())));
    conn.once('error', reject);
  });
}

test('(T1) prepare는 코드 마감 안에서만 기다린다: timeoutMs 4000이면 30초가 아니라 약 2초 뒤 AGENT_REPLY_TIMEOUT', async t => {
  const { base, socketPath } = await seed(t, { agentConfig: { releaseDeadlineMs: 300 } });
  const tab = await connectTab(t, base, await claimLease(base));
  const response = runCodeWithTimeout(socketPath, "await hwp.open('a.hwp'); return 'ok'", 4000);
  await tab.frame('agent.prepare'); // 답하지 않는다
  const release = await tab.frame('agent.release');
  await tab.reply(release.requestId, { ok: true });
  const out = await response;
  assert.equal(out.ok, false);
  assert.match(out.error, /AGENT_REPLY_TIMEOUT/);
  assert.ok(out.elapsedMs < 5000, `elapsedMs ${out.elapsedMs}`); // 예전(prepare 30초)이면 30초를 넘는다
});

test('(T2) 마감까지 prepare 몫이 1초도 안 남으면 탭에 닿기 전에 NO_TIME_FOR_PREPARE, 잠금은 바로 풀린다', async t => {
  const { base, socketPath, server } = await seed(t);
  const lease = await claimLease(base);
  const tab = await connectTab(t, base, lease);
  const out = await runCodeWithTimeout(socketPath, "await hwp.open('a.hwp'); return 'ok'", 2500);
  assert.equal(out.ok, false);
  assert.match(out.error, /NO_TIME_FOR_PREPARE/);
  const seen = await Promise.race([tab.frame('agent.prepare').then(() => 'prepare'),
    new Promise(resolve => setTimeout(resolve, 300, 'none'))]);
  assert.equal(seen, 'none');
  assert.equal(server.store.isLocked('a.hwp'), false); // prepareToken이 없으므로 open 실패 경로(runner.mjs:78)가 바로 풀었다
});
