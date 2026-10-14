import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { excelToSheets, loadExcel, patchXlsx } from '../web/office-src/xlsx-patch.mjs';

async function styled() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('예산');
  ws.getCell('A1').value = '항목';
  ws.getCell('A1').font = { bold: true, color: { argb: 'FFC00000' }, size: 14 };
  ws.getCell('B1').value = '금액';
  ws.getCell('B2').value = 1000;
  ws.getCell('B2').numFmt = '#,##0';
  ws.getCell('B2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  ws.getCell('B3').value = { formula: 'B2*2', result: 2000 };
  ws.mergeCells('D1:E1');
  ws.getCell('D1').value = '병합';
  ws.getColumn(1).width = 20;
  wb.addWorksheet('빈 시트');
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
const clone = value => JSON.parse(JSON.stringify(value));
const find = (sheet, r, c) => sheet.celldata.find(x => x.r === r && x.c === c);

test('excelToSheets exposes values, formulas, styles, merges and widths', async () => {
  const sheets = excelToSheets(await loadExcel(await styled()));
  assert.deepEqual(sheets.map(s => s.name), ['예산', '빈 시트']);
  const [s] = sheets;
  assert.equal(find(s, 0, 0).v.bl, 1);
  assert.equal(find(s, 0, 0).v.fc, '#C00000');
  assert.equal(find(s, 0, 0).v.fs, 14);
  assert.equal(find(s, 1, 1).v.v, 1000);
  assert.equal(find(s, 1, 1).v.bg, '#FFF2CC');
  assert.equal(find(s, 1, 1).v.ct.fa, '#,##0');
  assert.equal(find(s, 2, 1).v.f, '=B2*2');
  assert.deepEqual(s.config.merge['0_3'], { r: 0, c: 3, rs: 1, cs: 2 });
  assert.equal(s.config.columnlen[0], 145);
});

test('patch changes only edited cells and keeps untouched styles', async () => {
  const bytes = await styled();
  const baseline = excelToSheets(await loadExcel(bytes));
  const edited = clone(baseline);
  find(edited[0], 1, 1).v.v = 4242;                       // 값만 바꿈(채우기 유지)
  edited[0].celldata.push({ r: 5, c: 0, v: { v: '새 행', m: '새 행', ct: { fa: 'General', t: 'g' } } });
  find(edited[0], 0, 1).v.bl = 1;                          // B1 굵게
  const { bytes: out, changed } = await patchXlsx(bytes, baseline, edited);
  assert.equal(changed, 3);
  const wb = await loadExcel(out);
  const ws = wb.getWorksheet('예산');
  assert.equal(ws.getCell('B2').value, 4242);
  assert.equal(ws.getCell('B2').numFmt, '#,##0');
  assert.equal(ws.getCell('B2').fill.fgColor.argb, 'FFFFF2CC');
  assert.deepEqual({ bold: ws.getCell('A1').font.bold, color: ws.getCell('A1').font.color.argb }, { bold: true, color: 'FFC00000' });
  assert.equal(ws.getCell('B1').font.bold, true);
  assert.equal(ws.getCell('A6').value, '새 행');
  assert.deepEqual(ws.getCell('B3').value, { formula: 'B2*2', result: 2000 });
  assert.equal(ws.getColumn(1).width, 20);
  assert.deepEqual(ws.model.merges, ['D1:E1']);
  assert.deepEqual(wb.worksheets.map(w => w.name), ['예산', '빈 시트']);
});

test('patch handles cleared cells, new formulas, renamed/removed/added sheets and merges', async () => {
  const bytes = await styled();
  const baseline = excelToSheets(await loadExcel(bytes));
  const edited = clone(baseline);
  edited[0].name = '예산 2026';
  edited[0].celldata = edited[0].celldata.filter(x => !(x.r === 0 && x.c === 1)); // B1 지움
  edited[0].celldata.push({ r: 3, c: 1, v: { v: 6000, f: '=B2+B3*2', ct: { fa: 'General', t: 'n' } } });
  delete edited[0].config.merge['0_3'];
  edited[0].config.merge['6_0'] = { r: 6, c: 0, rs: 1, cs: 3 };
  edited.pop(); // '빈 시트' 삭제
  edited.push({ name: '새 시트', id: 'new-1', order: 5, celldata: [{ r: 0, c: 0, v: { v: 'x' } }], config: {} });
  const { bytes: out } = await patchXlsx(bytes, baseline, edited);
  const wb = await loadExcel(out);
  assert.deepEqual(wb.worksheets.map(w => w.name), ['예산 2026', '새 시트']);
  const ws = wb.getWorksheet('예산 2026');
  assert.equal(ws.getCell('B1').value, null);
  assert.deepEqual(ws.getCell('B4').value, { formula: 'B2+B3*2', result: 6000 });
  assert.deepEqual(ws.model.merges, ['A7:C7']);
  assert.equal(wb.getWorksheet('새 시트').getCell('A1').value, 'x');
});

test('the 2D data matrix from the live editor is read in preference to celldata', async () => {
  const bytes = await styled();
  const baseline = excelToSheets(await loadExcel(bytes));
  const edited = clone(baseline);
  edited[0].data = Array.from({ length: 3 }, () => Array(3).fill(null));
  for (const { r, c, v } of edited[0].celldata) if (r < 3 && c < 3) edited[0].data[r][c] = v;
  edited[0].data[2][0] = { v: '행3', m: '행3', ct: { t: 'g' } };
  edited[0].celldata = []; // 낡은 celldata는 무시돼야 한다
  const { bytes: out } = await patchXlsx(bytes, baseline.map(s => ({ ...s, celldata: s.celldata.filter(x => x.r < 3 && x.c < 3) })), edited);
  const ws = (await loadExcel(out)).getWorksheet('예산');
  assert.equal(ws.getCell('A3').value, '행3');
  assert.equal(ws.getCell('B2').value, 1000);
});

