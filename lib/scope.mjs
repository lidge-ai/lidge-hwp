import { tableAddresses, resolveCell, nestedCellParagraphs, nestedTables, nestedCellAt, resolveNestedCell, nestedParagraphs } from './cells.mjs';
// 편집기의 "전체 선택"과 같은 범위에 칸 안 표(한 겹)까지 더한다. 머리말·꼬리말·각주는 Studio Ctrl+A도 고르지 않으므로 넣지 않는다.
// 두 겹 이상 중첩 표는 skipped로 알린다.
export const selectAll = () => ({ all: true });
const nat = n => Number.isSafeInteger(n) && n >= 0;
const bad = why => Object.assign(new Error(`SCOPE_UNSUPPORTED: ${why}`), { code: 'SCOPE_UNSUPPORTED' });
function bodyTarget(doc, section, para, start, end) {
  const len = doc.getParagraphLength(section, para);
  const s = start ?? 0, e = end ?? len;
  if (!nat(s) || !nat(e) || s > e || e > len) throw bad(`range ${s}..${e} in paragraph ${para} (length ${len})`);
  return { kind: 'body', section, para, start: s, end: e };
}
function cellTargets(doc, a, cell) {
  const n = doc.getCellParagraphCount(a.section, a.para, a.control, cell), out = [];
  for (let p = 0; p < n; p++) out.push({ kind: 'cell', section: a.section, para: a.para, control: a.control, cell, cellPara: p,
    start: 0, end: doc.getCellParagraphLength(a.section, a.para, a.control, cell, p) });
  return out;
}
export function resolveScope(doc, scope) {
  if (scope === 'all' || scope?.all === true) {
    const targets = [];
    for (let s = 0; s < doc.getSectionCount(); s++)
      for (let p = 0; p < doc.getParagraphCount(s); p++) targets.push(bodyTarget(doc, s, p));
    for (const a of tableAddresses(doc)) for (let c = 0; c < a.cellCount; c++) targets.push(...cellTargets(doc, a, c));
    const nested = nestedCellParagraphs(doc);
    for (const n of nested.cells) targets.push({ kind: 'nested', section: n.section, para: n.para, path: n.path, start: 0, end: n.length });
    return { targets, skipped: nested.skipped };
  }
  if (!scope || typeof scope !== 'object') throw bad('scope must be selectAll(), {paragraph}, {from,to}, {table,row,col} or {table}');
  if (scope.nested !== undefined) {
    // 칸 안 표(한 겹): {nested,row,col}은 그 칸, {nested}는 표 전체. 번호는 hwp.nestedTables()가 준다.
    const cellTargetsOf = c => nestedParagraphs(doc, c).map((p, i) => ({ kind: 'nested', section: c.section, para: c.para,
      path: c.pathFor(i), start: 0, end: p.length }));
    if (scope.row === undefined && scope.col === undefined) {
      const t = nestedTables(doc)[scope.nested];
      if (!Number.isInteger(scope.nested) || !t) throw bad(`nested ${scope.nested}`);
      const targets = [];
      for (let cell = 0; cell < t.cellCount; cell++) targets.push(...cellTargetsOf(nestedCellAt(t, cell)));
      return { targets, skipped: [] };
    }
    return { targets: cellTargetsOf(resolveNestedCell(doc, scope.nested, scope.row, scope.col)), skipped: [] };
  }
  const section = scope.section ?? 0;
  if (!nat(section) || section >= doc.getSectionCount()) throw bad(`section ${section}`);
  if (scope.table !== undefined) {
    const a = tableAddresses(doc)[scope.table];
    if (!a) throw bad(`table ${scope.table}`);
    if (scope.row === undefined && scope.col === undefined) {
      const targets = [];
      for (let c = 0; c < a.cellCount; c++) targets.push(...cellTargets(doc, a, c));
      return { targets, skipped: [] };
    }
    const r = resolveCell(doc, scope.table, scope.row, scope.col);
    return { targets: cellTargets(doc, r, r.cell), skipped: [] };
  }
  const count = doc.getParagraphCount(section);
  if (scope.paragraph !== undefined) {
    if (!nat(scope.paragraph) || scope.paragraph >= count) throw bad(`paragraph ${scope.paragraph}`);
    return { targets: [bodyTarget(doc, section, scope.paragraph, scope.start, scope.end)], skipped: [] };
  }
  if (scope.from !== undefined) {
    const to = scope.to ?? scope.from;
    if (!nat(scope.from) || !nat(to) || scope.from > to || to >= count) throw bad(`paragraphs ${scope.from}..${to}`);
    const targets = [];
    for (let p = scope.from; p <= to; p++) targets.push(bodyTarget(doc, section, p));
    return { targets, skipped: [] };
  }
  throw bad('unknown scope shape');
}
