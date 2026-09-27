import { createHash, randomUUID } from 'node:crypto';
import { tableAddresses, resolveCell, cellText, cellsInTable, nestedCellParagraphs } from './cells.mjs';
import { validateApiCall, canonical, normalizeResult, decodeResult, MAX_BATCH_OPS, MAX_BATCH_BYTES } from './api-registry.mjs';
export const sha = s => createHash('sha256').update(s).digest('hex');
const plain = s => typeof s === 'string' && !/[\u0000-\u001f\u007f]/u.test(s);
const checked = (s, name) => { if (!plain(s)) throw new Error(`invalid ${name}`); return s; };
const hitText = (doc, h) => doc.getTextRange(h.sec, h.para, h.charOffset, h.length);
const paraText = (doc, section, para) => doc.getTextRange(section, para, 0, doc.getParagraphLength(section, para));
const OP_KINDS = ['setCell', 'insertTextInCell', 'replaceText', 'setCheckbox', 'insertText', 'call'];
const HEX64 = /^[a-f0-9]{64}$/;
export function newBatch(base) { return { schemaVersion: 1, commandId: randomUUID(), base, ops: [] }; }
export function validateBatch(batch) {
  if (batch.schemaVersion !== 1 || !batch.commandId || !Array.isArray(batch.ops)) throw new Error('invalid op batch');
  if (batch.ops.length > MAX_BATCH_OPS) throw new Error('BATCH_TOO_LARGE');
  for (const op of batch.ops) {
    if (!OP_KINDS.includes(op.kind) ||
        !op.logical || !op.resolved || !HEX64.test(op.beforeSha256) || !op.args)
      throw new Error('invalid op');
    if (op.kind === 'call' && !HEX64.test(op.resultSha256)) throw new Error('invalid op');
  }
  return batch;
}
// 한 저장의 op 수·보낼 크기 한도. 모든 op 종류가 문서를 바꾸기 전에 부른다. ops 하나 또는 여러 개(replaceText의
// 일치 항목 전부)를 한 번에 잰다. 크기는 JSON.stringify(op)의 UTF-8 바이트(SSE data에 그대로 들어가는 모양)다.
export function reserveBatch(batch, ops) {
  const list = Array.isArray(ops) ? ops : [ops];
  const bytes = list.reduce((n, op) => n + Buffer.byteLength(JSON.stringify(op)), 0);
  if (batch.ops.length + list.length > MAX_BATCH_OPS || (batch.bytes ?? 0) + bytes > MAX_BATCH_BYTES)
    throw Object.assign(new Error(`BATCH_TOO_LARGE: max ${MAX_BATCH_OPS} edits / ${MAX_BATCH_BYTES} bytes per save; save and continue in another hwp_exec call`),
      { code: 'BATCH_TOO_LARGE' });
  batch.bytes = (batch.bytes ?? 0) + bytes;
}
export function applyOp(doc, batch, kind, args) {
  if (kind === 'insertText') {
    // 본문(표 밖) 문단 하나에 글을 끼운다. offset을 빼면 문단 끝이다. 좌표는 hwp.paragraphs()가 준다.
    const { section = 0, paragraph } = args;
    const text = checked(args.text, 'text');
    if (!text) throw new Error('empty text');
    if (!Number.isInteger(section) || section < 0 || section >= doc.getSectionCount() ||
        !Number.isInteger(paragraph) || paragraph < 0 || paragraph >= doc.getParagraphCount(section))
      throw new Error('paragraph out of bounds');
    const length = doc.getParagraphLength(section, paragraph);
    const offset = args.offset ?? length;
    if (!Number.isInteger(offset) || offset < 0 || offset > length) throw new Error('paragraph offset out of bounds');
    const before = paraText(doc, section, paragraph);
    const op = { kind, logical: { section, paragraph },
      resolved: { section, para: paragraph, control: null, cell: null, offset, length: 0 },
      beforeSha256: sha(before), args: { section, paragraph, offset, text } };
    reserveBatch(batch, op);
    const result = JSON.parse(doc.insertText(section, paragraph, offset, text));
    if (result?.ok === false) throw new Error('insert failed');
    batch.ops.push(op);
    return { before, after: paraText(doc, section, paragraph) };
  }
  if (kind === 'setCell' || kind === 'insertTextInCell') {
    const { table, row, col } = args;
    const a = resolveCell(doc, table, row, col);
    const before = cellText(doc, a);
    const text = checked(args.text, 'text');
    if (kind === 'insertTextInCell') {
      const { paragraph, offset } = args;
      if (!Number.isInteger(paragraph) || paragraph < 0 || !Number.isInteger(offset) || offset < 0 ||
          paragraph >= doc.getCellParagraphCount(a.section, a.para, a.control, a.cell) ||
          offset > doc.getCellParagraphLength(a.section, a.para, a.control, a.cell, paragraph))
        throw new Error('cell insertion out of bounds');
    }
    const op = { kind, logical: { table, row, col },
      resolved: { section: a.section, para: a.para, control: a.control, cell: a.cell },
      beforeSha256: sha(before), args: { ...args } };
    reserveBatch(batch, op);
    if (kind === 'setCell') {
      const count = doc.getCellParagraphCount(a.section, a.para, a.control, a.cell);
      for (let p = 0; p < count; p++) {
        const len = doc.getCellParagraphLength(a.section, a.para, a.control, a.cell, p);
        if (len) doc.deleteTextInCell(a.section, a.para, a.control, a.cell, p, 0, len);
      }
      if (text) doc.insertTextInCell(a.section, a.para, a.control, a.cell, 0, 0, text);
    } else doc.insertTextInCell(a.section, a.para, a.control, a.cell, args.paragraph, args.offset, text);
    batch.ops.push(op);
    return { before, after: cellText(doc, a) };
  }
  if (kind === 'replaceText') {
    const find = checked(args.find, 'find'), replace = checked(args.replace, 'replace');
    if (!find) throw new Error('empty find');
    const hits = JSON.parse(doc.searchAllText(find, true, false));
    if (!hits.length || (args.expectedCount !== undefined && hits.length !== args.expectedCount))
      throw new Error(`replace count mismatch: ${hits.length}`);
    // 뒤에서부터 바꾼다(앞 치환이 뒤 오프셋을 밀지 않게). op는 모두 먼저 만들어 한 번에 잰다.
    const ordered = hits.reverse();
    const ops = ordered.map(h => ({ kind, logical: { find, occurrence: hits.length },
      resolved: { section: h.sec, para: h.para, control: null, cell: null, offset: h.charOffset, length: h.length },
      beforeSha256: sha(hitText(doc, h)), args: { find, replace } }));
    reserveBatch(batch, ops);
    ordered.forEach((h, i) => { doc.replaceText(h.sec, h.para, h.charOffset, h.length, replace); batch.ops.push(ops[i]); });
    return { count: hits.length };
  }
  if (kind === 'setCheckbox') {
    const hits = JSON.parse(doc.searchAllText('□', true, true));
    if (!Number.isInteger(args.occurrence) || args.occurrence < 0 || args.occurrence >= hits.length)
      throw new Error('checkbox occurrence absent');
    const h = hits[args.occurrence];
    if (h.cellPath || h.equationControl !== undefined) throw new Error('unsupported checkbox context');
    const op = { kind, logical: { occurrence: args.occurrence },
      resolved: { section: h.sec, para: h.para, parentPara: h.cellContext?.parentPara ?? null,
        control: h.cellContext?.ctrlIdx ?? null,
        cell: h.cellContext?.cellIdx ?? null, cellPara: h.cellContext?.cellPara ?? null, offset: h.charOffset, length: 1 },
      beforeSha256: sha('□'), args: { occurrence: args.occurrence } };
    reserveBatch(batch, op);
    if (h.cellContext) {
      const c = h.cellContext;
      doc.deleteTextInCell(h.sec, c.parentPara, c.ctrlIdx, c.cellIdx, c.cellPara, h.charOffset, 1);
      doc.insertTextInCell(h.sec, c.parentPara, c.ctrlIdx, c.cellIdx, c.cellPara, h.charOffset, '☑');
    } else doc.replaceText(h.sec, h.para, h.charOffset, 1, '☑');
    batch.ops.push(op);
    return { occurrence: args.occurrence };
  }
  throw new Error(`unknown operation: ${kind}`);
}
// 칸·표 메서드의 (구역, 문단, 컨트롤)은 최상위 표여야 하고, ByPath 경로는 최상위 칸(한 칸) 또는 nestedCellParagraphs가
// 돌려준 중첩 칸이어야 한다. rhwp 경로 해석기는 글상자·캡션까지 들어가는데(text_editing.rs:5687-5724) 서명은 그곳 서식을
// 보지 않으므로 거절한다(API_TARGET_UNSIGNED).
const CELL_TRIPLE = new Set(['applyCharFormatInCell', 'applyParaFormatInCell', 'applyCellStyle', 'insertTextInCell', 'deleteTextInCell',
  'deleteRangeInCell', 'splitParagraphInCell', 'mergeParagraphInCell', 'insertTableRow', 'insertTableColumn', 'deleteTableRow',
  'deleteTableColumn', 'mergeTableCells', 'splitTableCell', 'setTableProperties']);
