import { startAgentChannel } from '/agent-channel.mjs';
import { bindSaveShortcut } from '/shortcuts.mjs';
import { followSwitch, restoreSwitch } from '/follow-switch.mjs';
import { copyPath } from '/copy-path.mjs';
import { shellShortcutDecision } from '/shell-shortcuts.mjs';
import { dispatchHostEvent } from '/host-shortcuts.mjs';
import { initSidebar } from '/sidebar.mjs';
import { normalizeNewDocName } from '/doc-name.mjs';
import { ACCEPT, familyOf, formatOf, isEditable, labelOf, needsConversion } from '/formats.mjs';
import { createOfficeEditor } from '/editors/office.mjs';
import { startOfficeChannel } from '/editors/office-channel.mjs';
import { groupDocs, groupKeyOf, createGroupFor, matchDoc, renderProjects, readCollapsedGroups, writeCollapsedGroups, bindListKeys, displayName } from '/projects.mjs';

initSidebar();

const docFilter = document.querySelector('#doc-filter');
const studioHost = document.querySelector('#studio');
const officeHost = document.querySelector('#office-host');
const refreshButton = document.querySelector('#docs-refresh');
const projectAdd = document.querySelector('#project-add');
const folderAdd = document.querySelector('#folder-add');

const list = document.querySelector('#docs');
const externalList = document.querySelector('#external-docs');
const status = document.querySelector('#status');
const filename = document.querySelector('#filename');
const saveButton = document.querySelector('#save');
const newButton = document.querySelector('#new-doc');
const docFormat = document.querySelector('#doc-format');
const newMenuButton = document.querySelector('#new-menu');
const newMenu = document.querySelector('#new-menu-list');
const importDialog = document.querySelector('#import-dialog');
const copyPathButton = document.querySelector('#copy-path');
const shellMessage = document.querySelector('#shell-message');
const shellRetry = document.querySelector('#shell-retry');
const shellReload = document.querySelector('#shell-reload');
const shellHint = document.querySelector('#shell-hint');
let studio;
let resolveStudioReady;
const studioReady = new Promise(resolve => { resolveStudioReady = resolve; });
let shellState = { kind: 'empty' };
function setShellState(state) {
  shellState = state;
  document.body.dataset.shellState = state.kind;
  document.body.dataset.noDocument = state.kind === 'open' ? '' : 'true';
  if (state.kind === 'open') delete document.body.dataset.noDocument;
  // 첫 화면은 index.html의 #studio inert로 막는다(스크립트 전 입력 차단). 편집기가 생기면 입력 차단은 iframe inert가 맡으므로
  // 감싸는 #studio의 inert는 푼다. 남겨 두면 iframe inert를 풀어도 편집기가 계속 입력을 받지 못한다.
  if (studio) {
    // 오피스 편집기가 열려 있으면 숨겨진 HWP 편집기는 입력을 받지 않는다.
    studio.element.inert = state.kind !== 'open' || state.followPending === true || Boolean(current?.editor);
    studioHost.inert = false;
  }
  shellMessage.textContent = state.reason === 'STUDIO_FAILED' ? '편집기를 시작하지 못했습니다'
    : state.reason === 'EDITOR_PENDING' ? '이 형식의 편집기는 곧 붙습니다'
    : state.kind === 'opening' ? '문서를 여는 중…'
    : state.kind === 'error' ? `${nameOf(state.attemptedId)} 문서를 열지 못했습니다`
    : '목록에서 문서를 선택하세요';
  shellRetry.hidden = !(state.kind === 'error' && state.attemptedId && state.reason !== 'STUDIO_FAILED');
  shellRetry.disabled = state.kind === 'opening';
  shellReload.hidden = state.reason !== 'STUDIO_FAILED';
  shellHint.hidden = state.kind !== 'error' || state.reason === 'STUDIO_FAILED';
}
shellRetry.addEventListener('click', () => { if (shellState.attemptedId) void openDoc(shellState.attemptedId); });
shellReload.addEventListener('click', () => location.reload());
setShellState(shellState);
let current = null;
// 지금 붙어 있는 오피스 편집기(#office-host). HWP 문서로 바꾸거나 다른 오피스 문서를 열 때 정리한다.
let officeEditor = null;
const editorOf = tab => tab?.editor ?? studio;
function showEditorFamily(family) {
  document.body.dataset.editorFamily = family;
  officeHost.hidden = family === 'hwp';
}
function dropOfficeEditor() {
  try { officeEditor?.destroy(); } catch { /* 이미 떨어진 편집기 */ }
  officeEditor = null;
}
let saving = false;
let agentLocked = false;
let opening = 0;                   // 줄에 선 openDoc 수. AI 전환 판정(canFollow)이 본다
let openQueue = Promise.resolve(); // 사람 클릭과 AI 전환(agent.follow)을 한 줄로 세운다
const setSaveLocked = on => { agentLocked = on; syncSaveButton(); };
function syncCopyPathButton() { copyPathButton.disabled = !current; }

