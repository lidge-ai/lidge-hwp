import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
import { blankDocx } from '../lib/office/blank.mjs';
import { appendParagraph, documentText } from '../lib/office/docx-text.mjs';
import { writeZip, bytesOf } from '../lib/office/zip.mjs';
const run = promisify(execFile);
const odt = () => writeZip(new Map([['mimetype', bytesOf('application/vnd.oasis.opendocument.text')], ['content.xml', bytesOf('<x/>')]]), { compression: false });
const pptx = () => writeZip(new Map([['ppt/presentation.xml', bytesOf('<p/>')]]));


test('pdf view: converted once then cached, safe headers, 422 on failure, 413 over 32MB', async t => {
  let calls = 0, fail = false;
  const convert = async (bytes, { to }) => { calls += 1; if (fail) throw Object.assign(new Error('CONVERT_FAILED'), { status: 502, code: 'CONVERT_FAILED' }); return to === 'pdf' ? Buffer.from('%PDF-1.7 fake') : bytes; };
  const { base, root } = await setup(t, convert);
  const url = base + '/api/office/pdf/' + encodeURIComponent('proj/sub/발표.pptx');
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'application/pdf');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.match(first.headers.get('content-disposition'), /^inline; .*filename\*=UTF-8''%EB%B0%9C%ED%91%9C\.pdf$/);
  assert.equal((await first.text()).slice(0, 4), '%PDF');
  await fetch(url);
  assert.equal(calls, 1, 'second request hits the pdf cache');
  fail = true;
  const failed = await fetch(base + '/api/office/pdf/' + encodeURIComponent('원고.docx'));
  assert.equal(failed.status, 422);
  assert.equal((await failed.json()).error.code, 'UNSUPPORTED_SOURCE');
  fail = false;
  await writeFile(join(root, '큰.pptx'), Buffer.concat([pptx(), Buffer.alloc(33 * 1024 * 1024)]));
  const big = await fetch(base + '/api/office/pdf/' + encodeURIComponent('큰.pptx'));
  assert.equal(big.status, 413);
});

async function setup(t, convert) {
  const root = await mkdtemp(join(tmpdir(), 'jongi-copy-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'jongi-copy-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(join(root, 'proj', 'sub'), { recursive: true });
  await writeFile(join(root, 'proj', '보고서.odt'), odt());
  await writeFile(join(root, 'proj', 'sub', '발표.pptx'), pptx());
  await writeFile(join(root, '원고.docx'), appendParagraph(blankDocx(), '원본 문단'));
  await writeFile(join(root, '옛날.pages'), writeZip(new Map([['index.xml', bytesOf('<sl:document/>')]])));
  await run('git', ['-C', root, 'init', '-q']);
  const server = await createServer({ docsRoot: root, stateDir, startAgentSocket: null, office: { convert } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { root, base: 'http://127.0.0.1:' + server.address().port };
}

test('editable: docx passes through, odt converts once then hits the cache, failure is 422', async t => {
  const calls = [];
  let fail = false;
  const convert = async (bytes, options) => {
    calls.push(options);
    if (fail) throw Object.assign(new Error('CONVERT_FAILED'), { status: 502, code: 'CONVERT_FAILED' });
    return appendParagraph(blankDocx(), '변환된 ' + options.from);
  };
  const { base } = await setup(t, convert);
  const docx = await fetch(base + '/api/office/editable/' + encodeURIComponent('원고.docx'));
  assert.equal(docx.status, 200);
  assert.equal(docx.headers.get('x-editable-format'), 'docx');
  assert.match(documentText(Buffer.from(await docx.arrayBuffer())), /원본 문단/);
  assert.equal(calls.length, 0);
  const first = await fetch(base + '/api/office/editable/' + encodeURIComponent('proj/보고서.odt'));
  assert.equal(first.status, 200);
  assert.match(documentText(Buffer.from(await first.arrayBuffer())), /변환된 odt/);
  const second = await fetch(base + '/api/office/editable/' + encodeURIComponent('proj/보고서.odt'));
  assert.equal(second.status, 200);
  assert.equal(calls.length, 1, 'second request is served from the cache');
  fail = true;
  const pages = await fetch(base + '/api/office/editable/' + encodeURIComponent('옛날.pages'));
  assert.equal(pages.status, 422);
  assert.equal((await pages.json()).error.code, 'UNSUPPORTED_SOURCE');
  const xlsx = await fetch(base + '/api/office/editable/' + encodeURIComponent('proj/sub/발표.pptx'));
  assert.equal(xlsx.status, 400);
  assert.equal((await fetch(base + '/api/office/editable/%E0%A4%A')).status, 400);
});

test('copy: editor bytes become a sibling docx; server conversion makes a pptx→odp copy at the project root', async t => {
  const convert = async (bytes, { from, to }) => to === 'odp'
    ? writeZip(new Map([['mimetype', bytesOf('application/vnd.oasis.opendocument.presentation')]]), { compression: false })
    : appendParagraph(blankDocx(), from);
  const { base, root } = await setup(t, convert);
  const post = (id, target, body = new Uint8Array(0), origin = base) => fetch(base + '/api/office/copy', { method: 'POST', body,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Doc-Id': encodeURIComponent(id), 'X-Target-Format': target, ...(origin ? { Origin: origin } : {}) } });
  const edited = appendParagraph(blankDocx(), '편집한 내용');
  const fromEditor = await post('옛날.pages', 'docx', edited);
  assert.equal(fromEditor.status, 201);
  const made = await fromEditor.json();
  assert.equal(made.id, '옛날.docx');
  assert.equal(made.source, 'editor');
  assert.match(documentText(await readFile(join(root, '옛날.docx'))), /편집한 내용/);
  const again = await post('옛날.pages', 'docx', edited);
  assert.equal((await again.json()).id, '옛날 (2).docx');
  const converted = await post('proj/sub/발표.pptx', 'odp');
  assert.equal(converted.status, 201);
  assert.equal((await converted.json()).id, 'proj/발표.odp');
  assert.ok((await readdir(join(root, 'proj'))).includes('발표.odp'));
  const same = await post('proj/sub/발표.pptx', 'pptx');
  assert.equal((await same.json()).error.code, 'SAME_FORMAT');
  const bad = await post('원고.docx', 'docx', Buffer.from('not docx'));
  assert.equal((await bad.json()).error.code, 'INVALID_BYTES');
  const pdf = await post('원고.docx', 'pdf');
  assert.equal((await pdf.json()).error.code, 'INVALID_FORMAT');
  assert.equal((await post('원고.docx', 'odt', new Uint8Array(0), null)).status, 403); // Origin 필요
  assert.equal((await post('없음.docx', 'odt')).status, 404);
});
