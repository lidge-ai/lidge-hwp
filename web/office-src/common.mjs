// 오피스 편집기 공용 도우미(번들 안).
export function bindSaveKey(element, onSave) {
  const handler = event => {
    const key = event.key?.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.code === 'KeyS' || key === 's' || key === 'ㄴ')) {
      event.preventDefault();
      event.stopPropagation();
      onSave();
    }
  };
  element.addEventListener('keydown', handler, true);
  return () => element.removeEventListener('keydown', handler, true);
}
export async function waitFor(check, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Object.assign(new Error('EDITOR_TIMEOUT'), { code: 'EDITOR_TIMEOUT' });
}

