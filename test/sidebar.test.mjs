import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSidebarWidth, readSidebarState } from '../web/sidebar.mjs';

test('clampSidebarWidth clamps to 200..min(480, viewport/2) and rounds', () => {
  assert.equal(clampSidebarWidth(100, 2000), 200);
  assert.equal(clampSidebarWidth(300, 2000), 300);
  assert.equal(clampSidebarWidth(999, 2000), 480);
  assert.equal(clampSidebarWidth(300.6, 2000), 301);
  // 좁은 창에서는 뷰포트 절반이 상한이 되되 200은 보장한다
  assert.equal(clampSidebarWidth(300, 500), 250);
  assert.equal(clampSidebarWidth(100, 300), 200);
  assert.equal(clampSidebarWidth(300, 300), 200);
  // 유한하지 않은 값과 뷰포트는 기본값으로 되돌린다
  assert.equal(clampSidebarWidth(NaN, 2000), 256);
  assert.equal(clampSidebarWidth(Infinity, 2000), 256);
  assert.equal(clampSidebarWidth(300, NaN), 300); // max fallback은 200 이상을 보장
});

test('readSidebarState reads persisted collapse and width, tolerates garbage', () => {
  const storage = (map) => ({ getItem: (key) => (key in map ? map[key] : null) });
  assert.deepEqual(readSidebarState(storage({})), { collapsed: false, width: 256 });
  assert.deepEqual(readSidebarState(storage({ 'lidge-hwp.sidebar': 'collapsed' })), { collapsed: true, width: 256 });
  assert.deepEqual(readSidebarState(storage({ 'lidge-hwp.sidebar': 'expanded', 'lidge-hwp.sidebar-width': '320' })),
    { collapsed: false, width: 320 });
  assert.deepEqual(readSidebarState(storage({ 'lidge-hwp.sidebar': 'junk', 'lidge-hwp.sidebar-width': 'abc' })),
    { collapsed: false, width: 256 });
  assert.deepEqual(readSidebarState(storage({ 'lidge-hwp.sidebar-width': '' })), { collapsed: false, width: 256 });
});

test('readSidebarState tolerates a throwing or missing storage', () => {
  const throwing = { getItem: () => { throw new Error('denied'); } };
  assert.deepEqual(readSidebarState(throwing), { collapsed: false, width: 256 });
  assert.deepEqual(readSidebarState(null), { collapsed: false, width: 256 });
  assert.deepEqual(readSidebarState(undefined), { collapsed: false, width: 256 });
});

function fakeDom({ innerWidth = 2000, stored = {} } = {}) {
  const handlers = {};
  const writes = [];
  const el = (id) => ({ id, attrs: {}, style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    dataset: {}, listeners: {}, hidden: false, inert: false, innerHTML: '', title: '',
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
    querySelector(sel) { return sel === '.sidebar-body' ? body : null; },
    getBoundingClientRect: () => ({ width: 44 }) });
  const body = el('body'); const aside = el('doc-list'); const toggle = el('sidebar-toggle');
  const resizer = el('sidebar-resizer'); const layout = el('layout');
  aside.querySelector = (sel) => (sel === '.sidebar-body' ? body : null);
  const view = { innerWidth, navigator: { platform: 'MacIntel' }, addEventListener: (t, f) => { handlers[t] = f; } };
  const doc = { body: { dataset: {} }, defaultView: view, addEventListener() {},
    querySelector: (sel) => ({ '#sidebar-toggle': toggle, '#doc-list': aside, '#sidebar-resizer': resizer, '.layout': layout })[sel] ?? null };
  const storage = { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => writes.push([k, v]) };
  return { doc, view, storage, layout, handlers, writes };
}

test('window resize reapplies the preferred width without overwriting it (collapsed or narrowed)', async () => {
  const { initSidebar } = await import('../web/sidebar.mjs');
  const dom = fakeDom({ stored: { 'lidge-hwp.sidebar': 'collapsed', 'lidge-hwp.sidebar-width': '320' } });
  initSidebar({ doc: dom.doc, storage: dom.storage });
  const width = () => dom.layout.style.props['--sidebar-width'];
  assert.equal(width(), '320px');
  dom.view.innerWidth = 500; dom.handlers.resize();   // 좁히면 적용 너비만 줄어든다
  assert.equal(width(), '250px');
  dom.view.innerWidth = 2000; dom.handlers.resize();  // 넓히면 선호 너비로 돌아온다
  assert.equal(width(), '320px');
  assert.deepEqual(dom.writes.filter(([k]) => k === 'lidge-hwp.sidebar-width'), []); // 접힌 폭(44px)·축소 폭을 저장하지 않는다
});
