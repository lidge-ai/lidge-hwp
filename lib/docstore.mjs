import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, constants as fsConstants } from 'node:fs';
import { readdir, realpath, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };

// 새 문서 파일을 만든다(덮어쓰지 않음). macOS에서는 O_NOFOLLOW_ANY로 경로 어디에서도 심볼릭 링크를
// 따라가지 않으므로, 확인 뒤 디렉터리가 링크로 바뀌어도 문서함 밖에 만들지 않고 ELOOP로 실패한다.
const O_NOFOLLOW_ANY = 0x20000000; // <sys/fcntl.h> (Darwin). Node 상수에는 아직 없다.
export function createExclusiveFlags(platform = process.platform) {
  const { O_CREAT, O_EXCL, O_WRONLY, O_NOFOLLOW } = fsConstants;
  return O_CREAT | O_EXCL | O_WRONLY | (platform === 'darwin' ? O_NOFOLLOW_ANY : O_NOFOLLOW);
}

// HWP는 CFB 시그니처, HWPX는 ZIP 시그니처. PUT·가져오기 양쪽이 같은 판정을 쓴다.
export function matchesFormat(bytes, format) {
  if (bytes.length < 8) return false;
  const hwp = bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  const hwpx = bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
  return format === 'hwp' ? hwp : hwpx;
}

// 한 경로 조각(프로젝트명·파일명): NFC 정규화해 돌려준다.
export function validateSegment(name, code = 'INVALID_NAME', max = 128) {
  if (typeof name !== 'string') fail(400, code);
  const normalized = name.normalize('NFC');
  if (name.trim() !== name || normalized.length < 1 || normalized.length > max
      || /[/\\]|[\x00-\x1f\x7f]/.test(name) || normalized === '.' || normalized === '..'
      || normalized.startsWith('.')) fail(400, code);
  return normalized;
}
export const validateProjectName = (name) => validateSegment(name, 'INVALID_PROJECT', 64);

