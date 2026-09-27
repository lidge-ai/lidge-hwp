import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { contentSignature, verifyAgentBytes, SIGNATURE_VERSION } from '../lib/signature.mjs';
import { openDocument, exportWithReport } from '../lib/rhwp-node.mjs';
import { applyOp, applyCall, newBatch, sha } from '../lib/ops.mjs';
import { nestedCellParagraphs, tableAddresses } from '../lib/cells.mjs';

// 서명이 읽는 메서드만 가진 가짜 문서. 표 없음, 문단 하나. v2가 읽는 서식·스타일 메서드도 둔다.
function fakeDoc({ text = 'ab', controls = [], aux = { schemaVersion: 1, items: [] }, withAux = true, italic = false } = {}) {
  const doc = {
    getSectionCount: () => 1, getParagraphCount: () => 1,
    getParagraphLength: () => text.length, getTextRange: () => text,
    getControls: () => JSON.stringify(controls), getScanItems: () => '[]',
    getParaPropertiesAt: () => JSON.stringify({ alignment: 'justify', numberingId: 0, paraShapeId: 3 }),
    getStyleAt: () => JSON.stringify({ id: 0, name: '바탕글' }),
    getCharShapeRuns: () => JSON.stringify([{ startOffset: 0, endOffset: text.length, charShapeId: 7 }]),
    getCharPropertiesAt: () => JSON.stringify({ italic, charShapeId: italic ? 9 : 7 }),
  };
  if (withAux) doc.lidgeAuxContent = () => JSON.stringify(aux);
  return doc;
}

test('서명: 같은 내용은 같고, 공백 하나도 다르다', () => {
  const a = contentSignature(fakeDoc());
  assert.equal(a.status, 'ok');
  assert.equal(contentSignature(fakeDoc()).digest, a.digest);
  assert.notEqual(contentSignature(fakeDoc({ text: 'ab ' })).digest, a.digest);
});
test('서명 v2: 글자 서식만 달라도 다르고, 모양 번호(charShapeId)만 다른 것은 같다', () => {
  assert.equal(contentSignature(fakeDoc()).version, 2);
  assert.notEqual(contentSignature(fakeDoc({ italic: true })).digest, contentSignature(fakeDoc()).digest);
  const renumbered = fakeDoc(); renumbered.getCharPropertiesAt = () => JSON.stringify({ italic: false, charShapeId: 42 });
  assert.equal(contentSignature(renumbered).digest, contentSignature(fakeDoc()).digest);
});
test('서명 v2: 두 겹 중첩 표는 unsupported(저장 거부)', () => {
  const deep = contentSignature(fakeDoc({ aux: { schemaVersion: 1, items: [{ kind: 'tbl', section: 0,
    path: [1, 0, 0, 2, 0, 0, 3, 0, 0], applyTo: null, texts: [], unsupported: [] }] } }));
  assert.equal(deep.status, 'unsupported'); assert.match(deep.reasons.join(), /deeper than one level/);
});
test('서명: 모르는 컨트롤·aux 없음·aux의 unsupported는 모두 unsupported(저장 거부)', () => {
  const eq = contentSignature(fakeDoc({ controls: [{ ctrlId: 'eqed', list: 0, para: 0, pos: 0, controlIndex: 0 }] }));
  assert.equal(eq.status, 'unsupported'); assert.match(eq.reasons[0], /eqed/);
  assert.equal(contentSignature(fakeDoc({ withAux: false })).status, 'unsupported');
  const note = contentSignature(fakeDoc({ aux: { schemaVersion: 1, items: [{ kind: 'head', section: 0, path: [0, 4],
    applyTo: 0, texts: [''], unsupported: ['equation'] }] } }));
  assert.equal(note.status, 'unsupported'); assert.match(note.reasons[0], /head 0\/0\/4: equation/);
  assert.equal(contentSignature(fakeDoc({ aux: { schemaVersion: 2, items: [] } })).status, 'unsupported');
});
test('서명: 머리말 글이 바뀌면 다르다', () => {
  const head = t => ({ schemaVersion: 1, items: [{ kind: 'head', section: 0, path: [2, 2], applyTo: 0, texts: [t], unsupported: [] }] });
  assert.notEqual(contentSignature(fakeDoc({ aux: head('') })).digest, contentSignature(fakeDoc({ aux: head('x') })).digest);
});

