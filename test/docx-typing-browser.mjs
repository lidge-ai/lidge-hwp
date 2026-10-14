// DOCX 입력 지연 회귀(수동 실행: node test/docx-typing-browser.mjs). build/office에 들어간 docx-editor 조각 재사용
// 빌드 패치(scripts/docx-paint-reuse.mjs)를 실제 Chrome 키 입력으로 본다: 키당 새 DOM 노드 수, 입력·한 글자 치환·표 셀 반영,
// 저장 뒤 다시 열기. 키→그리기 p50/p90을 찍는다. 산출물: DOCX_TYPING_QA_DIR(기본 /tmp/jongi-docx-typing-qa)에 스크린샷.
// 전후 비교용: DOCX_TYPING_BUNDLE_DIR=<폴더>를 주면 /office/*.js를 그 폴더의 번들로 바꿔 연다(기본은 build/office).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { blankDocx } from '../lib/office/blank.mjs';
import { appendParagraph, documentText } from '../lib/office/docx-text.mjs';
import { readZip, writeZip, text, bytesOf } from '../lib/office/zip.mjs';
import { withBrowser, until, expect as assert } from './browser-shell-helper.mjs';

const git = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const OUT = process.env.DOCX_TYPING_QA_DIR || '/tmp/jongi-docx-typing-qa';
const BUNDLE = process.env.DOCX_TYPING_BUNDLE_DIR || null;
await mkdir(OUT, { recursive: true });

