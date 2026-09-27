import { execFile } from 'node:child_process';

export const PICK_SCRIPT = 'POSIX path of (choose folder with prompt "LIDGE HWP에 추가할 폴더를 고르세요")';
const failed = (status, code) => Object.assign(new Error(code), { status, code });

export function pickFolder({ execFileImpl = execFile, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl('/usr/bin/osascript', ['-e', PICK_SCRIPT],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        if (!error) {
          const path = String(stdout).replace(/\r?\n$/, '');
          if (!path) reject(failed(500, 'PICK_FAILED'));
          else resolve(path);
          return;
        }
        if (/-128\b/.test(String(stderr))) { resolve(null); return; }
        reject(error.killed || error.signal ? failed(504, 'PICK_TIMEOUT') : failed(500, 'PICK_FAILED'));
      });
  });
}
