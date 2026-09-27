import test from 'node:test'; import assert from 'node:assert/strict';
import { applyOp, newBatch, readView, sha, validateBatch } from '../lib/ops.mjs';
function bodyDoc(paras) {
  const calls = [];
  return { calls, getSectionCount: () => 1, getParagraphCount: () => paras.length,
    getParagraphLength: (_, p) => Array.from(paras[p]).length,
    getTextRange: (_, p, o, n) => Array.from(paras[p]).slice(o, o + n).join(''),
    insertText: (s, p, o, t) => { calls.push([s, p, o, t]); const a = Array.from(paras[p]); a.splice(o, 0, ...Array.from(t)); paras[p] = a.join(''); return JSON.stringify({ ok: true }); } };
}
test('insertText appends to a body paragraph by default and records the full paragraph preimage', () => {
  const doc = bodyDoc(['◦ ', '- 기존']), batch = newBatch({ diskSha256: 'x' });
  const out = applyOp(doc, batch, 'insertText', { paragraph: 1, text: ' 추가' });
  assert.deepEqual(doc.calls, [[0, 1, 4, ' 추가']]);
  assert.deepEqual(out, { before: '- 기존', after: '- 기존 추가' });
  assert.deepEqual(batch.ops[0].resolved, { section: 0, para: 1, control: null, cell: null, offset: 4, length: 0 });
  assert.deepEqual(batch.ops[0].args, { section: 0, paragraph: 1, offset: 4, text: ' 추가' });
  assert.equal(batch.ops[0].beforeSha256, sha('- 기존'));
  assert.equal(validateBatch(batch), batch);
  applyOp(doc, batch, 'insertText', { paragraph: 0, offset: 0, text: 'A' });
  assert.equal(doc.calls[1][2], 0);
});
test('insertText rejects out-of-range coordinates, empty or multi-line text', () => {
  const doc = bodyDoc(['abc']), batch = newBatch({ diskSha256: 'x' });
  assert.throws(() => applyOp(doc, batch, 'insertText', { paragraph: 1, text: 'x' }), /paragraph out of bounds/);
  assert.throws(() => applyOp(doc, batch, 'insertText', { paragraph: 0, offset: 4, text: 'x' }), /offset out of bounds/);
  assert.throws(() => applyOp(doc, batch, 'insertText', { paragraph: 0, text: '' }), /empty text/);
  assert.throws(() => applyOp(doc, batch, 'insertText', { paragraph: 0, text: 'a\nb' }), /invalid text/);
  assert.equal(doc.calls.length, 0);
  assert.equal(batch.ops.length, 0);
});
test('paragraphs lists body paragraphs with coordinates', () => {
  const doc = bodyDoc(['가', '', '다']);
  assert.deepEqual(readView(doc, 'paragraphs', { from: 1, count: 5 }),
    { total: 3, paragraphs: [{ section: 0, paragraph: 1, text: '' }, { section: 0, paragraph: 2, text: '다' }] });
});
test('setCell clears each paragraph before insert', () => {
  const calls = [], doc = {
    getSectionCount: () => 1, getParagraphCount: () => 1,
    getControls: () => JSON.stringify([{ list: 0, para: 0, ctrlId: 'tbl', controlIndex: 0 }]),
    getTableDimensions: () => JSON.stringify({ rowCount: 1, colCount: 1, cellCount: 1 }),
    getCellInfo: () => JSON.stringify({ row: 0, col: 0, rowSpan: 1, colSpan: 1 }),
    getCellParagraphCount: () => 2, getCellParagraphLength: (_, __, ___, ____, p) => p ? 1 : 2,
    getTextInCell: (_, __, ___, ____, p) => p ? 'B' : 'AA',
    deleteTextInCell: (...args) => calls.push(['del', ...args]),
    insertTextInCell: (...args) => calls.push(['ins', ...args]),
  };
  const batch = newBatch({ diskSha256: 'x' });
  applyOp(doc, batch, 'setCell', { table: 0, row: 0, col: 0, text: 'X' });
  assert.deepEqual(calls.map(c => c[0]), ['del','del','ins']);
  assert.equal(batch.ops[0].beforeSha256, sha('AA\nB'));
  assert.equal(validateBatch(batch), batch);
  assert.throws(() => applyOp(doc, batch, 'setCell', { table: 0, row: 0, col: 0, text: 'a\nb' }), /invalid text/);
});
test('setCheckbox records the parentPara it edited (cell hit) and null for a body hit', () => {
  const calls = [];
  const cellHit = { sec: 0, para: 4, charOffset: 3, length: 1, cellContext: { parentPara: 4, ctrlIdx: 0, cellIdx: 2, cellPara: 1 } };
  const bodyHit = { sec: 0, para: 7, charOffset: 0, length: 1 };
  const doc = {
    searchAllText: () => JSON.stringify([cellHit, bodyHit]),
    deleteTextInCell: (...args) => calls.push(['del', ...args]),
    insertTextInCell: (...args) => calls.push(['ins', ...args]),
    replaceText: (...args) => calls.push(['rep', ...args]),
  };
  const batch = newBatch({ diskSha256: 'x' });
  applyOp(doc, batch, 'setCheckbox', { occurrence: 0 });
  assert.deepEqual(calls.map(c => [c[0], c[2]]), [['del', 4], ['ins', 4]]);
  assert.equal(batch.ops[0].resolved.parentPara, 4);
  assert.deepEqual(batch.ops[0].resolved, { section: 0, para: 4, parentPara: 4, control: 0, cell: 2, cellPara: 1, offset: 3, length: 1 });
  applyOp(doc, batch, 'setCheckbox', { occurrence: 1 });
  assert.equal(calls.at(-1)[0], 'rep');
  assert.equal(batch.ops[1].resolved.parentPara, null);
  assert.equal(validateBatch(batch), batch);
});

