import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../server/index.mjs';
const git = promisify(execFile);
const HWPX = Buffer.from('504b0304000102030405', 'hex');

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'lidge-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = join(root, 'docs');
  await mkdir(docs);
  await git('git', ['-C', docs, 'init', '-q']);
  const server = await createServer({ docsRoot: docs, stateDir: join(root, 'state'),
    buildDir: join(root, 'build'), startAgentSocket: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { docs, base: 'http://127.0.0.1:' + server.address().port };
}
const post = (base, path, options = {}) => fetch(base + path, { method: 'POST', ...options });
const importDoc = (base, project, name, bytes, headers = {}) => post(base,
  `/api/projects/${encodeURIComponent(project)}/docs`, {
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), ...headers },
    body: bytes,
  });

test('POST /api/projects creates a project, rejects duplicates and bad names', async (t) => {
  const { base } = await setup(t);
  const json = (name) => post(base, '/api/projects', {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  const created = await json('새프로젝트');
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { project: '새프로젝트' });
  assert.equal((await json('새프로젝트')).status, 409);
  for (const bad of ['', '..', 'a/b', '.hidden', '.git', 'x\u0001', '가'.repeat(65), ' lead', 'trail ']) {
    const res = await json(bad);
    assert.equal(res.status, 400, `name ${JSON.stringify(bad)}`);
    assert.equal((await res.json()).error.code, 'INVALID_PROJECT');
  }
  const listed = await (await fetch(base + '/api/docs')).json();
  assert.deepEqual(listed.projects, ['새프로젝트']); // 빈 프로젝트도 목록에 나온다
});

test('POST /api/projects/<name>/docs imports bytes, commits, and rejects bad inputs', async (t) => {
  const { docs, base } = await setup(t);
  const json = (name) => post(base, '/api/projects', {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  await json('proj');
  const ok = await importDoc(base, 'proj', 'a.hwpx', HWPX);
  assert.equal(ok.status, 201);
  const saved = await ok.json();
  assert.equal(saved.id, 'proj/a.hwpx');
  assert.equal(saved.format, 'hwpx');
  assert.equal((await readFile(join(docs, 'proj', 'a.hwpx'))).equals(HWPX), true);
  const { stdout } = await git('git', ['-C', docs, 'log', '-1', '--format=%s']);
  assert.equal(stdout.trim(), 'Add proj/a.hwpx');
  const status = await git('git', ['-C', docs, 'status', '--porcelain', '--', 'proj/a.hwpx']);
  assert.equal(status.stdout.trim(), '');
  const listing = await (await fetch(base + '/api/docs')).json();
  assert.deepEqual(listing.docs, [{ id: 'proj/a.hwpx', format: 'hwpx' }]);
  assert.equal((await importDoc(base, 'proj', 'a.hwpx', HWPX)).status, 409); // DOC_EXISTS
  assert.equal((await importDoc(base, 'proj', 'b.txt', HWPX)).status, 400); // INVALID_FORMAT
  assert.equal((await importDoc(base, 'proj', 'b.hwpx', Buffer.from('not a zip file'))).status, 400); // INVALID_BYTES
  assert.equal((await importDoc(base, 'ghost', 'c.hwpx', HWPX)).status, 404); // PROJECT_NOT_FOUND
});

test('import into a symlinked project is refused and cross-origin POST is 403', async (t) => {
  const { docs, base } = await setup(t);
  const outside = join(docs, '..', 'outside');
  await mkdir(outside);
  await symlink(outside, join(docs, 'linked'));
  const res = await importDoc(base, 'linked', 'a.hwpx', HWPX);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'SYMLINK');
  const cross = await post(base, '/api/projects', {
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ name: 'x' }) });
  assert.equal(cross.status, 403);
  assert.equal((await cross.json()).error.code, 'BAD_ORIGIN');
});

test('import rolls back file and index when the commit fails', async (t) => {
  const { docs, base } = await setup(t);
  await post(base, '/api/projects', { headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'proj' }) });
  // pre-commit 훅을 실패시켜 commitFile이 깨지게 한다.
  await writeFile(join(docs, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const res = await importDoc(base, 'proj', 'doomed.hwpx', HWPX);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'COMMIT_FAILED');
  await assert.rejects(readFile(join(docs, 'proj', 'doomed.hwpx')), { code: 'ENOENT' });
  const { stdout } = await git('git', ['-C', docs, 'status', '--porcelain']);
  assert.equal(stdout.trim(), ''); // staged 파일도 남지 않는다
});

