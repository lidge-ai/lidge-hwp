import { readApi, readView } from './ops.mjs';

const coded = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

export function createPageView({ source, getGen, getDoc, format, exporter, openDocument, cliPageCount, rhwpBin, deadline }) {
  let cache = null;

  async function build(gen) {
    let bytes = source.bytes, doc = getDoc(), owned = null, handedOff = false;
    try {
      if (gen) {
        const exported = exporter(doc, format);
        if (exported.report.count) throw coded('RENDER_CONTENT_LOSS', 'edited document cannot be exported without loss; save first');
        bytes = exported.bytes;
        doc = owned = await openDocument(bytes);
      }
      const authoritativeCount = await cliPageCount(bytes, format, rhwpBin, deadline);
      const wasmPageCount = doc.pageCount();
      const view = { gen, bytes, doc, owned, cliPageCount: authoritativeCount, wasmPageCount,
        diverged: authoritativeCount !== wasmPageCount };
      handedOff = true;
      return view;
    } finally { if (!handedOff) owned?.free(); }
  }

  async function current() {
    const gen = getGen();
    if (cache?.gen === gen) return cache;
    const next = await build(gen);
    if (getGen() !== gen) { next.owned?.free(); throw coded('PAGE_VIEW_STALE', 'document changed during page read'); }
    const old = cache;
    cache = next;
    old?.owned?.free();
    return next;
  }

  async function read(method, args = []) {
    const v = await current();
    if (method === 'pageCount') { readApi(v.doc, method, args); return v.cliPageCount; }
    if (method === 'getDocumentInfo') return { ...readApi(v.doc, method, args), pageCount: v.cliPageCount };
    if (method === 'info') return { ...readView(v.doc, 'info'), pageCount: v.cliPageCount };
    if (v.diverged) throw Object.assign(coded('PAGE_LAYOUT_DIVERGED', 'CLI and WASM page layouts differ; inspect snapshot'),
      { details: { cliPageCount: v.cliPageCount, wasmPageCount: v.wasmPageCount } });
    if (method === 'getPageText') return readApi(v.doc, method, args);
    if (method === 'text') return readView(v.doc, method, args[0]);
    throw coded('PAGE_READ_INVALID', method);
  }

  function close() { const old = cache; cache = null; old?.owned?.free(); }
  function inspect() { return cache && { gen: cache.gen, ownedId: cache.owned?.__trackId ?? null,
    cliPageCount: cache.cliPageCount, diverged: cache.diverged }; }
  return { current, read, close, inspect };
}
