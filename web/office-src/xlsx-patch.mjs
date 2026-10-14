// xlsx 전용 경로: ExcelJS로 원본을 읽어 화면용 시트를 만들고, 저장 때는 바뀐 셀만 원본 위에 덧쓴다.
// 손대지 않은 셀의 서식·열 너비·조건부 서식 등은 ExcelJS가 읽고 쓰는 만큼 그대로 남는다.
import ExcelJS from 'exceljs';
import { MIN_COLS, MIN_ROWS } from './sheet-convert.mjs';

export async function loadExcel(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}
const hexOf = color => (typeof color?.argb === 'string' && color.argb.length >= 6 ? '#' + color.argb.slice(-6).toUpperCase() : null);
const argbOf = hex => 'FF' + String(hex).replace('#', '').toUpperCase().padStart(6, '0').slice(-6);
const HT = { center: 0, left: 1, right: 2 };

function plainValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value.richText)) return value.richText.map(run => run.text).join('');
  if (typeof value.text === 'string') return value.text;
  if (value.error) return value.error;
  if ('result' in value) return plainValue(value.result);
  return null;
}
function fortuneCell(cell) {
  const value = cell.value;
  const formula = cell.formula || (value && typeof value === 'object' && (value.formula || value.sharedFormula)) || null;
  const v = plainValue(value);
  if (v === null && !formula) return null;
  const out = { v: v ?? '', m: cell.text ?? (v === null ? '' : String(v)), ct: { fa: cell.numFmt || 'General', t: typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 'g' } };
  if (formula) out.f = '=' + formula;
  const font = cell.font ?? {};
  if (font.bold) out.bl = 1;
  if (font.italic) out.it = 1;
  if (font.underline) out.un = 1;
  if (font.size) out.fs = font.size;
  const fc = hexOf(font.color);
  if (fc) out.fc = fc;
  const fill = cell.fill;
  const bg = fill?.type === 'pattern' && fill.pattern === 'solid' ? hexOf(fill.fgColor) : null;
  if (bg) out.bg = bg;
  const ht = HT[cell.alignment?.horizontal];
  if (ht !== undefined) out.ht = ht;
  return out;
}
const decodeRef = ref => {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  const col = [...match[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { r: Number(match[2]) - 1, c: col };
};
const encodeRef = (r, c) => { let s = '', n = c + 1; while (n) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s + (r + 1); };

export function excelToSheets(workbook) {
  return workbook.worksheets.map((ws, order) => {
    const celldata = [];
    const config = {};
    let maxR = 0, maxC = 0;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (cell.isMerged && cell.master !== cell) return;
        const v = fortuneCell(cell);
        if (!v) return;
        celldata.push({ r: rowNumber - 1, c: colNumber - 1, v });
        maxR = Math.max(maxR, rowNumber); maxC = Math.max(maxC, colNumber);
      });
    });
    for (const range of ws.model.merges ?? []) {
      const [a, b] = range.split(':');
      const s = decodeRef(a), e = decodeRef(b ?? a);
      config.merge ??= {};
      config.merge[s.r + '_' + s.c] = { r: s.r, c: s.c, rs: e.r - s.r + 1, cs: e.c - s.c + 1 };
    }
    (ws.columns ?? []).forEach((col, i) => { if (col?.width) { config.columnlen ??= {}; config.columnlen[i] = Math.round(col.width * 7 + 5); } });
    ws.eachRow({ includeEmpty: true }, (row, n) => { if (row.height) { config.rowlen ??= {}; config.rowlen[n - 1] = Math.round(row.height * 4 / 3); } });
    return { name: ws.name, id: 'sheet-' + order, order, status: order === 0 ? 1 : 0, celldata, config,
      row: Math.max(MIN_ROWS, maxR + 20), column: Math.max(MIN_COLS, maxC + 5) };
  });
}

