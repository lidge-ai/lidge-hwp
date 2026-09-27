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
