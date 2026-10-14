import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from '../server/index.mjs';
import { rhwpModule, exportWithReport } from '../lib/rhwp-node.mjs';

const git = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check().catch(() => null);
    if (value) return value;
    await delay(100);
  }
  throw new Error('browser condition timed out');
}
export class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.next = 0; this.pending = new Map(); this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.next; this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(source) {
    const result = await this.send('Runtime.evaluate', { expression: `(async () => { ${source} })()`,
      awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async shot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path, Buffer.from(data, 'base64'));
  }
  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener); this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }
  close() { this.socket.close(); }
}
export async function withBrowser({ files = [], roots = [], width = 1440, height = 900,
    intercept = null, agent = false, agentConfig = {}, office = {} } = {}, run) {
  const scratch = await mkdtemp(join(tmpdir(), 'lidge-wp16-browser-'));
  const docs = join(scratch, 'docs');
  let server, chrome, cdp;
  try {
    await mkdir(docs);
    await git('git', ['-C', docs, 'init', '-q']);
    if (files.length) {
      const { HwpDocument } = await rhwpModule();
      const doc = HwpDocument.createEmpty();
      let hwpBytes, hwpxBytes;
      try { doc.createBlankDocument(); hwpBytes = Buffer.from(exportWithReport(doc, 'hwp').bytes);
        if (files.some(file => file.toLowerCase().endsWith('.hwpx')))
          hwpxBytes = Buffer.from(exportWithReport(doc, 'hwpx').bytes); }
      finally { doc.free(); }
      for (const file of files) {
        await mkdir(dirname(join(docs, file)), { recursive: true });
        await writeFile(join(docs, file), file.toLowerCase().endsWith('.hwpx') ? hwpxBytes : hwpBytes);
      }
      await git('git', ['-C', docs, 'add', '.']);
      await git('git', ['-C', docs, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed']);
    }
    const socketPath = join(scratch, 'agent.sock');
    server = await createServer({ docsRoot: docs, stateDir: join(scratch, 'state'), office,
      ...(agent ? { agentConfig: { ...agentConfig, socketPath } } : { startAgentSocket: null }) });
    for (const root of roots) await server.store.register(root);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const profile = join(scratch, 'chrome');
    chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, base], { stdio: 'ignore' });
    const port = await until(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]));
    const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
      .find(row => row.type === 'page' && row.url.startsWith(base))?.webSocketDebuggerUrl);
    cdp = new Cdp(page);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await until(() => cdp.eval(`return !!document.querySelector('#docs') && document.querySelector('#list-feedback').textContent === '';`));
    if (intercept) await intercept({ cdp, base, docs, server });
    await run({ cdp, base, docs, server, scratch, socketPath });
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await Promise.race([once(chrome, 'exit'), delay(3000)]); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(scratch, { recursive: true, force: true });
  }
}
export const key = (name, extra = '') => `new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true, ${extra} })`;
export const idSelector = id => `.doc[data-id=${JSON.stringify(id)}]`;
export const expect = assert;
