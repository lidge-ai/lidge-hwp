// 오피스 편집기 브라우저 시나리오(수동 실행: node test/office-browser.mjs). 실제 Chrome으로 열기·입력·저장을 돈다.
// 산출물: OFFICE_QA_DIR(기본 /tmp/jongi-office-qa)에 단계별 스크린샷.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import ZAHL from 'xlsx/dist/xlsx.zahl.mjs';
import { withBrowser, until, expect as assert } from './browser-shell-helper.mjs';

const git = promisify(execFile);
const OUT = process.env.OFFICE_QA_DIR || '/tmp/jongi-office-qa';
await mkdir(OUT, { recursive: true });

async function styledXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('예산');
  ws.getCell('A1').value = '항목'; ws.getCell('A1').font = { bold: true, color: { argb: 'FFC00000' } };
  ws.getCell('B1').value = '금액'; ws.getCell('B2').value = 1000; ws.getCell('B3').value = { formula: 'B2*2', result: 2000 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function numbersFile() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['날짜', '지출'], ['9/1', 12000], ['9/2', 8000]]), '가계부');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'numbers', numbers: ZAHL }));
}

await withBrowser({ files: ['메모.hwp'] }, async ({ cdp, docs }) => {
  const page = source => cdp.eval(source); // justified: CDP Runtime.evaluate inside the headless test browser, not dynamic code in this process
  const dialogs = [];
  await cdp.send('Page.enable');
  cdp.on('Page.javascriptDialogOpening', params => {
    dialogs.push(params.message);
    void cdp.send('Page.handleJavaScriptDialog', { accept: true });
  });
  await writeFile(join(docs, '예산.xlsx'), await styledXlsx());
  await writeFile(join(docs, '가계부.numbers'), numbersFile());
  await writeFile(join(docs, '표.csv'), '이름,점수\n가,1\n나,2\n');
  await git('git', ['-C', docs, 'add', '.']);
  await git('git', ['-C', docs, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'office seed']);
  await page("document.querySelector('#docs-refresh').click();");
  await until(() => page("return !!document.querySelector('.doc[data-id=\"가계부.numbers\"]');"));

  const open = async id => {
    await page('document.querySelector(' + JSON.stringify('.doc[data-id="' + id + '"]') + ').click();');
    await until(() => page("return document.body.dataset.shellState === 'open' && document.querySelector('#filename').title === " + JSON.stringify(id) + ";"), 30000);
    await until(() => page("return document.querySelectorAll('#office-host canvas').length > 0;"), 30000);
    await new Promise(r => setTimeout(r, 800));
  };
  // 셀 좌표(0부터) 가운데를 두 번 눌러 편집을 열고 글자를 넣은 뒤 Enter.
  const typeCell = async (row, col, text) => {
    const box = await page("const a = document.querySelector('#office-host .fortune-sheet-overlay') || document.querySelector('#office-host .fortune-cell-area'); const r = a.getBoundingClientRect(); return { x: r.left, y: r.top };");
    const header = await page("const h = document.querySelector('#office-host .fortune-col-header'); const rh = document.querySelector('#office-host .fortune-row-header'); return { top: h ? h.getBoundingClientRect().bottom : 0, left: rh ? rh.getBoundingClientRect().right : 0 };");
    const x = Math.round(header.left + 73 * col + 36), y = Math.round(header.top + 20 * row + 10);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 2 });
    await new Promise(r => setTimeout(r, 300));
    await page("const e = document.querySelector('#office-host .luckysheet-cell-input'); if (e) { e.focus(); const s = window.getSelection(); s.selectAllChildren(e); }");
    await cdp.send('Input.insertText', { text });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await new Promise(r => setTimeout(r, 300));
    return { x, y, box };
  };
  const save = async () => {
    const before = await page("return document.querySelector('#status').textContent;");
    await page("document.querySelector('#save').click();");
    await until(() => page("const s = document.querySelector('#status').textContent; return s === '저장됨' || s.startsWith('저장 실패') || s === '저장 취소';"), 30000);
    return page("return document.querySelector('#status').textContent;");
  };
  const lastCommit = async file => (await git('git', ['-C', docs, 'log', '-1', '--format=%s', '--', file])).stdout.trim();

  // 1. xlsx: 열기 → B2 입력 → 저장 → 디스크에서 값 변경과 A1 서식 유지 확인
  await open('예산.xlsx');
  await cdp.shot(join(OUT, '01-xlsx-open.png'));
  await typeCell(1, 1, '4242');
  await cdp.shot(join(OUT, '02-xlsx-edited.png'));
  assert.equal(await save(), '저장됨');
  const saved = new ExcelJS.Workbook(); await saved.xlsx.load(await readFile(join(docs, '예산.xlsx')));
  const ws = saved.getWorksheet('예산');
  assert.equal(ws.getCell('B2').value, 4242);
  assert.equal(ws.getCell('A1').font.bold, true);
  assert.equal(ws.getCell('A1').font.color.argb, 'FFC00000');
  assert.equal(await lastCommit('예산.xlsx'), 'Edit 예산.xlsx [human]');
  console.log('PASS xlsx open/edit/save keeps A1 style and writes B2');

  // 2. numbers: 열기 → B3 입력 → 저장(경고 동의) → SheetJS로 다시 읽어 값 확인
  await open('가계부.numbers');
  await cdp.shot(join(OUT, '03-numbers-open.png'));
  await typeCell(2, 1, '9000');
  assert.equal(await save(), '저장됨');
  assert.ok(dialogs.some(message => message.includes('Numbers')), 'numbers save asks for consent: ' + dialogs.join(' | '));
  const back = XLSX.read(await readFile(join(docs, '가계부.numbers')));
  const rows = XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1 });
  assert.equal(rows[2][1], 9000);
  assert.equal(await lastCommit('가계부.numbers'), 'Edit 가계부.numbers [human]');
  await cdp.shot(join(OUT, '04-numbers-saved.png'));
  console.log('PASS numbers open/edit/save with consent dialog');

  // 3. csv
  await open('표.csv');
  await typeCell(1, 1, '10');
  assert.equal(await save(), '저장됨');
  assert.match((await readFile(join(docs, '표.csv'), 'utf8')).replace(/\r/g, ''), /가,10/);
  console.log('PASS csv open/edit/save');

  // 4. HWP로 돌아가도 기존 편집기가 뜬다(오피스 편집기는 치운다)
  await page("document.querySelector('.doc[data-id=\"메모.hwp\"]').click();");
  await until(() => page("return document.body.dataset.shellState === 'open' && document.body.dataset.editorFamily === 'hwp' && document.querySelector('#office-host').hidden && !document.querySelector('#office-host canvas');"), 30000);
  await cdp.shot(join(OUT, '05-back-to-hwp.png'));
  console.log('PASS switching back to HWP restores the rhwp editor');
});

