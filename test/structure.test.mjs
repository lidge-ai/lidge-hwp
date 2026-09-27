import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openDocument, exportWithReport } from '../lib/rhwp-node.mjs';
import { newBatch, readView } from '../lib/ops.mjs';
import { tableAddresses, resolveCell } from '../lib/cells.mjs';
import { STRUCTURE } from '../lib/structure.mjs';
import { contentSignature, verifyAgentBytes } from '../lib/signature.mjs';

const { insertParagraph, deleteParagraph, splitParagraph, mergeParagraph, deleteText, replaceAll, createTable,
  insertRow, deleteRow, insertColumn, deleteColumn, mergeCells, splitCell } = STRUCTURE;
const code = c => e => e.code === c;
async function fixtureDoc(t) {
  const fixture = process.env.LIDGE_HWP_SIG_FIXTURE;
  if (!fixture) { t.skip('set LIDGE_HWP_SIG_FIXTURE'); return null; }
  const doc = await openDocument(await readFile(fixture));
  t.after(() => doc.free());
  return doc;
}
// 저장→다시 열기 뒤 문서로 확인한다(저장된 내용이 의도대로인지).
async function saved(t, doc) {
  const again = await openDocument(exportWithReport(doc, 'hwp').bytes);
  t.after(() => again.free());
  return again;
}
const text = (doc, p) => doc.getTextRange(0, p, 0, doc.getParagraphLength(0, p));
const firstText = doc => { for (let p = 0; p < doc.getParagraphCount(0); p++) if (doc.getParagraphLength(0, p) > 3 && !tableAddresses(doc).some(a => a.para === p)) return p; throw new Error('no text'); };
const dims = (doc, i) => { const a = tableAddresses(doc)[i]; return [a.rowCount, a.colCount]; };

