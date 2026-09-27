import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
const run = promisify(execFile);
const HWP = Buffer.from('d0cf11e0a1b11ae100010203', 'hex');
const HWPX = Buffer.from('504b0304000102030405', 'hex');
const report = (format, count = 0) => Buffer.from(JSON.stringify({ schemaVersion: 1,
  outputFormat: format, count, losses: count ? [{}] : [] })).toString('base64');

test('API commits exact HWP and HWPX paths and rejects stale/lossy saves', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lidge-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.hwp'), HWP);
  await writeFile(join(root, 'b.hwpx'), HWPX);
  await run('git', ['-C', root, 'init', '-q']);
  const server = await createServer({ docsRoot: root, startAgentSocket: null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const docs = await (await fetch(`${base}/api/docs`)).json();
  assert.deepEqual(docs.docs.map((d) => d.id), ['a.hwp', 'b.hwpx']);
  for (const [id, format, original] of [['a.hwp', 'hwp', HWP], ['b.hwpx', 'hwpx', HWPX]]) {
    const get = await fetch(`${base}/api/docs/${id}`);
    assert.equal(get.status, 200);
    const etag = get.headers.get('etag');
    const leaseRes = await fetch(`${base}/api/tabs`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId: id }) });
    assert.equal(leaseRes.status, 201);
    const { lease } = await leaseRes.json();
    const changed = Buffer.concat([original, Buffer.from('changed')]);
    const headers = { 'If-Match': etag, 'X-Lease': lease,
      'X-Document-Format': format, 'X-Content-Loss-Report': report(format) };
    const token = server.store.lock(id);
    const locked = await fetch(`${base}/api/docs/${id}`, { method: 'PUT', headers, body: changed });
    assert.equal(locked.status, 423);
    token.release();
    const lossy = await fetch(`${base}/api/docs/${id}`, { method: 'PUT', headers: {
      ...headers, 'X-Content-Loss-Report': report(format, 1) }, body: changed });
    assert.equal(lossy.status, 422);
    const saved = await fetch(`${base}/api/docs/${id}`, { method: 'PUT', headers, body: changed });
    assert.equal(saved.status, 200);
    const result = await saved.json();
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(await readFile(join(root, id)), changed);
    const { stdout } = await run('git', ['-C', root, 'show', '--format=', '--name-only', 'HEAD']);
    assert.equal(stdout.trim(), id);
    const stale = await fetch(`${base}/api/docs/${id}`, { method: 'PUT', headers, body: changed });
    assert.equal(stale.status, 412);
    if (id === 'b.hwpx') {
      const headBefore = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
      const noOp = await fetch(`${base}/api/docs/${id}`, { method: 'PUT',
        headers: { ...headers, 'If-Match': `"${result.sha256}"` }, body: changed });
      assert.equal(noOp.status, 200);
      assert.notEqual((await noOp.json()).commit, headBefore);
      const hook = join(root, '.git', 'hooks', 'pre-commit');
      const staged = Buffer.concat([changed, Buffer.from('staged')]);
      await writeFile(join(root, id), staged);
      await run('git', ['-C', root, 'add', '--', id]);
      await writeFile(join(root, id), changed);
      const indexBefore = (await run('git', ['-C', root, 'ls-files', '-s', '--', id])).stdout;
      await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o700);
      const rejected = await fetch(`${base}/api/docs/${id}`, { method: 'PUT',
        headers: { ...headers, 'If-Match': `"${result.sha256}"` },
        body: Buffer.concat([changed, Buffer.from('next')]) });
      assert.equal(rejected.status, 500);
      assert.deepEqual(await readFile(join(root, id)), changed);
      assert.equal((await run('git', ['-C', root, 'ls-files', '-s', '--', id])).stdout, indexBefore);
    }
    await fetch(`${base}/api/tabs/${lease}`, { method: 'DELETE' });
  }
});
