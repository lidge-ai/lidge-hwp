// hwp.api 허용 목록. 여기 없는 HwpDocument 메서드는 부를 수 없다(API_METHOD_DENIED).
// mutate는 op로 기록돼 탭에서 재생된다. 탭 목록(rhwp/rhwp-studio/src/lidge/api-registry.ts)과 같아야 한다(test/api.test.mjs).
// 인자 타입: i=0 이상 정수, b=불리언, s=한 줄 글(제어 문자 없음), j=객체(JSON.stringify해서 넘김),
// p=칸 경로 배열 [{controlIndex,cellIndex,cellParaIndex},…](JSON.stringify해서 넘김).
export const API_VERSION = 1;
// 한 번 저장(hwp.save)에 담는 op 한도. 탭 agent-ops.ts assertBatch와 같은 값. 크기 한도는 SSE 한 번 쓰기를 작게 두려는 값이다.
export const MAX_BATCH_OPS = 4096, MAX_BATCH_BYTES = 8 * 1024 * 1024;
const R = (mode, sig) => ({ mode, sig: [...sig] });
export const REGISTRY = Object.freeze({
  // 읽기
  getDocumentInfo: R('read', ''), pageCount: R('read', ''), getPageText: R('read', 'i'),
  getSectionCount: R('read', ''), getParagraphCount: R('read', 'i'), getParagraphLength: R('read', 'ii'),
  getTextRange: R('read', 'iiii'), getControls: R('read', ''), searchAllText: R('read', 'sbb'),
  getCharShapeRuns: R('read', 'iiii'), getCharPropertiesAt: R('read', 'iii'), getParaPropertiesAt: R('read', 'ii'),
  getCellCharPropertiesAt: R('read', 'iiiiii'), getCellParaPropertiesAt: R('read', 'iiiii'),
  getCellParagraphCount: R('read', 'iiii'), getCellParagraphLength: R('read', 'iiiii'), getTextInCell: R('read', 'iiiiiii'),
  getCellInfo: R('read', 'iiii'), getTableDimensions: R('read', 'iii'), getTableProperties: R('read', 'iii'),
  getStyleList: R('read', ''), getStyleDetail: R('read', 'i'), getStyleAt: R('read', 'ii'), getCellStyleAt: R('read', 'iiiii'),
  getCellParagraphCountByPath: R('read', 'iip'), getCellParagraphLengthByPath: R('read', 'iip'), getTextInCellByPath: R('read', 'iipii'),
  getCellCharPropertiesAtByPath: R('read', 'iipi'), getCharShapeRunsInCellByPath: R('read', 'iipii'), lidgeAuxContent: R('read', ''),
  // 변경: 서식·스타일
  applyCharFormat: R('mutate', 'iiiij'), applyCharFormatInCell: R('mutate', 'iiiiiiij'), applyCharFormatInCellByPath: R('mutate', 'iipiij'),
  applyParaFormat: R('mutate', 'iij'), applyParaFormatInCell: R('mutate', 'iiiiij'),
  applyStyle: R('mutate', 'iii'), applyCellStyle: R('mutate', 'iiiiii'), findOrCreateFontId: R('mutate', 's'),
  // 변경: 글·문단
  insertText: R('mutate', 'iiis'), insertTextInCell: R('mutate', 'iiiiiis'), replaceText: R('mutate', 'iiiis'),
  replaceAll: R('mutate', 'ssb'), deleteText: R('mutate', 'iiii'), deleteTextInCell: R('mutate', 'iiiiiii'),
  deleteRange: R('mutate', 'iiiii'), deleteRangeInCell: R('mutate', 'iiiiiiii'),
  insertParagraph: R('mutate', 'ii'), deleteParagraph: R('mutate', 'ii'), splitParagraph: R('mutate', 'iii'),
  mergeParagraph: R('mutate', 'ii'), splitParagraphInCell: R('mutate', 'iiiiii'), mergeParagraphInCell: R('mutate', 'iiiii'),
  // 변경: 표
  createTable: R('mutate', 'iiiii'), insertTableRow: R('mutate', 'iiiib'), insertTableColumn: R('mutate', 'iiiib'),
  deleteTableRow: R('mutate', 'iiii'), deleteTableColumn: R('mutate', 'iiii'), mergeTableCells: R('mutate', 'iiiiiii'),
  splitTableCell: R('mutate', 'iiiii'), setTableProperties: R('mutate', 'iiij'),
});
const coded = (code, message = code) => Object.assign(new Error(`${code}: ${message}`), { code });
const PLAIN = /^[^\u0000-\u001f\u007f]*$/u;
// 객체 인자(j)의 키별 값 규칙. rhwp 파서는 모르는 키·타입이 틀린 값을 조용히 무시하고, 모르는 정렬 문자열은
// justify로 바꾼다(rhwp/src/document_core/helpers.rs:332-336, 529-539, 710-721). 그래서 키와 값을 여기서 다 확인한다.
const bool = v => typeof v === 'boolean';
const int = (lo, hi) => v => Number.isSafeInteger(v) && v >= lo && v <= hi;
const color = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const oneOf = (...xs) => v => xs.includes(v);
export const CHAR_RULES = Object.freeze({ bold: bool, italic: bool, underline: bool, strikethrough: bool, subscript: bool,
  superscript: bool, emboss: bool, engrave: bool, kerning: bool, fontSize: int(100, 409600), fontId: int(0, 65535),
  textColor: color, shadeColor: color, underlineColor: color, strikeColor: color, underlineType: oneOf('Bottom', 'Top', 'None'),
  outlineType: int(0, 6), shadowType: int(0, 2), emphasisDot: int(0, 12) });
