import test from 'node:test';
import assert from 'node:assert/strict';
import { blankDocx } from '../lib/office/blank.mjs';
import { paragraphs, replaceText, appendParagraph, documentText } from '../lib/office/docx-text.mjs';
import { readZip, writeZip, text, bytesOf } from '../lib/office/zip.mjs';

function withBody(inner) {
  const files = readZip(blankDocx());
  const xml = text(files.get('word/document.xml')).replace('<w:body><w:p/>', '<w:body>' + inner);
  files.set('word/document.xml', bytesOf(xml));
  return writeZip(files);
}

test('append and read paragraphs, including XML-special characters', () => {
  let doc = appendParagraph(blankDocx(), '안녕 세계');
  doc = appendParagraph(doc, 'A & B <C>');
  assert.deepEqual(paragraphs(doc).map(p => p.text), ['', '안녕 세계', 'A & B <C>']);
  assert.match(text(readZip(doc).get('word/document.xml')), /A &amp; B &lt;C&gt;/);
});

test('replace across split runs keeps run formatting and counts matches', () => {
  const doc = withBody('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>안녕 </w:t></w:r><w:r><w:t>세계</w:t></w:r><w:r><w:t xml:space="preserve"> 그리고 안녕 세계</w:t></w:r></w:p><w:p><w:r><w:t>다른 문단</w:t></w:r></w:p>');
  const { bytes, count } = replaceText(doc, { find: '안녕 세계', replace: '반가워' });
  assert.equal(count, 2);
  assert.deepEqual(paragraphs(bytes).map(p => p.text), ['반가워 그리고 반가워', '다른 문단']);
  const xml = text(readZip(bytes).get('word/document.xml'));
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">반가워<\/w:t>/);
  assert.ok(readZip(bytes).has('word/styles.xml'));
});

test('expectedCount mismatch fails without writing; missing text returns the same bytes', () => {
  const doc = appendParagraph(blankDocx(), '하나 하나');
  assert.throws(() => replaceText(doc, { find: '하나', replace: '둘', expectedCount: 1 }), { code: 'REPLACE_COUNT_MISMATCH', details: { expected: 1, actual: 2 } });
  const none = replaceText(doc, { find: '없음', replace: 'x' });
  assert.equal(none.count, 0);
  assert.deepEqual(none.bytes, Buffer.from(doc));
  assert.throws(() => replaceText(doc, { find: '', replace: 'x' }), { code: 'API_ARGS_INVALID' });
  assert.throws(() => paragraphs(Buffer.from('not a zip')), { code: 'INVALID_BYTES' });
  assert.equal(documentText(doc), '\n하나 하나');
});

