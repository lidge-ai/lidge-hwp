import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withBrowser, until, key, expect as assert } from './browser-shell-helper.mjs';

await withBrowser({ files: ['P/a.hwp'] }, async ({ cdp, docs, server, scratch }) => {
  await until(() => cdp.eval(`return document.body.dataset.studioReady === 'true';`));
  await cdp.eval(`window.__realFetch = window.fetch; window.__posts = 0; window.__lookups = 0;
    window.fetch = (url, options) => { if (String(url) === '/api/docs' && options?.method === 'POST') window.__posts++;
      if (String(url).startsWith('/api/docs/requests/')) window.__lookups++;
      return window.__realFetch(url, options); };`);
  await cdp.eval(`document.querySelector('.group-header[data-group="P"]').focus(); document.querySelector('#new-doc').click();`);
  await until(() => cdp.eval(`return !!document.querySelector('.new-doc-row input');`));
  const draft = await cdp.eval(`const input = document.querySelector('.new-doc-row input');
    return { value: input.value, selected: input.value.slice(input.selectionStart, input.selectionEnd),
      suffix: input.nextSibling.textContent, posts: window.__posts, parent: input.closest('.group')?.querySelector('.group-header')?.dataset.group };`);
  assert.deepEqual(draft, { value: '새 문서', selected: '새 문서', suffix: '.hwp', posts: 0, parent: 'P' });
  await mkdir('/tmp/wp16-shots', { recursive: true });
  await cdp.shot('/tmp/wp16-shots/after-new-draft.png');
  console.log('PASS new draft stays inside selected group and selects base only');
  await cdp.eval(`document.querySelector('.new-doc-row input').dispatchEvent(${key('Escape')});`);
  assert.equal(await cdp.eval(`return !!document.querySelector('.new-doc-row');`), false);

  await cdp.eval(`document.querySelector('.doc[data-id="P/a.hwp"]').click();`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/a.hwp';`));
  await cdp.eval(`document.querySelector('.doc[data-id="P/a.hwp"]').focus();
    document.dispatchEvent(${key('F2', "code: 'F2'")});`);
  await until(() => cdp.eval(`return !!document.querySelector('.rename-input');`));
  await cdp.eval(`const button = document.querySelector('#new-doc');
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); button.click();`);
  await cdp.eval(`await new Promise(resolve => setTimeout(resolve, 300));`);
  assert.deepEqual(await cdp.eval(`return {
    drafts: document.querySelectorAll('.new-doc-row').length,
    renaming: !!document.querySelector('.rename-input'),
  };`), { drafts: 1, renaming: false });
  await cdp.eval(`const button = document.querySelector('#new-doc');
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); button.click();`);
  await cdp.eval(`await new Promise(resolve => setTimeout(resolve, 300));`);
  assert.equal(await cdp.eval(`return document.querySelectorAll('.new-doc-row').length;`), 1);
  await cdp.eval(`document.querySelector('.new-doc-row input').dispatchEvent(${key('Escape')});`);
  console.log('PASS new document click replaces rename or draft with one persistent draft');

  const beforeIme = await cdp.eval(`return window.__posts;`);
  await cdp.eval(`document.querySelector('#new-doc').click(); const input = document.querySelector('.new-doc-row input');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    input.dispatchEvent(${key('Enter')});`);
  assert.equal(await cdp.eval(`return window.__posts;`), beforeIme);
  await cdp.eval(`document.querySelector('.new-doc-row input').dispatchEvent(${key('Escape')});`);
  console.log('PASS IME confirmation Enter sends no POST');

  const create = async (value, expected) => {
    await cdp.eval(`document.querySelector('#new-doc').click();`);
    await until(() => cdp.eval(`return !!document.querySelector('.new-doc-row input');`));
    await cdp.eval(`const input = document.querySelector('.new-doc-row input'); input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
    await until(() => cdp.eval(`return document.querySelector('#filename').title === ${JSON.stringify(expected)};`))
      .catch(async error => { console.log('CREATE DEBUG', await cdp.eval(`return { status: document.querySelector('#status').textContent,
        file: document.querySelector('#filename').title, edit: document.querySelector('.new-doc-row input')?.value,
        alert: document.querySelector('[role="alert"]')?.textContent, shell: document.body.dataset.shellState };`)); throw error; });
    assert.ok((await readFile(join(docs, expected))).length > 8);
  };
  await create('  보고서  ', 'P/보고서.hwp');
  await create('대문자.HWP', 'P/대문자.hwp');
  console.log('PASS trim and lowercase HWP normalization create and open one file');

  const beforeDouble = await cdp.eval(`return window.__posts;`);
  await cdp.eval(`document.querySelector('#new-doc').click(); const input = document.querySelector('.new-doc-row input');
    input.value = '두번'; input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(${key('Enter')}); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/두번.hwp';`));
  assert.equal(await cdp.eval(`return window.__posts;`), beforeDouble + 1);
  console.log('PASS double Enter sends one POST');

  await cdp.eval(`document.querySelector('#new-doc').click(); const input = document.querySelector('.new-doc-row input');
    input.value = '보고서'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return !!document.querySelector('.new-doc-row [role="alert"]');`));
  assert.equal(await cdp.eval(`return document.querySelector('.new-doc-row input').value;`), '보고서');
  assert.equal(await cdp.eval(`return document.activeElement === document.querySelector('.new-doc-row input');`), true);
  await cdp.eval(`document.querySelector('.new-doc-row input').dispatchEvent(${key('Escape')});`);
  console.log('PASS duplicate name keeps draft and focus');

  await cdp.eval(`document.querySelector('#new-doc').click();`);
  await cdp.eval(`const input = document.querySelector('.new-doc-row input'); input.value = '거절.hwpx';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return !!document.querySelector('.new-doc-row [role="alert"]');`));
  assert.match(await cdp.eval(`return document.querySelector('.new-doc-row [role="alert"]').textContent;`), /HWP 형식/);
  assert.equal(await cdp.eval(`return document.activeElement === document.querySelector('.new-doc-row input');`), true);
  await cdp.eval(`document.querySelector('.new-doc-row input').dispatchEvent(${key('Escape')});`);
  console.log('PASS invalid format keeps draft, error and focus');

  await cdp.eval(`document.querySelector('.group-header[data-group="P"]').click();
    const filter = document.querySelector('#doc-filter'); filter.value = '없는 검색';
    filter.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#new-doc').click();`);
  await until(() => cdp.eval(`return !!document.querySelector('.new-doc-row input');`));
  assert.equal(await cdp.eval(`return document.querySelector('#doc-filter').value;`), '');
  assert.equal(await cdp.eval(`return document.querySelector('.group-header[data-group="P"]').getAttribute('aria-expanded');`), 'true');
  await cdp.eval(`document.querySelector('.new-doc-row input').dispatchEvent(${key('Escape')});`);
  assert.equal(await cdp.eval(`return document.querySelector('#doc-filter').value;`), '없는 검색');
  await cdp.eval(`const filter = document.querySelector('#doc-filter'); filter.value = '';
    filter.dispatchEvent(new Event('input', { bubbles: true }));`);
  assert.equal(await cdp.eval(`return document.querySelector('.group-header[data-group="P"]')?.getAttribute('aria-expanded');`), 'false');
  console.log('PASS cancelling draft restores search and collapsed group');

  const external = join(scratch, 'external'); await mkdir(external);
  await writeFile(join(external, 'e.hwp'), await readFile(join(docs, 'P', 'a.hwp')));
  const { key: externalKey } = await server.store.register(external);
  await cdp.eval(`document.querySelector('#docs-refresh').click();`);
  await until(() => cdp.eval(`return !!document.querySelector(${JSON.stringify(`.group-header[data-group="ext://${externalKey}"]`)});`));
  await cdp.eval(`document.querySelector(${JSON.stringify(`.group-header[data-group="ext://${externalKey}"]`)}).focus();
    document.querySelector('#new-doc').click();`);
  await until(() => cdp.eval(`return !!document.querySelector('#external-docs .new-doc-row input');`));
  await cdp.eval(`const input = document.querySelector('#external-docs .new-doc-row input'); input.value = '외부작성';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === ${JSON.stringify(`ext://${externalKey}/외부작성.hwp`)};`));
  assert.ok((await readFile(join(external, '외부작성.hwp'))).length > 8);
  console.log('PASS external folder draft creates in its selected group');

  await cdp.eval(`document.querySelector('.group-header[data-group="P"]').click();
    document.querySelector('.doc[data-id="P/a.hwp"]').click();`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/a.hwp';`));

  await cdp.eval(`window.__failCreatedOpen = true;
    window.fetch = (url, options) => {
      if (String(url) === '/api/docs' && options?.method === 'POST') window.__posts++;
      if (decodeURIComponent(String(url)).includes('열기실패.hwp') && window.__failCreatedOpen) {
        window.__failCreatedOpen = false; return Promise.resolve(new Response('{}', { status: 500 })); }
      return window.__realFetch(url, options);
    };`);
  await cdp.eval(`document.querySelector('#new-doc').click(); const input = document.querySelector('.new-doc-row input');
    input.value = '열기실패'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return document.querySelector('#status').textContent.includes('만들었습니다 · 목록에서 다시 여세요');`));
  assert.ok((await readFile(join(docs, 'P', '열기실패.hwp'))).length > 8);
  console.log('PASS created file survives editor opening failure');

  await cdp.eval(`window.__failCreatedList = false;
    window.fetch = (url, options) => {
      if (String(url) === '/api/docs' && options?.method === 'POST') { window.__posts++; window.__failCreatedList = true; }
      if (String(url) === '/api/docs' && (!options || options.method === 'GET') && window.__failCreatedList) {
        window.__failCreatedList = false; return Promise.resolve(new Response('{}', { status: 500 })); }
      return window.__realFetch(url, options);
    };`);
  await cdp.eval(`document.querySelector('.group-header[data-group="P"]').focus();
    document.querySelector('#new-doc').click(); const input = document.querySelector('.new-doc-row input');
    input.value = '목록실패'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return document.querySelector('#status').textContent.includes('목록 갱신 실패');`));
  assert.ok((await readFile(join(docs, 'P', '목록실패.hwp'))).length > 8);
  await cdp.eval(`document.querySelector('#docs-refresh').click();`);
  await until(() => cdp.eval(`return document.querySelector('#list-feedback').textContent === '';`));
  console.log('PASS created file survives list refresh failure');

  await cdp.eval(`window.fetch = async (url, options) => {
    if (String(url) === '/api/docs' && options?.method === 'POST') {
      window.__posts++; await window.__realFetch(url, options); throw new TypeError('lost response');
    }
    if (String(url).startsWith('/api/docs/requests/')) window.__lookups++;
    return window.__realFetch(url, options);
  };`);
  const before = await cdp.eval(`return window.__posts;`);
  await cdp.eval(`document.querySelector('.group-header[data-group="P"]').focus();`);
  await create('응답유실', 'P/응답유실.hwp');
  assert.equal(await cdp.eval(`return window.__posts;`), before + 1);
  assert.ok(await cdp.eval(`return window.__lookups > 0;`));
  assert.deepEqual((await readdir(join(docs, 'P'))).filter(name => name === '응답유실.hwp'), ['응답유실.hwp']);
  console.log('PASS lost POST response recovered by read-only request lookup');

  await cdp.eval(`window.fetch = async (url, options) => {
    if (String(url) === '/api/docs' && options?.method === 'POST') {
      window.__posts++; await window.__realFetch(url, options); throw new TypeError('lost response');
    }
    if (String(url).startsWith('/api/docs/requests/')) { window.__lookups++; return new Response('', { status: 404 }); }
    return window.__realFetch(url, options);
  };`);
  const beforeUnknown = await cdp.eval(`return window.__posts;`);
  await cdp.eval(`document.querySelector('#new-doc').click(); const input = document.querySelector('.new-doc-row input');
    input.value = '조회없음'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return document.querySelector('#status').textContent.includes('결과 확인 불가');`));
  assert.equal(await cdp.eval(`return window.__posts;`), beforeUnknown + 1);
  assert.deepEqual((await readdir(join(docs, 'P'))).filter(name => name === '조회없음.hwp'), ['조회없음.hwp']);
  console.log('PASS unknown lookup stops without retransmitting POST');
});

await withBrowser({}, async ({ cdp }) => {
  await until(() => cdp.eval(`return document.body.dataset.studioReady === 'true';`));
  await cdp.eval(`document.querySelector('#new-doc').click();`);
  await until(() => cdp.eval(`return !!document.querySelector('.new-doc-row input');`));
  assert.equal(await cdp.eval(`return document.querySelector('.new-doc-row').closest('.group').querySelector('.group-header').dataset.group;`), '');
  console.log('PASS empty document library shows the temporary 기타 group');
});
