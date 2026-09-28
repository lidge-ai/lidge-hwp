export function tableAddresses(doc) {
  const starts = []; let total = 0;
  for (let s = 0; s < doc.getSectionCount(); s++) {
    starts.push(total); total += doc.getParagraphCount(s);
  }
  return JSON.parse(doc.getControls()).filter(c => c.list === 0 && c.ctrlId === 'tbl')
    .map(c => {
      const section = starts.findLastIndex(n => n <= c.para);
      if (section < 0 || c.para >= total) throw new Error('invalid root paragraph');
      const para = c.para - starts[section], control = c.controlIndex;
      const size = JSON.parse(doc.getTableDimensions(section, para, control));
      return { section, para, control, ...size };
    });
}
export function resolveCell(doc, table, row, col) {
  if (![table, row, col].every(n => Number.isInteger(n) && n >= 0)) throw new Error('invalid grid address');
  const address = tableAddresses(doc)[table];
  if (!address) throw new Error(`top-level table ${table} absent`);
  if (row >= address.rowCount || col >= address.colCount) throw new Error('cell out of bounds');
  let anchor;
  for (let cell = 0; cell < address.cellCount; cell++) {
    const info = JSON.parse(doc.getCellInfo(address.section, address.para, address.control, cell));
    if (info.row === row && info.col === col) return { ...address, cell, ...info };
    if (info.row <= row && row < info.row + info.rowSpan && info.col <= col && col < info.col + info.colSpan)
      anchor = info;
  }
  if (anchor) throw new Error(`covered merged cell; use (${anchor.row},${anchor.col})`);
  throw new Error('cell absent');
}
export function cellText(doc, a) {
  const parts = [];
  const count = doc.getCellParagraphCount(a.section, a.para, a.control, a.cell);
  for (let p = 0; p < count; p++) {
    const len = doc.getCellParagraphLength(a.section, a.para, a.control, a.cell, p);
    parts.push(doc.getTextInCell(a.section, a.para, a.control, a.cell, p, 0, len));
  }
  return parts.join('\n').trim();
}
export function cellsInTable(doc, table) {
  const a = tableAddresses(doc)[table]; if (!a) throw new Error('top-level table absent');
  const cells = [];
  for (let i = 0; i < a.cellCount; i++) {
    const info = JSON.parse(doc.getCellInfo(a.section, a.para, a.control, i));
    cells.push({ ...info, text: cellText(doc, { ...a, cell: i }) });
  }
  return { table, rows: a.rowCount, cols: a.colCount, cells };
}

// 칸 안 표(한 겹)의 칸 문단 목록. 포크 lidgeAuxContent의 tbl 항목 path = [문단, 컨트롤, 칸, 칸 문단, 컨트롤]
// (rhwp/src/lidge_wasm.rs:144-167, 실측 wp1-human.hwp [19,0,0,25,0])에서 rhwp ByPath 경로를 만든다
// (경로 형식 rhwp/src/document_core/queries/cursor_nav.rs:600-601). 두 겹 이상(path 길이 9 이상)은 skipped.
export function nestedCellParagraphs(doc) {
  const cells = [], skipped = [];
  if (typeof doc.lidgeAuxContent !== 'function') return { cells, skipped: ['lidgeAuxContent missing'] };
  for (const it of JSON.parse(doc.lidgeAuxContent()).items ?? []) {
    if (it.kind !== 'tbl') continue;
    if (it.path.length !== 5) { skipped.push(`table at ${it.section}/${it.path.join('/')}: nested deeper than one level`); continue; }
    const [para, control, cell, cellPara, inner] = it.path;
    const outer = { controlIndex: control, cellIndex: cell, cellParaIndex: cellPara };
    for (let k = 0; k <= 4096; k++) {
      const first = [outer, { controlIndex: inner, cellIndex: k, cellParaIndex: 0 }];
      let count;
      try { count = doc.getCellParagraphCountByPath(it.section, para, JSON.stringify(first)); } catch { break; } // 마지막 칸 다음은 던진다
      if (!(count > 0)) break;
      for (let p = 0; p < count; p++) {
        const path = [outer, { controlIndex: inner, cellIndex: k, cellParaIndex: p }];
        cells.push({ section: it.section, para, path, length: doc.getCellParagraphLengthByPath(it.section, para, JSON.stringify(path)) });
      }
    }
  }
  return { cells, skipped };
}

