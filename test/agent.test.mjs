import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join, extname } from 'node:path';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { createDocStore } from '../lib/docstore.mjs';
import { createTabs } from '../server/tabs.mjs';
const git = promisify(execFile);
test('no-tab KU copy commits after injected refusal and contentLoss', async t => {
  const fixture = process.env.LIDGE_HWP_KU_FIXTURE;
  if (!fixture) return t.skip('set LIDGE_HWP_KU_FIXTURE to a private KU form');
  const root = await mkdtemp(join(tmpdir(), 'lidge-hwp-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'form' + extname(fixture).toLowerCase(); await cp(fixture, join(root, id));
  await git('git', ['-C', root, 'init', '-q']);
  await git('git', ['-C', root, 'add', '--', id]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed']);
  const [{ runAgent }, { ensureRepo }] = await Promise.all([
    import('../server/agent/runner.mjs'), import('../lib/git.mjs')]);
  await ensureRepo(root);
  const context = { store: createDocStore(root), tabs: createTabs(), config: {
    exporter: () => { throw new Error('forced rhwp refusal'); } } };
  const table = Number(process.env.LIDGE_HWP_KU_TABLE ?? 0);
  const row = Number(process.env.LIDGE_HWP_KU_ROW ?? 0);
  const col = Number(process.env.LIDGE_HWP_KU_COL ?? 0);
  const code = `const h=await hwp.open(${JSON.stringify(id)}); await hwp.setCell(h,{table:${table},row:${row},col:${col},text:'검증'}); await hwp.save(h); return 'ok';`;
  const out = await runAgent({ code }, context);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.saved[0].engine, 'kordoc');
  assert.ok(out.saved[0].commit);
  assert.ok((await readFile(join(root, id))).length > 0);
  context.config.exporter = () => ({ bytes: new Uint8Array(1), report: { count: 1 } });
  const second = await runAgent({ code: code.replace('검증', '검증2') }, context);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.saved[0].engine, 'kordoc');
  assert.notEqual(second.saved[0].commit, out.saved[0].commit);
});

async function seedRepo(t, fixture) {
  const root = await mkdtemp(join(tmpdir(), 'lidge-hwp-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'form' + extname(fixture).toLowerCase(); await cp(fixture, join(root, id));
  await git('git', ['-C', root, 'init', '-q']);
  await git('git', ['-C', root, 'add', '--', id]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed']);
  return { root, id };
}
const head = async root => (await git('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();

test('no-tab disk edit through rhwp overwrites the file and commits it', async t => {
  const fixture = process.env.LIDGE_HWP_KU_FIXTURE;
  if (!fixture) return t.skip('set LIDGE_HWP_KU_FIXTURE to a private KU form');
  const { root, id } = await seedRepo(t, fixture);
  const { runAgent } = await import('../server/agent/runner.mjs');
  const context = { store: createDocStore(root), tabs: createTabs(), config: {} };
  const seed = await head(root);
  const out = await runAgent({ code: `const h=await hwp.open(${JSON.stringify(id)}); await hwp.setCell(h,{table:0,row:0,col:0,text:'디스크검증'}); await hwp.save(h); return 'ok';` }, context);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.saved[0].engine, 'rhwp');
  assert.equal(out.saved[0].commit, await head(root));
  assert.notEqual(out.saved[0].commit, seed);
  const changed = (await git('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'])).stdout.trim();
  assert.equal(changed, id);
  const reread = await runAgent({ code: `const h=await hwp.open(${JSON.stringify(id)}); return await hwp.cells(h,{table:0});` }, context);
  assert.equal(reread.ok, true, JSON.stringify(reread));
  assert.match(JSON.stringify(reread.result), /디스크검증/);
});

test('kordoc fallback on a KU .hwp that kordoc cannot patch fails closed', async t => {
  const fixture = process.env.LIDGE_HWP_KU_HWP_FIXTURE;
  if (!fixture) return t.skip('set LIDGE_HWP_KU_HWP_FIXTURE to a private KU .hwp form');
  const { root, id } = await seedRepo(t, fixture);
  const { runAgent } = await import('../server/agent/runner.mjs');
  const context = { store: createDocStore(root), tabs: createTabs(), config: {
    exporter: () => { throw new Error('forced rhwp refusal'); } } };
  const before = await readFile(join(root, id)); const seed = await head(root);
  const out = await runAgent({ code: `const h=await hwp.open(${JSON.stringify(id)}); await hwp.setCell(h,{table:0,row:0,col:0,text:'검증'}); await hwp.save(h);` }, context);
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.ok(Buffer.compare(before, await readFile(join(root, id))) === 0, 'bytes unchanged');
  assert.equal(await head(root), seed);
  assert.equal(out.reconciliation.lastCommit, seed);
});
// ── wp13 (010 Revision 2~4): hwp_exec 결과까지의 오류 전달·크기 한도·paging. 공개 fixture, env skip 없음 ──
import { buildDoc, seedBytes, openBytes, cellParas, cellChar, bodyParas, GRAY } from './helpers/wp13-docs.mjs';
const outBytes = v => Buffer.byteLength(JSON.stringify(v));
const OPEN = "const h=await hwp.open('a.hwp');";

test('wp13 R2-1 hwp_exec replaceText mismatch는 code·좌표 details를 MCP 결과까지 싣고 저장하지 않는다', async t => {
  const s = await seedBytes(t, await buildDoc({ body: ['foo foo'] }));
  const out = await s.exec(`${OPEN} await hwp.replaceText(h,{find:'foo',replace:'x',expectedCount:3}); await hwp.save(h);`);
  assert.equal(out.ok, false);
  assert.ok(out.error.startsWith('replace count mismatch: 2'), out.error);
  assert.equal(out.code, 'REPLACE_COUNT_MISMATCH', JSON.stringify(out));
  const details = { expectedCount: 3, actualCount: 2, omitted: 0, next: null,
    positions: [{ section: 0, paragraph: 0, offset: 0, length: 3 }, { section: 0, paragraph: 0, offset: 4, length: 3 }] };
  assert.deepEqual(out.details, details);
  assert.deepEqual(JSON.parse(JSON.stringify(out)).details, details); // mcp/server.mjs:49가 하는 직렬화
  assert.deepEqual(out.saved, []);
  assert.equal(out.reconciliation.diskSha256, s.seedSha);
  assert.equal(await s.head(), s.seedHead);
  const caught = await s.exec(`${OPEN} try { await hwp.replaceText(h,{find:'foo',replace:'x',expectedCount:3}); } catch (e) { return e.details; } return 'no';`);
  assert.equal(caught.ok, false); // worker.mjs:21,37: 잡아도 host 실패는 호출 실패다
  assert.equal(caught.code, 'REPLACE_COUNT_MISMATCH');
  assert.deepEqual(caught.details, details);
});

test('wp13 R2-1/R3 hwp_exec mismatch는 100개로 제한되고 find paging이 같은 순서를 잇는다', async t => {
  const s = await seedBytes(t, await buildDoc({ body: ['foo '.repeat(2000)] }));
  const out = await s.exec(`${OPEN} await hwp.replaceText(h,{find:'foo',replace:'x',expectedCount:1});`);
  assert.equal(out.code, 'REPLACE_COUNT_MISMATCH', JSON.stringify(out).slice(0, 300));
  assert.equal(out.details.positions.length, 100);
  assert.equal(out.details.omitted, 1900);
  assert.deepEqual(out.details.next, { method: 'find', args: { query: 'foo', caseSensitive: true, scope: null, from: 100, limit: 100 } });
  assert.ok(outBytes(out) < 20000, String(outBytes(out)));
  assert.ok(out.error.length < 2048, String(out.error.length));
  const page = await s.exec(`${OPEN} return await hwp.find(h, ${JSON.stringify(out.details.next.args)});`);
  assert.equal(page.ok, true, JSON.stringify(page).slice(0, 300));
  assert.equal(page.result.total, 2000); assert.equal(page.result.count, 100);
  assert.deepEqual(page.result.positions[0], { section: 0, paragraph: 0, offset: 400, length: 3 });
  const one = await s.exec(`${OPEN} return (await hwp.find(h, {query:'foo',scope:null,from:99,limit:1})).positions[0];`);
  assert.deepEqual(one.result, out.details.positions[99]);
  for (const bad of ['{query:"foo",from:-1,limit:10}', '{query:"foo",limit:501}']) {
    const r = await s.exec(`${OPEN} return await hwp.find(h, ${bad});`);
    assert.equal(r.code, 'API_ARGS_INVALID', JSON.stringify(r));
  }
  const legacy = await s.exec(`${OPEN} return await hwp.find(h, {query:'foo',includeCells:true});`);
  assert.equal(legacy.ok, false); assert.match(legacy.error, /result too large/); // paging 없는 기존 find는 그대로
});

test('wp13 R2-1 wireError: code 형식·16KiB details·4096자 message로 제한', async () => {
  const { wireError, MAX_DETAILS_BYTES } = await import('../server/agent/wire-error.mjs');
  assert.equal(MAX_DETAILS_BYTES, 16384);
  const big = { positions: Array.from({ length: 5000 }, (_, i) => ({ section: 0, paragraph: i, offset: i, length: 3 })) };
  assert.deepEqual(wireError(Object.assign(new Error('m'), { code: 'X_Y', details: big })).details, { truncated: true });
  const loop = {}; loop.self = loop;
  assert.deepEqual(wireError(Object.assign(new Error('m'), { details: loop })).details, { truncated: true });
  assert.equal(wireError(Object.assign(new Error('m'), { code: 'bad code' })).code, undefined);
  assert.equal(wireError(new Error('z'.repeat(5000))).error.length, 4096);
  assert.deepEqual(wireError(Object.assign(new Error('m'), { code: 'X_Y', details: { a: 1 } })), { error: 'm', code: 'X_Y', details: { a: 1 } });
  assert.deepEqual(wireError('plain'), { error: 'plain' });
});

test('wp13 R2-2 hwp_exec setCell plain: Normal이 없으면 PLAIN_STYLE_UNAVAILABLE이고 같은 호출의 앞선 편집까지 저장하지 않는다', async t => {
  const bytes = await buildDoc({ body: ['BODY'], table: { rows: 1, cols: 1 }, cells: { '0,0': '안내' }, gray: ['0,0'], renameNormal: true });
  const s = await seedBytes(t, bytes);
  const out = await s.exec(`${OPEN} await hwp.insertText(h,{paragraph:0,offset:0,text:'앞'}); await hwp.setCell(h,{table:0,row:0,col:0,text:'실제',format:'plain'}); await hwp.save(h); return 1;`);
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.code, 'PLAIN_STYLE_UNAVAILABLE');
  assert.ok(out.details.styles.some(x => x.englishName === 'BodyX'));
  assert.deepEqual(out.saved, []);
  assert.equal(out.reconciliation.diskSha256, s.seedSha);
  assert.equal(await s.head(), s.seedHead);
  const disk = await openBytes(t, await s.disk());
  assert.deepEqual(cellParas(disk, 0, 0, 0), ['안내']);
  assert.equal(cellChar(disk, 0, 0, 0).italic, GRAY.italic);
  assert.equal(cellChar(disk, 0, 0, 0).textColor, GRAY.textColor);
  assert.ok(!bodyParas(disk).join('').includes('앞'));
});

async function mixedRepo(t) {
  return seedBytes(t, await buildDoc({ body: ['foo '.repeat(1000)], table: { rows: 1, cols: 2 },
    cells: { '0,0': 'foo '.repeat(1000), '0,1': 'foo '.repeat(300) } }));
}
test('wp13 R3 hwp_exec find: 칸 hit가 많이 섞여도 페이지마다 48KiB 이하, next를 따라 전부·중복 없이', async t => {
  const s = await mixedRepo(t);
  const first = await s.exec(`${OPEN} return await hwp.find(h,{query:'foo',includeCells:true,limit:500});`);
  assert.equal(first.ok, true, JSON.stringify(first).slice(0, 300));
  assert.equal(first.result.total, 2300); assert.equal(first.result.count, 500);
  assert.ok(outBytes(first.result) <= 49152, String(outBytes(first.result)));
  assert.equal(first.result.next.from, 500);
  const walk = await s.exec(`${OPEN} let c={query:'foo',includeCells:true,from:0,limit:500}, n=0, cells=0, body=0, maxLen=0; const seen=new Set(), order=[];
    while (c) { const p=await hwp.find(h,c); maxLen=Math.max(maxLen, JSON.stringify(p).length);
      for (const x of p.positions) { n++; if (x.table!==undefined) cells++; else body++; seen.add(JSON.stringify(x)); order.push(x.table===undefined ? 'b' : 'c'+x.row+x.col); }
      c=p.next; }
    return {n, cells, body, maxLen, uniq: seen.size, c00: order.indexOf('c00'), c01: order.indexOf('c01')};`);
  assert.equal(walk.ok, true, JSON.stringify(walk).slice(0, 300));
  assert.deepEqual({ ...walk.result, maxLen: walk.result.maxLen <= 49152 }, { n: 2300, cells: 1300, body: 1000, maxLen: true, uniq: 2300, c00: 1000, c01: 2000 });
  const tooMany = await s.exec(`${OPEN} return await hwp.find(h,{query:'foo',includeCells:true,limit:1000});`);
  assert.equal(tooMany.code, 'API_ARGS_INVALID');
  const past = await s.exec(`${OPEN} return await hwp.find(h,{query:'foo',includeCells:true,from:5000});`);
  assert.equal(past.result.count, 0); assert.equal(past.result.next, null);
  const legacy = await s.exec(`${OPEN} return await hwp.find(h,{query:'foo',includeCells:true});`);
  assert.match(legacy.error, /result too large/);
});

test('wp13 R3 replaceText 칸 scope mismatch의 커서는 같은 칸 안의 다음 후보를 가리킨다', async t => {
  const s = await mixedRepo(t);
  const out = await s.exec(`${OPEN} await hwp.replaceText(h,{find:'foo',replace:'x',scope:{table:0,row:0,col:0},expectedCount:1});`);
  assert.equal(out.code, 'REPLACE_COUNT_MISMATCH', JSON.stringify(out).slice(0, 300));
  assert.equal(out.details.actualCount, 1000);
  assert.equal(out.details.positions.length, 100);
  assert.ok(out.details.positions.every(p => p.table === 0 && p.row === 0 && p.col === 0));
  assert.deepEqual(out.details.next.args, { query: 'foo', caseSensitive: true, scope: { table: 0, row: 0, col: 0 }, from: 100, limit: 100 });
  const page = await s.exec(`${OPEN} return await hwp.find(h, ${JSON.stringify(out.details.next.args)});`);
  assert.equal(page.result.total, 1000);
  assert.deepEqual(page.result.positions[0], { table: 0, row: 0, col: 0, cellParagraph: 0, offset: 400, length: 3 });
  assert.ok(page.result.positions.every(p => p.table === 0 && p.row === 0 && p.col === 0));
  const one = await s.exec(`${OPEN} return (await hwp.find(h, {...${JSON.stringify(out.details.next.args)}, from:99, limit:1})).positions[0];`);
  assert.deepEqual(one.result, out.details.positions[99]);
  assert.equal(out.reconciliation.diskSha256, s.seedSha);
});

test('wp13 R4 hwp_exec: 큰 query·scope는 짧은 오류로 거절하고, 긴 find의 mismatch는 next를 주지 않는다', async t => {
  const s = await seedBytes(t, await buildDoc({ body: ['foo foo'], table: { rows: 1, cols: 1 }, cells: { '0,0': 'foo' } }));
  const q = await s.exec(`${OPEN} return await hwp.find(h,{query:'foo'.repeat(20000),limit:10});`);
  assert.equal(q.code, 'INVALID_QUERY', JSON.stringify(q).slice(0, 300)); assert.ok(outBytes(q) < 4096, String(outBytes(q)));
  const sc = await s.exec(`${OPEN} return await hwp.find(h,{query:'foo',scope:{table:0,row:0,col:0,pad:'x'.repeat(60000)}});`);
  assert.equal(sc.code, 'INVALID_SCOPE', JSON.stringify(sc).slice(0, 300)); assert.ok(outBytes(sc) < 4096, String(outBytes(sc)));
  const rs = await s.exec(`${OPEN} await hwp.replaceText(h,{find:'foo',replace:'x',scope:{table:0,row:0,col:0,extra:1}}); await hwp.save(h);`);
  assert.equal(rs.code, 'INVALID_SCOPE', JSON.stringify(rs).slice(0, 300));
  assert.equal(rs.reconciliation.diskSha256, s.seedSha);
  const long = await s.exec(`${OPEN} await hwp.replaceText(h,{find:'x'.repeat(1001),replace:'y',expectedCount:1});`);
  assert.equal(long.code, 'REPLACE_COUNT_MISMATCH', JSON.stringify(long).slice(0, 300));
  assert.equal(long.details.next, null);
  assert.equal(long.details.nextUnavailable, 'QUERY_TOO_LONG_FOR_FIND');
});

test('wp13 #27 VM 전역은 hwp 하나: bare paragraphs는 없고 hwp.paragraphs는 함수', async t => {
  const s = await seedBytes(t, await buildDoc({ body: ['x'] }));
  const out = await s.exec('return [typeof paragraphs, typeof selectAll, typeof hwp.paragraphs, typeof hwp.selectAll];');
  assert.deepEqual(out.result, ['undefined', 'undefined', 'function', 'function']);
  const bare = await s.exec(`${OPEN} return await paragraphs(h);`);
  assert.match(bare.error, /paragraphs is not defined/);
});
