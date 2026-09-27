import test from 'node:test';
import assert from 'node:assert/strict';
import { shellShortcutDecision, shellShortcutKey } from '../web/shell-shortcuts.mjs';

const base = { key: '', code: '', metaKey: false, ctrlKey: false,
  altKey: false, shiftKey: false, isComposing: false };
const keys = [
  [{ key: 'Process', code: 'KeyC', metaKey: true, shiftKey: true }, 'copyPath'],
  [{ key: 'R', code: 'KeyR', metaKey: true, shiftKey: true }, 'rename'],
  [{ key: 'F2', code: 'F2' }, 'rename'],
  [{ key: 'Dead', code: 'KeyN', metaKey: true, altKey: true }, 'newDocument'],
  [{ key: 'n', code: 'KeyN', metaKey: true }, 'newDocument'],
];
const target = selector => ({ closest: query => query.includes(selector) ? {} : null });

test('shell blocks its keys inside protected inputs and dialogs', () => {
  for (const [input] of keys) {
    const event = { ...base, ...input };
    assert.deepEqual(shellShortcutDecision(event, target('.rename-input')),
      { prevent: true, action: null });
    assert.deepEqual(shellShortcutDecision(event, target('.new-doc-row input')),
      { prevent: true, action: null });
    assert.deepEqual(shellShortcutDecision(event, target('dialog[open]')),
      { prevent: true, action: null });
  }
});

test('shell actions run from row buttons, search input, and body', () => {
  for (const [input, action] of keys) {
    const event = { ...base, ...input };
    assert.equal(shellShortcutKey(event), action);
    for (const focus of [target('.doc'), target('#doc-filter'), target('body')]) {
      assert.deepEqual(shellShortcutDecision(event, focus), { prevent: true, action });
    }
  }
});

test('composition prevents browser action without running a shell action', () => {
  for (const [input] of keys) {
    assert.deepEqual(shellShortcutDecision({ ...base, ...input, isComposing: true }, target('body')),
      { prevent: true, action: null });
  }
});

test('unowned modifier combinations remain untouched', () => {
  for (const event of [
    { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true, altKey: true },
    { key: 'R', code: 'KeyR', metaKey: true },
    { key: 'F2', code: 'F2', shiftKey: true },
    { key: 'N', code: 'KeyN', metaKey: true, ctrlKey: true },
  ]) assert.deepEqual(shellShortcutDecision({ ...base, ...event }, target('body')),
    { prevent: false, action: null });
});
