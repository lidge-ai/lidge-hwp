import test from 'node:test';
import assert from 'node:assert/strict';
import { isSaveShortcut, bindSaveShortcut } from '../web/shortcuts.mjs';

const key = (props) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: '', code: '', ...props });

test('isSaveShortcut matches Cmd/Ctrl+S including Korean IME and physical key', () => {
  assert.equal(isSaveShortcut(key({ metaKey: true, key: 's', code: 'KeyS' })), true);
  assert.equal(isSaveShortcut(key({ ctrlKey: true, key: 'S', code: 'KeyS' })), true);
  assert.equal(isSaveShortcut(key({ metaKey: true, key: 'ㄴ', code: 'KeyS' })), true);
  assert.equal(isSaveShortcut(key({ metaKey: true, key: 'Process', code: 'KeyS' })), true);
  assert.equal(isSaveShortcut(key({ key: 's', code: 'KeyS' })), false);
  assert.equal(isSaveShortcut(key({ metaKey: true, altKey: true, key: 's', code: 'KeyS' })), false);
  assert.equal(isSaveShortcut(key({ metaKey: true, key: 'p', code: 'KeyP' })), false);
});

test('bindSaveShortcut prevents browser save and calls onSave only for plain Cmd+S', () => {
  let handler; let capture;
  const target = { addEventListener: (type, fn, opt) => { assert.equal(type, 'keydown'); handler = fn; capture = opt; } };
  let saves = 0;
  bindSaveShortcut(target, () => { saves += 1; });
  assert.equal(capture, true);
  const fire = (props) => { const e = key({ ...props, prevented: false, preventDefault() { this.prevented = true; } }); handler(e); return e.prevented; };
  assert.equal(fire({ metaKey: true, key: 's', code: 'KeyS' }), true);
  assert.equal(saves, 1);
  assert.equal(fire({ metaKey: true, shiftKey: true, key: 's', code: 'KeyS' }), true);
  assert.equal(fire({ metaKey: true, repeat: true, key: 's', code: 'KeyS' }), true);
  assert.equal(saves, 1);
  assert.equal(fire({ key: 's', code: 'KeyS' }), false);
  assert.equal(saves, 1);
});
