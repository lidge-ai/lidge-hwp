import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocStore, sha256, matchesFormat, validateProjectName } from '../lib/docstore.mjs';
const HWPX = Buffer.from('504b0304000102030405', 'hex');

test('docstore fences paths and atomically replaces one file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lidge-docstore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'forms'));
  await writeFile(join(root, 'forms', 'a.hwp'), Buffer.from('before'));
  await symlink('/etc/hosts', join(root, 'forms', 'escape.hwp'));
  const store = createDocStore(root);
  assert.deepEqual(await store.list(), [{ id: 'forms/a.hwp', format: 'hwp' }]);
  await assert.rejects(store.read('../hosts'), { code: 'INVALID_ID' });
  await assert.rejects(store.read('forms/escape.hwp'), { code: 'SYMLINK' });
  const before = await store.read('forms/a.hwp');
  await assert.rejects(store.writeAtomic('forms/a.hwp', Buffer.from('bad'), 'wrong'), { code: 'ETAG_MISMATCH' });
  assert.equal((await readFile(join(root, 'forms', 'a.hwp'))).toString(), 'before');
  const result = await store.writeAtomic('forms/a.hwp', Buffer.from('after'), before.sha256);
  assert.equal(result.sha256, sha256(Buffer.from('after')));
  assert.equal((await store.read('forms/a.hwp')).bytes.toString(), 'after');
});

test('matchesFormat checks HWP/HWPX magic bytes', () => {
  assert.equal(matchesFormat(Buffer.from('d0cf11e0a1b11ae100', 'hex'), 'hwp'), true);
  assert.equal(matchesFormat(Buffer.from('504b030400000000', 'hex'), 'hwpx'), true);
  assert.equal(matchesFormat(Buffer.from('504b030400000000', 'hex'), 'hwp'), false);
  assert.equal(matchesFormat(Buffer.from('00', 'hex'), 'hwpx'), false);
});

test('validateProjectName NFC-normalizes and rejects bad names', () => {
  assert.equal(validateProjectName('abc'), 'abc');
  assert.equal(validateProjectName('가'.normalize('NFD')), '가'); // NFD 입력은 NFC로 저장
  for (const bad of ['', ' ', '..', '.', 'a/b', 'a\\b', '.git', 'x\u0001', '가'.repeat(65), ' lead', 'trail ', 5])
    assert.throws(() => validateProjectName(bad), { code: 'INVALID_PROJECT' }, JSON.stringify(bad));
});

test('docstore projects: list, create, import with fences', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lidge-docstore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'b-proj'));
  await mkdir(join(root, '.hidden'));
  await symlink(root, join(root, 'linked'));
  const store = createDocStore(root);
  assert.deepEqual(await store.listProjects(), ['b-proj']);
  assert.equal(await store.createProject('a-proj'), 'a-proj');
  assert.deepEqual(await store.listProjects(), ['a-proj', 'b-proj']);
  await assert.rejects(store.createProject('a-proj'), { code: 'PROJECT_EXISTS' });
  await assert.rejects(store.createProject('a/b'), { code: 'INVALID_PROJECT' });
  const imported = await store.importDocument('a-proj', 'doc.hwpx', HWPX);
  assert.equal(imported.id, 'a-proj/doc.hwpx');
  assert.equal(imported.sha256, sha256(HWPX));
  assert.deepEqual(await store.list(), [{ id: 'a-proj/doc.hwpx', format: 'hwpx' }]);
  await assert.rejects(store.importDocument('a-proj', 'doc.hwpx', HWPX), { code: 'DOC_EXISTS' });
  await assert.rejects(store.importDocument('a-proj', 'x.txt', HWPX), { code: 'INVALID_FORMAT' });
  await assert.rejects(store.importDocument('a-proj', 'bad.hwpx', Buffer.from('junk bytes!')), { code: 'INVALID_BYTES' });
  await assert.rejects(store.importDocument('ghost', 'd.hwpx', HWPX), { code: 'PROJECT_NOT_FOUND' });
  await assert.rejects(store.importDocument('linked', 'd.hwpx', HWPX), { code: 'SYMLINK' });
  await assert.rejects(store.importDocument('a-proj', 'a/b.hwpx', HWPX), { code: 'INVALID_NAME' });
  const token = store.lock('a-proj/held.hwpx');
  await assert.rejects(store.importDocument('a-proj', 'held.hwpx', HWPX), { code: 'DOCUMENT_LOCKED' });
  token.release();
  // 잠금을 놓으면 같은 id로 가져올 수 있다
  assert.equal((await store.importDocument('a-proj', 'held.hwpx', HWPX)).id, 'a-proj/held.hwpx');
});

test('file-name segments allow up to 128 chars, project names up to 64', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lidge-docstore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createDocStore(root);
  await store.createProject('p');
  const longName = '가'.repeat(100) + '.hwpx';
  assert.equal((await store.importDocument('p', longName, HWPX)).id, `p/${longName}`);
  await assert.rejects(store.importDocument('p', '나'.repeat(125) + '.hwp', HWPX), { code: 'INVALID_NAME' }); // 129자는 거부
  await assert.rejects(store.createProject('가'.repeat(65)), { code: 'INVALID_PROJECT' });
});
