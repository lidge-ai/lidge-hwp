// hwp.insertText·hwp.setCell 도우미 옵션(#28 splitLines, #30 format). 새 op 종류는 만들지 않는다: 기존 insertText·setCell·
// insertTextInCell op와 허용 목록 call(splitParagraph·splitParagraphInCell·mergeParagraphInCell·applyCharFormatInCell·
// findOrCreateFontId)만 순서대로 남기므로 탭(rhwp-studio agent-ops.ts)은 지금 재생 코드로 같은 결과를 만든다.
// 모든 검사(글·좌표·서식·op 수)는 문서를 바꾸기 전에 끝낸다.
import { applyOp, applyCall, checked, splitTextLines, preflightOps } from './ops.mjs';
import { resolveCell, cellText } from './cells.mjs';
import { format, normalCharProps, validateCharProps } from './format.mjs';
const nat = n => Number.isSafeInteger(n) && n >= 0;
const bad = why => Object.assign(new Error(`API_ARGS_INVALID: ${why}`), { code: 'API_ARGS_INVALID' });
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
  preflightOps(batch, lines.filter(Boolean).length + lines.length - 1);
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
function cellFormat(doc, value) {
  if (value === undefined || value === 'inherit') return null;
  if (value === 'plain') return normalCharProps(doc);
  if (value && typeof value === 'object' && !Array.isArray(value)) return validateCharProps(value);
  throw bad("format must be 'inherit', 'plain' or a charProps object");
}
// setCell. splitLines:true면 칸 문단 수가 줄 수와 같아진다(원래 문단을 합친 뒤 줄마다 나눈다). 생략하면 기존 setCell 그대로다.
export function setCellHelper(doc, batch, args) {
  const { format: fmt, splitLines, ...low } = args ?? {};
  const split = splitFlag(splitLines);
  const props = cellFormat(doc, fmt);
  const lines = split ? splitTextLines(low.text, 'text') : [checked(low.text, 'text')];
  const filled = lines.filter(Boolean).length;
  const formatOps = props && filled ? filled + (props.fontName ? 1 : 0) : 0;
  let result;
  if (split) {
    const a = resolveCell(doc, low.table, low.row, low.col);
    const original = doc.getCellParagraphCount(a.section, a.para, a.control, a.cell);
    preflightOps(batch, 1 + (original - 1) + (lines.length - 1) + lines.slice(1).filter(Boolean).length + formatOps);
    const { before } = applyOp(doc, batch, 'setCell', { ...low, text: lines[0] }); // 모든 문단의 글을 지우고 첫 줄을 넣는다
    for (let p = original - 1; p >= 1; p--) applyCall(doc, batch, 'mergeParagraphInCell', [a.section, a.para, a.control, a.cell, p]);
    for (let i = 1; i < lines.length; i++) {
      applyCall(doc, batch, 'splitParagraphInCell', [a.section, a.para, a.control, a.cell, i - 1,
        doc.getCellParagraphLength(a.section, a.para, a.control, a.cell, i - 1)]);
      if (lines[i]) applyOp(doc, batch, 'insertTextInCell', { table: low.table, row: low.row, col: low.col, paragraph: i, offset: 0, text: lines[i] });
    }
    result = { before, after: cellText(doc, a), lineCount: lines.length };
  } else {
    preflightOps(batch, 1 + formatOps);
    result = applyOp(doc, batch, 'setCell', low);
  }
  if (props && filled) result = { ...result, formatted: format(doc, batch, { table: low.table, row: low.row, col: low.col }, props).applied };
  return result;
}