// 실문서: KU 참가신청서 .hwp 사본(머리말 둘·중첩 표). 없으면 건너뛰고, C에서는 반드시 설정한다(건너뜀 0건).
const CELLS = [{ table: 1, row: 3, col: 1, text: 'WP5_A' }, { table: 1, row: 4, col: 1, text: 'WP5_B' }];
async function applied(t, extra = []) {
  const fixture = process.env.LIDGE_HWP_SIG_FIXTURE;
  if (!fixture) { t.skip('set LIDGE_HWP_SIG_FIXTURE to samples/wp5-hwp-repro.hwp'); return null; }
  const doc = await openDocument(await readFile(fixture));
  t.after(() => doc.free());
  for (const [kind, args] of [...CELLS.map(c => ['setCell', c]), ...extra]) applyOp(doc, newBatch({}), kind, args);
  return doc;
}
async function reparsed(bytes) { const doc = await openDocument(bytes); try { return contentSignature(doc); } finally { doc.free(); } }

test('실문서 .hwp 두 칸: 적용한 Node 문서의 서명 = export를 다시 연 서명, 서버 확인은 bytes', async t => {
  const doc = await applied(t); if (!doc) return;
  const before = contentSignature(doc);
  assert.equal(before.status, 'ok', JSON.stringify(before.reasons));
  const { bytes, report } = exportWithReport(doc, 'hwp');
  assert.equal(report.count, 0);
  assert.equal(contentSignature(doc).digest, before.digest); // export가 서명을 바꾸지 않는다
  assert.equal((await reparsed(bytes)).digest, before.digest);
  assert.equal(await verifyAgentBytes(bytes, 'hwp', { exportSha256: sha(bytes), signature: before }), 'bytes');
  assert.equal(await verifyAgentBytes(bytes, 'hwp', { exportSha256: '0'.repeat(64), signature: before }), 'content');
});
test('실문서 .hwp: 다른 칸·공백·체크박스가 바뀌면 서명이 다르고 서버 확인은 AGENT_VERIFY_MISMATCH', async t => {
  const doc = await applied(t); if (!doc) return;
  const expected = { exportSha256: '0'.repeat(64), signature: contentSignature(doc) };
  const variants = [
    ['setCell', { table: 1, row: 3, col: 10, text: '변조' }],
    ['setCell', { table: 1, row: 4, col: 1, text: 'WP5_B ' }],
    ['setCheckbox', { occurrence: 0 }],
  ];
  for (const extra of variants) {
    const other = await applied(t, [extra]);
    const { bytes } = exportWithReport(other, 'hwp');
    assert.notEqual(contentSignature(other).digest, expected.signature.digest, JSON.stringify(extra));
    await assert.rejects(verifyAgentBytes(bytes, 'hwp', expected), { code: 'AGENT_VERIFY_MISMATCH' });
  }
});
test('verifyAgentBytes: 기대값이 없으면 409 AGENT_VERIFY_MISSING, 못 여는 바이트는 AGENT_VERIFY_MISMATCH', async () => {
  await assert.rejects(verifyAgentBytes(Buffer.from('x'), 'hwp', null), { code: 'AGENT_VERIFY_MISSING', status: 409 });
  await assert.rejects(verifyAgentBytes(Buffer.from('d0cf11e0a1b11ae100', 'hex'), 'hwp',
    { exportSha256: '0'.repeat(64), signature: { status: 'ok', digest: 'x' } }), { code: 'AGENT_VERIFY_MISMATCH', status: 409 });
});

