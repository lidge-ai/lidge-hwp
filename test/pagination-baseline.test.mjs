import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from '../lib/config.mjs';
import { join } from 'node:path';

const expected = [
  ['6a3cdf2c148bf39f', 64, 'a6fff759171192c0', '7798d12ce6052b2c', 56, 0],
  ['d451ffbc72e8c844', 23, 'b3a53b816b25969b', '1c13a88d63ebf2af', 15, 0],
  ['177b93de7c79462b', 1, '7cbf797444cc0529', 'e3d3c6a6cb0deae9', 0, 0],
  ['c58144645069f7d1', 1, 'ded0200ff50b352e', 'b7d2bcc58b43f101', 0, 0],
  ['1c902d41d47e532f', 1, 'ded0200ff50b352e', '3cf6a16c675f33b4', 0, 0],
  ['49f3bd4fc45b9d23', 1, 'ded0200ff50b352e', 'b7d2bcc58b43f101', 0, 0],
  ['888eccf0ff22a9be', 1, '5518c88d715fac59', '76337720a2f495ae', 0, 0],
  ['bb2a140e4dfb1d55', 1, '7cbf797444cc0529', '9147745fdce2d6a6', 0, 0],
];
test('eight untouched pagination fixtures retain their pinned counts, boundaries and page text', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [join(ROOT, 'scripts/pagination-baseline.mjs')],
    { maxBuffer: 1024 * 1024 });
  const rows = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, expected.length);
  rows.forEach((row, i) => assert.deepEqual(
    [row.fileSha, row.wasmPages, row.boundariesSha, row.textSha, row.realResets, row.syntheticResets], expected[i], row.file));
  rows.forEach(row => assert.equal(row.cliPages, row.wasmPages, row.file));
});
