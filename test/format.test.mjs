import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ROOT } from '../lib/config.mjs';
import { openDocument, exportWithReport } from '../lib/rhwp-node.mjs';
import { newBatch } from '../lib/ops.mjs';
import { tableAddresses, nestedCellParagraphs, resolveCell } from '../lib/cells.mjs';
import { resolveScope, selectAll } from '../lib/scope.mjs';
import { format, paraFormat, getFormat, styles, applyStyle } from '../lib/format.mjs';
import { contentSignature } from '../lib/signature.mjs';

const code = c => e => e.code === c;
test('saved synthetic zero vpos no longer forces a page (#22)', async () => {
  const bytes = await readFile(join(ROOT, 'test/fixtures/issue22-synthetic-zero.hwp'));
  const doc = await openDocument(bytes);
  try { assert.equal(doc.pageCount(), 1); } finally { doc.free(); }
  const { stdout } = await promisify(execFile)(join(ROOT, 'bin/darwin-arm64/rhwp'),
    ['dump-pages', join(ROOT, 'test/fixtures/issue22-synthetic-zero.hwp'), '--json']);
  assert.equal(JSON.parse(stdout).pageCount, 1);
});
test('T22-e size after an empty paragraph stays on one page after deleting the empty and saving', async () => {
  const doc = await openDocument(await readFile(join(ROOT, 'rhwp/saved/blank2010.hwp')));
  try {
    doc.insertText(0, 0, 0, 'Title');
    doc.applyCharFormat(0, 0, 0, 5, JSON.stringify({ fontSize: 2000 }));
    for (const [index, text] of ['A', 'B', '', 'C', 'D'].entries()) {
      doc.insertParagraph(0, index + 1);
      if (text) doc.insertText(0, index + 1, 0, text);
    }
    for (const para of [2, 4]) doc.applyCharFormat(0, para, 0, 1,
      JSON.stringify({ fontSize: 1300, bold: true, textColor: '#224488' }));
    assert.equal(doc.pageCount(), 1);
    doc.deleteParagraph(0, 3);
    assert.equal(doc.pageCount(), 1);
    assert.deepEqual(JSON.parse(doc.getStoredFlowGaps(0)), []);
    const bytes = exportWithReport(doc, 'hwp').bytes;
    const again = await openDocument(bytes);
    try { assert.equal(again.pageCount(), 1); } finally { again.free(); }
  } finally { doc.free(); }
});
async function fixtureDoc(t) {
  const fixture = process.env.LIDGE_HWP_SIG_FIXTURE;
  if (!fixture) { t.skip('set LIDGE_HWP_SIG_FIXTURE'); return null; }
  const doc = await openDocument(await readFile(fixture));
  t.after(() => doc.free());
  return doc;
}
const firstText = doc => { for (let p = 0; p < doc.getParagraphCount(0); p++) if (doc.getParagraphLength(0, p) > 1) return p; throw new Error('no text'); };
const sigAfterRoundtrip = async doc => {
  const again = await openDocument(exportWithReport(doc, 'hwp').bytes);
  try { return contentSignature(again).digest; } finally { again.free(); }
};

