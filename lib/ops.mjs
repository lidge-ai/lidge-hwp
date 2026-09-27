import { createHash, randomUUID } from 'node:crypto';
import { tableAddresses, resolveCell, cellText, cellsInTable, nestedCellParagraphs } from './cells.mjs';
import { validateApiCall, canonical, normalizeResult, decodeResult, firstControlChar, MAX_BATCH_OPS, MAX_BATCH_BYTES } from './api-registry.mjs';
export const sha = s => createHash('sha256').update(s).digest('hex');
const nat = n => Number.isSafeInteger(n) && n >= 0;
export const codedError = (code, message, details) => Object.assign(new Error(message), { code }, details === undefined ? {} : { details });
// 글 인자 검증(#28). 거절 규칙은 그대로이고, 오류에 첫 제어 문자와 위치(code point·UTF-16)를 싣는다.
export const textInvalid = (name, bad) => codedError('TEXT_INVALID',
  `invalid ${name}: ${bad.codePoint} at codePointIndex=${bad.codePointIndex}, utf16Index=${bad.utf16Index}`, { arg: name, ...bad });
export function checked(s, name) {
  if (typeof s !== 'string') throw codedError('TEXT_INVALID', `invalid ${name}: string required`, { arg: name });
  const bad = firstControlChar(s);
  if (bad) throw textInvalid(name, bad);
  return s;
}
// splitLines:true 전용(#28). CRLF·LF·CR을 줄 경계로 나누고, 나머지 제어 문자는 원문 위치로 거절한다.
export function splitTextLines(s, name = 'text') {
  if (typeof s !== 'string') return checked(s, name);
  const bad = firstControlChar(s, { allowBreaks: true });
  if (bad) throw textInvalid(name, bad);
  return s.split(/\r\n|\r|\n/);
}
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
  if (batch.ops.length + list.length > MAX_BATCH_OPS || (batch.bytes ?? 0) + bytes > MAX_BATCH_BYTES) throw batchTooLarge();
  batch.bytes = (batch.bytes ?? 0) + bytes;
}
const batchTooLarge = () => Object.assign(new Error(`BATCH_TOO_LARGE: max ${MAX_BATCH_OPS} edits / ${MAX_BATCH_BYTES} bytes per save; save and continue in another hwp_exec call`),
  { code: 'BATCH_TOO_LARGE' });
// 여러 op를 묶어 내는 helper(splitLines·scope 치환)가 문서를 바꾸기 전에 op 수 한도를 미리 본다.
export function preflightOps(batch, count) {
  if (batch.ops.length + count > MAX_BATCH_OPS) throw batchTooLarge();
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
    // #29: scope(본문 문단 하나 또는 최상위 칸 하나)와 occurrence(0-based). 생략하면 기존처럼 본문 전체·모든 일치.
    // 후보 번호는 scopedHits의 정렬 순서(= hwp.find paging 순서)이고 expectedCount는 scope 안 후보 수다.
    const scope = normalizeScope(args.scope);
    const { hits } = scopedHits(doc, { query: find, caseSensitive: true, scope, includeCells: false });
    const { expectedCount, occurrence } = args;
    if ((expectedCount !== undefined && (!nat(expectedCount) || hits.length !== expectedCount)) ||
        (occurrence !== undefined && (!nat(occurrence) || occurrence >= hits.length)) || !hits.length)
      throw mismatch({ find, scope, expectedCount, occurrence, hits });
    const chosen = occurrence === undefined ? hits.map((h, i) => ({ h, i })) : [{ h: hits[occurrence], i: occurrence }];
    preflightOps(batch, chosen.length + (replace ? chosen.filter(c => c.h.table !== undefined).length : 0));
    // 본문 op는 모두 먼저 만들어 한 번에 잰다. 칸 치환은 기존 call op 두 개(deleteTextInCell·insertTextInCell)로 남긴다.
    const bodyOps = new Map();
    for (const { h, i } of chosen) if (h.table === undefined) {
      const before = doc.getTextRange(h.section, h.paragraph, h.offset, h.length);
      if (before !== find) throw new Error('replace preimage mismatch');
      bodyOps.set(i, { kind, logical: { find, occurrence: i },
        resolved: { section: h.section, para: h.paragraph, control: null, cell: null, offset: h.offset, length: h.length },
        beforeSha256: sha(before), args: { find, replace } });
    }
    reserveBatch(batch, [...bodyOps.values()]);
    // 뒤에서부터 바꾼다(앞 치환이 뒤 오프셋을 밀지 않게).
    for (const { h, i } of chosen.toReversed()) {
      if (h.table === undefined) { doc.replaceText(h.section, h.paragraph, h.offset, h.length, replace); batch.ops.push(bodyOps.get(i)); continue; }
      const a = resolveCell(doc, h.table, h.row, h.col), at = [a.section, a.para, a.control, a.cell, h.cellParagraph, h.offset];
      if (doc.getTextInCell(...at, h.length) !== find) throw new Error('replace preimage mismatch');
      applyCall(doc, batch, 'deleteTextInCell', [...at, h.length]);
      if (replace) applyCall(doc, batch, 'insertTextInCell', [...at, replace]);
    }
    return { count: chosen.length, matchedCount: hits.length, positions: chosen.slice(0, MAX_POSITIONS).map(c => c.h),
      omitted: Math.max(0, chosen.length - MAX_POSITIONS) };
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
  if (method === 'find') {
    // paging 인자(from·limit·scope)가 없으면 기존 계약 그대로 엔진 hit 배열이다. 있으면 크기 제한 페이지(010 Revision 3·4).
    if (args.from !== undefined || args.limit !== undefined || args.scope !== undefined) return findPage(doc, args);
    return JSON.parse(doc.searchAllText(args.query, args.caseSensitive ?? true, args.includeCells ?? false));
  }
  throw new Error(`unknown read: ${method}`);
}

