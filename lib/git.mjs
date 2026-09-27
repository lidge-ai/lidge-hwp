import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
const run = promisify(execFile);
let commitQueue = Promise.resolve();
const asHistory = value => typeof value === 'string' ? { workTree: value, gitDir: null } : value;
export const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
export const gitArgs = (value, args) => {
  if (value === null) return ['--literal-pathspecs', ...args];
  const h = asHistory(value);
  return h.gitDir
    ? ['--literal-pathspecs', '-c', 'core.bare=false', '--git-dir', h.gitDir, '--work-tree', h.workTree, ...args]
    : ['--literal-pathspecs', '-C', h.workTree, ...args];
};
const gitRun = (history, args) => run('git', gitArgs(history, args), { env: gitEnv() });
const initializing = new Map();
export function ensureShadowRepo(history) {
  if (!history.gitDir) return Promise.resolve();
  if (initializing.has(history.gitDir)) return initializing.get(history.gitDir);
  const operation = (async () => {
    await mkdir(dirname(history.gitDir), { recursive: true, mode: 0o700 });
    try { if (!(await lstat(history.gitDir)).isDirectory()) throw new Error('HISTORY_INVALID'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await gitRun(null, ['init', '--bare', '-q', history.gitDir]);
    }
    await gitRun(history, ['rev-parse', '--git-dir']);
  })();
  initializing.set(history.gitDir, operation);
  operation.finally(() => initializing.delete(history.gitDir)).catch(() => {});
  return operation;
}

export async function ensureRepo(root) {
  const { stdout } = await gitRun(root, ['rev-parse', '--show-toplevel']);
  if (await realpath(stdout.trim()) !== await realpath(root)) throw new Error('DOCS_ROOT is not the Git root');
}

export function commitFile(history, id, message) {
  const path = asHistory(history).path ?? id;
  const operation = commitQueue.then(async () => {
    const tracked = await gitRun(history, ['ls-files', '--error-unmatch', '--', path])
      .then(() => true, () => false);
    if (!tracked) await gitRun(history, ['add', '--', path]);
    await gitRun(history, ['-c', 'user.name=LIDGE HWP',
      '-c', 'user.email=lidge-hwp@local.invalid', 'commit', '--only', '-m', message, '--', path]);
    const { stdout } = await gitRun(history, ['rev-parse', 'HEAD']);
    return stdout.trim();
  });
  commitQueue = operation.catch(() => {});
  return operation;
}

export async function renameSourceTracked(history, oldPath) {
  if ((await gitRun(history, ['ls-files', '--stage', '--', oldPath])).stdout) return true;
  const headPath = await gitRun(history, ['ls-tree', '-z', '--name-only', 'HEAD', '--', oldPath])
    .then(result => result.stdout, error => {
      if (error.code === 128 && /not a valid object name|Not a valid object name/.test(error.stderr || '')) return '';
      throw error;
    });
  return headPath.split('\0').includes(oldPath);
}

export function commitRename(history, oldPath, newPath, message) {
  const operation = commitQueue.then(async () => {
    const tracked = await renameSourceTracked(history, oldPath);
    if (!history.gitDir && tracked) {
      const indexed = (await gitRun(history, ['ls-files', '--stage', '--', oldPath])).stdout;
      if (!indexed) await gitRun(history, ['add', '--', oldPath]);
      await gitRun(history, ['mv', '--', oldPath, newPath]);
    } else if (history.gitDir && tracked) {
      await gitRun(history, ['add', '-A', '--', oldPath, newPath]);
    } else {
      await gitRun(history, ['add', '--', newPath]);
    }
    const paths = tracked ? [oldPath, newPath] : [newPath];
    await gitRun(history, ['-c', 'user.name=LIDGE HWP', '-c', 'user.email=lidge-hwp@local.invalid',
      'commit', '--only', '-m', message, '--', ...paths]);
    return (await gitRun(history, ['rev-parse', 'HEAD'])).stdout.trim();
  });
  commitQueue = operation.catch(() => {});
  return operation;
}

export async function emptySaveCommit(history, id, message) {
  const path = asHistory(history).path ?? id;
  const operation = commitQueue.then(async () => {
    await gitRun(history, ['-c', 'user.name=LIDGE HWP',
      '-c', 'user.email=lidge-hwp@local.invalid', 'commit', '--allow-empty', '--only', '-m', message, '--', path]);
    return (await gitRun(history, ['rev-parse', 'HEAD'])).stdout.trim();
  });
  commitQueue = operation.catch(() => {});
  return operation;
}

export async function lastCommit(history, id) {
  const path = asHistory(history).path ?? id;
  const { stdout } = await gitRun(history, ['log', '-1', '--format=%H', '--', path]);
  return stdout.trim() || null;
}