test('resolveScope(all): 본문 + 최상위 칸 + 중첩 칸(한 겹)', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const { targets, skipped } = resolveScope(doc, selectAll());
  let body = 0; for (let s = 0; s < doc.getSectionCount(); s++) body += doc.getParagraphCount(s);
  let cells = 0; for (const a of tableAddresses(doc)) for (let c = 0; c < a.cellCount; c++) cells += doc.getCellParagraphCount(a.section, a.para, a.control, c);
  const nested = nestedCellParagraphs(doc).cells.length;
  assert.equal(targets.length, body + cells + nested);
  assert.ok(nested > 0 && targets.some(x => x.kind === 'nested'));
  assert.deepEqual(skipped, []);
  const addrs = tableAddresses(doc);
  for (const x of targets.filter(x => x.kind === 'cell')) assert.ok(addrs.some(a => a.section === x.section && a.para === x.para && a.control === x.control));
});
test('resolveScope: 두 겹 중첩은 skipped, 틀린 범위는 SCOPE_UNSUPPORTED', async t => {
  const fake = { getSectionCount: () => 1, getParagraphCount: () => 1, getParagraphLength: () => 2,
    getControls: () => '[]', lidgeAuxContent: () => JSON.stringify({ schemaVersion: 1, items: [{ kind: 'tbl', section: 0, path: [0, 0, 0, 0, 0, 0, 0, 0, 0] }] }) };
  assert.match(resolveScope(fake, selectAll()).skipped.join(), /deeper than one level/);
  assert.throws(() => resolveScope(fake, { paragraph: 9999 }), code('SCOPE_UNSUPPORTED'));
  assert.throws(() => resolveScope(fake, { paragraph: 0, start: 1, end: 5 }), code('SCOPE_UNSUPPORTED'));
  assert.throws(() => resolveScope(fake, 'nope'), code('SCOPE_UNSUPPORTED'));
});
test('format(selectAll, italic): 본문·칸·중첩 칸이 모두 기울고, 저장 왕복에도 서명이 같다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const batch = newBatch({});
  const r = format(doc, batch, selectAll(), { italic: true });
  assert.ok(r.applied > 0 && batch.ops.every(o => o.kind === 'call'));
  assert.ok(batch.ops.some(o => o.args.method === 'applyCharFormatInCellByPath'));
  for (let p = 0; p < doc.getParagraphCount(0); p++)
    if (doc.getParagraphLength(0, p) > 0) assert.equal(JSON.parse(doc.getCharPropertiesAt(0, p, 0)).italic, true, `body ${p}`);
  const [a] = tableAddresses(doc);
  for (let c = 0; c < a.cellCount; c++) for (let cp = 0; cp < doc.getCellParagraphCount(a.section, a.para, a.control, c); cp++)
    if (doc.getCellParagraphLength(a.section, a.para, a.control, c, cp) > 0)
      assert.equal(JSON.parse(doc.getCellCharPropertiesAt(a.section, a.para, a.control, c, cp, 0)).italic, true, `cell ${c}/${cp}`);
  for (const n of nestedCellParagraphs(doc).cells.filter(n => n.length > 0))
    assert.equal(JSON.parse(doc.getCellCharPropertiesAtByPath(n.section, n.para, JSON.stringify(n.path), 0)).italic, true);
  assert.equal(await sigAfterRoundtrip(doc), contentSignature(doc).digest);
});
test('format: 모르는 키·틀린 값·문자열 size는 API_ARGS_INVALID, fontName은 글꼴 표 op를 먼저 남긴다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const p = firstText(doc);
  assert.throws(() => format(doc, newBatch({}), { paragraph: p }, { foo: 1 }), code('API_ARGS_INVALID'));
  assert.throws(() => format(doc, newBatch({}), { paragraph: p }, { italic: 'yes' }), code('API_ARGS_INVALID'));
  assert.throws(() => format(doc, newBatch({}), { paragraph: p }, { size: '12' }), code('API_ARGS_INVALID'));
  assert.throws(() => format(doc, newBatch({}), { paragraph: 9999 }, { italic: true }), code('SCOPE_UNSUPPORTED'));
  const b = newBatch({});
  format(doc, b, { paragraph: p }, { fontName: '맑은 고딕', size: 12 });
  assert.equal(b.ops[0].args.method, 'findOrCreateFontId');
  const props = JSON.parse(doc.getCharPropertiesAt(0, p, 0));
  assert.equal(props.fontSize, 1200); assert.equal(props.fontFamily, '맑은 고딕');
});
test('paraFormat: 정렬이 바뀌고, 전체 선택에서는 중첩 칸 문단을 skipped로 알린다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const p = firstText(doc);
  paraFormat(doc, newBatch({}), { paragraph: p }, { alignment: 'center' });
  assert.equal(JSON.parse(doc.getParaPropertiesAt(0, p)).alignment, 'center');
  const all = paraFormat(doc, newBatch({}), selectAll(), { alignment: 'right' });
  assert.match(all.skipped.join(), /nested cell paragraphs/);
  assert.throws(() => paraFormat(doc, newBatch({}), { paragraph: p }, { alignment: 'middle' }), code('API_ARGS_INVALID'));
});
test('getFormat·styles: 원 API와 같은 값을 돌려준다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const p = firstText(doc);
  format(doc, newBatch({}), { paragraph: p }, { italic: true });
  assert.equal(getFormat(doc, { paragraph: p }).char.italic, true);
  const c = resolveCell(doc, 0, 0, 0);
  assert.deepEqual(getFormat(doc, { table: 0, row: 0, col: 0 }).char, JSON.parse(doc.getCellCharPropertiesAt(c.section, c.para, c.control, c.cell, 0, 0)));
  assert.deepEqual(styles(doc), JSON.parse(doc.getStyleList()));
});
test('applyStyle: 이름·id로 본문과 칸에 적용되고, 모르는 이름은 거절, 저장 왕복 서명 동일', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const p = firstText(doc), list = styles(doc), cur = JSON.parse(doc.getStyleAt(0, p)).id;
  const byName = list.find(s => s.id !== cur && s.type === 0 && s.name), byId = list.find(s => s.id !== cur && s.id !== byName.id && s.type === 0);
  applyStyle(doc, newBatch({}), { paragraph: p }, byName.name);
  assert.equal(JSON.parse(doc.getStyleAt(0, p)).id, byName.id);
  applyStyle(doc, newBatch({}), { paragraph: p }, byId.id);
  assert.equal(JSON.parse(doc.getStyleAt(0, p)).id, byId.id);
  const c = resolveCell(doc, 0, 0, 0);
  applyStyle(doc, newBatch({}), { table: 0, row: 0, col: 0 }, byName.id);
  assert.equal(JSON.parse(doc.getCellStyleAt(c.section, c.para, c.control, c.cell, 0)).id, byName.id);
  assert.throws(() => applyStyle(doc, newBatch({}), { paragraph: p }, '없는스타일'), code('API_ARGS_INVALID'));
  assert.equal(await sigAfterRoundtrip(doc), contentSignature(doc).digest);
});