export function createDocStore(root, { excludeHidden = false } = {}) {
  const base = realpathSync(resolve(root));
  const locks = new Map();
  function lock(id) {
    if (locks.has(id)) return null;
    const token = { id, release() { if (locks.get(id) === token) locks.delete(id); } };
    locks.set(id, token);
    return token;
  }
  function ownsLock(id, token) { return locks.get(id) === token; }
  function isLocked(id) { return locks.has(id); }
  // 복구 실패(RECOVERY_FAILED)한 문서는 바이트·index 상태를 믿을 수 없으므로 쓰기를 막는다.
  // 해제는 사람이 git status/diff로 확인한 뒤 서버를 다시 시작하는 것뿐이다(메모리 상태).
  const quarantined = new Map();
  function quarantine(id, reason) { quarantined.set(id, { reason, at: new Date().toISOString() }); }
  function isQuarantined(id) { return quarantined.has(id); }
  const inside = (file) => file === base || file.startsWith(base + sep);
  const readFlags = fsConstants.O_RDONLY | (process.platform === 'darwin' ? O_NOFOLLOW_ANY : fsConstants.O_NOFOLLOW);
  async function resolveId(id) {
    if (typeof id !== 'string' || !id || id.includes('\\') || /[\x00-\x1f]/.test(id)
        || isAbsolute(id) || id.split('/').some((part) => !part || part === '.' || part === '..')) fail(400, 'INVALID_ID');
    if (excludeHidden && id.split('/').some(part => part.startsWith('.'))) fail(403, 'HIDDEN_PATH');
    const format = extname(id).toLowerCase().slice(1);
    if (format !== 'hwp' && format !== 'hwpx') fail(400, 'INVALID_FORMAT');
    const full = resolve(base, id);
    if (!inside(full)) fail(400, 'INVALID_ID');
    let cursor = base;
    try {
      for (const part of id.split('/')) {
        cursor = join(cursor, part);
        if ((await lstat(cursor)).isSymbolicLink()) fail(403, 'SYMLINK');
      }
      const actual = await realpath(full);
      if (!inside(actual) || !(await lstat(actual)).isFile()) fail(403, 'OUTSIDE_ROOT');
    } catch (error) {
      if (error?.code === 'ENOENT') fail(404, 'NOT_FOUND');
      throw error;
    }
    return { id, full, format };
  }
  async function canonicalPath(id) {
    const { full } = await resolveId(id);
    let cursor = base;
    for (const part of id.split('/')) {
      if (!(await readdir(cursor)).includes(part)) fail(409, 'PATH_ALIAS');
      cursor = join(cursor, part);
    }
    return full;
  }
  async function list() {
    const rootReal = await realpath(base);
    if (rootReal !== base) fail(403, 'SYMLINK_ROOT');
    const found = [];
    async function visit(dir) {
      const dirStat = await lstat(dir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return;
      if (!inside(await realpath(dir))) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.isSymbolicLink() || (excludeHidden && entry.name.startsWith('.'))) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          const st = await lstat(full).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
          if (!st || !st.isDirectory() || st.isSymbolicLink()) continue;
          const actual = await realpath(full).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
          if (actual && inside(actual)) await visit(full);
        }
        else if (entry.isFile() && /\.hwpx?$/i.test(entry.name)) {
          const id = relative(base, full).split(sep).join('/');
          found.push({ id, format: extname(id).slice(1).toLowerCase() });
        }
      }
    }
    await visit(base);
    return found.sort((a, b) => a.id.localeCompare(b.id, 'ko'));
  }
  async function listProjects() {
    const rootReal = await realpath(base);
    if (rootReal !== base) fail(403, 'SYMLINK_ROOT');
    const names = [];
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')) names.push(entry.name);
    }
    return names.sort((a, b) => a.localeCompare(b, 'ko'));
  }
  async function createProject(name) {
    const normalized = validateProjectName(name);
    try { await mkdir(join(base, normalized)); }
    catch (error) {
      if (error?.code === 'EEXIST') fail(409, 'PROJECT_EXISTS');
      throw error;
    }
    return normalized;
  }
  // 가져오기는 실제 디렉터리에만 쓰고 기존 파일을 덮지 않는다.
  // 잠금은 쓰기·커밋·실패 복구가 모두 끝날 때까지 쥔다. 그 사이 PUT·탭 임대는 423이다.
  // index는 쓰기 전 스냅숏(indexSnapshot)으로 되돌리고 같은지 확인한다. 확인되지 않으면 격리한다
  // (persistDocument와 같은 계약).
  async function importDocument(project, fileName, bytes, { commit = null, indexSnapshot = null, indexRestore = null } = {}) {
    const projectName = project === null ? null : validateProjectName(project);
    const dir = projectName === null ? base : join(base, projectName);
    const stat = await lstat(dir).catch((error) => {
      if (error?.code === 'ENOENT') fail(404, 'PROJECT_NOT_FOUND');
      throw error;
    });
    if (stat.isSymbolicLink()) fail(403, 'SYMLINK');
    if (!stat.isDirectory()) fail(404, 'PROJECT_NOT_FOUND');
    const name = validateSegment(fileName);
    const format = extname(name).toLowerCase().slice(1);
    if (format !== 'hwp' && format !== 'hwpx') fail(400, 'INVALID_FORMAT');
    if (!(bytes instanceof Uint8Array) || !matchesFormat(bytes, format)) fail(400, 'INVALID_BYTES');
    const id = projectName === null ? name : `${projectName}/${name}`;
    // 상위 디렉터리 링크까지 막는 생성 플래그(O_NOFOLLOW_ANY)가 있는 macOS에서만 가져오기를 허용한다.
    if (process.platform !== 'darwin') fail(501, 'IMPORT_UNSUPPORTED_PLATFORM');
    const token = lock(id);
    if (!token) fail(423, 'DOCUMENT_LOCKED');
    try {
      if (isQuarantined(id)) fail(423, 'DOCUMENT_QUARANTINED');
      const full = join(dir, name);
      const expected = join(dir, name);
      // 쓰기 직전 재확인: 프로젝트 디렉터리가 문서함 안의 실제 디렉터리여야 한다.
      if (await realpath(dir) !== dir) fail(403, 'SYMLINK');
      const indexBefore = commit && indexSnapshot ? await indexSnapshot(id) : null;
      let created = false;
      let identity = null; // 우리가 만든 파일의 (dev, ino). 정리할 때 같은 파일인지 확인한다.
      try {
        const handle = await open(full, createExclusiveFlags(), 0o600);
        created = true;
        try {
          const st = await handle.stat();
          identity = { dev: st.dev, ino: st.ino };
          await handle.writeFile(bytes); await handle.sync();
        } finally { await handle.close(); }
      } catch (error) {
        if (!created && error?.code === 'EEXIST') fail(409, 'DOC_EXISTS');
        if (!created && error?.code === 'ELOOP') fail(403, 'SYMLINK');
        if (created) await removeCreated(id, dir, full, identity); // 우리가 만든 파일만 지운다
        throw error;
      }
      // 쓰기 뒤 재확인: 링크로 바뀌었으면 만든 파일을(확인이 되면) 지우고 거절한다.
      if (await realpath(full).catch(() => null) !== expected) {
        await removeCreated(id, dir, full, identity);
        fail(403, 'SYMLINK');
      }
      const result = { id, format, sha256: sha256(bytes) };
      if (!commit) return result;
      try {
        return { ...result, commit: await commit(id) };
      } catch (cause) {
        try {
          if (indexRestore) await indexRestore(id, indexBefore);
          await removeCreated(id, dir, full, identity);
          if (await lstat(full).then(() => true, () => false)) throw new Error('file still present');
          if (indexSnapshot && (await indexSnapshot(id)) !== indexBefore) throw new Error('index not restored');
        } catch (recovery) {
          quarantine(id, 'RECOVERY_FAILED');
          throw Object.assign(new Error('RECOVERY_FAILED'), { status: 500, code: 'RECOVERY_FAILED', cause: [cause, recovery] });
        }
        throw Object.assign(new Error('COMMIT_FAILED'), { status: 500, code: 'COMMIT_FAILED', cause });
      }
    } finally { token.release(); }
  }
  // 가져오기가 만든 파일을 지운다. 경로로 지우기 직전에 (1) 프로젝트 디렉터리가 여전히 문서함 안의 실제
  // 디렉터리이고 (2) 그 경로가 우리가 만든 파일(dev, ino)일 때만 지운다. 아니면 지우지 않고 격리한다.
  // 남는 경합 창은 이 확인과 unlink 사이뿐이며, 그 창을 쓰려면 문서함에 쓰기 권한이 있어야 한다.
  async function removeCreated(id, dir, full, identity) {
    const refuse = (cause) => {
      quarantine(id, 'RECOVERY_FAILED');
      throw Object.assign(new Error('RECOVERY_FAILED'), { status: 500, code: 'RECOVERY_FAILED', cause });
    };
    if (!identity) refuse(new Error('unknown identity'));
    const dirOk = await realpath(dir).then((p) => p === dir, () => false);
    if (!dirOk) refuse(new Error('project dir changed'));
    let st;
    try { st = await lstat(full); }
    catch (error) { if (error?.code === 'ENOENT') return; refuse(error); }
    if (!st.isFile() || st.dev !== identity.dev || st.ino !== identity.ino) refuse(new Error('not our file'));
    try { await unlink(full); }
    catch (error) { if (error?.code !== 'ENOENT') refuse(error); }
  }
  async function read(id) {
    const target = await resolveId(id);
    let bytes;
    try {
      const h = await open(target.full, readFlags);
      try {
        if (!(await h.stat()).isFile()) fail(403, 'OUTSIDE_ROOT');
        bytes = await h.readFile();
      } finally { await h.close(); }
    } catch (error) { if (error.code === 'ELOOP') fail(403, 'SYMLINK'); throw error; }
    return { bytes, sha256: sha256(bytes), format: target.format };
  }
  async function writeAtomic(id, bytes, expectedSha256) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) fail(400, 'EMPTY_BYTES');
    const target = await resolveId(id);
    const before = await read(id);
    if (before.sha256 !== expectedSha256) fail(412, 'ETAG_MISMATCH');
    const temp = join(dirname(target.full), `.lidge-${randomUUID()}.tmp`);
    try {
      let handle;
      try { handle = await open(temp, createExclusiveFlags(), 0o600); }
      catch (error) { if (error.code === 'ELOOP') fail(403, 'SYMLINK'); throw error; }
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if ((await read(id)).sha256 !== expectedSha256) fail(412, 'ETAG_MISMATCH');
      if ((await resolveId(id)).full !== target.full) fail(403, 'OUTSIDE_ROOT');
      await rename(temp, target.full);
      try {
        const actual = await realpath(target.full);
        const st = await lstat(target.full);
        if (!inside(actual) || !st.isFile() || st.isSymbolicLink()) fail(403, 'OUTSIDE_ROOT');
      } catch (error) {
        quarantine(id, 'RECOVERY_FAILED');
        throw Object.assign(new Error('RECOVERY_FAILED'), { status: 500, code: 'RECOVERY_FAILED', cause: error });
      }
      return { sha256: sha256(bytes) };
    } finally {
      await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return { root: base, resolveId, canonicalPath, list, listProjects, createProject, importDocument,
    read, writeAtomic, lock, ownsLock, isLocked, quarantine, isQuarantined,
    hasAnyLock: () => locks.size > 0 };
}
