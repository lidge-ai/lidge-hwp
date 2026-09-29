// office_exec로 odt 문단을 바꾸면 LibreOffice로 docx에 들렀다 odt로 돌아와 커밋된다(실제 soffice). 건너뛰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../../server/index.mjs';
import { runOfficeAgent } from '../../server/agent/office-runner.mjs';
import { convert } from '../../lib/office/soffice.mjs';
import { blankDocx } from '../../lib/office/blank.mjs';
import { appendParagraph, documentText } from '../../lib/office/docx-text.mjs';
import { sniffBytes } from '../../lib/office/sniff.mjs';
const run = promisify(execFile);

test('office_exec replaceText on an odt keeps the file an odt with the edit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jongi-agent-odt-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'jongi-agent-odt-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(join(root, '보고.odt'), await convert(appendParagraph(blankDocx(), '분기 매출은 10억이다'), { from: 'docx', to: 'odt' }));
  await run('git', ['-C', root, 'init', '-q']);
  const server = await createServer({ docsRoot: root, stateDir, startAgentSocket: null });
  t.after(() => server.close());
  const out = await runOfficeAgent({ code: "const h = await office.open('보고.odt'); const r = await office.replaceText(h, { find: '10억', replace: '12억', expectedCount: 1 }); await office.save(h); return r;", timeoutMs: 60000 },
    { store: server.store, tabs: server.tabs, config: {} });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.saved[0].warnings, ['CONVERTED_VIA_LIBREOFFICE']);
  const disk = await readFile(join(root, '보고.odt'));
  assert.equal(sniffBytes(disk, 'odt'), true);
  assert.match(documentText(await convert(disk, { from: 'odt', to: 'docx' })), /분기 매출은 12억이다/);
});

