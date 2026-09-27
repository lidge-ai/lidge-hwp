import { createHash } from 'node:crypto';
import { tableAddresses, nestedCellParagraphs } from './cells.mjs';
import { openDocument, exportWithReport } from './rhwp-node.mjs';
import { canonical } from './api-registry.mjs';

// v2: v1(글·표 구조·컨트롤·스캔·보조 글)에 글자·문단 서식, 스타일 지정, 최상위 표 속성, 중첩 칸(한 겹)의 글·글자 서식을 더했다.
// 기대값과 실제값 모두 Node에서 계산하므로(runner, verifyAgentBytes) 브라우저 DPI·글꼴 측정이 끼지 않는다.
export const SIGNATURE_VERSION = 2;
// v1이 글·자리를 모두 읽어 담는 컨트롤 종류(getControls ctrlId, hwpctrl_sets.rs control_identity).
// 이 밖의 종류가 하나라도 있으면 unsupported → 에이전트 탭 저장을 거부한다(fail closed).
const COVERED = new Set(['secd', 'cold', 'pgnp', 'pghd', 'nwno', 'atno', 'tbl', 'gso', 'head', 'foot', 'fn', 'en']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const coded = (code, status, detail) => Object.assign(new Error(code), { code, status, detail });
// 저장 때 다시 매겨질 수 있는 번호만 뺀다(모양·테두리 표 번호). numberingId 같은 의미 있는 값은 남긴다.
const UNSTABLE = new Set(['charShapeId', 'paraShapeId', 'borderFillId']);
const STYLE_DROP = new Set(['id', 'paraShapeId', 'charShapeId']);
const keep = (json, drop = UNSTABLE) => {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  return canonical(Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !drop.has(k))));
};
// 빈 문단·스타일 읽기처럼 rhwp가 던질 수 있는 곳에만 쓴다. 던진 메시지도 서명에 들어가 양쪽이 같은 규칙을 쓴다.
const attempt = f => { try { return f(); } catch (e) { return `!${String(e?.message ?? e).slice(0, 80)}`; } };
// 글자 모양 구간 → [시작, 끝, 해석된 속성]. 속성이 같은 이웃 구간은 합친다.
function runs(length, runsJson, propsAt) {
  if (!length) return [[0, 0, attempt(() => keep(propsAt(0)))]];
  const out = [];
  for (const r of JSON.parse(runsJson())) {
    const props = keep(propsAt(r.startOffset)), last = out.at(-1);
    if (last && last[2] === props && last[1] === r.startOffset) last[1] = r.endOffset;
    else out.push([r.startOffset, r.endOffset, props]);
  }
  return out;
}
function bodyFormat(doc, s, p) {
  const len = doc.getParagraphLength(s, p);
  return [keep(doc.getParaPropertiesAt(s, p)), attempt(() => keep(doc.getStyleAt(s, p), STYLE_DROP)),
    runs(len, () => doc.getCharShapeRuns(s, p, 0, len), off => doc.getCharPropertiesAt(s, p, off))];
}
function cellFormat(doc, a, cell, cp) {
  const len = doc.getCellParagraphLength(a.section, a.para, a.control, cell, cp);
  const path = JSON.stringify([{ controlIndex: a.control, cellIndex: cell, cellParaIndex: cp }]);
  return [keep(doc.getCellParaPropertiesAt(a.section, a.para, a.control, cell, cp)),
    attempt(() => keep(doc.getCellStyleAt(a.section, a.para, a.control, cell, cp), STYLE_DROP)),
    runs(len, () => doc.getCharShapeRunsInCellByPath(a.section, a.para, path, 0, len),
      off => doc.getCellCharPropertiesAt(a.section, a.para, a.control, cell, cp, off))];
}
// 중첩 칸: 글과 글자 서식만(문단 서식 ByPath 읽기 API가 없다 — 허용 목록에도 그 쓰기가 없다).
function nestedFormat(doc, n) {
  const path = JSON.stringify(n.path);
  return [n.section, n.para, path, doc.getTextInCellByPath(n.section, n.para, path, 0, n.length),
    runs(n.length, () => doc.getCharShapeRunsInCellByPath(n.section, n.para, path, 0, n.length),
      off => doc.getCellCharPropertiesAtByPath(n.section, n.para, path, off))];
}

// 칸 문단별 원문. cellText(cells.mjs:30-38)와 달리 다듬지 않고 문단 경계를 배열로 남긴다.
function rawCellParagraphs(doc, a, cell) {
  const count = doc.getCellParagraphCount(a.section, a.para, a.control, cell);
  const paragraphs = [];
  for (let p = 0; p < count; p++) {
    const length = doc.getCellParagraphLength(a.section, a.para, a.control, cell, p);
    paragraphs.push(doc.getTextInCell(a.section, a.para, a.control, cell, p, 0, length));
  }
  return paragraphs;
}

