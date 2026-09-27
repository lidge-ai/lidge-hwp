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
import { openDocument, exportWithReport, rhwpModule } from '../lib/rhwp-node.mjs';
import { applyOp, newBatch } from '../lib/ops.mjs';
import { startAgentChannel } from '../web/agent-channel.mjs';
const git = promisify(execFile);
const HWP_STUB = Buffer.from('d0cf11e0a1b11ae100010203', 'hex');

async function seed(t, { id = 'a.hwp', bytes = HWP_STUB, agentConfig = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lidge-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, id), bytes);
  await git('git', ['-C', root, 'init', '-q']);
  await git('git', ['-C', root, 'add', '--', id]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed']);
  const stateDir = await mkdtemp(join(tmpdir(), 'lidge-hwp-state-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const server = await createServer({ docsRoot: root, stateDir,
    agentConfig: { ...agentConfig, socketPath: join(root, 'agent.sock') } });
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

// wp2: 빌드된 WASM으로 만든 빈 HWP. HWP_STUB는 rhwp로 열리지 않으므로 탭 없는 디스크 경로 테스트에 쓴다.
async function blankHwp() {
  const { HwpDocument } = await rhwpModule();
  const doc = HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    const exported = exportWithReport(doc, 'hwp');
    assert.equal(exported.report.count, 0);
    return Buffer.from(exported.bytes);
  } finally { doc.free(); }
}

test('wp2: 같은 id 재open은 같은 핸들이고 한 번만 prepare/release한다', async t => {
  const bytes = await blankHwp();
  const { root, base, socketPath } = await seed(t, { bytes });
  const lease = await claimLease(base);
  const tab = await connectTab(t, base, lease);
  const before = await head(root);
  const run = runCode(socketPath, "const a=await hwp.open('a.hwp'); const b=await hwp.open('a.hwp'); return {same:a===b,handle:a}");
  const prepare = await tab.frame('agent.prepare');
  assert.equal((await tab.reply(prepare.requestId, { ok: true, state: tabState('hwp'),
    diskSha256: sha(bytes), exportSha256: sha(bytes), contentLoss: noLoss('hwp') }, bytes)).status, 204);
  const release = await tab.frame('agent.release');
  assert.equal(release.token, prepare.requestId);
  assert.equal((await tab.reply(release.requestId, { ok: true })).status, 204);
  const out = await run;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result.same, true);
  assert.equal(out.saved.length, 0);
  assert.deepEqual(tab.seen.filter(x => x === 'agent.prepare' || x === 'agent.release'),
    ['agent.prepare', 'agent.release']);
  await unchanged(root, 'a.hwp', bytes, before);
});

test('wp2: 서로 다른 id와 첫 실패 뒤 재open은 거절하고 파일을 바꾸지 않는다', async t => {
  const bytes = await blankHwp();
  const { root, socketPath } = await seed(t, { bytes });
  const before = await head(root);
  const other = await runCode(socketPath, "const a=await hwp.open('a.hwp'); await hwp.open('other.hwp'); return a");
  assert.equal(other.ok, false);
  assert.match(other.error, /one document per invocation/);
  const firstFailed = await runCode(socketPath, "try { await hwp.open('absent.hwp'); } catch {} try { await hwp.open('a.hwp'); } catch(e) { console.log('second:',e.message); }");
  assert.equal(firstFailed.ok, false);
  assert.match(firstFailed.error, /NOT_FOUND/);
  assert.ok(firstFailed.logs.some(line => line.includes('second: one document per invocation')));
  await unchanged(root, 'a.hwp', bytes, before);
});

test('wp2: Promise.all 재open은 직렬화되어 같은 핸들을 반환한다', async t => {
  const bytes = await blankHwp();
  const { socketPath } = await seed(t, { bytes });
  const out = await runCode(socketPath, "const [a,b]=await Promise.all([hwp.open('a.hwp'),hwp.open('a.hwp')]); return a===b");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result, true);
  assert.deepEqual(out.saved, []);
});

test('wp2: save 뒤 재open은 같은 핸들이고 mutation after save는 살아 있다', async t => {
  const bytes = await blankHwp();
  const { root, socketPath } = await seed(t, { bytes });
  const before = await head(root);
  const out = await runCode(socketPath, "const a=await hwp.open('a.hwp'); await hwp.save(a); const b=await hwp.open('a.hwp'); if(a!==b) throw Error('HANDLE_CHANGED'); await hwp.insertText(b,{paragraph:0,text:'blocked'});");
  assert.equal(out.ok, false);
  assert.match(out.error, /mutation after save/);
  assert.deepEqual(out.saved, []);
  await unchanged(root, 'a.hwp', bytes, before);
});

