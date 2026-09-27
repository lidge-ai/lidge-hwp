import test from 'node:test';
import assert from 'node:assert/strict';
import { copyPath, isCopyPathShortcut } from '../web/copy-path.mjs';

test('copyPath writes the server path and reports success', async () => {
  const messages = [], written = [];
  const ok = await copyPath('ext://key/a.hwp', { request: async url => {
    assert.equal(url, '/api/docs/ext%3A%2F%2Fkey%2Fa.hwp/path');
    return { json: async () => ({ path: '/tmp/docs/a.hwp' }) };
  }, clipboard: { writeText: async value => written.push(value) }, say: text => messages.push(text) });
  assert.equal(ok, true);
  assert.deepEqual(written, ['/tmp/docs/a.hwp']);
  assert.equal(messages.at(-1), '경로 복사됨: /tmp/docs/a.hwp');
});

test('copyPath reports clipboard denial without success', async () => {
  const messages = [];
  const ok = await copyPath('a.hwp', { request: async () => ({ json: async () => ({ path: '/tmp/a.hwp' }) }),
    clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } }, say: text => messages.push(text) });
  assert.equal(ok, false);
  assert.match(messages.at(-1), /경로 복사 실패: NotAllowedError/);
});

test('copyPath with no document does not request or write', async () => {
  const messages = [];
  const ok = await copyPath(null, { request: () => { throw new Error('requested'); },
    clipboard: { writeText: () => { throw new Error('written'); } }, say: text => messages.push(text) });
  assert.equal(ok, false);
  assert.equal(messages.at(-1), '경로를 복사할 문서를 선택하세요.');
});

test('copy shortcut accepts macOS C and rejects composition and modifiers', () => {
  const event = { metaKey: true, shiftKey: true, altKey: false, ctrlKey: false,
    isComposing: false, code: 'KeyC', key: 'ㅊ' };
  assert.equal(isCopyPathShortcut(event), true);
  assert.equal(isCopyPathShortcut({ ...event, altKey: true }), false);
  assert.equal(isCopyPathShortcut({ ...event, isComposing: true }), false);
  assert.equal(isCopyPathShortcut({ ...event, metaKey: false }), false);
});
