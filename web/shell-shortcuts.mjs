// Recognize the physical key before deciding whether this focus may run its action.
export function shellShortcutKey(event) {
  const key = event.key?.toLowerCase();
  if ((event.code === 'F2' || key === 'f2')
      && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return 'rename';
  if (!event.metaKey || event.ctrlKey) return null;
  if (event.shiftKey && !event.altKey) {
    if (event.code === 'KeyC' || key === 'c' || key === 'ㅊ') return 'copyPath';
    if (event.code === 'KeyR' || key === 'r' || key === 'ㄱ') return 'rename';
  }
  if (!event.shiftKey && (event.code === 'KeyN' || key === 'n' || key === 'ㅜ')) return 'newDocument';
  return null;
}

export function shellShortcutDecision(event, target = event.target) {
  const action = shellShortcutKey(event);
  if (!action) return { prevent: false, action: null };
  if (event.isComposing) return { prevent: true, action: null };
  // 시트·문서 편집기 안의 F2는 셀·글 편집 키다. 셸 이름 바꾸기로 가로채지 않는다(⌘⇧R은 그대로 동작).
  if (action === 'rename' && !event.metaKey && target?.closest?.('#office-host')) return { prevent: false, action: null };
  const inProtectedInput = target?.closest?.('.rename-input, .new-doc-row input');
  const inDialog = target?.closest?.('dialog[open], [role="dialog"], [aria-modal="true"]');
  return { prevent: true, action: inProtectedInput || inDialog ? null : action };
}
