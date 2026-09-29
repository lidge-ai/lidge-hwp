// ⌘S 저장과 끊긴 연결 복구 브라우저 시나리오(수동 실행: build:studio·build:office 뒤 node test/save-shortcut-browser.mjs).
// 셸 어디서 누른 ⌘S든 앱 저장이 되고(브라우저 "페이지 저장"으로 새지 않음), SSE가 끊긴 탭은 ⌘S나 배경 재연결로
// 새 lease를 받아 저장한다. 서버 재시작은 server.tabs.release(서버가 SSE 응답을 끝냄)로, 서버가 죽어 있는 동안은
// CDP Fetch로 /api/tabs·/api/events 요청을 실패시켜 흉내 낸다.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as XLSX from 'xlsx';
import { withBrowser, until, expect as assert } from './browser-shell-helper.mjs';
import { blankDocx, blankXlsx } from '../lib/office/blank.mjs';
import { appendParagraph, documentText } from '../lib/office/docx-text.mjs';
import { openDocument } from '../lib/rhwp-node.mjs';

const git = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const FRAME = "document.querySelector('#studio iframe').contentWindow";
const DOCS = ['a.hwp', 'b.hwp', 'c.hwp', 'd.docx', 'e.xlsx'];
const DISCONNECTED = '연결이 끊겼습니다 · 다시 연결하는 중';

