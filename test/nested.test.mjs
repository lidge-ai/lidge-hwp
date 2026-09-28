// 칸 안 표(한 겹) 편집·체크박스·inline 스냅샷(#nested-cells-pdf).
// fixture test/fixtures/nested-table.hwp: 내장 WASM 빈 HWP에 2x2 표와 3x3 표를 만든 뒤 HWPX에서 3x3 표를 바깥 표 (0,0) 칸 안으로
// 옮겨 HWP로 다시 저장한 공개 문서다. 안쪽 표: [구분|성명|동의여부], [대표|(빈칸)|□ 동의함, □ 동의하지 않음], [회원|이몽룡|□ 동의함, □ 동의하지 않음].
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm, realpath, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ROOT } from '../lib/config.mjs';
import { openDocument, exportWithReport } from '../lib/rhwp-node.mjs';
import { newBatch, applyCall } from '../lib/ops.mjs';
import { nestedTables, nestedCellsView, nestedCellParagraphs } from '../lib/cells.mjs';
import { nestedSetCell, nestedInsertText, nestedReplaceText, checkboxes, setCheckboxHelper } from '../lib/nested.mjs';
import { format } from '../lib/format.mjs';
import { contentSignature } from '../lib/signature.mjs';
import { replayCall } from '../rhwp/rhwp-studio/src/lidge/api-registry.ts';
import { createDocStore } from '../lib/docstore.mjs';
import { createTabs } from '../server/tabs.mjs';
import { imageBlocks } from '../mcp/images.mjs';
const run = promisify(execFile);
const FIXTURE = join(ROOT, 'test/fixtures/nested-table.hwp');
const code = c => e => e.code === c;
const sha = s => createHash('sha256').update(s).digest('hex');
const open = async () => openDocument(await readFile(FIXTURE));
const cellText = (doc, row, col) => nestedCellsView(doc, 0).cells.find(c => c.row === row && c.col === col).text;
// 탭 재생: 같은 원본을 새로 열어 기록된 call op를 탭 코드(replayCall)로 적용하고, 두 문서의 서명·저장 후 서명을 비교한다.
async function assertReplays(doc, batch) {
  assert.ok(batch.ops.length > 0 && batch.ops.every(op => op.kind === 'call'), JSON.stringify(batch.ops.map(o => o.kind)));
  const tab = await open();
  try {
    for (const op of batch.ops) replayCall(tab, op, sha);
    const want = contentSignature(doc);
    assert.equal(want.status, 'ok', JSON.stringify(want));
    assert.equal(contentSignature(tab).digest, want.digest);
    const again = await openDocument(exportWithReport(tab, 'hwp').bytes);
    try { assert.equal(contentSignature(again).digest, want.digest); } finally { again.free(); }
  } finally { tab.free(); }
}

test('nestedTables and cells({nested}) read the table inside a cell', async () => {
  const doc = await open();
  try {
    const [t, ...rest] = nestedTables(doc);
    assert.equal(rest.length, 0);
    assert.deepEqual({ nested: t.nested, rows: t.rows, cols: t.cols, parent: t.parent }, { nested: 0, rows: 3, cols: 3, parent: { table: 0, row: 0, col: 0, paragraph: 0 } });
    const view = nestedCellsView(doc, 0);
    assert.equal(view.cells.length, 9);
    assert.deepEqual(view.cells.slice(0, 3).map(c => c.text), ['구분', '성명', '동의여부']);
    assert.equal(cellText(doc, 1, 2), '□ 동의함, □ 동의하지 않음');
    assert.throws(() => nestedCellsView(doc, 1), code('NESTED_TABLE_ABSENT'));
  } finally { doc.free(); }
});

test('setCell {nested} writes the empty name cell; the tab replays the same ops to the same signature', async () => {
  const doc = await open(), batch = newBatch({});
  try {
    const out = nestedSetCell(doc, batch, { nested: 0, row: 1, col: 1, text: '홍길동' });
    assert.deepEqual(out, { before: '', after: '홍길동' });
    assert.equal(cellText(doc, 1, 1), '홍길동');
    assert.ok(batch.ops.every(op => op.args.method.endsWith('ByPath')));
    await assertReplays(doc, batch);
  } finally { doc.free(); }
});

