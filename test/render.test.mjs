import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, readdir, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join, basename } from 'node:path';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { createDocStore } from '../lib/docstore.mjs';
import { createLibrary } from '../lib/library.mjs';
import { createRootsRegistry } from '../lib/roots.mjs';
import { createTabs } from '../server/tabs.mjs';
import { checkSnapshotOptions, stampName, pageFile } from '../lib/render.mjs';
import { ROOT } from '../lib/config.mjs';
import { RHWP_BIN } from '../lib/config.mjs';
import { openDocument } from '../lib/rhwp-node.mjs';
import { cliPageCountOf } from '../lib/render.mjs';
import { createHandleTracker, createFailingCli } from './helpers/handle-tracker.mjs';
import { makeRhwpStub } from './helpers/rhwp-stub.mjs';
const run = promisify(execFile);
const SAMPLES = join(ROOT, 'rhwp', 'samples');
const PDF = Buffer.from('%PDF-'), PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const startsWith = async (file, magic) => (await readFile(file)).subarray(0, magic.length).equals(magic);
const EMPTY = join('hwpx', 'ref', 'ref_empty.hwpx');

test('snapshot options: defaults, limits and unknown keys', () => {
  assert.deepEqual(checkSnapshotOptions(undefined, 'darwin'), { pages: undefined, png: true, pdf: true, maxPx: 1600 });
  assert.equal(checkSnapshotOptions({}, 'linux').png, false);
  assert.throws(() => checkSnapshotOptions({ png: true }, 'linux'), /PNG_UNSUPPORTED/);
  for (const bad of [{ pages: [] }, { pages: [1, 1] }, { pages: [-1] }, { pages: '0' }, { maxPx: 10 }, { png: false, pdf: false }, { page: 0 }])
    assert.throws(() => checkSnapshotOptions(bad, 'darwin'), /RENDER_ARGS_INVALID/, JSON.stringify(bad));
  assert.throws(() => checkSnapshotOptions({ pages: Array.from({ length: 201 }, (_, i) => i) }, 'darwin'), /RENDER_ARGS_INVALID/);
  assert.match(stampName('ab'.repeat(32), new Date(2026, 8, 27, 13, 5, 9)), /^20260927-130509-abababab$/);
  assert.equal(pageFile(0, 'png'), 'page-001.png');
});

test('save then reopen the same id and snapshot in one call (#4)', async t => {
  const { root, agent } = await seed(t, { 'empty.hwpx': EMPTY });
  const before = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const out = await agent("const h=await hwp.open('empty.hwpx'); await hwp.insertText(h,{paragraph:0,text:'저장 후 스냅샷'}); await hwp.save(h); const again=await hwp.open('empty.hwpx'); const s=await hwp.snapshot(again,{png:false}); return {same:h===again, origin:s.origin, pages:s.pages.length};");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.result, { same: true, origin: 'edited', pages: 1 });
  assert.equal(out.saved.length, 1);
  const after = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  assert.notEqual(after, before);
  assert.equal(out.saved[0].commit, after);
  await clean(root);
});

async function seed(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'lidge-hwp-render-docs-'));
  const exportsRoot = await mkdtemp(join(tmpdir(), 'lidge-hwp-render-out-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(exportsRoot, { recursive: true, force: true })]));
  for (const [id, src] of Object.entries(files)) await cp(join(SAMPLES, src), join(root, id));
  await run('git', ['-C', root, 'init', '-q']);
  await run('git', ['-C', root, 'add', '--', ...Object.keys(files)]);
  await run('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed']);
  const { runAgent } = await import('../server/agent/runner.mjs');
  const context = { store: createDocStore(root), tabs: createTabs(), config: { exportsRoot } };
  const agent = code => runAgent({ code, timeoutMs: 60000 }, context);
  return { root, exportsRoot, agent, context };
}
const clean = async root => assert.equal((await run('git', ['-C', root, 'status', '--porcelain'])).stdout, '');

