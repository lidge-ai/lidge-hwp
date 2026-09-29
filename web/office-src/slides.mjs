// 슬라이드 보기: 서버가 LibreOffice로 만든 PDF를 pdf.js로 그린다(pptx·odp·ppt·key는 읽기 전용).
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = '/office/pdf.worker.min.mjs';
const THUMB_WIDTH = 168;
const MAX_PAGES = 200;

export async function createEditor(host, { id } = {}) {
  const element = document.createElement('div');
  element.className = 'office-editor office-slides';
  element.innerHTML = '<nav class="slide-rail" aria-label="슬라이드 목록"></nav><section class="slide-stage" tabindex="0" aria-label="슬라이드"></section><a class="slide-pdf" target="_blank" rel="noopener">PDF로 보기</a>';
  host.replaceChildren(element);
  element.querySelector('.slide-pdf').href = '/api/office/pdf/' + encodeURIComponent(id ?? '');
  const rail = element.querySelector('.slide-rail');
  const stage = element.querySelector('.slide-stage');
  let pdf = null, current = 0, drawing = 0, docId = id;
  const observer = new ResizeObserver(() => { if (pdf) void show(current); });
  observer.observe(stage);

  async function draw(page, canvas, width) {
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * ratio });
    canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width / ratio) + 'px';
    canvas.style.height = Math.floor(viewport.height / ratio) + 'px';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }
  async function show(index) {
    if (!pdf) return;
    current = Math.max(0, Math.min(index, pdf.numPages - 1));
    const seq = ++drawing;
    const page = await pdf.getPage(current + 1);
    if (seq !== drawing) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'slide-page';
    const box = stage.getBoundingClientRect();
    const view = page.getViewport({ scale: 1 });
    const width = Math.max(200, Math.min(box.width - 48, (box.height - 48) * view.width / view.height));
    await draw(page, canvas, width);
    if (seq !== drawing) return;
    stage.replaceChildren(canvas);
    for (const [i, button] of [...rail.children].entries()) button.setAttribute('aria-current', String(i === current));
    rail.children[current]?.scrollIntoView({ block: 'nearest' });
  }
  stage.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowRight', 'PageDown'].includes(event.key)) { event.preventDefault(); void show(current + 1); }
    if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); void show(current - 1); }
  });

  return {
    element,
    family: 'slides',
    async loadFile(_bytes, _name) {
      const response = await fetch('/api/office/pdf/' + encodeURIComponent(docId), { cache: 'no-store' });
      if (!response.ok) {
        let code = 'HTTP ' + response.status;
        try { code = (await response.json()).error?.code || code; } catch { /* pdf 아님 */ }
        throw Object.assign(new Error(code), { code });
      }
      pdf = await getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
      rail.replaceChildren();
      const count = Math.min(pdf.numPages, MAX_PAGES);
      for (let i = 0; i < count; i += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'slide-thumb';
        button.setAttribute('aria-label', (i + 1) + '번 슬라이드');
        const label = document.createElement('span'); label.textContent = String(i + 1);
        button.append(label);
        button.addEventListener('click', () => void show(i));
        rail.append(button);
      }
      await show(0);
      // 썸네일은 뒤에서 차례로 그린다.
      void (async () => {
        for (let i = 0; i < count && pdf; i += 1) {
          const page = await pdf.getPage(i + 1);
          const canvas = document.createElement('canvas');
          await draw(page, canvas, THUMB_WIDTH);
          rail.children[i]?.prepend(canvas);
        }
      })().catch(() => {});
    },
    async getDocumentState() { return { dirty: false }; },
    async exportWithReport() { throw Object.assign(new Error('FORMAT_READ_ONLY'), { code: 'FORMAT_READ_ONLY' }); },
    pageCount: () => pdf?.numPages ?? 0,
    async notifySaved() {},
    destroy() { observer.disconnect(); void pdf?.destroy(); pdf = null; element.remove(); },
  };
}
