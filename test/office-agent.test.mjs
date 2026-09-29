import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import ZAHL from 'xlsx/dist/xlsx.zahl.mjs';
import { createServer } from '../server/index.mjs';
import { runOfficeAgent } from '../server/agent/office-runner.mjs';
import { runAgent } from '../server/agent/runner.mjs';
import { verifySheet } from '../lib/office/agent-sheet.mjs';
import { blankDocx } from '../lib/office/blank.mjs';
import { appendParagraph, documentText } from '../lib/office/docx-text.mjs';
import { writeZip, bytesOf } from '../lib/office/zip.mjs';
const run = promisify(execFile);

async function styledXlsx() {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('예산');
  ws.getCell('A1').value = '항목'; ws.getCell('A1').font = { bold: true };
  ws.getCell('B2').value = 1;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function numbersFile() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 1]]), '표');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'numbers', numbers: ZAHL }));
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'jongi-agent-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'jongi-agent-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(join(root, '예산.xlsx'), await styledXlsx());
  await writeFile(join(root, '회의록.docx'), appendParagraph(blankDocx(), '첫 안건은 예산이다'));
  await writeFile(join(root, '가계부.numbers'), numbersFile());
  await writeFile(join(root, '발표.pptx'), writeZip(new Map([['ppt/presentation.xml', bytesOf('<p/>')]])));
  await writeFile(join(root, '메모.hwp'), Buffer.from('d0cf11e0a1b11ae100010203', 'hex'));
  await run('git', ['-C', root, 'init', '-q']);
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'seed']);
  const server = await createServer({ docsRoot: root, stateDir, startAgentSocket: null });
  t.after(() => server.close());
  return { root, store: server.store, tabs: server.tabs };
}
const office = (ctx, code, config = {}) => runOfficeAgent({ code, timeoutMs: 30000 }, { store: ctx.store, tabs: ctx.tabs, config });

test('xlsx: read, setCells (value + formula), save commits as agent and keeps styles', async t => {
  const ctx = await setup(t);
  const out = await office(ctx, "const docs = await office.docs(); const h = await office.open('예산.xlsx'); const before = await office.read(h, { range: 'A1:B2' }); await office.setCells(h, { start: 'B2', values: [[42, '=B2*2']] }); await office.save(h); return { docs, before, info: await office.info(h) };");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.result.before, [['항목', null], [null, 1]]);
  assert.deepEqual(out.result.docs.map(d => d.id).sort(), ['가계부.numbers', '발표.pptx', '예산.xlsx', '회의록.docx']);
  assert.deepEqual(out.result.info.sheets, ['예산']);
  assert.equal(out.saved.length, 1);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await readFile(join(ctx.root, '예산.xlsx')));
  const ws = wb.getWorksheet('예산');
  assert.equal(ws.getCell('B2').value, 42);
  assert.equal(ws.getCell('C2').formula, 'B2*2');
  assert.equal(ws.getCell('A1').font.bold, true);
  const { stdout } = await run('git', ['-C', ctx.root, 'log', '-1', '--format=%an|%s']);
  assert.equal(stdout.trim(), 'Jongi|office_exec: 예산.xlsx [agent]');
});

test('docx: find, replaceText and appendParagraph are verified then committed', async t => {
  const ctx = await setup(t);
  const out = await office(ctx, "const h = await office.open('회의록.docx'); const hits = await office.find(h, { query: '예산' }); const r = await office.replaceText(h, { find: '예산', replace: '인력', expectedCount: 1 }); await office.appendParagraph(h, { text: '다음 회의는 금요일' }); await office.save(h); return { hits, r };");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.result.r, { count: 1 });
  const text = documentText(await readFile(join(ctx.root, '회의록.docx')));
  assert.match(text, /첫 안건은 인력이다/);
  assert.match(text, /다음 회의는 금요일/);
  assert.doesNotMatch(text, /예산/);
});

