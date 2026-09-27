import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
const valid = r => r && UUID.test(r.key) && typeof r.path === 'string'
  && isAbsolute(r.path) && resolve(r.path) === r.path
  && Number.isSafeInteger(r.dev) && Number.isSafeInteger(r.ino);

export async function createRootsRegistry({ docsRoot, stateDir, fsOps = {} }) {
  const ops = { ...fs, ...fsOps };
  const docs = await ops.realpath(docsRoot);
  const state = resolve(stateDir);
  await ops.mkdir(state, { recursive: true, mode: 0o700 });
  const stateReal = await ops.realpath(state);
  if (stateReal === docs || stateReal.startsWith(docs + sep)) fail(400, 'STATE_INSIDE_DOCS');
  const historyDir = join(stateReal, 'history');
  await ops.chmod(stateReal, 0o700);
  const file = join(stateReal, 'roots.json');
  const readDisk = async () => {
    let st;
    try { st = await ops.lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!st.isFile()) fail(500, 'ROOTS_INVALID');
    await ops.chmod(file, 0o600);
    let saved;
    try { saved = JSON.parse(await ops.readFile(file, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) fail(500, 'ROOTS_INVALID'); throw error; }
    if (!saved || saved.version !== 1 || !Array.isArray(saved.roots) || saved.roots.some(r => !valid(r))
        || new Set(saved.roots.map(r => r.key)).size !== saved.roots.length) fail(500, 'ROOTS_INVALID');
    for (let i = 0; i < saved.roots.length; i++) {
      if ([docs, stateReal, historyDir].some(p => overlaps(saved.roots[i].path, p))
          || saved.roots.slice(i + 1).some(r => overlaps(saved.roots[i].path, r.path))) fail(500, 'ROOTS_INVALID');
    }
    return saved.roots;
  };
  let records = await readDisk();
  let poisoned = false;
  const status = async r => {
    let actual, st;
    try { actual = await ops.realpath(r.path); st = await ops.lstat(r.path); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code))
        return { key: r.key, label: basename(r.path), path: r.path, available: false, reason: 'MISSING' };
      throw error;
    }
    const available = actual === r.path && st.isDirectory() && st.dev === r.dev && st.ino === r.ino;
    return { key: r.key, label: basename(r.path), path: r.path, available,
      ...(!available ? { reason: 'REPLACED' } : {}) };
  };
  const list = async () => {
    const rows = await Promise.all(records.map(status));
    Object.defineProperty(rows, 'warning', { value: poisoned ? 'ROOTS_RELOAD_FAILED' : null });
    return rows;
  };
  const syncDir = fsOps.syncDir ?? (async dir => {
    const h = await ops.open(dir, 'r');
    try { await h.sync(); } finally { await h.close(); }
  });
  const save = async next => {
    const temp = join(stateReal, `.roots-${randomUUID()}.tmp`);
    try {
      const h = await ops.open(temp, 'wx', 0o600);
      try { await h.writeFile(JSON.stringify({ version: 1, roots: next }) + '\n'); await h.sync(); }
      finally { await h.close(); }
      await ops.rename(temp, file);
      await syncDir(stateReal);
    } catch (error) {
      try { records = await readDisk(); }
      catch (reload) {
        poisoned = true;
        throw Object.assign(new AggregateError([error, reload], 'ROOTS_RELOAD_FAILED'),
          { status: 503, code: 'ROOTS_RELOAD_FAILED' });
      }
      throw error;
    } finally { await ops.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    records = next;
  };
  let mutationQueue = Promise.resolve();
  const serialize = (job, { allowPoisoned = false } = {}) => {
    const operation = mutationQueue.then(() => {
      if (poisoned && !allowPoisoned) fail(503, 'ROOTS_RELOAD_FAILED');
      return job();
    });
    mutationQueue = operation.catch(() => {});
    return operation;
  };
  const reload = () => serialize(async () => {
    records = await readDisk();
    poisoned = false;
    return list();
  }, { allowPoisoned: true });
  function register(path) { return serialize(async () => {
    const actual = await ops.realpath(path);
    const st = await ops.lstat(actual);
    if (!st.isDirectory()) fail(400, 'ROOT_NOT_DIRECTORY');
    if ([docs, stateReal, historyDir, ...records.map(r => r.path)].some(p => overlaps(actual, p))) fail(409, 'ROOT_OVERLAP');
    const root = { key: randomUUID(), path: actual, dev: st.dev, ino: st.ino };
    await save([...records, root]);
    return status(root);
  }); }
  function remove(key) { return serialize(async () => {
    if (!UUID.test(key)) fail(400, 'INVALID_ID');
    if (!records.some(r => r.key === key)) fail(404, 'ROOT_NOT_FOUND');
    await save(records.filter(r => r.key !== key));
  }); }
  return { list, register, remove, reload };
}
