import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withBrowser, until, key, idSelector, expect as assert } from './browser-shell-helper.mjs';

await withBrowser({ files: ['P/a.hwp', 'P/b.hwp', 'P/UPPER.HWP', 'P/x.hwpx'] }, async ({ cdp, docs, server, scratch }) => {
  const a = idSelector('P/a.hwp');
  const b = idSelector('P/b.hwp');
  await until(() => cdp.eval(`return document.body.dataset.studioReady === 'true';`));
  await cdp.eval(`document.querySelector(${JSON.stringify(a)}).click();`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/a.hwp';`));
  const ordinary = await cdp.eval(`const node = document.querySelector(${JSON.stringify(a)}).querySelector('.doc-name');
    return { x: node.getBoundingClientRect().x, font: getComputedStyle(node).fontSize };`);
  await cdp.eval(`document.querySelector(${JSON.stringify(a)}).focus(); document.dispatchEvent(${key('F2', "code: 'F2'")});`);
  await until(() => cdp.eval(`return !!document.querySelector('.rename-input');`));
  const initial = await cdp.eval(`const input = document.querySelector('.rename-input'); const row = input.closest('.doc-row');
    return { name: input.value, selected: input.value.slice(input.selectionStart, input.selectionEnd),
      suffix: input.nextSibling.textContent, badge: row.querySelector('.badge').textContent,
      docButton: !!row.querySelector('button.doc'), border: getComputedStyle(input).borderTopStyle };`);
  assert.deepEqual(initial, { name: 'a', selected: 'a', suffix: '.hwp', badge: 'HWP', docButton: false, border: 'none' });
  const edited = await cdp.eval(`const node = document.querySelector('.rename-input');
    return { x: node.getBoundingClientRect().x, font: getComputedStyle(node).fontSize };`);
  assert.deepEqual(edited, ordinary);
  await mkdir('/tmp/wp16-shots', { recursive: true });
  await cdp.shot('/tmp/wp16-shots/after-rename-draft.png');
  console.log('PASS F2 edits base name in the document slot, preserving suffix and badge');

  await cdp.eval(`const input = document.querySelector('.rename-input'); input.value = '  초안  ';
    input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#docs-refresh').click();`);
  await until(() => cdp.eval(`return document.querySelector('.rename-input')?.value === '  초안  ';`));
  assert.equal(await cdp.eval(`return document.activeElement === document.querySelector('.rename-input');`), true);
  await cdp.eval(`document.querySelector('.rename-input').dispatchEvent(${key('Escape')});`);
  assert.equal(await cdp.eval(`return document.activeElement?.dataset.id;`), 'P/a.hwp');
  console.log('PASS refresh preserves draft and Escape restores row focus');

  await cdp.eval(`const row = document.querySelector(${JSON.stringify(a)}).closest('.doc-row');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));`);
  await until(() => cdp.eval(`return !!document.querySelector('.rename-input');`));
  await cdp.eval(`document.querySelector('.rename-input').dispatchEvent(${key('Escape')});`);
  console.log('PASS context menu enters the same inline edit');

  // 이름 버튼이 없어 행 전체 폭을 문서 버튼이 쓴다(hover·focus 때도 오른쪽 예약 공간이 없다).
  const layoutScript = `const button = document.querySelector(${JSON.stringify(a)}); const row = button.closest('.doc-row');
    button.focus(); return { renameButtons: document.querySelectorAll('.doc-rename').length,
      rowWidth: row.getBoundingClientRect().width, docWidth: button.getBoundingClientRect().width,
      keys: button.getAttribute('aria-keyshortcuts') };`;
  const layout = await cdp.eval(layoutScript); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  assert.equal(layout.renameButtons, 0);
  assert.equal(layout.docWidth, layout.rowWidth);
  assert.equal(layout.keys, 'F2 Meta+Shift+R');
  console.log('PASS rows have no rename button and the document button spans the row');

  // Finder·VS Code(macOS)처럼 열린 문서에서 Enter는 이름 바꾸기다.
  const enterScript = selector => `const button = document.querySelector(${JSON.stringify(selector)}); button.focus();
    const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    button.dispatchEvent(event); return event.defaultPrevented;`;
  const escapeEdit = `document.querySelector('.rename-input').dispatchEvent(${key('Escape')});`;
  assert.equal(await cdp.eval(enterScript(a)), true); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  await until(() => cdp.eval(`return document.querySelector('.rename-input')?.value === 'a';`)); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  await cdp.eval(escapeEdit); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  console.log('PASS Enter on the open document enters inline rename');

  // 열리지 않은 문서의 Enter는 열기만 한다(버튼 기본 동작, 편집 없음).
  assert.equal(await cdp.eval(enterScript(b)), false); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  await cdp.eval(`document.querySelector(${JSON.stringify(b)}).click();`); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/b.hwp';`)); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  assert.equal(await cdp.eval(`return !!document.querySelector('.rename-input');`), false); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  console.log('PASS Enter on another document leaves it to open without editing');

  // 다른 문서 더블클릭: click 두 번이 먼저 그 문서를 연 뒤에도 편집으로 들어가야 한다(감사 블로커 1).
  const doubleClick = selector => `const button = document.querySelector(${JSON.stringify(selector)});
    for (const detail of [1, 2]) button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));`;
  const openedAndEditingA = `return document.querySelector('#filename').title === 'P/a.hwp'
    && document.querySelector('.rename-input')?.value === 'a';`;
  await cdp.eval(doubleClick(a)); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  await until(() => cdp.eval(openedAndEditingA)); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  await cdp.eval(escapeEdit); // justified: CDP Runtime.evaluate test helper, not dynamic eval
  console.log('PASS double-click on another document opens it and enters inline rename');

  const renameButton = async id => {
    await cdp.eval(doubleClick(idSelector(id))); // justified: CDP Runtime.evaluate test helper, not dynamic eval
    await until(() => cdp.eval(`return !!document.querySelector('.rename-input');`));
  };
  await renameButton('P/a.hwp');
  await cdp.eval(`window.__realFetch = window.fetch; window.__renames = 0;
    window.fetch = (url, options) => { if (String(url).endsWith('/rename')) window.__renames++;
      return window.__realFetch(url, options); };`);
  await cdp.eval(`const input = document.querySelector('.rename-input');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));`);
  assert.equal(await cdp.eval(`return window.__renames;`), 0);
  await cdp.eval(`document.querySelector('.rename-input').dispatchEvent(${key('Escape')});`);
  console.log('PASS IME Enter sends no rename request');

  await renameButton('P/a.hwp');
  await cdp.eval(`const input = document.querySelector('.rename-input'); input.value = 'b';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return !!document.querySelector('.renaming [role="alert"]');`));
  assert.equal(await cdp.eval(`return document.querySelector('.rename-input').value;`), 'b');
  assert.equal(await cdp.eval(`return document.activeElement === document.querySelector('.rename-input');`), true);
  await cdp.eval(`document.querySelector('.rename-input').dispatchEvent(${key('Escape')});`);
  console.log('PASS collision error stays inline with draft and focus');

  await renameButton('P/a.hwp');
  await cdp.eval(`const input = document.querySelector('.rename-input'); input.value = 'bad/name';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return !!document.querySelector('.renaming [role="alert"]');`));
  assert.equal(await cdp.eval(`return document.querySelector('.rename-input').value;`), 'bad/name');
  await cdp.eval(`document.querySelector('.rename-input').dispatchEvent(${key('Escape')});`);
  console.log('PASS invalid character error remains inline');

  await renameButton('P/a.hwp');
  await cdp.eval(`document.querySelector('#new-doc').focus();`);
  await until(() => cdp.eval(`return !document.querySelector('.rename-input');`));
  assert.equal(await cdp.eval(`return document.activeElement?.id;`), 'new-doc');
  console.log('PASS blur cancels rename without submitting');

  await renameButton('P/a.hwp');
  await cdp.eval(`const target = document.querySelector(${JSON.stringify(b)});
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); target.click();`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/b.hwp' && !document.querySelector('.rename-input');`));
  console.log('PASS clicking another document opens it before cancelling rename');

  await renameButton('P/b.hwp');
  await cdp.eval(`const target = document.querySelector('.group-header[data-group="P"]');
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); target.click();`);
  await until(() => cdp.eval(`return document.querySelector('.group-header[data-group="P"]').getAttribute('aria-expanded') === 'false'
    && !document.querySelector('.rename-input');`));
  await cdp.eval(`document.querySelector('.group-header[data-group="P"]').click();`);
  console.log('PASS group toggle completes before edit cancellation');

  await renameButton('P/b.hwp');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await until(() => cdp.eval(`return !document.querySelector('.rename-input');`));
  assert.notEqual(await cdp.eval(`return document.activeElement?.id;`), 'new-doc');
  console.log('PASS Tab cancels without stealing next focus');

  await renameButton('P/b.hwp');
  await cdp.eval(`const input = document.querySelector('.rename-input'); input.value = '  완성  ';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/완성.hwp';`));
  assert.ok((await readFile(join(docs, 'P', '완성.hwp'))).length > 8);
  console.log('PASS trimmed rename commits and reopens');

  await cdp.eval(`document.querySelector(${JSON.stringify(idSelector('P/UPPER.HWP'))}).click();`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/UPPER.HWP';`));
  await renameButton('P/UPPER.HWP');
  assert.equal(await cdp.eval(`return document.querySelector('.doc-extension').textContent;`), '.HWP');
  await cdp.eval(`document.querySelector('.rename-input').dispatchEvent(${key('Escape')});`);
  await cdp.eval(`document.querySelector(${JSON.stringify(idSelector('P/x.hwpx'))}).click();`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/x.hwpx';`));
  await renameButton('P/x.hwpx');
  assert.equal(await cdp.eval(`return document.querySelector('.doc-extension').textContent;`), '.hwpx');
  await cdp.eval(`document.querySelector('.rename-input').dispatchEvent(${key('Escape')});`);
  console.log('PASS original HWP and HWPX extension spelling stays fixed');

  const external = join(scratch, 'external'); await mkdir(external);
  await writeFile(join(external, 'e.hwp'), await readFile(join(docs, 'P', 'a.hwp')));
  const { key: externalKey } = await server.store.register(external);
  const externalId = `ext://${externalKey}/e.hwp`;
  await cdp.eval(`document.querySelector('#docs-refresh').click();`);
  await until(() => cdp.eval(`return !!document.querySelector(${JSON.stringify(idSelector(externalId))});`));
  await cdp.eval(`document.querySelector(${JSON.stringify(idSelector(externalId))}).click();`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === ${JSON.stringify(externalId)};`));
  await renameButton(externalId);
  await cdp.eval(`const input = document.querySelector('.rename-input'); input.value = 'f';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === ${JSON.stringify(`ext://${externalKey}/f.hwp`)};`));
  assert.ok((await readFile(join(external, 'f.hwp'))).length > 8);
  console.log('PASS external folder rename uses the same inline flow');

  await cdp.eval(`document.querySelector(${JSON.stringify(idSelector('P/UPPER.HWP'))}).click();`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/UPPER.HWP';`));
  await renameButton('P/UPPER.HWP');
  await cdp.eval(`window.__editorModule = await import('/editor/index.js');
    window.__oldState = window.__editorModule.RhwpEditor.prototype.getDocumentState;
    window.__editorModule.RhwpEditor.prototype.getDocumentState = async () => ({ dirty: true });
    window.__oldConfirm = window.confirm; window.confirm = () => false;
    const input = document.querySelector('.rename-input'); input.value = '거절';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return document.querySelector('.rename-input')?.readOnly === false;`));
  assert.equal(await cdp.eval(`return document.querySelector('#filename').title;`), 'P/UPPER.HWP');
  await cdp.eval(`window.__editorModule.RhwpEditor.prototype.getDocumentState = window.__oldState;
    window.confirm = window.__oldConfirm; document.querySelector('.rename-input').dispatchEvent(${key('Escape')});`);
  console.log('PASS dirty cancel retains the original document and edit draft');

  await renameButton('P/UPPER.HWP');
  await cdp.eval(`window.fetch = async (url, options) => { const response = await window.__realFetch(url, options);
    if (String(url).endsWith('/rename')) throw new TypeError('lost response'); return response; };
    const input = document.querySelector('.rename-input'); input.value = '회복';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(${key('Enter')});`);
  await until(() => cdp.eval(`return document.querySelector('#filename').title === 'P/회복.HWP'
    && document.querySelector('#status').textContent.includes('이름 변경 완료');`));
  console.log('PASS lost rename response reconciles and reopens the committed file');
});