test('a verification mismatch writes nothing, and the lock is released for the next call', async t => {
  const ctx = await setup(t);
  const before = await readFile(join(ctx.root, '예산.xlsx'));
  // 저장 바이트를 몰래 바꿔 진짜 검증기에 넘긴다: 검증기가 차이를 잡아야 한다.
  const tampered = async (bytes, model) => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes);
    wb.worksheets[0].getCell('B2').value = 0;
    return verifySheet(new Uint8Array(await wb.xlsx.writeBuffer()), model);
  };
  const failed = await office(ctx, "const h = await office.open('예산.xlsx'); await office.setCells(h, { start: 'B2', values: [[7]] }); await office.save(h);", { verifySheet: tampered });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'AGENT_VERIFY_MISMATCH');
  assert.deepEqual(failed.details.mismatches[0], { cell: '예산!B2', expected: 7, actual: 0 });
  assert.deepEqual(await readFile(join(ctx.root, '예산.xlsx')), before);
  assert.equal(ctx.store.isLocked('예산.xlsx'), false);
  const again = await office(ctx, "const h = await office.open('예산.xlsx'); return (await office.read(h, { range: 'B2' }))[0][0];");
  assert.equal(again.ok, true);
  assert.equal(again.result, 1);
});

test('guards: locked document, formula in Numbers, read-only slides, HWP handed to hwp_exec, one document per call', async t => {
  const ctx = await setup(t);
  const token = ctx.store.lock('예산.xlsx');
  const locked = await office(ctx, "await office.open('예산.xlsx');");
  token.release();
  assert.equal(locked.code, 'DOCUMENT_LOCKED');
  const numbers = await office(ctx, "const h = await office.open('가계부.numbers'); await office.setCells(h, { start: 'C1', values: [['=B1*2']] });");
  assert.equal(numbers.code, 'FORMULA_NOT_SAVED');
  const value = await office(ctx, "const h = await office.open('가계부.numbers'); await office.setCells(h, { start: 'C1', values: [[2]] }); await office.save(h);");
  assert.equal(value.ok, true, JSON.stringify(value));
  const back = XLSX.read(await readFile(join(ctx.root, '가계부.numbers')));
  assert.deepEqual(XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1 }), [['a', 1, 2]]);
  const slides = await office(ctx, "const h = await office.open('발표.pptx'); const info = await office.info(h); await office.save(h);");
  assert.equal(slides.code, 'FORMAT_READ_ONLY');
  const hwp = await office(ctx, "await office.open('메모.hwp');");
  assert.equal(hwp.code, 'FORMAT_UNSUPPORTED');
  assert.deepEqual(hwp.details, { use: 'hwp_exec' });
  const two = await office(ctx, "await office.open('예산.xlsx'); await office.open('회의록.docx');");
  assert.equal(two.ok, false);
  assert.match(two.error, /one document per invocation/);
});

test('hwp_exec keeps its contract: docs lists only HWP/HWPX and open refuses office formats', async t => {
  const ctx = await setup(t);
  const docs = await runAgent({ code: 'return await hwp.docs();', timeoutMs: 30000 }, { store: ctx.store, tabs: ctx.tabs, config: {} });
  assert.equal(docs.ok, true, JSON.stringify(docs));
  assert.deepEqual(docs.result, [{ id: '메모.hwp', format: 'hwp' }]);
  const open = await runAgent({ code: "await hwp.open('예산.xlsx');", timeoutMs: 30000 }, { store: ctx.store, tabs: ctx.tabs, config: {} });
  assert.equal(open.ok, false);
  assert.equal(open.code, 'FORMAT_UNSUPPORTED');
  assert.equal(ctx.store.isLocked('예산.xlsx'), false);
});

test('an open editor tab is told the document changed', async t => {
  const ctx = await setup(t);
  const lease = ctx.tabs.claim('예산.xlsx');
  const written = [];
  const fake = { writableEnded: false, writeHead() {}, write(chunk) { written.push(String(chunk)); return true; }, on() {}, end() { this.writableEnded = true; } };
  assert.equal(ctx.tabs.events(lease, fake), true);
  const out = await office(ctx, "const h = await office.open('예산.xlsx'); await office.setCells(h, { start: 'D1', values: [['새 값']] }); await office.save(h);");
  assert.equal(out.ok, true);
  const event = written.find(chunk => chunk.startsWith('event: office.changed'));
  assert.ok(event, written.join(''));
  const data = JSON.parse(event.split('data: ')[1]);
  assert.equal(data.docId, '예산.xlsx');
  assert.equal(data.leaseId, lease);
  assert.equal(data.commit, out.saved[0].commit);
  ctx.tabs.release(lease);
});

