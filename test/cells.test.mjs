import test from 'node:test'; import assert from 'node:assert/strict';
import { resolveCell, cellText } from '../lib/cells.mjs';
test('anchor and covered merged cell', () => {
  const doc = {
    getSectionCount: () => 1, getParagraphCount: () => 1,
    getControls: () => JSON.stringify([{ list: 0, para: 0, ctrlId: 'tbl', controlIndex: 0 }]),
    getTableDimensions: () => JSON.stringify({ rowCount: 2, colCount: 2, cellCount: 1 }),
    getCellInfo: () => JSON.stringify({ row: 0, col: 0, rowSpan: 2, colSpan: 2 }),
    getCellParagraphCount: () => 1, getCellParagraphLength: () => 1, getTextInCell: () => 'A',
  };
  assert.equal(cellText(doc, resolveCell(doc, 0, 0, 0)), 'A');
  assert.throws(() => resolveCell(doc, 0, 1, 1), /covered merged cell/);
});
