import { applyCall, readApi } from './ops.mjs';
import { resolveScope } from './scope.mjs';
import { resolveCell } from './cells.mjs';
// 키·값 규칙은 api-registry.mjs의 CHAR_RULES·PARA_RULES 하나를 같이 쓴다(hwp.api 직접 호출도 같은 검사를 받는다, 010).
import { CHAR_RULES, PARA_RULES } from './api-registry.mjs';
const bad = why => Object.assign(new Error(`API_ARGS_INVALID: ${why}`), { code: 'API_ARGS_INVALID' });
function charProps(doc, batch, props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw bad('props object required');
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'size') { if (typeof v !== 'number' || !(v > 0 && v <= 4096)) throw bad('size pt'); out.fontSize = Math.round(v * 100); continue; }
    if (k === 'fontName') { if (typeof v !== 'string' || !v) throw bad('fontName'); out.fontId = applyCall(doc, batch, 'findOrCreateFontId', [v]); continue; }
    if (!Object.hasOwn(CHAR_RULES, k) || !CHAR_RULES[k](v)) throw bad(`invalid char prop ${k}=${JSON.stringify(v)}`);
    out[k] = v;
  }
  if (!Object.keys(out).length) throw bad('empty props');
  return out;
}
function paraProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw bad('props object required');
  for (const [k, v] of Object.entries(props)) if (!Object.hasOwn(PARA_RULES, k) || !PARA_RULES[k](v)) throw bad(`invalid paragraph prop ${k}=${JSON.stringify(v)}`);
  if (!Object.keys(props).length) throw bad('empty props');
  return { ...props };
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
  const p = paraProps(props);
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
  if (at?.table !== undefined) {
    const a = resolveCell(doc, at.table, at.row, at.col), cp = at.paragraph ?? 0, off = at.offset ?? 0;
    return { char: readApi(doc, 'getCellCharPropertiesAt', [a.section, a.para, a.control, a.cell, cp, off]),
      para: readApi(doc, 'getCellParaPropertiesAt', [a.section, a.para, a.control, a.cell, cp]) };
  }
  const s = at?.section ?? 0, p = at?.paragraph, off = at?.offset ?? 0;
  return { char: readApi(doc, 'getCharPropertiesAt', [s, p, off]), para: readApi(doc, 'getParaPropertiesAt', [s, p]) };
}
export const styles = doc => readApi(doc, 'getStyleList', []);
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