async function externalRender(t) {
  const f = await seed(t, { 'empty.hwpx': EMPTY });
  const extra = await mkdtemp(join(tmpdir(), 'lidge-render-extra-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'lidge-render-state-'));
  t.after(() => Promise.all([rm(extra, { recursive: true, force: true }), rm(stateDir, { recursive: true, force: true })]));
  await cp(join(SAMPLES, EMPTY), join(extra, 'empty.hwpx'));
  const registry = await createRootsRegistry({ docsRoot: f.root, stateDir });
  const { key } = await registry.register(extra);
  f.context.store = await createLibrary({ docsRoot: f.root, stateDir });
  return { ...f, extra, stateDir, key, id: `ext://${key}/empty.hwpx` };
}

test('external snapshots use isolated export path', async t => {
  const f = await externalRender(t);
  const out = await f.agent(`const h=await hwp.open(${JSON.stringify(f.id)}); return await hwp.snapshot(h,{png:false,pages:[0]});`);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result.docId, f.id);
  assert.ok(out.result.dir.startsWith(join(await realpath(f.exportsRoot), 'external', f.key, 'empty.hwpx') + '/'));
  assert.deepEqual(out.result.pages, [{ page: 0, pdf: 'page-001.pdf' }]);
  assert.ok(await startsWith(join(out.result.dir, 'page-001.pdf'), PDF));
  assert.equal((await readdir(f.extra)).includes('.git'), false);
});

test('exports inside any registered root are refused', async t => {
  const f = await externalRender(t);
  f.context.config.exportsRoot = join(f.extra, 'exports');
  const out = await f.agent(`const h=await hwp.open(${JSON.stringify(f.id)}); return await hwp.exportPdf(h);`);
  assert.equal(out.ok, false);
  assert.match(out.error, /EXPORTS_INSIDE_DOCS/);
  await assert.rejects(access(join(f.extra, 'exports')));
  assert.equal((await readdir(f.extra)).includes('.git'), false);
});

test('hwp.snapshot writes per-page PDF and PNG outside the library', async t => {
  const { root, exportsRoot, agent } = await seed(t, { 'long.hwp': 'hwp3-sample16-hwp5.hwp' });
  const out = await agent("const h=await hwp.open('long.hwp'); return await hwp.snapshot(h,{pages:[1,0],maxPx:800});");
  assert.equal(out.ok, true, JSON.stringify(out));
  const r = out.result;
  assert.equal(r.docId, 'long.hwp'); assert.equal(r.origin, 'disk'); assert.equal(r.pageCount, 64);
  assert.ok(r.dir.startsWith(join(await realpath(exportsRoot), 'long.hwp') + '/'), r.dir);
  assert.deepEqual(r.pages.map(p => p.page), [1, 0]);
  assert.deepEqual((await readdir(r.dir)).sort(), ['page-001.pdf', 'page-001.png', 'page-002.pdf', 'page-002.png']);
  for (const p of r.pages) {
    assert.ok(await startsWith(join(r.dir, p.pdf), PDF), p.pdf);
    assert.ok(await startsWith(join(r.dir, p.png), PNG), p.png);
  }
  const { stdout } = await run('sips', ['-g', 'pixelHeight', join(r.dir, 'page-001.png')]);
  assert.match(stdout, /pixelHeight: 800/);
  assert.deepEqual(out.saved, []);
  await clean(root);
});

test('hwp.snapshot without pages renders every page; exportPdf writes one document PDF', async t => {
  const { root, agent } = await seed(t, { 'empty.hwpx': EMPTY });
  const out = await agent("const h=await hwp.open('empty.hwpx'); return {s: await hwp.snapshot(h,{png:false}), p: await hwp.exportPdf(h)};");
  assert.equal(out.ok, true, JSON.stringify(out));
  const { s, p } = out.result;
  assert.equal(s.pageCount, 1); assert.deepEqual(s.pages, [{ page: 0, pdf: 'page-001.pdf' }]);
  assert.deepEqual(await readdir(s.dir), ['page-001.pdf']);
  assert.equal(basename(p.path), 'document.pdf'); assert.equal(p.pageCount, 1);
  assert.ok(await startsWith(p.path, PDF)); assert.ok(p.bytes > 0);
  assert.notEqual(p.dir, s.dir, 'each render gets its own directory');
  await clean(root);
});

test('snapshot renders unsaved edits from the same call and writes nothing to the library', async t => {
  const { root, agent } = await seed(t, { 'empty.hwpx': EMPTY });
  const before = await readFile(join(root, 'empty.hwpx'));
  const out = await agent("const h=await hwp.open('empty.hwpx'); await hwp.insertText(h,{paragraph:0,text:'스냅샷'}); return await hwp.snapshot(h,{png:false});");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result.origin, 'edited');
  assert.notEqual(out.result.sourceSha256, (await run('shasum', ['-a', '256', join(root, 'empty.hwpx')])).stdout.slice(0, 64));
  assert.ok(Buffer.compare(before, await readFile(join(root, 'empty.hwpx'))) === 0);
  await clean(root);
});

