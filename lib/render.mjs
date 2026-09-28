// 문서를 PDF(쪽별·전체)와 PNG로 렌더한다. hwp.snapshot·hwp.exportPdf(server/agent/runner.mjs)가 쓴다.
// PDF는 번들 rhwp CLI(bin/rhwp export-pdf)로 만든다. 번들 바이너리에 native-skia가 없어 export-png는 못 쓰므로,
// PNG는 쪽 PDF를 macOS sips로 래스터화한다. 결과는 문서함(Git) 밖 EXPORTS_ROOT에 둔다.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_SNAPSHOT_PAGES = 200;
const PNG_DEFAULT_PX = 1600, PNG_MIN_PX = 256, PNG_MAX_PX = 4096, CONCURRENCY = 4;
const coded = (code, message = code) => Object.assign(new Error(`${code}: ${message}`), { code });

function run(file, args, deadline) {
  const timeout = deadline - Date.now();
  if (timeout < 500) return Promise.reject(coded('RENDER_TIMEOUT', 'no time left in this hwp_exec call; raise timeoutMs or ask for fewer pages'));
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout));
      if (error.killed) return reject(coded('RENDER_TIMEOUT', 'raise timeoutMs or ask for fewer pages'));
      const last = String(stderr || error.message).trim().split('\n').pop().slice(0, 300);
      reject(coded('RENDER_FAILED', last));
    });
  });
}
// The same CLI that renders snapshots supplies the authoritative count for their input bytes.
export async function cliPageCountOf(bytes, format, rhwpBin, deadline) {
  if (!rhwpBin || !['hwp', 'hwpx'].includes(format)) throw coded('RENDER_ARGS_INVALID', 'CLI page count arguments');
  const tmp = await mkdtemp(join(tmpdir(), 'lidge-hwp-pages-'));
  try {
    const src = join(tmp, `source.${format}`);
    await writeFile(src, bytes, { mode: 0o600 });
    const result = JSON.parse(await run(rhwpBin, ['dump-pages', src, '--json'], deadline));
    if (!Number.isSafeInteger(result.pageCount) || result.pageCount < 1) throw coded('RENDER_FAILED', 'invalid dump-pages count');
    return result.pageCount;
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
const manifest = stdout => {
  const line = stdout.trim().split('\n').reverse().find(l => l.startsWith('{'));
  const m = line ? JSON.parse(line) : null;
  if (!m || !Number.isSafeInteger(m.pageCount)) throw coded('RENDER_FAILED', 'no export-pdf manifest');
  return m;
};
const pad = n => String(n).padStart(2, '0');
// 로컬 시각 + 원본 해시 앞 8자. 같은 초에 두 번 찍으면 makeOutDir가 꼬리 번호를 붙인다.
export function stampName(sha256, now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${sha256.slice(0, 8)}`;
}
export const pageFile = (page, ext) => `page-${String(page + 1).padStart(3, '0')}.${ext}`;

export function checkSnapshotOptions(opts = {}, platform = process.platform) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw coded('RENDER_ARGS_INVALID', 'options must be an object');
  const unknown = Object.keys(opts).filter(k => !['pages', 'png', 'maxPx', 'pdf'].includes(k));
  if (unknown.length) throw coded('RENDER_ARGS_INVALID', `unknown option ${unknown.join(', ')}`);
  const { pages, png = platform === 'darwin', maxPx = PNG_DEFAULT_PX, pdf = true } = opts;
  if (pages !== undefined && !(Array.isArray(pages) && pages.length >= 1 && pages.length <= MAX_SNAPSHOT_PAGES &&
      pages.every(p => Number.isSafeInteger(p) && p >= 0) && new Set(pages).size === pages.length))
    throw coded('RENDER_ARGS_INVALID', `pages must be 1..${MAX_SNAPSHOT_PAGES} distinct 0-based page numbers`);
  if (typeof png !== 'boolean' || typeof pdf !== 'boolean' || !(png || pdf)) throw coded('RENDER_ARGS_INVALID', 'png and pdf are booleans; at least one must be true');
  if (png && platform !== 'darwin') throw coded('PNG_UNSUPPORTED', 'PNG snapshots need macOS sips; pass png:false');
  if (!Number.isSafeInteger(maxPx) || maxPx < PNG_MIN_PX || maxPx > PNG_MAX_PX) throw coded('RENDER_ARGS_INVALID', `maxPx must be ${PNG_MIN_PX}..${PNG_MAX_PX}`);
  return { pages, png, pdf, maxPx };
}

// 아직 없는 경로도 실제 경로로 푼다: 존재하는 가장 가까운 상위를 realpath하고 나머지를 붙인다(macOS /var → /private/var).
async function resolveReal(p) {
  const rest = [];
  for (let cur = p; ; cur = dirname(cur)) {
    try { return join(await realpath(cur), ...rest.reverse()); }
    catch (error) { if (error.code !== 'ENOENT' || dirname(cur) === cur) throw error; rest.push(basename(cur)); }
  }
}
// 새 출력 디렉터리를 만든다. 문서함 안이면 Git 기록을 더럽히므로 만들기 전에 거절한다.
async function makeOutDir({ exportsRoot, docsRoot, docsRoots = [], docId, sha256 }) {
  const parent = await resolveReal(join(exportsRoot, ...docId.split('/')));
  for (const root of [...(docsRoot ? [docsRoot] : []), ...docsRoots]) {
    const docs = await resolveReal(root);
    if (parent === docs || parent.startsWith(docs + sep))
      throw coded('EXPORTS_INSIDE_DOCS', 'set LIDGE_HWP_EXPORTS outside every document root');
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const base = join(parent, stampName(sha256));
  for (let i = 0; i < 100; i++) {
    const dir = i ? `${base}-${i}` : base;
    try { await mkdir(dir, { mode: 0o700 }); return dir; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw coded('RENDER_FAILED', 'could not create output directory');
}

async function pool(items, fn, n = CONCURRENCY) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// kind: 'snapshot'(쪽별) | 'pdf'(문서 전체 한 파일). 실패하면 이번에 만든 출력 디렉터리만 지운다.
export async function renderDocument({ kind, bytes, format, docId, options, exportsRoot, docsRoot, docsRoots, rhwpBin,
    sipsBin = '/usr/bin/sips', deadline, platform = process.platform }) {
  const started = Date.now();
  if (format !== 'hwp' && format !== 'hwpx') throw coded('RENDER_ARGS_INVALID', 'format');
  let opts = null;
  if (kind === 'snapshot') opts = checkSnapshotOptions(options, platform);
  else if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length))
    throw coded('RENDER_ARGS_INVALID', 'exportPdf takes no options; use snapshot for single pages');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const tmp = await mkdtemp(join(tmpdir(), 'lidge-hwp-render-'));
  let dir = null;
  try {
    const src = join(tmp, `source.${format}`);
    await writeFile(src, bytes, { mode: 0o600 });
    dir = await makeOutDir({ exportsRoot, docsRoot, docsRoots, docId, sha256 });
    const pdf = async (out, page) => manifest(await run(rhwpBin,
      ['export-pdf', src, '-o', out, '--json', ...(page === undefined ? [] : ['-p', String(page)])], deadline));
    if (kind === 'pdf') {
      const out = join(dir, 'document.pdf');
      const m = await pdf(out);
      return { dir, path: out, pageCount: m.pageCount, bytes: (await stat(out)).size,
        sourceSha256: sha256, elapsedMs: Date.now() - started };
    }
    // 쪽 수는 CLI 조판이 기준이다(탭 조판과 다를 수 있다). 첫 요청 쪽을 뽑으면서 쪽 수를 읽는다.
    const want = opts.pages ?? [0];
    const first = await pdf(join(opts.pdf ? dir : tmp, pageFile(want[0], 'pdf')), want[0]).catch(error => {
      if (/범위|range/i.test(error.message)) throw coded('PAGE_OUT_OF_RANGE', `page ${want[0]}`);
      throw error;
    });
    const pageCount = first.pageCount;
    const list = opts.pages ?? Array.from({ length: pageCount }, (_, i) => i);
    const bad = list.filter(p => p >= pageCount);
    if (bad.length) throw coded('PAGE_OUT_OF_RANGE', `pages ${bad.slice(0, 5).join(',')} >= pageCount ${pageCount}`);
    if (list.length > MAX_SNAPSHOT_PAGES) throw coded('TOO_MANY_PAGES', `${pageCount} pages; pass pages (max ${MAX_SNAPSHOT_PAGES} per call)`);
    const pages = await pool(list, async (page, i) => {
      const pdfOut = join(opts.pdf ? dir : tmp, pageFile(page, 'pdf'));
      if (i > 0) await pdf(pdfOut, page);
      const entry = { page };
      if (opts.pdf) entry.pdf = pageFile(page, 'pdf');
      if (opts.png) {
        await run(sipsBin, ['-Z', String(opts.maxPx), '-s', 'format', 'png', pdfOut, '--out', join(dir, pageFile(page, 'png'))], deadline);
        entry.png = pageFile(page, 'png');
      }
      return entry;
    });
    return { dir, pageCount, pages, sourceSha256: sha256, elapsedMs: Date.now() - started };
  } catch (error) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
