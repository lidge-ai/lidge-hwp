// Run separately: node test/rename-browser.mjs. Uses Node's WebSocket and the installed Chrome.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
import { rhwpModule, exportWithReport } from '../lib/rhwp-node.mjs';
import { defaultRenameGitOps } from '../lib/rename.mjs';

const git = promisify(execFile);
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, { timeout = 20000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await action(); if (result) return result; }
    catch (error) { last = error; }
    await delay(interval);
  }
  throw last ?? new Error('browser condition timed out');
}
async function blankHwp() {
  const { HwpDocument } = await rhwpModule();
  const doc = HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    const exported = exportWithReport(doc, 'hwp');
    assert.equal(exported.report.count, 0);
    return Buffer.from(exported.bytes);
  } finally { doc.free(); }
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

const selector = id => `.doc[data-id=${JSON.stringify(id)}]`;
async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'lidge-rename-browser-'));
  const docs = join(scratch, 'docs');
  const parent = '한글'.normalize('NFD');
  let server, chrome, cdp;
  try {
    await mkdir(docs);
    await git('git', ['-C', docs, 'init', '-q']);
    const bytes = await blankHwp();
    for (const id of ['P/a.hwp', 'P/c.hwp', 'P/q.hwp', 'P/r.hwp', `${parent}/a.hwp`]) {
      await mkdir(dirname(join(docs, id)), { recursive: true });
      await writeFile(join(docs, id), bytes);
    }
    await git('git', ['-C', docs, 'add', '.']);
    await git('git', ['-C', docs, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'seed']);
    const extra = join(scratch, 'external');
    await mkdir(extra);
    await writeFile(join(extra, 'e.hwp'), bytes);
    server = await createServer({ docsRoot: docs, stateDir: join(scratch, 'state'), startAgentSocket: null,
      renameOps: { gitOps: { commitRename: async (...args) => {
        if (args[2].endsWith('reject.hwp')) throw new Error('pre-commit failure');
        const commit = await defaultRenameGitOps.commitRename(...args);
        if (args[2].endsWith('quarantine.hwp')) throw new Error('post-commit HEAD unavailable');
        return commit;
      } } } });
    const { key: externalKey } = await server.store.register(extra);
    const externalId = `ext://${externalKey}/e.hwp`;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const profile = join(scratch, 'chrome');
    chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, base], { stdio: 'ignore' });
    const port = await until(async () => {
      const value = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      return Number(value.split('\n')[0]);
    });
    const pages = await until(async () => {
      const rows = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return rows.find(row => row.type === 'page' && row.url.startsWith(base))?.webSocketDebuggerUrl;
    });
    cdp = new Cdp(pages);
    await cdp.send('Runtime.enable');
    await until(() => cdp.eval(`return !!document.querySelector(${JSON.stringify(selector('P/a.hwp'))});`));
    const open = async id => {
      await cdp.eval(`document.querySelector(${JSON.stringify(selector(id))}).click();`);
      await until(() => cdp.eval(`return document.querySelector('#filename').title === ${JSON.stringify(id)}
        && !document.querySelector('#studio iframe').inert;`));
    };
    const buttonRename = async id => {
      await cdp.eval(`document.querySelector(${JSON.stringify(selector(id))}).parentElement.querySelector('.doc-rename').click();`);
      await until(() => cdp.eval(`return !!document.querySelector('.rename-input');`));
    };
    const submit = async value => {
      await cdp.eval(`const input = document.querySelector('.rename-input'); input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
    };
    const state = () => cdp.eval(`return { status: document.querySelector('#status').textContent,
      filename: document.querySelector('#filename').title,
      inert: document.querySelector('#studio iframe').inert,
      noDocument: document.body.hasAttribute('data-no-document'),
      input: document.querySelector('.rename-input')?.value ?? null,
      inputFocused: document.activeElement?.classList.contains('rename-input') ?? false };`);

    await open('P/a.hwp');
    await cdp.eval(`document.querySelector(${JSON.stringify(selector('P/a.hwp'))}).focus();`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
    await until(() => cdp.eval(`return !!document.querySelector('.rename-input');`));
    await cdp.eval(`const input = document.querySelector('.rename-input');
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));`);
    assert.equal((await state()).input, 'a.hwp');
    await cdp.eval(`document.querySelector('.rename-input').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      document.querySelector('.rename-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
    assert.equal((await state()).input, null);
    console.log('PASS F2, IME Enter, Escape');

    await cdp.eval(`document.querySelector(${JSON.stringify(selector('P/a.hwp'))}).parentElement.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));`);
    await until(() => cdp.eval(`return !!document.querySelector('.rename-input');`));
    await cdp.eval(`window.__realFetch = window.fetch; window.fetch = (url, options) => String(url).endsWith('/rename')
      ? Promise.resolve(new Response(JSON.stringify({ error: { code: 'NAME_COLLISION' } }), { status: 409,
        headers: { 'Content-Type': 'application/json' } })) : window.__realFetch(url, options);`);
    await submit('b.hwp');
    await until(async () => (await state()).status.includes('NAME_COLLISION'));
    assert.deepEqual({ input: (await state()).input, focused: (await state()).inputFocused, inert: (await state()).inert },
      { input: 'b.hwp', focused: true, inert: false });
    await cdp.eval('window.fetch = window.__realFetch;');
    console.log('PASS context menu and HTTP 409 keeps input, focus, lease');

    await submit('b.hwp');
    await until(async () => (await state()).status.includes('P/a.hwp → P/b.hwp · 커밋'));
    console.log('PASS successful rename and reopen');

    await cdp.eval(`const filter = document.querySelector('#doc-filter'); filter.value = 'no-match';
      filter.dispatchEvent(new Event('input', { bubbles: true }));`);
    await cdp.eval(`document.querySelector('#doc-filter').blur();`);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));`);
    await until(() => cdp.eval(`return !!document.querySelector('.rename-input');`));
    assert.equal(await cdp.eval(`return document.querySelector('#doc-filter').value;`), '');
    await cdp.eval(`document.querySelector('.rename-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
    console.log('PASS F2 reveals filtered document');

    await cdp.eval(`document.querySelector('.group-header[data-group="P"]').click();`);
    assert.equal(await cdp.eval(`return document.querySelector('.group-header[data-group="P"]').closest('li').querySelector('.group-docs').hidden;`), true);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));`);
    await until(() => cdp.eval(`return !!document.querySelector('.rename-input');`));
    assert.equal(await cdp.eval(`return document.querySelector('.group-header[data-group="P"]').closest('li').querySelector('.group-docs').hidden;`), false);
    await cdp.eval(`document.querySelector('.rename-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
    console.log('PASS F2 reveals collapsed group');

    await buttonRename('P/b.hwp');
    await cdp.eval(`window.__editorModule = await import('/editor/index.js');
      window.__originalState = window.__editorModule.RhwpEditor.prototype.getDocumentState;
      window.__editorModule.RhwpEditor.prototype.getDocumentState = async () => ({ dirty: true });
      window.__originalConfirm = window.confirm; window.confirm = () => false;`);
    await submit('cancelled.hwp');
    await delay(150);
    assert.equal((await state()).input, 'cancelled.hwp');
    assert.equal((await state()).inert, false);
    assert.equal((await state()).filename, 'P/b.hwp');
    await cdp.eval(`window.__editorModule.RhwpEditor.prototype.getDocumentState = window.__originalState;
      window.confirm = window.__originalConfirm;
      document.querySelector('.rename-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
    console.log('PASS dirty cancel retains old editable tab');

    await open(externalId);
    await buttonRename(externalId);
    await submit('f.hwp');
    await until(async () => (await state()).filename === `ext://${externalKey}/f.hwp`
      && (await state()).status.includes('· 커밋'));
    console.log('PASS external list rename button');

    await open('P/c.hwp');
    await buttonRename('P/c.hwp');
    await cdp.eval(`window.fetch = async (url, options) => { const response = await window.__realFetch(url, options);
      if (String(url).endsWith('/rename')) throw new TypeError('network lost after commit'); return response; };`);
    await submit('새이름.hwp'.normalize('NFD'));
    await until(async () => (await state()).status.includes('P/새이름.hwp · 이름 변경 완료')
      && !(await state()).inert);
    await cdp.eval('window.fetch = window.__realFetch;');
    console.log('PASS lost response reconciles NFC candidate and reopens');

    await open(`${parent}/a.hwp`);
    await buttonRename(`${parent}/a.hwp`);
    await cdp.eval(`window.fetch = async (url, options) => { const response = await window.__realFetch(url, options);
      if (String(url).endsWith('/rename')) throw new TypeError('network lost after commit'); return response; };`);
    await submit('새이름.hwp'.normalize('NFD'));
    const nfdTarget = `${parent}/새이름.hwp`;
    await until(async () => (await state()).status.includes(`${nfdTarget} · 이름 변경 완료`)
      && !(await state()).inert);
    await cdp.eval('window.fetch = window.__realFetch;');
    console.log('PASS NFD parent preserved in lost-response reconciliation');

    await open('P/r.hwp');
    await buttonRename('P/r.hwp');
    await submit('reject.hwp');
    await until(async () => (await state()).status.includes('이름 변경되지 않음 · 다시 열림'));
    assert.equal((await state()).filename, 'P/r.hwp');
    assert.equal((await state()).inert, false);
    console.log('PASS HTTP 500 before commit reconciles to old id with a new lease');

    await open('P/q.hwp');
    await buttonRename('P/q.hwp');
    await submit('quarantine.hwp');
    await until(async () => (await state()).status.includes('격리됨 · 수동 복구가 필요합니다'));
    assert.equal((await state()).status, 'P/quarantine.hwp 격리됨 · 수동 복구가 필요합니다');
    assert.equal((await state()).inert, true);
    assert.equal((await state()).noDocument, true);
    console.log('PASS HTTP 500 reconciles to quarantined id and leaves editor inert');
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

main().catch(error => { console.error(error); process.exitCode = 1; });
