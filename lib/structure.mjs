import { applyCall, readApi } from './ops.mjs';
import { tableAddresses, resolveCell } from './cells.mjs';
const bad = why => Object.assign(new Error(`API_ARGS_INVALID: ${why}`), { code: 'API_ARGS_INVALID' });
const nat = n => Number.isSafeInteger(n) && n >= 0;
const sec = a => a?.section ?? 0;
function table(doc, index) {
  const a = tableAddresses(doc)[index];
  if (!a) throw bad(`table ${index}`);
  return a;
}
export const insertParagraph = (doc, b, a) => applyCall(doc, b, 'insertParagraph', [sec(a), a?.paragraph]);
export const deleteParagraph = (doc, b, a) => applyCall(doc, b, 'deleteParagraph', [sec(a), a?.paragraph]);
export const splitParagraph = (doc, b, a) => applyCall(doc, b, 'splitParagraph', [sec(a), a?.paragraph, a?.offset]);
// rhwp mergeParagraph(s,p)는 p를 앞 문단(p-1)에 붙인다(001 §2).
export const mergeParagraph = (doc, b, a) => applyCall(doc, b, 'mergeParagraph', [sec(a), a?.paragraph]);
export function deleteText(doc, b, a) {
  if (a?.table !== undefined) {
    const c = resolveCell(doc, a.table, a.row, a.col);
    return applyCall(doc, b, 'deleteTextInCell', [c.section, c.para, c.control, c.cell, a.paragraph ?? 0, a.offset, a.count]);
  }
  return applyCall(doc, b, 'deleteText', [sec(a), a?.paragraph, a?.offset, a?.count]);
}
export function deleteRange(doc, b, a) {
  if (!a?.from || !a?.to) throw bad('deleteRange needs {from:{paragraph,offset}, to:{paragraph,offset}}');
  return applyCall(doc, b, 'deleteRange', [sec(a), a.from.paragraph, a.from.offset, a.to.paragraph, a.to.offset]);
}
export function replaceAll(doc, b, a) {
  if (typeof a?.find !== 'string' || !a.find) throw bad('find');
  return applyCall(doc, b, 'replaceAll', [a.find, a.replace ?? '', a.caseSensitive ?? true]);
}
export function createTable(doc, b, a) {
  if (!nat(a?.rows) || !nat(a?.cols) || a.rows < 1 || a.cols < 1 || a.rows > 200 || a.cols > 50) throw bad('rows 1..200, cols 1..50');
  const before = tableAddresses(doc).length;
  const r = applyCall(doc, b, 'createTable', [sec(a), a.paragraph, a.offset ?? 0, a.rows, a.cols]);
  const after = tableAddresses(doc);
  const index = after.findIndex(t => t.section === sec(a) && t.para === r.paraIdx && t.control === r.controlIdx);
  // 새 표는 본문에만 생기므로 항상 최상위 목록에 있다. 없으면 불변식이 깨진 것이라 저장 전에 멈춘다.
  if (index < 0) throw Object.assign(new Error('TABLE_INDEX_UNRESOLVED'), { code: 'TABLE_INDEX_UNRESOLVED' });
  return { ...r, table: index, tableCount: after.length, added: after.length - before };
}
const rowCol = (fn, key, flag) => (doc, b, a) => {
  const t = table(doc, a?.table);
  const args = [t.section, t.para, t.control, a?.[key]];
  if (flag) args.push(a?.[flag] ?? true);
  return applyCall(doc, b, fn, args);
};
export const insertRow = rowCol('insertTableRow', 'row', 'below');
export const insertColumn = rowCol('insertTableColumn', 'col', 'right');
export const deleteRow = rowCol('deleteTableRow', 'row');
export const deleteColumn = rowCol('deleteTableColumn', 'col');
export function mergeCells(doc, b, a) {
  const t = table(doc, a?.table), [r1, c1] = a?.from ?? [], [r2, c2] = a?.to ?? [];
  return applyCall(doc, b, 'mergeTableCells', [t.section, t.para, t.control, r1, c1, r2, c2]);
}
export function splitCell(doc, b, a) {
  const t = table(doc, a?.table);
  return applyCall(doc, b, 'splitTableCell', [t.section, t.para, t.control, a?.row, a?.col]);
}
export const STRUCTURE = { insertParagraph, deleteParagraph, splitParagraph, mergeParagraph, deleteText, deleteRange,
  replaceAll, createTable, insertRow, insertColumn, deleteRow, deleteColumn, mergeCells, splitCell };