test('setCell {nested} replaces text, splits lines and formats', async () => {
  const doc = await open(), batch = newBatch({});
  try {
    nestedSetCell(doc, batch, { nested: 0, row: 2, col: 1, text: '성춘향\n이몽룡', splitLines: true, format: { bold: true } });
    const c = nestedCellParagraphs(doc).cells.filter(n => n.path[1].cellIndex === 7);
    assert.equal(c.length, 2);
    assert.deepEqual(c.map(n => doc.getTextInCellByPath(n.section, n.para, JSON.stringify(n.path), 0, n.length)), ['성춘향', '이몽룡']);
    for (const n of c) assert.equal(JSON.parse(doc.getCellCharPropertiesAtByPath(n.section, n.para, JSON.stringify(n.path), 0)).bold, true);
    nestedSetCell(doc, batch, { nested: 0, row: 2, col: 1, text: '한 줄' }); // 문단 둘: 모두 비우고 첫 문단에 넣는다
    assert.equal(cellText(doc, 2, 1), '한 줄');
    await assertReplays(doc, batch);
  } finally { doc.free(); }
});

test('insertTextInCell and replaceText work inside the nested table', async () => {
  const doc = await open(), batch = newBatch({});
  try {
    nestedInsertText(doc, batch, { nested: 0, row: 2, col: 0, text: ' 1' });
    assert.equal(cellText(doc, 2, 0), '회원 1');
    assert.throws(() => nestedReplaceText(doc, batch, { find: '동의함', replace: 'X', scope: { nested: 0 }, expectedCount: 1 }), code('REPLACE_COUNT_MISMATCH'));
    const out = nestedReplaceText(doc, batch, { find: '동의하지 않음', replace: '미동의', scope: { nested: 0, row: 1, col: 2 } });
    assert.equal(out.count, 1);
    assert.deepEqual(out.positions[0], { nested: 0, row: 1, col: 2, paragraph: 0, offset: 9, length: 7 });
    assert.equal(cellText(doc, 1, 2), '□ 동의함, □ 미동의');
    assert.equal(format(doc, batch, { nested: 0, row: 0, col: 0 }, { italic: true }).applied, 1);
    await assertReplays(doc, batch);
  } finally { doc.free(); }
});

test('checkboxes lists nested boxes with labels; setCheckbox by label, mark and exclusive', async () => {
  const doc = await open(), batch = newBatch({});
  try {
    const list = checkboxes(doc);
    assert.equal(list.total, 4);
    assert.deepEqual(list.boxes.map(b => [b.box, b.checked, b.label, b.row, b.col]),
      [[0, false, '동의함', 1, 2], [1, false, '동의하지 않음', 1, 2], [2, false, '동의함', 2, 2], [3, false, '동의하지 않음', 2, 2]]);
    assert.throws(() => setCheckboxHelper(doc, batch, { label: '동의함' }), code('CHECKBOX_AMBIGUOUS'));
    assert.throws(() => setCheckboxHelper(doc, batch, { label: '거부', scope: { nested: 0, row: 1, col: 2 } }), code('CHECKBOX_NOT_FOUND'));
    const first = setCheckboxHelper(doc, batch, { label: '동의함', scope: { nested: 0, row: 1, col: 2 } });
    assert.equal(first.mark, '☑'); // 문서에 쓰던 체크 표시가 없으면 ☑
    assert.equal(cellText(doc, 1, 2), '☑ 동의함, □ 동의하지 않음');
    setCheckboxHelper(doc, batch, { label: '동의하지않음', scope: { nested: 0, row: 2 }, mark: '■' });
    assert.equal(cellText(doc, 2, 2), '□ 동의함, ■ 동의하지 않음');
    const radio = setCheckboxHelper(doc, batch, { label: '동의함', scope: { nested: 0, row: 2, col: 2 }, exclusive: true });
    assert.equal(radio.mark, '■'); // 같은 문단의 표시를 따른다
    assert.equal(cellText(doc, 2, 2), '■ 동의함, □ 동의하지 않음');
    setCheckboxHelper(doc, batch, { box: 0, checked: false });
    assert.equal(cellText(doc, 1, 2), '□ 동의함, □ 동의하지 않음');
    await assertReplays(doc, batch);
  } finally { doc.free(); }
});

