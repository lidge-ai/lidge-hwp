// 칸 안 표(한 겹)의 글 편집과 체크박스. 새 op 종류는 만들지 않는다: 허용 목록 ByPath call(insert/delete/split/merge
// TextInCellByPath, applyCharFormatInCellByPath)과 기존 칸·본문 call만 남기므로 탭(agent-ops.ts replayCall)이 그대로 재생한다.
// 서명 v2는 한 겹 중첩 칸의 글·글자 서식을 본다(signature.mjs nestedFormat). 두 겹 이상은 guardTarget이 거절한다.
import { applyCall, checked, splitTextLines, plannedCall, preflightBatch, codedError } from './ops.mjs';
import { tableAddresses, nestedTables, resolveNestedCell, nestedParagraphs, nestedCellText } from './cells.mjs';
import { resolveScope } from './scope.mjs';
import { format } from './format.mjs';
import { cellFormatArg } from './text-helpers.mjs';
const nat = n => Number.isSafeInteger(n) && n >= 0;
const bad = why => codedError('API_ARGS_INVALID', `API_ARGS_INVALID: ${why}`);
const MAX_FONT_ID = 65535;
function onlyKeys(args, allowed, name) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw bad(`${name} needs an object`);
  const extra = Object.keys(args).filter(k => !allowed.includes(k));
  if (extra.length) throw bad(`${name}: unknown keys ${extra.slice(0, 5).join(', ')} (allowed: ${allowed.join(', ')})`);
}
function plannedFormat(props, c, lines) {
  if (!props) return [];
  const out = [], p = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'size') p.fontSize = Math.round(v * 100);
    else if (k === 'fontName') { out.push(plannedCall('findOrCreateFontId', [v])); p.fontId = MAX_FONT_ID; }
    else p[k] = v;
  }
  lines.forEach((t, i) => { if (t) out.push(plannedCall('applyCharFormatInCellByPath', [c.section, c.para, c.pathFor(i), 0, t.length, p])); });
  return out;
}

// hwp.setCell(h,{nested,row,col,text,splitLines?,format?}). 최상위 setCell과 같은 규칙: 칸의 모든 문단 글을 지우고 첫 문단에 넣는다.
// splitLines:true면 문단을 하나로 합친 뒤 줄마다 나눈다(문단 수 = 줄 수).
export function nestedSetCell(doc, batch, args) {
  onlyKeys(args, ['nested', 'row', 'col', 'text', 'splitLines', 'format'], 'setCell');
  const { nested, row, col, text, splitLines, format: fmt } = args;
  if (splitLines !== undefined && typeof splitLines !== 'boolean') throw bad('splitLines must be boolean');
  const props = cellFormatArg(doc, fmt);
  const lines = splitLines ? splitTextLines(text, 'text') : [checked(text, 'text')];
  const c = resolveNestedCell(doc, nested, row, col), s = c.section, pp = c.para;
  const paras = nestedParagraphs(doc, c), before = nestedCellText(doc, c);
  const planned = [];
  paras.forEach((p, i) => { if (p.length) planned.push(plannedCall('deleteTextInCellByPath', [s, pp, c.pathFor(i), 0, p.length])); });
  if (splitLines) for (let p = paras.length - 1; p >= 1; p--) planned.push(plannedCall('mergeParagraphInCellByPath', [s, pp, c.pathFor(p)]));
  lines.forEach((line, i) => {
    if (i > 0) planned.push(plannedCall('splitParagraphInCellByPath', [s, pp, c.pathFor(i - 1), lines[i - 1].length]));
    if (line) planned.push(plannedCall('insertTextInCellByPath', [s, pp, c.pathFor(i), 0, line]));
  });
  planned.push(...plannedFormat(props, c, lines));
  preflightBatch(batch, planned); // 개수·바이트 모두, 첫 편집 전에
  for (let i = paras.length - 1; i >= 0; i--)
    if (paras[i].length) applyCall(doc, batch, 'deleteTextInCellByPath', [s, pp, c.pathFor(i), 0, paras[i].length]);
  if (splitLines) for (let p = paras.length - 1; p >= 1; p--) applyCall(doc, batch, 'mergeParagraphInCellByPath', [s, pp, c.pathFor(p)]);
  lines.forEach((line, i) => {
    if (i > 0) applyCall(doc, batch, 'splitParagraphInCellByPath', [s, pp, c.pathFor(i - 1),
      doc.getCellParagraphLengthByPath(s, pp, JSON.stringify(c.pathFor(i - 1)))]);
    if (line) applyCall(doc, batch, 'insertTextInCellByPath', [s, pp, c.pathFor(i), 0, line]);
  });
  const result = { before, after: nestedCellText(doc, c), ...(splitLines ? { lineCount: lines.length } : {}) };
  if (props && lines.some(Boolean)) result.formatted = format(doc, batch, { nested, row, col }, props).applied;
  return result;
}

