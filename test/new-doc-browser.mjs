// Run separately: node test/new-doc-browser.mjs. Uses Node WebSocket and installed Chrome.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';

const git = promisify(execFile);
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await action(); if (result) return result; }
    catch (error) { last = error; }
    await delay(100);
  }
  throw last ?? new Error('browser condition timed out');
}
class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.next = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(source) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${source} })()`, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': '
      + (result.exceptionDetails.exception?.description || ''));
    return result.result.value;
  }
  close() { this.socket.close(); }
}

const key = (keyName, extra = '') => `new KeyboardEvent('keydown', { key: ${JSON.stringify(keyName)},
  bubbles: true, cancelable: true, ${extra} })`;
const status = () => `return document.querySelector('#status').textContent;`;
const inlineState = () => `return { row: !!document.querySelector('.new-doc-row'),
  input: document.querySelector('.new-doc-row input')?.value ?? null,
  focused: document.activeElement === document.querySelector('.new-doc-row input'),
  buttonFocused: document.activeElement === document.querySelector('#new-doc') };`;

async function main() {
  const userState = join(homedir(), '.lidge-hwp');
  const userEntriesBefore = await readdir(userState).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const scratch = await mkdtemp(join(tmpdir(), 'lidge-new-doc-browser-'));
  const docs = join(scratch, 'docs');
  let server, chrome, cdp;
  try {
    await mkdir(docs);
    await mkdir(join(docs, 'P'));
    await git('git', ['-C', docs, 'init', '-q']);
    server = await createServer({ docsRoot: docs, stateDir: join(scratch, 'state'), startAgentSocket: null });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const profile = join(scratch, 'chrome');
    chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, base], { stdio: 'ignore' });
    const port = await until(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]));
    const page = await until(async () => {
      const rows = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return rows.find(row => row.type === 'page' && row.url.startsWith(base))?.webSocketDebuggerUrl;
    });
    cdp = new Cdp(page);
    await cdp.send('Runtime.enable');
    await until(() => cdp.eval(`return !!document.querySelector('.group-header[data-group="P"]');`));
    await cdp.eval(`window.__realFetch = window.fetch; window.__posts = 0;
      window.fetch = (url, options) => {
        if (String(url) === '/api/docs' && options?.method === 'POST') window.__posts++;
        return window.__realFetch(url, options);
      };`);
    const openInput = async () => {
      await cdp.eval(`document.querySelector('#new-doc').click();`);
      await until(() => cdp.eval(`return !!document.querySelector('.new-doc-row input');`));
    };
    const submit = (name = '') => cdp.eval(`const input = document.querySelector('.new-doc-row input');
      input.value = ${JSON.stringify(name)};
      input.dispatchEvent(${key('Enter')});`);
    const shortcut = () => cdp.eval(`document.querySelector('#new-doc').dispatchEvent(${key('Dead', "code: 'KeyN', altKey: true, metaKey: true")});`);
    const opened = id => cdp.eval(`return document.querySelector('#filename').title === ${JSON.stringify(id)}
      && !document.querySelector('.new-doc-row')
      && document.querySelector('#status').textContent.startsWith('새 문서 ');`);
    const postCount = () => cdp.eval(`return window.__posts;`);

    await openInput();
    await submit();
    await until(() => opened('새 문서.hwp'));
    assert.match(await statusFrom(cdp), /^새 문서 새 문서\.hwp · 커밋 [0-9a-f]{7}$/);
    assert.ok((await readFile(join(docs, '새 문서.hwp'))).length > 8);
    console.log('PASS button creates and opens a blank root HWP');

    await cdp.eval(`document.querySelector('.group-header[data-group="P"]').focus();`);
    await openInput();
    await submit('그룹.hwp');
    await until(() => opened('P/그룹.hwp'));
    assert.match(await statusFrom(cdp), /^새 문서 P\/그룹\.hwp · 커밋 [0-9a-f]{7}$/);
    console.log('PASS focused group takes precedence');

    await openInput();
    await submit('현재.hwp');
    await until(() => opened('P/현재.hwp'));
    assert.match(await statusFrom(cdp), /^새 문서 P\/현재\.hwp · 커밋 [0-9a-f]{7}$/);
    console.log('PASS current document group is the fallback');

    const beforeShortcut = await postCount();
    await shortcut();
    await until(() => opened('P/새 문서.hwp'));
    assert.equal(await postCount(), beforeShortcut + 1);
    assert.match(await statusFrom(cdp), /^새 문서 P\/새 문서\.hwp · 커밋 [0-9a-f]{7}$/);
    console.log('PASS Option-Command-N dead key creates once');

    await openInput();
    const beforeIme = await postCount();
    const protectedShortcut = await cdp.eval(`const input = document.querySelector('.new-doc-row input');
      const event = ${key('Dead', "code: 'KeyN', altKey: true, metaKey: true")};
      input.dispatchEvent(event); return event.defaultPrevented;`);
    assert.equal(protectedShortcut, true);
    assert.equal(await postCount(), beforeIme);
    assert.equal((await cdp.eval(inlineState())).row, true);
    await cdp.eval(`const input = document.querySelector('.new-doc-row input');
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(${key('Enter', 'isComposing: true')});`);
    assert.equal(await postCount(), beforeIme);
    assert.equal((await cdp.eval(inlineState())).row, true);
    await cdp.eval(`const input = document.querySelector('.new-doc-row input');
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      input.dispatchEvent(${key('Escape')});`);
    assert.deepEqual(await cdp.eval(inlineState()), { row: false, input: null, focused: false, buttonFocused: true });
    assert.equal(await postCount(), beforeIme);
    console.log('PASS IME Enter and Escape cancellation preserve file count and focus');

    await openInput();
    await submit('현재.hwp');
    await until(() => cdp.eval(`return document.querySelector('#status').textContent === '새 문서 실패: DOC_EXISTS';`));
    assert.deepEqual(await cdp.eval(inlineState()), { row: true, input: '현재.hwp', focused: true, buttonFocused: false });
    await cdp.eval(`document.querySelector('.new-doc-row input').dispatchEvent(${key('Escape')});`);
    console.log('PASS duplicate explicit name keeps input and reports DOC_EXISTS');

    await cdp.eval(`window.__release = null;
      window.fetch = (url, options) => {
        if (String(url) === '/api/docs' && options?.method === 'POST') {
          window.__posts++;
          return new Promise(resolve => { window.__release = () => resolve(new Response(
            JSON.stringify({ error: { code: 'DOC_EXISTS' } }), { status: 409 })); });
        }
        return window.__realFetch(url, options);
      };`);
    await openInput();
    await submit('현재.hwp');
    await cdp.eval(`document.querySelector('#docs-refresh').click();`);
    await until(() => cdp.eval(`return !document.querySelector('.new-doc-row');`));
    await cdp.eval(`window.__release();`);
    await until(() => cdp.eval(`return document.querySelector('#status').textContent === '새 문서 실패: DOC_EXISTS';`));
    assert.deepEqual(await cdp.eval(inlineState()), { row: false, input: null, focused: false, buttonFocused: true });
    console.log('PASS detached failed input returns focus to the button');

    await cdp.eval(`window.fetch = (url, options) => {
      if (String(url) === '/api/docs' && options?.method === 'POST') window.__posts++;
      if (String(url) === '/api/docs' && (!options || options.method === 'GET') && window.__failNextList) {
        window.__failNextList = false;
        return Promise.resolve(new Response(JSON.stringify({ error: { code: 'LIST_FAILED' } }), { status: 500 }));
      }
      if (String(url) === '/api/docs' && options?.method === 'POST') window.__failNextList = true;
      return window.__realFetch(url, options);
    };`);
    await openInput();
    await submit('갱신실패.hwp');
    await until(() => cdp.eval(`return document.querySelector('#status').textContent.includes('만들었음 · 목록 갱신/열기 실패');`));
    assert.equal((await cdp.eval(inlineState())).row, false);
    assert.match(await statusFrom(cdp), /^새 문서 P\/갱신실패\.hwp 만들었음 · 목록 갱신\/열기 실패: LIST_FAILED$/);
    assert.ok((await readFile(join(docs, 'P', '갱신실패.hwp'))).length > 8);
    console.log('PASS committed creation survives list refresh failure');

    await cdp.eval(`window.__hold = null; window.__release = null;
      window.fetch = (url, options) => {
        if (String(url) === '/api/docs' && options?.method === 'POST') {
          window.__posts++;
          return new Promise(resolve => { window.__release = () => resolve(window.__realFetch(url, options)); });
        }
        return window.__realFetch(url, options);
      };`);
    await openInput();
    const beforeDoubleEnter = await postCount();
    await cdp.eval(`const input = document.querySelector('.new-doc-row input'); input.value = '두번엔터.hwp';
      input.dispatchEvent(${key('Enter')}); input.dispatchEvent(${key('Enter')});`);
    assert.equal(await postCount(), beforeDoubleEnter + 1);
    await cdp.eval(`window.__release();`);
    await until(() => opened('P/두번엔터.hwp'));
    assert.deepEqual((await readdir(join(docs, 'P'))).filter(name => name === '두번엔터.hwp'), ['두번엔터.hwp']);
    assert.match(await statusFrom(cdp), /^새 문서 P\/두번엔터\.hwp · 커밋 [0-9a-f]{7}$/);
    console.log('PASS double Enter sends one POST');

    const beforeDoubleShortcut = await postCount();
    await cdp.eval(`const button = document.querySelector('#new-doc');
      button.dispatchEvent(${key('Dead', "code: 'KeyN', altKey: true, metaKey: true")});
      button.dispatchEvent(${key('Dead', "code: 'KeyN', altKey: true, metaKey: true")});`);
    assert.equal(await postCount(), beforeDoubleShortcut + 1);
    await cdp.eval(`window.__release();`);
    await until(() => opened('P/새 문서 2.hwp'));
    assert.deepEqual((await readdir(join(docs, 'P'))).filter(name => name === '새 문서 2.hwp'), ['새 문서 2.hwp']);
    assert.match(await statusFrom(cdp), /^새 문서 P\/새 문서 2\.hwp · 커밋 [0-9a-f]{7}$/);
    console.log('PASS double shortcut sends one POST');

    await cdp.eval(`window.fetch = (url, options) => {
      if (String(url) === '/api/docs' && options?.method === 'POST') {
        window.__posts++;
        return window.__realFetch(url, options).then(() => new Response('{invalid', { status: 200 }));
      }
      return window.__realFetch(url, options);
    };`);
    await openInput();
    const beforeUnknown = await postCount();
    await submit('불명확.hwp');
    await until(() => cdp.eval(`return document.querySelector('#status').textContent === '새 문서 결과 확인 불가 · 목록을 확인하세요';`));
    assert.equal((await cdp.eval(inlineState())).row, false);
    assert.equal(await postCount(), beforeUnknown + 1);
    assert.ok((await readFile(join(docs, 'P', '불명확.hwp'))).length > 8);
    assert.equal(await statusFrom(cdp), '새 문서 결과 확인 불가 · 목록을 확인하세요');
    console.log('PASS malformed POST response reports unknown outcome after list refresh');

    assert.deepEqual(await readdir(userState).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), userEntriesBefore);
    console.log('PASS real user state directory entries unchanged');
    console.log('Browser checks: 11 passed, 0 failed');
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill();
      await Promise.race([once(chrome, 'exit'), delay(3000)]);
    }
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(scratch, { recursive: true, force: true });
  }
}
const statusFrom = cdp => cdp.eval(status());
main().catch(error => { console.error(error); process.exitCode = 1; });
