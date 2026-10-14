// ZIP 계열 오피스 형식은 시그니처가 같다(PK\x03\x04). 가져오기·PUT에서 확장자를 바꿔 넣은 파일을 거르기 위해
// ZIP 안의 대표 항목 이름이 바이트에 있는지 본다(로컬 헤더의 파일 이름은 압축되지 않는다). 서버 전용.
import { matchesBytes, FORMATS } from '../formats.mjs';

const ZIP_MARKERS = {
  xlsx: ['xl/workbook'],
  docx: ['word/document.xml'],
  pptx: ['ppt/presentation.xml'],
  ods: ['application/vnd.oasis.opendocument.spreadsheet'],
  odt: ['application/vnd.oasis.opendocument.text'],
  odp: ['application/vnd.oasis.opendocument.presentation'],
  // iWork 2013+는 Index/Document.iwa, iWork '09는 index.xml(Keynote는 index.apxl).
  numbers: ['Index/Document.iwa', 'index.xml', 'Index.zip'],
  pages: ['Index/Document.iwa', 'index.xml', 'Index.zip'],
  key: ['Index/Document.iwa', 'index.apxl', 'Index.zip'],
};

export function sniffBytes(bytes, format) {
  if (!matchesBytes(bytes, format)) return false;
  const markers = ZIP_MARKERS[format];
  if (!markers || FORMATS[format].magic !== 'zip') return true;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return markers.some(marker => buffer.includes(marker, 0, 'latin1'));
}

