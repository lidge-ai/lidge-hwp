// 오피스 편집기 번들(build/office). build/는 .gitignore에 있고 CI와 설치 때 이 스크립트로 만든다.
// 진입점: sheet(FortuneSheet+SheetJS+ExcelJS), doc(docx-editor), slides(pdf.js). React는 번들 안에 들어간다.
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build', 'office');
await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'fonts'), { recursive: true });
const result = await build({
  absWorkingDir: ROOT,
  entryPoints: { sheet: 'web/office-src/sheet.jsx', doc: 'web/office-src/doc.jsx', slides: 'web/office-src/slides.mjs' },
  bundle: true, format: 'esm', splitting: true, outdir: OUT, minify: true, sourcemap: false,
  jsx: 'automatic', target: ['chrome120', 'safari17'], legalComments: 'external',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning', metafile: true,
});
await copyFile(join(ROOT, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), join(OUT, 'pdf.worker.min.mjs'));
await copyFile(join(ROOT, 'node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2'), join(OUT, 'fonts', 'PretendardVariable.woff2'));
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log('build/office ' + Object.keys(result.metafile.outputs).length + ' files, ' + (bytes / 1048576).toFixed(1) + ' MiB');

