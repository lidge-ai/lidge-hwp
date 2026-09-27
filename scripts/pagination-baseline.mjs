// Stable, public document pagination fingerprint. Run once before editing the engine and after rebuilding it.
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openDocument } from '../lib/rhwp-node.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin/darwin-arm64/rhwp');
const files = [
  'rhwp/samples/hwp3-sample16-hwp5.hwp',
  'rhwp/samples/3-09월_교육_통합_2022.hwp',
  'rhwp/samples/hml/formatting_table.hml',
  'rhwp/samples/hwpx/ref/ref_empty.hwpx',
  'rhwp/samples/render-p35-font-native-bitmap.hwpx',
  'rhwp/saved/blank2010.hwp',
  'rhwp/template/111111.hwp',
  'rhwp/template/empty-step2_saved_err.hwp',
];
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const exec = promisify(execFile);

for (const file of files) {
  const path = join(root, file);
  const bytes = await readFile(path);
  const doc = await openDocument(bytes);
  try {
    const { stdout } = await exec(bin, ['dump-pages', path, '--json'], { maxBuffer: 64 * 1024 * 1024 });
    const dump = JSON.parse(stdout);
    const boundaries = dump.pages.map(page => {
      const indices = page.columns.flatMap(col => col.items.map(item => item.paraIndex).filter(Number.isInteger));
      return [page.section, indices.at(0) ?? null, indices.at(-1) ?? null];
    });
    const texts = Array.from({ length: doc.pageCount() }, (_, page) => doc.getPageText(page));
    const { stdout: rawDump } = await exec(bin, ['dump', path], { maxBuffer: 64 * 1024 * 1024 });
    let previous = null, current = null, realResets = 0, syntheticResets = 0;
    for (const line of rawDump.split('\n')) {
      const header = /^--- 문단 (\d+)\.(\d+) ---/.exec(line);
      if (header) {
        previous = current;
        current = { section: Number(header[1]), paragraph: Number(header[2]), first: null, last: null };
        continue;
      }
      const row = /ls\[(\d+)\]:.*vpos=(-?\d+).*tag=0x([0-9a-fA-F]+)/.exec(line);
      if (!row || !current) continue;
      const seg = { vpos: Number(row[2]), synthetic: (Number.parseInt(row[3], 16) & 0x80000000) !== 0 };
      if (Number(row[1]) === 0) {
        current.first = seg;
        if (previous && previous.section === current.section && previous.last?.vpos > 5000 && seg.vpos === 0) {
          if (seg.synthetic) syntheticResets++; else realResets++;
        }
      }
      current.last = seg;
    }
    console.log(JSON.stringify({ file, fileSha: hash(bytes), wasmPages: doc.pageCount(), cliPages: dump.pageCount,
      boundariesSha: hash(JSON.stringify(boundaries)), textSha: hash(JSON.stringify(texts)), realResets, syntheticResets }));
  } finally { doc.free(); }
}
