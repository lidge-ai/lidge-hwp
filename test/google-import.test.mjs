import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
import { parseGoogleUrl } from '../lib/office/google.mjs';
import { blankXlsx, blankDocx } from '../lib/office/blank.mjs';
const run = promisify(execFile);

const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${ID}/edit`;
const SHEET_EXPORT = `https://docs.google.com/spreadsheets/d/${ID}/export?format=xlsx`;

async function setup(t, fetchImpl) {
  const root = await mkdtemp(join(tmpdir(), 'jongi-google-import-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'jongi-google-import-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await run('git', ['-C', root, 'init', '-q']);
  const server = await createServer({ docsRoot: root, stateDir, startAgentSocket: null, office: { fetchImpl } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { root, base: 'http://127.0.0.1:' + server.address().port };
}

// 가짜 fetch: 진짜 Response(본문 스트림·헤더)에 최종 URL만 덮어 씌운다.
function fakeResponse(url, bytes, { type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', disposition } = {}) {
  const headers = { 'Content-Type': type };
  if (disposition) headers['Content-Disposition'] = disposition;
  const res = new Response(bytes, { status: 200, headers });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

const post = (base, body, origin = base) => fetch(base + '/api/office/import-url', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  body: JSON.stringify(body),
});

test('parseGoogleUrl accepts sheets/docs/slides URLs and rejects the rest', () => {
  const sheetHash = parseGoogleUrl(`${SHEET_URL}#gid=123456`);
  assert.deepEqual(sheetHash, {
    kind: 'sheet', id: ID, gid: '123456',
    exportUrl: `${SHEET_EXPORT}&gid=123456`,
    ext: 'xlsx', defaultName: 'Google 시트.xlsx',
  });
  const sheetQuery = parseGoogleUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing&gid=99`);
  assert.equal(sheetQuery.gid, '99');
  assert.equal(sheetQuery.exportUrl, `${SHEET_EXPORT}&gid=99`);
  const doc = parseGoogleUrl(`https://docs.google.com/document/d/${ID}/edit`);
  assert.deepEqual(doc, {
    kind: 'doc', id: ID, gid: null,
    exportUrl: `https://docs.google.com/document/d/${ID}/export?format=docx`,
    ext: 'docx', defaultName: 'Google 문서.docx',
  });
  const slides = parseGoogleUrl(`https://docs.google.com/presentation/d/${ID}/edit`);
  assert.deepEqual(slides, {
    kind: 'slides', id: ID, gid: null,
    exportUrl: `https://docs.google.com/presentation/d/${ID}/export/pptx`,
    ext: 'pptx', defaultName: 'Google 슬라이드.pptx',
  });
  for (const bad of [
    `http://docs.google.com/spreadsheets/d/${ID}/edit`,
    `https://evil.example/spreadsheets/d/${ID}/edit`,
    'https://docs.google.com/spreadsheets/d/short/edit',
    'https://docs.google.com/document/d/',
  ]) {
    assert.throws(() => parseGoogleUrl(bad),
      cause => cause.status === 400 && cause.code === 'INVALID_URL', bad);
  }
});

test('import-url fetches the sheet export, stores it under the shared name, retries duplicates', async t => {
  const bytes = blankXlsx();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return fakeResponse(SHEET_EXPORT, bytes, { disposition: "filename*=UTF-8''%EC%98%88%EC%82%B0.xlsx" });
  };
  const { base, root } = await setup(t, fetchImpl);
  const res = await post(base, { url: SHEET_URL, group: { kind: 'default' } });
  assert.equal(res.status, 201);
  const doc = await res.json();
  assert.equal(doc.id, '예산.xlsx');
  assert.equal(doc.format, 'xlsx');
  assert.equal(doc.source, 'google');
  assert.match(doc.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await readFile(join(root, '예산.xlsx')), bytes);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SHEET_EXPORT);
  assert.equal(calls[0].options.redirect, 'follow');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  const again = await post(base, { url: SHEET_URL, group: { kind: 'default' } });
  assert.equal(again.status, 201);
  assert.equal((await again.json()).id, '예산 (2).xlsx');
  assert.deepEqual(await readFile(join(root, '예산 (2).xlsx')), bytes);
});

test('import-url maps invalid Google URLs to 400 INVALID_URL', async t => {
  const fetchImpl = async () => fakeResponse(SHEET_EXPORT, blankXlsx());
  const { base } = await setup(t, fetchImpl);
  const res = await post(base, { url: 'https://evil.example/document/d/' + ID, group: { kind: 'default' } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_URL');
});

test('import-url rejects HTML responses as GOOGLE_NOT_SHARED', async t => {
  const fetchImpl = async () => fakeResponse(
    `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(SHEET_EXPORT)}`,
    Buffer.from('<html>sign in</html>'), { type: 'text/html' });
  const { base } = await setup(t, fetchImpl);
  const res = await post(base, { url: SHEET_URL, group: { kind: 'default' } });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'GOOGLE_NOT_SHARED');
});

test('import-url blocks exports redirected outside Google hosts', async t => {
  const fetchImpl = async () => fakeResponse('https://evil.example/x', blankXlsx());
  const { base } = await setup(t, fetchImpl);
  const res = await post(base, { url: SHEET_URL, group: { kind: 'default' } });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'GOOGLE_REDIRECT_BLOCKED');
});

test('import-url sniffs export bytes and rejects kind mismatches', async t => {
  const fetchImpl = async () => fakeResponse(SHEET_EXPORT, blankDocx());
  const { base } = await setup(t, fetchImpl);
  const res = await post(base, { url: SHEET_URL, group: { kind: 'default' } });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'GOOGLE_BAD_BYTES');
});

test('import-url requires the Origin header', async t => {
  const fetchImpl = async () => fakeResponse(SHEET_EXPORT, blankXlsx());
  const { base } = await setup(t, fetchImpl);
  const res = await post(base, { url: SHEET_URL, group: { kind: 'default' } }, null);
  assert.equal(res.status, 403);
});
