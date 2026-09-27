// 프로젝트 그룹 목록(wp5). 문서함 최상위 폴더가 프로젝트, 루트 파일은 '기타' 그룹(키 '')으로 맨 뒤.
const COLLAPSED_KEY = 'lidge-hwp.projects.collapsed';
export const ROOT_GROUP = '';
export const ROOT_LABEL = '기타';

const icon = (paths) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
};
// lucide: chevron-right / folder
export const chevron = () => icon('<path d="m9 18 6-6-6-6"/>');
export const folder = () => icon('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>');

export function groupDocs(docs, projects = [], roots = []) {
  const groups = new Map(projects.map((name) => [name, []]));
  const external = new Map(roots.map(root => [root.key, { key: `ext://${root.key}`,
    label: root.label, path: root.path, available: root.available, reason: root.reason,
    kind: 'external', docs: [] }]));
  for (const doc of docs) {
    const match = /^ext:\/\/([0-9a-f-]{36})\/(.+)$/i.exec(doc.id);
    if (match) {
      const group = external.get(match[1]);
      if (group) group.docs.push({ id: doc.id, name: match[2], format: doc.format });
      continue;
    }
    const slash = doc.id.indexOf('/');
    const key = slash < 0 ? ROOT_GROUP : doc.id.slice(0, slash);
    const name = slash < 0 ? doc.id : doc.id.slice(slash + 1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: doc.id, name, format: doc.format });
  }
  const primary = [...groups.entries()]
    .map(([key, list]) => ({ key, label: key || ROOT_LABEL, kind: 'primary',
      docs: list.sort((a, b) => a.name.localeCompare(b.name, 'ko')) }))
    .sort((a, b) => (a.key === ROOT_GROUP) - (b.key === ROOT_GROUP)
      || a.label.localeCompare(b.label, 'ko'));
  return { primary, external: [...external.values()].map(group => ({ ...group,
    docs: group.docs.sort((a, b) => a.name.localeCompare(b.name, 'ko')) })) };
}

export const groupKeyOf = (id) => {
  const match = /^ext:\/\/([0-9a-f-]{36})\//i.exec(id);
  return match ? `ext://${match[1]}` : id.includes('/') ? id.slice(0, id.indexOf('/')) : ROOT_GROUP;
};

export function createGroupFor(groups, selectedKey, currentId) {
  const selected = selectedKey === null ? null : groups.find((g) => g.key === selectedKey);
  const active = currentId ? groups.find((g) => g.key === groupKeyOf(currentId)) : null;
  const group = selected ?? active;
  if (!group || group.key === '') return { kind: 'default' };
  return group.kind === 'external' ? { kind: 'external', key: group.key.slice('ext://'.length) }
    : { kind: 'project', name: group.key };
}

// 사람이 읽는 문서 이름. 외부 문서는 내부 id(ext://<UUID>/...) 대신 "폴더 이름/상대경로"로 보인다.
export function displayName(id, externalGroups = []) {
  const match = /^ext:\/\/([0-9a-f-]{36})\/(.+)$/i.exec(id || '');
  if (!match) return id;
  const group = externalGroups.find(g => g.key === `ext://${match[1]}`);
  return group ? `${group.label}/${match[2]}` : match[2];
}

// macOS 파일명이 NFD로 들어올 수 있어 양쪽을 NFC로 맞춘 뒤 소문자 부분 문자열로 비교한다.
export function matchDoc(doc, query) {
  const q = (query || '').normalize('NFC').trim().toLowerCase();
  return !q || doc.id.normalize('NFC').toLowerCase().includes(q);
}

export function readCollapsedGroups(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(COLLAPSED_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((key) => typeof key === 'string') : []);
  } catch { return new Set(); } // 저장소 없음·깨진 JSON 모두 접힘 없음으로
}

export function writeCollapsedGroups(collapsed, storage = globalThis.localStorage) {
  try { storage?.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* 저장소 없음 */ }
}

