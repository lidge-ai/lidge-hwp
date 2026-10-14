import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
import { blankDocx, blankXlsx } from '../lib/office/blank.mjs';
import { writeZip, bytesOf } from '../lib/office/zip.mjs';
const run = promisify(execFile);

const HWP = Buffer.from('d0cf11e0a1b11ae100010203', 'hex');
const PPTX = writeZip(new Map([['[Content_Types].xml', bytesOf('<Types/>')], ['ppt/presentation.xml', bytesOf('<p:presentation/>')]]));
// ODF는 mimetype 항목을 압축하지 않고 맨 앞에 둔다(LibreOffice 출력과 같게).
const odf = kind => writeZip(new Map([['mimetype', bytesOf('application/vnd.oasis.opendocument.' + kind)], ['content.xml', bytesOf('<office:document-content/>')]]), { compression: false });
const v2 = (format, extra = {}) => Buffer.from(JSON.stringify({ schemaVersion: 2, outputFormat: format, count: 0, losses: [], warnings: [], ...extra })).toString('base64');
const v1 = format => Buffer.from(JSON.stringify({ schemaVersion: 1, outputFormat: format, count: 0, losses: [] })).toString('base64');

async function setup(t, office = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jongi-office-api-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'jongi-office-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(join(root, 'proj'));
  await writeFile(join(root, 'a.xlsx'), blankXlsx());
  await writeFile(join(root, 'b.docx'), blankDocx());
  await writeFile(join(root, 'c.pptx'), PPTX);
  await writeFile(join(root, 'd.txt'), 'not a document');
  await writeFile(join(root, 'e.hwp'), HWP);
  await writeFile(join(root, 'f.odt'), odf('text'));
  await writeFile(join(root, '~$b.docx'), 'lock');
  await run('git', ['-C', root, 'init', '-q']);
  const server = await createServer({ docsRoot: root, stateDir, startAgentSocket: null, office });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { root, base: 'http://127.0.0.1:' + server.address().port, server };
}
async function claim(base, docId) {
  const res = await fetch(base + '/api/tabs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId }) });
  assert.equal(res.status, 201);
  return (await res.json()).lease;
}
async function put(base, id, body, headers) {
  return fetch(base + '/api/docs/' + encodeURIComponent(id), { method: 'PUT', body, headers });
}

test('library lists every registered format and skips txt and Office lock files', async t => {
  const { base } = await setup(t);
  const { docs } = await (await fetch(base + '/api/docs')).json();
  assert.deepEqual(docs.map(d => d.id).sort(), ['a.xlsx', 'b.docx', 'c.pptx', 'e.hwp', 'f.odt']);
  assert.deepEqual(docs.find(d => d.id === 'a.xlsx'), { id: 'a.xlsx', format: 'xlsx' });
  const get = await fetch(base + '/api/docs/b.docx');
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('x-document-format'), 'docx');
  assert.equal((await fetch(base + '/api/docs/d.txt')).status, 400);
  const formats = await fetch(base + '/formats.mjs');
  assert.equal(formats.status, 200);
  assert.match(formats.headers.get('content-type'), /javascript/);
  assert.match(await formats.text(), /export const FORMATS/);
});

test('office PUT: read-only 405, report v2 required, bytes sniffed, commit on success', async t => {
  const { base, root } = await setup(t);
  // 미리보기 전용(pptx): 임대·ETag·형식 헤더가 맞아도 405
  const pptxEtag = (await fetch(base + '/api/docs/c.pptx')).headers.get('etag');
  const pptxLease = await claim(base, 'c.pptx');
  const readOnly = await put(base, 'c.pptx', PPTX, { 'If-Match': pptxEtag, 'X-Lease': pptxLease, 'X-Document-Format': 'pptx', 'X-Content-Loss-Report': v2('pptx') });
  assert.equal(readOnly.status, 405);
  assert.equal((await readOnly.json()).error.code, 'FORMAT_READ_ONLY');

  const etag = (await fetch(base + '/api/docs/a.xlsx')).headers.get('etag');
  const lease = await claim(base, 'a.xlsx');
  const headers = { 'If-Match': etag, 'X-Lease': lease, 'X-Document-Format': 'xlsx' };
  const next = blankXlsx();
  next[next.length - 1] ^= 0; // 같은 바이트여도 새 버퍼
  const oldReport = await put(base, 'a.xlsx', next, { ...headers, 'X-Content-Loss-Report': v1('xlsx') });
  assert.equal(oldReport.status, 400);
  assert.equal((await oldReport.json()).error.code, 'INVALID_REPORT');
  const badWarning = await put(base, 'a.xlsx', next, { ...headers, 'X-Content-Loss-Report': v2('xlsx', { warnings: ['no spaces allowed'] }) });
  assert.equal(badWarning.status, 400);
  const swapped = await put(base, 'a.xlsx', blankDocx(), { ...headers, 'X-Content-Loss-Report': v2('xlsx') });
  assert.equal(swapped.status, 400);
  assert.equal((await swapped.json()).error.code, 'INVALID_BYTES');
  const agent = await put(base, 'a.xlsx', next, { ...headers, 'X-Content-Loss-Report': v2('xlsx'), 'X-Agent-Request-Id': 'x' });
  assert.equal(agent.status, 400);
  assert.equal((await agent.json()).error.code, 'AGENT_UNSUPPORTED');
  const edited = Buffer.from(blankXlsx());
  const replaced = await (async () => { const XLSX = await import('xlsx');
    const wb = XLSX.read(edited); XLSX.utils.sheet_add_aoa(wb.Sheets.Sheet1, [['값', 42]]);
    return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); })();
  const saved = await put(base, 'a.xlsx', replaced, { ...headers, 'X-Content-Loss-Report': v2('xlsx', { warnings: ['STYLES_NOT_SAVED'] }) });
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(await readFile(join(root, 'a.xlsx')), replaced);
  const { stdout } = await run('git', ['-C', root, 'log', '-1', '--format=%s']);
  assert.equal(stdout.trim(), 'Edit a.xlsx [human]');
});

