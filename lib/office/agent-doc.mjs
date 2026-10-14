// office_exec 문서 엔진. docx는 OOXML을 직접 고치고(lib/office/docx-text.mjs), odt·rtf·doc은 LibreOffice로 docx에 들렀다 돌아온다.
import { paragraphs, replaceText, appendParagraph, documentText } from './docx-text.mjs';

const fail = (code, details, status = 400) => { throw Object.assign(new Error(code), { code, status, ...(details !== undefined ? { details } : {}) }); };

export async function openDoc(bytes, format, { convert }) {
  const via = format !== 'docx';
  const docx = via ? await convert(bytes, { from: format, to: 'docx' }) : Buffer.from(bytes);
  return { format, via, docx, expectations: [], edited: false };
}
export const docParagraphs = model => paragraphs(model.docx);
export function docFind(model, { query } = {}) {
  if (typeof query !== 'string' || !query) fail('API_ARGS_INVALID', { query });
  return paragraphs(model.docx).map(p => ({ paragraph: p.index, count: p.text.split(query).length - 1 })).filter(hit => hit.count > 0);
}
export function docReplace(model, args = {}) {
  const { bytes, count } = replaceText(model.docx, args);
  if (count) { model.docx = bytes; model.edited = true; model.expectations.push({ kind: 'replace', find: args.find, replace: args.replace }); }
  return { count };
}
export function docAppend(model, { text } = {}) {
  model.docx = appendParagraph(model.docx, text);
  model.edited = true;
  model.expectations.push({ kind: 'append', text });
  return { paragraphs: paragraphs(model.docx).length };
}
// 저장 전 확인: 편집한 docx를 다시 읽어 기대가 맞는지 본다(변환 전). 바꾼 글은 있고, 찾은 글은 replace가 품고 있지 않은 한 없다.
export function verifyDoc(model) {
  const text = documentText(model.docx);
  const mismatches = [];
  for (const e of model.expectations) {
    if (e.kind === 'replace') {
      if (!text.includes(e.replace)) mismatches.push({ expected: 'contains ' + JSON.stringify(e.replace) });
      if (!e.replace.includes(e.find) && text.includes(e.find)) mismatches.push({ expected: 'no ' + JSON.stringify(e.find) });
    } else if (!text.includes(e.text)) mismatches.push({ expected: 'contains ' + JSON.stringify(e.text) });
  }
  if (mismatches.length) fail('AGENT_VERIFY_MISMATCH', { mismatches }, 409);
}
export async function docBytes(model, { convert }) {
  return model.via ? convert(model.docx, { from: 'docx', to: model.format }) : model.docx;
}
export const docWarnings = model => (model.via ? ['CONVERTED_VIA_LIBREOFFICE'] : []);

