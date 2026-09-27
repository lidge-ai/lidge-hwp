import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rename, symlink, stat, rm, chmod, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
import { createRootsRegistry } from '../lib/roots.mjs';
import { createLibrary } from '../lib/library.mjs';
import { createTabs } from '../server/tabs.mjs';
import { runAgent } from '../server/agent/runner.mjs';
import { ROOT } from '../lib/config.mjs';

const git = promisify(execFile);
const HWPX = Buffer.from('504b0304000102030405', 'hex');
const loss = Buffer.from(JSON.stringify({ schemaVersion: 1, outputFormat: 'hwpx', count: 0, losses: [] })).toString('base64');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lidge-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = join(root, 'docs'), extra = join(root, 'extra'), stateDir = join(root, 'state');
  await Promise.all([mkdir(docs), mkdir(extra)]);
  await writeFile(join(docs, 'a.hwpx'), HWPX);
  await writeFile(join(extra, 'a.hwpx'), HWPX);
  await git('git', ['-C', docs, 'init', '-q']);
  await git('git', ['-C', docs, 'add', '--', 'a.hwpx']);
  await git('git', ['-C', docs, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed']);
  const registry = await createRootsRegistry({ docsRoot: docs, stateDir });
  const added = await registry.register(extra);
  const id = `ext://${added.key}/a.hwpx`;
  async function start() {
    const server = await createServer({ docsRoot: docs, stateDir, startAgentSocket: null });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => {
      if (!server.listening) return resolve();
      server.close(resolve); server.closeAllConnections();
    }));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  }
  return { root, docs, extra, stateDir, registry, added, id, start };
}
const docUrl = (base, id) => `${base}/api/docs/${encodeURIComponent(id)}`;
async function putDocument(base, id, bytes) {
  const get = await fetch(docUrl(base, id));
  const claim = await fetch(base + '/api/tabs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId: id }) });
  assert.equal(claim.status, 201);
  const { lease } = await claim.json();
  const put = await fetch(docUrl(base, id), { method: 'PUT', headers: {
    'If-Match': get.headers.get('etag'), 'X-Lease': lease, 'X-Document-Format': 'hwpx',
    'X-Content-Loss-Report': loss,
  }, body: bytes });
  await fetch(base + '/api/tabs/' + lease, { method: 'DELETE' });
  return put;
}

test('library keeps base IDs and lists registered external IDs once', async t => {
  const f = await fixture(t); const { server, base } = await f.start();
  assert.equal((await server.store.resolveId(f.id)).id, f.id);
  const fresh = await server.store.historyForNew(f.added.key, 'fresh.hwp');
  assert.deepEqual(fresh, { workTree: await realpath(f.extra), gitDir: join(f.stateDir, 'history', f.added.key), path: 'fresh.hwp' });
  const listed = await (await fetch(base + '/api/docs')).json();
  assert.deepEqual(listed.docs.map(d => d.id), ['a.hwpx', f.id]);
  assert.deepEqual(listed.projects, []);
  assert.equal(listed.rootsWarning, null);
  assert.deepEqual(listed.roots, [{ key: f.added.key, label: 'extra', path: await realpath(f.extra), available: true }]);
  const opened = await fetch(docUrl(base, f.id));
  assert.equal(opened.status, 200);
  assert.deepEqual(Buffer.from(await opened.arrayBuffer()), HWPX);
});

test('BUG-R7 lock and quarantine survive a temporary external root disappearance', async t => {
  const base = await mkdtemp(join(tmpdir(), 'lidge-roots-r7-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const docs = join(base, 'docs'), ext = join(base, 'ext'), state = join(base, 'state');
  await Promise.all([mkdir(docs), mkdir(ext)]);
  await writeFile(join(ext, 'a.hwpx'), HWPX);
  await git('git', ['-C', docs, 'init', '-q']);
  const lib = await createLibrary({ docsRoot: docs, stateDir: state });
  const added = await lib.register(ext);
  const id = `ext://${added.key}/a.hwpx`;
  const token = lib.lock(id);
  assert.ok(token);
  lib.quarantine(id, 'RECOVERY_FAILED');
  assert.equal(lib.isQuarantined(id), true);
  await rename(ext, ext + '.away');
  assert.equal((await lib.roots()).find(r => r.key === added.key).available, false);
  assert.throws(() => lib.lock(id), /ROOT_UNAVAILABLE/);
  await rename(ext + '.away', ext);
  assert.equal((await lib.roots()).find(r => r.key === added.key).available, true);
  assert.equal(lib.lock(id), null, 'the original lock is still held after the folder came back');
  assert.equal(lib.isQuarantined(id), true, 'quarantine survives the disappearance');
  assert.equal(lib.ownsLock(id, token), true);
  token.release();
});

test('external IDs survive server restart and missing root stays unavailable', async t => {
  const f = await fixture(t); const first = await f.start();
  const before = await (await fetch(first.base + '/api/docs')).json();
  await new Promise(resolve => { first.server.close(resolve); first.server.closeAllConnections(); });
  const second = await f.start();
  assert.deepEqual((await (await fetch(second.base + '/api/docs')).json()).docs, before.docs);
  await rename(f.extra, join(f.root, 'moved'));
  const after = await (await fetch(second.base + '/api/docs')).json();
  assert.equal(after.roots[0].available, false);
  assert.equal(after.roots[0].reason, 'MISSING');
  assert.deepEqual(after.docs.map(d => d.id), ['a.hwpx']);
  const missing = await fetch(docUrl(second.base, f.id));
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'ROOT_UNAVAILABLE');
});

test('registry rejects nested and duplicate real roots', async t => {
  const f = await fixture(t);
  await mkdir(join(f.extra, 'nested'));
  await symlink(f.extra, join(f.root, 'alias'));
  const original = await readFile(join(f.stateDir, 'roots.json'));
  for (const path of [f.docs, f.extra, join(f.extra, 'nested'), f.root, join(f.root, 'alias'), f.stateDir])
    await assert.rejects(f.registry.register(path), { code: 'ROOT_OVERLAP' });
  assert.deepEqual(await readFile(join(f.stateDir, 'roots.json')), original);
  assert.equal((await f.registry.list()).length, 1);
});

test('registry serializes concurrent mutations and rejects invalid saved identity', async t => {
  const f = await fixture(t);
  const second = join(f.root, 'second'), third = join(f.root, 'third');
  await Promise.all([mkdir(second), mkdir(third)]);
  const added = await Promise.all([f.registry.register(second), f.registry.register(third)]);
  const saved = JSON.parse(await readFile(join(f.stateDir, 'roots.json'), 'utf8'));
  assert.equal(saved.roots.length, 3);
  assert.deepEqual(new Set(saved.roots.map(r => r.key)), new Set([f.added.key, ...added.map(r => r.key)]));
  saved.roots[0].ino = 'invalid';
  await writeFile(join(f.stateDir, 'roots.json'), JSON.stringify(saved));
  await assert.rejects(createRootsRegistry({ docsRoot: f.docs, stateDir: f.stateDir }),
    { code: 'ROOTS_INVALID', status: 500 });
});

test('BUG-R1 separate registry instances preserve sequential and concurrent additions', async t => {
  const f = await fixture(t);
  const peer = await createRootsRegistry({ docsRoot: f.docs, stateDir: f.stateDir });
  const folders = ['second', 'third', 'fourth', 'fifth'].map(name => join(f.root, name));
  await Promise.all(folders.map(path => mkdir(path)));
  const first = await f.registry.register(folders[0]);
  const second = await peer.register(folders[1]);
  const [third, fourth] = await Promise.all([
    f.registry.register(folders[2]), peer.register(folders[3]),
  ]);
  const expected = new Set([f.added.key, first.key, second.key, third.key, fourth.key]);
  const disk = JSON.parse(await readFile(join(f.stateDir, 'roots.json'), 'utf8'));
  assert.deepEqual(new Set(disk.roots.map(r => r.key)), expected);
  assert.deepEqual(new Set((await f.registry.list()).map(r => r.key)), expected);
  assert.deepEqual(new Set((await peer.list()).map(r => r.key)), expected);
});

test('BUG-R6 content hash conflict retries the mutation with a fresh snapshot', async t => {
  const f = await fixture(t);
  const next = join(f.root, 'next'); await mkdir(next);
  const file = join(await realpath(f.stateDir), 'roots.json');
  let reads = 0;
  const peer = await createRootsRegistry({ docsRoot: f.docs, stateDir: f.stateDir, fsOps: {
    readFile: async (path, ...args) => {
      const bytes = await readFile(path, ...args);
      if (path === file && ++reads === 3) return Buffer.concat([bytes, Buffer.from(' ')]);
      return bytes;
    },
  } });
  const added = await peer.register(next);
  assert.equal(reads, 5);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(new Set(disk.roots.map(r => r.key)), new Set([f.added.key, added.key]));
});

test('BUG-R6 persistent content hash conflict returns 409 without replacing roots.json', async t => {
  const f = await fixture(t);
  const next = join(f.root, 'next'); await mkdir(next);
  const file = join(await realpath(f.stateDir), 'roots.json');
  const before = await readFile(file);
  let reads = 0;
  const peer = await createRootsRegistry({ docsRoot: f.docs, stateDir: f.stateDir, fsOps: {
    readFile: async (path, ...args) => {
      const bytes = await readFile(path, ...args);
      if (path === file && ++reads >= 3 && reads % 2 === 1)
        return Buffer.concat([bytes, Buffer.from(' ')]);
      return bytes;
    },
  } });
  await assert.rejects(peer.register(next), { code: 'ROOTS_CONFLICT', status: 409 });
  assert.equal(reads, 9);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual((await readdir(f.stateDir)).filter(name => name.endsWith('.tmp')), []);
});

test('BUG-R4 library refreshes peer roots before synchronous lock and save', async t => {
  const f = await fixture(t);
  const next = join(f.root, 'next'); await mkdir(next);
  await writeFile(join(next, 'peer.hwpx'), HWPX);
  const libA = await createLibrary({ docsRoot: f.docs, stateDir: f.stateDir });
  const libB = await createLibrary({ docsRoot: f.docs, stateDir: f.stateDir });
  const added = await libB.register(next);
  const id = `ext://${added.key}/peer.hwpx`;
  const lease = libA.lock(id);
  assert.equal(libA.ownsLock(id, lease), true);
  assert.ok((await libA.list()).some(doc => doc.id === id));
  const before = await libA.read(id);
  assert.deepEqual(before.bytes, HWPX);
  await libA.writeAtomic(id, Buffer.concat([HWPX, Buffer.from('saved')]), before.sha256);
  assert.notDeepEqual(await readFile(join(next, 'peer.hwpx')), HWPX);
});

test('BUG-R6 synchronous lock rejects a root removed by another registry instance', async t => {
  const f = await fixture(t);
  const library = await createLibrary({ docsRoot: f.docs, stateDir: f.stateDir });
  await f.registry.remove(f.added.key);
  assert.throws(() => library.lock(f.id), { code: 'ROOT_NOT_FOUND', status: 404 });
});

test('external listing and opening exclude hidden and symlink paths', async t => {
  const f = await fixture(t);
  await mkdir(join(f.extra, '.hidden'));
  await writeFile(join(f.extra, '.hidden', 'a.hwpx'), HWPX);
  await writeFile(join(f.extra, '.secret.hwpx'), HWPX);
  await symlink(join(f.docs, 'a.hwpx'), join(f.extra, 'link.hwpx'));
  const { base } = await f.start();
  const listed = await (await fetch(base + '/api/docs')).json();
  assert.deepEqual(listed.docs.map(d => d.id), ['a.hwpx', f.id]);
  for (const path of ['.secret.hwpx', '.hidden/a.hwpx', 'link.hwpx']) {
    const response = await fetch(docUrl(base, `ext://${f.added.key}/${path}`));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, path.startsWith('link') ? 'SYMLINK' : 'HIDDEN_PATH');
  }
});

test('external nested symlink is neither listed nor opened', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'x.hwp'), Buffer.from('d0cf11e0a1b11ae100010203', 'hex'));
  await symlink(outside, join(f.extra, 'link'));
  const { base } = await f.start();
  const listed = await (await fetch(base + '/api/docs')).json();
  assert.equal(listed.docs.some(d => d.id.includes('/link/')), false);
  const get = await fetch(docUrl(base, `ext://${f.added.key}/link/x.hwp`));
  assert.equal(get.status, 403);
  assert.equal((await get.json()).error.code, 'SYMLINK');
});

