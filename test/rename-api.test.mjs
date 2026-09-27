import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../server/index.mjs';
import { indexEntry } from '../lib/persist.mjs';
import { defaultRenameGitOps } from '../lib/rename.mjs';
import { assertOriginMatrix } from './helpers/origin-matrix.mjs';

const run = promisify(execFile);
const HWP = Buffer.from('d0cf11e0a1b11ae100010203', 'hex');
const git = (root, ...args) => run('git', ['-C', root, ...args]);
const idUrl = (base, id) => `${base}/api/docs/${encodeURIComponent(id)}`;

async function setup(t, { files = { 'P/a.hwp': HWP }, tracked = true, renameOps = {} } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'lidge-rename-'));
  const root = join(scratch, 'docs');
  await mkdir(root);
  await git(root, 'init', '-q');
  for (const [id, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, id)), { recursive: true });
    await writeFile(join(root, id), bytes);
  }
  if (tracked) {
    await git(root, 'add', '.');
    await git(root, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'seed');
  }
  const server = await createServer({ docsRoot: root, stateDir: join(scratch, 'state'), startAgentSocket: null, renameOps });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controllers = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  });
  return { scratch, root, server, controllers, base: `http://127.0.0.1:${server.address().port}` };
}

async function claim(f, id, { connect = true } = {}) {
  const response = await fetch(`${f.base}/api/tabs`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId: id }) });
  assert.equal(response.status, 201);
  const { lease } = await response.json();
  const etag = (await fetch(idUrl(f.base, id))).headers.get('etag');
  if (connect) {
    const controller = new AbortController();
    f.controllers.push(controller);
    const events = await fetch(`${f.base}/api/events?lease=${encodeURIComponent(lease)}`, { signal: controller.signal });
    assert.equal(events.status, 200);
    const reader = events.body.getReader();
    let data = '';
    while (!data.includes('event: hello')) data += new TextDecoder().decode((await reader.read()).value);
  }
  return { lease, etag };
}

const requestRename = (f, id, name, { lease, etag }, origin = 'same') => fetch(`${idUrl(f.base, id)}/rename`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lease': lease, 'If-Match': etag,
    ...(origin === null ? {} : { Origin: origin === 'same' ? f.base : origin }) }, body: JSON.stringify({ name }),
});
async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
}
const head = async root => (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
const changedPaths = async root => (await git(root, 'show', '--no-renames', '--format=', '--name-only', 'HEAD')).stdout.trim().split('\n').sort();

test('tracked default rename commits exactly two paths and releases the old lease', async t => {
  const f = await setup(t, { files: { 'P/a.hwp': HWP, 'P/other.hwp': HWP } });
  await writeFile(join(f.root, 'P/other.hwp'), Buffer.concat([HWP, Buffer.from('staged')]));
  await git(f.root, 'add', 'P/other.hwp');
  const otherBefore = await indexEntry({ workTree: f.root, path: 'P/other.hwp' }, 'P/other.hwp');
  const owner = await claim(f, 'P/a.hwp');
  const response = await requestRename(f, 'P/a.hwp', 'b.hwp', owner);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual({ id: result.id, oldId: result.oldId }, { id: 'P/b.hwp', oldId: 'P/a.hwp' });
  assert.match(result.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(await readFile(join(f.root, 'P/b.hwp')), HWP);
  await assert.rejects(readFile(join(f.root, 'P/a.hwp')), { code: 'ENOENT' });
  assert.deepEqual(await changedPaths(f.root), ['P/a.hwp', 'P/b.hwp']);
  assert.equal(await indexEntry({ workTree: f.root, path: 'P/other.hwp' }, 'P/other.hwp'), otherBefore);
  await expectError(await requestRename(f, 'P/b.hwp', 'c.hwp', owner), 409, 'LEASE_REQUIRED');
  assert.equal((await fetch(`${f.base}/api/tabs`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId: 'P/b.hwp' }) })).status, 201);
});

test('untracked default rename commits only the new path', async t => {
  const f = await setup(t, { tracked: false });
  const owner = await claim(f, 'P/a.hwp');
  assert.equal((await requestRename(f, 'P/a.hwp', 'b.hwp', owner)).status, 200);
  assert.deepEqual(await changedPaths(f.root), ['P/b.hwp']);
});

