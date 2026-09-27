import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('LIDGE_HWP_')) delete env[key];
  return { ...env, ...overrides };
}
function config(overrides = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import * as config from ${JSON.stringify(new URL('../lib/config.mjs', import.meta.url).href)};
console.log(JSON.stringify(config));`], { cwd: ROOT, env: cleanEnv(overrides), encoding: 'utf8' });
}

test('configuration defaults use the home directory and bundled fork', () => {
  const home = join(tmpdir(), 'lidge-config-home');
  const result = config({ HOME: home });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.DOCS_ROOT, join(home, '.lidge-hwp', 'docs'));
  assert.equal(actual.RUN_DIR, join(home, '.lidge-hwp', 'run'));
  assert.equal(actual.RHWP_DIR, resolve(ROOT, 'rhwp'));
  assert.equal(actual.HOST, '127.0.0.1');
  assert.equal(actual.PORT, 10500);
  assert.equal(actual.AGENT_PUT_HOLD_MS, 0);
});

test('configuration accepts document, fork, port and hold overrides', () => {
  const result = config({ LIDGE_HWP_DOCS: 'custom docs', LIDGE_HWP_RHWP: 'custom fork',
    LIDGE_HWP_PORT: '12345', LIDGE_HWP_HOLD_AGENT_PUT_MS: '700' });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.DOCS_ROOT, resolve(ROOT, 'custom docs'));
  assert.equal(actual.RHWP_DIR, resolve(ROOT, 'custom fork'));
  assert.equal(actual.PORT, 12345);
  assert.equal(actual.AGENT_PUT_HOLD_MS, 700);
});

test('empty document override falls back to home and invalid numeric settings still fail', () => {
  const home = join(tmpdir(), 'lidge-empty-home');
  assert.equal(JSON.parse(config({ HOME: home, LIDGE_HWP_DOCS: '' }).stdout).DOCS_ROOT,
    join(home, '.lidge-hwp', 'docs'));
  for (const [key, value] of [['LIDGE_HWP_PORT', '65536'], ['LIDGE_HWP_HOLD_AGENT_PUT_MS', '-1']]) {
    const result = config({ [key]: value });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp('Invalid ' + key));
  }
});

// Run the real shell script in a disposable tree. Only the expensive external
// Node/npm/WASM tools are substituted; copies, traps and output checks are real.
async function buildFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lidge-build config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fork = join(root, 'fork sources');
  const bin = join(root, 'bin');
  const override = join(root, 'override bin');
  const files = {
    'fork sources/Cargo.lock': 'lock',
    'fork sources/rhwp-studio/package-lock.json': '{}',
    'fork sources/rhwp-studio/public/rhwp.js': 'user working tree edits',
    'fork sources/.git/index': 'staged contents must stay unchanged',
    'fork sources/pkg/rhwp.js': 'generated glue',
    'fork sources/pkg/rhwp_bg.wasm': 'generated wasm',
  };
  for (const name of ['index.js', 'index.d.ts', 'transport.js', 'document-agent-contract.js', 'package.json'])
    files['fork sources/npm/editor/' + name] = 'editor ' + name;
  for (const [name, contents] of Object.entries(files)) {
    const target = join(root, name);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, contents, { mode: 0o640 });
  }
  for (const dir of ['scripts', 'bin', 'override bin', 'fork sources/scripts'])
    await mkdir(join(root, dir), { recursive: true });
  await copyFile(join(ROOT, 'scripts/build-studio.sh'), join(root, 'scripts/build-studio.sh'));
  const node = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ tool: 'node', binary: process.argv[1] }) + '\\n');
Object.defineProperty(process.versions, 'node', { value: process.env.TEST_NODE_VERSION || '26.0.0' });
Object.defineProperty(process, 'arch', { value: 'x64' });
if (process.argv[2] === '-p') console.log(eval(process.argv[3]));
else if (process.argv[2] === '-e') eval(process.argv[3]);
else process.exit(99);
`;
  for (const dir of [bin, override]) await writeFile(join(dir, 'node'), node, { mode: 0o755 });
  await writeFile(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ tool: 'npm', args, base: process.env.LIDGE_STUDIO_BASE }) + '\\n');
