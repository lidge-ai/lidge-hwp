import {
  runTest, setTestCase, createNewDocument, clickEditArea, screenshot, assert,
} from './helpers.mjs';

const pageErrors = [];

const key = (page, opts) => page.evaluate((o) => {
  const t = window.__inputHandler.textarea;
  t.dispatchEvent(new KeyboardEvent('keydown', {
    key: o.key, code: o.code || o.key,
    ctrlKey: !!o.ctrl, metaKey: !!o.meta, altKey: !!o.alt, shiftKey: !!o.shift,
    bubbles: true, cancelable: true,
  }));
}, opts);

const settle = () => new Promise(r => setTimeout(r, 350));

// 셀 선택 모드는 createNewDocument 를 넘어 남는다 — 케이스마다 해제.
const resetModes = (page) => page.evaluate(() => {
  const ih = window.__inputHandler;
  const cur = ih.cursor;
  try { if (cur.isInCellSelectionMode?.()) cur.exitCellSelectionMode(); } catch {}
  try { if (cur.isInTableObjectSelection?.()) cur.exitTableObjectSelection?.(); } catch {}
  try { if (cur.isInPictureObjectSelection?.()) cur.exitPictureObjectSelection?.(); } catch {}
  try { if (cur.isInBlockSelectionMode?.()) cur.exitBlockSelectionMode(); } catch {}
  ih.cellSelectionRenderer?.clear?.();
  ih.updateCaret?.();
});

const buildDoc = (page) => createNewDocument(page)
  .then(() => resetModes(page))
  .then(() => page.evaluate(async () => {
    const w = window.__wasm;
    const nf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    w.doc.insertText(0, 0, 0, 'BEFORE');
    w.doc.splitParagraph(0, 0, 6);
    const created = w.createTable(0, 1, 0, 3, 3);
    if (!created?.ok) throw new Error(`createTable: ${JSON.stringify(created)}`);
    w.doc.insertParagraph(0, created.paraIdx + 1);
    w.doc.insertText(0, created.paraIdx + 1, 0, 'AFTER');
    for (const b of w.getTableCellBboxes(0, created.paraIdx, created.controlIdx, 0) || []) {
      w.doc.insertTextInCell(0, created.paraIdx, created.controlIdx, b.cellIdx, 0, 0, `${'ABC'[b.col]}${b.row + 1}`);
    }
    window.__canvasView?.loadDocument?.();
    await nf(); await nf();
    return { paraIdx: created.paraIdx, controlIdx: created.controlIdx };
  }));

const caretInBody = (page) => page.evaluate(() => {
  const ih = window.__inputHandler;
  ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 2 });
  ih.updateCaret(); ih.focus();
});

const caretInCell = (page, doc, row, col) => page.evaluate(({ paraIdx, controlIdx, row, col }) => {
  const w = window.__wasm;
  const ih = window.__inputHandler;
  const b = (w.getTableCellBboxes(0, paraIdx, controlIdx, 0) || []).find(x => x.row === row && x.col === col);
  if (!b) throw new Error(`cell (${row},${col}) 없음`);
  ih.cursor.moveTo({
    sectionIndex: 0, paragraphIndex: 0, charOffset: 1,
    parentParaIndex: paraIdx, controlIndex: controlIdx,
    cellIndex: b.cellIdx, cellParaIndex: 0,
    cellPath: [{ controlIndex: controlIdx, cellIndex: b.cellIdx, cellParaIndex: 0 }],
  });
  ih.updateCaret(); ih.focus();
}, { ...doc, row, col });

const selState = (page) => page.evaluate(() => {
  const c = window.__inputHandler.cursor;
  const ordered = c.getSelectionOrdered?.();
  return {
    hasSel: c.hasSelection(),
    start: ordered ? { ...ordered.start } : null,
    end: ordered ? { ...ordered.end } : null,
    pos: c.getPosition(),
    cellSel: !!c.isInCellSelectionMode(),
    inCell: c.isInCell(),
  };
});

const cellText = (page, doc, row, col) => page.evaluate(({ paraIdx, controlIdx, row, col }) => {
  const w = window.__wasm;
  const b = (w.getTableCellBboxes(0, paraIdx, controlIdx, 0) || []).find(x => x.row === row && x.col === col);
  if (!b) return null;
  return w.getTextInCell(0, paraIdx, controlIdx, b.cellIdx, 0, 0, 100);
}, { ...doc, row, col });

