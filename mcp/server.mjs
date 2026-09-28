import net from 'node:net';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { AGENT_SOCK } from '../lib/config.mjs';
import { TOOL_SPEC as tool, SERVER_INSTRUCTIONS } from './tool.mjs';
import { imageBlocks } from './images.mjs';
function execute(args, id = randomUUID()) {
  return new Promise((resolve, reject) => {
    const client = net.connect(AGENT_SOCK); let data = '';
    client.setEncoding('utf8'); client.setTimeout(Math.max(240000, (args.timeoutMs ?? 30000) + 210000),
      () => client.destroy(new Error('agent timeout')));
    client.once('connect', () => client.write(JSON.stringify({ id, ...args }) + '\n'));
    client.on('data', chunk => { data += chunk; if (data.length > 131072) client.destroy(new Error('agent response too large')); });
    client.once('end', () => { try { resolve(JSON.parse(data.trim())); } catch (e) { reject(e); } });
    client.once('error', reject);
  });
}
// Aside 데몬(1.26.926.1637)은 tools/call을 60초에 끊는다. Aside 등록 항목만 이 값을 넣는다. 없으면 0이고 예전 동작 그대로다.
const CLIENT_DEADLINE_MS = Number(process.env.LIDGE_HWP_CLIENT_DEADLINE_MS || 0);
if (!Number.isSafeInteger(CLIENT_DEADLINE_MS) || CLIENT_DEADLINE_MS < 0 || (CLIENT_DEADLINE_MS > 0 && CLIENT_DEADLINE_MS < 6000))
  throw new Error('Invalid LIDGE_HWP_CLIENT_DEADLINE_MS');
async function callTool(args) {
  if (!CLIENT_DEADLINE_MS) return execute(args);
  const id = randomUUID();
  const requested = Number.isSafeInteger(args.timeoutMs) ? args.timeoutMs : 30000;
  const pending = execute({ ...args, timeoutMs: Math.min(requested, CLIENT_DEADLINE_MS - 5000) }, id);
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(resolve, CLIENT_DEADLINE_MS, null); });
  try {
    const out = await Promise.race([pending, late]);
    if (out !== null) return out;
  } finally { clearTimeout(timer); }
  // 소켓 요청은 끊지 않는다. 서버는 문서 잠금을 쥔 채 끝까지 처리하고, 그동안 같은 문서 재시도는 DOCUMENT_LOCKED다.
  pending.then(out => process.stderr.write(`[lidge-hwp] late result ${id} ok=${out?.ok === true}\n`),
    error => process.stderr.write(`[lidge-hwp] late error ${id} ${error.message}\n`));
  return { ok: false, error: 'CLIENT_DEADLINE', stillRunning: true, requestId: id, deadlineMs: CLIENT_DEADLINE_MS,
    advice: 'do not retry; check with hwp.cells/hwp.docs after a while' };
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
// hwp.snapshot(h,{inline:true})가 남긴 쪽 PNG는 텍스트 결과 뒤에 MCP 이미지 블록으로 붙는다(mcp/images.mjs).
async function toolResult(out) {
  const { images, ...rest } = out ?? {};
  const { blocks, skipped } = await imageBlocks(images);
  const body = skipped.length ? { ...rest, inlineSkipped: skipped } : rest;
  return { content: [{ type: 'text', text: JSON.stringify(body) }, ...blocks], isError: !out?.ok };
}
for await (const line of rl) {
  let request;
  try {
    request = JSON.parse(line);
    if (!('id' in request)) continue;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'lidge-hwp', version: '0.1.0' }, instructions: SERVER_INSTRUCTIONS };
    else if (request.method === 'tools/list') result = { tools: [tool] };
    else if (request.method === 'tools/call' && request.params?.name === 'hwp_exec') {
      result = await toolResult(await callTool(request.params.arguments ?? {}));
    } else throw Object.assign(new Error('method not found'), { rpcCode: -32601 });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null,
      error: { code: e.rpcCode ?? -32603, message: String(e.message ?? e) } }) + '\n');
  }
}
