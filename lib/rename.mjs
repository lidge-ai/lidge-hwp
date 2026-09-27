import { link, unlink, lstat, readdir, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, extname, join } from 'node:path';
import { validateSegment } from './docstore.mjs';
import { indexEntry, restoreIndex } from './persist.mjs';
import { commitRename, renameSourceTracked, trackedNamesIn, gitArgs, gitEnv } from './git.mjs';

const runGit = promisify(execFile);
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const folded = value => value.normalize('NFC').toLowerCase();
const sameFile = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;

async function headOf(history) {
  try {
    return (await runGit('git', gitArgs(history, ['rev-parse', '--verify', 'HEAD']), { env: gitEnv() })).stdout.trim();
  } catch (error) {
    if (error.code === 128 && /Needed a single revision|unknown revision|bad revision/.test(error.stderr || '')) return null;
    throw error;
  }
}

export const defaultRenameFsOps = { link, unlink, lstat, readdir, realpath };
export const defaultRenameGitOps = { indexEntry, restoreIndex, commitRename, renameSourceTracked, headOf, trackedNamesIn };

export async function renameFile({ store, id, name, history, oldRel, newId, newRel,
  fsOps = defaultRenameFsOps, gitOps = defaultRenameGitOps }) {
  if (store.isQuarantined(id) || store.isQuarantined(newId)) fail(423, 'DOCUMENT_QUARANTINED');
  const old = await store.resolveId(id);
  const nextName = validateSegment(name);
  if (extname(nextName) !== extname(old.full)) fail(400, 'FORMAT_MISMATCH');
  if (folded(basename(old.full)) === folded(nextName)) fail(409, 'NAME_COLLISION');
  if (old.full !== join(history.workTree, oldRel)) fail(403, 'OUTSIDE_ROOT');
  const dir = dirname(old.full);
  const newFull = join(dir, nextName);
  if (await fsOps.realpath(dir) !== dir) fail(403, 'SYMLINK');
  if ((await fsOps.readdir(dir)).some(entry => folded(entry) === folded(nextName))) fail(409, 'NAME_COLLISION');
  const before = await store.read(id);
  const oldStat = await fsOps.lstat(old.full);
  const oldHistory = { ...history, path: oldRel };
  const newHistory = { ...history, path: newRel };
  const oldIndex = await gitOps.indexEntry(oldHistory, id);
  const newIndex = await gitOps.indexEntry(newHistory, newId);
  if (newIndex) fail(409, 'NAME_COLLISION');
  // HEAD에만 남은 이름(디스크·index에서 지워진 상태)도 충돌이다. 대소문자·NFC 차이도 같게 본다.
  const dirRel = newRel.includes('/') ? newRel.slice(0, newRel.lastIndexOf('/')) : '';
  const oldBase = oldRel.split('/').at(-1);
  if ((await gitOps.trackedNamesIn(history, dirRel))
    .some(entry => entry !== oldBase && folded(entry) === folded(nextName))) fail(409, 'NAME_COLLISION');
  const headBefore = await gitOps.headOf(history);
  const tracked = await gitOps.renameSourceTracked(history, oldRel);
  let linked = false;
  let removedOld = false;
  let commitStarted = false;
  try {
    if (await fsOps.realpath(dir) !== dir) fail(403, 'SYMLINK');
    const now = await fsOps.lstat(old.full);
    if (!sameFile(oldStat, now) || (await store.read(id)).sha256 !== before.sha256) fail(409, 'FILE_CHANGED');
    if (history.gitDir || !tracked) {
      try { await fsOps.link(old.full, newFull); linked = true; }
      catch (error) { if (error.code === 'EEXIST') fail(409, 'NAME_COLLISION'); throw error; }
      const target = await fsOps.lstat(newFull);
      if (!sameFile(oldStat, target)) fail(500, 'RENAME_FAILED');
      if (!sameFile(oldStat, await fsOps.lstat(old.full))) fail(409, 'FILE_CHANGED');
      await fsOps.unlink(old.full); removedOld = true;
      if (await fsOps.realpath(newFull) !== newFull || (await store.read(newId)).sha256 !== before.sha256)
        fail(500, 'RENAME_FAILED');
    }
    commitStarted = true;
    const commit = await gitOps.commitRename(history, oldRel, newRel, `Rename ${oldRel} to ${newRel}`);
    const target = await fsOps.lstat(newFull);
    if (!sameFile(oldStat, target) || (await store.read(newId)).sha256 !== before.sha256)
      fail(500, 'RECOVERY_FAILED');
    return { id: newId, oldId: id, commit };
  } catch (cause) {
    if (commitStarted) {
      let headAfter;
      try { headAfter = await gitOps.headOf(history); }
      catch { store.quarantine(id, 'RECOVERY_FAILED'); store.quarantine(newId, 'RECOVERY_FAILED'); fail(500, 'RECOVERY_FAILED'); }
      if (headAfter !== headBefore || cause.code === 'RECOVERY_FAILED') {
        store.quarantine(id, 'RECOVERY_FAILED'); store.quarantine(newId, 'RECOVERY_FAILED');
        fail(500, 'RECOVERY_FAILED');
      }
    }
    const recoveryErrors = [];
    try {
      if (!history.gitDir && tracked && commitStarted) {
        const target = await fsOps.lstat(newFull).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (target) {
          if (!sameFile(oldStat, target)) throw new Error('target identity changed');
          await fsOps.link(newFull, old.full);
          await fsOps.unlink(newFull);
        }
      } else if (removedOld) {
        const target = await fsOps.lstat(newFull);
        if (!sameFile(oldStat, target)) throw new Error('target identity changed');
        await fsOps.link(newFull, old.full);
        await fsOps.unlink(newFull);
      } else if (linked) {
        const target = await fsOps.lstat(newFull);
        if (!sameFile(oldStat, target)) throw new Error('target identity changed');
        await fsOps.unlink(newFull);
      }
    } catch (error) { recoveryErrors.push(error); }
    for (const [snapshotHistory, snapshotId, snapshot] of [
      [oldHistory, id, oldIndex], [newHistory, newId, newIndex],
    ]) {
      try { await gitOps.restoreIndex(snapshotHistory, snapshotId, snapshot); }
      catch (error) { recoveryErrors.push(error); }
    }
    try {
      if (!sameFile(oldStat, await fsOps.lstat(old.full)) || (await store.read(id)).sha256 !== before.sha256
          || (await gitOps.indexEntry(oldHistory, id)) !== oldIndex
          || (await gitOps.indexEntry(newHistory, newId)) !== newIndex) throw new Error('recovery mismatch');
    } catch (error) { recoveryErrors.push(error); }
    if (recoveryErrors.length) {
      store.quarantine(id, 'RECOVERY_FAILED'); store.quarantine(newId, 'RECOVERY_FAILED');
      throw Object.assign(new Error('RECOVERY_FAILED'), { status: 500, code: 'RECOVERY_FAILED', cause: [cause, ...recoveryErrors] });
    }
    if (cause.status) throw cause;
    throw Object.assign(new Error('COMMIT_FAILED'), { status: 500, code: 'COMMIT_FAILED', cause });
  }
}