// ── wp13 (#26 #30, 010 Revision 2). 공개 fixture, 새 함수는 동적 import ──
import { buildDoc, openBytes, cellParas, cellChar, cellPara, bodyParas, GRAY } from './helpers/wp13-docs.mjs';
const wp13Text = () => import('../lib/text-helpers.mjs');
const DIST = ['spacingBefore', 'spacingAfter', 'indent', 'marginLeft', 'marginRight'];
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

test('wp13 #26 paraFormat unit:pt 왕복: spacing 1x, indent/margin 2x HWPUNIT, getFormat unit:pt (본문·칸)', async t => {
  const doc = await openBytes(t, await buildDoc({ body: ['ABCD'], table: { rows: 1, cols: 1 }, cells: { '0,0': '칸' } }));
  const pt = { unit: 'pt', spacingBefore: 9, spacingAfter: 2, indent: 10, marginLeft: 10, marginRight: 10 };
  const b = newBatch({});
  paraFormat(doc, b, { paragraph: 0 }, pt);
  assert.deepEqual(JSON.parse(b.ops[0].args.args[2]), { spacingBefore: 900, spacingAfter: 200, indent: 2000, marginLeft: 2000, marginRight: 2000 });
  assert.deepEqual(pick(getFormat(doc, { paragraph: 0, unit: 'pt' }).para, DIST), { spacingBefore: 9, spacingAfter: 2, indent: 10, marginLeft: 10, marginRight: 10 });
  assert.deepEqual(pick(getFormat(doc, { paragraph: 0 }).para, DIST), { spacingBefore: 12, spacingAfter: 2.7, indent: 13.3, marginLeft: 13.3, marginRight: 13.3 });
  paraFormat(doc, newBatch({}), { table: 0, row: 0, col: 0 }, pt);
  assert.deepEqual(pick(getFormat(doc, { table: 0, row: 0, col: 0, unit: 'pt' }).para, DIST), { spacingBefore: 9, spacingAfter: 2, indent: 10, marginLeft: 10, marginRight: 10 });
  const neg = newBatch({});
  paraFormat(doc, neg, { paragraph: 0 }, { unit: 'pt', indent: -5 });
  assert.deepEqual(JSON.parse(neg.ops[0].args.args[2]), { indent: -1000 });
  assert.throws(() => paraFormat(doc, newBatch({}), { paragraph: 0 }, { unit: 'px', indent: 1 }), code('API_ARGS_INVALID'));
  assert.throws(() => paraFormat(doc, newBatch({}), { paragraph: 0 }, { unit: 'pt', marginLeft: -1 }), code('API_ARGS_INVALID'));
  const raw = newBatch({}); paraFormat(doc, raw, { paragraph: 0 }, { spacingBefore: 300 }); // 생략 시 기존 raw 그대로
  assert.deepEqual(JSON.parse(raw.ops[0].args.args[2]), { spacingBefore: 300 });
});

