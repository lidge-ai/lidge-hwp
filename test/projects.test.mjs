import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDocs, groupKeyOf, matchDoc, readCollapsedGroups } from '../web/projects.mjs';

test('groupDocs groups by top-level folder, root docs last as 기타, names keep nested paths', () => {
  const docs = [
    { id: 'b-project/z.hwp', format: 'hwp' },
    { id: 'a-project/sub/a.hwpx', format: 'hwpx' },
    { id: 'a-project/b.hwp', format: 'hwp' },
    { id: 'root.hwp', format: 'hwp' },
  ];
  const groups = groupDocs(docs);
  assert.deepEqual(groups.map((g) => g.key), ['a-project', 'b-project', '']);
  assert.equal(groups[2].label, '기타');
  assert.deepEqual(groups[0].docs.map((d) => d.name), ['b.hwp', 'sub/a.hwpx']);
  assert.equal(groups[0].docs[1].id, 'a-project/sub/a.hwpx');
});

test('groupDocs sorts groups and docs with ko localeCompare', () => {
  const groups = groupDocs([
    { id: '다/b.hwp', format: 'hwp' }, { id: '가/a.hwp', format: 'hwp' },
  ]);
  assert.deepEqual(groups.map((g) => g.key), ['가', '다']);
});

test('groupDocs includes empty projects as empty groups', () => {
  const groups = groupDocs([{ id: 'a/x.hwp', format: 'hwp' }], ['a', 'empty-proj']);
  assert.deepEqual(groups.map((g) => g.key), ['a', 'empty-proj']);
  assert.deepEqual(groups[1].docs, []);
});

test('matchDoc is case-insensitive substring over NFC-normalized id', () => {
  assert.equal(matchDoc({ id: 'Forms/Report.HWPX' }, 'report.hwpx'), true);
  assert.equal(matchDoc({ id: 'a.hwp' }, 'zzz'), false);
  assert.equal(matchDoc({ id: 'a.hwp' }, ''), true);
  // macOS는 파일명을 NFD로 줄 수 있다. 분해된 '참가신청서'도 NFC 질의로 찾는다.
  const nfd = { id: 'ku/\u110e\u1161\u11b7\u1100\u1161\u1109\u1175\u11ab\u110e\u1165\u11bc\u1109\u1165.hwp' };
  assert.equal(matchDoc(nfd, '참가신청서'), true);
  assert.equal(matchDoc({ id: 'ku/참가신청서.hwp' }, '\u110e\u1161\u11b7\u1100\u1161'), true);
});

test('groupKeyOf returns top-level folder or root key', () => {
  assert.equal(groupKeyOf('a/b/c.hwp'), 'a');
  assert.equal(groupKeyOf('a.hwp'), '');
});

test('readCollapsedGroups parses a JSON array of keys and tolerates garbage', () => {
  const storage = (map) => ({ getItem: (key) => (key in map ? map[key] : null) });
  assert.deepEqual(readCollapsedGroups(storage({})), new Set());
  assert.deepEqual(readCollapsedGroups(storage({ 'lidge-hwp.projects.collapsed': '["a","b"]' })), new Set(['a', 'b']));
  assert.deepEqual(readCollapsedGroups(storage({ 'lidge-hwp.projects.collapsed': 'not json' })), new Set());
  assert.deepEqual(readCollapsedGroups(storage({ 'lidge-hwp.projects.collapsed': '{"a":1}' })), new Set());
  assert.deepEqual(readCollapsedGroups(storage({ 'lidge-hwp.projects.collapsed': '[1,"a"]' })), new Set(['a']));
  assert.deepEqual(readCollapsedGroups({ getItem: () => { throw new Error('denied'); } }), new Set());
});

// 아주 작은 가짜 DOM: renderProjects가 쓰는 API만 흉내 낸다.
function fakeElement(tag) {
  const el = { tag, children: [], attrs: {}, dataset: {}, hidden: false, title: '', className: '', type: '', id: '', listeners: {},
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
    append(...nodes) { this.children.push(...nodes); }, addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
    get firstChild() { return this.children[0]; },
    set innerHTML(v) { this._html = v; },
    set textContent(v) { this._text = v; this.children = []; }, get textContent() { return this._text ?? this.children.map((c) => c.textContent ?? '').join(''); } };
  return el;
}
function walk(node, out = []) { out.push(node); for (const c of node.children ?? []) walk(c, out); return out; }

test('renderProjects gives documents path labels and hides format/count badges from the accessible name', async () => {
  globalThis.document = { createElement: fakeElement, createElementNS: (_ns, tag) => fakeElement(tag) };
  try {
    const { renderProjects } = await import('../web/projects.mjs');
    const list = fakeElement('ul');
    const groups = groupDocs([{ id: 'samples/a.hwp', format: 'hwp' }, { id: 'samples/b.hwpx', format: 'hwpx' }], ['samples']);
    renderProjects(list, groups, { currentId: 'samples/b.hwpx' });
    const nodes = walk(list);
    const docs = nodes.filter((n) => n.className === 'doc');
    assert.deepEqual(docs.map((d) => d.getAttribute('aria-label')), ['samples/a.hwp', 'samples/b.hwpx']);
    assert.deepEqual(docs.map((d) => d.getAttribute('aria-current')), ['false', 'true']);
    for (const badge of nodes.filter((n) => n.className === 'badge' || n.className === 'count')) assert.equal(badge.getAttribute('aria-hidden'), 'true');
    const header = nodes.find((n) => n.className === 'group-header');
    assert.equal(header.getAttribute('aria-label'), 'samples 프로젝트, 문서 2개');
  } finally { delete globalThis.document; }
});