test('wp2: prepare 실패 뒤 같은 id 재open도 거절하고 prepare는 한 번뿐이다', async t => {
  const bytes = await blankHwp();
  const { root, base, socketPath } = await seed(t, { bytes });
  const lease = await claimLease(base);
  const tab = await connectTab(t, base, lease);
  const before = await head(root);
  const run = runCode(socketPath, "try { await hwp.open('a.hwp'); } catch (e) { console.log('first:', e.message); } try { await hwp.open('a.hwp'); } catch (e) { console.log('second:', e.message); }");
  const prepare = await tab.frame('agent.prepare');
  await tab.reply(prepare.requestId, { ok: false, error: { code: 'PREPARE_REFUSED', message: 'PREPARE_REFUSED' } });
  const release = await tab.frame('agent.release');
  assert.equal(release.token, prepare.requestId); // runner는 실패한 prepare의 requestId로 finally에서 release한다(runner.mjs:120,279)
  await tab.reply(release.requestId, { ok: true });
  const out = await run;
  assert.equal(out.ok, false);
  assert.ok(out.logs.some(line => line.includes('second: one document per invocation')), JSON.stringify(out.logs));
  assert.equal(tab.seen.filter(x => x === 'agent.prepare').length, 1);
  await unchanged(root, 'a.hwp', bytes, before);
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
  await writeFile(join(env.root, 'x.hwp'), await blankHwp());
  await git('git', ['-C', env.root, 'add', '--', 'x.hwp']);
  await git('git', ['-C', env.root, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed x']);
  const y = await connectTab(t, env.base, await claimLease(env.base, 'y.hwp'));
  return { ...env, y };
}
const claimWith = (base, docId, reservation) => fetch(`${base}/api/tabs`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(reservation === undefined ? { docId } : { docId, reservation }) });
const OPEN_X = "const h=await hwp.open('x.hwp'); await hwp.setCell(h,{table:99,row:0,col:0,text:'x'});";
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

test('(F1) open+tables는 다른 문서를 보는 셸을 움직이지 않는다', async t => {
  const { socketPath, y } = await seedTwo(t);
  const out = await runCode(socketPath, "const h=await hwp.open('x.hwp'); return await hwp.tables(h)");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.follow, undefined);
  assert.equal(y.seen.includes('agent.follow'), false);
});

test('(F7) 첫 변경에서 agent.follow → 예약 claim → x 탭으로 prepare', async t => {
  const { base, socketPath, y } = await seedTwo(t);
  const response = runCode(socketPath, OPEN_X);
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
  assert.deepEqual(out.follow, { from: 'y.hwp', to: 'x.hwp', outcome: 'followed', completion: 'none' });
  assert.equal(y.seen.includes('agent.prepare'), false);
});

test('(F8) follow:false 변경 저장은 y 탭을 유지한다', async t => {
  const { root, socketPath, y } = await seedTwo(t);
  const before = await head(root);
  const out = await runCode(socketPath,
    "const h=await hwp.open('x.hwp',{follow:false}); await hwp.insertText(h,{paragraph:0,text:'edited'}); await hwp.save(h)");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.saved.length, 1);
  assert.notEqual(await head(root), before);
  assert.equal(out.follow, undefined);
  assert.equal(y.seen.includes('agent.follow'), false);
});

test('(F9) 저장 없는 편집은 release 뒤 followEnd none을 보낸다', async t => {
  const { root, base, socketPath, y, server } = await seedTwo(t);
  const bytes = await readFile(join(root, 'x.hwp'));
  const before = await head(root);
  const run = runCode(socketPath, "const h=await hwp.open('x.hwp'); await hwp.insertText(h,{paragraph:0,text:'unsaved'})");
  const follow = await y.frame('agent.follow');
  await y.reply(follow.requestId, { ok: true });
  const claimed = await claimWith(base, 'x.hwp', follow.reservation);
  const x = await connectTab(t, base, (await claimed.json()).lease);
  const prepare = await x.frame('agent.prepare');
  await x.reply(prepare.requestId, { ok: true, state: tabState('hwp'), diskSha256: sha(bytes),
    exportSha256: sha(bytes), contentLoss: noLoss('hwp') }, bytes);
  const release = await x.frame('agent.release');
  await x.reply(release.requestId, { ok: true });
  const end = await x.frame('agent.followEnd');
  const out = await run;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.follow.completion, 'none');
  assert.equal(Object.hasOwn(out.follow, 'lease'), false);
  assert.equal(end.completion, 'none');
  assert.equal(server.store.isLocked('x.hwp'), false);
  assert.deepEqual(x.seen.slice(-3), ['agent.prepare', 'agent.release', 'agent.followEnd']);
  assert.equal(await head(root), before);
});

test('(F11) followEnd queued during claim is sent just after hello', () => {
  const tabs = createTabs();
  const lease = tabs.claim('x.hwp');
  assert.equal(tabs.followEnd(lease, { from: 'y.hwp', to: 'x.hwp', completion: 'none' }), true);
  const writes = [];
  const response = { writeHead() {}, write(value) { writes.push(value); }, on() {}, end() {}, writableEnded: false };
  tabs.events(lease, response);
  assert.match(writes[0], /^event: hello/);
  assert.match(writes[1], /^event: agent.followEnd/);
  tabs.close();
});