function say(message, kind = /실패|오류|끊겼|확인 불가|격리/.test(message) ? 'error' : 'normal') {
  status.textContent = message; status.title = message;
  document.querySelector('header').dataset.statusKind = kind;
}

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
  tab.retired = true; // 배경 재연결을 멈춘다
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
function openDocNow(id, { reservation = null, agent = false, restoreFrom = null, reason = null } = {}) {
  if (restoreFrom) return restoreSwitch({ id, expectedLease: restoreFrom, currentLease: current?.lease,
    reason, switchTo, say, nameOf, currentName: () => current ? nameOf(current.id) : null });
  if (!agent) return switchTo(id).catch(error => { say(`열기 실패: ${error.message}`); return false; });
  return followSwitch({ id, reservation, element: studio.element, switchTo, say,
    hasCurrent: () => current !== null,
    giveBack: token => fetch(`/api/tabs/reservations/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => {}) });
}

// 문서 하나로 바꾼다. 새 문서가 열렸으면 true. AI 전환(agent)은 멈출 이유를 던지고(followSwitch가 정리),
// 사람 전환은 상태줄에 알리고 false를 돌려준다.
async function switchTo(id, { reservation = null, agent = false, rethrow = false, restore = null } = {}) {
  if (restore) agent = true;
  if (!studio && !(await studioReady)) {
    setShellState({ kind: 'error', reason: 'STUDIO_FAILED' });
    return false;
  }
  if (saving) { if (agent) throw new Error('SAVING'); return false; }
  // 연결이 끊긴 탭은 같은 문서를 다시 열어 새 lease로 복구할 수 있다(편집이 있으면 아래 confirm).
  if (current?.id === id && !current.disconnected) { if (agent) throw new Error('ALREADY_OPEN'); return false; }
  if (current && (await editorOf(current).getDocumentState()).dirty) {
    if (agent) throw new Error('DIRTY'); // AI 전환은 확인 창을 띄우지 않는다
    if (!confirm('저장하지 않은 편집을 버리고 다른 문서를 여시겠습니까?')) return false;
  }
  let next;
  const previous = current;
  const previousShellState = shellState;
  const previousInert = studio.element.inert;
  setShellState({ kind: 'opening', attemptedId: id });
  if (previous) {
    // 이전 문서를 먼저 정리한다. release()가 stopAgent()를 await하며,
    // AGENT_BUSY·LEASE_ISOLATED면 던지고 전환을 중단한다(선택 표시는 그대로 이전 문서).
    try { await release(previous); }
    catch (error) {
      setShellState(previousShellState);
      studio.element.inert = previousInert;
      if (agent) throw error;
      say(`전환 취소: ${error.message}`);
      return false;
    }
    current = null;
    syncCopyPathButton();
    saveButton.disabled = true;
  }
  try {
    say(restore ? `AI 작업이 저장 없이 끝나 ${nameOf(id)}로 돌아가는 중`
      : agent ? `AI가 ${nameOf(id)}를 편집하려 해서 그 문서로 전환하는 중` : '문서를 여는 중');
    const response = await api(docUrl(id));
    const bytes = await response.arrayBuffer();
    const etag = response.headers.get('ETag');
    const format = response.headers.get('X-Document-Format');
    if (!etag || !format || formatOf(id) !== format) throw new Error('Invalid document response');
    const family = familyOf(format);
    const leaseResponse = await api('/api/tabs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reservation ? { docId: id, reservation } : { docId: id }) });
    const { lease } = await leaseResponse.json();
    next = { id, etag, format, lease, events: null, stopAgent: null, editor: null };
    // loadFile이 끝날 때까지 SSE를 열지 않는다. 그동안 서버는 이 탭을 "여는 중"으로 보고 runner는 붙기를 기다린다.
    if (family === 'hwp') {
      await studio.loadFile(bytes, id.split('/').at(-1));
      dropOfficeEditor();
      showEditorFamily('hwp');
    } else {
      // HWP가 아닌 형식: 형식 가족별 편집기(시트·문서·슬라이드)를 #office-host에 붙인다. HWP 편집기는 그대로 둔다.
      dropOfficeEditor();
      showEditorFamily(family);
      officeEditor = await createOfficeEditor(officeHost, format, { id, onSaveShortcut: () => void save(), notify: say });
      next.editor = officeEditor;
      const source = needsConversion(format)
        ? await (await api(`/api/office/editable/${encodeURIComponent(id)}`)).arrayBuffer() : bytes;
      await officeEditor.loadFile(source, id.split('/').at(-1));
    }
    const tab = next;
    connectTab(tab);
    current = next;
    if (agent && !restore) setSaveLocked(true);
    syncCopyPathButton();
    setShellState({ kind: 'open', followPending: agent && !restore });
    // 오피스 편집기는 숨긴 채 붙였으므로 보이게 된 뒤 크기를 다시 재게 한다(FortuneSheet 캔버스는 창 resize를 듣는다).
    if (tab.editor) requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    filename.textContent = nameOf(id); filename.title = id;
    docFormat.textContent = labelOf(format); docFormat.dataset.fmt = format; docFormat.hidden = false;
    syncSaveButton();
    for (const button of document.querySelectorAll('#docs button[data-id], #external-docs button[data-id]')) button.setAttribute('aria-current', String(button.dataset.id === id));
    // 방금 연 문서의 그룹이 접혀 있으면 펼치고 활성 버튼이 보이게 한다.
    expandGroup(groupKeyOf(id));
    renderDocs();
    const activeButton = document.querySelector('#docs button[aria-current="true"], #external-docs button[aria-current="true"]');
    activeButton?.scrollIntoView({ block: 'nearest' });
    if (openHadListFocus) activeButton?.focus();
    openHadListFocus = false;
    say(restore ? `${nameOf(id)}로 돌아옴 · AI 작업은 저장 없이 끝남(${restore.reason})`
      : agent ? '열림 · AI 편집 대기 중' : '열림');
    return true;
  } catch (error) {
    // AI 전환이면 runner가 FOLLOW_LOAD_FAILED로 알아채고, followSwitch가 예약을 돌려준다.
    if (next && current !== next) await release(next).catch(() => {});
    if (next?.editor && current !== next) { dropOfficeEditor(); showEditorFamily('hwp'); }
    if (!current) {
      syncCopyPathButton();
      // 이전 문서는 이미 반납했다. 화면에 남은 옛 문서를 편집·저장할 수 없게 덮고, 목록에서 다시 고르게 한다.
      filename.textContent = ''; filename.title = '';
      docFormat.hidden = true;
      saveButton.disabled = true;
      for (const button of document.querySelectorAll('#docs button[data-id], #external-docs button[data-id]')) button.setAttribute('aria-current', 'false');
      setShellState({ kind: 'error', attemptedId: id, reason: error.message });
      studio.element.blur?.();
    }
    // AI 전환은 알림을 followSwitch 한 곳이 맡는다(중복 알림·구체 사유 덮어쓰기 방지). 화면 정리만 하고 던진다.
    if (agent || rethrow) throw error;
    say(error.message === 'DOCUMENT_LOCKED'
      ? 'AI가 편집 중입니다 · 잠시 뒤 다시 여세요'
      : error.message === 'EDITOR_PENDING' ? '이 형식의 편집기는 곧 붙습니다'
      : '문서를 열지 못했습니다 · 다시 열어 보세요');
    return false;
  }
}

// 탭의 SSE와 에이전트 채널을 붙인다. 처음 열 때와 끊긴 연결을 다시 붙일 때(reconnect) 같은 경로를 쓴다.
function connectTab(tab) {
  const { id, lease } = tab;
  tab.events = new EventSource(`/api/events?lease=${encodeURIComponent(lease)}`);
  tab.connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('SSE_HELLO_TIMEOUT')), 5000);
    const hello = () => finish(null);
    const failed = () => finish(new Error('SSE_CONNECT_FAILED'));
    function finish(error) {
      clearTimeout(timer);
      tab.events.removeEventListener('hello', hello);
      tab.events.removeEventListener('error', failed);
      if (error) reject(error); else resolve();
    }
    tab.events.addEventListener('hello', hello, { once: true });
    tab.events.addEventListener('error', failed, { once: true });
  });
  tab.connected.catch(() => {});
  tab.events.addEventListener('error', () => markDisconnected(tab, lease));
  // 같은 틱에 리스너를 붙이므로 첫 SSE 이벤트를 놓치지 않는다.
  const followHooks = {
    canFollow: async () => saving ? 'SAVING' : opening > 0 ? 'BUSY'
      : (await editorOf(tab).getDocumentState()).dirty ? 'DIRTY' : null,
    onFollow: (targetId, token) => openDoc(targetId, { reservation: token, agent: true }),
    onFollowEnd: msg => {
      if (current?.lease !== lease) return;
      if (msg.completion === 'committed') return say(`AI 편집 저장됨 · ${nameOf(id)}${msg.commit ? ' · 커밋 ' + msg.commit : ''}`);
      if (msg.completion === 'unknown') return say(`AI 작업 결과 확인 필요(${msg.error ?? '알 수 없음'}) · 이 문서에 남습니다`);
      if (msg.completion === 'none') return openDoc(msg.from, { restoreFrom: lease, reason: msg.error ?? '변경 없음' });
    },
  };
  if (tab.editor) tab.stopAgent = startOfficeChannel({ events: tab.events, docId: id, lease, showStatus: say, setSaveLocked,
    // 저장 중 전환은 switchTo가 막는다. 끊긴 탭을 save()가 스스로 다시 붙이는 정리는 막지 않는다.
    isBusy: () => saving && current === tab && !tab.disconnected, ...followHooks,
    onChanged: async () => {
      if (current !== tab) return;
      if ((await tab.editor.getDocumentState()).dirty) { say('AI가 이 문서를 바꿨습니다 · 저장하지 않은 편집이 있어 다시 읽지 않았습니다'); return; }
      const fresh = await api(docUrl(id), { cache: 'no-store' });
      const freshBytes = await fresh.arrayBuffer();
      tab.etag = fresh.headers.get('ETag');
      const src = needsConversion(tab.format)
        ? await (await api(`/api/office/editable/${encodeURIComponent(id)}`)).arrayBuffer() : freshBytes;
      await tab.editor.loadFile(src, id.split('/').at(-1));
      say('AI 편집을 불러왔습니다');
    } });
  else tab.stopAgent = startAgentChannel({ editor: studio, events: tab.events, docId: id, lease,
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
    ...followHooks,
  });
}

// SSE가 끊긴 탭(서버 재시작·네트워크). 저장을 조용히 막지 않는다: 배경 재시도나 다음 ⌘S가 새 lease로 다시 붙인다.
function markDisconnected(tab, lease) {
  if (tab.lease !== lease || tab.retired || tab.disconnected) return;
  tab.disconnected = true;
  syncSaveButton();
  if (current === tab) say('연결이 끊겼습니다 · 다시 연결하는 중');
  scheduleReconnect(tab, 0);
}
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];
function scheduleReconnect(tab, attempt) {
  if (attempt >= RECONNECT_DELAYS.length) {
    if (current === tab && tab.disconnected) say('연결이 끊겼습니다 · ⌘S로 다시 연결해 저장하거나 문서를 다시 여세요');
    return;
  }
  setTimeout(async () => {
    if (current !== tab || tab.retired || !tab.disconnected) return;
    if (!(await reconnect(tab)) && current === tab && tab.disconnected && !tab.retired) scheduleReconnect(tab, attempt + 1);
  }, RECONNECT_DELAYS[attempt]);
}
const releaseLease = lease => fetch(`/api/tabs/${encodeURIComponent(lease)}`, { method: 'DELETE' }).catch(() => {});
// 끊긴 탭을 제자리에서 다시 붙인다(편집기와 편집 내용은 그대로). 서버는 SSE가 닫힐 때 옛 lease를 이미 풀었다.
// 탭마다 한 번만 진행한다. 그사이 다른 문서로 옮겼으면 새로 받은 lease(지역 변수)를 바로 반납한다.
function reconnect(tab) {
  if (tab.retired) return Promise.resolve(false);
  if (!tab.disconnected) return Promise.resolve(true);
  tab.reconnecting ??= (async () => {
    let lease = null;
    try {
      // 옛 채널 정리. 오피스·HWP 모두 저장 잠금을 푼다. 격리(LEASE_ISOLATED)·AI 작업 중(AGENT_BUSY)이면 던진다.
      await tab.stopAgent?.();
      tab.events?.close();
      const response = await api('/api/tabs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId: tab.id }) });
      lease = (await response.json()).lease;
      if (current !== tab || tab.retired) { await releaseLease(lease); return false; }
      tab.lease = lease;
      connectTab(tab);
      await tab.connected;
      if (current !== tab || tab.retired) {
        await tab.stopAgent?.().catch(() => {});
        tab.events.close();
        await releaseLease(lease);
        return false;
      }
      tab.disconnected = false;
      tab.reconnectError = null;
      syncSaveButton();
      say('다시 연결됨');
      return true;
    } catch (error) {
      tab.reconnectError = error.message;
      if (lease && tab.lease === lease) { await tab.stopAgent?.().catch(() => {}); tab.events?.close(); }
      if (lease) await releaseLease(lease);
      if (error.message === 'LEASE_ISOLATED' && current === tab) say('이 탭은 격리돼 새로고침해야 저장할 수 있습니다');
      return false;
    } finally { tab.reconnecting = null; }
  })();
  return tab.reconnecting;
}

async function save() {
  if (!current || saving) return;
  // 저장 요청은 조용히 사라지지 않는다. 끊긴 연결은 아래에서 다시 붙이고, AI 잠금은 이유를 알린다.
  if (agentLocked && !current.disconnected) { say('AI가 편집 중이라 지금은 저장할 수 없습니다'); return; }
  if (!isEditable(current.format)) {
    // 편집기가 있는 읽기 전용 형식(Pages)은 편집한 내용을 DOCX 사본으로 남긴다. 슬라이드는 서버가 PPTX 사본을 만든다.
    if (current.editor?.family === 'doc') return saveCopy('docx', { fromEditor: true });
    if (current.editor?.family === 'slides' && current.format !== 'pptx') return saveCopy('pptx');
    say(`${labelOf(current.format)}는 미리보기 전용입니다 · 사본으로 변환해 편집하세요`); return;
  }
  saving = true;
  saveButton.disabled = true;
  const tab = current;
  try {
    if (tab.disconnected) {
      say('연결을 다시 붙이는 중');
      if (!(await reconnect(tab))) {
        say(`저장 실패: 연결이 끊겼습니다${tab.reconnectError ? `(${tab.reconnectError})` : ''} · 서버를 확인한 뒤 다시 ⌘S`);
        return;
      }
    }
    say('저장 중');
    const exported = tab.editor ? await tab.editor.exportWithReport({ format: tab.format })
      : await studio.lidge.request('exportWithReport', { format: tab.format });
    if (exported.contentLoss.count !== 0 || exported.contentLoss.losses.length !== 0) throw new Error('CONTENT_LOSS');
    // 오피스 형식이 지키지 못하는 것(서식·수식 등)이 있으면 탭마다 한 번 확인을 받는다.
    const warnings = exported.contentLoss.warnings ?? [];
    const unseen = warnings.filter(code => !tab.acceptedWarnings?.has(code));
    if (unseen.length) {
      const lines = tab.editor?.describeWarnings?.(unseen) ?? unseen;
      if (!confirm(`${labelOf(tab.format)}로 저장하면:\n\n${lines.map(line => '· ' + line).join('\n')}\n\n저장할까요?`)) { say('저장 취소'); return; }
      tab.acceptedWarnings = new Set([...(tab.acceptedWarnings ?? []), ...unseen]);
    }
    const report = btoa(JSON.stringify(exported.contentLoss));
    const response = await api(docUrl(tab.id), { method: 'PUT', headers: {
      'Content-Type': 'application/octet-stream', 'If-Match': tab.etag,
      'X-Lease': tab.lease, 'X-Document-Format': tab.format,
      'X-Content-Loss-Report': report,
      ...(exported.sourceFormat ? { 'X-Source-Format': exported.sourceFormat } : {}),
    }, body: exported.bytes });
    const result = await response.json();
    tab.etag = `"${result.sha256}"`;
    say('저장됨');
    try { await (tab.editor ?? studio).notifySaved(tab.id.split('/').at(-1)); }
    catch (error) { say(`파일 커밋 ${result.commit} 완료, 편집기 상태 갱신 실패: ${error.message}`); }
  } catch (error) { say(`저장 실패: ${error.message}`); }
  finally { saving = false; syncSaveButton(); }
}

// 저장 버튼: 편집 가능한 형식은 "저장", Pages는 "DOCX 사본", pptx가 아닌 슬라이드는 "PPTX 사본", pptx 미리보기는 끔.
function syncSaveButton() {
  const family = current?.editor?.family;
  const copyTarget = !current || isEditable(current.format) ? null
    : family === 'doc' ? 'docx' : family === 'slides' && current.format !== 'pptx' ? 'pptx' : null;
  const copyOnly = Boolean(copyTarget);
  saveButton.textContent = copyOnly ? `${labelOf(copyTarget)} 사본` : '저장';
  saveButton.disabled = !current || (agentLocked && !current.disconnected) || saving || (!isEditable(current.format) && !copyOnly);
}

// 원본 옆에 다른 형식 사본을 만든다. fromEditor면 편집기 내보내기 바이트를, 아니면 서버 변환을 쓴다.
async function saveCopy(target, { fromEditor = false } = {}) {
  if (!current || saving) return;
  const tab = current;
  saving = true; syncSaveButton();
  try {
    say(`${labelOf(target)} 사본 만드는 중`);
    const bytes = fromEditor ? (await tab.editor.exportWithReport({ format: target })).bytes : new Uint8Array(0);
    const response = await api('/api/office/copy', { method: 'POST', body: bytes, headers: {
      'Content-Type': 'application/octet-stream', 'X-Doc-Id': encodeURIComponent(tab.id), 'X-Target-Format': target } });
    const created = await response.json();
    await tab.editor?.notifySaved?.();
    saving = false;
    await loadDocs();
    say(`${nameOf(created.id)} 사본을 만들었습니다${created.commit ? ' · 커밋 ' + String(created.commit).slice(0, 7) : ''}`);
    await openDoc(created.id);
  } catch (error) { say(`사본 만들기 실패: ${error.message}`); }
  finally { saving = false; syncSaveButton(); }
}

// 프로젝트 그룹 상태(wp5). 접힌 그룹 키는 localStorage에, 필터는 세션에만 둔다.
let groups = [];
let externalGroups = [];
let selectedGroupKey = null;
let creating = false;
let editing = null;
let rendering = false;
let pendingCancel = null;
let searchTimer;
for (const docList of [list, externalList]) docList.addEventListener('focusin', (event) => {
  const group = event.target?.closest?.('.group');
  if (group) selectedGroupKey = group.querySelector('.group-header')?.dataset.group ?? null;
});
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
  if (editing && active?.matches?.('.doc-edit input')) {
    editing.draft = active.value;
    editing.selection = [active.selectionStart, active.selectionEnd];
  }
  const activeList = list.contains(active) ? list : externalList.contains(active) ? externalList : null;
  const selector = active?.dataset?.id ? `button[data-id="${CSS.escape(active.dataset.id)}"]`
    : active?.classList?.contains('group-header') ? `.group-header[data-group="${CSS.escape(active.dataset.group)}"]`
    : null;
  rendering = true;
  const query = docFilter.value.trim();
  const total = [...groups, ...externalGroups].reduce((n, group) => n + group.docs.filter(doc => matchDoc(doc, query)).length, 0);
  const noResults = !!query && total === 0 && !editing;
  const editOptions = { edit: editing, onEditInput: input => {
    if (!editing) return;
    editing.draft = input.value;
    editing.touched = true;
    if (editing.error) { editing.error = null; input.removeAttribute('aria-invalid');
      input.closest('.doc-row')?.querySelector('.name-error')?.remove(); }
  }, onEditKey: editKey, onEditBlur: editBlur };
  renderProjects(list, groups, {
    currentId: current?.id ?? null, collapsed: collapsedGroups, query: docFilter.value,
    ...editOptions, showEmpty: !query,
    onRename: id => { void beginRename(id); },
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
    ...editOptions, showEmpty: !query,
    onRename: id => { void beginRename(id); },
    emptyLabel: externalGroups.length === 0 ? '추가한 폴더가 없습니다.'
      : externalGroups.every(group => group.available === false) ? '' : '추가한 폴더에 문서가 없습니다.',
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
  document.querySelector('#search-feedback').replaceChildren();
  if (noResults) {
    const feedback = document.querySelector('#search-feedback');
    feedback.append('일치하는 문서가 없습니다 · ');
    const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = '검색어 지우기';
    clear.addEventListener('click', () => { docFilter.value = ''; renderDocs(); docFilter.focus(); announceSearch(); });
    feedback.append(clear);
  }
  rendering = false;
  if (editing) {
    const input = document.querySelector('.doc-edit input');
    if (input && active?.matches?.('.doc-edit input')) {
      input.focus();
      if (editing.selection) input.setSelectionRange(...editing.selection);
    }
  }
  if (activeList && !editing) {
    (selector && activeList.querySelector(selector)
      || document.querySelector('#docs button[aria-current="true"], #external-docs button[aria-current="true"]'))?.focus();
  }
}
async function loadDocs() {
  const feedback = document.querySelector('#list-feedback');
  feedback.textContent = '문서 목록을 불러오는 중…';
  try {
    const response = await api('/api/docs');
    const { docs, projects = [], roots = [] } = await response.json();
    ({ primary: groups, external: externalGroups } = groupDocs(docs, projects, roots));
    renderDocs();
    feedback.textContent = '';
    if (!current) say(docs.length === 0 ? '문서함에 문서가 없습니다.' : '');
  } catch (error) {
    feedback.textContent = '문서 목록을 불러오지 못했습니다 · ';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '다시 시도';
    retry.addEventListener('click', () => { void loadDocs(); }); feedback.append(retry);
    say('문서 목록을 불러오지 못했습니다', 'error');
    throw error;
  }
}
function announceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const query = docFilter.value.trim();
    if (!query) { say('검색어를 지웠습니다'); return; }
    const count = [...groups, ...externalGroups].reduce((n, group) => n + group.docs.filter(doc => matchDoc(doc, query)).length, 0);
    say(count ? `검색 결과 ${count}개` : '일치하는 문서가 없습니다');
  }, 300);
}

async function newDocument(name, group, format = 'hwp') {
  if (creating) return { ok: false, created: null };
  creating = true;
  const requestId = crypto.randomUUID();
  try {
    let response;
    try {
      response = await api('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group, requestId, ...(format !== 'hwp' ? { format } : {}), ...(name !== undefined ? { name } : {}) }) });
    } catch (error) {
      if (error instanceof TypeError) {
        return settleUnknown(requestId);
      }
      showEditError(error.message);
      return { ok: false, created: null };
    }
    let created;
    try { created = await response.json(); }
    catch { return settleUnknown(requestId); }
    return completeCreated(created);
  } finally { creating = false; }
}
async function settleUnknown(requestId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 300));
    try {
      const response = await fetch(`/api/docs/requests/${encodeURIComponent(requestId)}`);
      if (response.status === 200) return completeCreated(await response.json());
      if (response.status === 404) break;
      if (response.status !== 202) break;
    } catch { break; }
  }
  editing = null; renderDocs();
  say('새 문서 결과 확인 불가 · 목록을 확인하세요', 'error');
  return { ok: true, created: null };
}
async function completeCreated(created) {
  editing = null;
  selectedGroupKey = null;
  renderDocs();
  try {
    await loadDocs();
    const opened = await openDoc(created.id);
    say(opened ? '새 문서 열림' : '새 문서를 만들었습니다 · 목록에서 다시 여세요');
  } catch (error) {
    say(`새 문서를 만들었습니다 · 목록 갱신 실패: ${error.message}`, 'error');
  }
  return { ok: true, created };
}

function requestNewDocument() {
  beginNewDraft();
}

function rowFor(id) {
  return (list.querySelector(`.doc[data-id="${CSS.escape(id)}"]`)
    || externalList.querySelector(`.doc[data-id="${CSS.escape(id)}"]`))?.closest('.doc-row');
}
function showRow(id) {
  if (docFilter.value && ![...groups, ...externalGroups].flatMap(group => group.docs)
    .some(doc => doc.id === id && matchDoc(doc, docFilter.value))) docFilter.value = '';
  expandGroup(groupKeyOf(id));
  renderDocs();
  return rowFor(id);
}
async function beginRename(id) {
  if (editing?.pending) return;
  // 더블클릭은 click 두 번(열기 두 번)을 먼저 큐에 넣는다. 여기서 부르는 열기는 이미 열린 문서라 false를 돌려주므로,
  // 호출 결과가 아니라 큐가 끝난 뒤 그 문서가 현재인지로 판단한다. 저장 중·열기 실패면 current가 달라 멈춘다.
  if (current?.id !== id) { await openDoc(id); if (current?.id !== id) return; }
  showRow(id);
  const file = id.split('/').at(-1);
  // 확장자는 형식 레지스트리가 아는 것만 이름 바꾸기 대상이다(서버도 같은 확장자만 허용한다).
  const match = /^(.*)(\.[a-z0-9]+)$/i.exec(file);
  if (!match || !formatOf(file)) return;
  editing = { kind: 'rename', id, label: nameOf(id), groupKey: groupKeyOf(id),
    draft: match[1], extension: match[2], selection: null, error: null, pending: false };
  renderDocs(); focusEdit();
}
// extension: '.hwp'(기본, ⌘N·새 문서 버튼), '.xlsx', '.docx'(새 문서 메뉴).
function beginNewDraft(extension = '.hwp') {
  if (typeof extension !== 'string') extension = '.hwp'; // 클릭 이벤트로 불릴 때
  if (editing?.pending || creating) return;
  const target = createGroupFor([...groups, ...externalGroups], selectedGroupKey, current?.id);
  const groupKey = target.kind === 'default' ? '' : target.kind === 'external' ? `ext://${target.key}` : target.name;
  editing = { kind: 'new', group: target, groupKey, draft: '새 문서', extension,
    touched: false, selection: null, error: null, pending: false,
    previousFilter: docFilter.value, wasCollapsed: collapsedGroups.has(groupKey) };
  docFilter.value = '';
  expandGroup(groupKey);
  renderDocs(); focusEdit();
}
function focusEdit() {
  const input = document.querySelector('.doc-edit input');
  input?.focus(); input?.select();
  if (editing && input) editing.selection = [input.selectionStart, input.selectionEnd];
}
function cancelEdit(restoreFocus = false) {
  if (!editing || editing.pending) return;
  const old = editing;
  editing = null; pendingCancel = null;
  if (old.kind === 'new') {
    docFilter.value = old.previousFilter;
    if (old.wasCollapsed) collapsedGroups.add(old.groupKey);
  }
  renderDocs();
  if (restoreFocus) (old.kind === 'new' ? newButton : rowFor(old.id)?.querySelector('.doc'))?.focus();
}
const EDIT_ERRORS = { DOC_EXISTS: '이미 같은 이름의 문서가 있습니다', NAME_COLLISION: '이미 같은 이름의 문서가 있습니다',
  INVALID_NAME: '이름에 쓸 수 없는 문자가 있습니다', INVALID_FORMAT: '새 문서는 HWP 형식으로만 만들 수 있습니다' };
function showEditError(code) {
  if (!editing) return;
  editing.error = EDIT_ERRORS[code] || '이름을 저장하지 못했습니다';
  if (code === 'INVALID_FORMAT' && editing.kind === 'new' && editing.extension !== '.hwp')
    editing.error = `새 문서는 ${labelOf(editing.extension.slice(1))} 형식으로만 만들 수 있습니다`;
  editing.pending = false;
  renderDocs();
  focusEdit();
  say(editing.error, 'error');
}
function editBlur(_event, input) {
  if (rendering || !editing || editing.pending) return;
  editing.draft = input.value;
  const edit = editing;
  pendingCancel = edit;
  setTimeout(() => {
    if (pendingCancel === edit && editing === edit
      && !document.activeElement?.closest?.('.doc-row[data-edit]')) cancelEdit(false);
  }, 0);
}
function editKey(event, input) {
  if (!editing) return;
  if (event.key === 'Tab') { pendingCancel = editing; return; }
  if (event.key === 'Escape' && !event.isComposing && !editing.composing && !editing.pending) {
    event.preventDefault(); event.stopPropagation(); cancelEdit(true); return;
  }
  if (event.key !== 'Enter' || editing.pending || event.isComposing || event.keyCode === 229 || editing.composing || editing.imeJustEnded) return;
  event.preventDefault(); event.stopPropagation();
  editing.draft = input.value;
  void submitEdit();
}
async function submitEdit() {
  const edit = editing;
  if (!edit || edit.pending) return;
  let name;
  try {
    const base = edit.draft.trim().normalize('NFC');
    if (!base) throw new Error('INVALID_NAME');
    name = edit.kind === 'new' ? (edit.touched ? normalizeNewDocName(base, edit.extension) : undefined)
      : `${base}${edit.extension}`;
  } catch (error) { showEditError(error.message); return; }
  edit.pending = true; renderDocs();
  const input = document.querySelector('.doc-edit input');
  if (edit.kind === 'new') await newDocument(name, edit.group, edit.extension.slice(1));
  else {
    await renameDoc(edit.id, name, input);
    if (editing === edit && !edit.error && !edit.keep) { editing = null; renderDocs(); }
  }
}
function startRename() {
  const id = current?.id;
  if (!id) { say('이름을 바꿀 문서를 선택하세요.'); return; }
  void beginRename(id);
}
function renameDoc(id, name, input) {
  const candidateId = id.slice(0, id.lastIndexOf('/') + 1) + name.trim().normalize('NFC');
  let sent = false;
  let committed = null;
  const detach = tab => {
    tab?.events?.close();
    current = null;
    syncCopyPathButton();
    saveButton.disabled = true;
    setShellState({ kind: 'error', attemptedId: id, reason: 'RENAME' });
  };
  const reopen = async target => {
    try {
      if (!(await switchTo(target, { rethrow: true }))) throw new Error('REOPEN_FAILED');
      showRow(target)?.querySelector('.doc')?.focus();
      return true;
    } catch (error) {
      if (error.message === 'DOCUMENT_QUARANTINED') say(`${nameOf(target)} 격리됨 · 수동 복구가 필요합니다`);
      else say(`${nameOf(target)} 다시 열기 실패: ${error.message} · 목록에서 다시 선택하세요`);
      return false;
    }
  };
  const reconcile = async () => {
    say('이름 변경 결과 확인 중…');
    try {
      await loadDocs();
      const ids = new Set([...groups, ...externalGroups].flatMap(group => group.docs.map(doc => doc.id)));
      const newExists = ids.has(candidateId), oldExists = ids.has(id);
      if (newExists === oldExists) throw new Error('AMBIGUOUS_RENAME');
      const target = newExists ? candidateId : id;
      if (!(await reopen(target))) return;
      say(newExists ? `${nameOf(id)} → ${nameOf(target)} · 이름 변경 완료` : `${nameOf(id)} 이름 변경되지 않음 · 다시 열림`);
    } catch {
      say('이름 변경 결과를 확인할 수 없음 · 목록을 새로 고친 뒤 다시 여세요');
    }
  };
  const run = openQueue.then(async () => {
    if (saving || agentLocked || current?.id !== id) throw new Error('AGENT_BUSY');
    if ((await editorOf(current).getDocumentState()).dirty
        && !confirm('저장하지 않은 편집을 버리고 이름을 바꾸시겠습니까?')) {
      if (editing) { editing.pending = false; editing.keep = true; renderDocs(); focusEdit(); }
      return;
    }
    const tab = current;
    await tab.connected;
    await tab.stopAgent();
    sent = true;
    const response = await fetch(`${docUrl(id)}/rename`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lease': tab.lease, 'If-Match': tab.etag },
      body: JSON.stringify({ name: name.trim() }) });
    if (!response.ok) {
      let code = `HTTP ${response.status}`;
      try { code = (await response.json()).error?.code || code; } catch { /* malformed error */ }
      throw Object.assign(new Error(code), { status: response.status });
    }
    committed = await response.json();
    if (committed.id !== candidateId) console.warn('rename id mismatch', candidateId, committed.id);
    detach(tab);
    editing = null;
    filename.textContent = nameOf(committed.id); filename.title = committed.id;
    await loadDocs();
    showRow(committed.id);
    if (!(await reopen(committed.id))) return;
    editing = null;
    say(`${nameOf(committed.oldId)} → ${nameOf(committed.id)} · 커밋 ${committed.commit}`);
  }).catch(async error => {
    if (committed) {
      say(`${nameOf(committed.id)} 이름 변경 완료 · 목록/재열기 실패: ${error.message}`);
    } else if (sent && !(error.status >= 400 && error.status < 500)) {
      detach(current);
      await reconcile();
    } else {
      showEditError(error.message);
    }
  });
  openQueue = run.catch(() => {});
  return run;
}
const targetForDocumentAction = () => {
  const focused = document.activeElement?.closest?.('.doc-row')?.querySelector('.doc[data-id]')
    ?? document.activeElement?.closest?.('.doc[data-id]');
  return focused?.dataset.id ?? current?.id ?? null;
};
const copyDocumentPath = id => copyPath(id, { request: api, clipboard: navigator.clipboard, say });
copyPathButton.addEventListener('click', () => { void copyDocumentPath(current?.id ?? null); });
window.addEventListener('keydown', event => {
  const { prevent, action } = shellShortcutDecision(event);
  if (!prevent) return;
  event.preventDefault();
  if (action === 'copyPath') void copyDocumentPath(targetForDocumentAction());
  else if (action === 'newDocument') requestNewDocument();
  else if (action === 'rename') {
    const id = targetForDocumentAction();
    if (id) void beginRename(id);
  }
}, true);
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
docFilter.addEventListener('input', () => { renderDocs(); announceSearch(); });
docFilter.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && docFilter.value) { docFilter.value = ''; renderDocs(); announceSearch(); event.stopPropagation(); }
});
refreshButton.addEventListener('click', () => { void loadDocs().catch(() => {}); });
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

