import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, stat, symlink, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../server/index.mjs';

const git = promisify(execFile);

test('GET /path returns only an existing, exactly spelled document path', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'lidge-path-api-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const docs = join(scratch, 'docs');
  await mkdir(docs);
  await git('git', ['-C', docs, 'init', '-q']);
  await writeFile(join(docs, 'a.hwp'), 'document');
  await writeFile(join(docs, '가.hwp'), 'document');
  await mkdir(join(docs, 'sub'));
  await symlink(join(docs, 'a.hwp'), join(docs, 'linked.hwp'));
  await symlink(join(docs, 'sub'), join(docs, 'linked-dir'));
  const server = await createServer({ docsRoot: docs, stateDir: join(scratch, 'state'), startAgentSocket: null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/docs/`;
  const get = id => fetch(`${base}${encodeURIComponent(id)}/path`);
  const expectError = async (response, status, code) => {
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  };

  const ok = await get('a.hwp');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { path: await realpath(join(docs, 'a.hwp')) });
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  await expectError(await get('missing.hwp'), 404, 'NOT_FOUND');
  await expectError(await get('linked.hwp'), 403, 'SYMLINK');
  await expectError(await get('linked-dir/a.hwp'), 403, 'SYMLINK');
  for (const id of ['../etc/hosts', '../x.hwp', 'sub/../a.hwp']) {
    await expectError(await get(id), 400, 'INVALID_ID');
  }
  for (const [alias, original] of [['A.hwp', 'a.hwp'], ['가.hwp', '가.hwp']]) {
    const result = await get(alias);
    const aliased = await stat(join(docs, alias)).then(() => true, () => false);
    if (aliased) await expectError(result, 409, 'PATH_ALIAS');
    else await expectError(result, 404, 'NOT_FOUND');
    assert.notEqual(alias, original);
  }
  await expectError(await fetch(`${base}a.hwp/path`, { method: 'POST' }), 405, 'METHOD_NOT_ALLOWED');
  await unlink(join(docs, 'a.hwp'));
  await expectError(await get('a.hwp'), 404, 'NOT_FOUND');
});