// 마지막 selectionRenderer.render 에 전달된 rect 목록을 캡처하는 spy.
const installRectSpy = (page) => page.evaluate(() => {
  const ih = window.__inputHandler;
  const r = ih.selectionRenderer;
  if (r && !r.__spyPatched) {
    r.__spyPatched = true;
    const orig = r.render.bind(r);
    r.render = (rects, zoom) => { window.__lastSelRects = rects; return orig(rects, zoom); };
  }
});

await runTest('⌘A 전체 선택 — 셀/글상자 범위 + 표 하이라이트 + 포커스 밖', async ({ page }) => {
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await clickEditArea(page);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('시작하기'));
    btn?.click();
  });
  await page.evaluate(() => new Promise(r => setTimeout(r, 300)));

  // ── (a) 본문 캐럿 → 문서 전체 + 표 영역도 하이라이트 ──
  {
    setTestCase('a-body');
    const doc = await buildDoc(page);
    await caretInBody(page);
    await installRectSpy(page);
    await key(page, { key: 'a', code: 'KeyA', meta: true });
    await page.evaluate(settle);
    const s = await selState(page);
    assert(s.hasSel === true, 'a: 선택 있음' + ` (실제 ${s.hasSel})`);
    assert(s.start.paragraphIndex === 0, 'a: 시작은 문서 첫 문단' + ` (실제 ${s.start.paragraphIndex})`);
    assert(s.start.parentParaIndex === undefined, 'a: 시작은 본문' + ` (실제 ${s.start.parentParaIndex})`);
    const paraCount = await page.evaluate(() => window.__wasm.getParagraphCount(0));
    assert(s.end.paragraphIndex === paraCount - 1, 'a: 끝은 문서 마지막 문단' + ` (실제 ${s.end.paragraphIndex})`);
    // 표 bbox 와 겹치는 하이라이트 rect 가 있어야 한다
    const { rects, unions } = await page.evaluate(async (d) => {
      const w = window.__wasm;
      const bs = w.getTableCellBboxes(0, d.paraIdx, d.controlIdx) || [];
      const byPage = new Map();
      for (const b of bs) {
        const u = byPage.get(b.pageIndex) ?? { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
        u.x0 = Math.min(u.x0, b.x); u.y0 = Math.min(u.y0, b.y);
        u.x1 = Math.max(u.x1, b.x + b.w); u.y1 = Math.max(u.y1, b.y + b.h);
        byPage.set(b.pageIndex, u);
      }
      return {
        rects: window.__lastSelRects || [],
        unions: [...byPage].map(([pageIndex, u]) => ({ pageIndex, ...u })),
      };
    }, doc);
    const overlaps = unions.some(u => rects.some(r => r.pageIndex === u.pageIndex
      && r.x < u.x1 && r.x + r.width > u.x0 && r.y < u.y1 && r.y + r.height > u.y0));
    assert(overlaps, `a: 표 영역이 하이라이트에 포함 (rects=${JSON.stringify(rects)}, table=${JSON.stringify(unions)})`);
    await screenshot(page, 'pr2-a-body-cmdA');
  }

  // ── (b) 셀 안 캐럿 → 그 셀 내용만 ──
  {
    setTestCase('b-cell');
    const doc = await buildDoc(page);
    await caretInCell(page, doc, 1, 1); // B2
    await key(page, { key: 'a', code: 'KeyA', meta: true });
    await page.evaluate(settle);
    const s = await selState(page);
    assert(s.hasSel === true, 'b: 선택 있음' + ` (실제 ${s.hasSel})`);
    assert(s.start.parentParaIndex === doc.paraIdx, 'b: 선택은 셀 안' + ` (실제 ${s.start.parentParaIndex})`);
    assert((s.start.cellParaIndex ?? s.start.cellPath?.at(-1)?.cellParaIndex) === 0, 'b: 셀 첫 문단');
    assert(s.start.charOffset === 0, 'b: 셀 첫 문단 시작' + ` (실제 ${s.start.charOffset})`);
    assert(s.pos.parentParaIndex === doc.paraIdx, 'b: 캐럿이 셀을 떠나지 않음' + ` (실제 ${s.pos.parentParaIndex})`);
    await screenshot(page, 'pr2-b-cell-cmdA');
    await key(page, { key: 'Backspace' });
    await page.evaluate(settle);
    assert(await cellText(page, doc, 1, 1) === '', 'b: B2 만 지워짐');
    assert(await cellText(page, doc, 0, 0) === 'A1', 'b: 다른 셀 보존');
    assert(await cellText(page, doc, 2, 2) === 'C3', 'b: 다른 셀 보존');
  }

  // ── (d) 셀 블록(F5) → 블록 해제 + 현재 셀 선택 ──
  {
    setTestCase('d-cellblock');
    const doc = await buildDoc(page);
    await caretInCell(page, doc, 0, 0);
    await key(page, { key: 'F5', code: 'F5' });
    await page.evaluate(settle);
    const before = await selState(page);
    assert(before.cellSel === true, 'd: 셀 블록 진입 확인' + ` (실제 ${before.cellSel})`);
    await key(page, { key: 'a', code: 'KeyA', meta: true });
    await page.evaluate(settle);
    const s = await selState(page);
    assert(s.cellSel === false, 'd: 블록 해제' + ` (실제 ${s.cellSel})`);
    assert(s.hasSel === true, 'd: 선택 있음' + ` (실제 ${s.hasSel})`);
    assert(s.start.parentParaIndex === doc.paraIdx, 'd: 셀 안 선택' + ` (실제 ${s.start.parentParaIndex})`);
    await screenshot(page, 'pr2-d-cellblock-cmdA');
  }

  // ── (e) 툴바 버튼 포커스에서 실제 CDP ⌘A → 편집기 전체 선택 + 포커스 복귀 ──
  {
    setTestCase('e-toolbar');
    const doc = await buildDoc(page);
    await caretInBody(page);
    await page.evaluate(() => {
      const btn = document.querySelector('button');
      btn?.focus();
    });
    const active = await page.evaluate(() => document.activeElement?.tagName);
    assert(active === 'BUTTON', 'e: 포커스가 버튼에 있음을 확인' + ` (실제 ${active})`);
    await page.keyboard.down('Meta');
    await page.keyboard.press('a');
    await page.keyboard.up('Meta');
    await page.evaluate(settle);
    const s = await selState(page);
    const after = await page.evaluate(() => document.activeElement?.tagName);
    assert(s.hasSel === true, 'e: textarea 밖 포커스에서도 전체 선택' + ` (실제 ${s.hasSel})`);
    assert(after === 'TEXTAREA', `e: 포커스가 편집기 textarea로 복귀 (실제 ${after})`);
  }

  // ── (f) 한글 IME 스타일 ⌘A (key 'ㅁ', code 'KeyA') ──
  {
    setTestCase('f-ime');
    await buildDoc(page);
    await caretInBody(page);
    await key(page, { key: 'ㅁ', code: 'KeyA', meta: true });
    await page.evaluate(settle);
    const s = await selState(page);
    assert(s.hasSel === true, 'f: IME ⌘A 전체 선택' + ` (실제 ${s.hasSel})`);
  }

  // ── (g) ⌘A 뒤 Backspace → 표 포함 전체 삭제 (회귀) ──
  {
    setTestCase('g-delete-all');
    const doc = await buildDoc(page);
    await caretInBody(page);
    await key(page, { key: 'a', code: 'KeyA', meta: true });
    await key(page, { key: 'Backspace' });
    await page.evaluate(settle);
    const after = await page.evaluate((d) => {
      const w = window.__wasm;
      const n = w.getParagraphCount(0);
      const body = [];
      for (let p = 0; p < n; p++) body.push(w.getTextRange(0, p, 0, 50));
      const bboxes = w.getTableCellBboxes(0, d.paraIdx, d.controlIdx) || [];
      return { n, body, tableLeft: bboxes.length };
    }, doc);
    assert(after.tableLeft === 0, 'g: 표도 삭제됨' + ` (실제 ${after.tableLeft})`);
    assert(after.n === 1, `g: 문단 1개만 남음 (실제 ${after.n})`);
    assert((after.body[0] ?? '') === '', 'g: 본문도 비었음');
  }

  assert(pageErrors.length === 0, `pageerror 0건 (실제: ${JSON.stringify(pageErrors)})`);
});