test('ByPath text calls outside signed cells are refused', async () => {
  const doc = await open(), batch = newBatch({});
  try {
    const [n] = nestedCellParagraphs(doc).cells;
    const deep = [...n.path, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }];
    assert.throws(() => applyCall(doc, batch, 'insertTextInCellByPath', [n.section, n.para, deep, 0, 'x']), code('API_TARGET_UNSIGNED'));
    assert.throws(() => applyCall(doc, batch, 'deleteTextInCellByPath', [n.section, n.para, [n.path[0], { ...n.path[1], cellIndex: 99 }], 0, 1]), code('API_TARGET_UNSIGNED'));
    assert.equal(batch.ops.length, 0);
  } finally { doc.free(); }
});

async function seed(t) {
  const root = await mkdtemp(join(tmpdir(), 'lidge-hwp-nested-docs-'));
  const exportsRoot = await mkdtemp(join(tmpdir(), 'lidge-hwp-nested-out-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(exportsRoot, { recursive: true, force: true })]));
  await cp(FIXTURE, join(root, 'form.hwp'));
  await run('git', ['-C', root, 'init', '-q']);
  await run('git', ['-C', root, 'add', '--', 'form.hwp']);
  await run('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed']);
  const { runAgent } = await import('../server/agent/runner.mjs');
  const context = { store: createDocStore(root), tabs: createTabs(), config: { exportsRoot } };
  return { root, exportsRoot, context, agent: c => runAgent({ code: c, timeoutMs: 60000 }, context) };
}

test('hwp_exec: nested helpers, legacy occurrence checkbox, inline snapshot and save', async t => {
  const f = await seed(t);
  const out = await f.agent(`const h=await hwp.open('form.hwp');
    const tables=await hwp.nestedTables(h);
    const hits=await hwp.find(h,{query:'이몽룡',includeCells:true});
    await hwp.setCell(h,{nested:0,row:1,col:1,text:'홍길동'});
    await hwp.setCheckbox(h,{label:'동의함',scope:{nested:0,row:1,col:2},exclusive:true});
    await hwp.setCheckbox(h,{occurrence:2});
    const boxes=await hwp.checkboxes(h,{scope:{nested:0}});
    const s=await hwp.snapshot(h,{pages:[0],inline:true});
    await hwp.save(h);
    return {tables, hit:hits[0].nested, cells:(await hwp.cells(h,{nested:0})).cells.map(c=>c.text), boxes:boxes.boxes.map(b=>b.mark), s:{origin:s.origin, inline:s.inline, pages:s.pages}};`);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.result.tables, [{ nested: 0, rows: 3, cols: 3, parent: { table: 0, row: 0, col: 0, paragraph: 0 } }]);
  assert.deepEqual(out.result.hit, { nested: 0, row: 2, col: 1, paragraph: 0 });
  assert.equal(out.result.cells[4], '홍길동');
  assert.equal(out.result.cells[5], '☑ 동의함, □ 동의하지 않음');
  // legacy occurrence는 남은 □만 센다: 0 = 첫 줄 '동의하지 않음', 1·2 = 둘째 줄 두 칸 → 2는 둘째 줄 '동의하지 않음'
  assert.equal(out.result.cells[8], '□ 동의함, ☑ 동의하지 않음');
  assert.deepEqual(out.result.boxes, ['☑', '□', '□', '☑']);
  assert.deepEqual(out.result.s, { origin: 'edited', inline: [0], pages: [{ page: 0, pdf: 'page-001.pdf', png: 'page-001.png' }] });
  assert.equal(out.images.length, 1);
  assert.equal(out.saved.length, 1);
  const saved = await openDocument(await readFile(join(f.root, 'form.hwp')));
  try { assert.equal(nestedCellsView(saved, 0).cells[4].text, '홍길동'); } finally { saved.free(); }
  // MCP 서버가 붙이는 이미지 블록: 내보내기 폴더 안 page PNG만
  const { blocks, skipped } = await imageBlocks(out.images, f.exportsRoot);
  assert.deepEqual(skipped, []);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, 'image'); assert.equal(blocks[1].mimeType, 'image/png');
  assert.ok(Buffer.from(blocks[1].data, 'base64').subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
  assert.match(blocks[0].text, new RegExp(`^page 0 \\(0-based\\): ${(await realpath(f.exportsRoot)).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/`));
});

