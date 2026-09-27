import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, type AgentBatch, type AgentOpsDeps } from '../src/lidge/agent-ops.ts';

test('initial state read failure is recovered before snapshot dispatch', async () => {
  let dispatches = 0;
  const batch = {
    schemaVersion: 1, commandId: 'preflight', token: 'token',
    base: { diskSha256: 'a'.repeat(64), documentEpoch: 1, changeSeq: 0, exportSha256: 'b'.repeat(64) },
    ops: [{ kind: 'insertText', logical: { section: 0, paragraph: 0 },
      resolved: { section: 0, para: 0, control: null, cell: null, offset: 0, length: 0 },
      beforeSha256: 'c'.repeat(64), args: { section: 0, paragraph: 0, offset: 0, text: 'x' } }],
  } as AgentBatch;
  const deps = {
    lock: { assertAgent(token: string) { assert.equal(token, 'token'); } },
    controller: { getDocumentState() { throw new Error('state unavailable'); } },
    input: { async executeDocumentAgentOperation() { dispatches += 1; } },
  } as unknown as AgentOpsDeps;
  await assert.rejects(() => applyOps(batch, deps), (error: unknown) => {
    const e = error as { code?: string; message?: string; recovered?: boolean };
    return e.code === 'INITIAL_STATE_READ_FAILED' && e.message === 'state unavailable' && e.recovered === true;
  });
  assert.equal(dispatches, 0);
});
