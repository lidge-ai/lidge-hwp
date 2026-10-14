// odt·rtf를 docx로 열어 고치고 원래 형식으로 저장하는 전체 흐름(실제 LibreOffice). 건너뛰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from '../../server/index.mjs';
import { convert } from '../../lib/office/soffice.mjs';
import { blankDocx } from '../../lib/office/blank.mjs';
import { appendParagraph, replaceText, documentText } from '../../lib/office/docx-text.mjs';
const run = promisify(execFile);

for (const format of ['odt', 'rtf']) {
  test(format + ': editable docx → edit → PUT X-Source-Format docx → disk stays ' + format + ' with the edit', async t => {
    const root = await mkdtemp(join(tmpdir(), 'jongi-rt-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'jongi-rt-state-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const source = await convert(appendParagraph(blankDocx(), '원래 문장입니다'), { from: 'docx', to: format });
    await writeFile(join(root, '문서.' + format), source);
    await run('git', ['-C', root, 'init', '-q']);
    let conversions = 0;
    const counting = async (bytes, options) => { conversions += 1; return convert(bytes, options); };
    const server = await createServer({ docsRoot: root, stateDir, startAgentSocket: null, office: { convert: counting } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    const id = encodeURIComponent('문서.' + format);
    const etag = (await fetch(base + '/api/docs/' + id)).headers.get('etag');
    const editable = Buffer.from(await (await fetch(base + '/api/office/editable/' + id)).arrayBuffer());
    assert.match(documentText(editable), /원래 문장입니다/);
    await fetch(base + '/api/office/editable/' + id);
    assert.equal(conversions, 1, 'same bytes hit the editable cache');
    const { bytes: edited, count } = replaceText(editable, { find: '원래 문장', replace: '고친 문장' });
    assert.equal(count, 1);
    const lease = (await (await fetch(base + '/api/tabs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId: '문서.' + format }) })).json()).lease;
    const report = Buffer.from(JSON.stringify({ schemaVersion: 2, outputFormat: format, count: 0, losses: [], warnings: ['CONVERTED_VIA_LIBREOFFICE'] })).toString('base64');
    const saved = await fetch(base + '/api/docs/' + id, { method: 'PUT', body: edited, headers: {
      'If-Match': etag, 'X-Lease': lease, 'X-Document-Format': format, 'X-Source-Format': 'docx', 'X-Content-Loss-Report': report } });
    assert.equal(saved.status, 200, await saved.clone().text());
    const onDisk = await readFile(join(root, '문서.' + format));
    if (format === 'rtf') assert.equal(onDisk.subarray(0, 5).toString(), '{\\rtf');
    const back = await convert(onDisk, { from: format, to: 'docx' });
    assert.match(documentText(back), /고친 문장입니다/);
    const { stdout } = await run('git', ['-C', root, 'log', '-1', '--format=%s']);
    assert.equal(stdout.trim(), 'Edit 문서.' + format + ' [human]');
  });
}