if (args[0] === 'run') {
  if (fs.readFileSync('public/rhwp.js', 'utf8') !== 'generated glue') process.exit(98);
  if (process.env.TEST_FAIL_BUILD === '1') process.exit(42);
  fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.html', '<html>built</html>');
}
`, { mode: 0o755 });
  await writeFile(join(bin, 'git'), '#!/bin/sh\necho "Unexpected Git invocation" >&2\nexit 99\n', { mode: 0o755 });
  await writeFile(join(fork, 'scripts/wasm-pack-locked.sh'),
    '#!/bin/sh\ncp pkg/rhwp.js rhwp-studio/public/rhwp.js\n[ "${TEST_FAIL_WASM:-0}" != 1 ] || exit 41\n');
  const env = cleanEnv({ PATH: bin + delimiter + process.env.PATH, LIDGE_HWP_RHWP: fork,
    LIDGE_HWP_SKIP_WASM: '1', TEST_LOG: join(root, 'tools.jsonl') });
  return { root, fork, bin, override, env,
    run: (extra = {}) => spawnSync('sh', [join(root, 'scripts/build-studio.sh')],
      { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 }) };
}

test('build uses PATH Node on x64, produces outputs and preserves working file and index', async (t) => {
  const f = await buildFixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.fork, 'rhwp-studio/public/rhwp.js'), 'utf8'), 'user working tree edits');
  assert.equal((await stat(join(f.fork, 'rhwp-studio/public/rhwp.js'))).mode & 0o777, 0o640);
  assert.equal(await readFile(join(f.fork, '.git/index'), 'utf8'), 'staged contents must stay unchanged');
  assert.equal(await readFile(join(f.root, 'build/wasm/rhwp.js'), 'utf8'), 'generated glue');
  assert.equal(await readFile(join(f.root, 'build/studio/index.html'), 'utf8'), '<html>built</html>');
  const calls = (await readFile(f.env.TEST_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [
    { tool: 'node', binary: join(f.bin, 'node') },
    { tool: 'npm', args: ['ci', '--include=optional'] },
    { tool: 'npm', args: ['run', 'build', '--', '--base=/studio/'], base: '/studio/' },
  ]);
});

test('build accepts executable and directory Node overrides with spaces', async (t) => {
  const f = await buildFixture(t);
  for (const value of [join(f.override, 'node'), f.override]) {
    const result = f.run({ LIDGE_HWP_NODE_BIN: value });
    assert.equal(result.status, 0, result.stderr);
  }
  const calls = (await readFile(f.env.TEST_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(c => c.tool === 'node').map(c => c.binary),
    [join(f.override, 'node'), join(f.override, 'node')]);
});

test('build rejects Node below 26 before modifying source or calling npm', async (t) => {
  const f = await buildFixture(t);
  const result = f.run({ TEST_NODE_VERSION: '25.9.0' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node >=26 required/);
  assert.equal(await readFile(join(f.fork, 'rhwp-studio/public/rhwp.js'), 'utf8'), 'user working tree edits');
  const calls = (await readFile(f.env.TEST_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'node');
});

for (const [stage, extra, status] of [
  ['npm', { TEST_FAIL_BUILD: '1' }, 42],
  ['wasm', { LIDGE_HWP_SKIP_WASM: '0', TEST_FAIL_WASM: '1' }, 41],
]) test(`build restores edited glue when ${stage} fails`, async (t) => {
  const f = await buildFixture(t);
  const result = f.run(extra);
  assert.equal(result.status, status, result.stderr);
  assert.equal(await readFile(join(f.fork, 'rhwp-studio/public/rhwp.js'), 'utf8'), 'user working tree edits');
  assert.equal(await readFile(join(f.fork, '.git/index'), 'utf8'), 'staged contents must stay unchanged');
});

test('build preserves an absent public glue file', async (t) => {
  const f = await buildFixture(t);
  const publicJs = join(f.fork, 'rhwp-studio/public/rhwp.js');
  await rm(publicJs);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(publicJs), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.root, 'build/wasm/rhwp.js'), 'utf8'), 'generated glue');
});

test('vendor requires an explicit fork before invoking external tools', () => {
  const result = spawnSync('sh', [join(ROOT, 'scripts/rhwp-vendor.sh')],
    { env: cleanEnv(), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /first argument or set LIDGE_HWP_FORK/);
});

test('vendor resolves fork argument before environment and excludes private data from both archives', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lidge-vendor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'bin'));
  await copyFile(join(ROOT, 'scripts/rhwp-vendor.sh'), join(root, 'scripts/rhwp-vendor.sh'));
  await copyFile(join(ROOT, 'scripts/sanitize-rhwp-metadata.mjs'), join(root, 'scripts/sanitize-rhwp-metadata.mjs'));
  await writeFile(join(root, 'bin/git'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + '\\n');
if (args[2] === 'rev-parse') console.log('abc123');
else if (args[2] === 'merge-base') console.log('def456');
`, { mode: 0o755 });
  await writeFile(join(root, 'bin/tar'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dest = args[args.indexOf('-C') + 1];
for (const file of ['saved/blank2010.hwp',
  'src/parser/hwpx/blank2010_assets/hwp_summary_information.bin',
  'src/parser/hwpx/blank2010_assets/doc_options_link_doc.bin']) {
  const target = path.join(dest, file);
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.copyFileSync(path.join(process.env.TEST_VENDOR_ASSETS, file), target);
}
`, { mode: 0o755 });
  await writeFile(join(root, 'bin/rsync'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.copyFileSync(args.at(-2) + '.lidge-vendor.json', args.at(-1) + '.lidge-vendor.json');
`, { mode: 0o755 });
  // Font-table preservation is checked by the dedicated Python tool. This
  // routing test observes its invocation without requiring Python dependencies.
  await writeFile(join(root, 'bin/font-python'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args[0].endsWith('/scripts/rename-sourcehan-subset.py')
  || args[1] !== '--root' || args[3] !== '--apply') process.exit(2);
fs.appendFileSync(process.env.TEST_FONT_LOG, JSON.stringify(args) + '\\n');
`, { mode: 0o755 });
  const log = join(root, 'git.jsonl');
  const fontLog = join(root, 'fonts.jsonl');
  const env = cleanEnv({ PATH: join(root, 'bin') + delimiter + process.env.PATH,
    LIDGE_HWP_FORK: '/environment fork', TEST_LOG: log, TEST_VENDOR_ASSETS: join(ROOT, 'rhwp'),
    LIDGE_HWP_FONT_PYTHON: join(root, 'bin/font-python'), TEST_FONT_LOG: fontLog });
  for (const [args, expectedFork, expectedRef] of [
    [[], '/environment fork', 'lidge/studio-host-devel'],
    [['/argument fork', 'custom-ref'], '/argument fork', 'custom-ref'],
  ]) {
    await writeFile(log, '');
    await writeFile(fontLog, '');
    const result = spawnSync('sh', [join(root, 'scripts/rhwp-vendor.sh'), ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(fontLog, 'utf8')).trim().split('\n').length, 1);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(c => c[0] === '-C' && c[1] === expectedFork));
    assert.deepEqual(calls[0].slice(2), ['rev-parse', '--verify', expectedRef + '^{commit}']);
    const archives = calls.filter(c => c[2] === 'archive');
    assert.equal(archives.length, 2);
    const [archive, restored] = archives;
    for (const excluded of ['mydocs', 'pdf', 'samples', 'tests/fixtures', 'tests/golden_svg', 'fuzz/corpus',
      'saved', 'rhwp-studio/public/samples', 'tools/task2279/evidence'])
      assert.ok(archive.includes(':(exclude)' + excluded), excluded);
    for (const excluded of ['corpus', 'fixtures'])
      assert.ok(archive.includes(':(exclude,glob)tools/llm_verifier/*/' + excluded + '/**'));
    assert.ok(restored.includes('mydocs/manual'));
    assert.ok(restored.includes(':(exclude)mydocs/manual/memory'));
    assert.ok(restored.includes(':(exclude)mydocs/manual/codex'));
    assert.ok(!restored.includes('samples/hwpx/aift.hwpx'));
    assert.deepEqual(restored.filter(arg => arg === 'saved' || arg.startsWith('saved/')), ['saved/blank2010.hwp']);
    const manifest = JSON.parse(await readFile(join(root, 'rhwp/.lidge-vendor.json'), 'utf8'));
    for (const excluded of ['fuzz/corpus', 'mydocs/manual/memory', 'rhwp-studio/public/samples',
      'tools/task2279/evidence', 'saved (blank2010.hwp 제외)'])
      assert.ok(manifest.excluded.includes(excluded), excluded);
    assert.equal(manifest.ref, expectedRef);
  }
});
