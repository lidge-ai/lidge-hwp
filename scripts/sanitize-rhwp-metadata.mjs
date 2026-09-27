#!/usr/bin/env node
// Source-artifact hygiene for exactly three vendored templates, not user documents.
// Run after vendoring and before compiling include_bytes! assets:
//   node scripts/sanitize-rhwp-metadata.mjs --root <vendor-root> --apply
//   node scripts/sanitize-rhwp-metadata.mjs [--root <vendor-root>] [--check]
// Exit 0: sanitized; 1: check found unsanitized metadata; 2: invalid input/usage.
// Threat: public source/binaries expose template authors and workstation paths.
// Only parsed string payloads may change. A masked SHA-256 pins all other bytes;
// upstream structural changes require review, never a best-effort rewrite.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = new Map([
  ['saved/blank2010.hwp', { size: 13824, structure: 'e389f9394fe9dcfb6e14fe8eb0c99039b4bf29d8a73d225d81067d34b2b7cffc' }],
  ['src/parser/hwpx/blank2010_assets/hwp_summary_information.bin',
    { size: 461, structure: 'd90b7a619552af34b9b2be05258c8b2e6f6bca867eb338d6834a04e7d9c6b255' }],
  ['src/parser/hwpx/blank2010_assets/doc_options_link_doc.bin',
    { size: 524, structure: '48e64ee0dc74617bd4bc747301c70dc47738459c4ce430dca101f70a0fdb36c0' }],
]);
const END = 0xfffffffe;
const FREE = 0xffffffff;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function requireValid(condition, reason) {
  if (!condition) throw new Error(reason); // Never include input bytes or PII.
}

