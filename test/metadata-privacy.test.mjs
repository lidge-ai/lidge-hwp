import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import CFB from 'cfb'; // Existing kordoc dependency; independent CFB reader.
import { sanitizeAsset } from '../scripts/sanitize-rhwp-metadata.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RHWP = ROOT + 'rhwp/';
const SCRIPT = ROOT + 'scripts/sanitize-rhwp-metadata.mjs';
const HWP = 'saved/blank2010.hwp';
const SUMMARY = 'src/parser/hwpx/blank2010_assets/hwp_summary_information.bin';
const LINK = 'src/parser/hwpx/blank2010_assets/doc_options_link_doc.bin';
const LINK_NAME = 'blank-' + 'x'.repeat(42) + '.hwp';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const load = (path) => readFileSync(RHWP + path);

// Measured from the original assets BEFORE sanitization. Only digests and
// structural offsets are retained: no private author names, paths or fixtures.
// Static extents here are an independent oracle; production follows the CFB
// directory/FAT and property tables instead of using these offsets.
const BASELINES = [
  { path: HWP, size: 13824, payloads: [[4360, 10], [4468, 10], [12802, 104]],
    maskedHash: 'e389f9394fe9dcfb6e14fe8eb0c99039b4bf29d8a73d225d81067d34b2b7cffc' },
  { path: SUMMARY, size: 461, payloads: [[200, 12], [312, 12]],
    maskedHash: 'd90b7a619552af34b9b2be05258c8b2e6f6bca867eb338d6834a04e7d9c6b255' },
  { path: LINK, size: 524, payloads: [[2, 104]],
    maskedHash: '48e64ee0dc74617bd4bc747301c70dc47738459c4ce430dca101f70a0fdb36c0' },
];

function authorProperties(bytes) {
  const section = bytes.readUInt32LE(44);
  const result = new Map();
  for (let i = 0; i < bytes.readUInt32LE(section + 4); i++) {
    const id = bytes.readUInt32LE(section + 8 + i * 8);
    if (id !== 4 && id !== 8) continue;
    const off = section + bytes.readUInt32LE(section + 12 + i * 8);
    assert.equal(bytes.readUInt32LE(off), 31);
    const chars = bytes.readUInt32LE(off + 4);
    assert.equal(bytes.readUInt16LE(off + 8 + (chars - 1) * 2), 0);
    result.set(id, bytes.toString('utf16le', off + 8, off + 8 + (chars - 1) * 2));
  }
  return result;
}

test('vendored metadata is anonymous and both LinkDoc copies agree', () => {
  const cfb = CFB.read(load(HWP), { type: 'buffer' });
  const summary = CFB.find(cfb, '\u0005HwpSummaryInformation').content;
  assert.deepEqual(authorProperties(summary), new Map([[4, 'anon_'], [8, 'anon_']]));
  assert.deepEqual(authorProperties(load(SUMMARY)), new Map([[4, 'anon__'], [8, 'anon__']]));
  const link = load(LINK);
  assert.ok(CFB.find(cfb, 'Root Entry/DocOptions/_LinkDoc').content.equals(link));
  assert.equal(link.toString('utf16le', 2, 106), LINK_NAME);
  assert.equal(link.readUInt16LE(106), 0);
  assert.doesNotMatch(LINK_NAME, /[:\\/]/);
});

test('every byte outside the original metadata payloads remains unchanged', () => {
  for (const { path, size, payloads, maskedHash } of BASELINES) {
    const bytes = load(path);
    assert.equal(bytes.length, size, path);
    for (const [off, length] of payloads) bytes.fill(0, off, off + length);
    assert.equal(hash(bytes), maskedHash, path);
  }
});

test('independent CFB reader validates the original body and all structural streams', () => {
  const cfb = CFB.read(load(HWP), { type: 'buffer' });
  const expected = new Map([
    ['FileHeader', [256, 'cfb806a1fd4ee8680b1d738aea175b8558170136b3089f55994a143aa22a0878']],
    ['DocInfo', [1552, 'd09ab24dc40a700df2e00878e67829de889fa3e90e69f331928ced7cca78cc59']],
    ['BodyText/Section0', [189, '820544fd7585a452b6bf2c1154f16d8cfb6c05a3d0aba0c2c88fc475786e0c8a']],
    ['PrvImage', [5126, '2103d51fb863769afce086d2aa45eda343808e1c478527a9d40b3dfbebe513c6']],
    ['PrvText', [4, 'b7f560303ee2cca55615b53fcff87c6ab2c55f9e71a6cea93c61b572213e7075']],
    ['Scripts/JScriptVersion', [13, '1322438fbe7c693f50ae634db95d80567379557dea3a970e75d06e63a0e16b55']],
    ['Scripts/DefaultJScript', [16, '1b4833c1d5a47fcf6cc76e769cf6b12b27401152387d99dfd313469881bcf590']],
  ]);
  assert.equal(cfb.FileIndex.filter((entry) => entry.type === 2).length, 9);
  for (const [path, [size, digest]] of expected) {
    const stream = CFB.find(cfb, 'Root Entry/' + path);
    assert.ok(stream, path);
    assert.equal(stream.size, size, path);
    assert.equal(hash(stream.content), digest, path);
  }
});

