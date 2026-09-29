// 슬라이드 미리보기와 사본(실제 LibreOffice). 건너뛰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from '../../server/index.mjs';
import { slidesAs } from '../helpers/slides-fixture.mjs';
import { sniffBytes } from '../../lib/office/sniff.mjs';
const run = promisify(execFile);


test('Korean text survives PDF rendering (fontconfig points at macOS fonts)', async () => {
  const { convert } = await import('../../lib/office/soffice.mjs');
  const pdf = await convert(await slidesAs(['한글 슬라이드 제목'], 'pptx'), { from: 'pptx', to: 'pdf' });
  // 한글 글리프를 가진 글꼴이 임베드돼야 한다(글꼴을 못 찾으면 글자가 통째로 빠진 PDF가 나온다: 실측).
  const fonts = [...new Set(pdf.toString('latin1').match(/BaseFont\/[A-Za-z0-9+_-]*/g) ?? [])];
  assert.ok(fonts.some(name => /ArialUnicode|AppleSDGothic|AppleGothic|AppleMyungjo|NotoSansCJK|Pretendard|Nanum/i.test(name)), 'embedded fonts: ' + fonts.join(', '));
});
test('pptx and odp render to PDF; odp gets a PPTX copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jongi-slides-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'jongi-slides-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(join(root, '발표.pptx'), await slidesAs(['첫 슬라이드', '둘째 슬라이드'], 'pptx'));
  await writeFile(join(root, '초안.odp'), await slidesAs(['ODP 슬라이드'], 'odp'));
  await run('git', ['-C', root, 'init', '-q']);
  const server = await createServer({ docsRoot: root, stateDir, startAgentSocket: null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const id of ['발표.pptx', '초안.odp']) {
    const pdf = await fetch(base + '/api/office/pdf/' + encodeURIComponent(id));
    assert.equal(pdf.status, 200, id);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  }
  const copy = await fetch(base + '/api/office/copy', { method: 'POST', body: new Uint8Array(0), headers: {
    'Content-Type': 'application/octet-stream', Origin: base, 'X-Doc-Id': encodeURIComponent('초안.odp'), 'X-Target-Format': 'pptx' } });
  assert.equal(copy.status, 201);
  assert.equal((await copy.json()).id, '초안.pptx');
  assert.equal(sniffBytes(await readFile(join(root, '초안.pptx')), 'pptx'), true);
});
