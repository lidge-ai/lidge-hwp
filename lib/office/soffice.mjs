// LibreOffice headless 변환의 유일한 창구. soffice는 앱에 번들하지 않는다.
// 찾는 순서: LIDGE_HWP_SOFFICE → /Applications/LibreOffice.app → Codex 런타임에 딸린 LibreOfficeDev → PATH.
import { execFile } from 'node:child_process';
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const executable = path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
export function sofficeCandidates(env = process.env) {
  const list = [];
  if (env.LIDGE_HWP_SOFFICE) list.push(env.LIDGE_HWP_SOFFICE);
  list.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  list.push(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice'));
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) list.push(join(dir, 'soffice'));
  return list;
}
export function findSoffice(env = process.env) {
  if (env.LIDGE_HWP_SOFFICE) return executable(env.LIDGE_HWP_SOFFICE) ? env.LIDGE_HWP_SOFFICE : null;
  return sofficeCandidates(env).find(executable) ?? null;
}

const MAX_PARALLEL = 2;
let running = 0;
const waiting = [];
async function slot(task) {
  if (running >= MAX_PARALLEL) await new Promise(resolve => waiting.push(resolve));
  running += 1;
  try { return await task(); }
  finally { running -= 1; waiting.shift()?.(); }
}
const fail = (status, code, detail) => { throw Object.assign(new Error(code), { status, code, detail }); };
const EXT = /^[a-z0-9]{1,8}$/;

// 헤드리스 LibreOfficeDev(fontconfig 사용)는 macOS 시스템 글꼴을 못 찾아 PDF에서 한글이 빠진다(실측).
// macOS 글꼴 폴더를 가리키는 fontconfig 설정을 한 번 만들어 자식 프로세스에 준다. 사용자가 FONTCONFIG_FILE을 정했으면 그대로 둔다.
let fontConfig = null;
export function fontConfigFile() {
  if (fontConfig) return fontConfig;
  const dir = join(tmpdir(), 'jongi-fontconfig');
  mkdirSync(join(dir, 'cache'), { recursive: true });
  const dirs = ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', join(homedir(), 'Library/Fonts')];
  const xml = '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n'
    + dirs.map(d => '  <dir>' + d + '</dir>\n').join('') + '  <cachedir>' + join(dir, 'cache') + '</cachedir>\n</fontconfig>\n';
  writeFileSync(join(dir, 'fonts.conf'), xml);
  fontConfig = join(dir, 'fonts.conf');
  return fontConfig;
}
const childEnv = () => (process.env.FONTCONFIG_FILE ? process.env : { ...process.env, FONTCONFIG_FILE: fontConfigFile() });

// bytes(from 형식) → to 형식 바이트. filter는 LibreOffice 내보내기 필터 이름(선택).
export async function convert(bytes, { from, to, filter = null, timeoutMs = 60000, bin = findSoffice() } = {}) {
  if (!EXT.test(from ?? '') || !EXT.test(to ?? '')) fail(400, 'INVALID_FORMAT');
  if (!bin) fail(503, 'SOFFICE_UNAVAILABLE');
  return slot(async () => {
    const work = await mkdtemp(join(tmpdir(), 'jongi-soffice-'));
    try {
      const input = join(work, 'in.' + from);
      const outDir = join(work, 'out');
      await writeFile(input, bytes);
      const args = ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
        '-env:UserInstallation=' + pathToFileURL(join(work, 'profile')).href,
        '--convert-to', filter ? to + ':' + filter : to, '--outdir', outDir, input];
      const stderr = await new Promise(resolve => {
        execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: childEnv() }, (error, _stdout, err) =>
          resolve(error ? String(err || error.message).slice(-400) : ''));
      });
      const files = await readdir(outDir).catch(() => []);
      const name = files.find(file => file.toLowerCase() === 'in.' + to);
      if (!name) fail(502, 'CONVERT_FAILED', stderr || 'no output');
      const out = await readFile(join(outDir, name));
      if (!out.length) fail(502, 'CONVERT_FAILED', 'empty output');
      return out;
    } finally {
      // 우리가 mkdtemp로 만든 작업 폴더만 지운다.
      await rm(work, { recursive: true, force: true });
    }
  });
}