test('inline limits and exportPdf options', async t => {
  const f = await seed(t);
  const five = await f.agent("const h=await hwp.open('form.hwp'); return await hwp.snapshot(h,{pages:[0],inline:true,png:false});");
  assert.equal(five.ok, false); assert.match(five.error, /inline needs png/);
  const pdf = await f.agent("const h=await hwp.open('form.hwp'); return await hwp.exportPdf(h,{inline:true});");
  assert.equal(pdf.ok, false); assert.match(pdf.error, /inline is a snapshot option/);
  const plain = await f.agent("const h=await hwp.open('form.hwp'); return await hwp.exportPdf(h);");
  assert.equal(plain.ok, true, JSON.stringify(plain)); assert.equal(plain.images, undefined);
  // 리뷰 1: pages 없는 inline은 모든 쪽을 그리므로 거절한다. 한 호출 4쪽을 넘으면 거절한다.
  const all = await f.agent("const h=await hwp.open('form.hwp'); return await hwp.snapshot(h,{inline:true});");
  assert.equal(all.ok, false); assert.match(all.error, /inline needs pages/);
  const many = await f.agent("const h=await hwp.open('form.hwp'); await hwp.snapshot(h,{pages:[0],inline:true}); await hwp.snapshot(h,{pages:[0],inline:true}); await hwp.snapshot(h,{pages:[0],inline:true}); await hwp.snapshot(h,{pages:[0],inline:true}); return await hwp.snapshot(h,{pages:[0],inline:true});");
  assert.equal(many.ok, false); assert.match(many.error, /at most 4 pages/);
  // 리뷰 4: open 실패는 opened:false와 이유로 알린다.
  f.context.config.openBin = '/usr/bin/false';
  const failed = await f.agent("const h=await hwp.open('form.hwp'); return await hwp.exportPdf(h,{open:true});");
  assert.equal(failed.ok, true, JSON.stringify(failed));
  assert.equal(failed.result.opened, false); assert.ok(failed.result.openError);
  f.context.config.openBin = '/usr/bin/true';
  const opened = await f.agent("const h=await hwp.open('form.hwp'); return await hwp.exportPdf(h,{open:true});");
  assert.equal(opened.result.opened, true); assert.equal(opened.result.openError, undefined);
});

test('checkbox edits are preflighted as a whole: no partial edit at the batch limit (review 2, 3)', async () => {
  const { MAX_BATCH_OPS } = await import('../lib/api-registry.mjs');
  const doc = await open();
  try {
    const batch = newBatch({});
    batch.ops.length = MAX_BATCH_OPS - 1; // 한 자리만 남았다: 표시 하나는 delete+insert 두 call이다
    batch.ops.fill({ kind: 'call' });
    const before = cellText(doc, 1, 2);
    assert.throws(() => setCheckboxHelper(doc, batch, { label: '동의함', scope: { nested: 0, row: 1 } }), /BATCH_TOO_LARGE/);
    assert.equal(batch.ops.length, MAX_BATCH_OPS - 1);
    assert.equal(cellText(doc, 1, 2), before);
  } finally { doc.free(); }
});

test('imageBlocks refuses files outside the exports root and non-page names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lidge-hwp-img-'));
  const other = await mkdtemp(join(tmpdir(), 'lidge-hwp-img-other-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  await mkdir(join(root, 'a'), { recursive: true });
  await writeFile(join(root, 'a', 'page-001.png'), png); await writeFile(join(root, 'a', 'secret.png'), png); await writeFile(join(other, 'page-001.png'), png);
  const { blocks, skipped } = await imageBlocks([{ page: 0, path: join(root, 'a', 'page-001.png') }, { page: 1, path: join(root, 'a', 'secret.png') },
    { page: 2, path: join(other, 'page-001.png') }], root);
  assert.equal(blocks.length, 2);
  assert.deepEqual(skipped.map(s => s.why), ['not a page png', 'outside exports root']);
});