test('import holds the document lock through commit, and a commit failure restores file and index', async (t) => {
  const { docs, base } = await setup(t);
  await post(base, '/api/projects', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'proj' }) });
  const hook = join(docs, '.git', 'hooks', 'pre-commit');
  // 느린 커밋: 커밋 중에는 같은 문서의 탭 임대가 423이어야 한다(잠금이 커밋 끝까지 유지됨).
  // 훅이 표식 파일을 만든 뒤(=커밋 단계 진입) 임대를 시도한다. 고정 대기에 기대지 않는다.
  const marker = join(docs, '.git', 'hook-entered');
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nsleep 2\n`, { mode: 0o755 });
  const pending = importDoc(base, 'proj', 'slow.hwpx', HWPX);
  for (let i = 0; i < 100; i++) {
    if (await readFile(marker).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await readFile(marker); // 훅에 들어오지 못했으면 여기서 실패한다
  const claim = await post(base, '/api/tabs', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId: 'proj/slow.hwpx' }) });
  assert.equal(claim.status, 423);
  assert.equal((await pending).status, 201);
  // 실패하는 커밋: 500 COMMIT_FAILED, 파일 없음, index에 없음, 고친 뒤 다시 가져오기 가능.
  await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const failed = await importDoc(base, 'proj', 'b.hwpx', HWPX);
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error.code, 'COMMIT_FAILED');
  await assert.rejects(readFile(join(docs, 'proj', 'b.hwpx')), { code: 'ENOENT' });
  const staged = await git('git', ['-C', docs, 'ls-files', '--stage', '--', 'proj/b.hwpx']);
  assert.equal(staged.stdout.trim(), '');
  await rm(hook);
  assert.equal((await importDoc(base, 'proj', 'b.hwpx', HWPX)).status, 201);
});

test('commit failure on a path already tracked restores its original index entry', async (t) => {
  const { docs, base } = await setup(t);
  await post(base, '/api/projects', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'proj' }) });
  assert.equal((await importDoc(base, 'proj', 't.hwpx', HWPX)).status, 201);
  await rm(join(docs, 'proj', 't.hwpx')); // 작업트리에서만 지움(추적은 그대로)
  const before = (await git('git', ['-C', docs, 'ls-files', '--stage', '--', 'proj/t.hwpx'])).stdout;
  assert.notEqual(before.trim(), '');
  const hook = join(docs, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const failed = await importDoc(base, 'proj', 't.hwpx', Buffer.concat([HWPX, Buffer.from('new')]));
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error.code, 'COMMIT_FAILED');
  const after = (await git('git', ['-C', docs, 'ls-files', '--stage', '--', 'proj/t.hwpx'])).stdout;
  assert.equal(after, before); // 원래 index 항목 그대로(staged deletion 없음)
  const status = (await git('git', ['-C', docs, 'status', '--porcelain', '--', 'proj/t.hwpx'])).stdout;
  assert.equal(status.trim(), 'D proj/t.hwpx'); // 작업트리 삭제만 남는다
});

test('import quarantines the document when failure recovery cannot be confirmed', async (t) => {
  const { docs } = await setup(t);
  const { createDocStore } = await import('../lib/docstore.mjs');
  const store = createDocStore(docs);
  await store.createProject('proj');
  await assert.rejects(store.importDocument('proj', 'q.hwpx', HWPX, {
    commit: async () => { throw new Error('commit boom'); },
    indexSnapshot: async () => '',
    indexRestore: async () => { throw new Error('restore boom'); },
  }), { code: 'RECOVERY_FAILED' });
  assert.equal(store.isQuarantined('proj/q.hwpx'), true);
  assert.equal(store.isLocked('proj/q.hwpx'), false); // 잠금은 풀리고 격리로 막는다
  await assert.rejects(store.importDocument('proj', 'q.hwpx', HWPX), { code: 'DOCUMENT_QUARANTINED' });
});

test('import rejects a project directory that is a symlink out of the docs root', async (t) => {
  const { docs, base } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'lidge-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(docs, 'linked'));
  const res = await importDoc(base, 'linked', 'x.hwpx', HWPX);
  assert.equal(res.status, 403);
  await assert.rejects(readFile(join(outside, 'x.hwpx')), { code: 'ENOENT' });
});

test('exclusive create flags refuse a path through a symlinked directory (darwin O_NOFOLLOW_ANY)', { skip: process.platform !== 'darwin' && 'darwin only' }, async (t) => {
  const { createExclusiveFlags } = await import('../lib/docstore.mjs');
  const { open } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'lidge-nofollow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'real'));
  await symlink(join(root, 'real'), join(root, 'link'));
  await assert.rejects(open(join(root, 'link', 'x.hwpx'), createExclusiveFlags('darwin'), 0o600), { code: 'ELOOP' });
  await assert.rejects(readFile(join(root, 'real', 'x.hwpx')), { code: 'ENOENT' });
});

test('commit failure keeps a user\'s staged deletion (empty index snapshot is not reset from HEAD)', async (t) => {
  const { docs, base } = await setup(t);
  await post(base, '/api/projects', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'proj' }) });
  assert.equal((await importDoc(base, 'proj', 'd.hwpx', HWPX)).status, 201);
  assert.equal((await importDoc(base, 'proj', 'keep.hwpx', HWPX)).status, 201); // 폴더가 비지 않게
  await git('git', ['-C', docs, 'rm', '-q', '--', 'proj/d.hwpx']); // staged deletion
  const hook = join(docs, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const failed = await importDoc(base, 'proj', 'd.hwpx', HWPX);
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error.code, 'COMMIT_FAILED');
  const staged = (await git('git', ['-C', docs, 'ls-files', '--stage', '--', 'proj/d.hwpx'])).stdout;
  assert.equal(staged, '');
  const status = (await git('git', ['-C', docs, 'status', '--porcelain', '--', 'proj/d.hwpx'])).stdout;
  assert.equal(status.trim(), 'D  proj/d.hwpx'.trim()); // staged deletion 그대로
});

test('cleanup never unlinks through a project dir swapped to an outside symlink', async (t) => {
  const { docs } = await setup(t);
  const { createDocStore } = await import('../lib/docstore.mjs');
  const { rename } = await import('node:fs/promises');
  const store = createDocStore(docs);
  await store.createProject('proj');
  const outside = await mkdtemp(join(tmpdir(), 'lidge-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'q.hwpx'), 'outside-keep');
  await assert.rejects(store.importDocument('proj', 'q.hwpx', HWPX, {
    commit: async () => {
      await rename(join(docs, 'proj'), join(docs, 'proj-moved'));
      await symlink(outside, join(docs, 'proj'));
      throw new Error('commit boom');
    },
    indexSnapshot: async () => '',
    indexRestore: async () => {},
  }), { code: 'RECOVERY_FAILED' });
  assert.equal((await readFile(join(outside, 'q.hwpx'), 'utf8')), 'outside-keep'); // 밖 파일은 그대로
  assert.equal(store.isQuarantined('proj/q.hwpx'), true);
});