test('(P1) prepare hash failure retains disk SHA, commit and diagnostics', async t => {
  const bytes = await blankHwp();
  const { root, base, socketPath } = await seed(t, { bytes });
  const tab = await connectTab(t, base, await claimLease(base));
  const run = runCode(socketPath, "await hwp.open('a.hwp')");
  const prepare = await tab.frame('agent.prepare');
  await tab.reply(prepare.requestId, { ok: false, error: { code: 'SNAPSHOT_HASH_MISMATCH',
    message: 'SNAPSHOT_HASH_MISMATCH', retryable: false,
    hashes: { snapshotSha256: 'snap', exportSha256: 'export', tabDiskSha256: 'tab' } } });
  const release = await tab.frame('agent.release');
  await tab.reply(release.requestId, { ok: true });
  const out = await run;
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'SNAPSHOT_HASH_MISMATCH');
  assert.equal(out.retryable, false);
  assert.deepEqual(out.hashes, { snapshotSha256: 'snap', exportSha256: 'export', tabDiskSha256: 'tab',
    diskSha256: sha(bytes) });
  assert.equal(out.reconciliation.diskSha256, sha(bytes));
  assert.equal(out.reconciliation.lastCommit, await head(root));
});

test('(F13) apply reply timeout after committed PUT is committed, never restored', async t => {
  const { root, base, socketPath, y } = await seedTwo(t, { applyDeadlineMs: 150, releaseDeadlineMs: 1500 });
  const bytes = await readFile(join(root, 'x.hwp'));
  const before = await head(root);
  const run = runCode(socketPath,
    "const h=await hwp.open('x.hwp'); await hwp.insertText(h,{paragraph:0,text:'committed'}); await hwp.save(h)");
  const follow = await y.frame('agent.follow');
  await y.reply(follow.requestId, { ok: true });
  const claimed = await claimWith(base, 'x.hwp', follow.reservation);
  const lease = (await claimed.json()).lease;
  const x = await connectTab(t, base, lease);
  const prepare = await x.frame('agent.prepare');
  await x.reply(prepare.requestId, { ok: true, state: tabState('hwp'), diskSha256: sha(bytes),
    exportSha256: sha(bytes), contentLoss: noLoss('hwp') }, bytes);
  const apply = await x.frame('agent.apply');
  const doc = await openDocument(bytes);
  let edited;
  try {
    for (const op of apply.batch.ops) applyOp(doc, newBatch({}), op.kind, op.args);
    edited = Buffer.from(exportWithReport(doc, 'hwp').bytes);
  } finally { doc.free(); }
  const put = await fetch(`${base}/api/docs/x.hwp`, { method: 'PUT', body: edited, headers: {
    'Content-Type': 'application/octet-stream', 'If-Match': `"${sha(bytes)}"`, 'X-Lease': lease,
    'X-Document-Format': 'hwp', 'X-Content-Loss-Report': Buffer.from(JSON.stringify(noLoss('hwp'))).toString('base64'),
    'X-Agent-Request-Id': apply.requestId } });
  assert.equal(put.status, 200, await put.text());
  const release = await x.frame('agent.release');
  await x.reply(release.requestId, { ok: true });
  const end = await x.frame('agent.followEnd');
  const out = await run;
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.error, 'AGENT_REPLY_TIMEOUT');
  assert.deepEqual(out.saved, []);
  assert.equal(out.follow.completion, 'committed');
  assert.equal(Object.hasOwn(out.follow, 'lease'), false);
  assert.equal(end.completion, 'committed');
  assert.notEqual(await head(root), before);
  assert.equal(out.reconciliation.diskSha256, sha(await readFile(join(root, 'x.hwp'))));
});

test('(F10) disk read failure after follow sends followEnd without prepare', async t => {
  const { base, socketPath, y, server } = await seedTwo(t);
  const read = server.store.read;
  let reads = 0;
  server.store.read = async id => {
    if (id === 'x.hwp' && ++reads === 3) throw Object.assign(new Error('READ_AFTER_FOLLOW'), { code: 'EIO' });
    return read(id);
  };
  const run = runCode(socketPath, OPEN_X);
  const follow = await y.frame('agent.follow');
  await y.reply(follow.requestId, { ok: true });
  const claimed = await claimWith(base, 'x.hwp', follow.reservation);
  const x = await connectTab(t, base, (await claimed.json()).lease);
  const end = await x.frame('agent.followEnd');
  const out = await run;
  assert.equal(out.error, 'READ_AFTER_FOLLOW');
  assert.equal(out.follow.completion, 'none');
  assert.equal(end.completion, 'none');
  assert.equal(x.seen.includes('agent.prepare'), false);
  assert.equal(server.store.isLocked('x.hwp'), false);
});

