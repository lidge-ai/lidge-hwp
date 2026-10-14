// office_exec MCP 서버(stdio). hwp_exec 서버(mcp/server.mjs)와 따로 등록한다: 같은 에이전트 소켓에 tool:'office'로 보낸다.
// 등록 예: { "command": "node", "args": ["<repo>/mcp/office-server.mjs"] }
import net from 'node:net';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { AGENT_SOCK } from '../lib/config.mjs';

export const OFFICE_TOOL_SPEC = Object.freeze({
  name: 'office_exec',
  description: 'Run an async JavaScript body against one office document (xlsx, xls, ods, csv, Numbers, docx, odt, rtf, doc; slides and Pages read-only) in the Jongi (종이) library. The only global is office: list ids with await office.docs(), then const h = await office.open(id). ' +
    "Sheets: office.sheets(h), office.read(h,{sheet?,range:'A1:C10'}), office.setCells(h,{sheet?,start:'B2',values:[[1,'text','=B2*2']]}) ('=' starts a formula; xls/numbers/csv reject formulas). " +
    'Documents: office.paragraphs(h), office.find(h,{query}), office.replaceText(h,{find,replace,expectedCount?}), office.appendParagraph(h,{text}). office.info(h) works for every format. ' +
    'Finish with await office.save(h); nothing is written unless the whole call succeeds and the reopened result matches (AGENT_VERIFY_MISMATCH otherwise). One document per call. HWP/HWPX use hwp_exec. await office.help() lists everything. Return a small value (<=64 KiB).',
  inputSchema: { type: 'object', properties: { code: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 } }, required: ['code'], additionalProperties: false },
});
export const OFFICE_INSTRUCTIONS = [
  'Jongi (종이) office_exec edits spreadsheets and word-processing documents in the local Jongi library. Each call runs a JavaScript body with a single global office and works on one document.',
  'Workflow: office.docs() -> office.open(id) -> office.info(h) -> read (office.read / office.paragraphs) -> edit (office.setCells / office.replaceText / office.appendParagraph) -> office.save(h) last.',
  'If any office call fails, the whole call is rolled back and nothing is saved: read error, code and details, fix the code and run it again. Saves are committed to the document history with author agent; an open editor tab reloads the document unless it has unsaved edits.',
].join('\n');

function execute(args, id = randomUUID()) {
  return new Promise((resolve, reject) => {
    const client = net.connect(AGENT_SOCK); let data = '';
    client.setEncoding('utf8');
    client.setTimeout(Math.max(240000, (args.timeoutMs ?? 30000) + 210000), () => client.destroy(new Error('agent timeout')));
    client.once('connect', () => client.write(JSON.stringify({ id, tool: 'office', ...args }) + '\n'));
    client.on('data', chunk => { data += chunk; if (data.length > 131072) client.destroy(new Error('agent response too large')); });
    client.once('end', () => { try { resolve(JSON.parse(data.trim())); } catch (e) { reject(e); } });
    client.once('error', reject);
  });
}
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
  pending.then(out => process.stderr.write('[jongi-office] late result ' + id + ' ok=' + (out?.ok === true) + '\n'),
    error => process.stderr.write('[jongi-office] late error ' + id + ' ' + error.message + '\n'));
  return { ok: false, error: 'CLIENT_DEADLINE', stillRunning: true, requestId: id, deadlineMs: CLIENT_DEADLINE_MS,
    advice: 'do not retry; check with office.info/office.read after a while' };
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === (await import('node:fs')).realpathSync(process.argv[1]);
if (isMain) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    let request;
    try {
      request = JSON.parse(line);
      if (!('id' in request)) continue;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'jongi-office', version: '0.1.0' }, instructions: OFFICE_INSTRUCTIONS };
      else if (request.method === 'tools/list') result = { tools: [OFFICE_TOOL_SPEC] };
      else if (request.method === 'tools/call' && request.params?.name === 'office_exec') {
        const out = await callTool(request.params.arguments ?? {});
        result = { content: [{ type: 'text', text: JSON.stringify(out) }], isError: !out?.ok };
      } else throw Object.assign(new Error('method not found'), { rpcCode: -32601 });
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null,
        error: { code: e.rpcCode ?? -32603, message: String(e.message ?? e) } }) + '\n');
    }
  }
}