const LINE = '가나다라마바사 아자차카타파하 문서 편집 지연을 재는 긴 문단입니다. The quick brown fox jumps over the lazy dog. 숫자 1234567890.';
function longDocx(count) {
  let bytes = blankDocx();
  for (let i = 0; i < count; i++) bytes = appendParagraph(bytes, (i + 1) + '. ' + LINE);
  return bytes;
}
// 제목 스타일·글머리표 목록·3x3 표·본문 문단이 섞인 문서. 빈 문서에 부품을 더해 만든다(바이너리 픽스처 없음).
function richDocx() {
  const files = readZip(blankDocx());
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  files.set('[Content_Types].xml', bytesOf(text(files.get('[Content_Types].xml')).replace('</Types>',
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>')));
  files.set('word/_rels/document.xml.rels', bytesOf(text(files.get('word/_rels/document.xml.rels')).replace('</Relationships>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>')));
  files.set('word/styles.xml', bytesOf(text(files.get('word/styles.xml')).replace('</w:styles>',
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>')));
  files.set('word/numbering.xml', bytesOf('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="' + W + '">'
    + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'));
  const para = (value, pPr = '') => '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + '<w:r><w:t xml:space="preserve">' + value + '</w:t></w:r></w:p>';
  const cell = value => '<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>' + para(value) + '</w:tc>';
  const border = side => '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="000000"/>';
  const table = '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('') + '</w:tblBorders></w:tblPr>'
    + '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>'
    + [1, 2, 3].map(r => '<w:tr>' + [1, 2, 3].map(c => cell('R' + r + 'C' + c)).join('') + '</w:tr>').join('') + '</w:tbl>';
  let body = para('회의 제목', '<w:pStyle w:val="Heading1"/>');
  for (const item of ['항목 하나', '항목 둘', '항목 셋']) body += para(item, '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
  body += table;
  for (let i = 0; i < 40; i++) body += para('본문 ' + (i + 1) + ' ' + LINE);
  const xml = text(files.get('word/document.xml')).replace('<w:body><w:p/>', '<w:body>' + body);
  files.set('word/document.xml', bytesOf(xml));
  return writeZip(files);
}
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.at(-1) };
};
const fmt = s => 'p50=' + s.p50.toFixed(1) + ' p90=' + s.p90.toFixed(1) + ' max=' + s.max.toFixed(1) + ' (n=' + s.n + ')';

const intercept = BUNDLE ? async ({ cdp }) => {
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/office/*.js*' }] });
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const name = new URL(request.url).pathname.replace('/office/', '');
    try {
      const body = await readFile(join(BUNDLE, name));
      await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], body: body.toString('base64') });
    } catch { await cdp.send('Fetch.continueRequest', { requestId }); }
  });
} : null;

await withBrowser({ files: [], intercept }, async ({ cdp, docs }) => {
  const page = source => cdp.eval(source); // justified: CDP Runtime.evaluate inside the headless test browser, not dynamic code in this process
  cdp.on('Page.javascriptDialogOpening', () => { void cdp.send('Page.handleJavaScriptDialog', { accept: true }); });
  await writeFile(join(docs, '긴 문서.docx'), longDocx(600));
  await writeFile(join(docs, '표 문서.docx'), richDocx());
  await git('git', ['-C', docs, 'add', '.']);
  await git('git', ['-C', docs, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'docx typing seed']);
  await page("document.querySelector('#docs-refresh').click();");
  await until(() => page("return !!document.querySelector('.doc[data-id=\"표 문서.docx\"]');"));
  if (BUNDLE) console.log('bundle override: ' + BUNDLE);

  const open = async id => {
    await page('document.querySelector(' + JSON.stringify('.doc[data-id="' + id + '"]') + ').click();');
    await until(() => page("return document.body.dataset.shellState === 'open' && document.querySelector('#filename').title === " + JSON.stringify(id) + " && !!document.querySelector('#office-host .docx-pages .layout-run-text');"), 60000);
    await sleep(1500);
  };
  const key = async (name, { code = name, vk, text: typed, modifiers = 0 } = {}) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, modifiers, ...(typed ? { text: typed, unmodifiedText: typed } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const typeChar = ch => key(ch, { code: /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /\d/.test(ch) ? 'Digit' + ch : '', vk: ch.toUpperCase().charCodeAt(0), text: ch });
  const end = () => key('End', { vk: 35 });
  // 그려진 글자 한 조각(layout-run-text)을 눌러 캐럿을 두고 줄 끝으로 간다.
  const placeCaret = async match => {
    const spot = await page('const want = ' + JSON.stringify(match) + '; const run = [...document.querySelectorAll("#office-host .docx-pages .layout-run-text")].find(n => want === null || n.textContent.includes(want)); if (!run) return null; run.scrollIntoView({ block: "center" }); const r = run.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };');
    assert.ok(spot, 'run not found: ' + match);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
    await sleep(300);
    await end();
    await sleep(300);
  };
  // 키마다: keydown 시각 → 편집면 첫 DOM 변경 → 다음 프레임 뒤 태스크(그리기) 시간과, 그 키로 새로 붙은 요소 수.
  const probe = () => page(`
    const surface = document.querySelector('#office-host .docx-pages');
    window.__typing?.observer.disconnect();
    const state = window.__typing = { keys: [], pending: null, observer: null };
    window.__typingKeydown ??= window.addEventListener('keydown', event => { if (window.__typing) window.__typing.pending = { t: event.timeStamp, added: 0 }; }, true) || true;
    state.observer = new MutationObserver(records => {
      const p = state.pending; if (!p) return;
      for (const record of records) for (const node of record.addedNodes) p.added += 1 + (node.querySelectorAll ? node.querySelectorAll('*').length : 0);
      if (p.mut !== undefined) return;
      p.mut = performance.now() - p.t;
      requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = () => { p.paint = performance.now() - p.t; state.keys.push(p); }; channel.port2.postMessage(0); });
    });
    state.observer.observe(surface, { subtree: true, childList: true, characterData: true });
    return true;`);
  const collect = async () => { await sleep(800); return page('const k = window.__typing.keys; window.__typing.keys = []; return k.map(({ mut, paint, added }) => ({ mut, paint, added }));'); };
  const pageText = () => page("return [...document.querySelectorAll('#office-host .docx-pages .layout-run-text')].map(n => n.textContent).join('');");
  const save = async () => {
    await page("document.querySelector('#save').click();");
    await until(() => page("const s = document.querySelector('#status').textContent; return s === '저장됨' || s.startsWith('저장 실패') || s === '저장 취소';"), 30000);
    return page("return document.querySelector('#status').textContent;");
  };

  // (a)(e) 600문단: 실제 키 20번. 키당 새 노드와 키→그리기 시간.
  await open('긴 문서.docx');
  await placeCaret(null);
  await probe();
  const typed = 'abcdefghijklmnopqrst';
  for (const ch of typed) { await typeChar(ch); await sleep(250); }
  const long = await collect();
  const added = stats(long.map(k => k.added)), paint = stats(long.map(k => k.paint));
  console.log('600문단 키당 새 노드 ' + fmt(added));
  console.log('600문단 키→그리기 ms ' + fmt(paint) + ' | 키→DOM 변경 ms ' + fmt(stats(long.map(k => k.mut))));
  await cdp.shot(join(OUT, '01-long-typed.png'));
  assert.equal(long.length, typed.length, 'every key produced a paint: ' + long.length);
  assert.ok(added.p50 < 200, '600-paragraph keystroke adds < 200 nodes (p50 ' + added.p50 + ')');
  console.log('PASS (a) 600문단 키당 새 노드 p50 < 200');

  // (b) 입력한 글자가 그려진 쪽에 보이고, 한 글자를 골라 같은 폭 숫자로 바꿔 쳐도 반영된다.
  assert.ok((await pageText()).includes(typed), 'typed text is painted');
  for (const ch of '5550') { await typeChar(ch); await sleep(120); }
  await key('ArrowLeft', { vk: 37, modifiers: 8 });
  await sleep(200);
  await typeChar('6');
  await sleep(800);
  const afterReplace = await pageText();
  assert.ok(afterReplace.includes(typed + '5556'), 'same-width replacement is painted: ' + afterReplace.slice(0, 80));
  assert.ok(!afterReplace.includes(typed + '5550'), 'replaced digit is gone from the painted page');
  await cdp.shot(join(OUT, '02-long-replaced.png'));
  console.log('PASS (b) 입력 글자와 같은 폭 한 글자 치환이 그려진 쪽에 반영');

  // (d) 저장하면 디스크 DOCX에 들어간다.
  assert.equal(await save(), '저장됨');
  assert.ok(documentText(await readFile(join(docs, '긴 문서.docx'))).includes(typed + '5556'), 'saved docx has the typed text');

  // (c) 표 문서: 셀 R2C2 끝에 입력.
  await open('표 문서.docx');
  await placeCaret('R2C2');
  await probe();
  for (const ch of 'XYZ') { await typeChar(ch); await sleep(250); }
  const cell = await collect();
  console.log('표 문서 키당 새 노드 ' + fmt(stats(cell.map(k => k.added))) + ' | 키→그리기 ms ' + fmt(stats(cell.map(k => k.paint))));
  const tableText = await pageText();
  assert.ok(tableText.includes('R2C2XYZ'), 'cell input is painted: ' + tableText.slice(0, 120));
  assert.ok(tableText.includes('R1C1') && tableText.includes('R3C3') && tableText.includes('항목 둘') && tableText.includes('회의 제목'), 'other cells, list and heading stay painted');
  await cdp.shot(join(OUT, '03-table-typed.png'));
  console.log('PASS (c) 표 셀 입력 반영');
  assert.equal(await save(), '저장됨');
  assert.ok(documentText(await readFile(join(docs, '표 문서.docx'))).includes('R2C2XYZ'), 'saved docx has the cell text');

  // (d) 다른 문서로 갔다가 다시 열어도 입력 내용이 그대로다.
  await open('긴 문서.docx');
  assert.ok((await pageText()).includes(typed + '5556'), 'reopened long document keeps the typed text');
  await open('표 문서.docx');
  assert.ok((await pageText()).includes('R2C2XYZ'), 'reopened table document keeps the cell text');
  await cdp.shot(join(OUT, '04-reopened.png'));
  console.log('PASS (d) 저장 뒤 다시 열어도 입력 내용 유지');
  console.log('RESULT ' + JSON.stringify({ bundle: BUNDLE ?? 'build/office', longAdded: added, longPaint: paint, cellAdded: stats(cell.map(k => k.added)), cellPaint: stats(cell.map(k => k.paint)) }));
});
