// SheetJS 통합문서 ↔ FortuneSheet 시트 목록 변환. 브라우저 번들과 Node 테스트가 같이 쓴다(순수 함수).
import * as XLSX from 'xlsx';

export const MIN_ROWS = 100;
export const MIN_COLS = 26;
const BOOK_TYPES = { xlsx: 'xlsx', xls: 'biff8', ods: 'ods', csv: 'csv', numbers: 'numbers' };

// CSV는 바이트를 글자로 먼저 푼다(UTF-8 기본, BOM이 있으면 그 인코딩). SheetJS에 바이트를 그대로 주면 한글이 깨진다.
function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  return new TextDecoder('utf-8').decode(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b);
}
export function readWorkbook(bytes, format = null) {
  const options = { cellFormula: true, cellStyles: true, cellNF: true, cellDates: false };
  if (format === 'csv') return XLSX.read(decodeText(bytes), { ...options, type: 'string' });
  return XLSX.read(bytes, { ...options, type: 'array' });
}

function fortuneType(cell) {
  if (cell.t === 'n') return 'n';
  if (cell.t === 'b') return 'b';
  if (cell.t === 'd') return 'd';
  return 'g';
}

// 통합문서 → FortuneSheet 시트 배열([{name, id, order, celldata, config, row, column}]).
export function workbookToSheets(workbook) {
  return workbook.SheetNames.map((name, order) => {
    const sheet = workbook.Sheets[name];
    const celldata = [];
    const config = {};
    let rows = 0, cols = 0;
    if (sheet['!ref']) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      rows = range.e.r + 1; cols = range.e.c + 1;
      for (let r = range.s.r; r <= range.e.r; r += 1) {
        for (let c = range.s.c; c <= range.e.c; c += 1) {
          const cell = sheet[XLSX.utils.encode_cell({ r, c })];
          if (!cell || (cell.v === undefined && !cell.f)) continue;
          const v = { v: cell.v, m: cell.w ?? (cell.v === undefined ? '' : String(cell.v)), ct: { fa: cell.z || 'General', t: fortuneType(cell) } };
          if (cell.f) v.f = '=' + cell.f;
          celldata.push({ r, c, v });
        }
      }
    }
    for (const merge of sheet['!merges'] ?? []) {
      config.merge ??= {};
      config.merge[merge.s.r + '_' + merge.s.c] = { r: merge.s.r, c: merge.s.c, rs: merge.e.r - merge.s.r + 1, cs: merge.e.c - merge.s.c + 1 };
    }
    (sheet['!cols'] ?? []).forEach((col, i) => { if (col?.wpx) { config.columnlen ??= {}; config.columnlen[i] = Math.round(col.wpx); } });
    (sheet['!rows'] ?? []).forEach((row, i) => { if (row?.hpx) { config.rowlen ??= {}; config.rowlen[i] = Math.round(row.hpx); } });
    return { name, id: 'sheet-' + order, order, status: order === 0 ? 1 : 0, celldata, config,
      row: Math.max(MIN_ROWS, rows + 20), column: Math.max(MIN_COLS, cols + 5) };
  });
}

// FortuneSheet 셀 하나 → SheetJS 셀. 빈 셀이면 null.
function toCell(value) {
  if (value === null || value === undefined) return null;
  const v = typeof value === 'object' ? value : { v: value };
  const formula = typeof v.f === 'string' && v.f.startsWith('=') ? v.f.slice(1) : (typeof v.f === 'string' && v.f ? v.f : null);
  const raw = v.v;
  if (formula === null && (raw === undefined || raw === null || raw === '')) return null;
  const cell = {};
  if (typeof raw === 'number') { cell.t = 'n'; cell.v = raw; }
  else if (typeof raw === 'boolean') { cell.t = 'b'; cell.v = raw; }
  else if (raw === undefined || raw === null) { cell.t = 'n'; cell.v = 0; }
  else {
    const text = String(raw);
    const numeric = v.ct?.t === 'n' && text.trim() !== '' && Number.isFinite(Number(text));
    if (numeric) { cell.t = 'n'; cell.v = Number(text); } else { cell.t = 's'; cell.v = text; }
  }
  if (formula) cell.f = formula;
  if (v.ct?.fa && v.ct.fa !== 'General') cell.z = v.ct.fa;
  return cell;
}

// 시트 하나의 셀 목록: data(2차원)가 있으면 그것을, 없으면 celldata를 쓴다(비활성 시트는 data가 없다).
export function cellsOf(sheet) {
  const out = [];
  if (Array.isArray(sheet.data)) {
    sheet.data.forEach((row, r) => row?.forEach((value, c) => { const cell = toCell(value); if (cell) out.push({ r, c, cell }); }));
  } else {
    for (const item of sheet.celldata ?? []) { const cell = toCell(item.v); if (cell) out.push({ r: item.r, c: item.c, cell }); }
  }
  return out;
}