test('(F16) unconfirmed release marks unsaved follow unknown and isolates lease', async t => {
  const { root, base, socketPath, y, server } = await seedTwo(t, { releaseDeadlineMs: 150 });
  const bytes = await readFile(join(root, 'x.hwp'));
  const run = runCode(socketPath, "const h=await hwp.open('x.hwp'); await hwp.insertText(h,{paragraph:0,text:'unsaved'})");
  const follow = await y.frame('agent.follow');
  await y.reply(follow.requestId, { ok: true });
  const claimed = await claimWith(base, 'x.hwp', follow.reservation);
  const lease = (await claimed.json()).lease;
  const x = await connectTab(t, base, lease);
  const prepare = await x.frame('agent.prepare');
  await x.reply(prepare.requestId, { ok: true, state: tabState('hwp'), diskSha256: sha(bytes),
    exportSha256: sha(bytes), contentLoss: noLoss('hwp') }, bytes);
  await x.frame('agent.release'); // deliberately withhold response
  const end = await x.frame('agent.followEnd');
  const out = await run;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.follow.completion, 'unknown');
  assert.equal(end.completion, 'unknown');
  assert.equal(server.tabs.isIsolated(lease), true);
  assert.equal(server.store.isLocked('x.hwp'), false);
});

test('(F14) zero-range edit followed by save fails and ends follow as none', async t => {
  const { root, base, socketPath, y } = await seedTwo(t);
  const bytes = await readFile(join(root, 'x.hwp'));
  const before = await head(root);
  const run = runCode(socketPath,
    "const h=await hwp.open('x.hwp'); await hwp.format(h,{paragraph:0,start:0,end:0},{bold:true}); await hwp.save(h)");
  const follow = await y.frame('agent.follow');
  await y.reply(follow.requestId, { ok: true });
  const claimed = await claimWith(base, 'x.hwp', follow.reservation);
  const x = await connectTab(t, base, (await claimed.json()).lease);
  const prepare = await x.frame('agent.prepare');
  await x.reply(prepare.requestId, { ok: true, state: tabState('hwp'), diskSha256: sha(bytes),
    exportSha256: sha(bytes), contentLoss: noLoss('hwp') }, bytes);
  const release = await x.frame('agent.release');
  await x.reply(release.requestId, { ok: true });
  const end = await x.frame('agent.followEnd');
  const out = await run;
  assert.equal(out.ok, false);
  assert.equal(out.error, 'save requires an edit');
  assert.equal(out.follow.completion, 'none');
  assert.equal(end.error, 'save requires an edit');
  assert.equal(end.completion, 'none');
  assert.equal(await head(root), before);
});

test('(F2) 저장 안 한 편집이 있는 셸은 DIRTY로 거절하고 runner는 디스크 경로로 간다', async t => {
  const { base, socketPath, y } = await seedTwo(t);
  const response = runCode(socketPath, OPEN_X);
  const follow = await y.frame('agent.follow');
  await y.reply(follow.requestId, { ok: false, error: { code: 'DIRTY', message: 'DIRTY' } });
  const out = await response;
  assert.match(out.error, /table|cell|invalid/i, JSON.stringify(out));
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
  assert.deepEqual(out.follow, { from: 'y.hwp', to: 'x.hwp', outcome: 'failed', code: 'FOLLOW_LOAD_FAILED', completion: 'none' });
  assert.match(out.error, /table|cell|invalid/i, JSON.stringify(out));
});

