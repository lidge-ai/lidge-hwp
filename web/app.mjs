import { createStudio } from '/editor/index.js';
import { startAgentChannel } from '/agent-channel.mjs';
import { followSwitch } from '/follow-switch.mjs';
import { initSidebar } from '/sidebar.mjs';
import { groupDocs, groupKeyOf, renderProjects, readCollapsedGroups, writeCollapsedGroups, bindListKeys, displayName } from '/projects.mjs';

initSidebar();

const docFilter = document.querySelector('#doc-filter');
const refreshButton = document.querySelector('#docs-refresh');
const projectAdd = document.querySelector('#project-add');
const folderAdd = document.querySelector('#folder-add');

const list = document.querySelector('#docs');
const externalList = document.querySelector('#external-docs');
const status = document.querySelector('#status');
const filename = document.querySelector('#filename');
const saveButton = document.querySelector('#save');
let studio;
let current = null;
let saving = false;
let agentLocked = false;
let opening = 0;                   // 줄에 선 openDoc 수. AI 전환 판정(canFollow)이 본다
let openQueue = Promise.resolve(); // 사람 클릭과 AI 전환(agent.follow)을 한 줄로 세운다
const setSaveLocked = on => { agentLocked = on; saveButton.disabled = on || saving || !current; };

function say(message) { status.textContent = message; status.title = message; } // 한 줄로 잘려도 전체는 title로

async function api(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let code = `HTTP ${response.status}`;
    try { code = (await response.json()).error?.code || code; } catch { /* binary error */ }
    throw new Error(code);
  }
  return response;
}
const docUrl = (id) => `/api/docs/${encodeURIComponent(id)}`;
async function release(tab) {
  // 에이전트 작업 중이거나 격리된 탭이면 AGENT_BUSY/LEASE_ISOLATED를 던진다. openDocNow가 전환을 멈춘다.
  await tab.stopAgent?.();
  tab.events?.close();
  await fetch(`/api/tabs/${encodeURIComponent(tab.lease)}`, { method: 'DELETE' });
}

// 문서 열기는 한 번에 하나씩. AI 전환과 사람 클릭이 섞여도 앞의 전환이 끝난 뒤에 다음이 시작한다.
function openDoc(id, options = {}) {
  opening += 1;
  const run = openQueue.then(() => openDocNow(id, options)).finally(() => { opening -= 1; });
  openQueue = run.catch(() => {});
  return run;
}

