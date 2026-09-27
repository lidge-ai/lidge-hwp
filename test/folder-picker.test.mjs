import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFolder, PICK_SCRIPT } from '../lib/folder-picker.mjs';

test('picker invokes fixed osascript without a shell and preserves trailing spaces', async () => {
  const calls = [];
  const picked = await pickFolder({ timeoutMs: 1234, execFileImpl: (...args) => {
    calls.push(args.slice(0, 3)); args[3](null, '/tmp/끝에 공백 \n', '');
  } });
  assert.deepEqual(calls, [['/usr/bin/osascript', ['-e', PICK_SCRIPT], { timeout: 1234, maxBuffer: 64 * 1024 }]]);
  assert.equal(picked, '/tmp/끝에 공백 ');
});

test('picker maps only macOS cancellation to null', async () => {
  const result = await pickFolder({ execFileImpl: (_bin, _args, _options, done) =>
    done(Object.assign(new Error('cancel'), { code: 1 }), '', 'execution error: User canceled. (-128)') });
  assert.equal(result, null);
});

test('picker maps killed to timeout and other failures or empty output to PICK_FAILED', async () => {
  const run = (error, stdout = '', stderr = '') => pickFolder({ execFileImpl: (_bin, _args, _options, done) => done(error, stdout, stderr) });
  await assert.rejects(run(Object.assign(new Error('killed'), { killed: true })), { status: 504, code: 'PICK_TIMEOUT' });
  await assert.rejects(run(new Error('failed')), { status: 500, code: 'PICK_FAILED' });
  await assert.rejects(run(null), { status: 500, code: 'PICK_FAILED' });
});
