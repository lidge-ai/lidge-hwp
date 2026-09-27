export const isCopyPathShortcut = (event) => event.metaKey && event.shiftKey
  && !event.altKey && !event.ctrlKey && !event.isComposing
  && (event.code === 'KeyC' || ['c', 'C', 'ㅊ'].includes(event.key));

export async function copyPath(id, { request, clipboard, say }) {
  if (!id) { say('경로를 복사할 문서를 선택하세요.'); return false; }
  try {
    const response = await request(`/api/docs/${encodeURIComponent(id)}/path`);
    const { path } = await response.json();
    await clipboard.writeText(path);
    say(`경로 복사됨: ${path}`);
    return true;
  } catch (error) { say(`경로 복사 실패: ${error.message}`); return false; }
}
