#!/usr/bin/env node
// HWP/HWPX 표 칸 좌표 지도 출력.
// 사용법: node scripts/hwp-map.mjs <문서.hwp> [--empty] [--table N] [--json]
//   --empty   : 비어 있거나 안내문(예시)처럼 보이는 칸만
//   --table N : N번 표만
// 출력 좌표(table,row,col)는 rhwp plan 의 set_cell step 에 그대로 쓴다.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (!file) {
  console.error('usage: node scripts/hwp-map.mjs <file.hwp> [--empty] [--table N] [--json]');
  process.exit(2);
}
const onlyEmpty = args.includes('--empty');
const asJson = args.includes('--json');
const ti = args.indexOf('--table');
const onlyTable = ti >= 0 ? Number(args[ti + 1]) : null;

const rhwp = process.env.RHWP_BIN || [path.join(path.dirname(new URL(import.meta.url).pathname), '../bin/rhwp'), path.join(homedir(), '.local/bin/rhwp'), 'rhwp'].find((p) => p === 'rhwp' || existsSync(p));
const raw = execFileSync(rhwp, ['export-tables', file, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
const doc = JSON.parse(raw);

// 서식에 흔한 "예시/안내" 문구 — 채워야 할 칸일 가능성이 높다.
const HINT = /(작성|기입|예시|예\)|입력|※|OOO|○○|000|홍길동|고개척)/;

const rows = [];
for (const t of doc.tables) {
  if (onlyTable !== null && t.index !== onlyTable) continue;
  const where = t.containerPath?.length ? t.containerPath.map((c) => c.kind).join('>') : 'body';
  for (const c of t.cells) {
    const text = (c.text || '').replace(/\s+/g, ' ').trim();
    const empty = text === '';
    const hint = !empty && HINT.test(text);
    if (onlyEmpty && !empty && !hint) continue;
    // 같은 행에서 바로 왼쪽 칸 = 라벨일 가능성이 높다
    const left = t.cells.filter((x) => x.row === c.row && x.col + x.colSpan === c.col).map((x) => (x.text || '').trim())[0] || '';
    rows.push({ table: t.index, row: c.row, col: c.col, span: `${c.rowSpan}x${c.colSpan}`, where, label: left.slice(0, 20), state: empty ? 'EMPTY' : hint ? 'HINT' : '', text: text.slice(0, 60) });
  }
}

if (asJson) {
  console.log(JSON.stringify({ source: file, tableCount: doc.tableCount, cells: rows }, null, 1));
} else {
  console.log(`# ${file} — tables=${doc.tableCount}${onlyEmpty ? ' (empty/hint only)' : ''}`);
  console.log('table\trow\tcol\tspan\tstate\tlabel\t| text');
  for (const r of rows) console.log(`${r.table}\t${r.row}\t${r.col}\t${r.span}\t${r.state}\t${r.label}\t| ${r.text}`);
}
