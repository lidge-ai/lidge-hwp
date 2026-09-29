// DOCX 본문 문단 읽기·바꾸기(OOXML 직접). 에이전트(office_exec)와 테스트가 쓴다.
// word/document.xml만 고치고 나머지 부품(그림·머리글·스타일 등)은 바이트 그대로 둔다.
import { readZip, writeZip, text as textOf, bytesOf } from './zip.mjs';

const fail = (status, code, details) => { throw Object.assign(new Error(code), { status, code, details }); };
const PART = 'word/document.xml';
const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const escapeXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 본문 문단(<w:p>…</w:p> 또는 <w:p/>). 표 안 문단도 순서대로 센다.
const PARA = /<w:p(?=[\s>/])(?:[^>]*\/>|[^>]*>[\s\S]*?<\/w:p>)/g;
const TEXT = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)|<w:t(?:\s[^>]*)?\/>/g;

function load(bytes) {
  let files;
  try { files = readZip(bytes); } catch { fail(400, 'INVALID_BYTES'); }
  const part = files.get(PART);
  if (!part) fail(400, 'INVALID_BYTES');
  return { files, xml: textOf(part) };
}
const save = (files, xml) => { files.set(PART, bytesOf(xml)); return writeZip(files); };
function runsOf(paraXml) {
  const runs = [];
  for (const m of paraXml.matchAll(TEXT)) if (m[1]) runs.push({ index: m.index, open: m[1], body: m[2], close: m[3], text: unescapeXml(m[2]) });
  return runs;
}

export function paragraphs(bytes) {
  const { xml } = load(bytes);
  return [...xml.matchAll(PARA)].map((m, index) => ({ index, text: runsOf(m[0]).map(r => r.text).join('') }));
}
export function documentText(bytes) { return paragraphs(bytes).map(p => p.text).join('\n'); }

// 문단 안에서 find를 replace로 바꾼다. 글자가 여러 런(w:t)에 나뉘어 있어도 찾는다.
// 바뀐 글자는 일치가 시작된 런에 넣고, 뒤따르는 런에서는 일치 부분만 지운다(런 서식은 유지).
export function replaceText(bytes, { find, replace, expectedCount } = {}) {
  if (typeof find !== 'string' || !find || typeof replace !== 'string') fail(400, 'API_ARGS_INVALID');
  const { files, xml } = load(bytes);
  let count = 0;
  const next = xml.replace(PARA, para => {
    const runs = runsOf(para);
    if (!runs.length) return para;
    const full = runs.map(r => r.text).join('');
    if (!full.includes(find)) return para;
    // 런별 새 텍스트 계산
    const starts = []; let pos = 0;
    for (const r of runs) { starts.push(pos); pos += r.text.length; }
    const out = runs.map(r => r.text.split(''));
    let from = 0;
    for (;;) {
      const at = full.indexOf(find, from);
      if (at < 0) break;
      count += 1;
      const end = at + find.length;
      let placed = false;
      runs.forEach((r, i) => {
        const s = starts[i], e = s + r.text.length;
        for (let k = Math.max(at, s); k < Math.min(end, e); k += 1) {
          out[i][k - s] = placed ? '' : (placed = true, replace);
        }
      });
      from = end;
    }
    let result = '', cursor = 0;
    runs.forEach((r, i) => {
      const value = out[i].join('');
      const open = /xml:space=/.test(r.open) ? r.open : r.open.replace(/^<w:t/, '<w:t xml:space="preserve"');
      result += para.slice(cursor, r.index) + open + escapeXml(value) + r.close;
      cursor = r.index + r.open.length + r.body.length + r.close.length;
    });
    return result + para.slice(cursor);
  });
  if (expectedCount !== undefined && count !== expectedCount) fail(409, 'REPLACE_COUNT_MISMATCH', { expected: expectedCount, actual: count });
  return { bytes: count ? save(files, next) : Buffer.from(bytes), count };
}

// 본문 끝(sectPr 앞)에 문단 하나를 붙인다.
export function appendParagraph(bytes, value) {
  if (typeof value !== 'string') fail(400, 'API_ARGS_INVALID');
  const { files, xml } = load(bytes);
  const para = '<w:p><w:r><w:t xml:space="preserve">' + escapeXml(value) + '</w:t></w:r></w:p>';
  const sect = xml.lastIndexOf('<w:sectPr');
  const bodyEnd = xml.lastIndexOf('</w:body>');
  if (bodyEnd < 0) fail(400, 'INVALID_BYTES');
  const at = sect >= 0 && sect < bodyEnd ? sect : bodyEnd;
  return save(files, xml.slice(0, at) + para + xml.slice(at));
}

