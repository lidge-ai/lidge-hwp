import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { emptySaveCommit, commitFile, gitArgs } from './git.mjs';
const run = promisify(execFile);
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };

export async function indexEntry(history, id) {
  const path = typeof history === 'string' ? id : history.path ?? id;
  return (await run('git', gitArgs(history, ['ls-files', '--stage', '--', path]))).stdout;
}
export async function restoreIndex(history, id, before) {
  const path = typeof history === 'string' ? id : history.path ?? id;
  if (!before) {
    // 스냅숏에 항목이 없었다 = index에 그 경로가 없던 상태(새 파일, 또는 사용자가 stage한 삭제).
    // HEAD에서 되살리지(reset) 않고 index 항목만 뺀다.
    await run('git', gitArgs(history, ['rm', '--cached', '-q', '--ignore-unmatch', '--', path]));
    return;
  }
  const lines = before.trimEnd().split('\n').map(line => `${line}\n`).join('');
  await new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs(history, ['update-index', '--index-info']));
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`index restore ${code}`)));
    child.stdin.end(lines);
  });
}

export async function persistDocument(store, { id, bytes, expectedSha256, contentLoss, message, author, lockToken }) {
  const token = lockToken ?? store.lock(id);
  if (!token || !store.ownsLock(id, token)) fail(423, 'DOCUMENT_LOCKED');
  const releaseHere = !lockToken;
  try {
    if (store.isQuarantined(id)) fail(423, 'DOCUMENT_QUARANTINED');
    if (contentLoss?.count !== 0 || !Array.isArray(contentLoss?.losses) || contentLoss.losses.length)
      fail(422, 'CONTENT_LOSS');
    const before = await store.read(id);
    if (before.sha256 !== expectedSha256) fail(412, 'ETAG_MISMATCH');
    const history = store.historyFor ? await store.historyFor(id) : { workTree: store.root, gitDir: null, path: id };
    const indexBefore = await indexEntry(history, id);
    if (Buffer.from(bytes).equals(before.bytes)) {
      try {
        // An existing but untracked document needs its first path commit.
        const commit = indexBefore
          ? await emptySaveCommit(history, id, `${message} [${author}]`)
          : await commitFile(history, id, `${message} [${author}]`);
        return { sha256: before.sha256, commit };
      } catch (cause) {
        try {
          await restoreIndex(history, id, indexBefore);
          if ((await store.read(id)).sha256 !== before.sha256 ||
              (await indexEntry(history, id)) !== indexBefore) throw new Error('recovery verification failed');
        } catch (recovery) {
          store.quarantine(id, 'RECOVERY_FAILED');
          throw Object.assign(new Error('RECOVERY_FAILED'), { status: 500, code: 'RECOVERY_FAILED', cause: [cause, recovery] });
        }
        throw cause;
      }
    }
    const written = await store.writeAtomic(id, bytes, before.sha256);
    try {
      const commit = await commitFile(history, id, `${message} [${author}]`);
      return { sha256: written.sha256, commit };
    } catch (cause) {
      try {
        await store.writeAtomic(id, before.bytes, written.sha256);
        await restoreIndex(history, id, indexBefore);
        if ((await store.read(id)).sha256 !== before.sha256 ||
            (await indexEntry(history, id)) !== indexBefore) throw new Error('recovery verification failed');
      } catch (recovery) {
        store.quarantine(id, 'RECOVERY_FAILED');
        throw Object.assign(new Error('RECOVERY_FAILED'), { status: 500, code: 'RECOVERY_FAILED', cause: [cause, recovery] });
      }
      throw cause;
    }
  } finally { if (releaseHere) token.release(); }
}
