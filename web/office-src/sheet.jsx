// 시트 편집기: FortuneSheet(React)로 그리고, 열기·저장은 SheetJS(xls·ods·csv·numbers)와 ExcelJS(xlsx)가 맡는다.
import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Workbook } from '@fortune-sheet/react';
import '@fortune-sheet/react/dist/index.css';
import ZAHL from 'xlsx/dist/xlsx.zahl.mjs';
import { readWorkbook, workbookToSheets, sheetsToWorkbook, writeWorkbook, warningsFor, workbookHasStyles, sheetsHaveFormulas, WARNING_TEXT } from './sheet-convert.mjs';
import { loadExcel, excelToSheets, patchXlsx } from './xlsx-patch.mjs';
import { bindSaveKey, waitFor } from './common.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const STRUCTURE_OPS = new Set(['insertRowCol', 'deleteRowCol']);

export async function createEditor(host, { format, onSaveShortcut = () => {} } = {}) {
  const element = document.createElement('div');
  element.className = 'office-editor office-sheet';
  host.replaceChildren(element);
  const root = createRoot(element);
  const unbindSave = bindSaveKey(element, onSaveShortcut);
  let ref = createRef();
  let state = { original: null, baseline: null, hadStyles: false, structureChanged: false, dirty: false, ready: false, seq: 0 };

  function mount(sheets) {
    state.seq += 1;
    ref = createRef();
    const onOp = ops => {
      if (!state.ready) return;
      state.dirty = true;
      if (ops.some(op => STRUCTURE_OPS.has(op.op))) state.structureChanged = true;
    };
    root.render(<Workbook key={state.seq} ref={ref} data={sheets} lang="en" onOp={onOp}
      showToolbar showFormulaBar showSheetTabs allowEdit />);
  }

  return {
    element,
    family: 'sheet',
    async loadFile(bytes) {
      state.ready = false;
      const data = new Uint8Array(bytes);
      let sheets;
      if (format === 'xlsx') {
        sheets = excelToSheets(await loadExcel(data));
        state.hadStyles = true;
      } else {
        const workbook = readWorkbook(data, format);
        sheets = workbookToSheets(workbook);
        state.hadStyles = workbookHasStyles(workbook);
      }
      state.original = data;
      state.baseline = clone(sheets);
      state.structureChanged = false;
      state.dirty = false;
      mount(clone(sheets));
      await waitFor(() => ref.current?.getAllSheets, 10000);
      // 첫 렌더가 만드는 내부 op는 편집이 아니다. 한 프레임 뒤부터 사람 편집으로 센다.
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));
      state.ready = true;
    },
    async getDocumentState() { return { dirty: state.dirty }; },
    async exportWithReport({ format: target = format } = {}) {
      const sheets = ref.current.getAllSheets();
      const warnings = warningsFor(target, { sheets: sheets.length, hadStyles: state.hadStyles,
        structureChanged: state.structureChanged, hasFormulas: sheetsHaveFormulas(sheets) });
      let bytes;
      if (target === 'xlsx' && !state.structureChanged) bytes = (await patchXlsx(state.original, state.baseline, sheets)).bytes;
      else bytes = writeWorkbook(sheetsToWorkbook(sheets), target, { numbersTemplate: ZAHL });
      state.pending = { bytes, sheets: clone(sheets) };
      return { bytes, contentLoss: { schemaVersion: 2, outputFormat: target, count: 0, losses: [], warnings } };
    },
    describeWarnings: codes => codes.map(code => WARNING_TEXT[code] ?? code),
    async notifySaved() {
      if (state.pending) { state.original = state.pending.bytes; state.baseline = state.pending.sheets; state.pending = null; }
      state.structureChanged = false;
      state.dirty = false;
    },
    destroy() { unbindSave(); root.unmount(); element.remove(); },
  };
}
