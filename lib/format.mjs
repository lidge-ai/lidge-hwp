import { applyCall, readApi } from './ops.mjs';
import { resolveScope } from './scope.mjs';
import { resolveCell } from './cells.mjs';
// 키·값 규칙은 api-registry.mjs의 CHAR_RULES·PARA_RULES 하나를 같이 쓴다(hwp.api 직접 호출도 같은 검사를 받는다, 010).
import { CHAR_RULES, PARA_RULES, firstControlChar } from './api-registry.mjs';
const bad = why => Object.assign(new Error(`API_ARGS_INVALID: ${why}`), { code: 'API_ARGS_INVALID' });
// 문서를 바꾸지 않는 글자 속성 검사. setCell(format)이 칸을 지우기 전에 부른다(#30).
export function validateCharProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw bad('props object required');
  if (!Object.keys(props).length) throw bad('empty props');
  for (const [k, v] of Object.entries(props)) {
    if (k === 'size') { if (typeof v !== 'number' || !(v > 0 && v <= 4096)) throw bad('size pt'); continue; }
    if (k === 'fontName') { if (typeof v !== 'string' || !v || v.length > 10000 || firstControlChar(v)) throw bad('fontName'); continue; }
    if (!Object.hasOwn(CHAR_RULES, k) || !CHAR_RULES[k](v)) throw bad(`invalid char prop ${k}=${JSON.stringify(v)}`);
  }
  return props;
}
function charProps(doc, batch, props) {
  validateCharProps(props); // 글꼴 표 op(findOrCreateFontId)보다 먼저 전부 검사한다
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'size') { out.fontSize = Math.round(v * 100); continue; }
    if (k === 'fontName') { out.fontId = applyCall(doc, batch, 'findOrCreateFontId', [v]); continue; }
    out[k] = v;
  }
  return out;
}
function paraProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw bad('props object required');
  for (const [k, v] of Object.entries(props)) if (!Object.hasOwn(PARA_RULES, k) || !PARA_RULES[k](v)) throw bad(`invalid paragraph prop ${k}=${JSON.stringify(v)}`);
  if (!Object.keys(props).length) throw bad('empty props');
  return { ...props };
}
// #26: 문단 거리 단위. 쓰기 raw는 spacingBefore·spacingAfter가 1/100 pt, indent·marginLeft·marginRight가 1/200 pt다
// (rhwp helpers.rs:552-565). 읽기(getParaPropertiesAt)는 96 dpi px를 0.1 단위로 준다(formatting.rs:803-864).
const SPACING = ['spacingBefore', 'spacingAfter'], DOUBLE = ['indent', 'marginLeft', 'marginRight'];
function rawParaProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props) || !Object.hasOwn(props, 'unit')) return paraProps(props);
  const { unit, ...rest } = props;
  if (unit !== 'pt') throw bad(`unit must be 'pt' (omit unit for raw values)`);
  const p = { ...rest };
  for (const k of [...SPACING, ...DOUBLE]) if (Object.hasOwn(p, k)) {
    const v = p[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || (v < 0 && k !== 'indent')) throw bad(`invalid pt ${k}=${JSON.stringify(v)}`);
    p[k] = Math.round(v * (SPACING.includes(k) ? 100 : 200)) || 0;
  }
  return paraProps(p);
}
// px(0.1) → pt(0.1). 엔진 표시값 기준이며 raw 값을 정확히 되살리지는 않는다(로드맵 010-1).
function paraInPt(para) {
  const p = { ...para };
  for (const k of [...SPACING, ...DOUBLE]) if (typeof p[k] === 'number') p[k] = Math.round(p[k] * 7.5) / 10;
  return p;
}
export function format(doc, batch, scope, props) {
  const { targets, skipped } = resolveScope(doc, scope);
  const p = charProps(doc, batch, props);
  let applied = 0;
  for (const t of targets) {
    if (t.end <= t.start) continue; // 빈 범위는 편집기도 건너뛴다(command.ts:1147-1183)
    if (t.kind === 'body') applyCall(doc, batch, 'applyCharFormat', [t.section, t.para, t.start, t.end, p]);
    else if (t.kind === 'cell') applyCall(doc, batch, 'applyCharFormatInCell', [t.section, t.para, t.control, t.cell, t.cellPara, t.start, t.end, p]);
    else applyCall(doc, batch, 'applyCharFormatInCellByPath', [t.section, t.para, t.path, t.start, t.end, p]);
    applied++;
  }
  return { applied, skipped };
}
export function paraFormat(doc, batch, scope, props) {
  const { targets, skipped } = resolveScope(doc, scope);
  const p = rawParaProps(props);
  let applied = 0, nested = 0;
  for (const t of targets) {
    if (t.kind === 'body') applyCall(doc, batch, 'applyParaFormat', [t.section, t.para, p]);
    else if (t.kind === 'cell') applyCall(doc, batch, 'applyParaFormatInCell', [t.section, t.para, t.control, t.cell, t.cellPara, p]);
    else { nested++; continue; } // 중첩 칸 문단 서식 API(ByPath)가 rhwp에 없다
    applied++;
  }
  return { applied, skipped: nested ? [...skipped, `nested cell paragraphs: ${nested} (no paragraph-format API by path)`] : skipped };
}
export function getFormat(doc, at) {
  if (at?.unit !== undefined && at.unit !== 'pt') throw bad(`getFormat unit must be 'pt'`);
  const out = getFormatPx(doc, at);
  return at?.unit === 'pt' ? { ...out, para: paraInPt(out.para) } : out;
}
function getFormatPx(doc, at) {
  if (at?.table !== undefined) {
    const a = resolveCell(doc, at.table, at.row, at.col), cp = at.paragraph ?? 0, off = at.offset ?? 0;
    return { char: readApi(doc, 'getCellCharPropertiesAt', [a.section, a.para, a.control, a.cell, cp, off]),
      para: readApi(doc, 'getCellParaPropertiesAt', [a.section, a.para, a.control, a.cell, cp]) };
  }
  const s = at?.section ?? 0, p = at?.paragraph, off = at?.offset ?? 0;
  return { char: readApi(doc, 'getCharPropertiesAt', [s, p, off]), para: readApi(doc, 'getParaPropertiesAt', [s, p]) };
}
export const styles = doc => readApi(doc, 'getStyleList', []);
// #30 format:'plain'. 문서의 Normal(바탕글) 문단 스타일 글자 모양 중 CHAR_RULES가 받는 속성만(로드맵 010-3).
// 스타일이 없으면 PLAIN_STYLE_UNAVAILABLE이다. 다른 스타일(예: id 0)로 대신하지 않는다(로드맵 010-2).
export function normalCharProps(doc) {
  const list = styles(doc);
  const hit = list.find(s => s.type === 0 && (s.englishName === 'Normal' || s.name === '바탕글'));
  if (!hit) throw Object.assign(new Error('PLAIN_STYLE_UNAVAILABLE: Normal(바탕글) paragraph style not found; pass format:{...} explicitly'),
    { code: 'PLAIN_STYLE_UNAVAILABLE', details: { styles: list.slice(0, 20).map(({ id, name, englishName }) => ({ id, name, englishName })) } });
  const cp = readApi(doc, 'getStyleDetail', [hit.id])?.charProps ?? {};
  const out = {};
  if (typeof cp.fontFamily === 'string' && cp.fontFamily && !firstControlChar(cp.fontFamily)) out.fontName = cp.fontFamily;
  for (const k of Object.keys(CHAR_RULES)) if (k !== 'fontId' && Object.hasOwn(cp, k) && CHAR_RULES[k](cp[k])) out[k] = cp[k];
  return validateCharProps(out);
}
export function applyStyle(doc, batch, scope, style) {
  const list = styles(doc);
  const hit = typeof style === 'number' ? list.find(s => s.id === style) : list.find(s => s.name === style || s.englishName === style);
  if (!hit) throw bad(`style ${style}`);
  const { targets, skipped } = resolveScope(doc, scope);
  let applied = 0, nested = 0;
  for (const t of targets) {
    if (t.kind === 'body') applyCall(doc, batch, 'applyStyle', [t.section, t.para, hit.id]);
    else if (t.kind === 'cell') applyCall(doc, batch, 'applyCellStyle', [t.section, t.para, t.control, t.cell, t.cellPara, hit.id]);
    else { nested++; continue; }
    applied++;
  }
  return { applied, style: { id: hit.id, name: hit.name }, skipped: nested ? [...skipped, `nested cell paragraphs: ${nested} (no style API by path)`] : skipped };
}