// 칸 안 표(한 겹) 목록. 번호 nested는 lidgeAuxContent 순서(문서 순서)이고 nestedCellParagraphs와 같은 표를 같은 순서로 센다.
// parent는 바깥 표가 최상위 표일 때 그 표 번호와 칸 위치다(글상자 안 표처럼 최상위가 아니면 null).
// 안쪽 표 경로 = [바깥 칸, {controlIndex: 안쪽 표, cellIndex, cellParaIndex}] (rhwp resolve_table_by_path, cursor_nav.rs:644).
export function nestedTables(doc) {
  const out = [];
  if (typeof doc.lidgeAuxContent !== 'function') return out;
  let tops = null;
  for (const it of JSON.parse(doc.lidgeAuxContent()).items ?? []) {
    if (it.kind !== 'tbl' || it.path.length !== 5) continue;
    const [para, control, cell, cellPara, inner] = it.path;
    const outer = { controlIndex: control, cellIndex: cell, cellParaIndex: cellPara };
    const probe = JSON.stringify([outer, { controlIndex: inner, cellIndex: 0, cellParaIndex: 0 }]);
    const dims = JSON.parse(doc.getTableDimensionsByPath(it.section, para, probe));
    tops ??= tableAddresses(doc);
    const table = tops.findIndex(t => t.section === it.section && t.para === para && t.control === control);
    let parent = null;
    if (table >= 0) {
      const info = JSON.parse(doc.getCellInfo(it.section, para, control, cell));
      parent = { table, row: info.row, col: info.col, paragraph: cellPara };
    }
    out.push({ nested: out.length, section: it.section, para, outer, inner,
      rows: dims.rowCount, cols: dims.colCount, cellCount: dims.cellCount, parent });
  }
  return out;
}
const nestedAbsent = (nested, count) => Object.assign(new Error(`NESTED_TABLE_ABSENT: nested table ${nested} absent (document has ${count}; list them with hwp.nestedTables(h))`),
  { code: 'NESTED_TABLE_ABSENT' });
// 중첩 표 칸 하나. pathFor(p)는 그 칸 p번째 문단의 ByPath 경로(배열)다.
export function nestedCellAt(t, cell) {
  return { ...t, cell, pathFor: p => [t.outer, { controlIndex: t.inner, cellIndex: cell, cellParaIndex: p }] };
}
export function resolveNestedCell(doc, nested, row, col) {
  if (![nested, row, col].every(n => Number.isInteger(n) && n >= 0)) throw new Error('invalid nested cell address {nested,row,col}');
  const all = nestedTables(doc), t = all[nested];
  if (!t) throw nestedAbsent(nested, all.length);
  if (row >= t.rows || col >= t.cols) throw new Error(`nested cell out of bounds (${t.rows}x${t.cols})`);
  let anchor;
  for (let cell = 0; cell < t.cellCount; cell++) {
    const c = nestedCellAt(t, cell);
    const info = JSON.parse(doc.getCellInfoByPath(t.section, t.para, JSON.stringify(c.pathFor(0))));
    if (info.row === row && info.col === col) return { ...c, ...info };
    if (info.row <= row && row < info.row + info.rowSpan && info.col <= col && col < info.col + info.colSpan) anchor = info;
  }
  if (anchor) throw new Error(`covered merged cell; use (${anchor.row},${anchor.col})`);
  throw new Error('nested cell absent');
}
// 중첩 칸의 문단 수·길이·글(문단 배열).
export function nestedParagraphs(doc, c) {
  const n = doc.getCellParagraphCountByPath(c.section, c.para, JSON.stringify(c.pathFor(0))), out = [];
  for (let p = 0; p < n; p++) {
    const path = JSON.stringify(c.pathFor(p)), length = doc.getCellParagraphLengthByPath(c.section, c.para, path);
    out.push({ length, text: doc.getTextInCellByPath(c.section, c.para, path, 0, length) });
  }
  return out;
}
export const nestedCellText = (doc, c) => nestedParagraphs(doc, c).map(p => p.text).join('\n').trim();
export function nestedCellsView(doc, nested) {
  const all = nestedTables(doc), t = all[nested];
  if (!Number.isInteger(nested) || !t) throw nestedAbsent(nested, all.length);
  const cells = [];
  for (let cell = 0; cell < t.cellCount; cell++) {
    const c = nestedCellAt(t, cell);
    const info = JSON.parse(doc.getCellInfoByPath(t.section, t.para, JSON.stringify(c.pathFor(0))));
    cells.push({ ...info, text: nestedCellText(doc, c) });
  }
  return { nested, rows: t.rows, cols: t.cols, parent: t.parent, cells };
}
