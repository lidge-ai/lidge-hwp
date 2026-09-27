import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { REGISTRY, validateApiCall, canonical, normalizeResult, MAX_BATCH_OPS, CHAR_RULES, PARA_RULES, TABLE_RULES } from '../lib/api-registry.mjs';
import { LIDGE_MUTATE_METHODS, canonical as tsCanonical, normalizeResult as tsNormalize, replayCall } from '../rhwp/rhwp-studio/src/lidge/api-registry.ts';
import { applyCall, applyOp, readApi, newBatch, validateBatch, reserveBatch, sha } from '../lib/ops.mjs';
import { tableAddresses, nestedCellParagraphs } from '../lib/cells.mjs';
import { fallbackPatch } from '../lib/kordoc-fallback.mjs';
import { openDocument } from '../lib/rhwp-node.mjs';

const code = c => e => e.code === c;
test('validateApiCall: 목록 밖·인자 수·타입·객체 키와 값', () => {
  assert.throws(() => validateApiCall('exportHwp', []), code('API_METHOD_DENIED'));
  assert.throws(() => validateApiCall('toString', []), code('API_METHOD_DENIED'));
  assert.throws(() => validateApiCall('applyCharFormat', [0, 0, 0, 1]), code('API_ARGS_INVALID'));
  assert.throws(() => validateApiCall('applyCharFormat', [0, 0, 0, 1, 'x']), code('API_ARGS_INVALID'));
  assert.throws(() => validateApiCall('applyCharFormat', [0, 0, -1, 1, { italic: true }]), code('API_ARGS_INVALID'));
  for (const bad of [{ italics: true }, { italic: 'yes' }, { textColor: 'red' }, {}])
    assert.throws(() => validateApiCall('applyCharFormat', [0, 0, 0, 1, bad]), code('API_ARGS_INVALID'), JSON.stringify(bad));
  assert.throws(() => validateApiCall('applyParaFormat', [0, 0, { alignment: 'middle' }]), code('API_ARGS_INVALID'));
  assert.throws(() => validateApiCall('applyParaFormat', [0, 0, { lineSpacing: 160.5 }]), code('API_ARGS_INVALID'));
  assert.throws(() => validateApiCall('setTableProperties', [0, 0, 0, { cellSpacing: 32768 }]), code('API_ARGS_INVALID'));
  assert.deepEqual(validateApiCall('setTableProperties', [0, 0, 0, { cellSpacing: 32767 }]).args, [0, 0, 0, '{"cellSpacing":32767}']);
  assert.equal(validateApiCall('applyParaFormat', [0, 0, { alignment: 'center', lineSpacing: 160 }]).args[2], '{"alignment":"center","lineSpacing":160}');
  assert.throws(() => validateApiCall('insertText', [0, 0, 0, 'a\nb']), code('API_ARGS_INVALID'));
  assert.equal(validateApiCall('applyCharFormatInCellByPath', [0, 1, [{ controlIndex: 2, cellIndex: 3, cellParaIndex: 4 }], 0, 1, { bold: true }]).args[2],
    '[{"controlIndex":2,"cellIndex":3,"cellParaIndex":4}]');
  assert.throws(() => validateApiCall('applyCharFormatInCellByPath', [0, 1, [{ controlIndex: 2 }], 0, 1, { bold: true }]), code('API_ARGS_INVALID'));
});
test('규칙 표: 키마다 통과 값 하나, 거절 값 하나', () => {
  const pass = { bool: true, color: '#12ab34' };
  for (const [method, rules] of [['applyCharFormat', CHAR_RULES], ['applyParaFormat', PARA_RULES], ['setTableProperties', TABLE_RULES]]) {
    const argsFor = props => method === 'applyCharFormat' ? [0, 0, 0, 1, props] : method === 'applyParaFormat' ? [0, 0, props] : [0, 0, 0, props];
    for (const [key, rule] of Object.entries(rules)) {
      const good = [true, false, 0, 1, 100, 1200, pass.color, 'center', 'Percent', 'Bottom', -5].find(v => rule(v));
      assert.notEqual(good, undefined, `no pass value for ${key}`);
      validateApiCall(method, argsFor({ [key]: good }));
      assert.throws(() => validateApiCall(method, argsFor({ [key]: { nope: 1 } })), code('API_ARGS_INVALID'), key);
    }
  }
});
test('Node와 탭 목록·정규화가 같다', () => {
  const node = Object.entries(REGISTRY).filter(([, e]) => e.mode === 'mutate').map(([n, e]) => [n, e.sig.length]).sort();
  assert.deepEqual(Object.entries(LIDGE_MUTATE_METHODS).sort(), node);
  const v = { b: 1, a: [{ d: 2, c: null }], s: '한글' };
  assert.equal(tsCanonical(v), canonical(v));
  assert.equal(tsNormalize('{"ok":true,"a":1}'), normalizeResult('{"a":1,"ok":true}'));
});
test('replayCall(탭 재생): 반환값이 다르면 RESULT_MISMATCH, 목록 밖·함수 없음도 막는다', () => {
  const hash = s => sha(s);
  const op = { args: { method: 'applyCharFormat', args: [0, 0, 0, 1, '{"italic":true}'] }, resultSha256: sha(normalizeResult('{"ok":true}')) };
  assert.equal(replayCall({ applyCharFormat: () => '{"ok":true}' }, op, hash), '{"ok":true}');
  assert.throws(() => replayCall({ applyCharFormat: () => '{"ok":false}' }, op, hash), code('RESULT_MISMATCH'));
  assert.throws(() => replayCall({}, op, hash), code('API_METHOD_MISSING'));
  assert.throws(() => replayCall({ exportHwp: () => 1 }, { ...op, args: { method: 'exportHwp', args: [] } }, hash), code('API_METHOD_DENIED'));
});
test('fallbackPatch: setCell 하나가 아니면 FALLBACK_UNSUPPORTED_OP', async () => {
  const op = { kind: 'call', logical: { method: 'applyCharFormat' }, resolved: {}, beforeSha256: '0'.repeat(64), args: {} };
  await assert.rejects(fallbackPatch(Buffer.alloc(0), 'hwp', [op]), code('FALLBACK_UNSUPPORTED_OP'));
});
test('reserveBatch: 여러 op를 한꺼번에 재고 4096 경계를 지킨다', () => {
  const b = newBatch({}); b.ops = Array.from({ length: 4000 }, () => ({}));
  const one = { kind: 'replaceText', args: { find: 'a', replace: 'b' } };
  assert.throws(() => reserveBatch(b, Array.from({ length: 97 }, () => one)), code('BATCH_TOO_LARGE'));
  reserveBatch(b, Array.from({ length: 96 }, () => one));
  // replaceText: 가짜 문서의 일치 4097개 → 한 번도 바꾸지 않고 거절
  let replaced = 0;
  const doc = { searchAllText: () => JSON.stringify(Array.from({ length: 4097 }, (_, i) => ({ sec: 0, para: 0, charOffset: i, length: 1 }))),
    getTextRange: () => 'a', replaceText: () => { replaced++; } };
  assert.throws(() => applyOp(doc, newBatch({}), 'replaceText', { find: 'a', replace: 'b' }), code('BATCH_TOO_LARGE'));
  assert.equal(replaced, 0);
});

