// LibreOffice(soffice)가 있어야 도는 테스트. 건너뛰지 않는다: soffice가 없으면 실패한다.
// 실행: npm run test:soffice (기본 npm test 글롭 test/*.test.mjs 밖)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { findSoffice, convert } from '../../lib/office/soffice.mjs';
import { blankDocx } from '../../lib/office/blank.mjs';
import { sniffBytes } from '../../lib/office/sniff.mjs';

test('soffice is discoverable', () => {
  assert.ok(findSoffice(), 'soffice required: install LibreOffice or set LIDGE_HWP_SOFFICE');
});

test('csv converts to xlsx with the values intact', async () => {
  const out = await convert(Buffer.from('이름,값\n가,1\n나,2\n'), { from: 'csv', to: 'xlsx' });
  assert.equal(sniffBytes(out, 'xlsx'), true);
  const wb = XLSX.read(out);
  assert.deepEqual(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }), [['이름', '값'], ['가', 1], ['나', 2]]);
});

test('docx round-trips through odt and rtf', async () => {
  const odt = await convert(blankDocx(), { from: 'docx', to: 'odt' });
  assert.equal(sniffBytes(odt, 'odt'), true);
  const back = await convert(odt, { from: 'odt', to: 'docx' });
  assert.equal(sniffBytes(back, 'docx'), true);
  const rtf = await convert(blankDocx(), { from: 'docx', to: 'rtf' });
  assert.equal(rtf.subarray(0, 5).toString(), '{\\rtf');
});

test('a missing converter binary is reported, not hidden', async () => {
  await assert.rejects(convert(blankDocx(), { from: 'docx', to: 'odt', bin: null }), { code: 'SOFFICE_UNAVAILABLE' });
  await assert.rejects(convert(blankDocx(), { from: 'docx', to: 'odt', bin: '/nonexistent/soffice' }), { code: 'CONVERT_FAILED' });
});