// 사람 전환은 switchTo를 바로 부른다. AI 전환(agent.follow 수락)은 followSwitch가 전체를 감싸서, 어느 단계에서
// 던지거나 실패해도 예약 반납·입력 차단 복구·상태줄 알림을 한다(web/follow-switch.mjs).
function openDocNow(id, { reservation = null, agent = false } = {}) {
  if (!agent) return switchTo(id).catch(error => { say(`열기 실패: ${error.message}`); return false; });
  return followSwitch({ id, reservation, element: studio.element, switchTo, say,
    hasCurrent: () => current !== null,
    giveBack: token => fetch(`/api/tabs/reservations/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => {}) });
}

// 문서 하나로 바꾼다. 새 문서가 열렸으면 true. AI 전환(agent)은 멈출 이유를 던지고(followSwitch가 정리),
// 사람 전환은 상태줄에 알리고 false를 돌려준다.
async function switchTo(id, { reservation = null, agent = false } = {}) {
  if (saving) { if (agent) throw new Error('SAVING'); return false; }
  if (current?.id === id) { if (agent) throw new Error('ALREADY_OPEN'); return false; }
  if (current && (await studio.getDocumentState()).dirty) {
    if (agent) throw new Error('DIRTY'); // AI 전환은 확인 창을 띄우지 않는다
    if (!confirm('저장하지 않은 편집을 버리고 다른 문서를 여시겠습니까?')) return false;
  }
  let next;
  const previous = current;
  if (previous) {
    // 이전 문서를 먼저 정리한다. release()가 stopAgent()를 await하며,
    // AGENT_BUSY·LEASE_ISOLATED면 던지고 전환을 중단한다(선택 표시는 그대로 이전 문서).
    try { await release(previous); }
    catch (error) {
      if (agent) throw error; // followSwitch가 inert를 전환 전 값(격리 탭이면 true)으로 되돌린다
      say(`전환 취소: ${error.message}`);
      return false;
    }
    current = null;
    saveButton.disabled = true;
  }
  try {
    say(agent ? `AI가 ${nameOf(id)}를 편집하려 해서 그 문서로 전환하는 중` : '문서를 여는 중');
    const response = await api(docUrl(id));
    const bytes = await response.arrayBuffer();
    const etag = response.headers.get('ETag');
    const format = response.headers.get('X-Document-Format');
    if (!etag || !['hwp', 'hwpx'].includes(format)) throw new Error('Invalid document response');
    const leaseResponse = await api('/api/tabs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reservation ? { docId: id, reservation } : { docId: id }) });
    const { lease } = await leaseResponse.json();
    next = { id, etag, format, lease, events: null, stopAgent: null };
    // loadFile이 끝날 때까지 SSE를 열지 않는다. 그동안 서버는 이 탭을 "여는 중"으로 보고 runner는 붙기를 기다린다.
    await studio.loadFile(bytes, id.split('/').at(-1));
    const tab = next;
    tab.events = new EventSource(`/api/events?lease=${encodeURIComponent(lease)}`);
    tab.events.addEventListener('error', () => { saveButton.disabled = true; say('연결이 끊겼습니다. 문서를 다시 여세요.'); });
    // 같은 틱에 리스너를 붙이므로 첫 SSE 이벤트를 놓치지 않는다.
    tab.stopAgent = startAgentChannel({ editor: studio, events: tab.events, docId: id, lease,
      getDiskSha: () => tab.etag.slice(1, -1),
      setDiskSha: sha => { tab.etag = `"${sha}"`; },
      showStatus: say, setSaveLocked,
      putDocument: async (docId, body, meta) => {
        const response = await api(docUrl(docId), { method: 'PUT', body, headers: {
          'Content-Type': 'application/octet-stream', 'If-Match': `"${meta.ifMatch}"`,
          'X-Lease': meta.lease, 'X-Document-Format': meta.format,
          'X-Content-Loss-Report': btoa(JSON.stringify(meta.contentLoss)),
          'X-Agent-Request-Id': meta.agentRequestId,
        } });
        const saved = await response.json();
        tab.etag = `"${saved.sha256}"`;
        return saved;
      },
      // agent.follow 판정. 저장 중·다른 전환 중·저장 안 한 편집이면 거절 코드, 아니면 null(수락).
      canFollow: async () => saving ? 'SAVING' : opening > 0 ? 'BUSY'
        : (await studio.getDocumentState()).dirty ? 'DIRTY' : null,
      onFollow: (targetId, token) => openDoc(targetId, { reservation: token, agent: true }),
    });
    current = next;
    delete document.body.dataset.noDocument;
    studio.element.inert = false;
    filename.textContent = nameOf(id); filename.title = id;
    saveButton.disabled = agentLocked;
    for (const button of document.querySelectorAll('#docs button[data-id], #external-docs button[data-id]')) button.setAttribute('aria-current', String(button.dataset.id === id));
    // 방금 연 문서의 그룹이 접혀 있으면 펼치고 활성 버튼이 보이게 한다.
    expandGroup(groupKeyOf(id));
    renderDocs();
    const activeButton = document.querySelector('#docs button[aria-current="true"], #external-docs button[aria-current="true"]');
    activeButton?.scrollIntoView({ block: 'nearest' });
    if (openHadListFocus) activeButton?.focus();
    openHadListFocus = false;
    say(agent ? `${nameOf(id)} 열림 · AI 편집을 기다리는 중` : `${nameOf(id)} 열림`);
    return true;
  } catch (error) {
    // AI 전환이면 runner가 FOLLOW_LOAD_FAILED로 알아채고, followSwitch가 예약을 돌려준다.
    if (next && current !== next) await release(next).catch(() => {});
    if (!current) {
      // 이전 문서는 이미 반납했다. 화면에 남은 옛 문서를 편집·저장할 수 없게 덮고, 목록에서 다시 고르게 한다.
      filename.textContent = ''; filename.title = '';
      saveButton.disabled = true;
      for (const button of document.querySelectorAll('#docs button[data-id], #external-docs button[data-id]')) button.setAttribute('aria-current', 'false');
      document.body.dataset.noDocument = 'true'; // CSS: [data-no-document] #studio { pointer-events:none; opacity:.35 } + 안내 오버레이
      studio.element.inert = true; // 포커스·키보드 입력까지 막는다(iframe은 pointer-events만으로 키 입력이 막히지 않음)
      studio.element.blur?.();
    }
    // AI 전환은 알림을 followSwitch 한 곳이 맡는다(중복 알림·구체 사유 덮어쓰기 방지). 화면 정리만 하고 던진다.
    if (agent) throw error;
    say(error.message === 'DOCUMENT_LOCKED'
      ? `${nameOf(id)}는 AI가 편집 중입니다 · 끝난 뒤 목록에서 다시 여세요`
      : `열기 실패: ${error.message} · 목록에서 문서를 다시 선택하세요`);
    return false;
  }
}

async function save() {
  if (!current || saving || agentLocked) return;
  saving = true;
  saveButton.disabled = true;
  const tab = current;
  try {
    say('저장 중');
    const exported = await studio.lidge.request('exportWithReport', { format: tab.format });
    if (exported.contentLoss.count !== 0 || exported.contentLoss.losses.length !== 0) throw new Error('CONTENT_LOSS');
    const report = btoa(JSON.stringify(exported.contentLoss));
    const response = await api(docUrl(tab.id), { method: 'PUT', headers: {
      'Content-Type': 'application/octet-stream', 'If-Match': tab.etag,
      'X-Lease': tab.lease, 'X-Document-Format': tab.format,
      'X-Content-Loss-Report': report,
    }, body: exported.bytes });
    const result = await response.json();
    tab.etag = `"${result.sha256}"`;
    say(`커밋 ${result.commit} · ${tab.id}`);
    try { await studio.notifySaved(tab.id.split('/').at(-1)); }
    catch (error) { say(`파일 커밋 ${result.commit} 완료, 편집기 상태 갱신 실패: ${error.message}`); }
  } catch (error) { say(`저장 실패: ${error.message}`); }
  finally { saving = false; saveButton.disabled = !current || agentLocked; }
}

// 프로젝트 그룹 상태(wp5). 접힌 그룹 키는 localStorage에, 필터는 세션에만 둔다.
let groups = [];
let externalGroups = [];
const nameOf = id => displayName(id, externalGroups);
let collapsedGroups = readCollapsedGroups();
let openHadListFocus = false; // 목록에서 연 열기는 loadFile이 iframe으로 뺏은 포커스를 목록에 돌려놓는다
const PROJECT_ERRORS = { PROJECT_EXISTS: '이미 있는 프로젝트입니다', INVALID_PROJECT: '쓸 수 없는 이름입니다' };
const iconSvg = (paths) => {
  const span = document.createElement('span');
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">${paths}</svg>`;
  return span.firstChild;
};
const expandGroup = (key) => { if (collapsedGroups.delete(key)) writeCollapsedGroups(collapsedGroups); };
function renderDocs() {
  // 목록을 다시 그리면 노드가 교체되어 포커스가 날아간다. 포커스가 목록 안에 있었으면
  // 같은 문서 버튼·그룹 헤더로 복원하고, 없어졌으면 활성 문서 버튼으로 보낸다.
  const active = document.activeElement;
  const activeList = list.contains(active) ? list : externalList.contains(active) ? externalList : null;
  const selector = active?.dataset?.id ? `button[data-id="${CSS.escape(active.dataset.id)}"]`
    : active?.classList?.contains('group-header') ? `.group-header[data-group="${CSS.escape(active.dataset.group)}"]`
    : null;
  renderProjects(list, groups, {
    currentId: current?.id ?? null, collapsed: collapsedGroups, query: docFilter.value,
    onOpen: (id) => { openHadListFocus = list.contains(document.activeElement); void openDoc(id); },
    onToggle: (key, expanded) => {
      if (expanded) collapsedGroups.delete(key); else collapsedGroups.add(key);
      writeCollapsedGroups(collapsedGroups);
      renderDocs();
    },
    // '기타' 그룹(루트 문서)에는 가져오기 버튼을 달지 않는다.
    groupActions: (group) => {
      if (group.key === '') return null;
      const upload = document.createElement('button');
      upload.type = 'button';
      upload.className = 'group-upload';
      upload.setAttribute('aria-label', `${group.key} 프로젝트로 문서 가져오기`);
      upload.title = `${group.key} 프로젝트로 문서 가져오기`;
      upload.append(iconSvg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'));
      upload.addEventListener('click', () => pickFiles(group.key));
      return upload;
    },
    onImport: (key, files) => { void importFiles(key, files); },
  });
  renderProjects(externalList, externalGroups, {
    currentId: current?.id ?? null, collapsed: collapsedGroups, query: docFilter.value,
    emptyLabel: externalGroups.length === 0 ? '추가한 폴더가 없습니다.' : '추가한 폴더에 HWP/HWPX가 없습니다.',
    onOpen: id => { openHadListFocus = externalList.contains(document.activeElement); void openDoc(id); },
    onToggle: (key, expanded) => {
      if (expanded) collapsedGroups.delete(key); else collapsedGroups.add(key);
      writeCollapsedGroups(collapsedGroups); renderDocs();
    },
    groupActions: group => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'group-remove';
      button.setAttribute('aria-label', `${group.label} 폴더 제거`);
      button.title = `${group.path} 등록 해제`;
      button.textContent = '×';
      button.addEventListener('click', () => { void removeFolder(group); });
      return button;
    },
  });
  if (activeList) {
    (selector && activeList.querySelector(selector)
      || document.querySelector('#docs button[aria-current="true"], #external-docs button[aria-current="true"]'))?.focus();
  }
}
async function loadDocs() {
  const response = await api('/api/docs');
  const { docs, projects = [], roots = [] } = await response.json();
  ({ primary: groups, external: externalGroups } = groupDocs(docs, projects, roots));
  renderDocs();
  say(docs.length === 0 ? '문서함에 HWP/HWPX가 없습니다.' : '문서를 선택하세요.');
}
bindListKeys(list, (key, expanded) => {
  if (expanded) collapsedGroups.delete(key); else collapsedGroups.add(key);
  writeCollapsedGroups(collapsedGroups);
  renderDocs();
  list.querySelector(`.group-header[data-group="${CSS.escape(key)}"]`)?.focus();
});
bindListKeys(externalList, (key, expanded) => {
  if (expanded) collapsedGroups.delete(key); else collapsedGroups.add(key);
  writeCollapsedGroups(collapsedGroups); renderDocs();
  externalList.querySelector(`.group-header[data-group="${CSS.escape(key)}"]`)?.focus();
});
docFilter.addEventListener('input', renderDocs);
docFilter.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && docFilter.value) { docFilter.value = ''; renderDocs(); event.stopPropagation(); }
});
refreshButton.addEventListener('click', () => { loadDocs().catch((error) => say(`목록 새로고침 실패: ${error.message}`)); });
folderAdd.addEventListener('click', async () => {
  if (folderAdd.disabled) return;
  folderAdd.disabled = true;
  try {
    const response = await api('/api/roots/pick', { method: 'POST' });
    if (response.status === 204) { say('폴더 선택 취소'); return; }
    const { root } = await response.json();
    await loadDocs();
    externalList.querySelector(`.group-header[data-group="${CSS.escape(`ext://${root.key}`)}"]`)?.focus();
    say(`${root.label} 폴더 추가`);
  } catch (error) { say(`폴더 추가 실패: ${error.message}`); }
  finally { folderAdd.disabled = false; }
});
async function removeFolder(group) {
  if (!confirm(`${group.label} 폴더를 목록에서 제거하시겠습니까? 파일과 이력은 남습니다.`)) return;
  try {
    await api(`/api/roots/${encodeURIComponent(group.key.slice('ext://'.length))}`, { method: 'DELETE' });
    await loadDocs(); folderAdd.focus(); say(`${group.label} 폴더 등록 해제`);
  } catch (error) { say(`폴더 제거 실패: ${error.message}`); }
}

// 새 프로젝트: "+"가 목록 맨 위에 인라인 입력 행을 연다. IME 조합 중 Enter는 제출이 아니라 조합 확정이다.
projectAdd.addEventListener('click', () => {
  if (list.querySelector('.create-row')) return;
  const row = document.createElement('li');
  row.className = 'create-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '프로젝트 이름';
  input.setAttribute('aria-label', '새 프로젝트 이름');
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !composing && !event.isComposing) void createProject(input.value, row);
    else if (event.key === 'Escape') row.remove();
  });
  input.addEventListener('blur', () => { if (!input.value.trim()) row.remove(); });
  row.append(input);
  list.prepend(row);
  input.focus();
});
async function createProject(name, row) {
  try {
    const { project } = await (await api('/api/projects', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();
    row.remove();
    expandGroup(project);
    await loadDocs();
    list.querySelector(`.group-header[data-group="${CSS.escape(project)}"]`)?.focus();
    say(`프로젝트 ${project} 생성`);
  } catch (error) { say(PROJECT_ERRORS[error.message] || `프로젝트 생성 실패: ${error.message}`); }
}

// 그룹 밖에 파일을 놓으면 브라우저가 파일로 이동해 미저장 편집을 잃는다. 파일 드래그만 기본 동작을 막는다.
const fileDrag = (event) => event.dataTransfer?.types?.includes('Files');
document.addEventListener('dragover', (event) => { if (fileDrag(event)) event.preventDefault(); });
document.addEventListener('drop', (event) => { if (fileDrag(event)) event.preventDefault(); });

const filePicker = document.createElement('input');
filePicker.type = 'file';
filePicker.accept = '.hwp,.hwpx';
filePicker.multiple = true;
filePicker.hidden = true;
document.body.append(filePicker);
let pickTarget = null;
function pickFiles(project) {
  pickTarget = project;
  filePicker.value = '';
  filePicker.click();
}
filePicker.addEventListener('change', () => {
  if (pickTarget && filePicker.files.length) void importFiles(pickTarget, filePicker.files);
  pickTarget = null;
});
const IMPORT_ERRORS = { INVALID_FORMAT: 'HWP/HWPX만 가져올 수 있습니다', INVALID_BYTES: '파일이 손상되었거나 형식이 다릅니다',
  DOC_EXISTS: '같은 이름의 문서가 있습니다', PROJECT_NOT_FOUND: '프로젝트를 찾을 수 없습니다' };
async function importFiles(project, files) {
  const done = [];
  const failed = [];
  for (const file of files) {
    try {
      const result = await (await api(`/api/projects/${encodeURIComponent(project)}/docs`, { method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file })).json();
      done.push(result);
    } catch (error) { failed.push(`${file.name}: ${IMPORT_ERRORS[error.message] || error.message}`); }
  }
  expandGroup(project);
  await loadDocs();
  const last = done.at(-1);
  say([done.length ? `${done.length}개 가져옴 · 커밋 ${last.commit.slice(0, 7)}` : '', ...failed].filter(Boolean).join(' · ') || '가져올 파일이 없습니다');
  if (done.length === 1 && failed.length === 0) void openDoc(done[0].id); // dirty 확인은 switchTo가 한다
}

saveButton.addEventListener('click', () => { void save(); });
try {
  studio = await createStudio('#studio', { studioUrl: '/studio/?chrome=embed' });
  studio.onLidgeEvent((event) => { if (event.event === 'lidge.hostSaveRequested') void save(); });
  await loadDocs();
} catch (error) { say(`편집기 시작 실패: ${error.message}`); }
