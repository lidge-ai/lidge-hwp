import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import ZAHL from 'xlsx/dist/xlsx.zahl.mjs';
import { readWorkbook, workbookToSheets, sheetsToWorkbook, writeWorkbook, cellsOf, warningsFor, sheetsHaveFormulas } from '../web/office-src/sheet-convert.mjs';

function sourceWorkbook() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['이름', '값'], ['사과', 3], ['배', 4]]);
  ws['!merges'] = [{ s: { r: 0, c: 3 }, e: { r: 0, c: 4 } }];
  ws.D1 = { t: 's', v: '병합 제목' };
  ws['!ref'] = 'A1:E3';
  XLSX.utils.book_append_sheet(wb, ws, '과일');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['메모']]), '두번째');
  return wb;
}
// 편집기에서 사람이 한 편집을 흉내 낸다: B2=42, C3 수식 =B2*2(값 84), 새 셀 A5.
function edit(sheets) {
  const first = sheets[0];
  const at = (r, c) => first.celldata.find(x => x.r === r && x.c === c);
  at(1, 1).v = { ...at(1, 1).v, v: 42, m: '42' };
  first.celldata.push({ r: 2, c: 2, v: { v: 84, m: '84', f: '=B2*2', ct: { fa: 'General', t: 'n' } } });
  first.celldata.push({ r: 4, c: 0, v: { v: '추가', m: '추가', ct: { fa: 'General', t: 'g' } } });
  return sheets;
}
const grid = (wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true });

for (const format of ['xlsx', 'xls', 'ods', 'csv', 'numbers']) {
  test('round trip ' + format + ': open → edit → save → reopen keeps values and formulas', () => {
    const original = writeWorkbook(sourceWorkbook(), format, { numbersTemplate: ZAHL });
    const opened = readWorkbook(original, format);
    const sheets = edit(workbookToSheets(opened));
    assert.equal(sheets[0].name, format === 'csv' ? 'Sheet1' : '과일');
    const saved = writeWorkbook(sheetsToWorkbook(sheets), format, { numbersTemplate: ZAHL });
    const reopened = readWorkbook(saved, format);
    const name = reopened.SheetNames[0];
    const rows = grid(reopened, name);
    assert.equal(rows[0][0], '이름');
    assert.equal(rows[1][1], 42);
    assert.equal(rows[2][1], 4);
    assert.equal(rows[4][0], '추가');
    // xls·numbers·csv는 SheetJS CE가 수식을 쓰지 않는다. 계산값이 남고, 저장 경고 FORMULAS_AS_VALUES로 알린다.
    const formulaKept = format === 'xlsx' || format === 'ods';
    assert.equal(sheetsHaveFormulas(sheets), true);
    assert.equal(warningsFor(format, { hasFormulas: true }).includes('FORMULAS_AS_VALUES'), !formulaKept);
    if (formulaKept) assert.equal(reopened.Sheets[name].C3.f, 'B2*2');
    else assert.equal(Number(rows[2][2]), 84);
    if (format === 'csv') {
      assert.equal(reopened.SheetNames.length, 1);
    } else {
      assert.deepEqual(reopened.SheetNames, ['과일', '두번째']);
      assert.equal(grid(reopened, '두번째')[0][0], '메모');
    }
    if (format === 'xlsx' || format === 'xls' || format === 'ods') {
      assert.deepEqual(reopened.Sheets[name]['!merges']?.map(m => XLSX.utils.encode_range(m)), ['D1:E1']);
    }
  });
}

test('the live 2D data matrix wins over stale celldata', () => {
  const sheet = { name: 'S', order: 0, celldata: [{ r: 0, c: 0, v: { v: 'old' } }],
    data: [[{ v: 'new', m: 'new' }, null], [null, { v: 7, m: '7', ct: { t: 'n' } }]] };
  assert.deepEqual(cellsOf(sheet), [{ r: 0, c: 0, cell: { t: 's', v: 'new' } }, { r: 1, c: 1, cell: { t: 'n', v: 7 } }]);
  // 숫자 형식 셀에 입력된 숫자 문자열은 숫자로 저장한다
  assert.deepEqual(cellsOf({ data: [[{ v: '12', ct: { t: 'n' } }]] })[0].cell, { t: 'n', v: 12 });
  assert.deepEqual(cellsOf({ data: [[{ v: '', f: '' }]] }), []);
});

test('csv keeps Korean text in UTF-8, UTF-8 BOM and UTF-16 inputs and writes UTF-8 with BOM', () => {
  const enc = s => new TextEncoder().encode(s);
  const utf16 = s => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < s.length; i += 1) { b[2 + i * 2] = s.charCodeAt(i) & 255; b[3 + i * 2] = s.charCodeAt(i) >> 8; } return b; };
  for (const input of [enc('이름,점수\n가,1\n'), enc('\ufeff이름,점수\n가,1\n'), utf16('이름,점수\n가,1\n')]) {
    const sheets = workbookToSheets(readWorkbook(input, 'csv'));
    assert.equal(sheets[0].celldata.find(c => c.r === 1 && c.c === 0).v.v, '가');
    const out = writeWorkbook(sheetsToWorkbook(sheets), 'csv');
    assert.deepEqual([...out.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(new TextDecoder().decode(out.subarray(3)).split('\n')[1], '가,1');
  }
});

test('numbers write refuses without the template instead of writing a broken file', () => {
  assert.throws(() => writeWorkbook(sourceWorkbook(), 'numbers'), { code: 'NUMBERS_TEMPLATE_REQUIRED' });
  assert.throws(() => writeWorkbook(sourceWorkbook(), 'pdf'), { code: 'INVALID_FORMAT' });
});

test('warnings describe what a format cannot keep', () => {
  assert.deepEqual(warningsFor('csv', { sheets: 2 }), ['CSV_FIRST_SHEET_ONLY']);
  assert.deepEqual(warningsFor('numbers'), ['NUMBERS_DATA_ONLY']);
  assert.deepEqual(warningsFor('ods', { hadStyles: true }), ['STYLES_NOT_SAVED']);
  assert.deepEqual(warningsFor('xlsx', { hadStyles: true }), []);
  assert.deepEqual(warningsFor('xlsx', { structureChanged: true }), ['STRUCTURE_CHANGED_STYLES_RESET']);
});
