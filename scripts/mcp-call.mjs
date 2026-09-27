#!/usr/bin/env node
// hwp_exec MCP stdio 점검 도구: node scripts/mcp-call.mjs '<code>' ['<code>' ...]
// initialize → tools/list → 각 code마다 tools/call hwp_exec 를 순서대로 보낸다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
const codes = process.argv.slice(2);
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  }
});
const send = (id, method, params) => new Promise((resolve) => {
  if (id !== null) pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id !== null ? { id } : {}), method, params }) + '\n');
  if (id === null) resolve(null);
});

const init = await send(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-call', version: '0' } });
console.log('INIT', JSON.stringify(init.result.serverInfo), init.result.protocolVersion);
await send(null, 'notifications/initialized', {});
const list = await send(2, 'tools/list', {});
console.log('TOOLS', list.result.tools.map((tool) => tool.name).join(','));
let id = 3;
for (const code of codes) {
  const reply = await send(id++, 'tools/call', { name: 'hwp_exec', arguments: { code } });
  console.log('CALL', JSON.stringify(reply.result ?? reply.error));
}
child.stdin.end();
