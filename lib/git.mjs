import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
const run = promisify(execFile);
let commitQueue = Promise.resolve();
const asHistory = value => typeof value === 'string' ? { workTree: value, gitDir: null } : value;
export const gitArgs = (value, args) => {
  const h = asHistory(value);
  return h.gitDir
    ? ['-c', 'core.bare=false', '--git-dir', h.gitDir, '--work-tree', h.workTree, ...args]
    : ['-C', h.workTree, ...args];
};
const initializing = new Map();
export function ensureShadowRepo(history) {
  if (!history.gitDir) return Promise.resolve();
  if (initializing.has(history.gitDir)) return initializing.get(history.gitDir);
  const operation = (async () => {
    await mkdir(dirname(history.gitDir), { recursive: true, mode: 0o700 });
    try { if (!(await lstat(history.gitDir)).isDirectory()) throw new Error('HISTORY_INVALID'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await run('git', ['init', '--bare', '-q', history.gitDir]);
    }
    await run('git', gitArgs(history, ['rev-parse', '--git-dir']));
  })();
  initializing.set(history.gitDir, operation);
  operation.finally(() => initializing.delete(history.gitDir)).catch(() => {});
  return operation;
}

export async function ensureRepo(root) {
  const { stdout } = await run('git', ['-C', root, 'rev-parse', '--show-toplevel']);
  if (await realpath(stdout.trim()) !== await realpath(root)) throw new Error('DOCS_ROOT is not the Git root');
}

export function commitFile(history, id, message) {
  const path = asHistory(history).path ?? id;
  const operation = commitQueue.then(async () => {
    const tracked = await run('git', gitArgs(history, ['ls-files', '--error-unmatch', '--', path]))
      .then(() => true, () => false);
    if (!tracked) await run('git', gitArgs(history, ['add', '--', path]));
    await run('git', gitArgs(history, ['-c', 'user.name=LIDGE HWP',
      '-c', 'user.email=lidge-hwp@local.invalid', 'commit', '--only', '-m', message, '--', path]));
    const { stdout } = await run('git', gitArgs(history, ['rev-parse', 'HEAD']));
    return stdout.trim();
  });
  commitQueue = operation.catch(() => {});
  return operation;
}

export async function emptySaveCommit(history, id, message) {
  const path = asHistory(history).path ?? id;
  const operation = commitQueue.then(async () => {
    await run('git', gitArgs(history, ['-c', 'user.name=LIDGE HWP',
      '-c', 'user.email=lidge-hwp@local.invalid', 'commit', '--allow-empty', '--only', '-m', message, '--', path]));
    return (await run('git', gitArgs(history, ['rev-parse', 'HEAD']))).stdout.trim();
  });
  commitQueue = operation.catch(() => {});
  return operation;
}

export async function lastCommit(history, id) {
  const path = asHistory(history).path ?? id;
  const { stdout } = await run('git', gitArgs(history, ['log', '-1', '--format=%H', '--', path]));
  return stdout.trim() || null;
}
