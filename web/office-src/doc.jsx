// 문서 편집기: docx-editor(Apache-2.0 부분만)로 DOCX를 그대로 편집한다. 손대지 않은 OOXML은 저장 때 보존된다.
// odt·rtf·doc·pages는 셸이 서버에서 docx로 바꿔 넘기고, 저장은 docx 바이트를 X-Source-Format: docx로 보낸다.
import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { DocxEditor } from '@docx-editor.dev/react';
import '@docx-editor.dev/react/styles.css';
import { bindSaveKey, waitFor } from './common.mjs';

const WARNING_TEXT = { CONVERTED_VIA_LIBREOFFICE: 'LibreOffice로 원래 형식으로 되돌려 저장합니다(일부 서식이 달라질 수 있습니다)' };

export async function createEditor(host, { format, onSaveShortcut = () => {}, notify = () => {} } = {}) {
  const element = document.createElement('div');
  element.className = 'office-editor office-doc';
  host.replaceChildren(element);
  const root = createRoot(element);
  const unbindSave = bindSaveKey(element, onSaveShortcut);
  let ref = createRef();
  const state = { original: null, dirty: false, ready: false, seq: 0, ready$: null };
  const viaConversion = format !== 'docx';

  function mount(bytes, title) {
    state.seq += 1;
    ref = createRef();
    let resolveReady;
    state.ready$ = new Promise(resolve => { resolveReady = resolve; });
    root.render(<DocxEditor key={state.seq} ref={ref} document={bytes} mode="edit" title={title}
      onReady={() => resolveReady()}
      onChange={() => { if (state.ready) state.dirty = true; }}
      onSave={() => onSaveShortcut()}
      onOpen={() => notify('다른 문서는 왼쪽 문서함에서 여세요')}
      colorMode="light" />);
  }

  return {
    element,
    family: 'doc',
    async loadFile(bytes, name) {
      state.ready = false;
      state.original = new Uint8Array(bytes);
      state.dirty = false;
      mount(state.original.slice(), String(name ?? '').replace(/\.[^.]+$/, ''));
      await Promise.race([state.ready$, waitFor(() => ref.current?.getEditor?.(), 20000)]);
      await new Promise(resolve => setTimeout(resolve, 150));
      state.ready = true;
    },
    async getDocumentState() { return { dirty: state.dirty }; },
    async exportWithReport({ format: target = format } = {}) {
      const saved = await ref.current.save();
      // null은 "바꾼 것이 없다". 원본 바이트를 그대로 돌려준다(서버는 같은 바이트면 빈 커밋).
      const bytes = saved ? new Uint8Array(saved) : state.original;
      const warnings = viaConversion ? ['CONVERTED_VIA_LIBREOFFICE'] : [];
      state.pending = bytes;
      return { bytes, sourceFormat: viaConversion ? 'docx' : undefined,
        contentLoss: { schemaVersion: 2, outputFormat: target, count: 0, losses: [], warnings } };
    },
    describeWarnings: codes => codes.map(code => WARNING_TEXT[code] ?? code),
    async notifySaved() { if (state.pending) state.original = state.pending; state.pending = null; state.dirty = false; },
    destroy() { unbindSave(); root.unmount(); element.remove(); },
  };
}

