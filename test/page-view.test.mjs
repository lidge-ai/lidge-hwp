import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, RHWP_BIN } from '../lib/config.mjs';
import { openDocument, exportWithReport } from '../lib/rhwp-node.mjs';
import { cliPageCountOf } from '../lib/render.mjs';
import { createPageView } from '../lib/page-view.mjs';
import { createHandleTracker, createFailingCli } from './helpers/handle-tracker.mjs';

const sample = () => readFile(join(ROOT, 'rhwp/samples/hwp3-sample16-hwp5.hwp'));
function setup(bytes, tracker, cli = cliPageCountOf, exporter = exportWithReport) {
  let gen = 0, base;
  const pages = createPageView({ source: { bytes }, getGen: () => gen, getDoc: () => base,
    format: 'hwp', exporter, openDocument: tracker.open, cliPageCount: cli,
    rhwpBin: RHWP_BIN, deadline: Date.now() + 60000 });
  return { pages, setBase: doc => { base = doc; }, edit: para => { base.insertParagraph(0, para); gen++; } };
}

test('P1 CLI failure frees the candidate and preserves the old page view', async () => {
  const bytes = await sample(), tracker = createHandleTracker(openDocument);
  const cli = createFailingCli(cliPageCountOf, [2]), ctx = setup(bytes, tracker, cli);
  const base = await tracker.open(bytes); ctx.setBase(base);
  try {
    ctx.edit(4); await ctx.pages.current();
    const old = ctx.pages.inspect();
    ctx.edit(10);
    await assert.rejects(ctx.pages.current(), /RENDER_FAILED/);
    assert.deepEqual(tracker.events.slice(-2).map(e => e.op), ['open', 'free']);
    assert.deepEqual(ctx.pages.inspect(), old);
    assert.equal(tracker.live.has(old.ownedId), true);
    await ctx.pages.current();
    assert.equal(ctx.pages.inspect().cliPageCount, 65);
    assert.deepEqual(tracker.events.slice(-2).map(e => e.op), ['open', 'free']);
  } finally { ctx.pages.close(); base.free(); }
  assert.deepEqual(tracker.stats(), { opens: 4, frees: 4, live: [], errors: [] });
});

test('P2 generation zero CLI failure owns no extra document', async () => {
  const bytes = await sample(), tracker = createHandleTracker(openDocument);
  const ctx = setup(bytes, tracker, createFailingCli(cliPageCountOf, [1]));
  const base = await tracker.open(bytes); ctx.setBase(base);
  try {
    await assert.rejects(ctx.pages.current(), /RENDER_FAILED/);
    assert.equal(ctx.pages.inspect(), null);
    assert.equal(tracker.stats().opens, 1);
    await ctx.pages.current();
    assert.equal(ctx.pages.inspect().ownedId, null);
    ctx.pages.close(); assert.deepEqual(tracker.stats().live, [1]);
  } finally { ctx.pages.close(); base.free(); }
  assert.deepEqual(tracker.stats().errors, []);
});

test('P3 export loss and reopen failure retain the previous generation', async () => {
  const bytes = await sample(), tracker = createHandleTracker(openDocument);
  let loss = false, failOpen = false;
  const open = async data => { if (failOpen) throw new Error('OPEN_FAILED'); return tracker.open(data); };
  let gen = 0;
  const base = await tracker.open(bytes);
  const pv = createPageView({ source: { bytes }, getGen: () => gen, getDoc: () => base,
    format: 'hwp', exporter: (doc, format) => loss ? { bytes: null, report: { count: 1 } } : exportWithReport(doc, format),
    openDocument: open, cliPageCount: cliPageCountOf, rhwpBin: RHWP_BIN, deadline: Date.now() + 60000 });
  try {
    base.insertParagraph(0, 4); gen++; await pv.current();
    const old = pv.inspect();
    base.insertParagraph(0, 10); gen++; loss = true;
    await assert.rejects(pv.current(), /RENDER_CONTENT_LOSS/);
    assert.deepEqual(pv.inspect(), old);
    loss = false; failOpen = true;
    await assert.rejects(pv.current(), /OPEN_FAILED/);
    assert.deepEqual(pv.inspect(), old);
  } finally { pv.close(); base.free(); }
  assert.deepEqual(tracker.stats(), { opens: 2, frees: 2, live: [], errors: [] });
});

test('P4 three generations free each replaced view once', async () => {
  const bytes = await sample(), tracker = createHandleTracker(openDocument), ctx = setup(bytes, tracker);
  const base = await tracker.open(bytes); ctx.setBase(base);
  try {
    for (const para of [4, 10, 16]) { ctx.edit(para); await ctx.pages.current(); }
  } finally { ctx.pages.close(); base.free(); }
  assert.deepEqual(tracker.events.map(e => `${e.op}${e.id}`),
    ['open1', 'open2', 'open3', 'free2', 'open4', 'free3', 'free4', 'free1']);
  assert.deepEqual(tracker.stats().errors, []);
});