export function sheetsToWorkbook(sheets) {
  const workbook = XLSX.utils.book_new();
  const ordered = [...sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const sheet of ordered) {
    const ws = {};
    let maxR = 0, maxC = 0;
    for (const { r, c, cell } of cellsOf(sheet)) {
      ws[XLSX.utils.encode_cell({ r, c })] = cell;
      maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
    }
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    const merges = Object.values(sheet.config?.merge ?? {});
    if (merges.length) ws['!merges'] = merges.map(m => ({ s: { r: m.r, c: m.c }, e: { r: m.r + m.rs - 1, c: m.c + m.cs - 1 } }));
    const columnlen = sheet.config?.columnlen ?? {};
    if (Object.keys(columnlen).length) ws['!cols'] = Object.entries(columnlen).reduce((cols, [i, w]) => { cols[Number(i)] = { wpx: w }; return cols; }, []);
    const rowlen = sheet.config?.rowlen ?? {};
    if (Object.keys(rowlen).length) ws['!rows'] = Object.entries(rowlen).reduce((rows, [i, h]) => { rows[Number(i)] = { hpx: h }; return rows; }, []);
    XLSX.utils.book_append_sheet(workbook, ws, uniqueName(workbook, sheet.name || 'Sheet'));
  }
  if (!workbook.SheetNames.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1');
  return workbook;
}
function uniqueName(workbook, name) {
  const base = String(name).slice(0, 31) || 'Sheet';
  let candidate = base;
  for (let n = 2; workbook.SheetNames.includes(candidate); n += 1) candidate = (base.slice(0, 27) + ' (' + n + ')');
  return candidate;
}

// 형식별로 쓴다. numbers는 SheetJS에 딸린 템플릿(zahl)이 필요하다: 호출하는 쪽이 넘긴다.
export function writeWorkbook(workbook, format, { numbersTemplate = null } = {}) {
  const bookType = BOOK_TYPES[format];
  if (!bookType) throw Object.assign(new Error('INVALID_FORMAT'), { code: 'INVALID_FORMAT' });
  if (format === 'numbers' && !numbersTemplate) throw Object.assign(new Error('NUMBERS_TEMPLATE_REQUIRED'), { code: 'NUMBERS_TEMPLATE_REQUIRED' });
  // CSV: 첫 시트를 UTF-8(BOM 포함, Excel이 한글을 바로 읽는다)로 쓴다.
  if (format === 'csv') return new TextEncoder().encode('﻿' + XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]));
  const out = XLSX.write(workbook, { type: 'array', bookType, compression: true, ...(format === 'numbers' ? { numbers: numbersTemplate } : {}) });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

// 저장 전에 알려야 할 경고 코드. 확인 창은 셸이 띄운다.
// SheetJS CE의 xls(BIFF8)·numbers·csv 쓰기는 수식을 저장하지 않고 계산값만 남긴다(실측: test/sheet-convert.test.mjs).
const FORMULA_LOSSY = new Set(['xls', 'numbers', 'csv']);
export function warningsFor(format, { sheets = 1, hadStyles = false, structureChanged = false, hasFormulas = false } = {}) {
  const warnings = [];
  if (format === 'csv' && sheets > 1) warnings.push('CSV_FIRST_SHEET_ONLY');
  if (FORMULA_LOSSY.has(format) && hasFormulas) warnings.push('FORMULAS_AS_VALUES');
  if (format !== 'xlsx' && hadStyles) warnings.push('STYLES_NOT_SAVED');
  if (format === 'numbers') warnings.push('NUMBERS_DATA_ONLY');
  if (format === 'xlsx' && structureChanged) warnings.push('STRUCTURE_CHANGED_STYLES_RESET');
  return warnings;
}
export const WARNING_TEXT = {
  CSV_FIRST_SHEET_ONLY: 'CSV는 첫 시트만 저장됩니다',
  FORMULAS_AS_VALUES: '이 형식으로는 수식이 저장되지 않고 계산된 값만 남습니다',
  STYLES_NOT_SAVED: '이 형식으로는 글꼴·색 같은 서식이 저장되지 않습니다',
  NUMBERS_DATA_ONLY: 'Numbers 파일은 값과 수식만 저장됩니다(서식·차트·이미지는 빠집니다)',
  STRUCTURE_CHANGED_STYLES_RESET: '행·열을 넣거나 지워서 원본 서식을 유지하지 못합니다',
  CONVERTED_VIA_LIBREOFFICE: 'LibreOffice로 원래 형식으로 되돌려 저장합니다(일부 서식이 달라질 수 있습니다)',
};
// 원본에 서식 정보가 있었는지(글꼴·채우기가 있는 셀이 하나라도 있으면 true).
export function workbookHasStyles(workbook) {
  return workbook.SheetNames.some(name => Object.entries(workbook.Sheets[name]).some(([key, cell]) => !key.startsWith('!') && cell?.s && Object.keys(cell.s).length > 0));
}
export const sheetsHaveFormulas = sheets => sheets.some(sheet => cellsOf(sheet).some(({ cell }) => Boolean(cell.f)));
