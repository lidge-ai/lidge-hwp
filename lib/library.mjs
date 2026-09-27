import { join, resolve } from 'node:path';
import { createDocStore, validateSegment } from './docstore.mjs';
import { createRootsRegistry } from './roots.mjs';
import { ensureShadowRepo } from './git.mjs';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const EXT = new RegExp(`^ext://(${UUID})/(.+)$`);

export async function createLibrary({ docsRoot, stateDir, registryOps }) {
  const base = createDocStore(docsRoot);
  const state = resolve(stateDir);
  const registry = await createRootsRegistry({ docsRoot: base.root, stateDir: state, fsOps: registryOps });
  // 루트 키별 store는 한 번 만들면 계속 둔다. 폴더가 잠깐 사라졌다 돌아와도 문서 잠금·격리 상태가 초기화되면 안 된다.
  // 사용 가능 여부는 매번 등록 기록(available)으로 판단한다. 키는 UUID라 같은 키가 다른 폴더를 가리키는 일은 없다.
  const stores = new Map();
  const removing = new Set();
  const removedKeys = new Set();
  const refuseRemoving = key => { if (key && removing.has(key)) fail(423, 'ROOT_BUSY'); };
  // 아직 store를 만들 수 없는(폴더가 없는) 루트에 기록된 격리. store를 만들 때 옮긴다.
  const pendingQuarantine = new Map();
  // 메모리 안의 안전 상태만 다루는 메서드는 폴더가 없어도 동작해야 한다(롤백 중 폴더가 사라져도 격리를 기록한다).
  const STATE_ONLY = new Set(['ownsLock', 'isLocked', 'quarantine', 'isQuarantined']);
  let records = [];
  const update = next => {
    const warning = next.warning;
    next = next.filter(r => !removedKeys.has(r.key));
    Object.defineProperty(next, 'warning', { value: warning });
    records = next;
    for (const r of next) if (r.available && !stores.has(r.key)) {
      const store = createDocStore(r.path, { excludeHidden: true });
      for (const [pending, reason] of pendingQuarantine) {
        if (!pending.startsWith(r.key + '/')) continue;
        store.quarantine(pending.slice(r.key.length + 1), reason);
        pendingQuarantine.delete(pending);
      }
      stores.set(r.key, store);
    }
    return next;
  };
  const refresh = async () => update(await registry.list());
  await refresh();
  const selected = async id => {
    if (typeof id !== 'string' || !id.startsWith('ext:')) return { store: base, path: id, key: null };
    const match = EXT.exec(id);
    if (!match) fail(400, 'INVALID_ID');
    const [, key, path] = match;
    refuseRemoving(key);
    const record = (await refresh()).find(r => r.key === key);
    refuseRemoving(key);
    if (!record) fail(404, 'ROOT_NOT_FOUND');
    if (!record.available) fail(503, 'ROOT_UNAVAILABLE');
    return { store: stores.get(key), path, key };
  };
  const call = (method, id, ...args) => selected(id).then(({ store, path }) => store[method](path, ...args));
  const sync = (method, id, ...args) => {
    if (typeof id === 'string' && id.startsWith('ext:')) {
      const match = EXT.exec(id); if (!match) fail(400, 'INVALID_ID');
      if (!STATE_ONLY.has(method)) refuseRemoving(match[1]);
      const record = update(registry.listSync()).find(r => r.key === match[1]);
      if (!record) fail(404, 'ROOT_NOT_FOUND');
      if (!record.available && !STATE_ONLY.has(method)) fail(503, 'ROOT_UNAVAILABLE');
      const store = stores.get(record.key);
      if (!store) {
        const pending = `${record.key}/${match[2]}`;
        if (method === 'quarantine') { pendingQuarantine.set(pending, args[0]); return; }
        if (method === 'isQuarantined') return pendingQuarantine.has(pending);
        if (method === 'isLocked' || method === 'ownsLock') return false;
        fail(503, 'ROOT_UNAVAILABLE');
      }
      return store[method](match[2], ...args);
    }
    return base[method](id, ...args);
  };
  const historyForNew = async (key, relPath) => {
    if (typeof relPath !== 'string' || !relPath || relPath.split('/').some(p => !p)) fail(400, 'INVALID_ID');
    const path = relPath.split('/').map(p => validateSegment(p, 'INVALID_ID')).join('/');
    if (!key) return { workTree: base.root, gitDir: null, path };
    const { store } = await selected(`ext://${key}/probe.hwp`);
    const history = { workTree: store.root, gitDir: join(state, 'history', key), path };
    await ensureShadowRepo(history);
    return history;
  };
  const historyForExisting = async id => {
    const { store, path, key } = await selected(id);
    const resolved = await store.resolveId(path);
    if (!key) return { workTree: base.root, gitDir: null, path: resolved.id };
    const history = { workTree: store.root, gitDir: join(state, 'history', key), path: resolved.id };
    await ensureShadowRepo(history);
    return history;
  };
  return {
    root: base.root,
    roots: refresh,
    async register(path) {
      const root = await registry.register(path);
      await refresh();
      return root;
    },
    async remove(key, isBusy = () => false) {
      if (removing.has(key)) fail(423, 'ROOT_BUSY');
      removing.add(key);
      try {
        if (stores.get(key)?.hasAnyLock() || isBusy(key)) fail(423, 'ROOT_BUSY');
        let warning;
        try { await registry.remove(key); }
        catch (error) {
          if (error.code === 'INVALID_ROOT_KEY' || error.code === 'ROOT_NOT_FOUND') throw error;
          let stillRegistered = true;
          try { stillRegistered = registry.listSync().some(r => r.key === key); } catch { /* disk outcome unknown */ }
          if (stillRegistered) throw error;
          warning = error.code || 'REMOVE_SYNC_FAILED';
        }
        removedKeys.add(key);
        stores.delete(key);
        records = records.filter(r => r.key !== key);
        for (const pending of [...pendingQuarantine.keys()]) {
          if (pending.startsWith(key + '/')) pendingQuarantine.delete(pending);
        }
        await refresh().catch(() => {});
        return warning ? { warning } : {};
      } finally { removing.delete(key); }
    },
    async list() {
      const docs = await base.list();
      for (const r of await refresh()) {
        if (!r.available) continue;
        const { store } = await selected(`ext://${r.key}/probe.hwp`);
        for (const doc of await store.list()) docs.push({ ...doc, id: `ext://${r.key}/${doc.id}` });
      }
      return docs.sort((a, b) => a.id.localeCompare(b.id, 'ko'));
    },
    listProjects: () => base.listProjects(),
    createProject: name => base.createProject(name),
    importDocument: (...args) => base.importDocument(...args),
    resolveId: async id => {
      const { store, path, key } = await selected(id);
      const resolved = await store.resolveId(path);
      return key ? { ...resolved, id: `ext://${key}/${resolved.id}` } : resolved;
    },
    read: id => call('read', id),
    writeAtomic: (id, bytes, sha) => call('writeAtomic', id, bytes, sha),
    lock: id => sync('lock', id),
    isRootRemoving: id => {
      const match = typeof id === 'string' ? EXT.exec(id) : null;
      return Boolean(match && removing.has(match[1]));
    },
    ownsLock: (id, token) => sync('ownsLock', id, token),
    isLocked: id => sync('isLocked', id),
    quarantine: (id, reason) => sync('quarantine', id, reason),
    isQuarantined: id => sync('isQuarantined', id),
    historyFor: historyForExisting,
    historyForNew,
    exportPath(id) {
      const match = typeof id === 'string' ? EXT.exec(id) : null;
      if (typeof id === 'string' && id.startsWith('ext:') && !match) fail(400, 'INVALID_ID');
      return match ? `external/${match[1]}/${match[2]}` : id;
    },
    exportRoots: () => [base.root, ...records.map(r => r.path)],
  };
}
