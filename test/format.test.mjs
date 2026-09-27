import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openDocument, exportWithReport } from '../lib/rhwp-node.mjs';
import { newBatch } from '../lib/ops.mjs';
import { tableAddresses, nestedCellParagraphs, resolveCell } from '../lib/cells.mjs';
import { resolveScope, selectAll } from '../lib/scope.mjs';
import { format, paraFormat, getFormat, styles, applyStyle } from '../lib/format.mjs';
import { contentSignature } from '../lib/signature.mjs';

const code = c => e => e.code === c;
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
