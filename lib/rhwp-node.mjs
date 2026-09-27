import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { BUILD_DIR } from './config.mjs';

let modulePromise;
export async function rhwpModule() {
  modulePromise ??= (async () => {
    const dir = join(BUILD_DIR, 'wasm');
    const mod = await import(pathToFileURL(join(dir, 'rhwp.js')).href);
    mod.initSync({ module: readFileSync(join(dir, 'rhwp_bg.wasm')) });
    return mod;
  })();
  return modulePromise;
}
export async function openDocument(bytes) {
  const { HwpDocument } = await rhwpModule();
  return new HwpDocument(new Uint8Array(bytes));
}
export function exportWithReport(doc, format) {
  const result = format === 'hwp' ? doc.exportHwpWithReport()
    : format === 'hwpx' ? doc.exportHwpxWithReport()
    : (() => { throw new Error('unsupported format'); })();
  try {
    const report = JSON.parse(result.contentLoss());
    if (report.schemaVersion !== 1 || !Array.isArray(report.losses) || report.count !== report.losses.length)
      throw new Error('invalid content-loss report');
    return { bytes: result.takeBytes(), report };
  } finally { result.free(); }
}