test('rename validates name, format, collision, lease, ETag, and Origin without mutation', async t => {
  const nfd = '새'.normalize('NFD');
  const f = await setup(t, { files: { 'P/a.hwp': HWP, 'P/Other.hwp': HWP, [`P/${nfd}.hwp`]: HWP } });
  const owner = await claim(f, 'P/a.hwp');
  const originalHead = await head(f.root);
  for (const [name, status, code] of [
    ['../x.hwp', 400, 'INVALID_NAME'], ['.hidden.hwp', 400, 'INVALID_NAME'],
    ['x.hwpx', 400, 'FORMAT_MISMATCH'], ['Other.hwp', 409, 'NAME_COLLISION'],
    ['other.hwp', 409, 'NAME_COLLISION'], ['새.hwp', 409, 'NAME_COLLISION'],
    ['a.hwp', 409, 'NAME_COLLISION'],
  ]) await expectError(await requestRename(f, 'P/a.hwp', name, owner), status, code);
  await expectError(await requestRename(f, 'P/a.hwp', 'b.hwp', { ...owner, lease: 'missing' }), 409, 'LEASE_REQUIRED');
  await expectError(await requestRename(f, 'P/a.hwp', 'b.hwp', { ...owner, etag: `"${'0'.repeat(64)}"` }), 412, 'ETAG_MISMATCH');
  await expectError(await requestRename(f, 'P/a.hwp', 'b.hwp', { ...owner, etag: 'bad' }), 400, 'INVALID_ETAG');
  await expectError(await fetch(`${idUrl(f.base, 'P/a.hwp')}/rename`, { method: 'POST',
    headers: { Origin: f.base, 'X-Lease': owner.lease, 'If-Match': owner.etag }, body: JSON.stringify({ name: 'b.hwp', extra: 1 }) }), 400, 'INVALID_NAME');
  assert.equal(await head(f.root), originalHead);
  assert.deepEqual(await readFile(join(f.root, 'P/a.hwp')), HWP);
  await assertOriginMatrix(origin => requestRename(f, 'P/a.hwp', 'b.hwp', owner, origin === undefined ? null : origin), 200);
});

test('SSE hello is required and locks and destination reservations block rename', async t => {
  const f = await setup(t);
  const owner = await claim(f, 'P/a.hwp', { connect: false });
  await expectError(await requestRename(f, 'P/a.hwp', 'b.hwp', owner), 409, 'LEASE_REQUIRED');
  const controller = new AbortController(); f.controllers.push(controller);
  const events = await fetch(`${f.base}/api/events?lease=${owner.lease}`, { signal: controller.signal });
  const reader = events.body.getReader();
  let data = '';
  while (!data.includes('event: hello')) data += new TextDecoder().decode((await reader.read()).value);
  for (const lockedId of ['P/a.hwp', 'P/b.hwp']) {
    const token = f.server.store.lock(lockedId);
    await expectError(await requestRename(f, 'P/a.hwp', 'b.hwp', owner), 423, 'DOCUMENT_LOCKED');
    token.release();
  }
  const reservation = f.server.tabs.reserve('P/b.hwp', 5000);
  if (reservation) {
    await expectError(await requestRename(f, 'P/a.hwp', 'b.hwp', owner), 409, 'DOC_RESERVED');
    f.server.tabs.cancelReservation(reservation);
  }
  assert.equal((await requestRename(f, 'P/a.hwp', 'b.hwp', owner)).status, 200);
});

test('pending agent work and a destination index entry reject rename', async t => {
  const f = await setup(t, { files: { 'P/a.hwp': HWP, 'P/b.hwp': HWP } });
  const owner = await claim(f, 'P/a.hwp');
  const pending = f.server.tabs.requestAgent(owner.lease, 'agent.prepare', {}, 5000);
  pending.catch(() => {});
  await expectError(await requestRename(f, 'P/a.hwp', 'c.hwp', owner), 423, 'AGENT_BUSY');
  f.server.tabs.release(owner.lease);
  await assert.rejects(pending);
  await unlink(join(f.root, 'P/b.hwp'));
  const nextOwner = await claim(f, 'P/a.hwp');
  await expectError(await requestRename(f, 'P/a.hwp', 'b.hwp', nextOwner), 409, 'NAME_COLLISION');
  assert.deepEqual(await readFile(join(f.root, 'P/a.hwp')), HWP);
});

test('NFD parent spelling is preserved for default and external roots', async t => {
  const parent = '한글'.normalize('NFD');
  const f = await setup(t, { files: { [`${parent}/a.hwp`]: HWP } });
  const extra = join(f.scratch, 'external');
  await mkdir(join(extra, parent), { recursive: true });
  await writeFile(join(extra, parent, 'a.hwp'), HWP);
  const { key } = await f.server.store.register(extra);
  for (const [id, root] of [[`${parent}/a.hwp`, f.root], [`ext://${key}/${parent}/a.hwp`, extra]]) {
    const owner = await claim(f, id);
    const response = await requestRename(f, id, 'b.hwp', owner);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const result = await response.json();
    assert.equal(result.id.slice(0, result.id.lastIndexOf('/') + 1), id.slice(0, id.lastIndexOf('/') + 1));
    assert.deepEqual(await readFile(join(root, parent, 'b.hwp')), HWP);
    await assert.rejects(readFile(join(root, parent, 'a.hwp')), { code: 'ENOENT' });
  }
  assert.equal((await readdir(extra)).includes('.git'), false);
});

