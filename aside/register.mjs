#!/usr/bin/env node
// Aside 라이브 설정에 lidge-hwp MCP 서버를 등록·해제·확인한다. aside repl 안의 aside.settings만 쓴다.
// ASIDE_BIN: 실행 파일(기본 PATH의 aside). ASIDE_ACCOUNT: 생략하면 Aside의 활성 기본 계정.
// ASIDE_HOST: 대상 호스트(기본 local).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { TOOL_SPEC } from '../mcp/tool.mjs';

export const NAME = 'lidge-hwp';
export const TOOL = 'hwp_exec';
export const CLIENT_DEADLINE_MS = '50000'; // Aside 데몬 tools/call 60초보다 짧게
const ASIDE = process.env.ASIDE_BIN || 'aside';
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp/server.mjs');

export function buildEntry({ execPath = process.execPath, serverPath = SERVER } = {}) {
  return { enabled: true, transport: 'stdio', command: execPath, args: [serverPath],
    env: { LIDGE_HWP_CLIENT_DEADLINE_MS: CLIENT_DEADLINE_MS } };
}

// aside repl로 문자열째 보낸다. 바깥 변수·import를 참조하지 않는다.
export async function registrationBody(aside, input) {
  const { name, tool, entry, action, dryRun, description = null } = input;
  const stable = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);
  const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
  const toolsOf = m => (Array.isArray(m?.inventories?.[name]?.tools) ? m.inventories[name].tools : []);
  const cachedTool = m => toolsOf(m).find(t => t?.name === tool);
  // 설명까지 같아야 발견으로 친다. 이름만 같고 설명이 옛것이면 stale(Refresh tools 필요).
  const found = m => m?.servers?.[name]?.enabled === true && Boolean(cachedTool(m))
    && (description === null || cachedTool(m).description === description);
  // 자기 항목을 뺀 나머지 전부(다른 서버, 다른 캐시, toolInventoryMigrationVersion 등)
  const othersOf = m => {
    const names = [...new Set([...Object.keys(m.servers || {}), ...Object.keys(m.inventories || {})])]
      .filter(n => n !== name).sort();
    const rest = Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'servers' && k !== 'inventories'));
    return stable({ rest, others: names.map(n => [n, m.servers?.[n] ?? null, m.inventories?.[n] ?? null]) });
  };

  const mcp = (await aside.settings.getAll())?.mcp || {};
  const servers = { ...(mcp.servers || {}) };
  const hasInventories = Object.hasOwn(mcp, 'inventories');
  const inventories = { ...(mcp.inventories || {}) };
  const before = servers[name] ?? null;
  const atRisk = Object.keys(servers).filter(n => n !== name); // 꺼진 서버도 센다
  const cached = Object.keys(inventories).filter(n => n !== name);
  let expected = before;
  let changed = false;
  if (action === 'register') {
    expected = entry;
    changed = stable(before) !== stable(entry);
    if (changed) servers[name] = entry;
  } else if (action === 'unregister') {
    expected = null;
    changed = before !== null || Object.hasOwn(inventories, name);
    delete servers[name];
    delete inventories[name];
  }
  // inventory 키는 초기화하지 않는다. 나머지 키는 그대로 복사한다.
  const next = { ...mcp, servers, ...(hasInventories ? { inventories } : {}) };
  if (!dryRun && changed) await aside.settings.set('mcp', next);
  const observed = dryRun ? next : ((await aside.settings.getAll())?.mcp || {});
  const othersKept = othersOf(observed) === othersOf(mcp);
  const ok = stable(observed.servers?.[name] ?? null) === stable(expected) && othersKept;
  // 항목이 바뀌면 예전 캐시가 있어도 서버별 Refresh tools를 다시 요구한다.
  const refreshRequired = action === 'register' && (changed || !found(mcp));
  const discovered = action !== 'unregister' && !refreshRequired && found(observed);
  const own = toolsOf(observed).find(t => t?.name === tool);
  const stale = Boolean(cachedTool(observed)) && description !== null && cachedTool(observed).description !== description;
  return { lidgeRegistration: 1, ok, action, dryRun, changed, refreshRequired, discovered, stale,
    agentTool: discovered ? 'mcp__' + name + '__' + own.name.replace(/[^A-Za-z0-9_-]/g, '_') : null,
    tools: toolsOf(observed).map(t => t?.name).filter(n => typeof n === 'string'),
    refreshedAt: observed.inventories?.[name]?.refreshedAt ?? null,
    atRisk, cached, othersKept, othersFingerprint: fnv(othersOf(observed)), before, after: expected };
}

export function replScript(input) {
  return 'console.log(JSON.stringify(await (' + registrationBody.toString() + ')(aside, ' + JSON.stringify(input) + ')));';
}

export function parseTagged(stdout) {
  for (const line of String(stdout).split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line);
      if (value?.lidgeRegistration === 1) return value;
    } catch { /* Aside의 시간 표시 줄은 JSON이 아니다 */ }
  }
  throw new Error('aside repl returned no tagged result');
}

export function parseArgs(argv) {
  const known = new Set(['--dry-run', '--unregister', '--check']);
  for (const arg of argv) if (!known.has(arg)) throw new Error('unknown option: ' + arg);
  const flags = new Set(argv);
  if (flags.has('--check') && flags.has('--unregister')) throw new Error('--check and --unregister conflict');
  const action = flags.has('--unregister') ? 'unregister' : flags.has('--check') ? 'check' : 'register';
  return { action, dryRun: flags.has('--dry-run') || action === 'check' };
}

// 캐시가 없거나(refreshRequired) 옛 설명이면(stale) 사용자가 Aside에서 Refresh tools를 눌러야 한다.
export function nextStep(result) {
  return (result.refreshRequired || result.stale)
    ? 'Refresh tools for lidge-hwp (the user clicks it in the Aside app: Settings > Plugins & MCPs > MCPs > lidge-hwp), then: node aside/register.mjs --check'
    : null;
}

export function exitCodeFor(result) {
  if (!result.ok) return 1;
  if (result.action === 'register' && !result.dryRun && !result.discovered) return 2;
  if (result.action === 'check' && !result.discovered) return 2;
  return 0;
}

function runRepl(script) {
  const account = process.env.ASIDE_ACCOUNT;
  const args = [...(account ? ['--account', account] : []),
    '--host', process.env.ASIDE_HOST || 'local', 'repl', script];
  const r = spawnSync(ASIDE, args,
    { encoding: 'utf8', timeout: 150000, maxBuffer: 1024 * 1024 });
  if (r.error || r.status !== 0 || /\[error\s*\|/.test(r.stdout || ''))
    throw new Error('aside repl failed: ' + (r.error?.message || r.stderr?.trim() || r.stdout?.trim() || r.status));
  return parseTagged(r.stdout);
}

async function main() {
  try {
    const { action, dryRun } = parseArgs(process.argv.slice(2));
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 26) throw new Error('run with Node 26; command would be ' + process.execPath + ' ' + process.version);
    if (action === 'register' && !existsSync(SERVER)) throw new Error('missing MCP server: ' + SERVER);
    const result = runRepl(replScript({ name: NAME, tool: TOOL, entry: buildEntry(), action, dryRun, description: TOOL_SPEC.description }));
    result.next = nextStep(result);
    console.log(JSON.stringify(result));
    process.exitCode = exitCodeFor(result);
  } catch (error) {
    console.error('[aside/register]', error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