newButton.addEventListener('click', beginNewDraft);

// 새 문서 형식 메뉴(HWP·XLSX·DOCX·Google에서 가져오기). 메뉴 버튼 패턴: Enter/Space/↓로 열고 ↑↓로 옮기고 Escape로 닫는다.
const menuItems = () => [...newMenu.querySelectorAll('[role="menuitem"]')];
function setMenu(open, { focus = 'first' } = {}) {
  newMenu.hidden = !open;
  newMenuButton.setAttribute('aria-expanded', String(open));
  if (open) (focus === 'last' ? menuItems().at(-1) : menuItems()[0])?.focus();
}
newMenuButton.addEventListener('click', () => setMenu(newMenu.hidden));
newMenuButton.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenu(true, { focus: event.key === 'ArrowUp' ? 'last' : 'first' }); }
});
newMenu.addEventListener('keydown', event => {
  const items = menuItems();
  const at = items.indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(false); newMenuButton.focus(); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); items[(at + 1) % items.length]?.focus(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
  else if (event.key === 'Tab') setMenu(false);
});
document.addEventListener('pointerdown', event => {
  if (!newMenu.hidden && !event.target.closest?.('.new-group')) setMenu(false);
});
newMenu.addEventListener('click', event => {
  const item = event.target.closest?.('[data-new]');
  if (!item) return;
  setMenu(false);
  if (item.dataset.new === 'google') openImportDialog();
  else beginNewDraft('.' + item.dataset.new);
});

