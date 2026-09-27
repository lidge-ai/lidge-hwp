import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NAME, TOOL, buildEntry, registrationBody, replScript, parseTagged, parseArgs, exitCodeFor, nextStep }
  from '../aside/register.mjs';

const ENTRY = buildEntry({ execPath: '/opt/node-v26/bin/node', serverPath: '/repo/mcp/server.mjs' });
const input = (action, dryRun = false, entry = ENTRY) => ({ name: NAME, tool: TOOL, entry, action, dryRun });
// u1 실측 모양(2026-09-26): 다른 서버 하나, 그 캐시, 마이그레이션 버전 1. 도구 항목은 객체다.
function u1Like() {
  return { mcp: {
    toolInventoryMigrationVersion: 1,
    servers: { 'aside-codemode': { enabled: true, transport: 'stdio', command: '/opt/node-v26/bin/node',
      args: ['/x/src/server.js'], env: {} } },
    inventories: { 'aside-codemode': { tools: [{ name: 'execute_code', title: 'Execute', description: 'd',
      inputSchema: { type: 'object' } }], refreshedAt: '2026-09-22T08:55:54.019Z' } } } };
}
function withOurTool(state, entry = ENTRY) {
  state.mcp.servers[NAME] = entry;
  state.mcp.inventories[NAME] = { tools: [{ name: TOOL, title: TOOL, description: 'd',
    inputSchema: { type: 'object' } }], refreshedAt: '2026-09-26T12:00:00.000Z' };
  return state;
}
function fakeAside(state) {
  const writes = [];
  return { writes, settings: {
    async getAll() { return structuredClone(state); },
    async set(key, value) { writes.push(key); state[key] = structuredClone(value); } } };
}

test('등록 항목은 Node 절대 경로와 60초 경계 env를 담는다', () => {
  assert.deepEqual(ENTRY, { enabled: true, transport: 'stdio', command: '/opt/node-v26/bin/node',
    args: ['/repo/mcp/server.mjs'], env: { LIDGE_HWP_CLIENT_DEADLINE_MS: '50000' } });
});

test('u1 모양에 등록하면 자기 항목만 더하고 발견 키와 다른 서버는 그대로 둔다', async () => {
  const state = u1Like(); const before = structuredClone(state); const aside = fakeAside(state);
  const r = await registrationBody(aside, input('register'));
  assert.deepEqual(aside.writes, ['mcp']);
  assert.equal(r.ok, true); assert.equal(r.changed, true); assert.equal(r.othersKept, true);
  assert.equal(r.refreshRequired, true); assert.equal(r.discovered, false); assert.equal(r.agentTool, null);
  assert.deepEqual(r.atRisk, ['aside-codemode']); assert.deepEqual(r.cached, ['aside-codemode']);
  assert.equal(state.mcp.toolInventoryMigrationVersion, 1);
  assert.deepEqual(state.mcp.servers['aside-codemode'], before.mcp.servers['aside-codemode']);
  assert.deepEqual(state.mcp.inventories, before.mcp.inventories);
  assert.deepEqual(state.mcp.servers[NAME], ENTRY);
  assert.equal(exitCodeFor(r), 2);
});

test('같은 항목에 도구가 발견돼 있으면 쓰지 않고 에이전트 도구 이름을 돌려준다', async () => {
  const state = withOurTool(u1Like()); const aside = fakeAside(state);
  const r = await registrationBody(aside, input('register'));
  assert.deepEqual(aside.writes, []);
  assert.equal(r.changed, false); assert.equal(r.refreshRequired, false); assert.equal(r.discovered, true);
  assert.equal(r.agentTool, 'mcp__lidge-hwp__hwp_exec');
  assert.equal(exitCodeFor(r), 0);
});

test('항목이 바뀌면 예전 캐시가 있어도 새로 고침을 요구한다', async () => {
  const state = withOurTool(u1Like(), { ...ENTRY, command: '/old/node' });
  const r = await registrationBody(fakeAside(state), input('register'));
  assert.equal(r.changed, true); assert.equal(r.refreshRequired, true); assert.equal(r.discovered, false);
});

test('다른 이름의 도구만 캐시돼 있으면 발견으로 치지 않는다', async () => {
  const state = withOurTool(u1Like());
  state.mcp.inventories[NAME].tools = [{ name: 'other', title: 'o', description: 'd', inputSchema: {} }];
  const r = await registrationBody(fakeAside(state), input('check', true));
  assert.equal(r.discovered, false); assert.equal(exitCodeFor(r), 2);
});

test('dry-run은 쓰지 않고 after만 보여 준다', async () => {
  const state = u1Like(); const before = structuredClone(state); const aside = fakeAside(state);
  const r = await registrationBody(aside, input('register', true));
  assert.deepEqual(aside.writes, []); assert.deepEqual(state, before);
  assert.deepEqual(r.after, ENTRY); assert.equal(r.before, null); assert.equal(exitCodeFor(r), 0);
});

test('꺼진 다른 서버도 위험 목록에 센다', async () => {
  const state = u1Like();
  state.mcp.servers.off = { enabled: false, transport: 'stdio', command: '/bin/false', args: [], env: {} };
  const r = await registrationBody(fakeAside(state), input('register', true));
  assert.deepEqual(r.atRisk, ['aside-codemode', 'off']);
});