test('splitParagraph·mergeParagraph: 나뉘고 다시 합쳐지며, 저장 뒤에도 그렇다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const p = firstText(doc), whole = text(doc, p), n = doc.getParagraphCount(0), b = newBatch({});
  splitParagraph(doc, b, { paragraph: p, offset: 2 });
  assert.equal(doc.getParagraphCount(0), n + 1);
  assert.equal(text(doc, p), whole.slice(0, 2)); assert.equal(text(doc, p + 1), whole.slice(2));
  const s1 = await saved(t, doc);
  assert.equal(s1.getParagraphCount(0), n + 1); assert.equal(text(s1, p + 1), whole.slice(2));
  mergeParagraph(doc, b, { paragraph: p + 1 });
  assert.equal(text(doc, p), whole);
  assert.equal(text(await saved(t, doc), p), whole);
  assert.deepEqual(b.ops.map(o => [o.kind, o.args.method]), [['call', 'splitParagraph'], ['call', 'mergeParagraph']]);
});
test('insertRow·deleteRow·insertColumn·deleteColumn: 표 크기가 바뀌고 저장 뒤에도 같다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const [r0, c0] = dims(doc, 0), b = newBatch({});
  insertRow(doc, b, { table: 0, row: 0 });
  assert.deepEqual(dims(doc, 0), [r0 + 1, c0]);
  assert.deepEqual(dims(await saved(t, doc), 0), [r0 + 1, c0]);
  deleteRow(doc, b, { table: 0, row: 1 });
  assert.deepEqual(dims(doc, 0), [r0, c0]);
  insertColumn(doc, b, { table: 0, col: 0 });
  assert.deepEqual(dims(await saved(t, doc), 0), [r0, c0 + 1]);
  deleteColumn(doc, b, { table: 0, col: 1 });
  assert.deepEqual(dims(await saved(t, doc), 0), [r0, c0]);
});
test('createTable: 새 표 2×3, 저장 모양 기준 서명은 통과하고 메모리 기준은 AGENT_VERIFY_MISMATCH(3-1)', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const p = firstText(doc), before = tableAddresses(doc).length;
  const r = createTable(doc, newBatch({}), { paragraph: p, rows: 2, cols: 3 });
  assert.equal(r.added, 1); assert.ok(r.table >= 0);
  assert.deepEqual(dims(doc, r.table), [2, 3]);
  const bytes = exportWithReport(doc, 'hwp').bytes;
  const again = await openDocument(bytes); t.after(() => again.free());
  const t2 = tableAddresses(again).find(a => a.para === r.paraIdx && a.control === r.controlIdx);
  assert.ok(t2, 'new table survives save'); assert.equal(tableAddresses(again).length, before + 1);
  assert.deepEqual([t2.rowCount, t2.colCount], [2, 3]);
  assert.equal(await verifyAgentBytes(bytes, 'hwp', { exportSha256: '0'.repeat(64), signature: contentSignature(again) }), 'content');
  await assert.rejects(verifyAgentBytes(bytes, 'hwp', { exportSha256: '0'.repeat(64), signature: contentSignature(doc) }), code('AGENT_VERIFY_MISMATCH'));
});
test('deleteText: 본문과 칸에서 글자가 지워지고 저장 뒤에도 그렇다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const p = firstText(doc), whole = text(doc, p), b = newBatch({});
  deleteText(doc, b, { paragraph: p, offset: 0, count: 1 });
  assert.equal(text(doc, p), whole.slice(1));
  let cell = null;
  for (const [ti, a] of tableAddresses(doc).entries()) for (let c = 0; c < a.cellCount && !cell; c++) {
    const info = JSON.parse(doc.getCellInfo(a.section, a.para, a.control, c));
    if (doc.getCellParagraphLength(a.section, a.para, a.control, c, 0) > 1) cell = { table: ti, row: info.row, col: info.col, a, c };
    if (cell) break;
  }
  const len = doc.getCellParagraphLength(cell.a.section, cell.a.para, cell.a.control, cell.c, 0);
  deleteText(doc, b, { table: cell.table, row: cell.row, col: cell.col, offset: 0, count: 1 });
  assert.equal(doc.getCellParagraphLength(cell.a.section, cell.a.para, cell.a.control, cell.c, 0), len - 1);
  assert.equal(b.ops[1].args.method, 'deleteTextInCell');
  const s = await saved(t, doc);
  assert.equal(text(s, p), whole.slice(1));
  const c2 = resolveCell(s, cell.table, cell.row, cell.col);
  assert.equal(s.getCellParagraphLength(c2.section, c2.para, c2.control, c2.cell, 0), len - 1);
});
test('replaceAll: 칸 안까지 바뀌고 저장 뒤 남은 게 없다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const before = JSON.parse(doc.searchAllText('고려대학교', true, true)).length;
  assert.ok(before > 0);
  const r = replaceAll(doc, newBatch({}), { find: '고려대학교', replace: '고려대' });
  assert.ok(r.count >= 1);
  assert.equal(JSON.parse(doc.searchAllText('고려대학교', true, true)).length, 0);
  assert.equal(JSON.parse((await saved(t, doc)).searchAllText('고려대학교', true, true)).length, 0);
});
test('mergeCells·splitCell·insertParagraph·deleteParagraph: 동작하고 서명이 바뀐다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const base = contentSignature(doc).digest, b = newBatch({}), n = doc.getParagraphCount(0), p = firstText(doc);
  insertParagraph(doc, b, { paragraph: p });
  assert.equal(doc.getParagraphCount(0), n + 1);
  assert.notEqual(contentSignature(doc).digest, base);
  deleteParagraph(doc, b, { paragraph: p });
  assert.equal(doc.getParagraphCount(0), n);
  const idx = tableAddresses(doc).findIndex(a => a.rowCount >= 2 && a.colCount >= 2);
  const a = tableAddresses(doc)[idx];
  const cellsBefore = a.cellCount;
  insertRow(doc, b, { table: idx, row: a.rowCount - 1 }); // 병합해도 되는 빈 행을 만든다
  const last = tableAddresses(doc)[idx].rowCount - 1;
  mergeCells(doc, b, { table: idx, from: [last, 0], to: [last, 1] });
  const merged = tableAddresses(doc)[idx].cellCount;
  assert.equal(merged, cellsBefore + a.colCount - 1);
  splitCell(doc, b, { table: idx, row: last, col: 0 });
  assert.equal(tableAddresses(doc)[idx].cellCount, cellsBefore + a.colCount);
  assert.equal(tableAddresses(await saved(t, doc))[idx].cellCount, cellsBefore + a.colCount);
});
test('잘못된 인자: 없는 표·음수 문단·rows 0은 API_ARGS_INVALID', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  assert.throws(() => insertRow(doc, newBatch({}), { table: 99, row: 0 }), code('API_ARGS_INVALID'));
  assert.throws(() => splitParagraph(doc, newBatch({}), { paragraph: -1, offset: 0 }), code('API_ARGS_INVALID'));
  assert.throws(() => createTable(doc, newBatch({}), { paragraph: 0, rows: 0, cols: 2 }), code('API_ARGS_INVALID'));
});
test('createTable 불변식: 새 표를 목록에서 못 찾으면 TABLE_INDEX_UNRESOLVED', () => {
  // REGISTRY 인자 검사를 통과하고, createTable이 목록에 없는 좌표를 돌려주는 가짜 문서
  const doc = { getSectionCount: () => 1, getParagraphCount: () => 1, getControls: () => '[]',
    createTable: () => '{"ok":true,"paraIdx":99,"controlIdx":0}' };
  assert.throws(() => createTable(doc, newBatch({}), { paragraph: 0, rows: 2, cols: 2 }), code('TABLE_INDEX_UNRESOLVED'));
});
test('k-skill info·list-paragraphs 대응: hwp.info와 hwp.paragraphs가 문서 정보·문단 목록을 준다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const info = readView(doc, 'info');
  assert.ok(info && typeof info === 'object' && Object.keys(info).length > 0);
  assert.deepEqual(info, JSON.parse(doc.getDocumentInfo()));
  const list = readView(doc, 'paragraphs', { from: 0, count: 5 });
  assert.equal(list.total, doc.getParagraphCount(0));
  assert.equal(list.paragraphs.length, Math.min(5, list.total));
  assert.equal(list.paragraphs[0].text, doc.getTextRange(0, 0, 0, doc.getParagraphLength(0, 0)));
});
