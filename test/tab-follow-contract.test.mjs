import test from 'node:test';
import assert from 'node:assert/strict';
import { followCompletion, projectResult } from '../server/agent/runner.mjs';
import { restoreSwitch } from '../web/follow-switch.mjs';
import { HELPERS } from '../lib/api-registry.mjs';
import { TOOL_SPEC } from '../mcp/tool.mjs';

test('(F12) completion distinguishes committed, none and unknown', () => {
  const base = { saved: [], source: { sha256: 'a' }, disk: { sha256: 'a' }, tabConfirmed: true };
  assert.equal(followCompletion(base), 'none');
  assert.equal(followCompletion({ ...base, saved: [{ commit: 'c' }] }), 'committed');
  assert.equal(followCompletion({ ...base, applySave: 'committed' }), 'committed');
  assert.equal(followCompletion({ ...base, applySave: 'pending' }), 'unknown');
  assert.equal(followCompletion({ ...base, disk: { sha256: 'b' } }), 'committed');
  assert.equal(followCompletion({ ...base, diskError: 'EIO' }), 'unknown');
  assert.equal(followCompletion({ ...base, tabConfirmed: false }), 'unknown');
  assert.equal(followCompletion({ ...base, source: null }), 'none');
});

test('(F17) result projection excludes internal lease', () => {
  const result = { ok: true };
  assert.equal(projectResult(result, null), result);
  assert.deepEqual(projectResult(result, { from: 'y', to: 'x', outcome: 'followed', completion: 'none', lease: 'secret', extra: 1 }),
    { ok: true, follow: { from: 'y', to: 'x', outcome: 'followed', completion: 'none' } });
});

test('restore waits for the same lease and reports its own final state', async () => {
  const calls = [];
  const run = values => restoreSwitch({ id: 'y.hwp', expectedLease: 'x', currentLease: values.lease,
    reason: 'save requires an edit', switchTo: async (id, options) => { calls.push([id, options]); return true; },
    say: value => calls.push(value), nameOf: id => id });
  assert.equal(await run({ lease: 'other' }), false);
  assert.deepEqual(calls, []);
  assert.equal(await run({ lease: 'x' }), true);
  assert.deepEqual(calls, [['y.hwp', { restore: { reason: 'save requires an edit' } }]]);
});

test('restore failure names the document left open', async () => {
  const status = [];
  const restored = await restoreSwitch({ id: 'y.hwp', expectedLease: 'x', currentLease: 'x', reason: 'no save',
    switchTo: async () => { throw new Error('DIRTY'); }, say: value => status.push(value),
    currentName: () => 'x.hwp' });
  assert.equal(restored, false);
  assert.deepEqual(status, ['AI 작업이 저장 없이 끝났지만 y.hwp로 돌아가지 못함(DIRTY) · x.hwp에 남습니다']);
});

test('help and tool describe delayed follow and opt-out', () => {
  assert.match(HELPERS.helpers.join(' '), /open\(docId,\{follow\?\}\)/);
  assert.match(HELPERS.notes.join(' '), /follow:false/);
  assert.match(TOOL_SPEC.description, /follow:false/);
});
