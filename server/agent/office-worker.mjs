// office_exec 코드를 돌리는 워커. hwp_exec 워커(worker.mjs)와 같은 격리: vm 문맥에 office 전역 하나, 문자열 코드 생성 금지.
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { wireError } from './wire-error.mjs';
const names = ['docs', 'open', 'help', 'info', 'sheets', 'read', 'setCells', 'paragraphs', 'find', 'replaceText', 'appendParagraph', 'save'];
const pending = new Map(), inFlight = new Set(), failures = []; let seq = 0; const logs = [];
parentPort.on('message', msg => {
  if (msg.type !== 'reply') return;
  const p = pending.get(msg.id); if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(Object.assign(new Error(msg.error), msg.code ? { code: msg.code } : {},
    msg.details !== undefined ? { details: msg.details } : {})) : p.resolve(msg.value);
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
const office = Object.freeze(Object.fromEntries(names.map(name => [name, (...args) => call(name, args)])));
const consoleView = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error'].map(level =>
  [level, (...args) => { if (logs.length < 100) logs.push('[' + level + '] ' + args.map(String).join(' ').slice(0, 1000)); }])));
try {
  const context = vm.createContext({ office, console: consoleView }, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script('(async () => {\n' + workerData.code + '\n})()', { filename: 'office-agent.js' });
  const value = await script.runInContext(context, { timeout: workerData.timeoutMs });
  const settled = await Promise.allSettled([...inFlight]);
  const failed = settled.find(x => x.status === 'rejected');
  if (failed || failures.length) throw failed?.reason ?? failures[0];
  const serialized = JSON.stringify(value === undefined ? null : value);
  if (Buffer.byteLength(serialized) > 65536) throw new Error('result too large');
  parentPort.postMessage({ type: 'done', out: { ok: true, result: JSON.parse(serialized), logs } });
} catch (error) {
  parentPort.postMessage({ type: 'done', out: { ok: false, ...wireError(error), logs } });
}

