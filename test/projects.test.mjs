import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDocs, groupKeyOf, createGroupFor, matchDoc, readCollapsedGroups, renderProjects, displayName } from '../web/projects.mjs';
import { isNewDocShortcut } from '../web/new-doc.mjs';

test('selected group outranks current then default', () => {
  const key = '123e4567-e89b-42d3-a456-426614174000';
  const groups = [
    { key: 'P', label: 'P', kind: 'primary' },
    { key: `ext://${key}`, label: '외부', kind: 'external' },
  ];
  assert.deepEqual(createGroupFor(groups, `ext://${key}`, 'P/old.hwp'), { kind: 'external', key });
  assert.deepEqual(createGroupFor(groups, null, 'P/old.hwp'), { kind: 'project', name: 'P' });
  assert.deepEqual(createGroupFor(groups, null, null), { kind: 'default' });
});

test('new document shortcut accepts dead key but ignores composing and modified or editable targets', () => {
  const shortcut = { metaKey: true, altKey: true, code: 'KeyN', key: 'Dead' };
  assert.equal(isNewDocShortcut(shortcut), true);
  assert.equal(isNewDocShortcut({ ...shortcut, isComposing: true }), false);
  assert.equal(isNewDocShortcut({ ...shortcut, shiftKey: true }), false);
  assert.equal(isNewDocShortcut({ ...shortcut, ctrlKey: true }), false);
  assert.equal(isNewDocShortcut({ ...shortcut, target: { tagName: 'INPUT' } }), false);
  assert.equal(isNewDocShortcut({ ...shortcut, target: { isContentEditable: true } }), false);
});

test('groupDocs groups by top-level folder, root docs last as 기타, names keep nested paths', () => {
  const docs = [
    { id: 'b-project/z.hwp', format: 'hwp' },
    { id: 'a-project/sub/a.hwpx', format: 'hwpx' },
    { id: 'a-project/b.hwp', format: 'hwp' },
    { id: 'root.hwp', format: 'hwp' },
  ];
  const { primary: groups, external } = groupDocs(docs);
  assert.deepEqual(external, []);
  assert.deepEqual(groups.map((g) => g.key), ['a-project', 'b-project', '']);
  assert.equal(groups[2].label, '기타');
  assert.deepEqual(groups[0].docs.map((d) => d.name), ['b.hwp', 'sub/a.hwpx']);
  assert.equal(groups[0].docs[1].id, 'a-project/sub/a.hwpx');
});

test('displayName shows folder label and path for external ids, raw id otherwise', () => {
  const key = '5cbf9b36-467f-42e7-847f-40c018f72bb1';
  const external = [{ key: `ext://${key}`, label: '자료', docs: [] }];
  assert.equal(displayName(`ext://${key}/하위/a.hwpx`, external), '자료/하위/a.hwpx');
  assert.equal(displayName(`ext://${key}/a.hwpx`, []), 'a.hwpx');
  assert.equal(displayName('프로젝트/b.hwp', external), '프로젝트/b.hwp');
});

test('groupDocs sorts groups and docs with ko localeCompare', () => {
  const { primary: groups } = groupDocs([
    { id: '다/b.hwp', format: 'hwp' }, { id: '가/a.hwp', format: 'hwp' },
  ]);
  assert.deepEqual(groups.map((g) => g.key), ['가', '다']);
});

test('groupDocs includes empty projects as empty groups', () => {
  const { primary: groups } = groupDocs([{ id: 'a/x.hwp', format: 'hwp' }], ['a', 'empty-proj']);
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
  assert.equal(groupKeyOf('ext://11111111-1111-4111-8111-111111111111/a.hwpx'), 'ext://11111111-1111-4111-8111-111111111111');
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
    const { primary: groups } = groupDocs([{ id: 'samples/a.hwp', format: 'hwp' }, { id: 'samples/b.hwpx', format: 'hwpx' }], ['samples']);
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

test('renderProjects exposes rename button and context menu with the exact document id', () => {
  globalThis.document = { createElement: fakeElement, createElementNS: (_ns, tag) => fakeElement(tag) };
  try {
    const key = '11111111-1111-4111-8111-111111111111';
    const id = `ext://${key}/nested/a.hwp`;
    const { primary, external } = groupDocs([
      { id: 'P/a.hwp', format: 'hwp' }, { id, format: 'hwp' },
    ], ['P'], [{ key, label: '외부', path: '/tmp/external', available: true }]);
    const seen = [];
    for (const groups of [primary, external]) {
      const list = fakeElement('ul');
      renderProjects(list, groups, { onRename: candidate => seen.push(candidate) });
      const nodes = walk(list);
      const rename = nodes.find(node => node.className === 'doc-rename');
      const row = nodes.find(node => node.className === 'doc-row');
      assert.ok(rename);
      assert.match(rename.getAttribute('aria-label'), /이름 바꾸기$/);
      rename.listeners.click[0]();
      let prevented = false;
      row.listeners.contextmenu[0]({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    }
    assert.deepEqual(seen, ['P/a.hwp', 'P/a.hwp', id, id]);
  } finally { delete globalThis.document; }
});

test('external ids group by UUID and unavailable roots retain label, path, and reason', () => {
  globalThis.document = { createElement: fakeElement, createElementNS: (_ns, tag) => fakeElement(tag) };
  try {
    const key = '11111111-1111-4111-8111-111111111111';
    const emptyKey = '22222222-2222-4222-8222-222222222222';
    const { primary, external } = groupDocs([{ id: `ext://${key}/a.hwpx`, format: 'hwpx' }], [], [
      { key, label: '자료', path: '/tmp/자료', available: false, reason: 'MISSING' },
      { key: emptyKey, label: '교체', path: '/tmp/교체', available: false, reason: 'REPLACED' },
    ]);
    assert.deepEqual(primary, []);
    assert.deepEqual(external.map(g => g.key), [`ext://${key}`, `ext://${emptyKey}`]);
    assert.deepEqual(external[0].docs.map(d => d.name), ['a.hwpx']);
    const list = fakeElement('ul');
    let imports = 0;
    renderProjects(list, external, { onImport: () => { imports++; } });
    const nodes = walk(list);
    const headers = nodes.filter(n => n.className === 'group-header');
    assert.deepEqual(headers.map(h => h.title), ['/tmp/자료', '/tmp/교체']);
    assert.deepEqual(headers.map(h => h.dataset.reason), ['MISSING', 'REPLACED']);
    assert.match(headers[0].getAttribute('aria-label'), /찾을 수 없음.*추가한 폴더/);
    assert.match(headers[1].getAttribute('aria-label'), /다른 폴더로 바뀜.*추가한 폴더/);
    const docButton = nodes.find(n => n.className === 'doc');
    assert.equal(docButton.dataset.id, `ext://${key}/a.hwpx`);
    assert.equal(docButton.title, '자료/a.hwpx', 'tooltip hides the internal ext:// id');
    assert.equal(docButton.getAttribute('aria-label'), '자료/a.hwpx');
    assert.equal(imports, 0);
  } finally { delete globalThis.document; }
});