// ── wp13 (#28 #29, 010 Revision 2~4). 공개 fixture(test/helpers/wp13-docs.mjs), 새 함수는 동적 import로 부른다 ──
import { applyCall } from '../lib/ops.mjs';
import { openDocument, exportWithReport } from '../lib/rhwp-node.mjs';
import { buildDoc, openBytes, bodyParas, cellParas } from './helpers/wp13-docs.mjs';
const textHelpers = () => import('../lib/text-helpers.mjs');
const ops = () => import('../lib/ops.mjs');
const hasCode = c => e => { assert.equal(e.code, c, e.message); return true; };
const opNames = b => b.ops.map(o => o.kind === 'call' ? o.args.method : o.kind);

test('wp13 #28 insertText splitLines: 본문 중간·빈 줄·CRLF, op 순서, 저장 왕복, 기본은 위치를 알려 거절', async t => {
  const doc = await openBytes(t, await buildDoc({ body: ['ABCD'] }));
  const { insertTextHelper } = await textHelpers();
  const b = newBatch({});
  const r = insertTextHelper(doc, b, { paragraph: 0, offset: 2, text: 'X\r\n\nY', splitLines: true });
  assert.deepEqual(bodyParas(doc), ['ABX', '', 'YCD']);
  assert.deepEqual(opNames(b), ['insertText', 'splitParagraph', 'splitParagraph', 'insertText']);
  assert.deepEqual(r, { first: { section: 0, paragraph: 0 }, last: { section: 0, paragraph: 2 }, lineCount: 3 });
  assert.equal(validateBatch(b), b);
  const again = await openDocument(exportWithReport(doc, 'hwp').bytes);
  try { assert.deepEqual(bodyParas(again), ['ABX', '', 'YCD']); } finally { again.free(); }
  const before = bodyParas(doc), plainBatch = newBatch({});
  assert.throws(() => insertTextHelper(doc, plainBatch, { paragraph: 0, text: 'a\r\nb' }),
    /invalid text: U\+000D at codePointIndex=1, utf16Index=1/);
  assert.throws(() => insertTextHelper(doc, plainBatch, { paragraph: 0, text: 'a\tb', splitLines: true }),
    /invalid text: U\+0009 at codePointIndex=1, utf16Index=1/);
  assert.deepEqual(bodyParas(doc), before);
  assert.equal(plainBatch.ops.length, 0);
});