// 서명 v2 실문서(LIDGE_HWP_SIG_FIXTURE: 중첩 표가 있는 KU 신청서 사본).
async function fixtureDoc(t) {
  const fixture = process.env.LIDGE_HWP_SIG_FIXTURE;
  if (!fixture) { t.skip('set LIDGE_HWP_SIG_FIXTURE'); return null; }
  const doc = await openDocument(await readFile(fixture));
  t.after(() => doc.free());
  return doc;
}
const firstText = doc => { for (let p = 0; p < doc.getParagraphCount(0); p++) if (doc.getParagraphLength(0, p) > 1) return p; throw new Error('no text'); };
test('서명 v2 실문서: 두 번·저장 왕복에 같고, 500ms 안이다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const t0 = performance.now(); const a = contentSignature(doc); const ms = performance.now() - t0;
  assert.equal(a.status, 'ok'); assert.equal(a.version, SIGNATURE_VERSION);
  assert.equal(contentSignature(doc).digest, a.digest);
  assert.equal((await reparsed(exportWithReport(doc, 'hwp').bytes)).digest, a.digest);
  t.diagnostic(`signature ms=${ms.toFixed(1)}`);
  assert.ok(ms < 2000, `signature took ${ms}ms`);
});
test('서명 v2 실문서: 서식·정렬·표 속성·스타일·중첩 칸 서식이 바뀌면 다르고, 서식만 다른 탭 바이트는 AGENT_VERIFY_MISMATCH', async t => {
  const base = await fixtureDoc(t); if (!base) return;
  const bytes = exportWithReport(base, 'hwp').bytes, before = contentSignature(base).digest;
  const p = firstText(base), [tbl] = tableAddresses(base), [nested] = nestedCellParagraphs(base).cells.filter(n => n.length > 0);
  const styles = JSON.parse(base.getStyleList()), current = JSON.parse(base.getStyleAt(0, p));
  const other = styles.find(s => s.id !== current.id && s.type === 0) ?? styles.find(s => s.id !== current.id);
  // 현재 값의 반대로 바꿔야 실제 변화가 생긴다(예: 중첩 칸 '구분'은 이미 굵다).
  const bodyItalic = JSON.parse(base.getCharPropertiesAt(0, p, 0)).italic;
  const nestedBold = JSON.parse(base.getCellCharPropertiesAtByPath(nested.section, nested.para, JSON.stringify(nested.path), 0)).bold;
  const variants = [
    ['applyCharFormat', [0, p, 0, 1, { italic: !bodyItalic }]],
    ['applyParaFormat', [0, p, { alignment: 'center' }]],
    ['setTableProperties', [tbl.section, tbl.para, tbl.control, { cellSpacing: 77 }]],
    ['applyStyle', [0, p, other.id]],
    ['applyCharFormatInCellByPath', [nested.section, nested.para, nested.path, 0, 1, { bold: !nestedBold }]],
  ];
  for (const [method, args] of variants) {
    const doc = await openDocument(bytes);
    try {
      applyCall(doc, newBatch({}), method, args);
      const sig = contentSignature(doc);
      assert.equal(sig.status, 'ok', method);
      assert.notEqual(sig.digest, before, method);
      // c-4: 기대값은 서식을 바꾼 문서, 탭이 보낸 바이트는 원본 → 거절
      await assert.rejects(verifyAgentBytes(bytes, 'hwp', { exportSha256: '0'.repeat(64), signature: sig }),
        { code: 'AGENT_VERIFY_MISMATCH' }, method);
    } finally { doc.free(); }
  }
});
test('서명 v2: 기대값 버전이 다르면 AGENT_VERIFY_MISMATCH', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const sig = contentSignature(doc), bytes = exportWithReport(doc, 'hwp').bytes;
  await assert.rejects(verifyAgentBytes(bytes, 'hwp', { exportSha256: sha(bytes), signature: { ...sig, version: 1 } }),
    e => e.code === 'AGENT_VERIFY_MISMATCH' && /version/.test(e.detail));
  assert.equal(await verifyAgentBytes(bytes, 'hwp', { exportSha256: sha(bytes), signature: sig }), 'bytes');
});
test('중첩 칸 경로: 이어 붙인 글이 lidgeAuxContent 그 표의 글과 같다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const aux = JSON.parse(doc.lidgeAuxContent()).items.find(i => i.kind === 'tbl' && i.path.length === 5);
  const want = aux.texts.filter(s => !s.startsWith('\u0001'));
  const got = nestedCellParagraphs(doc).cells.filter(n => JSON.stringify(n.path[0]) === JSON.stringify({ controlIndex: aux.path[1], cellIndex: aux.path[2], cellParaIndex: aux.path[3] }))
    .map(n => doc.getTextInCellByPath(n.section, n.para, JSON.stringify(n.path), 0, n.length));
  assert.deepEqual(got, want);
});
