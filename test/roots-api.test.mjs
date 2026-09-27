import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../server/index.mjs';
import { assertOriginMatrix } from './helpers/origin-matrix.mjs';

const git = promisify(execFile);
const HWPX = Buffer.from('504b0304000102030405', 'hex');

async function fixture(t, pickFolder) {
  const root = await mkdtemp(join(tmpdir(), 'lidge-pick-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = join(root, 'docs'), extra = join(root, 'extra'), stateDir = join(root, 'state');
  await Promise.all([mkdir(docs), mkdir(extra)]);
  await writeFile(join(extra, 'a.hwpx'), HWPX);
  await git('git', ['-C', docs, 'init', '-q']);
  async function start(pick = pickFolder ?? (async () => extra)) {
    const server = await createServer({ docsRoot: docs, stateDir, startAgentSocket: null, pickFolder: pick });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {
      if (!server.listening) return resolve();
      server.close(resolve); server.closeAllConnections();
    }));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  }
  return { root, docs, extra, stateDir, start };
}
const mutate = (base, path, method, origin = 'same') => fetch(base + path, {
  method, headers: origin == null ? {} : { Origin: origin === 'same' ? base : origin },
});

test('pick registers a selected folder, survives restart, and only unregisters files', async t => {
  const f = await fixture(t); const { server, base } = await f.start();
  await assertOriginMatrix(origin => mutate(base, '/api/roots/pick', 'POST', origin === undefined ? null : origin), 201);
  const rows = await (await fetch(base + '/api/docs')).json();
  assert.equal(rows.roots.length, 1);
  const added = rows.roots[0];
  assert.match(added.key, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const actualExtra = await realpath(f.extra);
  assert.equal(added.path, actualExtra); assert.equal(added.label, 'extra'); assert.equal(added.available, true);
  const registryFile = join(f.stateDir, 'roots.json');
  assert.equal((await stat(registryFile)).mode & 0o777, 0o600);
  const disk = JSON.parse(await readFile(registryFile, 'utf8'));
  const identity = await stat(f.extra);
  assert.deepEqual(disk, { version: 1, roots: [{ key: added.key, path: actualExtra, dev: identity.dev, ino: identity.ino }] });
  const history = await server.store.historyFor(`ext://${added.key}/a.hwpx`);
  assert.equal((await stat(history.gitDir)).isDirectory(), true);
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const restarted = await f.start();
  const after = await (await fetch(restarted.base + '/api/docs')).json();
  assert.equal(after.roots[0].key, added.key);
  await assertOriginMatrix(origin => mutate(restarted.base, `/api/roots/${added.key}`, 'DELETE', origin === undefined ? null : origin), 200);
  assert.deepEqual((await (await fetch(restarted.base + '/api/docs')).json()).roots, []);
  assert.deepEqual(await readFile(join(f.extra, 'a.hwpx')), HWPX);
  assert.equal((await stat(history.gitDir)).isDirectory(), true);
});

test('pick cancellation, failure, timeout, and single-flight leave registry unchanged', async t => {
  // 선택기가 불리지 않는 회귀에서 무한 대기하지 않도록 기한을 둔다.
  const waitFor = async (condition, what, ms = 5000) => {
    const end = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  let release, calls = 0;
  const f = await fixture(t, () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const { base } = await f.start();
  const first = mutate(base, '/api/roots/pick', 'POST');
  await waitFor(() => release, 'first picker call');
  const collision = await mutate(base, '/api/roots/pick', 'POST');
  assert.equal(collision.status, 409);
  assert.equal((await collision.json()).error.code, 'PICK_IN_PROGRESS');
  assert.equal(calls, 1);
  release(null);
  const cancelled = await first;
  assert.equal(cancelled.status, 204); assert.equal(await cancelled.text(), '');
  const again = mutate(base, '/api/roots/pick', 'POST');
  await waitFor(() => calls >= 2, 'second picker call');
  release(null);
  assert.equal((await again).status, 204);
  assert.deepEqual((await (await fetch(base + '/api/docs')).json()).roots, []);
  await assert.rejects(readFile(join(f.stateDir, 'roots.json')), { code: 'ENOENT' });
  for (const [status, code] of [[504, 'PICK_TIMEOUT'], [500, 'PICK_FAILED']]) {
    const other = await f.start(async () => { throw Object.assign(new Error(code), { status, code }); });
    const response = await mutate(other.base, '/api/roots/pick', 'POST');
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
});

test('remove validates key, refuses live lease and lock, and preserves registration on failure', async t => {
  const f = await fixture(t); const { server, base } = await f.start();
  const added = (await (await mutate(base, '/api/roots/pick', 'POST')).json()).root;
  const id = `ext://${added.key}/a.hwpx`;
  const invalid = await mutate(base, '/api/roots/NOT-A-UUID', 'DELETE');
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'INVALID_ROOT_KEY');
  const missing = await mutate(base, '/api/roots/22222222-2222-4222-8222-222222222222', 'DELETE');
  assert.equal(missing.status, 404);
  const claim = await fetch(base + '/api/tabs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId: id }) });
  assert.equal(claim.status, 201);
  const lease = (await claim.json()).lease;
  assert.equal((await mutate(base, `/api/roots/${added.key}`, 'DELETE')).status, 423);
  await fetch(base + '/api/tabs/' + lease, { method: 'DELETE' });
  const lock = server.store.lock(id);
  assert.equal((await mutate(base, `/api/roots/${added.key}`, 'DELETE')).status, 423);
  lock.release();
  const reservation = server.tabs.reserve(id, 60_000);
  assert.ok(reservation);
  assert.equal((await mutate(base, `/api/roots/${added.key}`, 'DELETE')).status, 423);
  server.tabs.cancelReservation(reservation);
  assert.equal((await mutate(base, `/api/roots/${added.key}`, 'DELETE')).status, 200);
  await assert.rejects(server.store.resolveId(id), { code: 'ROOT_NOT_FOUND' });
});

test('duplicate and overlapping folders are rejected without changing registration', async t => {
  let selectedPath;
  const f = await fixture(t, async () => selectedPath);
  selectedPath = f.extra;
  const { base } = await f.start();
  const first = await mutate(base, '/api/roots/pick', 'POST');
  assert.equal(first.status, 201);
  const before = await readFile(join(f.stateDir, 'roots.json'));
  await Promise.all([mkdir(join(f.extra, 'nested')), mkdir(join(f.docs, 'nested'))]);
  for (const path of [f.extra, f.root, join(f.extra, 'nested'), f.docs, join(f.docs, 'nested')]) {
    selectedPath = path;
    const overlap = await mutate(base, '/api/roots/pick', 'POST');
    assert.equal(overlap.status, 409, path);
    assert.equal((await overlap.json()).error.code, 'ROOT_OVERLAP');
  }
  assert.deepEqual(await readFile(join(f.stateDir, 'roots.json')), before);
});