test('T23-a edited HWP page reads follow snapshot bytes and CLI count', async t => {
  const f = await seed(t, { 'long.hwp': 'hwp3-sample16-hwp5.hwp' });
  const out = await f.agent("const h=await hwp.open('long.hwp'); await hwp.api(h,'insertParagraph',0,4); await hwp.api(h,'insertParagraph',0,10); const count=await hwp.api(h,'pageCount'); const info=await hwp.info(h); const apiInfo=await hwp.api(h,'getDocumentInfo'); const last=await hwp.api(h,'getPageText',64); const snap=await hwp.snapshot(h,{png:false,pages:[64]}); return {count,info:info.pageCount,apiInfo:apiInfo.pageCount,last,snap:snap.pageCount};");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([out.result.count, out.result.info, out.result.apiInfo, out.result.snap], [65, 65, 65, 65]);
  assert.ok(out.result.last.length > 0);
  await clean(f.root);
});

test('T23-b edited HWPX page reads follow snapshot', async t => {
  const f = await seed(t, { 'empty.hwpx': EMPTY });
  const out = await f.agent("const h=await hwp.open('empty.hwpx'); await hwp.api(h,'insertParagraph',0,0); return {count:await hwp.api(h,'pageCount'),info:(await hwp.info(h)).pageCount,snap:(await hwp.snapshot(h,{png:false,pages:[0]})).pageCount};");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.result, { count: 2, info: 2, snap: 2 });
  await clean(f.root);
});

test('T23-c one CLI resolver feeds page count and snapshot; text divergence is explicit', async t => {
  const f = await seed(t, { 'long.hwp': 'hwp3-sample16-hwp5.hwp' });
  const stub = await makeRhwpStub(f.exportsRoot, RHWP_BIN);
  f.context.config.rhwpBin = stub.path;
  const code = "const h=await hwp.open('long.hwp'); await hwp.api(h,'insertParagraph',0,4); await hwp.api(h,'insertParagraph',0,10); return {count:await hwp.api(h,'pageCount'),info:(await hwp.info(h)).pageCount,snapshot:(await hwp.snapshot(h,{png:false,pages:[0]})).pageCount};";
  const out = await f.agent(code);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.result, { count: 66, info: 66, snapshot: 66 });
  const lines = (await readFile(stub.logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(new Set(lines.map(row => row.cmd)), new Set(['dump-pages', 'export-pdf']));
  assert.equal(new Set(lines.map(row => row.inputSha256)).size, 1);
  const divergent = await f.agent("const h=await hwp.open('long.hwp'); await hwp.api(h,'insertParagraph',0,4); await hwp.api(h,'insertParagraph',0,10); return await hwp.api(h,'getPageText',0);");
  assert.equal(divergent.ok, false);
  assert.match(divergent.error, /^PAGE_LAYOUT_DIVERGED/);
  await clean(f.root);
});

test('T23-h snapshot reports a dump-pages versus render manifest mismatch', async t => {
  const f = await seed(t, { 'long.hwp': 'hwp3-sample16-hwp5.hwp' });
  f.context.config.rhwpBin = (await makeRhwpStub(f.exportsRoot, RHWP_BIN, { exportExtra: 0 })).path;
  const out = await f.agent("const h=await hwp.open('long.hwp'); await hwp.api(h,'insertParagraph',0,4); await hwp.api(h,'insertParagraph',0,10); return await hwp.snapshot(h,{png:false,pages:[0]});");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.result.pageCountMismatch, { api: 66, snapshot: 65 });
  await clean(f.root);
});