test('wp13 #28 setCell splitLines: 칸 문단 수가 줄 수와 같고(빈 첫·끝 줄 포함), op 한도는 편집 전에 거절', async t => {
  const doc = await openBytes(t, await buildDoc({ body: ['본문'], table: { rows: 1, cols: 2 }, cells: { '0,0': ['옛1', '옛2'], '0,1': '둘' } }));
  const { setCellHelper } = await textHelpers();
  assert.deepEqual(cellParas(doc, 0, 0, 0), ['옛1', '옛2']);
  const b = newBatch({});
  setCellHelper(doc, b, { table: 0, row: 0, col: 0, text: 'A\n\nB\n', splitLines: true });
  assert.deepEqual(cellParas(doc, 0, 0, 0), ['A', '', 'B', '']);
  assert.ok(b.ops.every(o => ['setCell', 'insertTextInCell', 'call'].includes(o.kind)));
  assert.equal(validateBatch(b), b);
  setCellHelper(doc, newBatch({}), { table: 0, row: 0, col: 1, text: '\n끝', splitLines: true });
  assert.deepEqual(cellParas(doc, 0, 0, 1), ['', '끝']);
  const again = await openDocument(exportWithReport(doc, 'hwp').bytes);
  try { assert.deepEqual(cellParas(again, 0, 0, 0), ['A', '', 'B', '']); } finally { again.free(); }
  const full = newBatch({}); full.ops.length = 4094; full.ops.fill({ kind: 'call' });
  assert.throws(() => setCellHelper(doc, full, { table: 0, row: 0, col: 1, text: 'x\ny\nz', splitLines: true }), hasCode('BATCH_TOO_LARGE'));
  assert.deepEqual(cellParas(doc, 0, 0, 1), ['', '끝']);
  assert.equal(full.ops.length, 4094);
  assert.throws(() => setCellHelper(doc, newBatch({}), { table: 0, row: 0, col: 1, text: 'a\nb' }),
    /invalid text: U\+000A at codePointIndex=1, utf16Index=1/);
});

test('wp13 #28 invalid text 위치: 본문·칸·찾기·직접 API가 문자와 code point/UTF-16 위치를 보고하고 아무것도 바꾸지 않는다', async t => {
  const doc = await openBytes(t, await buildDoc({ body: ['본문'], table: { rows: 1, cols: 1 }, cells: { '0,0': '칸' } }));
  const b = newBatch({}), body = bodyParas(doc);
  let err;
  assert.throws(() => applyOp(doc, b, 'insertText', { paragraph: 0, text: '가😀\n나' }), e => (err = e, true));
  assert.match(err.message, /^invalid text: U\+000A at codePointIndex=2, utf16Index=3$/);
  assert.equal(err.code, 'TEXT_INVALID');
  assert.deepEqual(err.details, { arg: 'text', codePoint: 'U+000A', codePointIndex: 2, utf16Index: 3 });
  assert.throws(() => applyOp(doc, b, 'setCell', { table: 0, row: 0, col: 0, text: '가\t' }), /invalid text: U\+0009 at codePointIndex=1, utf16Index=1/);
  assert.throws(() => applyOp(doc, b, 'replaceText', { find: 'a\rb', replace: 'x' }), /invalid find: U\+000D at codePointIndex=1, utf16Index=1/);
  assert.throws(() => applyCall(doc, b, 'insertText', [0, 0, 0, '가😀\n나']), e => {
    assert.equal(e.code, 'API_ARGS_INVALID');
    assert.match(e.message, /insertText arg 3 must be one-line string: U\+000A at codePointIndex=2, utf16Index=3/);
    return true;
  });
  assert.equal(b.ops.length, 0);
  assert.deepEqual(bodyParas(doc), body);
  assert.deepEqual(cellParas(doc, 0, 0, 0), ['칸']);
});

