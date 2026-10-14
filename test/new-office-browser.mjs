// 새 문서 형식 메뉴와 Google 가져오기 대화상자(수동 실행: node test/new-office-browser.mjs).
// Google 서버 응답은 가짜 fetch로 대신한다(네트워크 없음).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { blankXlsx } from '../lib/office/blank.mjs';
import { withBrowser, until, key, expect as assert } from './browser-shell-helper.mjs';

const fakeGoogle = async url => {
  const body = blankXlsx();
  const response = new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': "attachment; filename=\"x.xlsx\"; filename*=UTF-8''%EA%B3%B5%EC%9C%A0%20%EC%98%88%EC%82%B0.xlsx" } });
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
};

await withBrowser({ files: ['P/a.hwp'], office: { fetchImpl: fakeGoogle } }, async ({ cdp, docs }) => {
  const page = source => cdp.eval(source); // justified: CDP Runtime.evaluate inside the headless test browser, not dynamic code in this process
  // 셸 모듈이 끝까지 실행된 뒤(편집기 준비 표시)에 메뉴를 누른다. 정적 HTML만으로는 리스너가 아직 없다.
  await until(() => page("return document.body.dataset.studioReady === 'true';"), 30000);
  // 메뉴: 버튼으로 열고 Escape로 닫으면 포커스가 버튼으로 돌아온다.
  await page("document.querySelector('#new-menu').click();");
  assert.equal(await page("return document.querySelector('#new-menu').getAttribute('aria-expanded');"), 'true');
  assert.equal(await page("return document.activeElement.dataset.new;"), 'hwp');
  await page("document.activeElement.dispatchEvent(" + key('ArrowDown') + ");");
  assert.equal(await page("return document.activeElement.dataset.new;"), 'xlsx');
  // 메뉴가 열린 동안 ⌘N은 새 문서 초안을 만들지 않는다
  await page("document.activeElement.dispatchEvent(" + key('n', 'metaKey: true, code: "KeyN"') + ");");
  assert.equal(await page("return !!document.querySelector('.new-doc-row');"), false);
  await page("document.activeElement.dispatchEvent(" + key('Escape') + ");");
  assert.equal(await page("return document.querySelector('#new-menu-list').hidden && document.activeElement.id;"), 'new-menu');
  console.log('PASS new menu keyboard: open, arrow, Escape returns focus, ⌘N blocked while open');

  // XLSX 새 문서: 인라인 이름 입력 → Enter → 서버가 빈 xlsx를 만들고 시트 편집기로 연다
  await page("document.querySelector('#new-menu').click();");
  await page("document.querySelector('[data-new=\"xlsx\"]').click();");
  await until(() => page("return !!document.querySelector('.new-doc-row input');"));
  assert.equal(await page("return document.querySelector('.new-doc-row .badge').textContent;"), 'XLSX');
  await page("const input = document.querySelector('.new-doc-row input'); input.value = '분기 예산'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(" + key('Enter') + ");");
  await until(() => page("return document.body.dataset.shellState === 'open' && document.body.dataset.editorFamily === 'sheet';"), 30000).catch(async error => { console.log(JSON.stringify(await page("return { title: document.querySelector('#filename').title, status: document.querySelector('#status').textContent, state: document.body.dataset.shellState, fam: document.body.dataset.editorFamily, err: document.querySelector('.name-error')?.textContent };"))); throw error; });
  assert.equal(await page("return document.querySelector('#filename').title;"), '분기 예산.xlsx');
  assert.equal((await readFile(join(docs, '분기 예산.xlsx'))).subarray(0, 2).toString(), 'PK');
  assert.equal(await page("return document.querySelector('#doc-format').textContent;"), 'XLSX');
  await cdp.shot('/tmp/jongi-office-qa/11-new-xlsx.png');
  console.log('PASS new XLSX from the menu is created and opened in the sheet editor');

  // Google 가져오기: 잘못된 주소는 대화상자 안에서 오류, 맞는 주소는 공유 이름으로 만들고 연다
  await page("document.querySelector('#new-menu').click(); document.querySelector('[data-new=\"google\"]').click();");
  assert.equal(await page("return document.querySelector('#import-dialog').open;"), true);
  await page("document.querySelector('#import-url').value = 'https://example.com/x'; document.querySelector('#import-go').click();");
  await until(() => page("return document.querySelector('#import-error').textContent.includes('docs.google.com');"));
  await page("document.querySelector('#import-url').value = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'; document.querySelector('#import-go').click();");
  await until(() => page("return document.querySelector('#filename').title === '공유 예산.xlsx' && document.body.dataset.shellState === 'open';"), 30000);
  assert.equal(await page("return document.querySelector('#import-dialog').open;"), false);
  assert.ok((await readdir(docs)).includes('공유 예산.xlsx'));
  await cdp.shot('/tmp/jongi-office-qa/12-google-import.png');
  console.log('PASS Google import dialog validates, imports into the target group and opens the copy');
});
