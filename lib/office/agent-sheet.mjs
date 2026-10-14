// office_exec 시트 엔진. xlsx는 ExcelJS로 원본 위에 덧써 서식을 지키고, xls·ods·csv·numbers는 SheetJS로 읽고 쓴다.
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import ZAHL from 'xlsx/dist/xlsx.zahl.mjs';
import { readWorkbook, writeWorkbook, warningsFor, workbookHasStyles } from '../../web/office-src/sheet-convert.mjs';

const fail = (code, details, status = 400) => { throw Object.assign(new Error(code), { code, status, ...(details !== undefined ? { details } : {}) }); };
const FORMULA_LOSSY = new Set(['xls', 'numbers', 'csv']);
const MAX_CELLS = 20000;

function decodeRange(range) {
  if (typeof range !== 'string' || !/^[A-Z]{1,3}[0-9]{1,7}(:[A-Z]{1,3}[0-9]{1,7})?$/i.test(range)) fail('API_ARGS_INVALID', { range });
  const r = XLSX.utils.decode_range(range.toUpperCase());
  if ((r.e.r - r.s.r + 1) * (r.e.c - r.s.c + 1) > MAX_CELLS) fail('RANGE_TOO_LARGE', { max: MAX_CELLS });
  return r;
}
const plain = value => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value.richText)) return value.richText.map(run => run.text).join('');
  if (typeof value.text === 'string') return value.text;
  if (value.error) return value.error;
  if ('result' in value) return plain(value.result);
  return null;
};

export async function openSheet(bytes, format) {
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    return { format, kind: 'excel', wb, changes: [] };
  }
  const wb = readWorkbook(bytes, format);
  return { format, kind: 'sheetjs', wb, changes: [], hadStyles: workbookHasStyles(wb) };
}
export function sheetNames(model) {
  return model.kind === 'excel' ? model.wb.worksheets.map(ws => ws.name) : [...model.wb.SheetNames];
}
function pickSheet(model, sheet) {
  const names = sheetNames(model);
  const name = sheet === undefined ? names[0] : sheet;
  if (!names.includes(name)) fail('SHEET_NOT_FOUND', { sheet, sheets: names });
  return name;
}
// 2차원 값. 수식 셀은 {value, formula}.
export function readRange(model, { sheet, range } = {}) {
  const name = pickSheet(model, sheet);
  const r = decodeRange(range);
  const rows = [];
  for (let row = r.s.r; row <= r.e.r; row += 1) {
    const line = [];
    for (let col = r.s.c; col <= r.e.c; col += 1) {
      if (model.kind === 'excel') {
        const cell = model.wb.getWorksheet(name).getCell(row + 1, col + 1);
        const formula = cell.formula || (cell.value && typeof cell.value === 'object' && (cell.value.formula || cell.value.sharedFormula));
        line.push(formula ? { value: plain(cell.value), formula: '=' + formula } : plain(cell.value));
      } else {
        const cell = model.wb.Sheets[name][XLSX.utils.encode_cell({ r: row, c: col })];
        line.push(!cell ? null : cell.f ? { value: cell.v ?? null, formula: '=' + cell.f } : (cell.v ?? null));
      }
    }
    rows.push(line);
  }
  return rows;
}
// values: 2차원 배열. '='로 시작하는 문자열은 수식. null은 셀 비우기.
export function setCells(model, { sheet, start, values } = {}) {
  const name = pickSheet(model, sheet);
  if (typeof start !== 'string' || !/^[A-Z]{1,3}[0-9]{1,7}$/i.test(start)) fail('API_ARGS_INVALID', { start });
  if (!Array.isArray(values) || !values.length || !values.every(Array.isArray)) fail('API_ARGS_INVALID', { values: 'expected a 2D array' });
  const origin = XLSX.utils.decode_cell(start.toUpperCase());
  let count = 0;
  values.forEach((row, dr) => row.forEach((value, dc) => {
    if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) fail('API_ARGS_INVALID', { value });
    if (typeof value === 'number' && !Number.isFinite(value)) fail('API_ARGS_INVALID', { value });
    const formula = typeof value === 'string' && value.startsWith('=') ? value.slice(1) : null;
    if (formula && FORMULA_LOSSY.has(model.format)) fail('FORMULA_NOT_SAVED', { format: model.format, hint: 'this format stores values only; write the computed value instead' });
    const r = origin.r + dr, c = origin.c + dc;
    count += 1;
    if (count > MAX_CELLS) fail('RANGE_TOO_LARGE', { max: MAX_CELLS });
    if (model.kind === 'excel') {
      const cell = model.wb.getWorksheet(name).getCell(r + 1, c + 1);
      cell.value = formula ? { formula } : value;
    } else {
      const ws = model.wb.Sheets[name];
      const ref = XLSX.utils.encode_cell({ r, c });
      if (value === null) delete ws[ref];
      else ws[ref] = formula ? { t: 'n', f: formula } : typeof value === 'number' ? { t: 'n', v: value } : typeof value === 'boolean' ? { t: 'b', v: value } : { t: 's', v: value };
      const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r, c }, e: { r, c } };
      range.s.r = Math.min(range.s.r, r); range.s.c = Math.min(range.s.c, c);
      range.e.r = Math.max(range.e.r, r); range.e.c = Math.max(range.e.c, c);
      ws['!ref'] = XLSX.utils.encode_range(range);
    }
    model.changes.push({ sheet: name, r, c, value });
  }));
  return { count };
}
export async function sheetBytes(model) {
  if (model.kind === 'excel') {
    if (model.changes.length) model.wb.calcProperties = { ...(model.wb.calcProperties ?? {}), fullCalcOnLoad: true };
    return new Uint8Array(await model.wb.xlsx.writeBuffer());
  }
  return writeWorkbook(model.wb, model.format, { numbersTemplate: ZAHL });
}
export function sheetWarnings(model) {
  if (model.kind === 'excel') return [];
  return warningsFor(model.format, { sheets: model.wb.SheetNames.length, hadStyles: model.hadStyles }).filter(code => code !== 'FORMULAS_AS_VALUES');
}
// 저장할 바이트를 같은 엔진으로 다시 열어 바꾼 셀이 그대로인지 본다. 다르면 AGENT_VERIFY_MISMATCH.
export async function verifySheet(bytes, model) {
  const reopened = await openSheet(bytes, model.format);
  const mismatches = [];
  for (const change of model.changes) {
    const ref = XLSX.utils.encode_cell({ r: change.r, c: change.c });
    const [[got]] = readRange(reopened, { sheet: model.format === 'csv' ? undefined : change.sheet, range: ref });
    const want = change.value;
    const ok = typeof want === 'string' && want.startsWith('=')
      ? got && typeof got === 'object' && got.formula?.toUpperCase() === want.toUpperCase()
      : want === null ? got === null || got === ''
      : model.format === 'csv' ? String(got) === String(want)
      : got === want;
    if (!ok) mismatches.push({ cell: change.sheet + '!' + ref, expected: want, actual: got });
  }
  if (mismatches.length) fail('AGENT_VERIFY_MISMATCH', { mismatches: mismatches.slice(0, 20) }, 409);
}

