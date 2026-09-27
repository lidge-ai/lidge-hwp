import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, STUDIO_SW_KILL_SWITCH } from '../server/index.mjs';
const git = promisify(execFile);

test('studio service worker is replaced by a self-unregistering script and registerSW is inert', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lidge-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = join(root, 'docs'); const build = join(root, 'build');
  await mkdir(docs); await mkdir(join(build, 'studio'), { recursive: true });
  await writeFile(join(build, 'studio', 'sw.js'), 'precache old studio');
  await writeFile(join(build, 'studio', 'registerSW.js'), "navigator.serviceWorker.register('/studio/sw.js')");
  await writeFile(join(build, 'studio', 'index.html'), '<!doctype html>');
  await git('git', ['-C', docs, 'init', '-q']);
  const server = await createServer({ docsRoot: docs, stateDir: join(root, 'state'), buildDir: build, startAgentSocket: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const sw = await fetch(base + '/studio/sw.js');
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get('cache-control'), 'no-store');
  const body = await sw.text();
  assert.equal(body, STUDIO_SW_KILL_SWITCH);
  assert.match(body, /registration\.unregister\(\)/);
  assert.match(body, /caches\.delete/);
  const reg = await (await fetch(base + '/studio/registerSW.js')).text();
  assert.doesNotMatch(reg, /register\(/);
  const index = await fetch(base + '/studio/');
  assert.equal(index.headers.get('cache-control'), 'no-cache');
});

test('사이드바 토글·구분선 마크업과 접힘 CSS·저장 키가 셸에 있다 (wp5)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lidge-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = join(root, 'docs');
  await mkdir(docs);
  await git('git', ['-C', docs, 'init', '-q']);
  const server = await createServer({ docsRoot: docs, stateDir: join(root, 'state'),
    buildDir: join(root, 'build'), startAgentSocket: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const html = await (await fetch(base + '/')).text();
  assert.doesNotMatch(html.split('<aside')[0], /sidebar-toggle/); // 토글은 헤더가 아니라 사이드바 안에 있다
  assert.match(html, /<button id="sidebar-toggle" type="button" aria-controls="doc-list" aria-expanded="true"/);
  assert.match(html, /<aside id="doc-list" aria-label="문서 목록">/);
  assert.match(html, /id="sidebar-resizer" role="separator" aria-orientation="vertical" aria-controls="doc-list"/);
  assert.match(html, /id="doc-filter" type="search" placeholder="문서 찾기"/);
  assert.match(html, /id="folder-add" type="button"/);
  assert.match(html, /id="external-docs" aria-label="추가한 폴더"/);
  const sidebar = await (await fetch(base + '/sidebar.mjs')).text();
  assert.match(sidebar, /'lidge-hwp\.sidebar'/);
  assert.match(sidebar, /'lidge-hwp\.sidebar-width'/);
  const css = await (await fetch(base + '/style.css')).text();
  assert.match(css, /body\[data-sidebar="collapsed"\] \.layout \{ grid-template-columns: 2\.75rem/);
  assert.match(css, /#external-docs \.group-header\[data-reason\]/);
  // 머리 줄 하나(wp6): 문서 이름·상태·저장이 header에 모이고, 편집 영역은 남은 높이를 flex로 채운다.
  const header = html.split('<header>')[1].split('</header>')[0];
  for (const id of ['filename', 'status', 'save']) assert.match(header, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /class="toolbar"/);
  assert.match(html, /<main id="editor"><div id="studio"><\/div><\/main>/);
  assert.match(css, /body \{ margin: 0; height: 100dvh; display: flex; flex-direction: column/);
  assert.match(css, /#studio \{ flex: 1; min-height: 0; \}/);
  assert.match(css, /#studio > iframe \{ display: block; \}/);
  assert.doesNotMatch(css, /calc\(100dvh/); // 고정 뺄셈 높이가 남지 않는다
  assert.doesNotMatch(css, /h1 \{ display: none/); // 좁은 폭에서도 h1은 접근성 트리에 남는다
});

test('rename controls, F2 handling, and inline focus styles are served', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lidge-rename-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = join(root, 'docs'); await mkdir(docs);
  await git('git', ['-C', docs, 'init', '-q']);
  const server = await createServer({ docsRoot: docs, stateDir: join(root, 'state'), startAgentSocket: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const app = await (await fetch(base + '/app.mjs')).text();
  const shortcuts = await (await fetch(base + '/shell-shortcuts.mjs')).text();
  const projects = await (await fetch(base + '/projects.mjs')).text();
  const css = await (await fetch(base + '/style.css')).text();
  assert.match(app, /window\.addEventListener\('keydown', event => \{/);
  assert.match(app, /shellShortcutDecision\(event\)/);
  assert.match(shortcuts, /event\.code === 'F2'/);
  assert.match(shortcuts, /event\.shiftKey && !event\.altKey/);
  assert.match(app, /candidateId = id\.slice/);
  assert.match(projects, /className = 'doc-rename'/);
  assert.match(projects, /contextmenu/);
  assert.match(css, /\.rename-input:focus-visible/);
});