test('해제는 자기 서버와 자기 캐시만 지운다', async () => {
  const state = withOurTool(u1Like()); const base = u1Like();
  const r = await registrationBody(fakeAside(state), input('unregister'));
  assert.equal(r.ok, true); assert.equal(r.changed, true); assert.equal(r.after, null);
  assert.deepEqual(state, base); assert.equal(exitCodeFor(r), 0);
});

test('등록과 해제 전후의 다른 서버 지문이 같다', async () => {
  const state = u1Like();
  const a = await registrationBody(fakeAside(state), input('register', true));
  const b = await registrationBody(fakeAside(state), input('register'));
  const c = await registrationBody(fakeAside(state), input('unregister'));
  assert.equal(a.othersFingerprint, b.othersFingerprint); assert.equal(b.othersFingerprint, c.othersFingerprint);
});

test('REPL로 보내는 문자열이 같은 함수를 스스로 담는다', async () => {
  const lines = []; const AsyncFunction = (async () => {}).constructor;
  const state = u1Like(); const before = structuredClone(state);
  await new AsyncFunction('aside', 'console', replScript(input('register', true)))(
    fakeAside(state), { log: line => lines.push(line) });
  const r = parseTagged(['[repl] ready', ...lines, '[done | 21ms]'].join('\n'));
  assert.equal(r.dryRun, true); assert.equal(r.changed, true); assert.deepEqual(state, before);
  assert.throws(() => parseTagged('12:00 only a timing line'), /no tagged result/);
});

test('옵션 해석', () => {
  assert.deepEqual(parseArgs([]), { action: 'register', dryRun: false });
  assert.deepEqual(parseArgs(['--check']), { action: 'check', dryRun: true });
  assert.deepEqual(parseArgs(['--unregister', '--dry-run']), { action: 'unregister', dryRun: true });
  assert.throws(() => parseArgs(['--force']), /unknown option/);
  assert.throws(() => parseArgs(['--check', '--unregister']), /conflict/);
});

test('설명만 바뀐 캐시는 stale: check가 발견으로 치지 않고 Refresh tools를 안내한다', async () => {
  const state = withOurTool(u1Like()); // 캐시 설명 'd'
  const stale = await registrationBody(fakeAside(state), { ...input('check', true), description: 'new description' });
  assert.equal(stale.stale, true); assert.equal(stale.discovered, false);
  assert.equal(exitCodeFor(stale), 2);
  assert.match(nextStep(stale), /Refresh tools/);
  const fresh = await registrationBody(fakeAside(withOurTool(u1Like())), { ...input('check', true), description: 'd' });
  assert.equal(fresh.stale, false); assert.equal(fresh.discovered, true);
  assert.equal(nextStep(fresh), null);
  // 설명을 주지 않으면 예전처럼 이름만 본다
  assert.equal((await registrationBody(fakeAside(withOurTool(u1Like())), input('check', true))).discovered, true);
});

test('CLI는 PATH의 Aside와 활성 기본 계정, local 호스트를 쓴다', async (t) => {
  const result = await invokeCli(t);
  assert.deepEqual(result.argv.slice(0, -1), ['--host', 'local', 'repl']);
  assert.equal(result.argv.at(-1), replScript({ name: NAME, tool: TOOL,
    entry: buildEntry(), action: 'check', dryRun: true, description: (await import('../mcp/tool.mjs')).TOOL_SPEC.description }));
});

test('CLI는 ASIDE_BIN, ASIDE_ACCOUNT, ASIDE_HOST 값을 각각 하나의 인자로 전달한다', async (t) => {
  const result = await invokeCli(t, { ASIDE_ACCOUNT: 'work account; echo unexpected', ASIDE_HOST: 'remote host' }, true);
  assert.deepEqual(result.argv.slice(0, -1),
    ['--account', 'work account; echo unexpected', '--host', 'remote host', 'repl']);
  assert.equal(result.binary, 'override');
});

test('빈 계정은 플래그를 생략하고 호스트만 재정의할 수 있다', async (t) => {
  const result = await invokeCli(t, { ASIDE_ACCOUNT: '', ASIDE_HOST: 'other-host' });
  assert.deepEqual(result.argv.slice(0, -1), ['--host', 'other-host', 'repl']);
});

test('계정만 재정의하면 빈 호스트는 local로 돌아간다', async (t) => {
  const result = await invokeCli(t, { ASIDE_ACCOUNT: 'work', ASIDE_HOST: '' });
  assert.deepEqual(result.argv.slice(0, -1), ['--account', 'work', '--host', 'local', 'repl']);
});

async function invokeCli(t, overrides = {}, overrideBin = false) {
  const dir = await mkdtemp(join(tmpdir(), 'lidge-aside-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [filename, binary] of [['aside', 'path'], ['custom aside', 'override']]) {
    await writeFile(join(dir, filename), `#!${process.execPath}
console.log(JSON.stringify({ lidgeRegistration: 1, ok: true, action: 'check', discovered: true,
  argv: process.argv.slice(2), binary: ${JSON.stringify(binary)} }));
`, { mode: 0o755 });
  }
  const env = { ...process.env };
  for (const key of ['ASIDE_BIN', 'ASIDE_ACCOUNT', 'ASIDE_HOST']) delete env[key];
  Object.assign(env, { PATH: dir + delimiter + process.env.PATH }, overrides);
  if (overrideBin) env.ASIDE_BIN = join(dir, 'custom aside');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../aside/register.mjs', import.meta.url)), '--check'],
    { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