// listEl 아래에 그룹 헤더(펼침 버튼)+문서 버튼(data-id)을 그린다.
// query가 있으면 일치하는 그룹만 펼친 채로 보여 주고 접힘 저장소는 건드리지 않는다.
export function renderProjects(listEl, groups, { currentId = null, collapsed = new Set(),
    query = '', onOpen = () => {}, onToggle = () => {}, groupActions = null, onImport = null,
    onRename = () => {}, edit = null, onEditInput = () => {}, onEditKey = () => {},
    onEditBlur = () => {}, showEmpty = true,
    emptyLabel = '문서함에 HWP/HWPX가 없습니다.' } = {}) {
  listEl.textContent = '';
  let shown = 0;
  const filtering = matchDoc({ id: '' }, query) === false;
  const visibleGroups = edit?.kind === 'new' && edit.groupKey === '' && !groups.some(g => g.key === '')
    ? [...groups, { key: '', label: ROOT_LABEL, kind: 'primary', docs: [] }] : groups;
  const appendEdit = (body, editState, badgeText) => {
    const row = document.createElement('li');
    row.className = `doc-row ${editState.kind === 'new' ? 'new-doc-row' : 'renaming'}`;
    row.dataset.edit = 'true';
    if (editState.id) row.dataset.id = editState.id;
    if (editState.pending) row.setAttribute('aria-busy', 'true');
    const slot = document.createElement('div'); slot.className = 'doc-edit';
    const wrap = document.createElement('span'); wrap.className = 'edit-name';
    const input = document.createElement('input');
    input.type = 'text'; input.className = editState.kind === 'new' ? 'new-doc-input' : 'rename-input';
    input.value = editState.draft;
    input.readOnly = !!editState.pending;
    input.setAttribute('aria-label', editState.kind === 'new' ? '새 문서 이름' : `${editState.label} 새 이름`);
    if (editState.error) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'doc-name-error'); }
    input.addEventListener('input', () => onEditInput(input));
    input.addEventListener('keydown', event => onEditKey(event, input));
    input.addEventListener('blur', event => onEditBlur(event, input));
    input.addEventListener('compositionstart', () => { editState.composing = true; editState.imeJustEnded = false; });
    input.addEventListener('compositionend', () => { editState.composing = false; editState.imeJustEnded = true;
      input.addEventListener('keyup', () => { editState.imeJustEnded = false; }, { once: true }); });
    wrap.append(input);
    const suffix = document.createElement('span'); suffix.className = 'doc-extension'; suffix.textContent = editState.extension;
    wrap.append(suffix); slot.append(wrap);
    const badge = document.createElement('span'); badge.className = 'badge'; badge.setAttribute('aria-hidden', 'true');
    badge.textContent = badgeText; slot.append(badge); row.append(slot);
    if (editState.error) {
      const message = document.createElement('div'); message.id = 'doc-name-error';
      message.className = 'name-error'; message.setAttribute('role', 'alert'); message.textContent = editState.error;
      row.append(message);
    }
    body.append(row);
  };
  for (const group of visibleGroups) {
    const docs = group.docs.filter((doc) => matchDoc(doc, query));
    const newHere = edit?.kind === 'new' && edit.groupKey === group.key;
    if (filtering && docs.length === 0 && !newHere) continue;
    const expanded = filtering || !collapsed.has(group.key);
    shown += docs.length + Number(newHere);
    const item = document.createElement('li');
    item.className = 'group';
    const row = document.createElement('div');
    row.className = 'group-row';
    const bodyId = `group-body-${group.key ? encodeURIComponent(group.key) : 'root'}`;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'group-header';
    header.dataset.group = group.key;
    header.setAttribute('aria-expanded', String(expanded));
    header.setAttribute('aria-controls', bodyId);
    header.title = group.path ?? group.label;
    if (group.available === false && group.reason) header.dataset.reason = group.reason;
    header.append(chevron());
    const chev = header.firstChild;
    chev.classList.add('chevron');
    header.append(folder());
    const label = document.createElement('span');
    label.className = 'group-label';
    const reasonLabel = group.reason === 'MISSING' ? '찾을 수 없음'
      : group.reason === 'REPLACED' ? '다른 폴더로 바뀜' : '접근 불가';
    label.textContent = group.label;
    const count = document.createElement('span');
    count.className = 'count';
    count.setAttribute('aria-hidden', 'true');
    count.textContent = String(group.docs.length);
    header.append(label);
    if (group.available === false) {
      const reason = document.createElement('span'); reason.className = 'group-reason'; reason.textContent = reasonLabel;
      header.append(reason);
    }
    header.append(count);
    header.setAttribute('aria-label', `${group.label}${group.available === false ? ` (${reasonLabel})` : ''} ${group.kind === 'external' ? '추가한 폴더' : '프로젝트'}, 문서 ${group.docs.length}개`);
    header.addEventListener('click', () => onToggle(group.key, !expanded));
    row.append(header);
    if (groupActions) {
      const actions = groupActions(group);
      if (actions) row.append(actions);
    }
    item.append(row);
    if (onImport && group.kind === 'primary' && group.key !== ROOT_GROUP) {
      // 파일을 그룹 위에 놓으면 그 프로젝트로 가져온다. 파일 드래그일 때만 반응한다.
      const isFileDrag = (event) => event.dataTransfer?.types?.includes('Files');
      item.addEventListener('dragover', (event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        item.classList.add('drop');
      });
      item.addEventListener('dragleave', (event) => {
        // 자식 요소 사이 이동의 dragleave는 무시한다(하이라이트 깜빡임 방지).
        if (event.relatedTarget && item.contains(event.relatedTarget)) return;
        item.classList.remove('drop');
      });
      item.addEventListener('drop', (event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        item.classList.remove('drop');
        if (event.dataTransfer?.files?.length) onImport(group.key, event.dataTransfer.files);
      });
    }
    const body = document.createElement('ul');
    body.id = bodyId;
    body.className = 'group-docs';
    body.hidden = !expanded;
    if (newHere) appendEdit(body, edit, 'HWP');
    for (const doc of docs) {
      if (edit?.kind === 'rename' && edit.id === doc.id) { appendEdit(body, edit, doc.format.toUpperCase()); continue; }
      const row = document.createElement('li');
      row.className = 'doc-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'doc';
      button.dataset.id = doc.id;
      // 스크린리더·자동화가 문서를 전체 경로로 구별하게 한다(형식 배지는 읽지 않음).
      // 외부 문서는 내부 id(ext://<UUID>/...) 대신 "폴더 이름/경로"를 쓴다. 식별은 data-id가 맡는다.
      const shown = group.kind === 'external' ? `${group.label}/${doc.name}` : doc.id;
      button.title = shown;
      button.setAttribute('aria-label', shown);
      button.setAttribute('aria-current', String(doc.id === currentId));
      const name = document.createElement('span');
      name.className = 'doc-name';
      name.textContent = doc.name;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = doc.format.toUpperCase();
      button.append(name, badge);
      button.addEventListener('click', () => onOpen(doc.id));
      row.append(button);
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'doc-rename';
      rename.textContent = '이름';
      rename.title = `${shown} 이름 바꾸기 (F2, ⌘⇧R)`;
      rename.setAttribute('aria-label', `${shown} 이름 바꾸기`);
      rename.setAttribute('aria-keyshortcuts', 'F2 Meta+Shift+R');
      rename.addEventListener('click', () => onRename(doc.id));
      row.append(rename);
      row.addEventListener('contextmenu', event => { event.preventDefault(); onRename(doc.id); });
      body.append(row);
    }
    item.append(body);
    if (group.available === false) {
      const unavailable = document.createElement('p'); unavailable.className = 'group-unavailable';
      unavailable.textContent = '폴더에 접근할 수 없습니다 · 경로 확인 또는 등록 해제';
      item.append(unavailable);
    }
    listEl.append(item);
  }
  if (shown === 0 && showEmpty && emptyLabel) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = filtering ? '일치하는 문서가 없습니다' : emptyLabel;
    listEl.append(empty);
  }
}

// 목록 안 화살표 키 이동. ↑↓는 보이는 버튼(헤더·문서) 사이를, 문서의 ←는 그룹 헤더로,
// 헤더의 ←→는 접기·펼치기다.
export function bindListKeys(listEl, onToggle) {
  listEl.addEventListener('keydown', (event) => {
    const visible = [...listEl.querySelectorAll('button')]
      .filter((b) => !b.closest('.group-docs[hidden]') && !b.closest('[hidden]'));
    const index = visible.indexOf(event.target);
    if (index < 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      visible[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const target = event.target;
      if (target.classList.contains('doc')) {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          target.closest('.group')?.querySelector('.group-header')?.focus();
        }
        return;
      }
      if (!target.classList.contains('group-header')) return;
      const expanded = target.getAttribute('aria-expanded') === 'true';
      event.preventDefault();
      if (event.key === 'ArrowLeft' && expanded) onToggle(target.dataset.group, false);
      else if (event.key === 'ArrowRight' && !expanded) onToggle(target.dataset.group, true);
    }
  });
}
