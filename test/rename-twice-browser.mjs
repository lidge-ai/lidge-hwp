// 이름을 바꾼 직후 같은 문서를 다시 바꾸거나 저장할 수 있어야 한다(옛 SSE onerror가 새 문서의 Save를 잠그던 문제).
// justified: cdp.eval is Chrome DevTools Runtime.evaluate in a throwaway headless browser, not JS eval
import { withBrowser, until, key, idSelector, expect as assert } from './browser-shell-helper.mjs';
const run = (cdp, src) => cdp.eval(src); // justified: CDP Runtime.evaluate, see header
await withBrowser({ files: ['P/a.hwp'] }, async ({ cdp }) => {
  await until(() => run(cdp, `return document.body.dataset.studioReady === 'true';`));
  await run(cdp, `window.__log = []; const f = window.fetch; window.fetch = async (u, o) => { const r = await f(u, o);
    if (String(u).endsWith('/rename')) window.__log.push([String(u), r.status]); return r; };`);
  const rename = async (id, name) => {
    await run(cdp, `document.querySelector(${JSON.stringify(idSelector(id))}).click();`);
    await until(() => run(cdp, `return document.querySelector('#filename').title === ${JSON.stringify(id)};`));
    await until(() => run(cdp, `return document.querySelector('#save').disabled === false;`));
    await run(cdp, `document.querySelector(${JSON.stringify(idSelector(id))}).focus(); document.dispatchEvent(${key('F2', "code: 'F2'")});`);
    await until(() => run(cdp, `return !!document.querySelector('.rename-input');`));
    await run(cdp, `const input = document.querySelector('.rename-input'); input.value = ${JSON.stringify(name)};
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
    await until(() => run(cdp, `return !document.querySelector('.rename-input') && document.querySelector('#filename').title.endsWith(${JSON.stringify('/' + name + '.hwp')});`), 15000);
  };
  await rename('P/a.hwp', 'c');
  await until(() => run(cdp, `return document.querySelector('#save').disabled === false;`), 5000);
  console.log('PASS Save stays available after a rename');
  await rename('P/c.hwp', 'a');
  assert.deepEqual(await run(cdp, `return window.__log.map(x => x[1]);`), [200, 200]);
  console.log('PASS renaming the same document back right away succeeds');
});
