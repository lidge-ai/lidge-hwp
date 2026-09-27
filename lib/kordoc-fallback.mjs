import { openHwpxDocument, patchHwp, parse, blocksToMarkdown } from 'kordoc';
import { openDocument } from './rhwp-node.mjs';
import { resolveCell, cellText, tableAddresses } from './cells.mjs';
import { sha } from './ops.mjs';

export async function fallbackPatch(original, format, ops) {
  // kordoc 보조 저장은 칸 하나 쓰기만 보존을 증명했다(wp2). 그 밖의 op는 저장 전에 거절한다.
  if (ops.length !== 1 || ops[0].kind !== 'setCell') throw Object.assign(new Error('FALLBACK_UNSUPPORTED_OP'), { code: 'FALLBACK_UNSUPPORTED_OP' });
  const op = ops[0], { table, row, col } = op.logical;
  const oldDoc = await openDocument(original);
  try {
    if (sha(cellText(oldDoc, resolveCell(oldDoc, table, row, col))) !== op.beforeSha256)
      throw new Error('fallback preimage mismatch');
    const expectedTables = tableAddresses(oldDoc).length;
    let result;
    if (format === 'hwpx') {
      const session = await openHwpxDocument(original);
      const tables = session.blocks.map((b, blockIndex) => ({ b, blockIndex })).filter(x => x.b.type === 'table');
      if (tables.length !== expectedTables) throw new Error('fallback table mapping mismatch');
      const entry = tables[table];
      if (!entry?.b.table?.cells[row]?.[col]) throw new Error('fallback cell mapping mismatch');
      result = await session.patchBlocks([{ blockIndex: entry.blockIndex,
        cells: [{ row, col, text: op.args.text }] }], { verify: true });
    } else if (format === 'hwp') {
      const parsed = await parse(Buffer.from(original));
      if (!parsed.success) throw new Error(parsed.error);
      const tables = parsed.blocks.filter(b => b.type === 'table');
      if (tables.length !== expectedTables) throw new Error('fallback table mapping mismatch');
      const cell = tables[table]?.table?.cells[row]?.[col];
      if (!cell) throw new Error('fallback cell mapping mismatch');
      cell.text = op.args.text;
      result = await patchHwp(original, blocksToMarkdown(parsed.blocks), { verify: true });
      const stats = result.verification?.stats;
      if (!stats || stats.added || stats.removed || stats.modified)
        throw new Error('fallback markdown verification failed');
    } else throw new Error('unsupported format');
    if (!result.success || !result.data || result.skipped.length || result.applied < 1)
      throw new Error(`fallback refused: ${result.error ?? result.skipped.map(s => s.reason).join('; ')}`);
    const check = await openDocument(result.data);
    try {
      const actual = cellText(check, resolveCell(check, table, row, col));
      if (actual !== op.args.text) throw new Error('fallback target verification failed');
    } finally { check.free(); }
    return result.data;
  } finally { oldDoc.free(); }
}
