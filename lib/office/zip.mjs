// ZIP 읽기·쓰기. SheetJS에 들어 있는 CFB 모듈의 zip 지원을 쓴다(새 의존성 없음).
import * as XLSX from 'xlsx';
const { CFB } = XLSX;

// Map<경로, Uint8Array>. 디렉터리 항목은 뺀다. 경로는 'word/document.xml' 모양(앞의 'Root Entry/' 없음).
export function readZip(bytes) {
  const container = CFB.read(Buffer.from(bytes), { type: 'buffer' });
  const files = new Map();
  container.FileIndex.forEach((entry, index) => {
    if (entry.type !== 2 || !entry.content) return;
    const full = container.FullPaths[index].replace(/^[^/]*\//, '');
    // CFB가 읽을 때 넣는 자리 표시 항목(\u0001Sh33tJ5)은 실제 ZIP 항목이 아니다. 쓸 때도 CFB가 뺀다.
    if (full.startsWith('\u0001')) return;
    files.set(full, Uint8Array.from(entry.content));
  });
  return files;
}
export function writeZip(files, { compression = true } = {}) {
  const container = CFB.utils.cfb_new();
  for (const [path, content] of files) CFB.utils.cfb_add(container, path, Buffer.from(content));
  return Buffer.from(CFB.write(container, { fileType: 'zip', type: 'buffer', compression }));
}
export const text = bytes => new TextDecoder().decode(bytes);
export const bytesOf = string => new TextEncoder().encode(string);
