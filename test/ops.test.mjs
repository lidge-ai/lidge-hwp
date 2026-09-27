import test from 'node:test'; import assert from 'node:assert/strict';
import { applyOp, newBatch, readView, sha, validateBatch } from '../lib/ops.mjs';
function bodyDoc(paras) {
  const calls = [];
  return { calls, getSectionCount: () => 1, getParagraphCount: () => paras.length,
    getParagraphLength: (_, p) => Array.from(paras[p]).length,
    getTextRange: (_, p, o, n) => Array.from(paras[p]).slice(o, o + n).join(''),
    insertText: (s, p, o, t) => { calls.push([s, p, o, t]); const a = Array.from(paras[p]); a.splice(o, 0, ...Array.from(t)); paras[p] = a.join(''); return JSON.stringify({ ok: true }); } };
}
test('insertText appends to a body paragraph by default and records the full paragraph preimage', () => {
  const doc = bodyDoc(['◦ ', '- 기존']), batch = newBatch({ diskSha256: 'x' });
  const out = applyOp(doc, batch, 'insertText', { paragraph: 1, text: ' 추가' });
  assert.deepEqual(doc.calls, [[0, 1, 4, ' 추가']]);
  assert.deepEqual(out, { before: '- 기존', after: '- 기존 추가' });
  assert.deepEqual(batch.ops[0].resolved, { section: 0, para: 1, control: null, cell: null, offset: 4, length: 0 });
  assert.deepEqual(batch.ops[0].args, { section: 0, paragraph: 1, offset: 4, text: ' 추가' });
  assert.equal(batch.ops[0].beforeSha256, sha('- 기존'));
  assert.equal(validateBatch(batch), batch);
  applyOp(doc, batch, 'insertText', { paragraph: 0, offset: 0, text: 'A' });
  assert.equal(doc.calls[1][2], 0);
});
test('insertText rejects out-of-range coordinates, empty or multi-line text', () => {
  const doc = bodyDoc(['abc']), batch = newBatch({ diskSha256: 'x' });
  assert.throws(() => applyOp(doc, batch, 'insertText', { paragraph: 1, text: 'x' }), /paragraph out of bounds/);
  assert.throws(() => applyOp(doc, batch, 'insertText', { paragraph: 0, offset: 4, text: 'x' }), /offset out of bounds/);
  assert.throws(() => applyOp(doc, batch, 'insertText', { paragraph: 0, text: '' }), /empty text/);
  assert.throws(() => applyOp(doc, batch, 'insertText', { paragraph: 0, text: 'a\nb' }), /invalid text/);
  assert.equal(doc.calls.length, 0);
  assert.equal(batch.ops.length, 0);
});
test('paragraphs lists body paragraphs with coordinates', () => {
  const doc = bodyDoc(['가', '', '다']);
  assert.deepEqual(readView(doc, 'paragraphs', { from: 1, count: 5 }),
    { total: 3, paragraphs: [{ section: 0, paragraph: 1, text: '' }, { section: 0, paragraph: 2, text: '다' }] });
});
test('setCell clears each paragraph before insert', () => {
  const calls = [], doc = {
    getSectionCount: () => 1, getParagraphCount: () => 1,
    getControls: () => JSON.stringify([{ list: 0, para: 0, ctrlId: 'tbl', controlIndex: 0 }]),
    getTableDimensions: () => JSON.stringify({ rowCount: 1, colCount: 1, cellCount: 1 }),
    getCellInfo: () => JSON.stringify({ row: 0, col: 0, rowSpan: 1, colSpan: 1 }),
    getCellParagraphCount: () => 2, getCellParagraphLength: (_, __, ___, ____, p) => p ? 1 : 2,
    getTextInCell: (_, __, ___, ____, p) => p ? 'B' : 'AA',
    deleteTextInCell: (...args) => calls.push(['del', ...args]),
    insertTextInCell: (...args) => calls.push(['ins', ...args]),
  };
  const batch = newBatch({ diskSha256: 'x' });
  applyOp(doc, batch, 'setCell', { table: 0, row: 0, col: 0, text: 'X' });
  assert.deepEqual(calls.map(c => c[0]), ['del','del','ins']);
  assert.equal(batch.ops[0].beforeSha256, sha('AA\nB'));
  assert.equal(validateBatch(batch), batch);
  assert.throws(() => applyOp(doc, batch, 'setCell', { table: 0, row: 0, col: 0, text: 'a\nb' }), /invalid text/);
});
test('setCheckbox records the parentPara it edited (cell hit) and null for a body hit', () => {
  const calls = [];
  const cellHit = { sec: 0, para: 4, charOffset: 3, length: 1, cellContext: { parentPara: 4, ctrlIdx: 0, cellIdx: 2, cellPara: 1 } };
  const bodyHit = { sec: 0, para: 7, charOffset: 0, length: 1 };
  const doc = {
    searchAllText: () => JSON.stringify([cellHit, bodyHit]),
    deleteTextInCell: (...args) => calls.push(['del', ...args]),
    insertTextInCell: (...args) => calls.push(['ins', ...args]),
    replaceText: (...args) => calls.push(['rep', ...args]),
  };
  const batch = newBatch({ diskSha256: 'x' });
  applyOp(doc, batch, 'setCheckbox', { occurrence: 0 });
  assert.deepEqual(calls.map(c => [c[0], c[2]]), [['del', 4], ['ins', 4]]);
  assert.equal(batch.ops[0].resolved.parentPara, 4);
  assert.deepEqual(batch.ops[0].resolved, { section: 0, para: 4, parentPara: 4, control: 0, cell: 2, cellPara: 1, offset: 3, length: 1 });
  applyOp(doc, batch, 'setCheckbox', { occurrence: 1 });
  assert.equal(calls.at(-1)[0], 'rep');
  assert.equal(batch.ops[1].resolved.parentPara, null);
  assert.equal(validateBatch(batch), batch);
});
