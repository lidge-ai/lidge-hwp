// Run separately: node test/copy-path-browser.mjs. Uses Node's WebSocket and installed Chrome.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'lidge-copy-path-browser-'));
  const docs = join(scratch, 'docs');
  let server, chrome, cdp;
  try {
    await mkdir(docs);
    await git('git', ['-C', docs, 'init', '-q']);
    const bytes = await blankHwp();
    await writeFile(join(docs, 'a.hwp'), bytes);
    await writeFile(join(docs, 'b.hwp'), bytes);
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
    assert.equal(await cdp.eval(`return document.querySelector('#copy-path').disabled;`), true);
    await cdp.eval(`window.__writes = []; window.__clipboard = navigator.clipboard;
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true,
        value: async value => { window.__writes.push(value); } });`);
    await cdp.eval(`document.querySelector('.doc[data-id="a.hwp"]').click();`);
    await until(() => cdp.eval(`return document.querySelector('#filename').title === 'a.hwp'
      && !document.querySelector('#copy-path').disabled;`));
    const shortcut = target => cdp.eval(`${target}.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'C', code: 'KeyC', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));`);
    const pathA = await realpath(join(docs, 'a.hwp'));
    const pathB = await realpath(join(docs, 'b.hwp'));
    await cdp.eval(`document.querySelector('.doc[data-id="b.hwp"]').focus();`);
    await shortcut(`document.querySelector('.doc[data-id="b.hwp"]')`);
    await until(() => cdp.eval(`return window.__writes.at(-1) === ${JSON.stringify(pathB)};`));
    console.log('PASS focused document row shortcut copies that row path');

    await cdp.eval(`document.querySelector('#copy-path').focus();`);
    await shortcut(`document.querySelector('#copy-path')`);
    await until(() => cdp.eval(`return window.__writes.at(-1) === ${JSON.stringify(pathA)};`));
    console.log('PASS no row focus shortcut copies current path');

    await cdp.eval(`window.__writes = []; document.querySelector('#doc-filter').focus();`);
    const searchCopy = await cdp.eval(`const input = document.querySelector('#doc-filter');
      const event = new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', metaKey: true,
        shiftKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event); return event.defaultPrevented;`);
    assert.equal(searchCopy, true);
    await until(() => cdp.eval(`return window.__writes.at(-1) === ${JSON.stringify(pathA)};`));
    assert.match(await cdp.eval(`return document.querySelector('#status').textContent;`), /^경로 복사됨:/);
    console.log('PASS search input Command-Shift-C copies current path and prevents browser default');

    await cdp.eval(`window.__writes = []; document.querySelector('#copy-path').click();`);
    await until(() => cdp.eval(`return window.__writes.at(-1) === ${JSON.stringify(pathA)};`));
    console.log('PASS header button copies current path');

    await cdp.eval(`window.__writes = []; Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true, value: async () => { throw new Error('NotAllowedError'); } });
      document.querySelector('#copy-path').click();`);
    await until(() => cdp.eval(`return document.querySelector('#status').textContent.includes('경로 복사 실패: NotAllowedError');`));
    assert.deepEqual(await cdp.eval(`return window.__writes;`), []);
    console.log('PASS clipboard denial reports failure without a write');

    await cdp.eval(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true,
      value: async value => { window.__writes.push(value); } });
      document.querySelector('.doc[data-id="a.hwp"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));`);
    await until(() => cdp.eval(`return !!document.querySelector('.rename-input');`));
    const renameCopy = await cdp.eval(`const input = document.querySelector('.rename-input');
      const event = new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', metaKey: true,
        shiftKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event); return event.defaultPrevented;`);
    assert.equal(renameCopy, true);
    assert.deepEqual(await cdp.eval(`return window.__writes;`), []);
    console.log('PASS inline rename input ignores shortcut');

    await cdp.eval(`const input = document.querySelector('.rename-input'); input.value = 'renamed';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
    await until(() => cdp.eval(`return document.querySelector('#filename').title === 'renamed.hwp'
      && !document.querySelector('#copy-path').disabled;`));
    await cdp.eval(`document.querySelector('#copy-path').click();`);
    const renamedPath = await realpath(join(docs, 'renamed.hwp'));
    await until(() => cdp.eval(`return window.__writes.at(-1) === ${JSON.stringify(renamedPath)};`));
    console.log('PASS button state and renamed current document path');
    console.log('Browser checks: 7 passed, 0 failed');
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

await main();