// hwp.insertTextInCell(h,{nested,row,col,paragraph?,offset?,text}). offset을 빼면 문단 끝이다.
export function nestedInsertText(doc, batch, args) {
  onlyKeys(args, ['nested', 'row', 'col', 'paragraph', 'offset', 'text'], 'insertTextInCell');
  const c = resolveNestedCell(doc, args.nested, args.row, args.col);
  const text = checked(args.text, 'text');
  if (!text) throw new Error('empty text');
  const paras = nestedParagraphs(doc, c), paragraph = args.paragraph ?? 0;
  if (!nat(paragraph) || paragraph >= paras.length) throw new Error(`cell insertion out of bounds: paragraph ${paragraph} (cell has ${paras.length})`);
  const offset = args.offset ?? paras[paragraph].length;
  if (!nat(offset) || offset > paras[paragraph].length) throw new Error(`cell insertion out of bounds: offset ${offset} (length ${paras[paragraph].length})`);
  const before = nestedCellText(doc, c);
  applyCall(doc, batch, 'insertTextInCellByPath', [c.section, c.para, c.pathFor(paragraph), offset, text]);
  return { before, after: nestedCellText(doc, c) };
}

// 중첩 칸 경로 → {nested,row,col,paragraph}. find 결과와 체크박스 주소에 쓴다.
export function nestedAddressOf(doc, section, para, path, tables = nestedTables(doc)) {
  if (!Array.isArray(path) || path.length !== 2) return null;
  const t = tables.find(t => t.section === section && t.para === para && t.inner === path[1].controlIndex &&
    t.outer.controlIndex === path[0].controlIndex && t.outer.cellIndex === path[0].cellIndex && t.outer.cellParaIndex === path[0].cellParaIndex);
  if (!t) return null;
  const info = JSON.parse(doc.getCellInfoByPath(section, para, JSON.stringify([path[0], { ...path[1], cellParaIndex: 0 }])));
  return { nested: t.nested, row: info.row, col: info.col, paragraph: path[1].cellParaIndex };
}