test('external rename only changes shadow Git history', async t => {
  const f = await setup(t);
  const extra = join(f.scratch, 'external'); await mkdir(extra);
  await writeFile(join(extra, 'old.hwp'), HWP);
  await writeFile(join(extra, 'untouched.txt'), 'keep');
  const { key } = await f.server.store.register(extra);
  const id = `ext://${key}/old.hwp`;
  const baseHead = await head(f.root);
  const owner = await claim(f, id);
  const response = await requestRename(f, id, 'new.hwp', owner);
  assert.equal(response.status, 200);
  assert.deepEqual(await changedPaths(join(f.scratch, 'state', 'history', key)), ['new.hwp']);
  assert.equal(await head(f.root), baseHead);
  assert.deepEqual((await readdir(extra)).sort(), ['new.hwp', 'untouched.txt']);
  assert.deepEqual(await readFile(join(extra, 'new.hwp')), HWP);
  const nextOwner = await claim(f, `ext://${key}/new.hwp`);
  assert.equal((await requestRename(f, `ext://${key}/new.hwp`, 'again.hwp', nextOwner)).status, 200);
  assert.deepEqual(await changedPaths(join(f.scratch, 'state', 'history', key)), ['again.hwp', 'new.hwp']);
});

test('pre-commit failure restores names and exact index snapshots including staged deletions', async t => {
  for (const stagedDeletion of ['old', 'new']) {
    const f = await setup(t, { files: { 'P/a.hwp': HWP,
      ...(stagedDeletion === 'new' ? { 'P/b.hwp': HWP } : {}), 'P/other.hwp': HWP } });
    await writeFile(join(f.root, 'P/other.hwp'), Buffer.concat([HWP, Buffer.from('stage')]));
    await git(f.root, 'add', 'P/other.hwp');
    const deletedPath = stagedDeletion === 'old' ? 'P/a.hwp' : 'P/b.hwp';
    await git(f.root, 'rm', '--cached', '--', deletedPath);
    if (stagedDeletion === 'new') await unlink(join(f.root, deletedPath));
    const oldHistory = { workTree: f.root, path: 'P/a.hwp' };
    const newHistory = { workTree: f.root, path: 'P/b.hwp' };
    const snapshots = [await indexEntry(oldHistory, 'P/a.hwp'), await indexEntry(newHistory, 'P/b.hwp'),
      await indexEntry({ workTree: f.root, path: 'P/other.hwp' }, 'P/other.hwp')];
    const beforeHead = await head(f.root);
    const hook = join(f.root, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o700);
    const owner = await claim(f, 'P/a.hwp');
    await expectError(await requestRename(f, 'P/a.hwp', 'b.hwp', owner), 500, 'COMMIT_FAILED');
    assert.equal(await head(f.root), beforeHead);
    assert.deepEqual(await readFile(join(f.root, 'P/a.hwp')), HWP);
    assert.equal((await readdir(join(f.root, 'P'))).includes('b.hwp'), false);
    assert.deepEqual([await indexEntry(oldHistory, 'P/a.hwp'), await indexEntry(newHistory, 'P/b.hwp'),
      await indexEntry({ workTree: f.root, path: 'P/other.hwp' }, 'P/other.hwp')], snapshots);
    assert.equal(f.server.tabs.owns(owner.lease, 'P/a.hwp'), true);
  }
});

test('post-commit HEAD failure quarantines both ids; PUT, rename, tab claim return 423 before lookup', async t => {
  const f = await setup(t, { renameOps: { gitOps: { commitRename: async (...args) => {
    await defaultRenameGitOps.commitRename(...args);
    throw new Error('post-commit HEAD unavailable');
  } } } });
  const owner = await claim(f, 'P/a.hwp');
  await expectError(await requestRename(f, 'P/a.hwp', 'b.hwp', owner), 500, 'RECOVERY_FAILED');
  await assert.rejects(readFile(join(f.root, 'P/a.hwp')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(f.root, 'P/b.hwp')), HWP);
  assert.equal(f.server.store.isQuarantined('P/a.hwp'), true);
  assert.equal(f.server.store.isQuarantined('P/b.hwp'), true);
  for (const id of ['P/a.hwp', 'P/b.hwp']) {
    await expectError(await fetch(idUrl(f.base, id), { method: 'PUT', body: HWP }), 423, 'DOCUMENT_QUARANTINED');
    await expectError(await requestRename(f, id, 'c.hwp', owner), 423, 'DOCUMENT_QUARANTINED');
    await expectError(await fetch(`${f.base}/api/tabs`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId: id }) }), 423, 'DOCUMENT_QUARANTINED');
  }
});

test('restore failure quarantines both ids', async t => {
  const f = await setup(t, { renameOps: { gitOps: {
    commitRename: async () => { throw new Error('commit failed'); },
    restoreIndex: async () => { throw new Error('restore failed'); },
  } } });
  const owner = await claim(f, 'P/a.hwp');
  await expectError(await requestRename(f, 'P/a.hwp', 'b.hwp', owner), 500, 'RECOVERY_FAILED');
  assert.equal(f.server.store.isQuarantined('P/a.hwp'), true);
  assert.equal(f.server.store.isQuarantined('P/b.hwp'), true);
});
