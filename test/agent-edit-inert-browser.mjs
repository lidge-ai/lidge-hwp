// AI 편집(저장)이 끝난 뒤 편집기(#studio)가 입력 가능한 상태로 돌아와야 한다.
// justified: cdp.eval is Chrome DevTools Runtime.evaluate in a throwaway headless browser, not JS eval
import assert from 'node:assert/strict';
import net from 'node:net';
import { withBrowser, until, idSelector } from './browser-shell-helper.mjs';
const run = (cdp, src) => cdp.eval(src); // justified: CDP Runtime.evaluate, see header
function runCode(socketPath, code, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socketPath); let output = '';
    connection.once('connect', () => connection.write(JSON.stringify({ id: 'browser', code, timeoutMs }) + '\n'));
    connection.on('data', chunk => { output += chunk; });
    connection.once('end', () => resolve(JSON.parse(output.trim())));
    connection.once('error', reject);
  });
}
const state = cdp => run(cdp, `return { inert: !!document.querySelector('#studio iframe').closest('[inert]'), shell: document.body.dataset.shellState, title: document.querySelector('#filename').title, save: document.querySelector('#save').disabled, status: document.querySelector('#status')?.textContent };`);
await withBrowser({ files: ['x.hwp', 'y.hwp'], agent: true }, async ({ cdp, socketPath }) => {
  await until(() => run(cdp, `return document.body.dataset.studioReady === 'true';`));
  await run(cdp, `document.querySelector(${JSON.stringify(idSelector('x.hwp'))}).click();`);
  await until(() => run(cdp, `return document.querySelector('#filename').title === 'x.hwp';`)); await new Promise(r => setTimeout(r, 1500));
  const opened = await state(cdp);
  console.log('opened', JSON.stringify(opened));
  assert.equal(opened.inert, false, 'editor (or an ancestor) is inert right after opening a document');
  const same = await runCode(socketPath, "const h=await hwp.open('x.hwp'); await hwp.insertText(h,{paragraph:0,text:'같은 문서'}); await hwp.save(h); return 'ok';");
  assert.equal(same.ok, true, JSON.stringify(same));
  await new Promise(r => setTimeout(r, 1500));
  const afterSame = await state(cdp);
  console.log('same-doc', JSON.stringify(afterSame));
  assert.equal(afterSame.inert, false, 'editor stays inert after an AI edit on the open document');
  const other = await runCode(socketPath, "const h=await hwp.open('y.hwp'); await hwp.insertText(h,{paragraph:0,text:'다른 문서'}); await hwp.save(h); return 'ok';");
  assert.equal(other.ok, true, JSON.stringify(other));
  await new Promise(r => setTimeout(r, 1500));
  const afterOther = await state(cdp);
  console.log('follow', JSON.stringify(afterOther));
  assert.equal(afterOther.title, 'y.hwp');
  assert.equal(afterOther.inert, false, 'editor stays inert after a followed AI edit');
  console.log('PASS editor is usable after AI edits (same document and followed document)');
});
