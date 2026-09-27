import test from 'node:test'; import assert from 'node:assert/strict';
import net from 'node:net'; import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises'; import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));

async function fakeAgent(t, replyAfterMs, reply) {
  const home = await mkdtemp('/tmp/lhm-'); // Unix 소켓 경로 길이 때문에 짧게
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.lidge-hwp', 'run'), { recursive: true });
  const seen = { requests: [], replied: false, closedBeforeReply: false };
  const server = net.createServer(conn => {
    let input = ''; conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('close', () => { if (!seen.replied) seen.closedBeforeReply = true; });
    conn.on('data', chunk => {
      input += chunk; const end = input.indexOf('\n'); if (end < 0) return;
      const req = JSON.parse(input.slice(0, end)); seen.requests.push(req);
      setTimeout(() => { seen.replied = true; conn.end(JSON.stringify({ id: req.id, ...reply }) + '\n'); }, replyAfterMs);
    });
  });
  await new Promise(resolve => server.listen(join(home, '.lidge-hwp', 'run', 'agent.sock'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { home, seen };
}

function startMcp(t, home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, ...extraEnv };
  if (!Object.hasOwn(extraEnv, 'LIDGE_HWP_CLIENT_DEADLINE_MS')) delete env.LIDGE_HWP_CLIENT_DEADLINE_MS;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buffer = ''; let stderr = ''; const waiters = new Map();
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk; let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      waiters.get(message.id)?.(message);
    }
  });
  const call = (id, method, params) => new Promise(resolve => {
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, call, stderr: () => stderr };
}

test('클라이언트 한도가 있으면 한도에 CLIENT_DEADLINE으로 답하고 소켓 요청은 끊지 않는다', async t => {
  const { home, seen } = await fakeAgent(t, 8000, { ok: true, saved: [] });
  const mcp = startMcp(t, home, { LIDGE_HWP_CLIENT_DEADLINE_MS: '6000' });
  const started = Date.now();
  const reply = await mcp.call(1, 'tools/call', { name: 'hwp_exec', arguments: { code: 'return 1', timeoutMs: 120000 } });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 5900 && elapsed < 7900, 'elapsed ' + elapsed);
  assert.equal(reply.result.isError, true);
  const out = JSON.parse(reply.result.content[0].text);
  assert.equal(out.error, 'CLIENT_DEADLINE'); assert.equal(out.stillRunning, true);
  assert.equal(out.requestId, seen.requests[0].id);
  assert.equal(seen.requests[0].timeoutMs, 1000); // min(120000, 6000-5000)
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(seen.replied, true); assert.equal(seen.closedBeforeReply, false);
  assert.match(mcp.stderr(), /late result \S+ ok=true/);
});

test('한도 환경변수가 없으면 기존처럼 소켓 답을 기다리고 timeoutMs를 바꾸지 않는다', async t => {
  const { home, seen } = await fakeAgent(t, 300, { ok: true, value: 1 });
  const mcp = startMcp(t, home);
  const reply = await mcp.call(1, 'tools/call', { name: 'hwp_exec', arguments: { code: 'return 1', timeoutMs: 70000 } });
  assert.equal(reply.result.isError, false);
  assert.equal(JSON.parse(reply.result.content[0].text).value, 1);
  assert.equal(seen.requests[0].timeoutMs, 70000);
});

test('잘못된 한도 값이면 시작하지 않는다', async t => {
  const { home } = await fakeAgent(t, 0, {});
  const mcp = startMcp(t, home, { LIDGE_HWP_CLIENT_DEADLINE_MS: '100' });
  const code = await new Promise(resolve => mcp.child.once('exit', resolve));
  assert.notEqual(code, 0);
});
