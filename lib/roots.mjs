import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, lstatSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
const valid = r => r && UUID.test(r.key) && typeof r.path === 'string'
  && isAbsolute(r.path) && resolve(r.path) === r.path
  && Number.isSafeInteger(r.dev) && Number.isSafeInteger(r.ino);
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const processQueues = new Map();

function validateSaved(saved, docs, stateReal, historyDir) {
  if (!saved || saved.version !== 1 || !Array.isArray(saved.roots) || saved.roots.some(r => !valid(r))
      || new Set(saved.roots.map(r => r.key)).size !== saved.roots.length) fail(500, 'ROOTS_INVALID');
  for (let i = 0; i < saved.roots.length; i++) {
    if ([docs, stateReal, historyDir].some(p => overlaps(saved.roots[i].path, p))
        || saved.roots.slice(i + 1).some(r => overlaps(saved.roots[i].path, r.path))) fail(500, 'ROOTS_INVALID');
  }
  return saved.roots;
}

function queueForFile(path, job) {
  const previous = processQueues.get(path) ?? Promise.resolve();
  const operation = previous.then(job);
  const tail = operation.catch(() => {});
  processQueues.set(path, tail);
  tail.finally(() => { if (processQueues.get(path) === tail) processQueues.delete(path); });
  return operation;
}

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
  const lockFile = `${file}.lock`;
  const readDisk = async () => {
    let st;
    try { st = await ops.lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!st.isFile()) fail(500, 'ROOTS_INVALID');
    await ops.chmod(file, 0o600);
    let saved;
    try { saved = JSON.parse(await ops.readFile(file, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) fail(500, 'ROOTS_INVALID'); throw error; }
    return validateSaved(saved, docs, stateReal, historyDir);
  };
  const readDiskSync = () => {
    let st;
    try { st = lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!st.isFile()) fail(500, 'ROOTS_INVALID');
    chmodSync(file, 0o600);
    let saved;
    try { saved = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) fail(500, 'ROOTS_INVALID'); throw error; }
    return validateSaved(saved, docs, stateReal, historyDir);
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
    const current = poisoned ? records : await readDisk();
    const rows = await Promise.all(current.map(status));
    Object.defineProperty(rows, 'warning', { value: poisoned ? 'ROOTS_RELOAD_FAILED' : null });
    return rows;
  };
  const listSync = () => readDiskSync().map(r => {
    let actual, st;
    try { actual = realpathSync(r.path); st = lstatSync(r.path); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code))
        return { key: r.key, label: basename(r.path), path: r.path, available: false, reason: 'MISSING' };
      throw error;
    }
    const available = actual === r.path && st.isDirectory() && st.dev === r.dev && st.ino === r.ino;
    return { key: r.key, label: basename(r.path), path: r.path, available,
      ...(!available ? { reason: 'REPLACED' } : {}) };
  });
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
  const sameFile = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
  const lockOnDisk = async path => {
    let st;
    try { st = await ops.lstat(path); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let owner = null;
    try {
      const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
      if (Number.isSafeInteger(parsed?.pid) && parsed.pid > 0 && typeof parsed.token === 'string'
          && parsed.token.length > 0 && Number.isFinite(parsed.at)) owner = parsed;
    } catch (error) { if (error.code === 'ENOENT') return null; if (!(error instanceof SyntaxError)) throw error; }
    return { st, owner };
  };
  const unlinkIfSame = async (path, identity) => {
    const current = await lockOnDisk(path);
    if (current && sameFile(current.st, identity)) await ops.unlink(path);
  };
  const release = async (token, identity) => {
    const current = await lockOnDisk(lockFile);
    if (current && current.owner?.token === token && sameFile(current.st, identity)) await ops.unlink(lockFile);
    else console.warn('[roots] lock ownership changed before release');
  };
  const recover = async (observed, token) => {
    // Two processes recovering one dead lock can still interleave around rename; identity checks
    // and non-overwriting restoration narrow that window. PID reuse may look live and time out safely.
    const stale = `${lockFile}.${token}.stale`;
    try { await ops.rename(lockFile, stale); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const moved = await lockOnDisk(stale);
    if (moved && sameFile(moved.st, observed.st) && moved.owner?.token === observed.owner?.token) {
      await ops.unlink(stale);
      return true;
    }
    // A fresh lock may have appeared between reading and rename. Never overwrite another lock.
    try { await ops.link(stale, lockFile); await ops.unlink(stale); }
    catch (error) { if (error.code !== 'EEXIST') throw error; console.warn('[roots] displaced lock could not be restored'); }
    return false;
  };
  const withLock = async job => {
    const deadline = Date.now() + LOCK_WAIT_MS;
    const token = randomUUID();
    let identity;
    for (;;) {
      let handle;
      try {
        handle = await ops.open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        identity = await handle.stat();
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }));
        await handle.close();
        break;
      } catch (error) {
        if (handle) {
          if (!identity) {
            try { identity = await handle.stat(); }
            catch { console.warn('[roots] cannot verify failed lock create for cleanup'); }
          }
          try { await handle.close(); } catch { /* the original failure remains authoritative */ }
          if (identity) await unlinkIfSame(lockFile, identity);
          throw error;
        }
        if (error.code !== 'EEXIST') throw error;
        const existing = await lockOnDisk(lockFile);
        if (!existing) continue;
        let dead = false;
        if (existing.owner) {
          try { process.kill(existing.owner.pid, 0); }
          catch (check) { dead = check.code === 'ESRCH'; }
        } else dead = Date.now() - existing.st.mtimeMs > LOCK_STALE_MS;
        if (dead) {
          if (Date.now() >= deadline) fail(503, 'ROOTS_BUSY');
          if (!await recover(existing, token))
            await delay(Math.min(LOCK_RETRY_MS, deadline - Date.now()));
          continue;
        }
        if (Date.now() >= deadline) fail(503, 'ROOTS_BUSY');
        await delay(Math.min(LOCK_RETRY_MS, deadline - Date.now()));
      }
    }
    try { return await job(); }
    finally { await release(token, identity); }
  };
  let mutationQueue = Promise.resolve();
  const serialize = (job, { allowPoisoned = false, mutation = false } = {}) => {
    const operation = mutationQueue.then(async () => {
      if (poisoned && !allowPoisoned) fail(503, 'ROOTS_RELOAD_FAILED');
      if (!mutation) return job();
      return queueForFile(lockFile, () => withLock(async () => { records = await readDisk(); return job(); }));
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
  }, { mutation: true }); }
  function remove(key) { return serialize(async () => {
    if (!UUID.test(key)) fail(400, 'INVALID_ID');
    if (!records.some(r => r.key === key)) fail(404, 'ROOT_NOT_FOUND');
    await save(records.filter(r => r.key !== key));
  }, { mutation: true }); }
  return { list, listSync, register, remove, reload };
}