// This is deliberately a bounded CFB v3 reader for the pinned blank template.
// It follows FAT/miniFAT chains and directory links; it never serializes the CFB.
function cfbStreams(bytes) {
  requireValid(bytes.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1', 'Invalid CFB signature');
  requireValid(bytes.readUInt16LE(26) === 3 && bytes.readUInt16LE(28) === 0xfffe
    && bytes.readUInt16LE(30) === 9 && bytes.readUInt16LE(32) === 6
    && bytes.readUInt32LE(56) === 4096 && bytes.readUInt32LE(72) === 0,
  'Unsupported CFB layout');
  const sectorCount = bytes.length / 512 - 1;
  const sector = (id) => {
    requireValid(Number.isInteger(id) && id >= 0 && id < sectorCount, 'Invalid CFB sector');
    return bytes.subarray((id + 1) * 512, (id + 2) * 512);
  };
  const fatCount = bytes.readUInt32LE(44);
  requireValid(fatCount > 0 && fatCount <= 109, 'Unsupported FAT count');
  const fat = Buffer.concat(Array.from({ length: fatCount }, (_, i) => sector(bytes.readUInt32LE(76 + i * 4))));
  function chain(start, table, limit) {
    const result = [];
    const seen = new Set();
    for (let id = start; id !== END; id = table.readUInt32LE(id * 4)) {
      requireValid(id < limit && id * 4 + 4 <= table.length && !seen.has(id), 'Invalid or cyclic CFB chain');
      seen.add(id);
      result.push(id);
    }
    return result;
  }
  const directory = Buffer.concat(chain(bytes.readUInt32LE(48), fat, sectorCount).map(sector));
  const entries = [];
  for (let off = 0; off < directory.length; off += 128) {
    const type = directory[off + 66];
    const nameLength = directory.readUInt16LE(off + 64);
    requireValid(type === 0 || (nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0), 'Invalid CFB directory name');
    const size = directory.readBigUInt64LE(off + 120);
    requireValid(size <= BigInt(bytes.length), 'Invalid CFB stream size');
    entries.push({ type, name: directory.toString('utf16le', off, off + Math.max(0, nameLength - 2)),
      left: directory.readUInt32LE(off + 68), right: directory.readUInt32LE(off + 72),
      child: directory.readUInt32LE(off + 76), start: directory.readUInt32LE(off + 116), size: Number(size) });
  }
  const root = entries[0];
  requireValid(root?.type === 5, 'Missing CFB root');
  const miniRoot = chain(root.start, fat, sectorCount);
  requireValid(miniRoot.length === Math.ceil(root.size / 512), 'Invalid CFB mini-stream length');
  const miniFatChain = chain(bytes.readUInt32LE(60), fat, sectorCount);
  requireValid(miniFatChain.length === bytes.readUInt32LE(64), 'Invalid miniFAT length');
  const miniFat = Buffer.concat(miniFatChain.map(sector));
  const streams = new Map();
  const visited = new Set([0]);
  const occupied = new Set();
  function visit(id, parent) {
    if (id === FREE) return;
    requireValid(id < entries.length && !visited.has(id), 'Invalid CFB directory tree');
    visited.add(id);
    const entry = entries[id];
    requireValid(entry.type === 1 || entry.type === 2, 'Unsupported CFB directory type');
    visit(entry.left, parent);
    const path = parent + entry.name;
    if (entry.type === 1) visit(entry.child, path + '/');
    else {
      const mini = entry.size < 4096;
      const unit = mini ? 64 : 512;
      const blocks = chain(entry.start, mini ? miniFat : fat, mini ? root.size / 64 : sectorCount);
      requireValid(blocks.length === Math.ceil(entry.size / unit), 'Invalid CFB stream chain length');
      const offsets = Array.from({ length: entry.size }, (_, i) => {
        const logical = blocks[Math.floor(i / unit)] * unit + i % unit;
        const physical = mini ? (miniRoot[Math.floor(logical / 512)] + 1) * 512 + logical % 512 : logical + 512;
        requireValid(physical < bytes.length && !occupied.has(physical), 'Overlapping CFB streams');
        occupied.add(physical);
        return physical;
      });
      requireValid(!streams.has(path), 'Duplicate CFB stream');
      streams.set(path, { bytes: Buffer.from(offsets.map((off) => bytes[off])), offsets });
    }
    visit(entry.right, parent);
  }
  visit(root.child, '');
  requireValid(entries.every((entry, id) => entry.type === 0 || visited.has(id)), 'Unreachable CFB directory entry');
  return streams;
}

function summaryEdits(bytes) {
  requireValid(bytes.length >= 48 && bytes.readUInt16LE(0) === 0xfffe
    && bytes.readUInt32LE(24) === 1, 'Unsupported property-set header');
  const section = bytes.readUInt32LE(44);
  requireValid(section >= 48 && section + 8 <= bytes.length, 'Invalid property section offset');
  const end = section + bytes.readUInt32LE(section);
  const count = bytes.readUInt32LE(section + 4);
  const tableEnd = section + 8 + count * 8;
  requireValid(end === bytes.length && count >= 2 && tableEnd <= end, 'Invalid property table');
  const properties = [];
  const ids = new Set();
  for (let i = 0; i < count; i++) {
    const id = bytes.readUInt32LE(section + 8 + i * 8);
    const off = section + bytes.readUInt32LE(section + 12 + i * 8);
    requireValid(!ids.has(id) && off >= tableEnd && off + 4 <= end && off % 4 === 0, 'Invalid property offset or ID');
    ids.add(id);
    properties.push({ id, off });
  }
  properties.sort((a, b) => a.off - b.off);
  requireValid(properties.every((p, i) => i === 0 || p.off > properties[i - 1].off), 'Overlapping properties');
  return [4, 8].map((id) => {
    const index = properties.findIndex((property) => property.id === id);
    requireValid(index >= 0, 'Missing author property');
    const off = properties[index].off;
    const next = properties[index + 1]?.off ?? end;
    requireValid(off + 8 <= next && bytes.readUInt32LE(off) === 31, 'Unsupported author property type');
    const count = bytes.readUInt32LE(off + 4);
    requireValid(count >= 5 && count <= 256 && off + 8 + count * 2 <= next, 'Invalid author string length');
    requireValid(bytes.readUInt16LE(off + 8 + (count - 1) * 2) === 0, 'Missing author string terminator');
    return { off: off + 8, value: Buffer.from('anon'.padEnd(count - 1, '_'), 'utf16le') };
  });
}

function linkEdits(bytes) {
  // The pinned _LinkDoc has a u16 prefix followed by a NUL-terminated UTF-16
  // path. Preserve its terminator, padding and opaque tail exactly. Replacing
  // it with a same-length relative .hwp basename removes workstation paths.
  requireValid(bytes.length === 524 && bytes.readUInt16LE(0) === 0, 'Unsupported LinkDoc layout');
  let end = 2;
  while (end + 1 < bytes.length && bytes.readUInt16LE(end) !== 0) end += 2;
  const chars = (end - 2) / 2;
  requireValid(chars === 52 && end + 2 <= bytes.length, 'Unexpected LinkDoc path extent');
  return [{ off: 2, value: Buffer.from('blank-' + 'x'.repeat(chars - 10) + '.hwp', 'utf16le') }];
}

// Pure buffer API also permits a vendor caller to inspect a plan before writing.
export function sanitizeAsset(path, input) {
  const spec = ASSETS.get(path);
  requireValid(spec && Buffer.isBuffer(input) && input.length === spec.size, 'Unknown asset or unexpected size');
  const edits = [];
  function add(stream, changes) {
    for (const change of changes) {
      const offsets = Array.from({ length: change.value.length }, (_, i) => stream ? stream.offsets[change.off + i] : change.off + i);
      requireValid(offsets.every((off) => Number.isInteger(off) && off >= 0 && off < input.length), 'Invalid edit extent');
      edits.push({ offsets, value: change.value });
    }
  }
  if (path.endsWith('.hwp')) {
    const streams = cfbStreams(input);
    const summary = streams.get('\u0005HwpSummaryInformation');
    const link = streams.get('DocOptions/_LinkDoc');
    requireValid(summary && link && streams.has('BodyText/Section0'), 'Missing template streams');
    add(summary, summaryEdits(summary.bytes));
    add(link, linkEdits(link.bytes));
  } else if (path.endsWith('hwp_summary_information.bin')) add(null, summaryEdits(input));
  else add(null, linkEdits(input));
  const masked = Buffer.from(input);
  const output = Buffer.from(input);
  for (const { offsets, value } of edits) offsets.forEach((off, i) => {
    masked[off] = 0;
    output[off] = value[i];
  });
  requireValid(sha256(masked) === spec.structure, 'Template structural fingerprint changed; review upstream asset before sanitizing');
  return output;
}

function main(args) {
  let mode = '--check';
  let explicitMode = false;
  let explicitRoot = false;
  let root = fileURLToPath(new URL('../rhwp/', import.meta.url));
  while (args.length) {
    const arg = args.shift();
    if (arg === '--root') {
      requireValid(!explicitRoot && args[0] && !args[0].startsWith('--'), 'Invalid root argument');
      root = resolve(args.shift());
      explicitRoot = true;
    } else {
      requireValid(!explicitMode && (arg === '--apply' || arg === '--check'), 'Invalid mode argument');
      mode = arg;
      explicitMode = true;
    }
  }
  root = realpathSync(root);
  // Validate every asset before the first write. Refuse links so an imported
  // vendor tree cannot redirect this operation into original/private documents.
  const plans = [...ASSETS.keys()].map((path) => {
    let file = root;
    for (const part of path.split('/')) {
      file = join(file, part);
      requireValid(!lstatSync(file).isSymbolicLink(), 'Symlink in asset path');
    }
    const stat = lstatSync(file);
    requireValid(stat.isFile() && stat.nlink === 1, 'Asset must be a regular, unshared file');
    const before = readFileSync(file);
    return { path, file, before, after: sanitizeAsset(path, before) };
  });
  for (const plan of plans) requireValid(readFileSync(plan.file).equals(plan.before), 'Asset changed during validation');
  for (const { path, file, before, after } of plans) {
    const changed = !before.equals(after);
    if (mode === '--apply' && changed) {
      writeFileSync(file, after);
      requireValid(readFileSync(file).equals(after), 'Asset write verification failed');
    }
    console.log(JSON.stringify({ path, status: changed ? (mode === '--apply' ? 'sanitized' : 'needs-sanitization') : 'clean',
      bytes: before.length, beforeSha256: sha256(before), afterSha256: sha256(after) }));
  }
  return mode === '--check' && plans.some(({ before, after }) => !before.equals(after)) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch {
    // OS errors may contain absolute private paths; do not echo their messages.
    console.error('Metadata sanitization refused: invalid arguments, asset access, or unrecognized template structure. No metadata values are logged.');
    process.exitCode = 2;
  }
}