test('E1 failed page read aborts hwp_exec, frees every handle and a later call succeeds', async t => {
  const f = await seed(t, { 'long.hwp': 'hwp3-sample16-hwp5.hwp' });
  const tracker = createHandleTracker(openDocument), cli = createFailingCli(cliPageCountOf, [2]);
  f.context.config.openDocument = tracker.open; f.context.config.cliPageCount = cli;
  const before = await readFile(join(f.root, 'long.hwp'));
  const first = await f.agent("const h=await hwp.open('long.hwp'); await hwp.api(h,'insertParagraph',0,4); await hwp.api(h,'pageCount'); await hwp.api(h,'insertParagraph',0,10); try { await hwp.api(h,'pageCount'); } catch {} await hwp.save(h); return 'x';");
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.match(first.error, /^RENDER_FAILED/);
  assert.deepEqual(await readFile(join(f.root, 'long.hwp')), before);
  assert.deepEqual(tracker.stats().live, []);
  assert.equal(tracker.stats().opens, tracker.stats().frees);
  const second = await f.agent("const h=await hwp.open('long.hwp'); await hwp.api(h,'insertParagraph',0,4); await hwp.api(h,'insertParagraph',0,10); return await hwp.api(h,'pageCount');");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.result, 65);
  assert.deepEqual(tracker.stats().live, []);
  assert.equal(tracker.stats().opens, tracker.stats().frees);
  await clean(f.root);
});

test('E2 unedited page read failure releases the source handle', async t => {
  const f = await seed(t, { 'long.hwp': 'hwp3-sample16-hwp5.hwp' });
  const tracker = createHandleTracker(openDocument);
  f.context.config.openDocument = tracker.open;
  f.context.config.cliPageCount = createFailingCli(cliPageCountOf, [1]);
  const first = await f.agent("const h=await hwp.open('long.hwp'); return await hwp.api(h,'pageCount');");
  assert.equal(first.ok, false);
  assert.match(first.error, /^RENDER_FAILED/);
  assert.deepEqual(tracker.stats(), { opens: 1, frees: 1, live: [], errors: [] });
  f.context.config.cliPageCount = cliPageCountOf;
  const second = await f.agent("const h=await hwp.open('long.hwp'); return await hwp.api(h,'pageCount');");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.result, 64);
  assert.deepEqual(tracker.stats(), { opens: 2, frees: 2, live: [], errors: [] });
  await clean(f.root);
});

test('out-of-range pages fail and leave no output directory', async t => {
  const { exportsRoot, agent } = await seed(t, { 'empty.hwpx': EMPTY });
  for (const pages of [[5], [0, 3]]) {
    const out = await agent(`const h=await hwp.open('empty.hwpx'); return await hwp.snapshot(h,{pages:${JSON.stringify(pages)},png:false});`);
    assert.equal(out.ok, false); assert.match(out.error, /PAGE_OUT_OF_RANGE/);
  }
  assert.deepEqual(await readdir(join(exportsRoot, 'empty.hwpx')), []);
});

test('exports inside the document library are refused', async t => {
  const { root, agent, context } = await seed(t, { 'empty.hwpx': EMPTY });
  context.config.exportsRoot = join(root, 'exports');
  const out = await agent("const h=await hwp.open('empty.hwpx'); return await hwp.exportPdf(h);");
  assert.equal(out.ok, false); assert.match(out.error, /EXPORTS_INSIDE_DOCS/);
  await assert.rejects(access(join(root, 'exports')));
  await clean(root);
});
