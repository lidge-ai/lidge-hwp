export function createHandleTracker(realOpen) {
  let next = 0;
  const events = [], live = new Map(), errors = [];
  async function open(bytes) {
    const doc = await realOpen(bytes), id = ++next;
    doc.__trackId = id;
    live.set(id, doc);
    events.push({ op: 'open', id });
    const realFree = doc.free.bind(doc);
    let freed = false;
    doc.free = () => {
      if (freed) { errors.push({ kind: 'DOUBLE_FREE', id }); throw new Error('DOUBLE_FREE'); }
      freed = true; live.delete(id); events.push({ op: 'free', id }); realFree();
    };
    for (const method of ['pageCount', 'getPageText', 'getDocumentInfo']) {
      const real = doc[method].bind(doc);
      doc[method] = (...args) => {
        if (freed) { errors.push({ kind: 'USE_AFTER_FREE', id, method }); throw new Error('USE_AFTER_FREE'); }
        return real(...args);
      };
    }
    return doc;
  }
  const stats = () => ({ opens: next, frees: events.filter(event => event.op === 'free').length,
    live: [...live.keys()], errors: [...errors] });
  return { open, events, stats, live };
}

export function createFailingCli(real, failOn = []) {
  let calls = 0;
  const fn = (...args) => {
    calls++;
    if (failOn.includes(calls)) throw Object.assign(new Error('RENDER_FAILED: injected'), { code: 'RENDER_FAILED' });
    return real(...args);
  };
  Object.defineProperty(fn, 'calls', { get: () => calls });
  return fn;
}
