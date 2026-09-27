import net from 'node:net';
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AGENT_SOCK } from '../../lib/config.mjs';
import { runAgent } from './runner.mjs';
export async function startAgentSocket({ store, tabs, config }) {
  const socketPath = config.socketPath ?? AGENT_SOCK;
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(socketPath), 0o700);
  try {
    const old = await lstat(socketPath);
    if (!old.isSocket()) throw new Error('agent path is not a socket');
    await new Promise((resolve, reject) => {
      const probe = net.connect(socketPath); probe.once('connect', () => { probe.destroy(); reject(new Error('agent already running')); });
      probe.once('error', e => e.code === 'ECONNREFUSED' ? resolve() : reject(e));
    });
    await unlink(socketPath);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const server = net.createServer(conn => {
    let input = ''; conn.setEncoding('utf8');
    conn.setTimeout(config.socketTimeoutMs ?? 240000, () => conn.destroy(new Error('SOCKET_TIMEOUT')));
    conn.on('data', chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > 131072) return conn.destroy();
      const end = input.indexOf('\n'); if (end < 0) return;
      const line = input.slice(0, end); input = '';
      conn.pause();
      Promise.resolve().then(() => JSON.parse(line)).then(req => {
        if (typeof req.id !== 'string' || typeof req.code !== 'string') throw new Error('invalid request');
        // 코드 뒤로 apply 120초 + PUT 꼬리 + release 45초(runner.mjs RELEASE_DEADLINE_MS)
        conn.setTimeout(Math.max(config.socketTimeoutMs ?? 240000, (req.timeoutMs ?? 30000) + 210000));
        return runAgent({ code: req.code, timeoutMs: req.timeoutMs }, { store, tabs, config })
          .then(out => ({ id: req.id, ...out }));
      }).catch(e => ({ id: null, ok: false, error: String(e.message ?? e), logs: [], elapsedMs: 0, saved: [] }))
        .then(out => conn.end(JSON.stringify(out) + '\n'));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return server;
}
