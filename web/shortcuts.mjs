// 셸 문서(사이드바·문서 목록·검색창·헤더)의 저장 단축키.
// 스튜디오 iframe 안의 ⌘S는 iframe이 직접 잡아 lidge.hostSaveRequested로 올려 보내지만,
// 포커스가 셸에 있으면 키가 iframe에 가지 않아 브라우저 "페이지 저장" 대화상자로 샌다.

// ⌘/Ctrl+S. 한글 IME 상태에서는 key가 'ㄴ'으로 오므로 물리 키(code)도 함께 본다.
export function isSaveShortcut(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  const key = String(event.key || '').toLowerCase();
  return key === 's' || key === 'ㄴ' || event.code === 'KeyS';
}

// 캡처 단계라 목록·입력창의 keydown 처리보다 먼저 돈다. 브라우저 기본 저장은 항상 막고,
// Shift 없는 ⌘S만 저장으로 보낸다(문서 없음·저장 중·AI 잠금 판단은 onSave가 맡는다).
export function bindSaveShortcut(target, onSave) {
  target.addEventListener('keydown', (event) => {
    if (!isSaveShortcut(event)) return;
    event.preventDefault();
    if (!event.shiftKey && !event.repeat) onSave();
  }, true);
}