test('odt saves convert docx body back through LibreOffice; converter failure is 502', async t => {
  const calls = [];
  let failNext = false;
  const convert = async (bytes, options) => {
    calls.push({ ...options, size: bytes.length });
    if (failNext) throw Object.assign(new Error('CONVERT_FAILED'), { status: 502, code: 'CONVERT_FAILED' });
    return odf('text');
  };
  const { base, root } = await setup(t, { convert, findSoffice: () => '/fake/soffice' });
  assert.deepEqual(await (await fetch(base + '/api/office/status')).json(), { soffice: true });
  const etag = (await fetch(base + '/api/docs/f.odt')).headers.get('etag');
  const lease = await claim(base, 'f.odt');
  const headers = { 'If-Match': etag, 'X-Lease': lease, 'X-Document-Format': 'odt', 'X-Content-Loss-Report': v2('odt', { warnings: ['CONVERTED_VIA_LIBREOFFICE'] }) };
  const wrongSource = await put(base, 'f.odt', blankDocx(), { ...headers, 'X-Source-Format': 'xlsx' });
  assert.equal(wrongSource.status, 400);
  assert.equal((await wrongSource.json()).error.code, 'INVALID_SOURCE_FORMAT');
  assert.equal(calls.length, 0);
  failNext = true;
  const failed = await put(base, 'f.odt', blankDocx(), { ...headers, 'X-Source-Format': 'docx' });
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error.code, 'CONVERT_FAILED');
  assert.equal(calls.length, 1);
  failNext = false;
  const ok = await put(base, 'f.odt', blankDocx(), { ...headers, 'X-Source-Format': 'docx' });
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual({ from: calls[1].from, to: calls[1].to }, { from: 'docx', to: 'odt' });
  assert.deepEqual(await readFile(join(root, 'f.odt')), odf('text'));
  // HWP에는 변환 헤더를 쓸 수 없다
  const hwpEtag = (await fetch(base + '/api/docs/e.hwp')).headers.get('etag');
  const hwpLease = await claim(base, 'e.hwp');
  const hwp = await put(base, 'e.hwp', HWP, { 'If-Match': hwpEtag, 'X-Lease': hwpLease, 'X-Document-Format': 'hwp',
    'X-Content-Loss-Report': v1('hwp'), 'X-Source-Format': 'docx' });
  assert.equal(hwp.status, 400);
  assert.equal((await hwp.json()).error.code, 'INVALID_SOURCE_FORMAT');
});

test('new documents: xlsx and docx blanks, unsupported formats rejected, hwp default unchanged', async t => {
  const { base, root } = await setup(t, { findSoffice: () => null });
  assert.deepEqual(await (await fetch(base + '/api/office/status')).json(), { soffice: false });
  const post = body => fetch(base + '/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  const xlsx = await post({ group: { kind: 'default' }, format: 'xlsx' });
  assert.equal(xlsx.status, 201);
  assert.equal((await xlsx.json()).id, '새 문서.xlsx');
  assert.equal((await readFile(join(root, '새 문서.xlsx'))).subarray(0, 4).toString('hex'), '504b0304');
  const second = await post({ group: { kind: 'default' }, format: 'xlsx' });
  assert.equal((await second.json()).id, '새 문서 2.xlsx');
  const docx = await post({ group: { kind: 'project', name: 'proj' }, format: 'docx', name: '회의록' });
  assert.equal(docx.status, 201);
  assert.equal((await docx.json()).id, 'proj/회의록.docx');
  const wrongExt = await post({ group: { kind: 'default' }, format: 'docx', name: '회의록.xlsx' });
  assert.equal(wrongExt.status, 400);
  assert.equal((await wrongExt.json()).error.code, 'INVALID_FORMAT');
  const pptx = await post({ group: { kind: 'default' }, format: 'pptx' });
  assert.equal(pptx.status, 400);
  assert.equal((await pptx.json()).error.code, 'INVALID_FORMAT');
  const noOrigin = await fetch(base + '/api/office/status-post', { method: 'POST' });
  assert.equal(noOrigin.status, 403);
});

test('import accepts office formats and rejects extension swaps', async t => {
  const { base } = await setup(t);
  const upload = (name, bytes) => fetch(base + '/api/projects/proj/docs', { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, body: bytes });
  const ok = await upload('예산.xlsx', blankXlsx());
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).id, 'proj/예산.xlsx');
  const swapped = await upload('가짜.xlsx', blankDocx());
  assert.equal(swapped.status, 400);
  assert.equal((await swapped.json()).error.code, 'INVALID_BYTES');
  const csv = await upload('표.csv', Buffer.from('a,b\n1,2\n'));
  assert.equal(csv.status, 201);
  const txt = await upload('메모.txt', Buffer.from('hi'));
  assert.equal(txt.status, 400);
  assert.equal((await txt.json()).error.code, 'INVALID_FORMAT');
});