test('(F5) 수락 뒤 claim 전에 셸이 예약을 돌려주면 FOLLOW_CANCELLED → 디스크 경로', async t => {
  const { base, socketPath, y } = await seedTwo(t);
  const response = runCode(socketPath, OPEN_X);
  const follow = await y.frame('agent.follow');
  await y.reply(follow.requestId, { ok: true });
  const back = await fetch(`${base}/api/tabs/reservations/${follow.reservation}`, { method: 'DELETE' });
  assert.equal(back.status, 200);
  const out = await response;
  assert.deepEqual(out.follow, { from: 'y.hwp', to: 'x.hwp', outcome: 'failed', code: 'FOLLOW_CANCELLED', completion: 'none' });
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

test('wp3 E1: 첫 호출의 두 번째 다른 open 실패는 apply 없이 release하고 바이트를 유지한다', async t => {
  const bytes = await blankHwp();
  const { root, base, socketPath } = await seed(t, { bytes });
  const lease = await claimLease(base);
  const tab = await connectTab(t, base, lease);
  const before = await head(root);
  const run = runCode(socketPath, "const h=await hwp.open('a.hwp'); await hwp.open('b.hwp'); await hwp.save(h)");
  const prepare = await tab.frame('agent.prepare');
  await tab.reply(prepare.requestId, { ok: true, state: tabState('hwp'), diskSha256: sha(bytes),
    exportSha256: sha(bytes), contentLoss: noLoss('hwp') }, bytes);
  const release = await tab.frame('agent.release');
  assert.equal(release.token, prepare.requestId);
  await tab.reply(release.requestId, { ok: true });
  const out = await run;
  assert.equal(out.ok, false);
  assert.match(out.error, /one document per invocation/);
  assert.deepEqual(out.saved, []);
  assert.equal(tab.seen.includes('agent.apply'), false);
  await unchanged(root, 'a.hwp', bytes, before);
});

test('wp3 E2: unrecovered apply reply는 원인과 격리를 서버 응답까지 보존한다', async t => {
  const bytes = await blankHwp();
  const { root, base, socketPath } = await seed(t, { bytes });
  const lease = await claimLease(base);
  const tab = await connectTab(t, base, lease);
  const before = await head(root);
  const run = runCode(socketPath, "const h=await hwp.open('a.hwp'); await hwp.insertText(h,{paragraph:0,text:'x'}); await hwp.save(h)");
  const prepare = await tab.frame('agent.prepare');
  await tab.reply(prepare.requestId, { ok: true, state: tabState('hwp'), diskSha256: sha(bytes),
    exportSha256: sha(bytes), contentLoss: noLoss('hwp') }, bytes);
  const apply = await tab.frame('agent.apply');
  assert.equal(apply.token, prepare.requestId);
  await tab.reply(apply.requestId, { ok: false, error: { code: 'APPLY_STATE_UNKNOWN',
    message: 'APPLY_STATE_UNKNOWN: RPC_ERROR: transport dropped', recovered: null,
    causeCode: 'RPC_ERROR', causeMessage: 'transport dropped' },
    tab: { applied: false, committed: false, rollback: null, isolated: true } });
  const release = await tab.frame('agent.release');
  await tab.reply(release.requestId, { ok: true, tab: { isolated: true } });
  const out = await run;
  assert.equal(out.ok, false);
  assert.match(out.error, /APPLY_STATE_UNKNOWN: RPC_ERROR: transport dropped/);
  assert.deepEqual(out.saved, []);
  assert.equal((await humanPut(base, root, 'a.hwp', lease)).status, 409);
  const again = await runCode(socketPath, "await hwp.open('a.hwp')");
  assert.equal(again.ok, false);
  assert.match(again.error, /LEASE_ISOLATED/);
  await unchanged(root, 'a.hwp', bytes, before);
});

const channelWait = async predicate => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('agent channel response timeout');
};

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function sendChannelEvent(events, type, requestId, payload = {}) {
  const event = new Event(type);
  Object.defineProperty(event, 'data', { value: JSON.stringify({ schemaVersion: 1, type,
    requestId, docId: 'a.hwp', leaseId: 'lease-1', ...payload }) });
  events.dispatchEvent(event);
}

function channelHarness(t, { applyError, unlockError, replyGate, canFollow = async () => null,
    onReply, states = null, exports = null } = {}) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bytes = Uint8Array.of(1);
  const events = new EventTarget();
  const calls = [], replies = [], statuses = [], saveLocks = [];
  let locked = false;
  let inert = false;
  let stateReads = 0, exportReads = 0;
  const element = {
    get inert() { return inert; },
    set inert(value) { inert = value; calls.push(`inert=${value}`); },
  };
  const editor = {
    element,
    lidge: { request: async (method, params) => {
      if (method === 'lockInput') {
        calls.push(`lockInput:${params.on ? 'on' : 'off'}`);
        if (!params.on && unlockError) throw unlockError;
        locked = params.on;
        return { locked };
      }
      if (method === 'exportWithReport') return exports ? exports[Math.min(exportReads++, exports.length - 1)]
        : { bytes, contentLoss: noLoss('hwp') };
      if (method === 'applyOps') throw applyError;
      throw new Error(`unexpected ${method}`);
    } },
    getDocumentState: async () => states ? states[Math.min(stateReads++, states.length - 1)] : { documentSha256: sha(bytes) },
    loadFile: async () => { calls.push('loadFile'); },
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('/api/docs/')) return { ok: true, arrayBuffer: async () => bytes.buffer };
    assert.equal(init.method, 'POST');
    const body = typeof init.body === 'string' ? init.body : await init.body.text();
    const header = JSON.parse(body.split('\n')[0]);
    calls.push('POST reply');
    replies.push({ header, lockedAtReply: locked, inertAtReply: element.inert, saveLockedAtReply: saveLocks.at(-1) });
    onReply?.(header);
    if (replyGate && header.requestId === 'r') await replyGate.promise;
    return { ok: true, status: 204 };
  };
  const stop = startAgentChannel({ editor, events, docId: 'a.hwp', lease: 'lease-1',
    getDiskSha: () => sha(bytes), setDiskSha: () => {}, putDocument: async () => { throw new Error('unexpected PUT'); },
    showStatus: value => statuses.push(value), setSaveLocked: value => {
      calls.push(`saveLocked:${value}`); saveLocks.push(value);
    }, canFollow });
  const send = (type, id, payload) => sendChannelEvent(events, type, id, payload);
  const prepare = async () => { send('agent.prepare', 'p', { format: 'hwp' }); await channelWait(() => replies.length === 1); };
  return { send, prepare, calls, replies, statuses, saveLocks, editor, stop };
}

