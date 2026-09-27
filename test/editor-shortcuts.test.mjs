import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchHostEvent } from '../web/host-shortcuts.mjs';

test('host v1 events dispatch only their shell action', () => {
  const calls = [];
  const actions = Object.fromEntries(['save', 'rename', 'copyPath', 'newDocument']
    .map(name => [name, () => calls.push(name)]));
  for (const [event, name] of [
    ['lidge.hostSaveRequested', 'save'],
    ['lidge.hostRenameRequested', 'rename'],
    ['lidge.hostCopyPathRequested', 'copyPath'],
    ['lidge.hostNewRequested', 'newDocument'],
  ]) {
    assert.equal(dispatchHostEvent({ event, payload: { schemaVersion: 1 } }, actions), true);
    assert.equal(calls.at(-1), name);
  }
  assert.equal(calls.length, 4);
  assert.equal(dispatchHostEvent({ event: 'lidge.hostNewRequested', payload: { schemaVersion: 2 } }, actions), false);
  assert.equal(dispatchHostEvent({ event: 'lidge.unknown', payload: { schemaVersion: 1 } }, actions), false);
  assert.equal(calls.length, 4);
});