async function replaceDoc(t) {
  return openBytes(t, await buildDoc({ body: ['foo foo', 'foo'], table: { rows: 1, cols: 2, after: 1 }, cells: { '0,0': 'foo foo', '0,1': 'foo' } }));
}
test('wp13 #29 replaceText occurrence·scope: n번째만, 지정 문단만, 지정 칸만 바꾼다', async t => {
  let doc = await replaceDoc(t);
  let b = newBatch({});
  const r = applyOp(doc, b, 'replaceText', { find: 'foo', replace: 'X', occurrence: 1 });
  assert.deepEqual(r, { count: 1, matchedCount: 3, positions: [{ section: 0, paragraph: 0, offset: 4, length: 3 }], omitted: 0 });
  assert.deepEqual(bodyParas(doc).slice(0, 2), ['foo X', 'foo']);
  assert.equal(b.ops[0].logical.occurrence, 1);
  assert.deepEqual(cellParas(doc, 0, 0, 0), ['foo foo']);
  doc = await replaceDoc(t); b = newBatch({});
  assert.equal(applyOp(doc, b, 'replaceText', { find: 'foo', replace: 'X', scope: { paragraph: 1 }, expectedCount: 1 }).count, 1);
  assert.deepEqual(bodyParas(doc).slice(0, 2), ['foo foo', 'X']);
  doc = await replaceDoc(t); b = newBatch({});
  const c = applyOp(doc, b, 'replaceText', { find: 'foo', replace: 'X', scope: { table: 0, row: 0, col: 0 }, expectedCount: 2 });
  assert.equal(c.count, 2);
  assert.deepEqual(c.positions[0], { table: 0, row: 0, col: 0, cellParagraph: 0, offset: 0, length: 3 });
  assert.deepEqual(cellParas(doc, 0, 0, 0), ['X X']);
  assert.deepEqual(cellParas(doc, 0, 0, 1), ['foo']);
  assert.deepEqual(bodyParas(doc).slice(0, 2), ['foo foo', 'foo']);
  assert.deepEqual(opNames(b), ['deleteTextInCell', 'insertTextInCell', 'deleteTextInCell', 'insertTextInCell']);
  assert.equal(validateBatch(b), b);
  doc = await replaceDoc(t); b = newBatch({});
  applyOp(doc, b, 'replaceText', { find: 'foo', replace: '', scope: { table: 0, row: 0, col: 1 } });
  assert.deepEqual(cellParas(doc, 0, 0, 1), ['']);
  assert.deepEqual(opNames(b), ['deleteTextInCell']);
  doc = await replaceDoc(t); b = newBatch({});
  assert.equal(applyOp(doc, b, 'replaceText', { find: 'foo', replace: 'Z' }).count, 3); // 기본: 본문 전체, 칸 제외
  assert.deepEqual(bodyParas(doc).slice(0, 2), ['Z Z', 'Z']);
  assert.deepEqual(cellParas(doc, 0, 0, 0), ['foo foo']);
});

