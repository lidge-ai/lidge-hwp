// hwp.insertText·hwp.setCell 도우미 옵션(#28 splitLines, #30 format). 새 op 종류는 만들지 않는다: 기존 insertText·setCell·
// insertTextInCell op와 허용 목록 call(splitParagraph·splitParagraphInCell·mergeParagraphInCell·applyCharFormatInCell·
// findOrCreateFontId)만 순서대로 남기므로 탭(rhwp-studio agent-ops.ts)은 지금 재생 코드로 같은 결과를 만든다.
// 모든 검사(글·좌표·서식·op 수)는 문서를 바꾸기 전에 끝낸다.
import { applyOp, applyCall, checked, splitTextLines, plannedOp, plannedCall, preflightBatch } from './ops.mjs';
import { resolveCell, cellText } from './cells.mjs';
import { format, normalCharProps, validateCharProps } from './format.mjs';
const nat = n => Number.isSafeInteger(n) && n >= 0;
const bad = why => Object.assign(new Error(`API_ARGS_INVALID: ${why}`), { code: 'API_ARGS_INVALID' });
// 편집 뒤에야 아는 오프셋·길이는 UTF-16 길이(엔진 글자 수 이상)로, 글꼴 id는 최댓값(CHAR_RULES fontId 65535)으로 잡는다.
// 그래서 사전 계산은 실제 적재와 같거나 몇 바이트 크다(test/ops.test.mjs 경계 시험).
const MAX_FONT_ID = 65535;
function plannedCellFormat(props, a, paras) {
  if (!props) return [];
  const out = [], p = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'size') p.fontSize = Math.round(v * 100);
    else if (k === 'fontName') { out.push(plannedCall('findOrCreateFontId', [v])); p.fontId = MAX_FONT_ID; }
    else p[k] = v;
  }
  for (const { cellPara, end } of paras) out.push(plannedCall('applyCharFormatInCell', [a.section, a.para, a.control, a.cell, cellPara, 0, end, p]));
  return out;
}
function splitFlag(v) {
  if (v !== undefined && typeof v !== 'boolean') throw bad('splitLines must be boolean');
  return v === true;
}
// insertText. splitLines:true면 줄마다 넣고 줄 사이에서 문단을 나눈다. 삽입 위치 뒤의 원래 글은 마지막 줄 뒤에 남는다.
export function insertTextHelper(doc, batch, args) {
  const { splitLines, ...rest } = args ?? {};
  if (!splitFlag(splitLines)) return applyOp(doc, batch, 'insertText', rest);
  if (rest.text === '') throw new Error('empty text');
  const lines = splitTextLines(rest.text, 'text');
  const section = rest.section ?? 0, paragraph = rest.paragraph;
  if (!nat(section) || section >= doc.getSectionCount() || !nat(paragraph) || paragraph >= doc.getParagraphCount(section))
    throw new Error('paragraph out of bounds');
  const length = doc.getParagraphLength(section, paragraph), offset = rest.offset ?? length;
  if (!nat(offset) || offset > length) throw new Error('paragraph offset out of bounds');
  const planned = [];
  for (let i = 0, p = paragraph, o = offset; i < lines.length; i++) {
    const text = lines[i];
    if (text) {
      planned.push(plannedOp('insertText', { section, paragraph: p }, { section, para: p, control: null, cell: null, offset: o, length: 0 },
        { section, paragraph: p, offset: o, text }));
      o += text.length;
    }
    if (i < lines.length - 1) { planned.push(plannedCall('splitParagraph', [section, p, o])); p++; o = 0; }
  }
  preflightBatch(batch, planned); // 개수·바이트 모두, 첫 편집 전에
  let p = paragraph, o = offset;
  lines.forEach((line, i) => {
    if (line) {
      const before = doc.getParagraphLength(section, p);
      applyOp(doc, batch, 'insertText', { section, paragraph: p, offset: o, text: line });
      o += doc.getParagraphLength(section, p) - before;
    }
    if (i < lines.length - 1) { applyCall(doc, batch, 'splitParagraph', [section, p, o]); p++; o = 0; }
  });
  return { first: { section, paragraph }, last: { section, paragraph: p }, lineCount: lines.length };
}
// format: 생략·'inherit' → null(기존 동작: 안내 글의 글자 모양을 물려받는다), 'plain' → Normal 스타일, 객체 → 그 속성.
export function cellFormatArg(doc, value) {
  if (value === undefined || value === 'inherit') return null;
  if (value === 'plain') return normalCharProps(doc);
  if (value && typeof value === 'object' && !Array.isArray(value)) return validateCharProps(value);
  throw bad("format must be 'inherit', 'plain' or a charProps object");
}
// setCell. splitLines:true면 칸 문단 수가 줄 수와 같아진다(원래 문단을 합친 뒤 줄마다 나눈다). 생략하면 기존 setCell 그대로다.
export function setCellHelper(doc, batch, args) {
  const { format: fmt, splitLines, ...low } = args ?? {};
  const split = splitFlag(splitLines);
  const props = cellFormatArg(doc, fmt);
  const lines = split ? splitTextLines(low.text, 'text') : [checked(low.text, 'text')];
  const filled = lines.filter(Boolean).length, wantFormat = Boolean(props && filled);
  let result;
  if (split) {
    const a = resolveCell(doc, low.table, low.row, low.col);
    const original = doc.getCellParagraphCount(a.section, a.para, a.control, a.cell);
    const logical = { table: low.table, row: low.row, col: low.col }, resolved = { section: a.section, para: a.para, control: a.control, cell: a.cell };
    const planned = [plannedOp('setCell', logical, resolved, { ...low, text: lines[0] })];
    for (let p = original - 1; p >= 1; p--) planned.push(plannedCall('mergeParagraphInCell', [a.section, a.para, a.control, a.cell, p]));
    for (let i = 1; i < lines.length; i++) {
      planned.push(plannedCall('splitParagraphInCell', [a.section, a.para, a.control, a.cell, i - 1, lines[i - 1].length]));
      if (lines[i]) planned.push(plannedOp('insertTextInCell', logical, resolved,
        { table: low.table, row: low.row, col: low.col, paragraph: i, offset: 0, text: lines[i] }));
    }
    if (wantFormat) planned.push(...plannedCellFormat(props, a, lines.flatMap((t, i) => t ? [{ cellPara: i, end: t.length }] : [])));
    preflightBatch(batch, planned); // 개수·바이트 모두, 첫 편집 전에
    const { before } = applyOp(doc, batch, 'setCell', { ...low, text: lines[0] }); // 모든 문단의 글을 지우고 첫 줄을 넣는다
    for (let p = original - 1; p >= 1; p--) applyCall(doc, batch, 'mergeParagraphInCell', [a.section, a.para, a.control, a.cell, p]);
    for (let i = 1; i < lines.length; i++) {
      applyCall(doc, batch, 'splitParagraphInCell', [a.section, a.para, a.control, a.cell, i - 1,
        doc.getCellParagraphLength(a.section, a.para, a.control, a.cell, i - 1)]);
      if (lines[i]) applyOp(doc, batch, 'insertTextInCell', { table: low.table, row: low.row, col: low.col, paragraph: i, offset: 0, text: lines[i] });
    }
    result = { before, after: cellText(doc, a), lineCount: lines.length };
  } else {
    if (wantFormat) {
      const a = resolveCell(doc, low.table, low.row, low.col);
      preflightBatch(batch, [plannedOp('setCell', { table: low.table, row: low.row, col: low.col },
        { section: a.section, para: a.para, control: a.control, cell: a.cell }, { ...low }),
      ...plannedCellFormat(props, a, [{ cellPara: 0, end: lines[0].length }])]);
    }
    result = applyOp(doc, batch, 'setCell', low);
  }
  if (wantFormat) result = { ...result, formatted: format(doc, batch, { table: low.table, row: low.row, col: low.col }, props).applied };
  return result;
}
