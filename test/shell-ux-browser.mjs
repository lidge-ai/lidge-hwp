import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { withBrowser, until, idSelector, expect as assert } from './browser-shell-helper.mjs';

const shots = '/tmp/wp16-shots';
await mkdir(shots, { recursive: true });
await withBrowser({ files: ['P/a.hwp'] }, async ({ cdp, server, scratch }) => {
  await until(() => cdp.eval(`return document.body.dataset.studioReady === 'true';`));
  await cdp.shot(join(shots, 'after-empty.png'));
  const initial = await cdp.eval(`return { shell: document.body.dataset.shellState,
    message: document.querySelector('#shell-message').textContent,
    iframeTitle: document.querySelector('#studio iframe').title,
    inert: document.querySelector('#studio iframe').inert,
    shortcuts: [document.querySelector('#new-doc').getAttribute('aria-keyshortcuts'),
      document.querySelector('#copy-path').getAttribute('aria-keyshortcuts'),
      document.querySelector('.doc').getAttribute('aria-keyshortcuts')] };`);
  assert.equal(initial.shell, 'empty');
  assert.match(initial.message, /목록에서 문서를 선택/);
  assert.equal(initial.iframeTitle, '한글 문서 편집기');
  assert.equal(initial.inert, true);
  assert.deepEqual(initial.shortcuts, ['Alt+Meta+N Meta+N', 'Meta+Shift+C', 'F2 Meta+Shift+R']);
  console.log('PASS empty panel, inert iframe, title and keyboard hints');

  const focus = await cdp.eval(`const input = document.querySelector('#doc-filter'); input.focus();
    return getComputedStyle(input.closest('.filter')).outlineStyle;`);
  assert.notEqual(focus, 'none');
  const sizes = await cdp.eval(`const rect = id => { const r = document.querySelector(id).getBoundingClientRect(); return [r.width, r.height]; };
    return { project: rect('#project-add'), resize: rect('#sidebar-resizer') };`);
  assert.ok(sizes.project[0] >= 24 && sizes.project[1] >= 24);
  assert.ok(sizes.resize[0] >= 16);
  console.log('PASS visible search focus and desktop target sizes');

  await cdp.eval(`const input = document.querySelector('#doc-filter'); input.value = '없는 문서';
    input.dispatchEvent(new Event('input', { bubbles: true }));`);
  await until(() => cdp.eval(`return document.querySelector('#status').textContent === '일치하는 문서가 없습니다';`));
  assert.equal(await cdp.eval(`return [...document.querySelectorAll('#docs .empty, #external-docs .empty, #search-feedback')]
    .filter(el => el.textContent.includes('일치하는 문서가 없습니다')).length;`), 1);
  await cdp.eval(`document.querySelector('#search-feedback button').click();`);
  assert.equal(await cdp.eval(`return document.querySelector('#doc-filter').value;`), '');
  console.log('PASS one search-empty result, clear action and debounced status');

  await cdp.eval(`window.__realFetch = window.fetch; window.__failList = true;
    window.fetch = (url, options) => { if (String(url) === '/api/docs' && window.__failList) {
      window.__failList = false; return Promise.resolve(new Response('{}', { status: 500 })); }
      return window.__realFetch(url, options); };
    document.querySelector('#docs-refresh').click();`);
  await until(() => cdp.eval(`return document.querySelector('#list-feedback').textContent.includes('불러오지 못했습니다');`));
  await cdp.shot(join(shots, 'after-list-error.png'));
  assert.ok(await cdp.eval(`return !!document.querySelector('#list-feedback button');`));
  await cdp.eval(`document.querySelector('#list-feedback button').click();`);
  await until(() => cdp.eval(`return document.querySelector('#list-feedback').textContent === '';`));
  console.log('PASS list failure stays in sidebar and retry reloads it');

  const external = join(scratch, 'unavailable');
  await mkdir(external);
  await server.store.register(external);
  await rename(external, `${external}-moved`);
  await cdp.eval(`document.querySelector('#docs-refresh').click();`);
  await until(() => cdp.eval(`return !!document.querySelector('#external-docs .group-reason');`));
  const unavailable = await cdp.eval(`const reason = document.querySelector('#external-docs .group-reason');
    const parse = color => color.match(/[0-9.]+/g).slice(0,3).map(Number);
    const luminance = color => { const a = parse(color).map(v => v / 255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
      return .2126*a[0]+.7152*a[1]+.0722*a[2]; };
    const fg = luminance(getComputedStyle(reason).color), bg = luminance(getComputedStyle(document.querySelector('aside')).backgroundColor);
    return { text: reason.textContent, hint: document.querySelector('#external-docs .group-unavailable').textContent,
      contrast: (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05) };`);
  assert.match(unavailable.text, /찾을 수 없음/);
  assert.match(unavailable.hint, /폴더에 접근할 수 없습니다/);
  assert.ok(unavailable.contrast >= 4.5);
  console.log('PASS unavailable folder reason and contrast');

  await cdp.eval(`window.__failOpen = true;
    window.fetch = (url, options) => { if (String(url).startsWith('/api/docs/') && window.__failOpen) {
      window.__failOpen = false; return Promise.resolve(new Response('{}', { status: 500 })); }
      return window.__realFetch(url, options); };`);
  await cdp.eval(`document.querySelector(${JSON.stringify(idSelector('P/a.hwp'))}).click();`);
  await until(() => cdp.eval(`return document.body.dataset.shellState === 'error';`));
  await cdp.shot(join(shots, 'after-open-error.png'));
  assert.equal(await cdp.eval(`return document.querySelector('#studio iframe').inert;`), true);
  assert.equal(await cdp.eval(`return !document.querySelector('#shell-retry').hidden;`), true);
  await cdp.eval(`document.querySelector('#shell-retry').click();`);
  await until(() => cdp.eval(`return document.body.dataset.shellState === 'open';`));
  await cdp.shot(join(shots, 'after-open.png'));
  console.log('PASS opening failure panel retries the same document');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  const mobile = await cdp.eval(`const status = document.querySelector('#status'); const rect = status.getBoundingClientRect();
    return { width: rect.width, scroll: status.scrollWidth, text: status.textContent,
      project: document.querySelector('#project-add').getBoundingClientRect().width };`);
  assert.ok(mobile.width >= mobile.scroll);
  assert.ok(mobile.width > 100 && mobile.project >= 44);
  await cdp.shot(join(shots, 'after-390.png'));
  console.log('PASS 390px status remains readable and touch target expands');

  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*/editor/index.js'] });
  await cdp.send('Page.reload', { ignoreCache: true });
  await until(() => cdp.eval(`return document.querySelector('#shell-message')?.textContent === '편집기를 시작하지 못했습니다';`));
  assert.ok(await cdp.eval(`return !!document.querySelector(${JSON.stringify(idSelector('P/a.hwp'))})
    && !document.querySelector('#shell-reload').hidden;`));
  await cdp.shot(join(shots, 'after-studio-error.png'));
  console.log('PASS editor module failure still loads list and offers page reload');
});
