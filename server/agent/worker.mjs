import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { wireError } from './wire-error.mjs';
const names = ['docs','open','help','selectAll','info','text','paragraphs','tables','cells','find','getFormat','styles','snapshot','exportPdf','api',
  'setCell','insertTextInCell','replaceText','setCheckbox','insertText','format','paraFormat','applyStyle',
  'insertParagraph','deleteParagraph','splitParagraph','mergeParagraph','deleteText','deleteRange','replaceAll',
  'createTable','insertRow','insertColumn','deleteRow','deleteColumn','mergeCells','splitCell','save'];
const pending = new Map(), inFlight = new Set(), failures = []; let seq = 0; const logs = [];
parentPort.on('message', msg => {
  if (msg.type !== 'reply') return;
  const p = pending.get(msg.id); if (!p) return;
  pending.delete(msg.id);
  // host 오류의 code·details를 되살린다. 코드가 잡아도 실패로 남고(아래 failures), 최종 out에 그대로 실린다.
  msg.error ? p.reject(Object.assign(new Error(msg.error), msg.code ? { code: msg.code } : {},
    msg.details !== undefined ? { details: msg.details } : {},
    msg.retryable !== undefined ? { retryable: msg.retryable } : {},
    msg.hashes ? { hashes: msg.hashes } : {})) : p.resolve(msg.value);
});
function call(name, args) {
  if (pending.size >= 128) throw new Error('too many host calls');
  const promise = new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'call', id, name, args });
  });
  inFlight.add(promise);
  promise.catch(e => failures.push(e));
  promise.finally(() => inFlight.delete(promise)).catch(() => {});
  return promise;
}
const hwp = Object.freeze(Object.fromEntries(names.map(name => [name, (...args) => call(name, args)])));
const consoleView = Object.freeze(Object.fromEntries(['log','info','warn','error'].map(level =>
  [level, (...args) => {
    if (logs.length < 100) logs.push(`[${level}] ${args.map(String).join(' ').slice(0, 1000)}`);
  }])));
try {
  const context = vm.createContext({ hwp, console: consoleView },
    { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(`(async () => {\n${workerData.code}\n})()`, { filename: 'hwp-agent.js' });
  const value = await script.runInContext(context, { timeout: workerData.timeoutMs });
  const settled = await Promise.allSettled([...inFlight]);
  const failed = settled.find(x => x.status === 'rejected');
  if (failed || failures.length) throw failed?.reason ?? failures[0];
  const serialized = JSON.stringify(value === undefined ? null : value);
  if (Buffer.byteLength(serialized) > 65536) throw new Error('result too large');
  parentPort.postMessage({ type: 'done', out: { ok: true,
    result: JSON.parse(serialized), logs } });
} catch (error) {
  parentPort.postMessage({ type: 'done', out: { ok: false, ...wireError(error), logs } });
}