async function fixtureDoc(t) {
  const fixture = process.env.LIDGE_HWP_SIG_FIXTURE;
  if (!fixture) { t.skip('set LIDGE_HWP_SIG_FIXTURE'); return null; }
  const doc = await openDocument(await readFile(fixture));
  t.after(() => doc.free());
  return doc;
}
const firstText = doc => { for (let p = 0; p < doc.getParagraphCount(0); p++) if (doc.getParagraphLength(0, p) > 1) return p; throw new Error('no text'); };
test('applyCall 실문서: 기록·반환값 해시·실제 서식, 읽기 메서드는 기록 통로로 못 부름', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const p = firstText(doc), batch = newBatch({});
  assert.deepEqual(applyCall(doc, batch, 'applyCharFormat', [0, p, 0, 2, { italic: true }]), { ok: true });
  assert.equal(batch.ops[0].kind, 'call');
  assert.equal(batch.ops[0].resultSha256, sha(normalizeResult('{"ok":true}')));
  assert.equal(JSON.parse(doc.getCharPropertiesAt(0, p, 0)).italic, true);
  assert.equal(validateBatch(batch), batch);
  assert.throws(() => readApi(doc, 'applyCharFormat', [0, p, 0, 2, { bold: true }]), code('API_METHOD_DENIED'));
  assert.throws(() => applyCall(doc, batch, 'getParagraphCount', [0]), code('API_METHOD_DENIED'));
  assert.equal(readApi(doc, 'getParagraphCount', [0]), doc.getParagraphCount(0));
});
test('applyCall 실문서: 서명 밖 대상은 API_TARGET_UNSIGNED', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const batch = newBatch({}), [tbl] = tableAddresses(doc), [nested] = nestedCellParagraphs(doc).cells;
  const nonTable = [...Array(doc.getParagraphCount(0)).keys()].find(p => !tableAddresses(doc).some(a => a.para === p));
  assert.throws(() => applyCall(doc, batch, 'insertTableRow', [0, nonTable, 0, 0, true]), code('API_TARGET_UNSIGNED'));
  const deep = [nested.path[0], nested.path[1], { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }];
  assert.throws(() => applyCall(doc, batch, 'applyCharFormatInCellByPath', [nested.section, nested.para, deep, 0, 0, { bold: true }]), code('API_TARGET_UNSIGNED'));
  const fake = [nested.path[0], { ...nested.path[1], cellIndex: 9999 }];
  assert.throws(() => applyCall(doc, batch, 'applyCharFormatInCellByPath', [nested.section, nested.para, fake, 0, 0, { bold: true }]), code('API_TARGET_UNSIGNED'));
  assert.equal(batch.ops.length, 0);
  applyCall(doc, batch, 'applyCharFormatInCellByPath', [tbl.section, tbl.para, [{ controlIndex: tbl.control, cellIndex: 0, cellParaIndex: 0 }], 0, 0, { bold: true }]);
  applyCall(doc, batch, 'applyCharFormatInCellByPath', [nested.section, nested.para, nested.path, 0, nested.length, { bold: true }]);
  assert.equal(batch.ops.length, 2);
});
test('한도 실문서: 4097번째 호출은 BATCH_TOO_LARGE, 문서는 4096번째에서 멈춘다', async t => {
  const doc = await fixtureDoc(t); if (!doc) return;
  const p = firstText(doc), batch = newBatch({});
  for (let i = 0; i < MAX_BATCH_OPS; i++) applyCall(doc, batch, 'applyCharFormat', [0, p, 0, 1, { bold: i % 2 === 0 }]);
  assert.throws(() => applyCall(doc, batch, 'applyCharFormat', [0, p, 0, 1, { italic: true }]), code('BATCH_TOO_LARGE'));
  assert.equal(batch.ops.length, MAX_BATCH_OPS);
  assert.equal(JSON.parse(doc.getCharPropertiesAt(0, p, 0)).italic, false);
});
test('한도: 8MB 넘는 섞인 batch(applyOp·applyCall, 한글)는 BATCH_TOO_LARGE, 넘친 글은 문서에 안 들어간다', () => {
  // 실문서로 한 문단에 수백만 자를 넣으면 조판이 커져 느리다. 글 길이만 세는 가짜 문서로 크기 계산을 본다.
  let length = 5;
  const doc = { getSectionCount: () => 1, getParagraphCount: () => 1, getParagraphLength: () => length,
    getTextRange: (s, p, o, n) => 'x'.repeat(Math.min(n, 3)), insertText: (s, p, o, t) => { length += t.length; return '{"ok":true}'; } };
  const big = '가'.repeat(10000), batch = newBatch({});
  let n = 0, before = length;
  assert.throws(() => { for (;;) { before = length;
    if (n++ % 2) applyOp(doc, batch, 'insertText', { paragraph: 0, offset: 0, text: big });
    else applyCall(doc, batch, 'insertText', [0, 0, 0, big]); } }, code('BATCH_TOO_LARGE'));
  assert.equal(length, before); // 넘친 op의 글은 들어가지 않았다
  assert.ok(batch.ops.some(o => o.kind === 'call') && batch.ops.some(o => o.kind === 'insertText'));
  const serialized = batch.ops.reduce((s, op) => s + Buffer.byteLength(JSON.stringify(op)), 0);
  assert.ok(Math.abs(serialized - batch.bytes) <= 64 * batch.ops.length, `bytes ${batch.bytes} vs ${serialized}`);
  assert.ok(batch.bytes <= 8 * 1024 * 1024 && batch.bytes > 8 * 1024 * 1024 - 70000);

});