// Google 공유 링크 가져오기. 선택한 그룹(새 문서와 같은 규칙)에 xlsx·docx·pptx 사본을 만든다.
const importUrl = document.querySelector('#import-url');
const importError = document.querySelector('#import-error');
const importGo = document.querySelector('#import-go');
const IMPORT_URL_ERRORS = { INVALID_URL: 'docs.google.com의 시트·문서·슬라이드 주소가 아닙니다',
  GOOGLE_NOT_SHARED: '공유되지 않은 문서입니다 · "링크가 있는 모든 사용자"로 공유한 뒤 다시 시도하세요',
  GOOGLE_REDIRECT_BLOCKED: 'Google 밖으로 넘어가는 주소는 받지 않습니다', GOOGLE_FETCH_FAILED: 'Google에서 받지 못했습니다',
  GOOGLE_BAD_BYTES: '받은 파일이 문서 형식이 아닙니다', TOO_LARGE: '파일이 너무 큽니다(64MB 초과)' };
function openImportDialog() {
  importError.textContent = '';
  importUrl.value = '';
  importDialog.showModal();
  importUrl.focus();
}
document.querySelector('#import-cancel').addEventListener('click', () => { importDialog.close(); newMenuButton.focus(); });
document.querySelector('#import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const target = createGroupFor([...groups, ...externalGroups], selectedGroupKey, current?.id);
  importGo.disabled = true;
  importError.textContent = '가져오는 중…';
  try {
    const created = await (await api('/api/office/import-url', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: importUrl.value.trim(), group: target }) })).json();
    importDialog.close();
    await loadDocs();
    say(`${nameOf(created.id)} 가져옴 · 커밋 ${String(created.commit ?? '').slice(0, 7)}`);
    await openDoc(created.id);
  } catch (error) { importError.textContent = IMPORT_URL_ERRORS[error.message] || `가져오지 못했습니다: ${error.message}`; }
  finally { importGo.disabled = false; }
});
document.addEventListener('pointerdown', event => {
  if (editing && !editing.pending && !event.target.closest('.doc-row[data-edit]')) pendingCancel = editing;
}, true);
document.addEventListener('click', () => {
  const edit = pendingCancel;
  if (edit) setTimeout(() => {
    if (pendingCancel === edit && editing === edit) cancelEdit(false);
    else if (pendingCancel === edit) pendingCancel = null;
  }, 0);
});

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
filePicker.accept = ACCEPT;
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
const IMPORT_ERRORS = { INVALID_FORMAT: '지원하지 않는 형식입니다', INVALID_BYTES: '파일이 손상되었거나 형식이 다릅니다',
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
// 셸 어디에 포커스가 있어도(목록·검색창·헤더·편집기 포털 메뉴) ⌘S는 브라우저 저장이 아니라 앱 저장이다.
bindSaveShortcut(window, () => { void save(); });
void loadDocs().catch(() => {});
try {
  const { createStudio } = await import('/editor/index.js');
  studio = await createStudio('#studio', { studioUrl: '/studio/?chrome=embed' });
  studio.element.inert = true;
  document.body.dataset.studioReady = 'true';
  resolveStudioReady(true);
  studio.onLidgeEvent((event) => dispatchHostEvent(event, {
    save: () => void save(),
    rename: () => startRename(),
    copyPath: () => void copyDocumentPath(current?.id ?? null),
    newDocument: () => requestNewDocument(),
  }));
} catch (error) { resolveStudioReady(false); setShellState({ kind: 'error', reason: 'STUDIO_FAILED' }); say('편집기를 시작하지 못했습니다', 'error'); }