function guardTarget(doc, method, args) {
  const unsigned = why => Object.assign(new Error(`API_TARGET_UNSIGNED: ${method} ${why}`), { code: 'API_TARGET_UNSIGNED' });
  if (CELL_TRIPLE.has(method)) {
    const [section, para, control] = args;
    if (!tableAddresses(doc).some(t => t.section === section && t.para === para && t.control === control)) throw unsigned('needs a top-level table');
  }
  if (method === 'applyCharFormatInCellByPath') {
    const [section, para, pathJson] = args, path = JSON.parse(pathJson);
    const top = path.length === 1 && tableAddresses(doc).some(t => t.section === section && t.para === para && t.control === path[0].controlIndex);
    const nested = path.length === 2 && nestedCellParagraphs(doc).cells
      .some(n => n.section === section && n.para === para && JSON.stringify(n.path) === pathJson);
    if (!top && !nested) throw unsigned('path must be a top-level or one-level nested table cell');
  }
}
// 허용된 변경 메서드 한 번. 반환값을 정규화해 해시로 남기고, 탭은 같은 반환값을 받아야 한다(RESULT_MISMATCH).
// beforeSha256은 이 op의 메서드·인자 요약이다(무결성 확인용; 문서 전후 상태는 서명 v2가 서버에서 본다).
export function applyCall(doc, batch, method, rawArgs) {
  const { entry, args } = validateApiCall(method, rawArgs);
  if (entry.mode !== 'mutate') throw Object.assign(new Error(`API_METHOD_DENIED: ${method} is read-only; call it without recording`), { code: 'API_METHOD_DENIED' });
  guardTarget(doc, method, args); // 서명 v2가 보는 곳만 바꾼다
  const op = { kind: 'call', logical: { method }, resolved: { method, args },
    beforeSha256: sha(canonical({ method, args })), resultSha256: '0'.repeat(64), args: { method, args } };
  reserveBatch(batch, op); // 보낼 op 모양 그대로 잰다(결과 해시 자리 포함). 넘으면 문서를 바꾸기 전에 멈춘다
  const raw = doc[method](...args);
  op.resultSha256 = sha(normalizeResult(raw));
  batch.ops.push(op);
  return decodeResult(raw);
}
export function readApi(doc, method, rawArgs) {
  const { entry, args } = validateApiCall(method, rawArgs);
  if (entry.mode !== 'read') throw Object.assign(new Error(`API_METHOD_DENIED: ${method} mutates; it is recorded only through hwp.api`), { code: 'API_METHOD_DENIED' });
  return decodeResult(doc[method](...args));
}
export function readView(doc, method, args = {}) {
  if (method === 'info') return JSON.parse(doc.getDocumentInfo());
  if (method === 'paragraphs') {
    // 본문 문단 목록. 표 안 글은 cells()로 본다. 빈 문단도 좌표를 알려 주려고 그대로 싣는다.
    const section = args.section ?? 0, from = args.from ?? 0, count = Math.min(args.count ?? 200, 500);
    if (!Number.isInteger(section) || section < 0 || section >= doc.getSectionCount()) throw new Error('section out of bounds');
    const total = doc.getParagraphCount(section), out = [];
    for (let p = Math.max(0, from); p < Math.min(total, from + count); p++)
      out.push({ section, paragraph: p, text: paraText(doc, section, p) });
    return { total, paragraphs: out };
  }
  if (method === 'text') return args.page === undefined
    ? Array.from({ length: doc.pageCount() }, (_, i) => doc.getPageText(i)) : doc.getPageText(args.page);
  if (method === 'tables') return tableAddresses(doc).map((a, table) => ({ table, rows: a.rowCount, cols: a.colCount }));
  if (method === 'cells') return cellsInTable(doc, args.table);
  if (method === 'find') return JSON.parse(doc.searchAllText(args.query, args.caseSensitive ?? true, args.includeCells ?? false));
  throw new Error(`unknown read: ${method}`);
}