await withBrowser({ files: ['a.hwp', 'b.hwp', 'c.hwp'] }, async ({ cdp, docs, server }) => {
  const page = source => cdp.eval(source); // justified: CDP Runtime.evaluate inside the headless test browser, not dynamic code in this process
  const failures = [];
  const scenario = async (name, body) => {
    try { await body(); console.log('PASS ' + name); }
    catch (error) { failures.push(name); console.log('FAIL ' + name + ': ' + (error?.stack || error)); }
  };
  const dialogs = [];
  cdp.on('Page.javascriptDialogOpening', params => {
    dialogs.push(params.message);
    void cdp.send('Page.handleJavaScriptDialog', { accept: true });
  });
  // CDP Fetch: 시나리오가 policy를 바꿔 요청을 통과·실패·보류시킨다.
  let policy = () => 'continue';
  const held = [];
  cdp.on('Fetch.requestPaused', params => {
    const action = policy(params.request);
    if (action === 'fail') void cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' });
    else if (action === 'hold') held.push(params);
    else void cdp.send('Fetch.continueRequest', { requestId: params.requestId });
  });
  const release = paused => cdp.send('Fetch.continueRequest', { requestId: paused.requestId }).catch(() => {});

  await writeFile(join(docs, 'd.docx'), appendParagraph(blankDocx(), '첫 문단'));
  await writeFile(join(docs, 'e.xlsx'), blankXlsx());
  await git('git', ['-C', docs, 'add', '.']);
  await git('git', ['-C', docs, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'office seed']);
  await page("document.querySelector('#docs-refresh').click();");
  await until(() => page("return !!document.querySelector('.doc[data-id=\"e.xlsx\"]');"));
  // PUT 요청(과 X-Lease)과 ⌘S keydown의 defaultPrevented를 기록한다.
  await page(`window.__puts = []; window.__prevented = [];
    const realFetch = window.fetch;
    window.fetch = function (url, options) {
      if (String(url).startsWith('/api/docs/') && options?.method === 'PUT') window.__puts.push(options.headers?.['X-Lease'] ?? null);
      return realFetch.apply(this, arguments);
    };
    window.__watchKeys = target => target.addEventListener('keydown', event => {
      if (event.metaKey && event.code === 'KeyS') setTimeout(() => window.__prevented.push(event.defaultPrevented), 0);
    }, true);
    window.__watchKeys(window);`);

  const shell = () => page("return { id: document.querySelector('#filename').title, status: document.querySelector('#status').textContent, saveDisabled: document.querySelector('#save').disabled, puts: window.__puts.length, lastLease: window.__puts.at(-1) ?? null, prevented: window.__prevented.length };");
  const leases = () => DOCS.filter(id => server.tabs.owner(id) || server.tabs.claimed(id));
  const idle = () => until(async () => !['저장 중', '연결을 다시 붙이는 중'].includes((await shell()).status));
  const open = async (id, ready) => {
    await page('document.querySelector(' + JSON.stringify('.doc[data-id="' + id + '"]') + ').click();');
    await until(async () => { const s = await shell(); return s.id === id && s.status === '열림'; }, 40000);
    await until(() => page(ready), 40000);
    await delay(800);
  };
  const hwpReady = "return !!" + FRAME + ".document.querySelector('[data-rhwp-editor-input=\"true\"]');";
  const docxReady = "return !!document.querySelector('#office-host .office-doc [contenteditable]');";
  const xlsxReady = "return document.querySelectorAll('#office-host canvas').length > 0;";
  const READY = { 'a.hwp': hwpReady, 'b.hwp': hwpReady, 'c.hwp': hwpReady, 'd.docx': docxReady, 'e.xlsx': xlsxReady };
  // 시나리오를 서로 독립시킨다: 이 문서가 열려 있고 서버에 SSE가 붙은 lease가 있을 때까지 기다린다.
  const ensure = async id => {
    if ((await shell()).id !== id) await open(id, READY[id]);
    await until(async () => server.tabs.owner(id) && !['저장 중', '연결을 다시 붙이는 중', DISCONNECTED].includes((await shell()).status), 30000);
  };
  const focusStudio = () => page("const w = " + FRAME + "; if (!w.__saveWatched) { window.__watchKeys(w); w.__saveWatched = true; } w.document.querySelector('[data-rhwp-editor-input=\"true\"]').focus();");
  const key = async (name, code, virtualKeyCode, modifiers = 0) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, modifiers, windowsVirtualKeyCode: virtualKeyCode });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, modifiers, windowsVirtualKeyCode: virtualKeyCode });
  };
  const cmdS = (name = 's') => key(name, 'KeyS', name === 'Process' ? 229 : 83, 4);
  // ⌘S 한 번 → PUT 정확히 1회와 브라우저 기본 동작 차단.
  const expectOneSave = async (label, name = 's') => {
    await idle();
    const before = await shell();
    await cmdS(name);
    await until(async () => { const s = await shell(); return s.puts === before.puts + 1 && s.status === '저장됨'; }, 20000)
      .catch(async () => { throw new Error(label + ': ' + JSON.stringify(await shell())); });
    await delay(400);
    const after = await shell();
    assert.equal(after.puts, before.puts + 1, label + ' PUT count');
    const prevented = await page('return window.__prevented.slice(' + before.prevented + ');');
    assert.deepEqual(prevented, [true], label + ' defaultPrevented');
    return after;
  };
  // 서버가 이 문서의 SSE를 끝낸다(서버 재시작과 같은 효과). 셸이 끊김을 알아챌 때까지 기다린다.
  const dropSse = async id => {
    const old = server.tabs.owner(id);
    assert.ok(old, 'lease before drop: ' + id);
    server.tabs.release(old);
    await until(async () => (await shell()).status === DISCONNECTED, 5000);
    return old;
  };
  const click = async (x, y, clickCount = 1) => { for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount }); };
  const typeCell = async (row, col, text) => {
    const h = await page("const h = document.querySelector('#office-host .fortune-col-header'); const rh = document.querySelector('#office-host .fortune-row-header'); return { top: h.getBoundingClientRect().bottom, left: rh.getBoundingClientRect().right };");
    const x = Math.round(h.left + 73 * col + 36), y = Math.round(h.top + 20 * row + 10);
    await click(x, y); await click(x, y, 2); await delay(300);
    await page("const e = document.querySelector('#office-host .luckysheet-cell-input'); if (e) { e.focus(); window.getSelection().selectAllChildren(e); }");
    await cdp.send('Input.insertText', { text });
    await key('Enter', 'Enter', 13);
    await delay(300);
  };
  const typeDoc = async text => {
    const spot = await page("const el = document.querySelector('#office-host .office-doc'); const pages = [...el.querySelectorAll('*')].filter(n => { const r = n.getBoundingClientRect(); return r.width > 400 && r.height > 500 && getComputedStyle(n).backgroundColor === 'rgb(255, 255, 255)'; }); const p = pages.at(-1) ?? el; const r = p.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 110) };");
    await click(spot.x, spot.y); await delay(300);
    await key('End', 'End', 35, 4);
    await cdp.send('Input.insertText', { text });
    await delay(500);
  };
  const hwpText = async id => {
    const doc = await openDocument(await readFile(join(docs, id)));
    try { return doc.getTextRange(0, 0, 0, doc.getParagraphLength(0, 0)); } finally { doc.free(); }
  };
  // 끊긴 탭에서 배경 재연결 전에 ⌘S → 새 lease로 PUT 1회, 상태줄 '저장됨'.
  const saveAfterDrop = async id => {
    const old = await dropSse(id);
    const before = await shell();
    assert.equal(before.status, DISCONNECTED, 'still disconnected when Command-S is pressed');
    await cmdS();
    await until(async () => { const s = await shell(); return s.status === '저장됨' || s.status.startsWith('저장 실패'); }, 20000);
    await delay(300);
    const after = await shell();
    assert.equal(after.status, '저장됨', id + ' status after reconnect-save');
    assert.equal(after.puts, before.puts + 1, id + ' PUT count');
    assert.notEqual(after.lastLease, old, id + ' PUT used a new lease');
    assert.equal(after.lastLease, server.tabs.owner(id), id + ' PUT lease is the connected one');
    assert.equal(after.saveDisabled, false);
  };

  await scenario('1 shell focus Command-S saves once and blocks the browser default', async () => {
    await open('a.hwp', hwpReady);
    const spots = {
      '문서 행': "document.querySelector('.doc[data-id=\"a.hwp\"]').focus();",
      '검색창': "document.querySelector('#doc-filter').focus();",
      '헤더 경로 복사': "document.querySelector('#copy-path').focus();",
      'body': "document.activeElement?.blur();",
    };
    for (const [label, focus] of Object.entries(spots)) { await page(focus); await expectOneSave(label); }
    await page("document.querySelector('.doc[data-id=\"a.hwp\"]').focus();");
    await key('F2', 'F2', 113);
    await until(() => page("return document.activeElement?.classList.contains('rename-input');"), 5000);
    await expectOneSave('이름 편집 input');
    await page("document.querySelector('.rename-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));");
    await page("document.querySelector('#new-menu').click();");
    await until(() => page("return !document.querySelector('#new-menu-list').hidden;"), 5000);
    await page("document.querySelector('#new-menu-list [role=menuitem]').focus();");
    await expectOneSave('새 문서 메뉴');
    await page("document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));");

    await open('d.docx', "return !!document.querySelector('#office-host .office-doc [contenteditable]');");
    for (const [label, selector] of [['File 메뉴', '#office-host .docx-menubar__trigger'],
      ['글꼴 목록', '#office-host button[aria-label^="Select font family"]']]) {
      await page("document.activeElement?.blur();");
      const box = await page('const r = document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };');
      await click(box.x, box.y); await delay(400);
      await key('ArrowDown', 'ArrowDown', 40);
      await delay(200);
      assert.equal(await page("return !!document.activeElement.closest('.office-editor');"), false, label + ' focus is outside the DOCX editor element');
      await expectOneSave('DOCX ' + label);
      await key('Escape', 'Escape', 27);
      await delay(200);
    }
  });

  await scenario('2 HWP canvas Command-S with key Process (IME) saves once', async () => {
    await open('a.hwp', hwpReady);
    await focusStudio();
    await cdp.send('Input.insertText', { text: 'p' });
    await expectOneSave('HWP Process', 'Process');
  });

  await scenario('3a HWP: Command-S after SSE drop reconnects and saves the edit', async () => {
    await focusStudio();
    await cdp.send('Input.insertText', { text: 'SAVECHECK' });
    await saveAfterDrop('a.hwp');
    assert.match(await hwpText('a.hwp'), /SAVECHECK/);
  });

  await scenario('3b DOCX: Command-S after SSE drop reconnects and saves the edit', async () => {
    await ensure('d.docx');
    await typeDoc(' 다시 연결 저장');
    await saveAfterDrop('d.docx');
    assert.match(documentText(await readFile(join(docs, 'd.docx'))), /다시 연결 저장/);
  });

  await scenario('3c XLSX: Command-S after SSE drop reconnects and saves the edit', async () => {
    await ensure('e.xlsx');
    await typeCell(1, 1, '4242');
    await saveAfterDrop('e.xlsx');
    const book = XLSX.read(await readFile(join(docs, 'e.xlsx')));
    assert.equal(book.Sheets[book.SheetNames[0]].B2?.v, 4242);
  });

  await scenario('4 background reconnect restores the tab without Command-S', async () => {
    await ensure('e.xlsx');
    const old = await dropSse('e.xlsx');
    await until(async () => (await shell()).status === '다시 연결됨', 10000);
    assert.equal((await shell()).saveDisabled, false);
    const lease = server.tabs.owner('e.xlsx');
    assert.ok(lease && lease !== old, 'server has a new connected lease');
    assert.deepEqual(leases(), ['e.xlsx']);
  });

  await scenario('5 a dropped office tab does not carry its save lock to the next document', async () => {
    await ensure('e.xlsx');
    await dropSse('e.xlsx');
    await page("document.querySelector('.doc[data-id=\"b.hwp\"]').click();");
    await until(async () => { const s = await shell(); return s.id === 'b.hwp' && s.status === '열림'; }, 40000);
    await until(() => page(hwpReady), 40000);
    await delay(1500); // e.xlsx의 배경 재연결 시각을 지나도록
    assert.equal((await shell()).saveDisabled, false);
    await focusStudio();
    await expectOneSave('b.hwp after leaving a dropped xlsx tab');
    assert.deepEqual(leases(), ['b.hwp']);
  });

  await scenario('6 while the server stays down Command-S reports the failure and does not PUT', async () => {
    await ensure('b.hwp');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/tabs' }, { urlPattern: '*/api/events*' }] });
    policy = () => 'fail';
    try {
      await dropSse('b.hwp');
      const before = await shell();
      await focusStudio();
      await cmdS();
      await until(async () => (await shell()).status.startsWith('저장 실패'), 20000);
      const after = await shell();
      assert.match(after.status, /^저장 실패: 연결이 끊겼습니다/);
      assert.equal(after.puts, before.puts, 'no PUT while down');
      assert.deepEqual(await page('return window.__prevented.slice(' + before.prevented + ');'), [true]);
      // 서버가 돌아오면 다음 ⌘S가 다시 붙여 저장한다.
      policy = () => 'continue';
      await focusStudio();
      await expectOneSave('b.hwp after the server is back');
      assert.deepEqual(leases(), ['b.hwp']);
    } finally { policy = () => 'continue'; }
  });

  await scenario('7a switching documents while the reconnect lease request is in flight leaves no orphan lease', async () => {
    await ensure('b.hwp');
    policy = request => request.method === 'POST' && String(request.postData).includes('"b.hwp"') ? 'hold' : 'continue';
    try {
      await dropSse('b.hwp');
      await until(async () => held.length === 1, 5000);
      await open('c.hwp', hwpReady);
      await release(held.shift());
      await delay(1500);
      assert.deepEqual(leases(), ['c.hwp']);
    } finally { policy = () => 'continue'; }
  });

  await scenario('7b switching documents while the reconnect SSE is still connecting leaves no orphan lease', async () => {
    await ensure('c.hwp');
    let holdNext = true;
    policy = request => {
      if (holdNext && request.url.includes('/api/events')) { holdNext = false; return 'hold'; }
      return 'continue';
    };
    try {
      await dropSse('c.hwp');
      await until(async () => held.length === 1, 5000);
      await open('a.hwp', hwpReady);
      await delay(6000); // 재연결의 hello 한도(5초)를 넘긴다
      await release(held.shift());
      await delay(1000);
      assert.deepEqual(leases(), ['a.hwp']);
    } finally { policy = () => 'continue'; await cdp.send('Fetch.disable').catch(() => {}); }
  });

  console.log(dialogs.length ? 'dialogs: ' + dialogs.join(' | ') : 'dialogs: none');
  if (failures.length) { console.log('FAILED: ' + failures.join(', ')); process.exitCode = 1; }
});
