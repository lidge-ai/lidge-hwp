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