// 문단 수치는 rhwp가 json_i32로 읽어 소수점에서 끊는다(helpers.rs:541-565, 724-733) → 정수만 받는다(단위: HWP 내부 값).
export const PARA_RULES = Object.freeze({ alignment: oneOf('left', 'right', 'center', 'justify', 'distribute', 'split'),
  lineSpacing: int(0, 100000), lineSpacingType: oneOf('Percent', 'Fixed', 'SpaceOnly', 'Minimum'),
  indent: int(-1000000, 1000000), marginLeft: int(0, 1000000), marginRight: int(0, 1000000),
  spacingBefore: int(0, 1000000), spacingAfter: int(0, 1000000),
  keepWithNext: bool, keepLines: bool, pageBreakBefore: bool, widowOrphan: bool });
// 표 간격·안쪽 여백은 i16로 읽는다(table_ops.rs:2794-2809, helpers.rs:805-807) → 0..32767.
export const TABLE_RULES = Object.freeze({ cellSpacing: int(0, 32767), paddingLeft: int(0, 32767), paddingRight: int(0, 32767),
  paddingTop: int(0, 32767), paddingBottom: int(0, 32767), pageBreak: int(0, 2), repeatHeader: bool });
const PROP_RULES = { applyCharFormat: CHAR_RULES, applyCharFormatInCell: CHAR_RULES, applyCharFormatInCellByPath: CHAR_RULES,
  applyParaFormat: PARA_RULES, applyParaFormatInCell: PARA_RULES, setTableProperties: TABLE_RULES };