// 문서 내용 서명 v1. {version, status:'ok', digest} 또는 {version, status:'unsupported', reasons}.
export function contentSignature(doc) {
  const reasons = [];
  if (typeof doc.lidgeAuxContent !== 'function') {
    return { version: SIGNATURE_VERSION, status: 'unsupported', reasons: ['lidgeAuxContent missing (fork WASM older than wp5)'] };
  }
  const sections = [], formats = [];
  for (let s = 0; s < doc.getSectionCount(); s++) {
    const paragraphs = [], fs = [];
    for (let p = 0; p < doc.getParagraphCount(s); p++) {
      paragraphs.push(doc.getTextRange(s, p, 0, doc.getParagraphLength(s, p)));
      fs.push(bodyFormat(doc, s, p));
    }
    sections.push(paragraphs); formats.push(fs);
  }
  const tables = tableAddresses(doc).map(a => ({
    at: [a.section, a.para, a.control], rows: a.rowCount, cols: a.colCount,
    props: keep(doc.getTableProperties(a.section, a.para, a.control)),
    cells: Array.from({ length: a.cellCount }, (_, cell) => {
      const info = JSON.parse(doc.getCellInfo(a.section, a.para, a.control, cell));
      const paras = rawCellParagraphs(doc, a, cell);
      return [info.row, info.col, info.rowSpan, info.colSpan, paras, paras.map((_, cp) => cellFormat(doc, a, cell, cp))];
    }),
  }));
  const nested = nestedCellParagraphs(doc);
  for (const why of nested.skipped) reasons.push(why); // 두 겹 이상 중첩 표는 서명이 못 본다 → 에이전트 탭 저장 거부(fail closed)
  const nestedFormats = nested.cells.map(n => nestedFormat(doc, n));
  const controls = JSON.parse(doc.getControls()).map(c => {
    if (!COVERED.has(c.ctrlId)) reasons.push(`control ${c.ctrlId} at list ${c.list} para ${c.para}`);
    return [c.ctrlId, c.list, c.para, c.pos, c.controlIndex];
  });
  const scan = JSON.parse(doc.getScanItems()).map(x => [x.state, x.kind, x.text]);
  const aux = JSON.parse(doc.lidgeAuxContent());
  if (aux?.schemaVersion !== 1 || !Array.isArray(aux.items)) reasons.push('lidgeAuxContent schema');
  const items = (aux?.items ?? []).map(item => {
    for (const why of item.unsupported ?? []) reasons.push(`${item.kind} ${item.section}/${item.path.join('/')}: ${why}`);
    return [item.kind, item.section, item.path, item.applyTo, item.texts];
  });
  if (reasons.length) return { version: SIGNATURE_VERSION, status: 'unsupported', reasons };
  const body = JSON.stringify({ v: SIGNATURE_VERSION, sections, formats, tables, nestedFormats, controls, scan, items });
  return { version: SIGNATURE_VERSION, status: 'ok', digest: sha256(body) };
}

// 에이전트 PUT 확인(api-docs). 받은 바이트를 Node에서 다시 열어 손실 보고를 서버에서 다시 재고(헤더만 믿지 않음),
// 내용 서명이 runner가 둔 기대값과 같을 때만 통과한다. 돌려주는 값은 saved[].verify: 'bytes' | 'content'.
export async function verifyAgentBytes(bytes, format, expected) {
  if (expected?.signature?.status !== 'ok' || typeof expected.signature.digest !== 'string') {
    throw coded('AGENT_VERIFY_MISSING', 409, 'no server-side expectation for this apply');
  }
  if (expected.signature.version !== SIGNATURE_VERSION) throw coded('AGENT_VERIFY_MISMATCH', 409, 'signature version');
  let doc;
  try { doc = await openDocument(bytes); }
  catch (error) { throw coded('AGENT_VERIFY_MISMATCH', 409, `reopen failed: ${error.message}`); }
  try {
    const { report } = exportWithReport(doc, format);
    if (report.count > 0) throw coded('CONTENT_LOSS', 422, `server report count ${report.count}`);
    const got = contentSignature(doc);
    if (got.status !== 'ok') throw coded('AGENT_VERIFY_MISMATCH', 409, `unsupported: ${got.reasons.slice(0, 3).join('; ')}`);
    if (got.digest !== expected.signature.digest) throw coded('AGENT_VERIFY_MISMATCH', 409, 'content signature differs');
    return sha256(bytes) === expected.exportSha256 ? 'bytes' : 'content';
  } finally { doc.free(); }
}