// 비교용 정규화: 값·수식·굵게/기울임/밑줄·글자색·배경·크기.
const KEYS = ['v', 'f', 'bl', 'it', 'un', 'fc', 'bg', 'fs'];
function normalize(value) {
  if (value === null || value === undefined || typeof value !== 'object') return value === null || value === undefined || value === '' ? null : { v: value };
  const out = {};
  for (const key of KEYS) if (value[key] !== undefined && value[key] !== null && value[key] !== '' && value[key] !== 0) out[key] = value[key];
  if (out.v !== undefined && typeof out.v !== 'number' && typeof out.v !== 'boolean') out.v = String(out.v);
  return Object.keys(out).length ? out : null;
}
function cellMap(sheet) {
  const map = new Map();
  if (Array.isArray(sheet.data)) sheet.data.forEach((row, r) => row?.forEach((value, c) => { const n = normalize(value); if (n) map.set(r + ',' + c, { n, raw: value }); }));
  else for (const item of sheet.celldata ?? []) { const n = normalize(item.v); if (n) map.set(item.r + ',' + item.c, { n, raw: item.v }); }
  return map;
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const pick = (n, keys) => Object.fromEntries(keys.map(k => [k, n?.[k] ?? null]));

function writeValue(cell, entry) {
  const raw = entry?.raw && typeof entry.raw === 'object' ? entry.raw : { v: entry?.raw };
  const formula = typeof raw.f === 'string' && raw.f.startsWith('=') ? raw.f.slice(1) : null;
  let v = raw.v;
  if (typeof v === 'string' && raw.ct?.t === 'n' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
  if (formula) cell.value = { formula, result: v === '' ? undefined : v };
  else cell.value = v === undefined || v === '' ? null : v;
}
function writeStyle(cell, n) {
  const font = { ...(cell.font ?? {}) };
  font.bold = Boolean(n?.bl); font.italic = Boolean(n?.it); font.underline = Boolean(n?.un);
  if (n?.fs) font.size = n.fs;
  if (n?.fc) font.color = { argb: argbOf(n.fc) }; else delete font.color;
  cell.font = font;
  cell.fill = n?.bg ? { type: 'pattern', pattern: 'solid', fgColor: { argb: argbOf(n.bg) } } : { type: 'pattern', pattern: 'none' };
}

// baseline: 열 때 만든 시트(excelToSheets), edited: 편집기의 getAllSheets(). 반환: 새 xlsx 바이트와 바뀐 셀 수.
export async function patchXlsx(bytes, baseline, edited) {
  const workbook = await loadExcel(bytes);
  const byId = new Map(baseline.map((sheet, i) => [sheet.id, workbook.worksheets[i]]));
  let changed = 0;
  const kept = new Set();
  for (const sheet of [...edited].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    let ws = byId.get(sheet.id);
    const base = baseline.find(b => b.id === sheet.id);
    if (!ws) { ws = workbook.addWorksheet(sheet.name || 'Sheet'); }
    kept.add(ws.id);
    if (sheet.name && ws.name !== sheet.name) ws.name = sheet.name;
    const before = base ? cellMap(base) : new Map();
    const after = cellMap(sheet);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key)?.n ?? null, b = after.get(key)?.n ?? null;
      if (same(a, b)) continue;
      const [r, c] = key.split(',').map(Number);
      const cell = ws.getCell(r + 1, c + 1);
      if (!same(pick(a, ['v', 'f']), pick(b, ['v', 'f']))) writeValue(cell, after.get(key) ?? null);
      if (!same(pick(a, ['bl', 'it', 'un', 'fc', 'bg', 'fs']), pick(b, ['bl', 'it', 'un', 'fc', 'bg', 'fs']))) writeStyle(cell, b);
      changed += 1;
    }
    const baseMerges = new Set(Object.values(base?.config?.merge ?? {}).map(m => m.r + '_' + m.c + '_' + m.rs + '_' + m.cs));
    const nextMerges = Object.values(sheet.config?.merge ?? {});
    for (const m of nextMerges) {
      const key = m.r + '_' + m.c + '_' + m.rs + '_' + m.cs;
      if (!baseMerges.delete(key)) { ws.mergeCells(encodeRef(m.r, m.c) + ':' + encodeRef(m.r + m.rs - 1, m.c + m.cs - 1)); changed += 1; }
    }
    for (const key of baseMerges) {
      const [r, c, rs, cs] = key.split('_').map(Number);
      ws.unMergeCells(encodeRef(r, c) + ':' + encodeRef(r + rs - 1, c + cs - 1)); changed += 1;
    }
  }
  for (const ws of [...workbook.worksheets]) if (!kept.has(ws.id)) { workbook.removeWorksheet(ws.id); changed += 1; }
  // 값이 바뀌면 원본 수식의 저장된 결과가 낡는다. Excel·Numbers가 열 때 다시 계산하게 표시한다.
  if (changed) workbook.calcProperties = { ...(workbook.calcProperties ?? {}), fullCalcOnLoad: true };
  return { bytes: new Uint8Array(await workbook.xlsx.writeBuffer()), changed };
}
