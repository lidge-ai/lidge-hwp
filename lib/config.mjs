import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.LIDGE_HWP_PORT || 10500);
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid LIDGE_HWP_PORT');
export const DOCS_ROOT = resolve(process.env.LIDGE_HWP_DOCS || join(homedir(), '.lidge-hwp', 'docs'));
export const RHWP_DIR = resolve(process.env.LIDGE_HWP_RHWP || join(ROOT, 'rhwp'));
export const BUILD_DIR = join(ROOT, 'build');
export const RUN_DIR = join(homedir(), '.lidge-hwp', 'run');
export const AGENT_SOCK = join(RUN_DIR, 'agent.sock');
// hwp.snapshot·hwp.exportPdf 결과 위치. 문서함(Git) 밖이어야 한다(lib/render.mjs가 확인).
export const EXPORTS_ROOT = resolve(process.env.LIDGE_HWP_EXPORTS || join(homedir(), '.lidge-hwp', 'exports'));
export const RHWP_BIN = resolve(process.env.LIDGE_HWP_RHWP_BIN || join(ROOT, 'bin', 'rhwp'));
const agentPutHold = Number(process.env.LIDGE_HWP_HOLD_AGENT_PUT_MS || 0);
if (!Number.isSafeInteger(agentPutHold) || agentPutHold < 0 || agentPutHold > 30000)
  throw new Error('Invalid LIDGE_HWP_HOLD_AGENT_PUT_MS');
export const AGENT_PUT_HOLD_MS = agentPutHold; // c-7 증거 절차에서만 켠다