async function formatCells(t, opts = {}) {
  return openBytes(t, await buildDoc({ body: ['본문'], table: { rows: 1, cols: 4 },
    cells: { '0,0': '안내', '0,1': '안내', '0,2': '안내', '0,3': '안내' }, gray: ['0,0', '0,1', '0,2', '0,3'], ...opts }));
}
test('wp13 #30 setCell format: 기본·inherit는 안내 서식 상속, plain은 Normal 글자 모양, 객체는 지정값, 잘못된 값은 편집 전 거절', async t => {
  const doc = await formatCells(t);
  const { setCellHelper } = await wp13Text();
  const paraBefore = cellPara(doc, 0, 0, 2);
  const b = newBatch({});
  setCellHelper(doc, b, { table: 0, row: 0, col: 0, text: '기본' });
  setCellHelper(doc, b, { table: 0, row: 0, col: 1, text: '상속', format: 'inherit' });
  setCellHelper(doc, b, { table: 0, row: 0, col: 2, text: '보통', format: 'plain' });
  setCellHelper(doc, b, { table: 0, row: 0, col: 3, text: '지정', format: { italic: false, textColor: '#123456' } });
  const check = d => {
    for (const col of [0, 1]) assert.deepEqual(pick(cellChar(d, 0, 0, col), ['textColor', 'italic']), GRAY, `col ${col}`);
    assert.deepEqual(pick(cellChar(d, 0, 0, 2), ['textColor', 'italic', 'bold', 'fontFamily', 'fontSize']),
      { textColor: '#000000', italic: false, bold: false, fontFamily: '함초롬바탕', fontSize: 1000 });
    assert.deepEqual(pick(cellChar(d, 0, 0, 3), ['textColor', 'italic']), { textColor: '#123456', italic: false });
  };
  check(doc);
  assert.deepEqual(cellParas(doc, 0, 0, 2), ['보통']);
  assert.deepEqual(cellPara(doc, 0, 0, 2), paraBefore);
  assert.ok(b.ops.every(o => o.kind === 'setCell' || o.kind === 'call'));
  assert.ok(b.ops.filter(o => o.kind === 'setCell').every(o => !('format' in o.args) && !('splitLines' in o.args)));
  const again = await openDocument(exportWithReport(doc, 'hwp').bytes);
  try { check(again); } finally { again.free(); }
  for (const bad of [{ italic: 'no' }, { foo: 1 }, 'bogus', { fontName: '맑은 고딕', italic: 'x' }]) {
    const bb = newBatch({});
    assert.throws(() => setCellHelper(doc, bb, { table: 0, row: 0, col: 3, text: '새', format: bad }), code('API_ARGS_INVALID'), JSON.stringify(bad));
    assert.equal(bb.ops.length, 0);
    assert.deepEqual(cellParas(doc, 0, 0, 3), ['지정']);
  }
});

test('wp13 #30 setCell plain: Normal(바탕글)이 없으면 PLAIN_STYLE_UNAVAILABLE, id 0 대체 없음, 칸·batch 불변', async t => {
  const doc = await formatCells(t, { renameNormal: true });
  const { setCellHelper } = await wp13Text();
  assert.ok(styles(doc).some(s => s.id === 0 && s.englishName === 'BodyX'));
  assert.ok(!styles(doc).some(s => s.englishName === 'Normal' || s.name === '바탕글'));
  const b = newBatch({}), sig = contentSignature(doc).digest, charBefore = cellChar(doc, 0, 0, 0);
  assert.throws(() => setCellHelper(doc, b, { table: 0, row: 0, col: 0, text: '실제', format: 'plain' }), e => {
    assert.equal(e.code, 'PLAIN_STYLE_UNAVAILABLE');
    assert.ok(e.details.styles.some(s => s.englishName === 'BodyX'));
    return true;
  });
  assert.equal(b.ops.length, 0);
  assert.deepEqual(cellParas(doc, 0, 0, 0), ['안내']);
  assert.deepEqual(cellChar(doc, 0, 0, 0), charBefore);
  assert.equal(contentSignature(doc).digest, sig);
  assert.deepEqual(bodyParas(doc)[0], '본문');
});
