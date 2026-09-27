// 사이드바 접기·너비 조절(wp5). 상태는 body[data-sidebar]와 localStorage에 둔다.
// 저장소를 쓸 수 없는 창에서는 이번 화면에서만 바뀐다.
const STATE_KEY = 'lidge-hwp.sidebar';
const WIDTH_KEY = 'lidge-hwp.sidebar-width';
const DEFAULT_WIDTH = 256;
const MIN_WIDTH = 200;

const icon = (paths) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">${paths}</svg>`;
// lucide: panel-left-close / panel-left-open
export const ICONS = {
  collapse: icon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>'),
  expand: icon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>'),
};

export function clampSidebarWidth(px, viewportWidth) {
  const half = Number.isFinite(viewportWidth) ? Math.round(viewportWidth * 0.5) : 480;
  const max = Math.max(MIN_WIDTH, Math.min(480, half));
  const value = Number.isFinite(px) ? Math.round(px) : DEFAULT_WIDTH;
  return Math.min(max, Math.max(MIN_WIDTH, value));
}

export function readSidebarState(storage) {
  let collapsed = false;
  let width = DEFAULT_WIDTH;
  try { collapsed = storage?.getItem(STATE_KEY) === 'collapsed'; } catch { /* 저장소 없음 */ }
  try {
    const raw = storage?.getItem(WIDTH_KEY);
    if (raw && Number.isFinite(Number(raw))) width = Number(raw);
  } catch { /* 저장소 없음 */ }
  return { collapsed, width };
}

export function initSidebar({ doc = document, storage = globalThis.localStorage } = {}) {
  const toggle = doc.querySelector('#sidebar-toggle');
  const aside = doc.querySelector('#doc-list');
  const body = aside?.querySelector('.sidebar-body');
  const resizer = doc.querySelector('#sidebar-resizer');
  const layout = doc.querySelector('.layout');
  const view = doc.defaultView;
  if (!toggle || !aside || !body || !layout || !view) return;
  const isMac = /mac/i.test(view.navigator?.platform || '');
  const shortcut = isMac ? '⌘\\' : 'Ctrl+\\';

  const save = (key, value) => { try { storage?.setItem(key, value); } catch { /* 저장소 없음 */ } };
  const maxWidth = () => Math.max(MIN_WIDTH, Math.min(480, Math.round(view.innerWidth * 0.5)));
  // 사용자가 고른 너비(preferred)와 지금 화면에 적용한 너비를 나눈다. 창을 좁히면 적용 너비만 줄고,
  // 다시 넓히면 preferred로 돌아간다. 접힌 상태의 실제 aside 폭(~44px)은 어디에도 저장하지 않는다.
  let preferred = DEFAULT_WIDTH;

  function setCollapsed(collapsed, persist = true) {
    if (collapsed) doc.body.dataset.sidebar = 'collapsed';
    else delete doc.body.dataset.sidebar;
    const label = collapsed ? '문서 목록 펼치기' : '문서 목록 접기';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', label);
    toggle.title = `${label} (${shortcut})`;
    toggle.innerHTML = collapsed ? ICONS.expand : ICONS.collapse;
    body.hidden = collapsed;
    body.inert = collapsed;
    if (persist) save(STATE_KEY, collapsed ? 'collapsed' : 'expanded');
  }

  function applyWidth(px) {
    const width = clampSidebarWidth(px, view.innerWidth);
    layout.style.setProperty('--sidebar-width', `${width}px`);
    if (resizer) {
      resizer.setAttribute('aria-valuenow', String(width));
      resizer.setAttribute('aria-valuemax', String(maxWidth()));
    }
    return width;
  }
  // 사용자 조작(드래그 끝·키보드·더블클릭)만 preferred를 바꾸고 저장한다.
  function setWidth(px, persist = true) {
    const width = applyWidth(px);
    if (persist) { preferred = width; save(WIDTH_KEY, String(width)); }
    return width;
  }

  toggle.addEventListener('click', () => setCollapsed(doc.body.dataset.sidebar !== 'collapsed'));

  // ⌘\/Ctrl+\ 토글. 스튜디오 iframe 안의 키 입력은 이 문서까지 오지 않으므로 셸 문서에만 붙인다.
  doc.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
      event.preventDefault();
      setCollapsed(doc.body.dataset.sidebar !== 'collapsed');
    }
  });

  if (resizer) {
    let drag = null;
    const endDrag = () => {
      if (!drag) return;
      // 마지막으로 끈 너비를 저장한다. aside.getBoundingClientRect()는 150ms 전환 중간값이라 쓰지 않는다.
      setWidth(drag.last ?? drag.width);
      drag = null;
      delete doc.body.dataset.resizing;
    };
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, width: aside.getBoundingClientRect().width };
      doc.body.dataset.resizing = 'true'; // iframe(#studio)이 pointermove를 삼키지 않게 한다
    });
    resizer.addEventListener('pointermove', (event) => {
      if (!drag) return;
      drag.last = drag.width + event.clientX - drag.x;
      applyWidth(drag.last);
    });
    resizer.addEventListener('pointerup', endDrag);
    // 캡처가 끊겨도(pointercancel/lostpointercapture) 드래그 상태와 #studio 잠금을 푼다.
    resizer.addEventListener('pointercancel', endDrag);
    resizer.addEventListener('lostpointercapture', endDrag);
    resizer.addEventListener('keydown', (event) => {
      const width = clampSidebarWidth(preferred, view.innerWidth);
      const next = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: MIN_WIDTH, End: maxWidth() }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      setWidth(next);
    });
    resizer.addEventListener('dblclick', () => setWidth(DEFAULT_WIDTH));
  }

  view.addEventListener('resize', () => applyWidth(preferred));

  const stored = readSidebarState(storage);
  preferred = stored.width;
  applyWidth(preferred);
  setCollapsed(stored.collapsed, false);
}
