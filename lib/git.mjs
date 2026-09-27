import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
const run = promisify(execFile);
let commitQueue = Promise.resolve();

export async function ensureRepo(root) {
  const { stdout } = await run('git', ['-C', root, 'rev-parse', '--show-toplevel']);
  if (await realpath(stdout.trim()) !== await realpath(root)) throw new Error('DOCS_ROOT is not the Git root');
}

export function commitFile(root, id, message) {
  const operation = commitQueue.then(async () => {
    const tracked = await run('git', ['-C', root, 'ls-files', '--error-unmatch', '--', id])
      .then(() => true, () => false);
    if (!tracked) await run('git', ['-C', root, 'add', '--', id]);
    await run('git', ['-C', root, '-c', 'user.name=LIDGE HWP',
      '-c', 'user.email=lidge-hwp@local.invalid', 'commit', '--only', '-m', message, '--', id]);
    const { stdout } = await run('git', ['-C', root, 'rev-parse', 'HEAD']);
    return stdout.trim();
  });
  commitQueue = operation.catch(() => {});
  return operation;
}

export async function emptySaveCommit(root, id, message) {
  const operation = commitQueue.then(async () => {
    await run('git', ['-C', root, '-c', 'user.name=LIDGE HWP',
      '-c', 'user.email=lidge-hwp@local.invalid', 'commit', '--allow-empty', '--only', '-m', message, '--', id]);
    return (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  });
  commitQueue = operation.catch(() => {});
  return operation;
}

export async function lastCommit(root, id) {
  const { stdout } = await run('git', ['-C', root, 'log', '-1', '--format=%H', '--', id]);
  return stdout.trim() || null;
}