// hwp.replaceText(h,{find,replace,scope:{nested,row?,col?},occurrence?,expectedCount?}). 후보 순서는 칸 순서·문단 순서·위치 순서다.
export function nestedReplaceText(doc, batch, args) {
  onlyKeys(args, ['find', 'replace', 'scope', 'occurrence', 'expectedCount'], 'replaceText');
  const find = checked(args.find, 'find'), replace = checked(args.replace ?? '', 'replace');
  if (!find) throw new Error('empty find');
  onlyKeys(args.scope, ['nested', 'row', 'col'], 'replaceText scope');
  const { targets } = resolveScope(doc, args.scope), tables = nestedTables(doc), hits = [];
  for (const t of targets) {
    const pathJson = JSON.stringify(t.path), text = doc.getTextInCellByPath(t.section, t.para, pathJson, 0, t.end);
    for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) {
      const offset = [...text.slice(0, i)].length, length = [...find].length;
      hits.push({ t, offset, length, at: { ...nestedAddressOf(doc, t.section, t.para, t.path, tables), offset, length } });
    }
  }
  const { expectedCount, occurrence } = args;
  if ((expectedCount !== undefined && (!nat(expectedCount) || hits.length !== expectedCount)) ||
      (occurrence !== undefined && (!nat(occurrence) || occurrence >= hits.length)) || !hits.length)
    throw codedError('REPLACE_COUNT_MISMATCH', `replace count mismatch: ${hits.length} (expected ${expectedCount ?? '>=1'}${occurrence !== undefined ? `, occurrence ${occurrence}` : ''})`,
      { actualCount: hits.length, positions: hits.slice(0, 100).map(h => h.at), omitted: Math.max(0, hits.length - 100) });
  const chosen = occurrence === undefined ? hits : [hits[occurrence]];
  const planned = chosen.flatMap(h => [plannedCall('deleteTextInCellByPath', [h.t.section, h.t.para, h.t.path, h.offset, h.length]),
    ...(replace ? [plannedCall('insertTextInCellByPath', [h.t.section, h.t.para, h.t.path, h.offset, replace])] : [])]);
  preflightBatch(batch, planned);
  for (const h of chosen) if (doc.getTextInCellByPath(h.t.section, h.t.para, JSON.stringify(h.t.path), h.offset, h.length) !== find)
    throw new Error('replace preimage mismatch');
  for (const h of chosen.toReversed()) { // 뒤에서부터(앞 치환이 뒤 오프셋을 밀지 않게)
    applyCall(doc, batch, 'deleteTextInCellByPath', [h.t.section, h.t.para, h.t.path, h.offset, h.length]);
    if (replace) applyCall(doc, batch, 'insertTextInCellByPath', [h.t.section, h.t.para, h.t.path, h.offset, replace]);
  }
  return { count: chosen.length, matchedCount: hits.length, positions: chosen.slice(0, 100).map(h => h.at) };
}

