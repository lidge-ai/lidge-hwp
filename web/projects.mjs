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

export function groupDocs(docs, projects = []) {
  const groups = new Map(projects.map((name) => [name, []]));
  for (const doc of docs) {
    const slash = doc.id.indexOf('/');
    const key = slash < 0 ? ROOT_GROUP : doc.id.slice(0, slash);
    const name = slash < 0 ? doc.id : doc.id.slice(slash + 1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: doc.id, name, format: doc.format });
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, label: key || ROOT_LABEL,
      docs: list.sort((a, b) => a.name.localeCompare(b.name, 'ko')) }))
    .sort((a, b) => (a.key === ROOT_GROUP) - (b.key === ROOT_GROUP)
      || a.label.localeCompare(b.label, 'ko'));
}

export const groupKeyOf = (id) => id.includes('/') ? id.slice(0, id.indexOf('/')) : ROOT_GROUP;

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
    query = '', onOpen = () => {}, onToggle = () => {}, groupActions = null, onImport = null } = {}) {
  listEl.textContent = '';
  let shown = 0;
  const filtering = matchDoc({ id: '' }, query) === false;
  for (const group of groups) {
    const docs = group.docs.filter((doc) => matchDoc(doc, query));
    if (filtering && docs.length === 0) continue;
    const expanded = filtering || !collapsed.has(group.key);
    shown += docs.length;
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
    header.title = group.label;
    header.append(chevron());
    const chev = header.firstChild;
    chev.classList.add('chevron');
    header.append(folder());
    const label = document.createElement('span');
    label.className = 'group-label';
    label.textContent = group.label;
    const count = document.createElement('span');
    count.className = 'count';
    count.setAttribute('aria-hidden', 'true');
    count.textContent = String(group.docs.length);
    header.append(label, count);
    header.setAttribute('aria-label', `${group.label} 프로젝트, 문서 ${group.docs.length}개`);
    header.addEventListener('click', () => onToggle(group.key, !expanded));
    row.append(header);
    if (groupActions) {
      const actions = groupActions(group);
      if (actions) row.append(actions);
    }
    item.append(row);
    if (onImport && group.key !== ROOT_GROUP) {
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
    for (const doc of docs) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'doc';
      button.dataset.id = doc.id;
      button.title = doc.id;
      // 스크린리더·자동화가 문서를 전체 경로로 구별하게 한다(형식 배지는 읽지 않음).
      button.setAttribute('aria-label', doc.id);
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
      body.append(row);
    }
    item.append(body);
    listEl.append(item);
  }
  if (shown === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = filtering ? '일치하는 문서가 없습니다' : '문서함에 HWP/HWPX가 없습니다.';
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