test('synthetic identities and paths are removed, preserving layouts and inputs', () => {
  for (const { path, payloads } of BASELINES) {
    const clean = load(path);
    const synthetic = Buffer.from(clean);
    for (const [off, length] of payloads) {
      const replacement = length === 104 ? 'Z:\\' + 'q'.repeat(45) + '.hwp'
        : length === 10 ? 'guest' : 'tester';
      assert.equal(Buffer.byteLength(replacement, 'utf16le'), length);
      synthetic.write(replacement, off, length, 'utf16le');
    }
    const before = Buffer.from(synthetic);
    assert.ok(!synthetic.equals(clean));
    const once = sanitizeAsset(path, synthetic);
    assert.ok(synthetic.equals(before), 'pure API must not mutate its input');
    assert.ok(once.equals(clean), path);
    assert.ok(sanitizeAsset(path, once).equals(once), 'second pass must be identical');
  }
});

test('malformed property tables and unsupported drift fail without mutation', () => {
  const corruptions = [
    [24, 2], // Extra property set.
    [44, 0xffffffff], // Section out of bounds.
    [52, 0xffffffff], // Table count out of bounds.
    [76, 4], // Property points into its table.
    [72, 3], // Duplicate property ID, author missing.
    [192, 30], // Unexpected author variant type.
    [196, 0xffffffff], // String extends past the property.
    [212, 1], // Non-NUL terminator.
    [432, 4], // Unrelated property changed.
  ];
  for (const [off, value] of corruptions) {
    const bytes = load(SUMMARY);
    bytes.writeUInt32LE(value, off);
    const before = Buffer.from(bytes);
    assert.throws(() => sanitizeAsset(SUMMARY, bytes), Error);
    assert.ok(bytes.equals(before));
  }
});

test('invalid CFB chains, headers, LinkDoc extents and out-of-scope assets fail closed', () => {
  const hwp = load(HWP);
  const cyclicFat = Buffer.from(hwp);
  const fatStart = (hwp.readUInt32LE(76) + 1) * 512;
  cyclicFat.writeUInt32LE(7, fatStart + 7 * 4); // Root mini-stream loops.
  const cyclicMiniFat = Buffer.from(hwp);
  const miniFatStart = (hwp.readUInt32LE(60) + 1) * 512;
  cyclicMiniFat.writeUInt32LE(40, miniFatStart + 40 * 4); // LinkDoc loops.
  const badHeader = Buffer.from(hwp);
  badHeader[0] = 0;
  for (const bytes of [cyclicFat, cyclicMiniFat, badHeader, hwp.subarray(0, 512)]) {
    assert.throws(() => sanitizeAsset(HWP, bytes), Error);
  }
  const badLink = load(LINK);
  badLink.writeUInt16LE(0, 6);
  assert.throws(() => sanitizeAsset(LINK, badLink), /LinkDoc/);
  assert.throws(() => sanitizeAsset('../server/documents/example.hwp', hwp), /Unknown asset/);
});

test('CLI defaults to read-only, supports vendor --root, and explicit apply is idempotent', () => {
  const before = BASELINES.map(({ path }) => [hash(load(path)), statSync(RHWP + path).mtimeMs]);
  for (const args of [[], ['--root', RHWP, '--check'], ['--root', RHWP, '--apply']]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(report.map(({ path }) => path), BASELINES.map(({ path }) => path));
    assert.ok(report.every((row) => row.status === 'clean' && row.beforeSha256 === row.afterSha256));
  }
  const after = BASELINES.map(({ path }) => [hash(load(path)), statSync(RHWP + path).mtimeMs]);
  assert.deepEqual(after, before, 'check and clean apply must not rewrite files');
});

test('ambiguous or unknown CLI arguments fail without changing assets or leaking input', () => {
  const before = BASELINES.map(({ path }) => hash(load(path)));
  for (const args of [['--apply', '--check'], ['--root'], ['--root', RHWP, '--root', RHWP],
    ['--arbitrary-option'], ['--root', '/does-not-exist/synthetic-user', '--apply']]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /synthetic-user/);
  }
  assert.deepEqual(BASELINES.map(({ path }) => hash(load(path))), before);
});