test('external PUT commits only selected path in shadow history', async t => {
  const f = await fixture(t); const { base } = await f.start();
  await writeFile(join(f.extra, 'b.hwpx'), HWPX);
  await writeFile(join(f.extra, 'unrelated.txt'), 'other');
  const baseHead = (await git('git', ['-C', f.docs, 'rev-parse', 'HEAD'])).stdout.trim();
  const changed = Buffer.concat([HWPX, Buffer.from('changed')]);
  const put = await putDocument(base, f.id, changed);
  assert.equal(put.status, 200);
  assert.match((await put.json()).commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(await readFile(join(f.extra, 'a.hwpx')), changed);
  assert.equal((await git('git', ['-C', f.docs, 'rev-parse', 'HEAD'])).stdout.trim(), baseHead);
  assert.equal((await git('git', ['--git-dir', join(f.stateDir, 'history', f.added.key), '--work-tree', f.extra,
    'show', '--format=', '--name-only', 'HEAD'])).stdout.trim(), 'a.hwpx');
  assert.equal((await readdir(f.extra)).includes('.git'), false);
});

test('BUG-R2 literal pathspec commits only the selected document in external and primary roots', async t => {
  const f = await fixture(t); const { base } = await f.start();
  const literal = ':(glob)*.hwpx';
  for (const root of [f.extra, f.docs]) {
    await writeFile(join(root, literal), HWPX);
    await writeFile(join(root, 'other.hwpx'), HWPX);
  }
  for (const [id, root, gitDir] of [
    [`ext://${f.added.key}/${literal}`, f.extra, join(f.stateDir, 'history', f.added.key)],
    [literal, f.docs, null],
  ]) {
    const put = await putDocument(base, id, Buffer.concat([HWPX, Buffer.from('updated')]));
    assert.equal(put.status, 200, await put.text());
    const args = gitDir ? ['--git-dir', gitDir, '--work-tree', root] : ['-C', root];
    assert.equal((await git('git', [...args, 'show', '--format=', '--name-only', 'HEAD'])).stdout.trim(), literal);
    assert.equal((await git('git', [...args, 'ls-files', '--', 'other.hwpx'])).stdout.trim(), '');
  }
});

test('BUG-R3 inherited GIT environment cannot redirect external or primary commits', async t => {
  const f = await fixture(t); const { base, server } = await f.start();
  const extra = join(f.root, 'another'); await mkdir(extra);
  await writeFile(join(extra, 'x.hwpx'), HWPX);
  const hostile = {
    GIT_INDEX_FILE: join(f.root, 'bogus.index'),
    GIT_DIR: join(f.root, 'bogus.git'),
    GIT_WORK_TREE: join(f.root, 'bogus.worktree'),
  };
  const previous = Object.fromEntries(Object.keys(hostile).map(key => [key, process.env[key]]));
  Object.assign(process.env, hostile);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const added = await server.store.register(extra);
  for (const id of [`ext://${added.key}/x.hwpx`, 'a.hwpx']) {
    const put = await putDocument(base, id, Buffer.concat([HWPX, Buffer.from('updated')]));
    assert.equal(put.status, 200, await put.text());
  }
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const shadow = join(f.stateDir, 'history', added.key);
  assert.ok((await stat(join(shadow, 'index'))).isFile());
  assert.equal((await git('git', ['--git-dir', shadow, '--work-tree', extra, 'show', '--format=', '--name-only', 'HEAD'],
    { env: cleanEnv })).stdout.trim(), 'x.hwpx');
  assert.equal((await git('git', ['-C', f.docs, 'show', '--format=', '--name-only', 'HEAD'],
    { env: cleanEnv })).stdout.trim(), 'a.hwpx');
  for (const path of Object.values(hostile)) await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('external commit failure restores bytes and index', async t => {
  const f = await fixture(t); const { base, server } = await f.start();
  const history = await server.store.historyFor(f.id);
  const hook = join(history.gitDir, 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o700);
  const args = ['--git-dir', history.gitDir, '--work-tree', f.extra, 'ls-files', '--stage', '--', 'a.hwpx'];
  const before = (await git('git', args)).stdout;
  const put = await putDocument(base, f.id, Buffer.concat([HWPX, Buffer.from('fail')]));
  assert.equal(put.status, 500);
  assert.deepEqual(await readFile(join(f.extra, 'a.hwpx')), HWPX);
  assert.equal((await git('git', args)).stdout, before);
  assert.equal(server.store.isLocked(f.id), false);
});

test('external unrecoverable rollback quarantines the document', async t => {
  const f = await fixture(t); const { base, server } = await f.start();
  const history = await server.store.historyFor(f.id);
  await writeFile(join(history.gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
  await chmod(join(history.gitDir, 'hooks', 'pre-commit'), 0o700);
  const write = server.store.writeAtomic;
  let calls = 0;
  server.store.writeAtomic = (...args) => ++calls === 2 ? Promise.reject(new Error('rollback denied')) : write(...args);
  const put = await putDocument(base, f.id, Buffer.concat([HWPX, Buffer.from('fail')]));
  assert.equal(put.status, 500);
  assert.equal((await put.json()).error.code, 'RECOVERY_FAILED');
  assert.equal(server.store.isQuarantined(f.id), true);
  assert.equal(server.store.isLocked(f.id), false);
});

test('MCP lists opens and saves an external document', async t => {
  const f = await fixture(t);
  await cp(join(ROOT, 'rhwp', 'samples', 'hwpx', 'ref', 'ref_empty.hwpx'), join(f.extra, 'a.hwpx'));
  const before = await readFile(join(f.extra, 'a.hwpx'));
  const head = (await git('git', ['-C', f.docs, 'rev-parse', 'HEAD'])).stdout.trim();
  const store = await createLibrary({ docsRoot: f.docs, stateDir: f.stateDir });
  const listed = await runAgent({ code: 'return await hwp.docs();' }, { store, tabs: createTabs(), config: {} });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.ok(listed.result.some(d => d.id === f.id));
  const code = `const h=await hwp.open(${JSON.stringify(f.id)}); await hwp.insertText(h,{paragraph:0,text:'외부'}); await hwp.save(h); return true;`;
  const out = await runAgent({ code }, { store, tabs: createTabs(), config: {} });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.saved[0].docId, f.id);
  assert.match(out.saved[0].commit, /^[0-9a-f]{40}$/);
  assert.notDeepEqual(await readFile(join(f.extra, 'a.hwpx')), before);
  assert.equal((await git('git', ['-C', f.docs, 'rev-parse', 'HEAD'])).stdout.trim(), head);
});

test('roots registry reloads disk after post-rename dir sync failure', async t => {
  const f = await fixture(t);
  const second = join(f.root, 'second'); await mkdir(second);
  let failOnce = true;
  const registry = await createRootsRegistry({ docsRoot: f.docs, stateDir: f.stateDir,
    fsOps: { syncDir: async () => { if (failOnce) { failOnce = false; throw new Error('dir sync failed'); } } } });
  await assert.rejects(registry.register(second), /dir sync failed/);
  const disk = JSON.parse(await readFile(join(f.stateDir, 'roots.json'), 'utf8')).roots;
  assert.equal(disk.length, 2);
  assert.deepEqual(await registry.list(), disk.map(r => ({
    key: r.key, label: basename(r.path), path: r.path, available: true,
  })));
  const third = join(f.root, 'third'); await mkdir(third);
  await registry.register(third);
  const after = JSON.parse(await readFile(join(f.stateDir, 'roots.json'), 'utf8')).roots;
  assert.equal(after.length, 3);
  assert.deepEqual(after.slice(0, 2), disk);
});

test('recreated external directory is REPLACED and ext id is unavailable', async t => {
  const f = await fixture(t); const { base } = await f.start();
  const moved = join(f.root, 'extra-original');
  await rename(f.extra, moved);
  try {
    await mkdir(f.extra);
    await writeFile(join(f.extra, 'a.hwpx'), HWPX);
    const roots = await (await fetch(base + '/api/docs')).json();
    assert.equal(roots.roots[0].available, false);
    assert.equal(roots.roots[0].reason, 'REPLACED');
    const get = await fetch(docUrl(base, f.id));
    assert.equal(get.status, 503);
    assert.equal((await get.json()).error.code, 'ROOT_UNAVAILABLE');
  } finally { await Promise.all([rm(f.extra, { recursive: true, force: true }), rm(moved, { recursive: true, force: true })]); }
});

test('shadow save leaves an existing external Git repository untouched', async t => {
  const f = await fixture(t);
  await git('git', ['-C', f.extra, 'init', '-q']);
  await writeFile(join(f.extra, 'tracked.txt'), 'tracked');
  await git('git', ['-C', f.extra, 'add', '--', 'tracked.txt']);
  await git('git', ['-C', f.extra, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed']);
  await writeFile(join(f.extra, 'untracked.txt'), 'untracked');
  const head = (await git('git', ['-C', f.extra, 'rev-parse', 'HEAD'])).stdout.trim();
  const status = (await git('git', ['-C', f.extra, 'status', '--porcelain'])).stdout;
  const metadata = await readdir(join(f.extra, '.git'));
  const { base } = await f.start();
  const put = await putDocument(base, f.id, Buffer.concat([HWPX, Buffer.from('updated')]));
  assert.equal(put.status, 200);
  assert.equal((await git('git', ['--git-dir', join(f.stateDir, 'history', f.added.key), '--work-tree', f.extra,
    'show', '--format=', '--name-only', 'HEAD'])).stdout.trim(), 'a.hwpx');
  assert.equal((await git('git', ['-C', f.extra, 'rev-parse', 'HEAD'])).stdout.trim(), head);
  assert.equal((await git('git', ['-C', f.extra, 'status', '--porcelain'])).stdout, status);
  assert.deepEqual(await readdir(join(f.extra, '.git')), metadata);
});

test('roots.json and state directory have private modes', async t => {
  const f = await fixture(t);
  assert.equal((await stat(f.stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.stateDir, 'roots.json'))).mode & 0o777, 0o600);
});

test('uppercase UUID external id is rejected before root lookup', async t => {
  const f = await fixture(t); const { base } = await f.start();
  const get = await fetch(docUrl(base, `ext://${f.added.key.toUpperCase()}/a.hwpx`));
  assert.equal(get.status, 400);
  assert.equal((await get.json()).error.code, 'INVALID_ID');
});

test('historyForNew normalizes segments and rejects traversal or hidden paths', async t => {
  const f = await fixture(t); const store = await createLibrary({ docsRoot: f.docs, stateDir: f.stateDir });
  assert.equal((await store.historyForNew(f.added.key, 'e\u0301/a.hwp')).path, '\u00e9/a.hwp');
  for (const path of ['../a.hwp', 'x//a.hwp', '.hidden/a.hwp', 'x/../a.hwp'])
    await assert.rejects(store.historyForNew(f.added.key, path), { code: 'INVALID_ID' });
});

test('runner reconciliation handles both unavailable-root failure paths', async t => {
  for (const phase of ['code', 'save']) await t.test(phase, async t => {
    const f = await fixture(t);
    await cp(join(ROOT, 'rhwp', 'samples', 'hwpx', 'ref', 'ref_empty.hwpx'), join(f.extra, 'a.hwpx'));
    const store = await createLibrary({ docsRoot: f.docs, stateDir: f.stateDir });
    const moved = join(f.root, 'moved');
    const code = phase === 'code'
      ? `const h=await hwp.open(${JSON.stringify(f.id)}); await hwp.insertText(h,{paragraph:0,text:'x'}); throw new Error('after-open');`
      : `const h=await hwp.open(${JSON.stringify(f.id)}); await hwp.insertText(h,{paragraph:0,text:'x'}); await hwp.save(h); return true;`;
    const config = phase === 'code' ? {} : { beforeDiskPersist: async () => { await rename(f.extra, moved); } };
    if (phase === 'code') {
      const read = store.read;
      let opened = false;
      store.read = async id => {
        const result = await read(id);
        if (!opened && id === f.id) { opened = true; await rename(f.extra, moved); }
        return result;
      };
    }
    const out = await runAgent({ code }, { store, tabs: createTabs(), config });
    assert.equal(out.ok, false, JSON.stringify(out));
    if (phase === 'code') assert.match(out.error, /after-open/);
    else assert.match(out.error, /ROOT_UNAVAILABLE|NOT_FOUND/);
    assert.equal(out.reconciliation.lastCommit, null);
  });
});

test('default state contains primary docs; state inside docs fails', async t => {
  const state = await mkdtemp(join(tmpdir(), 'lidge-state-parent-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const docs = join(state, 'docs'); await mkdir(docs);
  const store = await createLibrary({ docsRoot: docs, stateDir: state });
  const roots = await store.roots();
  assert.equal(roots.length, 0);
  assert.equal(roots.warning, null);
  await assert.rejects(store.register(state), { code: 'ROOT_OVERLAP', status: 409 });
  const history = join(state, 'history'); await mkdir(history);
  await assert.rejects(store.register(history), { code: 'ROOT_OVERLAP', status: 409 });
  await assert.rejects(createLibrary({ docsRoot: docs, stateDir: docs }), { code: 'STATE_INSIDE_DOCS', status: 400 });
  await assert.rejects(createLibrary({ docsRoot: docs, stateDir: join(docs, 'state') }),
    { code: 'STATE_INSIDE_DOCS', status: 400 });
});

test('existing primary hidden component saves and creates commit', async t => {
  const f = await fixture(t);
  const hidden = join(f.docs, '.archive'); await mkdir(hidden);
  await writeFile(join(hidden, 'a.hwpx'), HWPX);
  const id = '.archive/a.hwpx';
  const { base } = await f.start();
  const put = await putDocument(base, id, Buffer.concat([HWPX, Buffer.from('updated')]));
  assert.equal(put.status, 200);
  assert.equal((await git('git', ['-C', f.docs, 'show', '--format=', '--name-only', 'HEAD'])).stdout.trim(), id);
});

test('failed save plus failed reload poisons mutations until reload succeeds', async t => {
  const f = await fixture(t);
  const second = join(f.root, 'second'); await mkdir(second);
  const third = join(f.root, 'third'); await mkdir(third);
  let failSync = true, failRead = false;
  const registry = await createRootsRegistry({ docsRoot: f.docs, stateDir: f.stateDir, fsOps: {
    syncDir: async () => { if (failSync) { failSync = false; failRead = true; throw new Error('sync failed'); } },
    readFile: async (...args) => { if (failRead) throw new Error('reload failed'); return readFile(...args); },
  } });
  await assert.rejects(registry.register(second), { code: 'ROOTS_RELOAD_FAILED', status: 503 });
  const stale = await registry.list();
  assert.equal(stale.warning, 'ROOTS_RELOAD_FAILED');
  assert.deepEqual(stale.map(r => r.key), [f.added.key]);
  await assert.rejects(registry.register(third), { code: 'ROOTS_RELOAD_FAILED', status: 503 });
  await assert.rejects(registry.remove(f.added.key), { code: 'ROOTS_RELOAD_FAILED', status: 503 });
  failRead = false;
  const loaded = await registry.reload();
  assert.equal(loaded.warning, null);
  assert.equal(loaded.length, 2);
  await registry.register(third);
  assert.equal((await registry.list()).length, 3);
});