test('(P2) prepare pairs export bytes with state after caret stamp', async t => {
  const a = Uint8Array.of(1), b = Uint8Array.of(2);
  const state = hash => ({ documentSha256: hash, documentEpoch: 1, changeSeq: 0 });
  const f = channelHarness(t, { states: [state(sha(a)), state(sha(b))],
    exports: [{ bytes: b, contentLoss: noLoss('hwp') }] });
  await f.prepare();
  assert.equal(f.replies[0].header.ok, true);
  assert.equal(f.replies[0].header.exportSha256, sha(b));
  assert.equal(f.replies[0].header.state.documentSha256, sha(b));
});

test('(P2 stable) persistent hash mismatch is not retryable and carries both hashes', async t => {
  const a = Uint8Array.of(1), b = Uint8Array.of(2);
  const state = { documentSha256: sha(a), documentEpoch: 1, changeSeq: 0 };
  const f = channelHarness(t, { states: [state, state, state],
    exports: [{ bytes: b, contentLoss: noLoss('hwp') }, { bytes: b, contentLoss: noLoss('hwp') }] });
  await f.prepare();
  assert.equal(f.replies[0].header.ok, false);
  assert.equal(f.replies[0].header.error.code, 'SNAPSHOT_HASH_MISMATCH');
  assert.equal(f.replies[0].header.error.retryable, false);
  assert.equal(f.replies[0].header.error.hashes.snapshotSha256, sha(a));
  assert.equal(f.replies[0].header.error.hashes.exportSha256, sha(b));
});

test('(P2 changing) changing prepare reports TAB_CONNECTING as retryable', async t => {
  const a = Uint8Array.of(1), b = Uint8Array.of(2), c = Uint8Array.of(3);
  const state = (bytes, seq) => ({ documentSha256: sha(bytes), documentEpoch: 1, changeSeq: seq });
  const f = channelHarness(t, { states: [state(a, 0), state(a, 0), state(c, 1)],
    exports: [{ bytes: b, contentLoss: noLoss('hwp') }, { bytes: b, contentLoss: noLoss('hwp') }] });
  await f.prepare();
  assert.equal(f.replies[0].header.error.code, 'TAB_CONNECTING');
  assert.equal(f.replies[0].header.error.retryable, true);
});

test('wp3 channel 1: ordinary release stays inert until unlock and reply confirmation', async t => {
  const gate = deferred();
  const f = channelHarness(t, { replyGate: gate });
  await f.prepare();
  f.calls.length = 0;
  f.send('agent.release', 'r', { token: 'p' });
  await channelWait(() => f.replies.length === 2);
  assert.deepEqual(f.calls, ['inert=true', 'lockInput:off', 'POST reply']);
  assert.equal(f.replies[1].saveLockedAtReply, true);
  assert.equal(f.replies[1].inertAtReply, true);
  assert.equal(f.editor.element.inert, true);
  gate.resolve();
  await channelWait(() => f.calls.includes('inert=false'));
  assert.deepEqual(f.calls, ['inert=true', 'lockInput:off', 'POST reply', 'saveLocked:false', 'inert=false']);
});

test('wp3 channel 2: prepare waits for release acknowledgement', async t => {
  const gate = deferred();
  const f = channelHarness(t, { replyGate: gate });
  await f.prepare();
  f.send('agent.release', 'r', { token: 'p' });
  await channelWait(() => f.replies.length === 2);
  f.send('agent.prepare', 'p2', { format: 'hwp' });
  assert.equal(f.calls.filter(value => value === 'lockInput:on').length, 1);
  gate.resolve();
  await channelWait(() => f.replies.length === 3);
  assert.equal(f.replies[2].header.ok, true);
  assert.equal(f.calls.filter(value => value === 'lockInput:on').length, 2);
});

test('wp3 channel 3: lost release response holds tab and queued prepare is isolated', async t => {
  const gate = deferred();
  const f = channelHarness(t, { replyGate: gate });
  await f.prepare();
  f.send('agent.release', 'r', { token: 'p' });
  await channelWait(() => f.replies.length === 2);
  f.send('agent.prepare', 'p2', { format: 'hwp' });
  gate.reject(new Error('response lost'));
  await channelWait(() => f.replies.length === 3);
  assert.equal(f.replies[2].header.error.code, 'LEASE_ISOLATED');
  assert.equal(f.editor.element.inert, true);
  assert.equal(f.saveLocks.at(-1), true);
  assert.equal(f.calls.at(-1), 'POST reply');
  assert.ok(f.calls.includes('lockInput:on'));
  assert.ok(f.statuses.some(value => value.includes('응답이 확인되지 않음')));
});