// ── 체크박스 ─────────────────────────────────────────────
// □는 빈 칸, ■☑▣☒는 체크. ■는 글머리표로도 흔히 쓰이므로 같은 문단에 □☑▣☒ 중 하나가 있을 때만 체크박스로 본다.
export const UNCHECKED = '□', CHECKED_MARKS = ['■', '☑', '▣', '☒'];
const STRONG = new Set(['□', '☑', '▣', '☒']);
function containerOf(doc, h, tops) {
  if (h.equationControl !== undefined) return null;
  if (h.cellPath) return h.cellPath.length === 2 ? { kind: 'nested', section: h.sec, para: h.para, path: h.cellPath } : null;
  if (h.cellContext) {
    const c = h.cellContext;
    if (!tops.some(t => t.section === h.sec && t.para === c.parentPara && t.control === c.ctrlIdx)) return null;
    return { kind: 'cell', section: h.sec, para: c.parentPara, control: c.ctrlIdx, cell: c.cellIdx, cellPara: c.cellPara };
  }
  return { kind: 'body', section: h.sec, para: h.para };
}
function reader(doc, w) {
  if (w.kind === 'body') return { length: doc.getParagraphLength(w.section, w.para), read: (o, n) => doc.getTextRange(w.section, w.para, o, n) };
  if (w.kind === 'cell') return { length: doc.getCellParagraphLength(w.section, w.para, w.control, w.cell, w.cellPara),
    read: (o, n) => doc.getTextInCell(w.section, w.para, w.control, w.cell, w.cellPara, o, n) };
  const path = JSON.stringify(w.path);
  return { length: doc.getCellParagraphLengthByPath(w.section, w.para, path), read: (o, n) => doc.getTextInCellByPath(w.section, w.para, path, o, n) };
}
function sortKey(w, offset) {
  const tail = w.kind === 'body' ? [0, 0, 0, 0, 0, 0] : w.kind === 'cell' ? [1, w.control, w.cell, w.cellPara, 0, 0]
    : [1, w.path[0].controlIndex, w.path[0].cellIndex, w.path[0].cellParaIndex, w.path[1].cellIndex + 1, w.path[1].cellParaIndex];
  return [w.section, w.para, ...tail, offset];
}
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
// 문서 순서의 체크박스 목록(내부용: 쓰기 주소 w 포함).
function scanBoxes(doc) {
  const tops = tableAddresses(doc), tables = nestedTables(doc), groups = new Map();
  for (const mark of [UNCHECKED, ...CHECKED_MARKS]) for (const h of JSON.parse(doc.searchAllText(mark, true, true))) {
    const w = containerOf(doc, h, tops);
    if (!w) continue;
    const key = JSON.stringify(w);
    if (!groups.has(key)) groups.set(key, { w, items: [] });
    groups.get(key).items.push({ mark, offset: h.charOffset });
  }
  const boxes = [];
  for (const { w, items } of groups.values()) {
    if (!items.some(i => STRONG.has(i.mark))) continue; // ■만 있는 문단은 글머리표
    items.sort((a, b) => a.offset - b.offset);
    const r = reader(doc, w);
    let where;
    if (w.kind === 'body') where = { section: w.section, paragraph: w.para };
    else if (w.kind === 'cell') {
      const info = JSON.parse(doc.getCellInfo(w.section, w.para, w.control, w.cell));
      where = { table: tops.findIndex(t => t.section === w.section && t.para === w.para && t.control === w.control), row: info.row, col: info.col, paragraph: w.cellPara };
    } else where = nestedAddressOf(doc, w.section, w.para, w.path, tables);
    if (!where) continue;
    items.forEach((it, i) => {
      const end = items[i + 1]?.offset ?? r.length;
      const label = r.read(it.offset + 1, Math.max(0, end - it.offset - 1)).replace(/^\s+/u, '').replace(/[\s,;/·|]+$/u, '').slice(0, 60);
      boxes.push({ w, key: sortKey(w, it.offset), checked: it.mark !== UNCHECKED, mark: it.mark, label, where, offset: it.offset,
        group: JSON.stringify(w) });
    });
  }
  boxes.sort((a, b) => cmp(a.key, b.key));
  return boxes;
}
const publicBox = (b, i) => ({ box: i, checked: b.checked, mark: b.mark, label: b.label, ...b.where, offset: b.offset });
export function checkboxes(doc, args = {}) {
  onlyKeys(args ?? {}, ['scope'], 'checkboxes');
  const all = scanBoxes(doc).map((b, i) => ({ b, i })).filter(({ b }) => inScope(b, args?.scope));
  return { total: all.length, boxes: all.slice(0, 500).map(({ b, i }) => publicBox(b, i)), omitted: Math.max(0, all.length - 500) };
}
// scope: {section?,paragraph} 본문 문단, {table,row?,col?} 최상위 표, {nested,row?,col?} 중첩 표. section은 모든 곳에 쓸 수 있다.
function inScope(b, scope) {
  if (scope === undefined || scope === null) return true;
  if (typeof scope !== 'object' || Array.isArray(scope)) throw bad('scope must be {paragraph,section?}, {table,row?,col?} or {nested,row?,col?}');
  const keys = Object.keys(scope);
  if (!keys.every(k => ['section', 'paragraph', 'table', 'nested', 'row', 'col'].includes(k))) throw bad(`checkbox scope keys ${keys.join(',')}`);
  if (keys.includes('paragraph') && !keys.some(k => k === 'table' || k === 'nested') && b.w.kind !== 'body') return false;
  return keys.every(k => k === 'section' ? b.w.section === scope.section : b.where[k] === scope[k]);
}
const squash = s => s.replace(/\s+/gu, '');
function pick(doc, args) {
  const all = scanBoxes(doc);
  if (args.box !== undefined) {
    if (!nat(args.box) || args.box >= all.length) throw codedError('CHECKBOX_NOT_FOUND', `CHECKBOX_NOT_FOUND: box ${args.box} (document has ${all.length}; list with hwp.checkboxes(h))`);
    return { all, target: all[args.box], index: args.box };
  }
  if (typeof args.label !== 'string' || !args.label.trim()) throw bad('setCheckbox needs {box} or {label, scope?} (or legacy {occurrence})');
  const inside = all.map((b, i) => ({ b, i })).filter(({ b }) => inScope(b, args.scope));
  const want = squash(args.label);
  let found = inside.filter(({ b }) => squash(b.label) === want);
  if (!found.length) found = inside.filter(({ b }) => squash(b.label).startsWith(want));
  const list = xs => xs.slice(0, 20).map(({ b, i }) => publicBox(b, i));
  if (!found.length) throw codedError('CHECKBOX_NOT_FOUND', `CHECKBOX_NOT_FOUND: no box labelled ${JSON.stringify(args.label)} in scope`, { candidates: list(inside) });
  if (found.length > 1) throw codedError('CHECKBOX_AMBIGUOUS', `CHECKBOX_AMBIGUOUS: ${found.length} boxes labelled ${JSON.stringify(args.label)}; add scope or use {box}`, { candidates: list(found) });
  return { all, target: found[0].b, index: found[0].i };
}
function writeMark(doc, batch, b, mark) {
  const w = b.w;
  if (w.kind === 'body') return applyCall(doc, batch, 'replaceText', [w.section, w.para, b.offset, 1, mark]);
  if (w.kind === 'cell') {
    const at = [w.section, w.para, w.control, w.cell, w.cellPara, b.offset];
    applyCall(doc, batch, 'deleteTextInCell', [...at, 1]);
    return applyCall(doc, batch, 'insertTextInCell', [...at, mark]);
  }
  applyCall(doc, batch, 'deleteTextInCellByPath', [w.section, w.para, w.path, b.offset, 1]);
  return applyCall(doc, batch, 'insertTextInCellByPath', [w.section, w.para, w.path, b.offset, mark]);
}
// hwp.setCheckbox(h,{box}|{label,scope?},{checked?,mark?,exclusive?}). mark를 빼면 같은 문단에서 쓰던 체크 표시, 없으면
// 문서에서 가장 많이 쓴 체크 표시, 그것도 없으면 ☑다. exclusive:true면 같은 문단의 다른 체크를 □로 되돌린다(라디오처럼).
export function setCheckboxHelper(doc, batch, args) {
  onlyKeys(args, ['box', 'label', 'scope', 'checked', 'mark', 'exclusive'], 'setCheckbox');
  const want = args.checked ?? true;
  if (typeof want !== 'boolean') throw bad('checked must be boolean');
  if (args.exclusive !== undefined && typeof args.exclusive !== 'boolean') throw bad('exclusive must be boolean');
  if (args.mark !== undefined && !CHECKED_MARKS.includes(args.mark)) throw bad(`mark must be one of ${CHECKED_MARKS.join(' ')}`);
  const { all, target, index } = pick(doc, args);
  const count = marks => { const m = new Map(); for (const b of marks) if (b.checked) m.set(b.mark, (m.get(b.mark) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0]; };
  const siblings = all.filter(b => b.group === target.group);
  const mark = want ? (args.mark ?? count(siblings) ?? count(all) ?? '☑') : UNCHECKED;
  const edits = [];
  if (target.mark !== mark) edits.push([target, mark]);
  if (want && args.exclusive) for (const b of siblings) if (b !== target && b.checked) edits.push([b, UNCHECKED]);
  preflightBatch(batch, edits.flatMap(() => [plannedCall('deleteTextInCellByPath', [0, 0, [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }], 0, 1]),
    plannedCall('insertTextInCellByPath', [0, 0, [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }], 0, mark])]));
  for (const [b, m] of edits) writeMark(doc, batch, b, m);
  const r = reader(doc, target.w), line = r.read(0, r.length);
  return { box: index, label: target.label, ...target.where, checked: want, mark, changed: edits.length, text: line.slice(0, 200) };
}
// 기존 {occurrence}(□ 검색 순서) 경로에서 한 겹 중첩 칸의 □. 표시는 예전처럼 ☑다.
export function legacyNestedCheckbox(doc, batch, h, occurrence) {
  const w = { kind: 'nested', section: h.sec, para: h.para, path: h.cellPath };
  writeMark(doc, batch, { w, offset: h.charOffset }, '☑');
  return { occurrence, ...nestedAddressOf(doc, h.sec, h.para, h.cellPath) };
}
