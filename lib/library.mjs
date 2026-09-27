import { join, resolve } from 'node:path';
import { createDocStore, validateSegment } from './docstore.mjs';
import { createRootsRegistry } from './roots.mjs';
import { ensureShadowRepo } from './git.mjs';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const EXT = new RegExp(`^ext://(${UUID})/(.+)$`);

export async function createLibrary({ docsRoot, stateDir }) {
  const base = createDocStore(docsRoot);
  const state = resolve(stateDir);
  const registry = await createRootsRegistry({ docsRoot: base.root, stateDir: state });
  const stores = new Map();
  let records = [];
  const update = next => {
    records = next;
    const available = new Set(next.filter(r => r.available).map(r => r.key));
    for (const key of stores.keys()) if (!available.has(key)) stores.delete(key);
    for (const r of next) if (r.available && !stores.has(r.key))
      stores.set(r.key, createDocStore(r.path, { excludeHidden: true }));
    return next;
  };
  const refresh = async () => update(await registry.list());
  await refresh();
  const selected = async id => {
    if (typeof id !== 'string' || !id.startsWith('ext:')) return { store: base, path: id, key: null };
    const match = EXT.exec(id);
    if (!match) fail(400, 'INVALID_ID');
    const [, key, path] = match;
    const record = (await refresh()).find(r => r.key === key);
    if (!record) fail(404, 'ROOT_NOT_FOUND');
    if (!record.available) fail(503, 'ROOT_UNAVAILABLE');
    return { store: stores.get(key), path, key };
  };
  const call = (method, id, ...args) => selected(id).then(({ store, path }) => store[method](path, ...args));
  const sync = (method, id, ...args) => {
    if (typeof id === 'string' && id.startsWith('ext:')) {
      const match = EXT.exec(id); if (!match) fail(400, 'INVALID_ID');
      let record = records.find(r => r.key === match[1]);
      if (!record) record = update(registry.listSync()).find(r => r.key === match[1]);
      if (!record) fail(404, 'ROOT_NOT_FOUND');
      const store = stores.get(record.key);
      if (!store) fail(503, 'ROOT_UNAVAILABLE');
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
    async remove(key) {
      await registry.remove(key);
      await refresh();
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
