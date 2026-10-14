// 형식 레지스트리. 서버(docstore·api)와 브라우저(/formats.mjs)가 같은 표를 쓴다. 의존성 없음.
// HWP/HWPX 판정은 lib/docstore.mjs의 matchesFormat이 예전 그대로 맡는다(rhwp 경로 불변).
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const starts = (b, sig) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
const MAGIC = {
  cfb: b => starts(b, CFB),
  zip: b => starts(b, ZIP),
  rtf: b => starts(b, [0x7b, 0x5c, 0x72, 0x74, 0x66]), // {\rtf
  // csv: NUL 없는 텍스트. UTF-16 BOM(FF FE / FE FF)으로 시작하면 NUL이 있어도 텍스트로 본다.
  text: b => starts(b, [0xff, 0xfe]) || starts(b, [0xfe, 0xff]) || !b.subarray(0, 4096).includes(0),
};

// family: 편집기 묶음. edit: 'rhwp' | 'sheet' | 'docx' | null(읽기 전용, 미리보기·사본 변환만).
// via: 편집 전후로 LibreOffice(soffice) 변환이 필요한 형식(docx로 바꿔 편집하고 저장 때 되돌린다).
export const FORMATS = Object.freeze({
  hwp: { family: 'hwp', magic: 'cfb', edit: 'rhwp', label: 'HWP' },
  hwpx: { family: 'hwp', magic: 'zip', edit: 'rhwp', label: 'HWPX' },
  xlsx: { family: 'sheet', magic: 'zip', edit: 'sheet', label: 'XLSX' },
  xls: { family: 'sheet', magic: 'cfb', edit: 'sheet', label: 'XLS' },
  ods: { family: 'sheet', magic: 'zip', edit: 'sheet', label: 'ODS' },
  csv: { family: 'sheet', magic: 'text', edit: 'sheet', label: 'CSV' },
  numbers: { family: 'sheet', magic: 'zip', edit: 'sheet', label: 'NUM' },
  docx: { family: 'doc', magic: 'zip', edit: 'docx', label: 'DOCX' },
  odt: { family: 'doc', magic: 'zip', edit: 'docx', via: 'soffice', label: 'ODT' },
  rtf: { family: 'doc', magic: 'rtf', edit: 'docx', via: 'soffice', label: 'RTF' },
  doc: { family: 'doc', magic: 'cfb', edit: 'docx', via: 'soffice', label: 'DOC' },
  pages: { family: 'doc', magic: 'zip', edit: null, via: 'soffice', label: 'PAGES' },
  pptx: { family: 'slides', magic: 'zip', edit: null, label: 'PPTX' },
  ppt: { family: 'slides', magic: 'cfb', edit: null, label: 'PPT' },
  odp: { family: 'slides', magic: 'zip', edit: null, label: 'ODP' },
  key: { family: 'slides', magic: 'zip', edit: null, label: 'KEY' },
});

export function formatOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name ?? ''));
  const format = match?.[1].toLowerCase();
  return format && Object.hasOwn(FORMATS, format) ? format : null;
}
export const isKnownFormat = format => typeof format === 'string' && Object.hasOwn(FORMATS, format);
export const familyOf = format => (isKnownFormat(format) ? FORMATS[format].family : null);
export const isEditable = format => isKnownFormat(format) && Boolean(FORMATS[format].edit);
export const labelOf = format => (isKnownFormat(format) ? FORMATS[format].label : String(format ?? '').toUpperCase());
export const needsConversion = format => isKnownFormat(format) && FORMATS[format].via === 'soffice';
export function matchesBytes(bytes, format) {
  if (!isKnownFormat(format) || !bytes) return false;
  if (bytes.length < (FORMATS[format].magic === 'text' ? 1 : 4)) return false;
  return MAGIC[FORMATS[format].magic](bytes);
}
// 목록에서 빼는 파일: 쓰기 중 임시 파일(.lidge-*.tmp)과 Office 잠금 파일(~$*).
export const isListedName = name => !name.startsWith('~$') && !name.startsWith('.lidge-') && formatOf(name) !== null;
export const ACCEPT = Object.keys(FORMATS).map(format => '.' + format).join(',');
// 새 문서로 만들 수 있는 형식(빈 바이트를 코드로 만든다).
export const NEW_FORMATS = Object.freeze(['hwp', 'xlsx', 'docx']);
