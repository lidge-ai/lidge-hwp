import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
import { openDocument } from '../lib/rhwp-node.mjs';
import { assertOriginMatrix } from './helpers/origin-matrix.mjs';

const git = promisify(execFile);

async function setup(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'lidge-new-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'docs');
  await mkdir(root);
  await git('git', ['-C', root, 'init', '-q']);
  const server = await createServer({ docsRoot: root, stateDir: join(scratch, 'state'), startAgentSocket: null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { root, base, server };
}
const create = (base, group, name) => fetch(`${base}/api/docs`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({ group, ...(name === undefined ? {} : { name }) }),
});

test('document creation extends the shared Origin matrix', async t => {
  const { root, base } = await setup(t);
  await assertOriginMatrix(origin => fetch(`${base}/api/docs`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin === 'same' ? base : origin } : {}) },
    body: JSON.stringify({ group: { kind: 'default' } }),
  }), 201);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.hwp')), ['새 문서.hwp']);
});

test('blank HWP round trips and commits exactly one path', async t => {
  const { root, base } = await setup(t);
  await mkdir(join(root, 'P'));
  const response = await create(base, { kind: 'project', name: 'P' });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.id, 'P/새 문서.hwp');
  assert.equal(result.format, 'hwp');
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  const bytes = await readFile(join(root, result.id));
  assert.equal(bytes.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
  const doc = await openDocument(bytes);
  try { assert.ok(doc.pageCount() >= 1); assert.ok(JSON.parse(doc.getDocumentInfo())); }
  finally { doc.free(); }
  const { stdout } = await git('git', ['-C', root, '-c', 'core.quotePath=false', 'show', '--format=', '--name-only', 'HEAD']);
  assert.equal(stdout.trim(), result.id);
});

test('automatic names are exclusive under concurrent POST', async t => {
  const { root, base } = await setup(t);
  const responses = await Promise.all([create(base, { kind: 'default' }), create(base, { kind: 'default' })]);
  assert.deepEqual(responses.map(r => r.status), [201, 201]);
  const ids = (await Promise.all(responses.map(r => r.json()))).map(r => r.id).sort();
  assert.deepEqual(ids, ['새 문서 2.hwp', '새 문서.hwp']);
  for (const id of ids) assert.ok((await readFile(join(root, id))).length > 8);
});

test('auto name skips a locked candidate while explicit name remains locked', async t => {
  const { base, server } = await setup(t);
  const token = server.store.lock('새 문서.hwp');
  assert.ok(token);
  t.after(() => token.release());
  const auto = await create(base, { kind: 'default' });
  assert.equal(auto.status, 201);
  assert.equal((await auto.json()).id, '새 문서 2.hwp');
  const named = await create(base, { kind: 'default' }, '새 문서.hwp');
  assert.equal(named.status, 423);
  assert.equal((await named.json()).error.code, 'DOCUMENT_LOCKED');
});

test('explicit name never overwrites and rejects non HWP', async t => {
  const { root, base } = await setup(t);
  assert.equal((await create(base, { kind: 'default' }, 'one.hwp')).status, 201);
  const before = await readFile(join(root, 'one.hwp'));
  const conflict = await create(base, { kind: 'default' }, 'one.hwp');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'DOC_EXISTS');
  for (const name of ['x.hwpx', 'x.txt']) {
    const rejected = await create(base, { kind: 'default' }, name);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, 'INVALID_FORMAT');
  }
  assert.deepEqual(await readFile(join(root, 'one.hwp')), before);
});

test('Origin, group, and content type failures have no file effect', async t => {
  const { root, base } = await setup(t);
  const post = (headers, group) => fetch(`${base}/api/docs`, { method: 'POST', headers,
    body: JSON.stringify({ group }) });
  const noOrigin = await post({ 'Content-Type': 'application/json' }, { kind: 'default' });
  assert.equal(noOrigin.status, 403);
  assert.equal((await noOrigin.json()).error.code, 'BAD_ORIGIN');
  const foreign = await post({ 'Content-Type': 'application/json', Origin: 'http://evil.example' }, { kind: 'default' });
  assert.equal(foreign.status, 403);
  const type = await post({ 'Content-Type': 'text/plain', Origin: base }, { kind: 'default' });
  assert.equal(type.status, 415);
  assert.equal((await type.json()).error.code, 'INVALID_CONTENT_TYPE');
  const group = await create(base, { kind: 'external', key: '123e4567-e89b-42d3-a456-426614174000' });
  assert.equal(group.status, 404);
  assert.equal((await group.json()).error.code, 'ROOT_NOT_FOUND');
  assert.deepEqual((await (await fetch(`${base}/api/docs`)).json()).docs, []);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.hwp')), []);
});

test('commit failure removes new file and staged entry', async t => {
  const { root, base } = await setup(t);
  await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const response = await create(base, { kind: 'default' }, 'doomed.hwp');
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'COMMIT_FAILED');
  await assert.rejects(readFile(join(root, 'doomed.hwp')), { code: 'ENOENT' });
  const { stdout } = await git('git', ['-C', root, 'ls-files', '--stage', '--', 'doomed.hwp']);
  assert.equal(stdout.trim(), '');
});

test('invalid JSON and non-object JSON return 400 without creating files', async t => {
  const { root, base } = await setup(t);
  for (const [payload, code] of [['{"group":', 'INVALID_JSON'], ['[]', 'INVALID_GROUP'], ['null', 'INVALID_GROUP']]) {
    const response = await fetch(`${base}/api/docs`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base }, body: payload });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, code);
  }
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.hwp')), []);
});
