import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_TOOL_SPEC } from '../mcp/office-server.mjs';

const SERVER = fileURLToPath(new URL('../mcp/office-server.mjs', import.meta.url));

test('office MCP server: its own name, one tool, calls go to the agent socket as tool office', async t => {
  const home = await mkdtemp('/tmp/jom-');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.lidge-hwp', 'run'), { recursive: true });
  const seen = [];
  const agent = net.createServer(conn => {
    let input = ''; conn.setEncoding('utf8');
    conn.on('data', chunk => {
      input += chunk; const end = input.indexOf('\n'); if (end < 0) return;
      const req = JSON.parse(input.slice(0, end)); seen.push(req);
      conn.end(JSON.stringify({ id: req.id, ok: true, result: 3, logs: [], saved: [] }) + '\n');
    });
  });
  await new Promise(resolve => agent.listen(join(home, '.lidge-hwp', 'run', 'agent.sock'), resolve));
  t.after(() => new Promise(resolve => agent.close(resolve)));
  const env = { ...process.env, HOME: home };
  delete env.LIDGE_HWP_CLIENT_DEADLINE_MS;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buffer = ''; const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk; let i;
    while ((i = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); waiters.get(m.id)?.(m); }
  });
  const call = (id, method, params) => new Promise(resolve => { waiters.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const init = await call(1, 'initialize', { protocolVersion: '2025-03-26' });
  assert.equal(init.result.serverInfo.name, 'jongi-office');
  assert.match(init.result.instructions, /office_exec/);
  const list = await call(2, 'tools/list', {});
  assert.deepEqual(list.result.tools, [JSON.parse(JSON.stringify(OFFICE_TOOL_SPEC))]);
  assert.equal(list.result.tools[0].name, 'office_exec');
  const reply = await call(3, 'tools/call', { name: 'office_exec', arguments: { code: 'return 3' } });
  assert.equal(reply.result.isError, false);
  assert.equal(JSON.parse(reply.result.content[0].text).result, 3);
  assert.equal(seen[0].tool, 'office');
  assert.equal(seen[0].code, 'return 3');
  const wrong = await call(4, 'tools/call', { name: 'hwp_exec', arguments: { code: 'return 1' } });
  assert.equal(wrong.error.code, -32601);
});