test('wp13 #29 replace mismatch: code·좌표 details, batch 0, 칸 좌표 모양', async t => {
  const doc = await replaceDoc(t), b = newBatch({});
  let err;
  assert.throws(() => applyOp(doc, b, 'replaceText', { find: 'foo', replace: 'x', scope: { paragraph: 0 }, expectedCount: 3 }), e => (err = e, true));
  assert.equal(err.code, 'REPLACE_COUNT_MISMATCH');
  assert.ok(err.message.startsWith('replace count mismatch: 2'), err.message);
  assert.deepEqual(err.details, { expectedCount: 3, actualCount: 2, omitted: 0, next: null,
    positions: [{ section: 0, paragraph: 0, offset: 0, length: 3 }, { section: 0, paragraph: 0, offset: 4, length: 3 }] });
  assert.throws(() => applyOp(doc, b, 'replaceText', { find: 'foo', replace: 'x', scope: { paragraph: 0 }, occurrence: 2 }),
    e => { assert.equal(e.details.occurrence, 2); assert.equal(e.details.actualCount, 2); return true; });
  assert.throws(() => applyOp(doc, b, 'replaceText', { find: 'foo', replace: 'x', scope: { table: 0, row: 0, col: 0 }, expectedCount: 5 }),
    e => { assert.deepEqual(e.details.positions[1], { table: 0, row: 0, col: 0, cellParagraph: 0, offset: 4, length: 3 }); return true; });
  assert.equal(b.ops.length, 0);
  assert.deepEqual(bodyParas(doc).slice(0, 2), ['foo foo', 'foo']);
});

test('wp13 R3 takeWithinBytes: 직렬화 크기로 멈추고 최소 1개, limit 우선', async () => {
  const { takeWithinBytes } = await ops();
  const item = { s: 'x'.repeat(192) }; assert.equal(JSON.stringify(item).length, 200);
  const items = Array.from({ length: 10 }, () => item);
  assert.equal(takeWithinBytes(items, 0, 10, 1000).length, 4); // 2 + 4×201 = 806, 다음은 1007 > 1000
  assert.equal(takeWithinBytes([{ s: 'y'.repeat(1500) }], 0, 10, 1000).length, 1);
  assert.equal(takeWithinBytes(items, 0, 3, 100000).length, 3);
  assert.equal(takeWithinBytes(items, 8, 10, 100000).length, 2);
});

test('wp13 R3 scopedHits: 문서 순서(본문 → 표 칸 → 뒤 본문), 문단 scope는 칸 제외, 정규화 위치', async t => {
  const { scopedHits } = await ops();
  const doc = await openBytes(t, await buildDoc({ body: ['foo A', 'foo B'], table: { rows: 1, cols: 2 }, cells: { '0,0': 'foo c00', '0,1': 'foo c01' } }));
  const all = scopedHits(doc, { query: 'foo', caseSensitive: true, scope: null, includeCells: true });
  const strip = ({ _k, ...p }) => p;
  assert.deepEqual(all.hits.map(strip), [{ section: 0, paragraph: 0, offset: 0, length: 3 },
    { table: 0, row: 0, col: 0, cellParagraph: 0, offset: 0, length: 3 }, { table: 0, row: 0, col: 1, cellParagraph: 0, offset: 0, length: 3 },
    { section: 0, paragraph: 4, offset: 0, length: 3 }]);
  assert.equal(all.excluded, 0);
  assert.deepEqual(scopedHits(doc, { query: 'foo', caseSensitive: true, scope: { section: 0, paragraph: 1 }, includeCells: false }).hits.length, 0);
  assert.equal(scopedHits(doc, { query: 'foo', caseSensitive: true, scope: null, includeCells: false }).hits.length, 2);
  assert.deepEqual(scopedHits(doc, { query: 'foo', caseSensitive: true, scope: { table: 0, row: 0, col: 1 }, includeCells: false }).hits.map(strip),
    [{ table: 0, row: 0, col: 1, cellParagraph: 0, offset: 0, length: 3 }]);
});

