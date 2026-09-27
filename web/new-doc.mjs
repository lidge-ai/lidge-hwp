export function isNewDocShortcut(event) {
  if (!event.metaKey || event.shiftKey || event.ctrlKey || event.isComposing) return false;
  if (!(event.code === 'KeyN' || ['n', 'N', 'ㅜ'].includes(event.key))) return false;
  const target = event.target;
  return !target?.isContentEditable && !/^(INPUT|TEXTAREA)$/.test(target?.tagName || '');
}
