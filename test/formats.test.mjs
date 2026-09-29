import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMATS, formatOf, familyOf, isEditable, matchesBytes, needsConversion, isListedName, ACCEPT, NEW_FORMATS, labelOf } from '../lib/formats.mjs';
import { sniffBytes } from '../lib/office/sniff.mjs';
import { matchesFormat } from '../lib/docstore.mjs';
import { blankDocx, blankXlsx } from '../lib/office/blank.mjs';
import { readZip } from '../lib/office/zip.mjs';

const CFB = Buffer.from('d0cf11e0a1b11ae100', 'hex');
const ZIP = Buffer.from('504b030400000000', 'hex');

test('registry knows 16 formats in four families and nothing else', () => {
  assert.equal(Object.keys(FORMATS).length, 16);
  const families = Object.fromEntries(Object.entries(FORMATS).map(([f, v]) => [f, v.family]));
  assert.deepEqual(Object.keys(families).filter(f => families[f] === 'hwp'), ['hwp', 'hwpx']);
  assert.deepEqual(Object.keys(families).filter(f => families[f] === 'sheet'), ['xlsx', 'xls', 'ods', 'csv', 'numbers']);
  assert.deepEqual(Object.keys(families).filter(f => families[f] === 'doc'), ['docx', 'odt', 'rtf', 'doc', 'pages']);
  assert.deepEqual(Object.keys(families).filter(f => families[f] === 'slides'), ['pptx', 'ppt', 'odp', 'key']);
  for (const name of ['a.txt', 'a.pdf', 'noext', '', null, 'a.hwp.bak']) assert.equal(formatOf(name), null, String(name));
  assert.equal(formatOf('보고서.HWPX'), 'hwpx');
  assert.equal(formatOf('dir/가계부.numbers'), 'numbers');
  assert.equal(familyOf('pptx'), 'slides');
  assert.equal(familyOf('txt'), null);
  assert.equal(labelOf('numbers'), 'NUM');
});

test('editability and conversion flags', () => {
  for (const f of ['hwp', 'hwpx', 'xlsx', 'xls', 'ods', 'csv', 'numbers', 'docx', 'odt', 'rtf', 'doc']) assert.equal(isEditable(f), true, f);
  for (const f of ['pages', 'pptx', 'ppt', 'odp', 'key', 'txt']) assert.equal(isEditable(f), false, f);
  assert.deepEqual(Object.keys(FORMATS).filter(needsConversion), ['odt', 'rtf', 'doc', 'pages']);
  assert.deepEqual(NEW_FORMATS, ['hwp', 'xlsx', 'docx']);
  assert.ok(ACCEPT.split(',').includes('.numbers') && ACCEPT.split(',').includes('.hwpx'));
});

test('magic bytes: cfb, zip, rtf and text', () => {
  assert.equal(matchesBytes(CFB, 'xls'), true);
  assert.equal(matchesBytes(ZIP, 'xls'), false);
  assert.equal(matchesBytes(ZIP, 'docx'), true);
  assert.equal(matchesBytes(Buffer.from('{\\rtf1 hi}'), 'rtf'), true);
  assert.equal(matchesBytes(Buffer.from('plain'), 'rtf'), false);
  assert.equal(matchesBytes(Buffer.from('a,b\n1,2\n'), 'csv'), true);
  assert.equal(matchesBytes(Buffer.from('a'), 'csv'), true);
  assert.equal(matchesBytes(Buffer.from([0x61, 0x00, 0x62]), 'csv'), false);
  assert.equal(matchesBytes(Buffer.from([0xff, 0xfe, 0x61, 0x00]), 'csv'), true); // UTF-16LE BOM
  assert.equal(matchesBytes(Buffer.alloc(0), 'csv'), false);
  assert.equal(matchesBytes(ZIP, 'txt'), false);
});

test('HWP/HWPX judgement in docstore.matchesFormat is unchanged; other formats delegate', () => {
  assert.equal(matchesFormat(CFB, 'hwp'), true);
  assert.equal(matchesFormat(ZIP, 'hwpx'), true);
  assert.equal(matchesFormat(ZIP, 'hwp'), false);
  assert.equal(matchesFormat(Buffer.from('504b0304', 'hex'), 'hwpx'), false); // 8바이트 미만은 예전처럼 거절
  assert.equal(matchesFormat(CFB, 'doc'), true);
  assert.equal(matchesFormat(ZIP, 'doc'), false);
});

test('zip sniffing rejects an extension swap between zip-based office formats', () => {
  const docx = blankDocx();
  const xlsx = blankXlsx();
  assert.equal(sniffBytes(docx, 'docx'), true);
  assert.equal(sniffBytes(docx, 'xlsx'), false);
  assert.equal(sniffBytes(xlsx, 'xlsx'), true);
  assert.equal(sniffBytes(xlsx, 'pptx'), false);
  assert.equal(sniffBytes(xlsx, 'numbers'), false);
  assert.equal(sniffBytes(CFB, 'xls'), true); // CFB 계열은 시그니처만 본다(문서화된 한계)
});

test('blank docx is a valid package with a single empty paragraph', () => {
  const files = readZip(blankDocx());
  assert.deepEqual([...files.keys()].sort(), ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
  assert.match(new TextDecoder().decode(files.get('word/document.xml')), /<w:body><w:p\/>/);
});

test('listed names skip temp and Office lock files', () => {
  assert.equal(isListedName('a.xlsx'), true);
  assert.equal(isListedName('~$a.docx'), false);
  assert.equal(isListedName('.lidge-1234.tmp'), false);
  assert.equal(isListedName('.lidge-x.docx'), false);
  assert.equal(isListedName('notes.txt'), false);
});

