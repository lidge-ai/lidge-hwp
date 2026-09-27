// Run separately after build:studio: node test/tab-follow-browser.mjs.
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withBrowser, until } from './browser-shell-helper.mjs';

const git = promisify(execFile);
function runCode(socketPath, code, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socketPath);
    let output = '';
    connection.once('connect', () => connection.write(JSON.stringify({ id: 'browser', code, timeoutMs }) + '\n'));
    connection.on('data', chunk => { output += chunk; });
    connection.once('end', () => resolve(JSON.parse(output.trim())));
    connection.once('error', reject);
  });
}
const head = async docs => (await git('git', ['-C', docs, 'rev-parse', 'HEAD'])).stdout.trim();

await withBrowser({ files: ['x.hwp', 'y.hwp', 'z.hwp'], agent: true,
  agentConfig: { applyDeadlineMs: 300, releaseDeadlineMs: 3000 } }, async ({ cdp, docs, socketPath }) => {
  const shell = () => cdp.eval(`return { id: document.querySelector('#filename').title,
    status: document.querySelector('#status').textContent,
    y: document.querySelector('.doc[data-id="y.hwp"]')?.getAttribute('aria-current'),
    inert: document.querySelector('#studio')?.inert };`);
  await until(() => cdp.eval(`return !!document.querySelector('.doc[data-id="y.hwp"]')`));
  await cdp.eval(`document.querySelector('.doc[data-id="y.hwp"]').click()`);
  await until(async () => (await shell()).id === 'y.hwp');
  const initial = await head(docs);

  const read = await runCode(socketPath, "const h=await hwp.open('x.hwp'); return await hwp.tables(h)");
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.follow, undefined);
  assert.equal((await shell()).id, 'y.hwp');
  assert.equal(await head(docs), initial);
  console.log('PASS B1 read-only open keeps y tab');

  await cdp.eval(`window.__heldPrepares = [];
    window.__originalFollowListener = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function(type, listener, options) {
      if (type === 'agent.prepare') return window.__originalFollowListener.call(this, type, event => {
        window.__heldPrepares.push(() => listener.call(this, event));
      }, options);
      return window.__originalFollowListener.call(this, type, listener, options);
    };`);
  const unsaved = runCode(socketPath,
    "const h=await hwp.open('x.hwp'); await hwp.format(h,{paragraph:0,start:0,end:0},{bold:true}); await hwp.save(h)");
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'x.hwp' && window.__heldPrepares.length === 1`));
  assert.equal(await cdp.eval(`return document.querySelector('#studio iframe').inert`), true);
  assert.equal(await cdp.eval(`return document.querySelector('#save').disabled`), true);
  console.log('PASS B2a followed tab stays inert until prepare');
  await cdp.eval(`window.__heldPrepares.shift()(); EventSource.prototype.addEventListener = window.__originalFollowListener`);
  const unsavedResult = await unsaved;
  assert.equal(unsavedResult.ok, false, JSON.stringify(unsavedResult));
  assert.equal(unsavedResult.error, 'save requires an edit');
  assert.equal(unsavedResult.follow.completion, 'none');
  await until(async () => (await shell()).id === 'y.hwp');
  const restored = await shell();
  assert.equal(restored.y, 'true');
  assert.equal(restored.status, 'y.hwp로 돌아옴 · AI 작업은 저장 없이 끝남(save requires an edit)');
  assert.equal(await head(docs), initial);
  console.log('PASS B2 unsaved edit restores y with final status');

  const disk = await runCode(socketPath,
    "const h=await hwp.open('x.hwp',{follow:false}); await hwp.insertText(h,{paragraph:0,text:'saved'}); await hwp.save(h)");
  assert.equal(disk.ok, true, JSON.stringify(disk));
  assert.equal(disk.saved.length, 1);
  assert.equal((await shell()).id, 'y.hwp');
  assert.notEqual(await head(docs), initial);
  console.log('PASS B5 follow:false commits with y tab unchanged');

  await cdp.eval(`document.querySelector('#studio iframe').contentDocument.querySelector('[data-rhwp-editor-input="true"]').focus()`);
  await cdp.send('Input.insertText', { text: 'caret sample' });
  await cdp.eval(`document.querySelector('#save').click()`);
  await until(async () => (await shell()).status === '저장됨');
  await cdp.eval(`window.__beforeFollowReload = true`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await until(() => cdp.eval(`return !window.__beforeFollowReload && document.querySelector('#list-feedback')?.textContent === ''
    && !!document.querySelector('.doc[data-id="y.hwp"]')`));
  await cdp.eval(`document.querySelector('.doc[data-id="y.hwp"]').click()`);
  await until(async () => (await shell()).id === 'y.hwp');
  await cdp.eval(`document.querySelector('#studio iframe').contentDocument.querySelector('[data-rhwp-editor-input="true"]').focus()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  const reopened = await runCode(socketPath, "const h=await hwp.open('y.hwp'); return await hwp.tables(h)");
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  console.log('PASS B6 first prepare after browser reload');

  const beforeApply = await head(docs);
  let held = false;
  const off = cdp.on('Fetch.requestPaused', event => {
    if (!event.request.url.includes('/api/agent/replies/')) return;
    if (event.request.postData?.includes('"changedCells"')) {
      held = true;
      setTimeout(() => { void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {}); }, 700);
    } else void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/agent/replies/*', requestStage: 'Request' }] });
  const late = await runCode(socketPath,
    "const h=await hwp.open('x.hwp'); await hwp.insertText(h,{paragraph:0,text:'browser committed'}); await hwp.save(h)");
  await cdp.send('Fetch.disable'); off();
  assert.equal(held, true);
  assert.equal(late.ok, false, JSON.stringify(late));
  assert.equal(late.error, 'AGENT_REPLY_TIMEOUT');
  assert.equal(late.follow.completion, 'committed');
  assert.deepEqual(late.saved, []);
  assert.notEqual(await head(docs), beforeApply);
  await until(async () => (await shell()).status.startsWith('AI 편집 저장됨'));
  assert.equal((await shell()).id, 'x.hwp');
  console.log('PASS B3 committed PUT with late apply reply stays on x');

  let unpause;
  const blocked = new Promise(resolve => { unpause = resolve; });
  const offEvents = cdp.on('Fetch.requestPaused', event => {
    if (event.request.url.includes('/api/events?lease=')) unpause(event.requestId);
    else void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/events?lease=*', requestStage: 'Request' }] });
  const connecting = runCode(socketPath,
    "const h=await hwp.open('z.hwp'); await hwp.insertText(h,{paragraph:0,text:'unsaved'})", 8000);
  const requestId = await blocked;
  const notConnected = await connecting;
  assert.equal(notConnected.ok, false, JSON.stringify(notConnected));
  assert.equal(notConnected.error, 'TAB_CONNECTING');
  assert.equal(notConnected.follow.outcome, 'failed');
  assert.equal(notConnected.follow.completion, 'none');
  await cdp.send('Fetch.continueRequest', { requestId });
  await cdp.send('Fetch.disable'); offEvents();
  await until(async () => (await shell()).id === 'x.hwp');
  assert.doesNotMatch((await shell()).status, /대기 중/);
  console.log('PASS B4 delayed SSE receives queued followEnd and restores x');
});

await withBrowser({ files: ['x.hwp', 'y.hwp', 'z.hwp'], agent: true }, async ({ cdp, socketPath }) => {
  const view = () => cdp.eval(`return { id: document.querySelector('#filename').title,
    status: document.querySelector('#status').textContent,
    held: window.__heldFollowEnds?.length ?? 0,
    inert: document.querySelector('#studio iframe')?.inert };`);
  await until(() => cdp.eval(`return !!document.querySelector('.doc[data-id="y.hwp"]')`));
  await cdp.eval(`document.querySelector('.doc[data-id="y.hwp"]').click()`);
  await until(async () => (await view()).id === 'y.hwp');
  await cdp.eval(`window.__heldFollowEnds = [];
    const original = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function(type, listener, options) {
      if (type === 'agent.followEnd') return original.call(this, type, event => {
        window.__heldFollowEnds.push(() => listener.call(this, event));
      }, options);
      return original.call(this, type, listener, options);
    };`);

  const first = await runCode(socketPath,
    "const h=await hwp.open('x.hwp'); await hwp.insertText(h,{paragraph:0,text:'unsaved'})");
  assert.equal(first.follow.completion, 'none');
  await until(async () => (await view()).id === 'x.hwp' && (await view()).held === 1);
  await cdp.eval(`document.querySelector('.doc[data-id="z.hwp"]').click()`);
  await until(async () => (await view()).id === 'z.hwp');
  const humanStatus = (await view()).status;
  await cdp.eval(`window.__heldFollowEnds.shift()()`);
  assert.equal((await view()).id, 'z.hwp');
  assert.equal((await view()).status, humanStatus);
  console.log('PASS B2c human navigation wins over delayed restore');

  const second = await runCode(socketPath,
    "const h=await hwp.open('x.hwp'); await hwp.insertText(h,{paragraph:0,text:'unsaved'})");
  assert.equal(second.follow.completion, 'none');
  await until(async () => (await view()).id === 'x.hwp' && (await view()).held === 1 && (await view()).inert === false);
  await cdp.eval(`document.querySelector('#studio iframe').contentDocument.querySelector('[data-rhwp-editor-input="true"]').focus()`);
  await cdp.send('Input.insertText', { text: 'dirty' });
  await cdp.eval(`window.__heldFollowEnds.shift()()`);
  await until(async () => (await view()).status.includes('돌아가지 못함(DIRTY)'));
  assert.equal((await view()).id, 'x.hwp');
  assert.equal((await view()).status, 'AI 작업이 저장 없이 끝났지만 z.hwp로 돌아가지 못함(DIRTY) · x.hwp에 남습니다');
  console.log('PASS B2b dirty x rejects automatic restore');
});