export function checkProps(method, v) {
  const rules = PROP_RULES[method];
  if (!rules) return;
  const keys = Object.keys(v);
  const badKeys = keys.filter(k => !Object.hasOwn(rules, k) || !rules[k](v[k]));
  if (!keys.length || badKeys.length) throw coded('API_ARGS_INVALID', `${method} props: empty or invalid (${badKeys.map(k => `${k}=${JSON.stringify(v[k])}`).join(', ')})`);
}
export function validateApiCall(method, args) {
  const entry = Object.hasOwn(REGISTRY, method) ? REGISTRY[method] : null;
  if (!entry) throw coded('API_METHOD_DENIED', String(method));
  if (!Array.isArray(args) || args.length !== entry.sig.length) throw coded('API_ARGS_INVALID', `${method} needs ${entry.sig.length} args`);
  const out = args.map((v, i) => {
    const t = entry.sig[i];
    if (t === 'i' && Number.isSafeInteger(v) && v >= 0) return v;
    if (t === 'b' && typeof v === 'boolean') return v;
    if (t === 's' && typeof v === 'string' && v.length <= 10000 && PLAIN.test(v)) return v;
    if (t === 'j' && v && typeof v === 'object' && !Array.isArray(v)) {
      checkProps(method, v);
      const s = JSON.stringify(v); if (s.length <= 20000) return s;
    }
    if (t === 'p' && Array.isArray(v) && v.length >= 1 && v.length <= 4 &&
        v.every(e => e && ['controlIndex', 'cellIndex', 'cellParaIndex'].every(k => Number.isSafeInteger(e[k]) && e[k] >= 0) && Object.keys(e).length === 3))
      return JSON.stringify(v.map(e => ({ controlIndex: e.controlIndex, cellIndex: e.cellIndex, cellParaIndex: e.cellParaIndex })));
    throw coded('API_ARGS_INVALID', `${method} arg ${i} must be ${({ i: 'int>=0', b: 'boolean', s: 'one-line string', j: 'object', p: 'cell path array' })[t]}`);
  });
  return { entry, args: out };
}
// 키를 정렬한 JSON. Node와 탭이 같은 함수를 쓴다(api-registry.ts의 canonical과 같은 결과여야 한다).
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
// WASM 반환값(대개 JSON 문자열)을 비교용 문자열로.
export function normalizeResult(raw) {
  if (typeof raw === 'string') { try { return canonical(JSON.parse(raw)); } catch { return canonical(raw); } }
  return canonical(raw);
}
export function decodeResult(raw) {
  if (typeof raw !== 'string') return raw ?? null;
  try { return JSON.parse(raw); } catch { return raw; }
}
export function apiHelp(extra = {}) {
  const list = mode => Object.entries(REGISTRY).filter(([, e]) => e.mode === mode).map(([name, e]) => `${name}(${e.sig.join('')})`);
  return { version: API_VERSION, argTypes: { i: 'int>=0', b: 'boolean', s: 'one-line string', j: 'object', p: '[{controlIndex,cellIndex,cellParaIndex},...]' },
    call: "await hwp.api(h, 'method', ...args)", read: list('read'), mutate: list('mutate'), ...extra };
}
// hwp.help()에 싣는 도우미 설명(040). 도우미 이름은 server/agent/worker.mjs names와 같다.
export const HELPERS = {
  helpers: [
    'docs()', 'open(docId) -> h', 'save(h)', 'help()', 'selectAll() -> {all:true}',
    'info(h)', 'text(h,{page?})', 'paragraphs(h,{section?,from?,count?})', 'tables(h)', 'cells(h,{table})', 'find(h,{query,includeCells?})',
    'getFormat(h,{section?,paragraph,offset?}|{table,row,col,paragraph?,offset?})', 'styles(h)',
    'setCell(h,{table,row,col,text})', 'insertTextInCell(h,{table,row,col,paragraph,offset,text})', 'insertText(h,{section?,paragraph,offset?,text})',
    'replaceText(h,{find,replace,expectedCount?}) body only', 'replaceAll(h,{find,replace,caseSensitive?}) incl. cells', 'setCheckbox(h,{occurrence})',
    'format(h,scope,charProps)', 'paraFormat(h,scope,paraProps)', 'applyStyle(h,scope,styleIdOrName)',
    'insertParagraph(h,{section?,paragraph})', 'deleteParagraph(h,{section?,paragraph})', 'splitParagraph(h,{section?,paragraph,offset})', 'mergeParagraph(h,{section?,paragraph}) joins into previous',
    'deleteText(h,{section?,paragraph,offset,count}|{table,row,col,paragraph?,offset,count})', 'deleteRange(h,{section?,from:{paragraph,offset},to:{paragraph,offset}})',
    'createTable(h,{section?,paragraph,offset?,rows,cols}) -> {table,...}', 'insertRow(h,{table,row,below?})', 'insertColumn(h,{table,col,right?})',
    'deleteRow(h,{table,row})', 'deleteColumn(h,{table,col})', 'mergeCells(h,{table,from:[r,c],to:[r,c]})', 'splitCell(h,{table,row,col})',
    "api(h,'method',...args) allowlisted rhwp HwpDocument call",
  ],
  scopes: ['selectAll()', '{section?,paragraph,start?,end?}', '{section?,from,to}', '{table,row,col}', '{table}'],
  charProps: 'bold italic underline strikethrough subscript superscript (boolean), size (pt number) or fontSize (1/100 pt), textColor shadeColor underlineColor strikeColor (#rrggbb), fontName, underlineType (Bottom|Top|None)',
  paraProps: 'alignment (left|right|center|justify|distribute|split), lineSpacing, lineSpacingType (Percent|Fixed|SpaceOnly|Minimum), indent, marginLeft, marginRight, spacingBefore, spacingAfter (integers), keepWithNext, keepLines, pageBreakBefore, widowOrphan',
  examples: [
    "const h=await hwp.open('a.hwp'); await hwp.format(h, await hwp.selectAll(), {italic:true}); await hwp.save(h);",
    "await hwp.paraFormat(h, {paragraph:3}, {alignment:'center'});",
    "await hwp.insertRow(h, {table:0, row:2}); await hwp.setCell(h, {table:0, row:3, col:0, text:'값'});",
  ],
  notes: ['selectAll() covers body paragraphs, top-level table cells and cells of tables nested one level inside a cell.',
    'One-level nested cells get character formatting only; paraFormat/applyStyle report them in skipped. Deeper nesting, headers, footers and footnotes are outside selectAll().',
    'Coordinates shift after split/insert/delete; re-read with paragraphs() or tables().', 'One save holds at most 4096 edit calls; split larger jobs across hwp_exec calls.'],
};