// ── 찾기 순서·paging·mismatch 좌표 (#29, 010 Revision 2~4) ──
// 결과 JSON은 worker의 64 KiB 한도(server/agent/worker.mjs:38-39) 안에 들어야 한다. 원형 칸 hit는 1000개에 약 116 KB라
// 정규화 위치만 싣고, 페이지는 next까지 포함한 결과 전체를 48 KiB로 자른다.
export const MAX_POSITIONS = 100, MAX_PAGE_LIMIT = 500, MAX_QUERY_CHARS = 1000;
export const MAX_RESULT_BYTES = 48 * 1024, MAX_DETAILS_BYTES = 16 * 1024;
const enc = new TextEncoder();
const jsonBytes = v => enc.encode(JSON.stringify(v)).length;
const U31 = n => Number.isInteger(n) && n >= 0 && n <= 0x7fffffff;
const clip = k => String(k).slice(0, 32);
export function normalizeQuery(q) {
  if (typeof q !== 'string' || !q) throw codedError('INVALID_QUERY', 'INVALID_QUERY: non-empty string required');
  if (!q.isWellFormed()) throw codedError('INVALID_QUERY', 'INVALID_QUERY: unpaired surrogate');
  const length = [...q].length;
  if (length > MAX_QUERY_CHARS)
    throw codedError('INVALID_QUERY', `INVALID_QUERY: ${length} code points > ${MAX_QUERY_CHARS}`, { length, max: MAX_QUERY_CHARS });
  const bad = firstControlChar(q);
  if (bad) throw codedError('INVALID_QUERY', `INVALID_QUERY: ${bad.codePoint} at codePointIndex=${bad.codePointIndex}`, bad);
  return q; // 오류에는 query 원문을 싣지 않는다
}
// scope: null | {section,paragraph} | {table,row,col}. 알려진 키와 0..2^31-1 정수만 받고 새 객체로 돌려준다.
export function normalizeScope(s) {
  if (s === undefined || s === null) return null;
  if (typeof s !== 'object' || Array.isArray(s)) throw codedError('INVALID_SCOPE', 'INVALID_SCOPE: object or null required');
  const cell = Object.hasOwn(s, 'table'), allowed = cell ? ['table', 'row', 'col'] : ['section', 'paragraph'];
  const extra = Object.keys(s).filter(k => !allowed.includes(k));
  if (extra.length) throw codedError('INVALID_SCOPE',
    `INVALID_SCOPE: unknown keys ${extra.slice(0, 5).map(k => JSON.stringify(clip(k))).join(',')}${extra.length > 5 ? ` +${extra.length - 5}` : ''}`,
    { unknownKeys: extra.slice(0, 5).map(clip), unknownCount: extra.length, allowed });
  if (cell) {
    const key = allowed.find(k => !U31(s[k]));
    if (key) throw codedError('INVALID_SCOPE', `INVALID_SCOPE: ${key} must be integer 0..2^31-1`, { key });
    return { table: s.table, row: s.row, col: s.col };
  }
  if (!U31(s.paragraph)) throw codedError('INVALID_SCOPE', 'INVALID_SCOPE: paragraph must be integer 0..2^31-1', { key: 'paragraph' });
  if (s.section !== undefined && !U31(s.section)) throw codedError('INVALID_SCOPE', 'INVALID_SCOPE: section must be integer 0..2^31-1', { key: 'section' });
  return { section: s.section ?? 0, paragraph: s.paragraph };
}
const FIND_KEYS = ['query', 'caseSensitive', 'includeCells', 'scope', 'from', 'limit'];
export function normalizeFindArgs(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw codedError('API_ARGS_INVALID', 'API_ARGS_INVALID: find args object');
  const extra = Object.keys(a).filter(k => !FIND_KEYS.includes(k));
  if (extra.length) throw codedError('API_ARGS_INVALID', `API_ARGS_INVALID: unknown find keys ${extra.slice(0, 5).map(k => JSON.stringify(clip(k))).join(',')}`);
  const bool = (v, d, k) => {
    if (v === undefined) return d;
    if (typeof v !== 'boolean') throw codedError('API_ARGS_INVALID', `API_ARGS_INVALID: ${k} must be boolean`);
    return v;
  };
  const scope = normalizeScope(a.scope), from = a.from ?? 0, limit = a.limit ?? MAX_POSITIONS;
  if (!U31(from) || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT)
    throw codedError('API_ARGS_INVALID', `API_ARGS_INVALID: find from/limit (limit 1..${MAX_PAGE_LIMIT})`);
  return { query: normalizeQuery(a.query), caseSensitive: bool(a.caseSensitive, true, 'caseSensitive'),
    includeCells: scope ? false : bool(a.includeCells, false, 'includeCells'), scope, from, limit };
}
// 최상위 표 칸 주소 → {table,row,col}. 여기 없는 칸 hit(중첩 표·글상자 등)는 excluded로 센다.
function cellGrid(doc) {
  const grid = new Map();
  tableAddresses(doc).forEach((a, table) => {
    for (let cell = 0; cell < a.cellCount; cell++) {
      const info = JSON.parse(doc.getCellInfo(a.section, a.para, a.control, cell));
      grid.set(`${a.section}:${a.para}:${a.control}:${cell}`, { table, row: info.row, col: info.col });
    }
  });
  return grid;
}
function scopeTarget(doc, scope) {
  if (!scope) return null;
  if (scope.table !== undefined) {
    try { return resolveCell(doc, scope.table, scope.row, scope.col); }
    catch (e) { throw codedError('INVALID_SCOPE', `INVALID_SCOPE: ${e.message}`); }
  }
  if (scope.section >= doc.getSectionCount() || scope.paragraph >= doc.getParagraphCount(scope.section))
    throw codedError('INVALID_SCOPE', `INVALID_SCOPE: paragraph ${scope.paragraph} of section ${scope.section} absent`);
  return null;
}
// 하나의 "scoped 순서". query·caseSensitive·scope(또는 includeCells)가 같으면 같은 배열·같은 순서다.
// 인자는 호출부가 검증·정규화한 값이다(scope는 normalizeScope 결과). 정렬 키: 구역, 문단(칸이면 표가 앉은 문단),
// 본문(0)/칸(1), 표, 행, 열, 칸 문단, 오프셋.
export function scopedHits(doc, { query, caseSensitive = true, scope = null, includeCells = false }) {
  const cellScope = scope !== null && scope.table !== undefined;
  const target = scopeTarget(doc, scope);
  const wantCells = cellScope || (scope === null && includeCells);
  const grid = wantCells ? cellGrid(doc) : null;
  let excluded = 0; const keyed = [];
  for (const h of JSON.parse(doc.searchAllText(query, caseSensitive, wantCells))) {
    if (h.cellContext) {
      const c = h.cellContext, g = h.cellPath ? null : grid?.get(`${h.sec}:${c.parentPara}:${c.ctrlIdx}:${c.cellIdx}`);
      if (!g) { excluded++; continue; }
      if (target && !(h.sec === target.section && c.parentPara === target.para && c.ctrlIdx === target.control && c.cellIdx === target.cell)) continue;
      keyed.push([[h.sec, c.parentPara, 1, g.table, g.row, g.col, c.cellPara, h.charOffset],
        { table: g.table, row: g.row, col: g.col, cellParagraph: c.cellPara, offset: h.charOffset, length: h.length }]);
    } else {
      if (cellScope) continue;
      if (scope && (scope.section !== h.sec || scope.paragraph !== h.para)) continue;
      keyed.push([[h.sec, h.para, 0, 0, 0, 0, 0, h.charOffset], { section: h.sec, paragraph: h.para, offset: h.charOffset, length: h.length }]);
    }
  }
  keyed.sort(([a], [b]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
  return { hits: keyed.map(([, p]) => p), excluded };
}
// 위치별 직렬화 크기로 빠르게 고른다(1차 근사). 최소 1개.
export function takeWithinBytes(items, from, limit, maxBytes = MAX_RESULT_BYTES) {
  const page = []; let bytes = 2;
  for (let i = from; i < items.length && page.length < limit; i++) {
    const n = jsonBytes(items[i]) + 1;
    if (page.length && bytes + n > maxBytes) break;
    page.push(items[i]); bytes += n;
  }
  return page;
}
// 예산은 결과 전체(next 포함)의 JSON 바이트다. 넘으면 위치를 뒤에서 버리고 next.from을 당긴다.
export function fitWholeResult(all, a, excluded, maxBytes = MAX_RESULT_BYTES) {
  const build = ps => {
    const end = a.from + ps.length;
    return { total: all.length, from: a.from, count: ps.length, positions: ps, excluded,
      next: end < all.length ? { query: a.query, caseSensitive: a.caseSensitive, scope: a.scope,
        includeCells: a.includeCells, from: end, limit: a.limit } : null };
  };
  const envelope = jsonBytes(build([])) + 64;
  let ps = takeWithinBytes(all, a.from, a.limit, Math.max(0, maxBytes - envelope));
  let result = build(ps);
  while (jsonBytes(result) > maxBytes && ps.length > 0) { ps = ps.slice(0, -1); result = build(ps); }
  if (jsonBytes(result) > maxBytes || (ps.length === 0 && a.from < all.length))
    throw codedError('FIND_PAGE_TOO_LARGE', 'FIND_PAGE_TOO_LARGE: envelope exceeds budget');
  return result;
}
export function findPage(doc, raw, { maxBytes = MAX_RESULT_BYTES } = {}) {
  const a = normalizeFindArgs(raw);
  const { hits, excluded } = scopedHits(doc, a);
  return fitWholeResult(hits, a, excluded, maxBytes);
}
// replaceText 후보 수가 기대와 다를 때. details는 MCP 결과까지 간다(server/agent/wire-error.mjs).
function mismatch({ find, scope, expectedCount, occurrence, hits }) {
  let findable = true;
  try { normalizeQuery(find); } catch { findable = false; } // 긴 find는 계속 허용하되 find paging 안내는 줄 수 없다
  const build = ps => {
    const omitted = hits.length - ps.length, d = {};
    if (expectedCount !== undefined) d.expectedCount = expectedCount;
    if (occurrence !== undefined) d.occurrence = occurrence;
    Object.assign(d, { actualCount: hits.length, positions: ps, omitted,
      next: findable && omitted ? { method: 'find', args: { query: find, caseSensitive: true, scope: scope ?? null, from: ps.length, limit: MAX_POSITIONS } } : null });
    if (!findable) d.nextUnavailable = 'QUERY_TOO_LONG_FOR_FIND';
    return d;
  };
  let positions = hits.slice(0, MAX_POSITIONS), details = build(positions);
  while (jsonBytes(details) > MAX_DETAILS_BYTES && positions.length) { positions = positions.slice(0, -1); details = build(positions); }
  const head = positions.slice(0, 10).map(p => JSON.stringify(p)).join(',');
  const want = `expected ${expectedCount ?? '>=1'}${occurrence !== undefined ? `, occurrence ${occurrence}` : ''}`;
  return codedError('REPLACE_COUNT_MISMATCH', `replace count mismatch: ${hits.length} (${want}) positions=[${head}]${hits.length > 10 ? ` +${hits.length - 10} more in details` : ''}`.slice(0, 2000), details);
}