test('wp3 channel 4: unlock failure reports isolation and keeps Save locked', async t => {
  const f = channelHarness(t, { unlockError: new Error('unlock failed') });
  await f.prepare();
  f.send('agent.release', 'r', { token: 'p' });
  await channelWait(() => f.replies.length === 2);
  assert.equal(f.replies[1].header.ok, true);
  assert.equal(f.replies[1].header.tab.isolated, true);
  assert.equal(f.saveLocks.includes(false), false);
  assert.equal(f.editor.element.inert, true);
});

test('wp3 channel 5: reload unlocks before loadFile but remains inert through reply', async t => {
  const gate = deferred();
  const f = channelHarness(t, { replyGate: gate });
  await f.prepare();
  f.calls.length = 0;
  f.send('agent.release', 'r', { token: 'p', reload: { diskSha256: 'a'.repeat(64), commit: 'abc' } });
  await channelWait(() => f.replies.length === 2);
  assert.deepEqual(f.calls, ['inert=true', 'lockInput:off', 'loadFile', 'POST reply']);
  assert.equal(f.editor.element.inert, true);
  gate.resolve();
  await channelWait(() => f.editor.element.inert === false);
  assert.deepEqual(f.calls.slice(-2), ['saveLocked:false', 'inert=false']);
  assert.equal(f.calls.filter(value => value === 'lockInput:off').length, 1);
});

test('wp3 channel 5b: reload reply loss leaves iframe inert', async t => {
  const gate = deferred();
  const f = channelHarness(t, { replyGate: gate });
  await f.prepare();
  f.send('agent.release', 'r', { token: 'p', reload: { diskSha256: 'a'.repeat(64), commit: 'abc' } });
  await channelWait(() => f.replies.length === 2);
  gate.reject(new Error('response lost'));
  await channelWait(() => f.statuses.some(value => value.includes('새로고침 필요')));
  assert.equal(f.editor.element.inert, true);
  assert.equal(f.saveLocks.at(-1), true);
});

test('wp3 channel 6: recovered false isolates and recovered true leaves tab usable', async t => {
  for (const recovered of [false, true]) {
    await t.test(`recovered=${recovered}`, async t => {
      const f = channelHarness(t, { applyError: Object.assign(new Error('rollback failed'),
        { code: 'ROLLBACK_FAILED', recovered }) });
      await f.prepare();
      f.send('agent.apply', 'a', { token: 'p', batch: { token: 'p' } });
      await channelWait(() => f.replies.length === 2);
      assert.equal(f.replies[1].header.error.code, recovered ? 'ROLLBACK_FAILED' : 'APPLY_STATE_UNKNOWN');
      assert.equal(f.replies[1].header.tab.isolated, !recovered);
      if (recovered) assert.equal(f.replies[1].header.error.recovered, true);
      else assert.equal(f.replies[1].header.error.causeCode, 'ROLLBACK_FAILED');
    });
  }
});

test('wp3 channel 7: unmarked apply error keeps cause in reply and status', async t => {
  const f = channelHarness(t, { applyError: new Error('transport dropped') });
  await f.prepare();
  f.send('agent.apply', 'a', { token: 'p', batch: { token: 'p' } });
  await channelWait(() => f.replies.length === 2);
  assert.deepEqual(f.replies[1].header.error, { code: 'APPLY_STATE_UNKNOWN',
    message: 'APPLY_STATE_UNKNOWN: APPLY_OPS_ERROR: transport dropped', recovered: null,
    causeCode: 'APPLY_OPS_ERROR', causeMessage: 'transport dropped' });
  assert.ok(f.statuses.some(value => value.includes('APPLY_OPS_ERROR') && value.includes('transport dropped')));
  assert.equal(f.replies[1].header.tab.isolated, true);
});

test('wp3 channel 7b: coded apply cause is preserved in reply', async t => {
  const f = channelHarness(t, { applyError: Object.assign(new Error('transport dropped'), { code: 'RPC_ERROR' }) });
  await f.prepare();
  f.send('agent.apply', 'a', { token: 'p', batch: { token: 'p' } });
  await channelWait(() => f.replies.length === 2);
  assert.deepEqual(f.replies[1].header.error, { code: 'APPLY_STATE_UNKNOWN',
    message: 'APPLY_STATE_UNKNOWN: RPC_ERROR: transport dropped', recovered: null,
    causeCode: 'RPC_ERROR', causeMessage: 'transport dropped' });
  assert.ok(f.statuses.some(value => value.includes('RPC_ERROR') && value.includes('transport dropped')));
});