test('wp13 R4 normalizeFindArgs: 큰 query·모르는 scope 키·틀린 값을 원문 없이 짧게 거절하고 scope를 새 객체로 정규화', async () => {
  const { normalizeFindArgs } = await ops();
  const f = a => () => normalizeFindArgs({ query: 'foo', limit: 10, ...a });
  let e1; assert.throws(f({ query: 'a'.repeat(1001) }), e => (e1 = e, true));
  assert.equal(e1.code, 'INVALID_QUERY'); assert.deepEqual(e1.details, { length: 1001, max: 1000 }); assert.ok(e1.message.length < 120);
  assert.equal(normalizeFindArgs({ query: 'a'.repeat(1000), limit: 10 }).query.length, 1000);
  assert.equal(normalizeFindArgs({ query: '😀'.repeat(1000), limit: 10 }).query.length, 2000);
  assert.throws(f({ query: '\ud800' }), hasCode('INVALID_QUERY'));
  assert.throws(f({ query: 'foo\n' }), e => { assert.equal(e.code, 'INVALID_QUERY'); assert.equal(e.details.codePointIndex, 3); return true; });
  let e2; assert.throws(f({ scope: { table: 0, row: 0, col: 0, pad: 'x'.repeat(60000) } }), e => (e2 = e, true));
  assert.equal(e2.code, 'INVALID_SCOPE'); assert.deepEqual(e2.details.unknownKeys, ['pad']);
  assert.ok(JSON.stringify(e2.details).length < 200 && e2.message.length < 200);
  const seven = Object.fromEntries(['k'.repeat(10000), 'b', 'c', 'd', 'e', 'f', 'g'].map(k => [k, 1]));
  assert.throws(f({ scope: { paragraph: 0, ...seven } }), e => {
    assert.equal(e.details.unknownCount, 7); assert.equal(e.details.unknownKeys.length, 5); assert.equal(e.details.unknownKeys[0].length, 32); return true; });
  for (const scope of [{ table: 0, row: '0', col: 0 }, { paragraph: -1 }, { paragraph: 1.5 }, { table: 0, row: 0, col: 0, paragraph: 0 }, [], 'x'])
    assert.throws(f({ scope }), hasCode('INVALID_SCOPE'), JSON.stringify(scope));
  const input = { paragraph: 2 }, out = normalizeFindArgs({ query: 'foo', scope: input });
  assert.deepEqual(out.scope, { section: 0, paragraph: 2 }); assert.notEqual(out.scope, input);
  assert.throws(f({ maxBytes: 1 }), hasCode('API_ARGS_INVALID'));
  assert.throws(f({ limit: 501 }), hasCode('API_ARGS_INVALID'));
});

test('wp13 R4 findPage: next를 포함한 결과 전체를 예산 안에 넣고 커서가 같은 scoped 순서를 잇는다', async t => {
  const { findPage } = await ops();
  // 010 R4-4의 수치(Q 1000자·30개·6000B)로는 30개가 한 페이지에 다 들어가 next(=Q 반복)가 없다. 결과 전체 예산을 실제로
  // 시험하도록 hit를 늘리고 예산을 줄였다: Q 2000B, 80개, 3000B. 위치만 재는 예산(Revision 3)이면 약 63개 + next.query로 약 5KB가 된다.
  const Q = '😀'.repeat(500), N = 80, MAX = 3000;
  const doc = await openBytes(t, await buildDoc({ body: [(Q + ' ').repeat(N)] }));
  const bytes = v => Buffer.byteLength(JSON.stringify(v));
  for (const scope of [undefined, { section: 0, paragraph: 0 }]) {
    let args = { query: Q, limit: 500, ...(scope ? { scope } : {}) }, seen = new Set(), pages = 0;
    while (args) {
      const page = findPage(doc, args, { maxBytes: MAX });
      assert.ok(bytes(page) <= MAX, `page ${bytes(page)}B`);
      assert.ok(page.count >= 1 && page.count < N, String(page.count));
      if (page.next) { assert.equal(page.next.query, Q); assert.equal(page.next.from, page.from + page.count);
        if (scope) assert.deepEqual(page.next.scope, { section: 0, paragraph: 0 }); }
      for (const p of page.positions) seen.add(JSON.stringify(p));
      args = page.next; pages++;
    }
    assert.equal(seen.size, N); assert.ok(pages > 1);
  }
});
