// Run separately after build:studio: node test/editor-shortcuts-browser.mjs.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
import { rhwpModule, exportWithReport } from '../lib/rhwp-node.mjs';

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

async function blankHwp() {
  const { HwpDocument } = await rhwpModule();
  const doc = HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    const result = exportWithReport(doc, 'hwp');
    assert.equal(result.report.count, 0);
    return Buffer.from(result.bytes);
  } finally { doc.free(); }
}

async function main() {
  const userState = join(homedir(), '.lidge-hwp');
  const userEntriesBefore = await readdir(userState).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const scratch = await mkdtemp(join(tmpdir(), 'lidge-editor-shortcuts-'));
  const docs = join(scratch, 'docs');
  let server, chrome, cdp;
  try {
    await mkdir(docs);
    await git('git', ['-C', docs, 'init', '-q']);
    await writeFile(join(docs, 'a.hwp'), await blankHwp());
    await git('git', ['-C', docs, 'add', '.']);
    await git('git', ['-C', docs, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'seed']);
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
    await until(() => cdp.eval(`return !!document.querySelector('.doc[data-id="a.hwp"]');`));
    await cdp.eval(`window.__realFetch = window.fetch; window.__posts = 0; window.__puts = 0;
      window.fetch = (url, options) => {
        if (String(url) === '/api/docs' && options?.method === 'POST') window.__posts++;
        if (String(url).startsWith('/api/docs/') && options?.method === 'PUT') window.__puts++;
        return window.__realFetch(url, options);
      };
      window.__writes = [];
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true,
        value: async value => { window.__writes.push(value); } });
      document.querySelector('.doc[data-id="a.hwp"]').click();`);
    await until(() => cdp.eval(`return document.querySelector('#filename').title === 'a.hwp'
      && !!document.querySelector('#studio iframe')?.contentDocument?.querySelector('[data-rhwp-editor-input="true"]');`));
    const frame = `document.querySelector('#studio iframe').contentWindow`;
    const focusEditor = () => cdp.eval(`const input = ${frame}.document.querySelector('[data-rhwp-editor-input="true"]'); input.focus();
      return ${frame}.document.activeElement === input;`);
    const key = (name, code, modifiers = 0, virtualKeyCode = 0) => cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: name, code, modifiers, windowsVirtualKeyCode: virtualKeyCode,
    });
    const state = () => cdp.eval(`return { status: document.querySelector('#status').textContent,
      rename: !!document.querySelector('.rename-input'), posts: window.__posts,
      puts: window.__puts, writes: window.__writes, id: document.querySelector('#filename').title };`);
    const closeRename = () => cdp.eval(`document.querySelector('.rename-input')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);

    assert.equal(await focusEditor(), true);
    await key('F2', 'F2', 0, 113);
    await until(async () => (await state()).rename);
    await closeRename();
    console.log('PASS iframe F2 opens shell rename input');

    assert.equal(await focusEditor(), true);
    await key('R', 'KeyR', 12, 82);
    await until(async () => (await state()).rename);
    await closeRename();
    console.log('PASS iframe Command-Shift-R opens shell rename input');

    assert.equal(await focusEditor(), true);
    await key('C', 'KeyC', 12, 67);
    const expectedPath = await realpath(join(docs, 'a.hwp'));
    await until(async () => (await state()).writes.at(-1) === expectedPath);
    assert.match((await state()).status, /^경로 복사됨:/);
    console.log('PASS iframe Command-Shift-C copies current shell path');

    const beforeFontShortcut = await state();
    const fontShortcut = await cdp.eval(`const input = ${frame}.document.querySelector('#font-size');
      input.focus();
      const event = new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', metaKey: true,
        shiftKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event); return event.defaultPrevented;`);
    assert.equal(fontShortcut, true);
    assert.deepEqual(await state(), beforeFontShortcut);
    console.log('PASS Studio font-size Command-Shift-C prevents browser default without shell action');

    assert.equal(await focusEditor(), true);
    const beforeNew = (await state()).posts;
    await key('n', 'KeyN', 5, 78);
    await until(() => cdp.eval(`return !!document.querySelector('.new-doc-row input');`));
    assert.equal((await state()).posts, beforeNew);
    await cdp.eval(`document.querySelector('.new-doc-row input').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
    await until(async () => (await state()).posts === beforeNew + 1);
    await until(async () => (await state()).id === '새 문서.hwp');
    assert.equal((await state()).status, '새 문서 열림');
    assert.equal((await state()).posts, beforeNew + 1);
    console.log('PASS iframe Option-Command-N creates one new HWP');

    assert.equal(await focusEditor(), true);
    const beforeCommandNew = (await state()).posts;
    await key('n', 'KeyN', 4, 78);
    await until(() => cdp.eval(`return !!document.querySelector('.new-doc-row input');`));
    assert.equal((await state()).posts, beforeCommandNew);
    await cdp.eval(`document.querySelector('.new-doc-row input').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
    await until(async () => (await state()).posts === beforeCommandNew + 1);
    await until(async () => (await state()).id === '새 문서 2.hwp');
    assert.equal((await state()).posts, beforeCommandNew + 1);
    console.log('PASS iframe Command-N creates one new HWP when delivered to the page');

    assert.equal(await focusEditor(), true);
    const beforeIme = await state();
    await cdp.eval(`const input = ${frame}.document.querySelector('[data-rhwp-editor-input="true"]');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'KeyN', metaKey: true,
        altKey: true, isComposing: true, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', code: 'F2',
        isComposing: true, bubbles: true, cancelable: true }));`);
    assert.equal((await state()).posts, beforeIme.posts);
    assert.equal((await state()).rename, false);
    console.log('PASS composing key combinations do not reach shell');

    const beforeFormat = await state();
    const inputHandlerAvailable = await cdp.eval(`return !!${frame}.__inputHandler;`);
    await cdp.eval(`const input = ${frame}.document.querySelector('[data-rhwp-editor-input="true"]');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ç', code: 'KeyC', altKey: true,
        bubbles: true, cancelable: true }));`);
    assert.equal((await state()).posts, beforeFormat.posts);
    assert.equal((await state()).rename, false);
    assert.equal((await state()).writes.length, beforeFormat.writes.length);
    console.log(`PASS iframe Option-C does not invoke shell (input handler exposed: ${inputHandlerAvailable})`);

    assert.equal(await focusEditor(), true);
    await cdp.eval(`const input = ${frame}.document.querySelector('[data-rhwp-editor-input="true"]');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true,
        bubbles: true, cancelable: true }));`);
    await until(() => cdp.eval(`return !!${frame}.document.querySelector('.cp-overlay');`));
    const beforePaletteShortcut = await state();
    const paletteShortcut = await cdp.eval(`const input = ${frame}.document.querySelector('[data-rhwp-editor-input="true"]');
      input.focus();
      const event = new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', metaKey: true,
        shiftKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return { prevented: event.defaultPrevented, paletteOpen: !!${frame}.document.querySelector('.cp-overlay') };`);
    assert.deepEqual(paletteShortcut, { prevented: true, paletteOpen: true });
    assert.deepEqual(await state(), beforePaletteShortcut);
    await cdp.eval(`${frame}.document.querySelector('.cp-input').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));`);
    await until(() => cdp.eval(`return !${frame}.document.querySelector('.cp-overlay');`));
    console.log('PASS Studio command palette Command-Shift-C prevents browser default without shell action');

    assert.equal(await focusEditor(), true);
    const beforeSave = (await state()).puts;
    await cdp.send('Input.insertText', { text: 'x' });
    await key('s', 'KeyS', 4, 83);
    await until(async () => (await state()).puts === beforeSave + 1);
    await until(async () => (await state()).status === '저장됨');
    console.log('PASS iframe Command-S saves once');

    assert.equal(await focusEditor(), true);
    const beforeCtrlSave = (await state()).puts;
    await cdp.send('Input.insertText', { text: 'y' });
    await key('s', 'KeyS', 2, 83);
    await until(async () => (await state()).puts === beforeCtrlSave + 1);
    await until(async () => (await state()).status === '저장됨');
    console.log('PASS iframe Ctrl-S saves once');

    await cdp.eval(`const button = ${frame}.document.querySelector('[data-cmd="insert:bookmark"]'); button.click();`);
    await until(() => cdp.eval(`return !!${frame}.document.querySelector('.modal-overlay input');`));
    const beforeModal = await state();
    await cdp.eval(`const input = ${frame}.document.querySelector('.modal-overlay input'); input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'KeyN', metaKey: true,
        altKey: true, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', code: 'F2',
        bubbles: true, cancelable: true }));`);
    assert.equal((await state()).posts, beforeModal.posts);
    assert.equal((await state()).rename, false);
    console.log('PASS Studio modal keeps its shortcuts');

    assert.deepEqual(await readdir(userState).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), userEntriesBefore);
    console.log('PASS real user state directory entries unchanged');
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

main().catch(error => { console.error(error); process.exitCode = 1; });