test('wp3 channel 8: stop and follow stay busy until release reply is confirmed', async t => {
  const gate = deferred();
  const f = channelHarness(t, { replyGate: gate, canFollow: async () => null });
  await f.prepare();
  f.send('agent.release', 'r', { token: 'p' });
  await channelWait(() => f.replies.length === 2);
  await assert.rejects(f.stop, error => error.code === 'AGENT_BUSY');
  f.send('agent.follow', 'f', { targetDocId: 'b.hwp', reservation: 'next' });
  await channelWait(() => f.replies.length === 3);
  assert.equal(f.replies[2].header.error.code, 'BUSY');
  gate.resolve();
  await channelWait(() => f.editor.element.inert === false);
  await f.stop();
  f.send('agent.follow', 'f2', { targetDocId: 'b.hwp', reservation: 'next' });
  await channelWait(() => f.replies.length === 4);
  assert.equal(f.replies[3].header.ok, true);
});
// ── wp13: 새 helper 옵션(splitLines·format:'plain'·칸 scope·occurrence)이 기존 op 종류만 내고, 탭 재생으로 서명이 맞는다 ──
// 합성 탭은 Studio와 같은 규칙으로 재생한다: call은 api-registry.ts의 replayCall(결과 해시 확인), replaceText는 기록된 좌표,
// 나머지 op는 lib/ops.mjs applyOp(탭 agent-ops.ts와 같은 의미).
import { buildDoc, cellParas as wp13CellParas, cellChar as wp13CellChar, bodyParas as wp13BodyParas } from './helpers/wp13-docs.mjs';
async function replayLikeTab(bytes, batch) {
  const { replayCall } = await import('../rhwp/rhwp-studio/src/lidge/api-registry.ts');
  const doc = await openDocument(bytes);
  try {
    for (const op of batch.ops) {
      if (op.kind === 'call') replayCall(doc, op, s => sha(s));
      else if (op.kind === 'replaceText') {
        const a = op.resolved;
        assert.equal(doc.getTextRange(a.section, a.para, a.offset, a.length), op.args.find);
        doc.replaceText(a.section, a.para, a.offset, a.length, op.args.replace);
      } else applyOp(doc, newBatch({}), op.kind, op.args);
    }
    return Buffer.from(exportWithReport(doc, 'hwp').bytes);
  } finally { doc.free(); }
}
test('wp13: splitLines·format plain·칸 scope·occurrence op가 기존 op 종류로 탭에서 재생되고 서버 서명 확인(verify=bytes)', async t => {
  const bytes = await buildDoc({ body: ['foo foo'], table: { rows: 1, cols: 2 }, cells: { '0,0': '안내', '0,1': 'foo foo' }, gray: ['0,0'] });
  const env = await seed(t, { id: 'a.hwp', bytes, agentConfig: { releaseDeadlineMs: 3000 } });
  const lease = await claimLease(env.base, 'a.hwp');
  const tab = await connectTab(t, env.base, lease);
  const f = { ...env, id: 'a.hwp', bytes, format: 'hwp', lease, tab };
  const code = "const h = await hwp.open('a.hwp');" +
    " await hwp.setCell(h,{table:0,row:0,col:0,text:'첫째\\n\\n셋째',splitLines:true,format:'plain'});" +
    " await hwp.replaceText(h,{find:'foo',replace:'bar',scope:{table:0,row:0,col:1},occurrence:1});" +
    " await hwp.replaceText(h,{find:'foo',replace:'baz',occurrence:0});" +
    " await hwp.insertText(h,{paragraph:0,text:'끝1\\n끝2',splitLines:true});" +
    " await hwp.save(h); return 'ok'";
  const response = runCode(f.socketPath, code);
  const prepare = await tab.frame('agent.prepare');
  await tab.reply(prepare.requestId, preparedReply(f), bytes);
  const first = await Promise.race([tab.frame('agent.apply').then(apply => ({ apply })), response.then(out => ({ out }))]);
  assert.ok(first.apply, JSON.stringify(first.out));
  const { apply } = first;
  assert.ok(apply.batch.ops.every(o => ['setCell', 'insertTextInCell', 'replaceText', 'insertText', 'call'].includes(o.kind)));
  const put = await agentPut(f, apply, await replayLikeTab(bytes, apply.batch));
  assert.equal(put.status, 200, await put.clone().text());
  const saved = await put.json();
  assert.equal(saved.verify, 'bytes');
  assert.equal((await tab.reply(apply.requestId, { ok: true, diskSha256: saved.sha256, commit: saved.commit })).status, 204);
  const release = await tab.frame('agent.release');
  await tab.reply(release.requestId, { ok: true });
  const out = await response;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.saved[0].commit, await head(env.root));
  const disk = await openDocument(await readFile(join(env.root, 'a.hwp')));
  try {
    assert.deepEqual(wp13CellParas(disk, 0, 0, 0), ['첫째', '', '셋째']);
    assert.equal(wp13CellChar(disk, 0, 0, 0).textColor, '#000000');
    assert.equal(wp13CellChar(disk, 0, 0, 0).italic, false);
    assert.deepEqual(wp13CellParas(disk, 0, 0, 1), ['foo bar']);
    assert.deepEqual(wp13BodyParas(disk).slice(0, 2), ['baz foo끝1', '끝2']);
  } finally { disk.free(); }
});
