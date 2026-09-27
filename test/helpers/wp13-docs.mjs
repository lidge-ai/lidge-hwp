// wp13 테스트용 공개 fixture. 내장 WASM 빈 HWP에서 만들며 환경 변수·사설 문서가 필요 없다.
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createBlankHwpBytes, openDocument, exportWithReport } from '../../lib/rhwp-node.mjs';
import { tableAddresses, resolveCell } from '../../lib/cells.mjs';
import { createDocStore } from '../../lib/docstore.mjs';
import { createTabs } from '../../server/tabs.mjs';
const git = promisify(execFile);
export const sha256 = b => createHash('sha256').update(b).digest('hex');
export const GRAY = { textColor: '#999999', italic: true };

// body: 본문 문단 글 배열. table: {rows, cols, after?} 표는 after 문단(기본 0) 끝에 만든다.
// cells: {'r,c': 글 | [문단 글...]}. gray: 회색·기울임을 줄 칸 ['r,c']. renameNormal: 스타일 0의 이름을 바꿔 Normal(바탕글)을 없앤다.
export async function buildDoc({ body = [''], table = null, cells = {}, gray = [], renameNormal = false } = {}) {
  const doc = await openDocument(await createBlankHwpBytes());
  try {
    body.forEach((text, p) => {
      if (p > 0) doc.splitParagraph(0, p - 1, doc.getParagraphLength(0, p - 1));
      if (text) doc.insertText(0, p, 0, text);
    });
    if (table) {
      const after = table.after ?? 0;
      JSON.parse(doc.createTable(0, after, doc.getParagraphLength(0, after), table.rows, table.cols));
      for (const [key, value] of Object.entries(cells)) {
        const [row, col] = key.split(',').map(Number);
        const a = resolveCell(doc, 0, row, col);
        const paras = Array.isArray(value) ? value : [value];
        paras.forEach((text, i) => {
          if (i > 0) doc.splitParagraphInCell(a.section, a.para, a.control, a.cell, i - 1,
            doc.getCellParagraphLength(a.section, a.para, a.control, a.cell, i - 1));
          if (text) doc.insertTextInCell(a.section, a.para, a.control, a.cell, i, 0, text);
        });
      }
      for (const key of gray) {
        const [row, col] = key.split(',').map(Number);
        const a = resolveCell(doc, 0, row, col);
        const len = doc.getCellParagraphLength(a.section, a.para, a.control, a.cell, 0);
        doc.applyCharFormatInCell(a.section, a.para, a.control, a.cell, 0, 0, len, JSON.stringify(GRAY));
      }
    }
    if (renameNormal && !doc.updateStyle(0, JSON.stringify({ name: '본문X', englishName: 'BodyX' }))) throw new Error('updateStyle failed');
    const { bytes, report } = exportWithReport(doc, 'hwp');
    if (report.count !== 0) throw new Error('fixture content loss');
    return Buffer.from(bytes);
  } finally { doc.free(); }
}
export async function openBytes(t, bytes) {
  const doc = await openDocument(bytes);
  t.after(() => doc.free());
  return doc;
}
export const bodyParas = doc => Array.from({ length: doc.getParagraphCount(0) },
  (_, p) => doc.getTextRange(0, p, 0, doc.getParagraphLength(0, p)));
export function cellParas(doc, table, row, col) {
  const a = resolveCell(doc, table, row, col), out = [];
  for (let p = 0; p < doc.getCellParagraphCount(a.section, a.para, a.control, a.cell); p++)
    out.push(doc.getTextInCell(a.section, a.para, a.control, a.cell, p, 0, doc.getCellParagraphLength(a.section, a.para, a.control, a.cell, p)));
  return out;
}
export function cellChar(doc, table, row, col, para = 0, offset = 0) {
  const a = resolveCell(doc, table, row, col);
  return JSON.parse(doc.getCellCharPropertiesAt(a.section, a.para, a.control, a.cell, para, offset));
}
export function cellPara(doc, table, row, col, para = 0) {
  const a = resolveCell(doc, table, row, col);
  return JSON.parse(doc.getCellParaPropertiesAt(a.section, a.para, a.control, a.cell, para));
}
export const tableCount = doc => tableAddresses(doc).length;
// 임시 git 문서 저장소(runAgent 디스크 경로용).
export async function seedBytes(t, bytes, id = 'a.hwp') {
  const root = await mkdtemp(join(tmpdir(), 'lidge-wp13-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, id), bytes);
  await git('git', ['-C', root, 'init', '-q']);
  await git('git', ['-C', root, 'add', '--', id]);
  await git('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', 'commit', '-qm', 'seed']);
  const seedHead = (await git('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const { runAgent } = await import('../../server/agent/runner.mjs');
  const exec = code => runAgent({ code }, { store: createDocStore(root), tabs: createTabs(), config: {} });
  const head = async () => (await git('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const disk = () => readFile(join(root, id));
  return { root, id, seedSha: sha256(bytes), seedHead, exec, head, disk };
}