test('MCP 도구 설명: 1500자 이하, help()·selectAll 안내, tools/list가 같은 정의를 낸다', async () => {
  const { TOOL_SPEC } = await import('../mcp/tool.mjs');
  assert.ok(TOOL_SPEC.description.length <= 1500);
  assert.match(TOOL_SPEC.description, /hwp\.help\(\)/); assert.match(TOOL_SPEC.description, /selectAll/);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [new URL('../mcp/server.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'ignore'] });
  const line = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i)); });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  });
  child.kill();
  assert.deepEqual(JSON.parse(line).result.tools, [JSON.parse(JSON.stringify(TOOL_SPEC))]);
});
test('help(): HELPERS가 worker의 도우미 이름을 모두 설명하고 범위 주의를 싣는다', async () => {
  const { HELPERS, apiHelp } = await import('../lib/api-registry.mjs');
  const src = (await readFile(new URL('../server/agent/worker.mjs', import.meta.url), 'utf8'));
  const names = [...src.match(/const names = \[([\s\S]*?)\];/)[1].matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]);
  const described = HELPERS.helpers.join(' ');
  for (const n of names) assert.match(described, new RegExp(`(^|[\\s|'])${n}\\(`), n);
  assert.match(HELPERS.notes.join(' '), /nested one level/);
  const help = apiHelp(HELPERS);
  assert.ok(help.mutate.length >= 30 && help.helpers.length === HELPERS.helpers.length);
});
