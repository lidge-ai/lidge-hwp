#!/usr/bin/env node
// Read Cargo metadata from stdin; never run Cargo, install, or compile.
// --fetch-upstream retrieves only explicitly pinned missing upstream notices.
// See licenses/RUST-DEPENDENCIES.md for the matching offline metadata command.
// Trust boundary: cached package metadata/text -> public notice artifacts.
// Only notice text is copied, with confined relative paths and byte hashes.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const target = 'aarch64-apple-darwin';
const command = `cargo metadata --locked --offline --format-version 1 --filter-platform ${target} --manifest-path rhwp/Cargo.toml | node scripts/collect-rust-licenses.mjs`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const noticeName = /^(licen[sc]e|copying|notice|copyright|unlicense)/i;
const textExtension = /(?:\.(?:txt|md|markdown|rst|html?)|(?:^|\/)LICENSE[^./]*|(?:^|\/)COPYING[^./]*|(?:^|\/)NOTICE[^./]*|(?:^|\/)COPYRIGHT[^./]*|(?:^|\/)UNLICENSE)$/i;
const copyleftMention = /Mozilla Public License|GNU (?:Affero |Lesser |Library )?General Public License|\b(?:A?GPL|LGPL|MPL)-\d/i;
const upstreamRepository = 'https://github.com/etemesi254/zune-image';
const upstreamNoticeHashes = {
  'LICENSE-ZLIB': '7fa429541e55b1509909e058f2d21a37467e4958ec713b357f6e0cf9dc4ee352',
  'LICENSE.md': 'c6dff146a9f31848ac296faa5a08a4253caf2c384c86f906dc99e7fc0a39cc8c',
};
const upstreamOverrides = {
  'zune-core@0.4.12': {
    revision: 'f8fbb123d5ed04441e8324a555bfcda0cb1bd28f', pathInVcs: 'crates/zune-core',
    manifestSha256: 'cc3fa616bb3dd673abbdebce2d8b2a1a1ecb6a3dd9654313d6fcc0ab2d3c5f84',
    repositoryField: 'homepage', repositoryValue: `${upstreamRepository}/tree/dev/zune-core`,
  },
  'zune-jpeg@0.4.21': {
    revision: 'fa2c767a01d7d9373911d0bf63e0588553d67e0e', pathInVcs: 'crates/zune-jpeg',
    manifestSha256: 'b84874c67f2b66aa79164f0a946d36b673a8e2a3e6bcc6a5ecdfc1b1c1e04530',
    repositoryField: 'repository', repositoryValue: `${upstreamRepository}/tree/dev/crates/zune-jpeg`,
  },
};
// Exact upstream tree inspected through GitHub's Git Trees API, not a branch tip.
const svgRevision = '2caeb0a038f9128b79833d803b94c2667565c4da';
const svgSourceBlobs = {
  'src/icc/sGrey-v4.icc': '2187b6786aa7c6a6744aad62599eb70b46118352',
  'src/icc/sRGB-v4.icc': 'd9f3c055bd4d7573124090569e1b9533932214eb',
  'src/lib.rs': '0b67237751c0a943c3f7d45deb3a191bc73d2ff2',
  'src/render/clip_path.rs': '582925773830bc0cf72792820f9d3e497bb2857f',
  'src/render/filter.rs': '2a2f37f0c5fd2b44e329932812104183d16f434e',
  'src/render/gradient.rs': '29d792183aa76e9327fba846ebc33c94ac5a7c45',
  'src/render/group.rs': '30ebc83e0d5a0213172b7065b2b642c0d6db2bb4',
  'src/render/image.rs': 'd539226c27a301757f81e98f8ed30a80d84526f5',
  'src/render/mask.rs': '252b2b42c2e99249c74d2354d785131209ebd9df',
  'src/render/mod.rs': '91ade5bd33c89312e58f84a271e61ed245e2000c',
  'src/render/path.rs': 'ffec45e18677e6a46f4cb2f7705e83ac7cd8139f',
  'src/render/pattern.rs': 'be529e6d9d12ad96376c4b4e4721d9769d623caa',
  'src/render/text.rs': '7eba1d11bfc01638f50bcd1c9fabe83eb1273fad',
  'src/util/allocate.rs': '033fcbe9e9cf991bc89f101707ee5cf5e7083e2e',
  'src/util/context.rs': '9c29ff785db4858be9e1bba3d3258782f29d38f4',
  'src/util/helper.rs': 'b28d053e11f79a8f109e8cd54d8be6430fc9bbcf',
  'src/util/mod.rs': 'fe1ec989a667d233bfad789e8be30c5787d86349',
  'src/util/resources.rs': 'b5d5788e43a75f2d20e537ad3c8946d8a34952c8',
};
const svgReviewedChanges = {
  'src/render/gradient.rs': '26f9b5fd77ddd89dfc4a801ad95d27ee33e6dc0863c633117d7f813785b3506d',
  'src/render/path.rs': '17a1d484bf17b30c617584284d0f519f28c41bd9740cd71c7e4c9a79e848c1ec',
  'src/render/text.rs': '2c1d3b4890157916bd39c63f6d54ec5ad48422d704c48b5a7ec58e85d052991d',
  'src/util/helper.rs': '66069d5ee0e402edfaa357b7ac12954e276553d38c5b68d14d28072c4fa6a512',
};

function requireValid(condition, reason) {
  if (!condition) throw new Error(reason);
}

function safeRelative(path) {
  requireValid(typeof path === 'string' && path.length > 0 && !isAbsolute(path)
    && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe relative filename');
  return path;
}

function publicPath(path) {
  return safeRelative(relative(root, path).split(sep).join('/'));
}

function textBytes(path) {
  requireValid(lstatSync(path).isFile(), 'Notice must be a regular file, not a symlink');
  return validateNotice(readFileSync(path));
}

function validateNotice(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  requireValid(!text.includes('\0'), 'Binary data in notice');
  requireValid(!/(?:\/Users\/|\/home\/|[A-Z]:[\\/]Users[\\/])/i.test(text), 'Host path in notice; original left unchanged, review required');
  return { bytes, text };
}

async function upstreamNotices(pkg, outputs, fetchUpstream) {
  const override = upstreamOverrides[`${pkg.name}@${pkg.version}`];
  if (!override) return null;
  const base = dirname(pkg.manifest_path);
  const vcs = JSON.parse(readFileSync(join(base, '.cargo_vcs_info.json'), 'utf8'));
  requireValid(vcs.git.sha1 === override.revision && !vcs.git.dirty && vcs.path_in_vcs === override.pathInVcs,
    'Upstream override does not match published crate VCS provenance');
  requireValid(sha256(readFileSync(join(base, 'Cargo.toml.orig'))) === override.manifestSha256
    && pkg[override.repositoryField] === override.repositoryValue
    && pkg.license === 'MIT OR Apache-2.0 OR Zlib', 'Upstream override package provenance changed');
  const rawBase = `https://raw.githubusercontent.com/etemesi254/zune-image/${override.revision}`;
  const files = [];
  for (const [original, expectedHash] of Object.entries(upstreamNoticeHashes)) {
    const path = `licenses/rust/${pkg.name}-${pkg.version}/${original}`;
    const sourceUrl = `${rawBase}/${original}`;
    let bytes;
    if (fetchUpstream) {
      const response = await fetch(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      requireValid(response.ok, `Pinned upstream notice fetch failed: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } else {
      requireValid(existsSync(join(root, path)), 'Pinned upstream notice absent; regenerate with --fetch-upstream');
      bytes = textBytes(join(root, path)).bytes;
    }
    const { text } = validateNotice(bytes);
    requireValid(sha256(bytes) === expectedHash, 'Pinned upstream notice hash mismatch');
    requireValid(!outputs.has(path), 'Cached notice now overlaps upstream override; review override');
    outputs.set(path, bytes);
    files.push({ original, path, sourceUrl, sha256: expectedHash, bytes: bytes.length,
      copyleftMention: copyleftMention.test(text) });
  }
  return { files, provenance: { repository: upstreamRepository, ...override,
    vcsEvidence: '.cargo_vcs_info.json', manifestEvidence: 'Cargo.toml.orig',
    manifestUrl: `${rawBase}/${override.pathInVcs}/Cargo.toml`,
    selectedLicense: 'Zlib',
    reason: 'Published crate omits license files; repository-root original notices at its exact VCS revision. Zlib is an explicit package/source-header alternative; complete Zlib text retained alongside original copyright notice.' } };
}

function svgSourceReview() {
  const base = 'rhwp/vendor/svg2pdf';
  const entries = readdirSync(join(root, base, 'src'), { recursive: true, withFileTypes: true });
  requireValid(entries.every(entry => !entry.isSymbolicLink()), 'Symlink in corresponding source');
  const actual = entries.filter(entry => entry.isFile())
    .map(entry => relative(join(root, base), join(entry.parentPath, entry.name)).split(sep).join('/')).sort(order);
  requireValid(JSON.stringify(actual) === JSON.stringify(Object.keys(svgSourceBlobs).sort(order)), 'Corresponding source file set changed; review required');
  const files = Object.entries(svgSourceBlobs).map(([path, upstreamGitBlob]) => {
    const bytes = readFileSync(join(root, base, path));
    const localGitBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const hash = sha256(bytes);
    const modified = localGitBlob !== upstreamGitBlob;
    requireValid(svgReviewedChanges[path] ? hash === svgReviewedChanges[path] : !modified,
      'Corresponding source differs from reviewed revision; review required');
    return { path: `${base}/${path}`, sha256: hash, upstreamGitBlob, modified };
  });
  const noticeHash = sha256(readFileSync(join(root, base, 'NOTICE')));
  const patchesHash = sha256(readFileSync(join(root, base, 'RHWP_PATCHES.md')));
  requireValid(noticeHash === '74544feeaa2083014e5c62c4d3eda0e6dfb77f621310b5b602b074df199dcc20'
    && patchesHash === '87293452a2e13bbf6403a0fe07f679d2405e5a248df57a31bdbcde5f325b776c', 'Reviewed MPL notice or patch record changed');
  requireValid(/svg2pdf\s*=\s*\{\s*path\s*=\s*"vendor\/svg2pdf"\s*\}/.test(readFileSync(join(root, 'rhwp/Cargo.toml'), 'utf8')), 'Local svg2pdf Cargo patch changed');
  return { status: 'mechanical-source-and-notice-checks-passed',
    distributionCondition: 'Distribute this complete source+binary candidate together, including this recipient source-location notice. Binary-only redistribution requires an accompanying corresponding-source location.',
    upstream: `https://github.com/edwardkim/svg2pdf/tree/${svgRevision}`,
    upstreamTreeApi: `https://api.github.com/repos/edwardkim/svg2pdf/git/trees/${svgRevision}?recursive=1`,
    notice: { path: `${base}/NOTICE`, sha256: noticeHash, identicalToUpstream: true },
    patches: { path: `${base}/RHWP_PATCHES.md`, sha256: patchesHash },
    findings: ['All 16 Rust source files and two ICC assets from the pinned upstream src tree are present.',
      'Four changed files match RHWP_PATCHES.md: gradient.rs, path.rs, text.rs, helper.rs.',
      'MPL-mentioned draw_path body and Taken from resvg attribution are unchanged from the pinned upstream.',
      'helper.rs differs only by two explicit return lifetimes; historical NOTICE helper function names are absent in both the upstream revision and this copy.',
      'Full original NOTICE, including MPL-2.0 terms and covered-code attribution, is preserved.'],
    files };
}

function findNotices(base) {
  const files = [];
  function walk(dir = '', inNoticeDirectory = false) {
    for (const entry of readdirSync(join(base, dir), { withFileTypes: true }).sort((a, b) => order(a.name, b.name))) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      const matches = noticeName.test(entry.name);
      if (entry.isDirectory()) walk(path, inNoticeDirectory || matches);
      else if (matches || inNoticeDirectory) {
        requireValid(entry.isFile(), 'Notice symlink requires manual review');
        // No implementation files, even if a source filename starts with LICENSE.
        if (textExtension.test(path) || !entry.name.includes('.')) files.push(safeRelative(path));
      }
    }
  }
  walk();
  return files.sort(order);
}

function selectedPackages(metadata) {
  const packageRoot = metadata.packages.find(pkg => pkg.name === 'rhwp'
    && publicPath(pkg.manifest_path) === 'rhwp/Cargo.toml');
  requireValid(packageRoot && metadata.resolve, 'Missing rhwp dependency resolution');
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const selected = new Set();
  function visit(id) {
    if (selected.has(id)) return;
    selected.add(id);
    const node = nodes.get(id);
    requireValid(node, 'Missing resolved package node');
    for (const dependency of node.deps) {
      if (dependency.dep_kinds.some(kind => kind.kind === null || kind.kind === 'build')) visit(dependency.pkg);
    }
  }
  visit(packageRoot.id);
  return metadata.packages.filter(pkg => selected.has(pkg.id))
    .sort((a, b) => order(`${a.name}@${a.version}`, `${b.name}@${b.version}`))
    .map(pkg => ({ pkg, features: [...nodes.get(pkg.id).features].sort(order) }));
}

async function collect(metadata, fetchUpstream) {
  const outputs = new Map();
  const packages = [];
  for (const { pkg, features } of selectedPackages(metadata)) {
    requireValid(/^[a-zA-Z0-9_-]+$/.test(pkg.name) && /^[a-zA-Z0-9.+_-]+$/.test(pkg.version), 'Invalid package identity');
    const base = dirname(pkg.manifest_path);
    const registry = pkg.source?.startsWith('registry+');
    requireValid(!pkg.source || registry, 'Non-registry external dependency requires separate notice collection');
    if (registry) {
      const url = new URL(pkg.source.slice('registry+'.length));
      requireValid(url.protocol === 'https:' && !url.username && !url.password, 'Non-public registry source');
    }
    const source = registry ? pkg.source : publicPath(base);
    let candidates;
    if (registry) candidates = findNotices(base);
    else if (source === 'rhwp/vendor/svg2pdf') candidates = ['LICENSE-APACHE', 'LICENSE-MIT', 'NOTICE'];
    else {
      requireValid(source === 'rhwp' || source.startsWith('rhwp/crates/'), 'Unrecognized local dependency');
      candidates = ['LICENSE'];
    }
    const localBase = !registry && source !== 'rhwp/vendor/svg2pdf' ? join(root, 'rhwp') : base;
    if (registry && pkg.license_file) {
      const declared = safeRelative(isAbsolute(pkg.license_file)
        ? relative(base, pkg.license_file).split(sep).join('/') : pkg.license_file);
      requireValid(textExtension.test(declared) || !declared.split('/').at(-1).includes('.'), 'Declared license is not a notice text filename');
      candidates = [...new Set([...candidates, declared])].sort(order);
    }
    const checksumPath = join(base, '.cargo-checksum.json');
    const checksums = registry && existsSync(checksumPath) ? JSON.parse(readFileSync(checksumPath, 'utf8')) : null;
    const files = [];
    const missingFiles = [];
    for (const candidate of candidates) {
      const original = join(localBase, safeRelative(candidate));
      if (!existsSync(original)) { missingFiles.push(candidate); continue; }
      const { bytes, text } = textBytes(original);
      const hash = sha256(bytes);
      const expected = checksums?.files?.[candidate];
      requireValid(!expected || expected === hash, 'Cached notice checksum mismatch');
      const path = registry ? `licenses/rust/${pkg.name}-${pkg.version}/${candidate}` : publicPath(original);
      if (registry) {
        requireValid(!outputs.has(path), 'Duplicate output package identity');
        outputs.set(path, bytes);
      }
      files.push({ original: registry ? candidate : publicPath(original), path, sha256: hash,
        bytes: bytes.length, copyleftMention: copyleftMention.test(text) });
    }
    const upstream = registry ? await upstreamNotices(pkg, outputs, fetchUpstream) : null;
    if (upstream) files.push(...upstream.files);
    const review = [];
    if (!files.length) review.push('No license/notice text found in the cached crate; metadata is not a substitute.');
    if (missingFiles.length) review.push('Declared notice files are missing.');
    if (!pkg.license && !pkg.license_file) review.push('No license expression or license-file declared.');
    if (files.some(file => file.copyleftMention)) review.push('Notice contains copyleft text or references; inspect file-specific applicability.');
    packages.push({ name: pkg.name, version: pkg.version, license: pkg.license,
      source, kind: registry ? 'registry' : 'local',
      ...(registry ? { crateChecksum: checksums?.package ?? null } : {}),
      ...(upstream ? { upstreamOverride: upstream.provenance } : {}),
      resolvedFeatures: features, files, missingFiles, review });
  }
  const manifest = {
    schemaVersion: 2,
    generator: 'scripts/collect-rust-licenses.mjs',
    metadataCommand: command.split(' | ')[0],
    target,
    scope: 'rhwp default-feature normal/build dependency closure; dev edges excluded; Cargo workspace feature unification can over-include packages. Not a binary link map or legal certification.',
    provenance: ['rhwp/Cargo.toml', 'rhwp/Cargo.lock'].map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) })),
    svg2pdfSourceReview: svgSourceReview(),
    packages,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  outputs.set('licenses/rust/manifest.json', manifestBytes);
  outputs.set('licenses/RUST-DEPENDENCIES.md', Buffer.from(report(manifest, sha256(manifestBytes))));
  const sums = [...outputs].sort(([a], [b]) => order(a, b)).map(([path, bytes]) => `${sha256(bytes)}  ${path}`).join('\n') + '\n';
  outputs.set('licenses/rust/SHA256SUMS', Buffer.from(sums));
  return { manifest, outputs, manifestHash: sha256(manifestBytes) };
}

function report(manifest, manifestHash) {
  const registry = manifest.packages.filter(pkg => pkg.kind === 'registry');
  const missing = manifest.packages.filter(pkg => !pkg.files.length || pkg.missingFiles.length);
  const flagged = manifest.packages.filter(pkg => pkg.files.some(file => file.copyleftMention));
  const link = path => `[${path}](../${path})`;
  return `# Rust dependency notices for the bundled rhwp CLI

Generated from the locked, offline Cargo metadata for \`${target}\`, matching the default-feature native build in \`scripts/build-rhwp-cli.sh\`. The normal/build dependency closure contains ${registry.length} registry packages and ${manifest.packages.length - registry.length} local packages. ${registry.reduce((sum, pkg) => sum + pkg.files.length, 0)} registry notice files are copied byte-for-byte, including nested notices and license directories. Author names and copyright statements in upstream notices are preserved.

This is a conservative notice inventory, not legal certification or a claim that every listed package is linked into the binary. Cargo metadata may unify features with other workspace members; build dependencies and nested test/data notices are retained conservatively. Dev-only dependency edges are excluded. This inventory does not cover npm tooling, fonts outside these crate notices, Rust toolchain libraries, or platform libraries. It does not replace file-level license review. The older ${link('rhwp/THIRD_PARTY_LICENSES.md')} is supplemental and is not the version source for this inventory.

## Reproduce and verify

Run from the repository root with the existing Cargo registry cache populated by the native build. Cargo and Node must already be installed. Normal generation/check uses the committed, hash-pinned upstream notices without network access. No compile or install is performed:

\`\`\`sh
${command}
${command} --check
shasum -a 256 -c licenses/rust/SHA256SUMS
\`\`\`

To restore the four upstream notice copies from their original commit-fixed URLs, or reverify them online, use \`--fetch-upstream\` (it can also be combined with \`--check\`). This opt-in fetch fails on redirects or hash mismatches and never downloads package/source code:

\`\`\`sh
${command} --fetch-upstream
\`\`\`

The input must be produced with the exact metadata command above; Cargo metadata does not encode its filter-platform argument. The script does not infer a different target or feature set. Regenerate with a reviewed command/script change if the native build target/features change. \`--check\` verifies the generated contents and rejects stale files; it does not certify that missing notices have been resolved. No timestamps, cache directories, absolute host paths, or raw Cargo package IDs are written. Per-file hashes, original relative filenames, package name/version/license/source, and lockfile hashes are in ${link('licenses/rust/manifest.json')}. The manifest SHA-256 is \`${manifestHash}\`.

## Missing notice texts

${missing.length ? missing.map(pkg => `- \`${pkg.name} ${pkg.version}\` — declared license: \`${pkg.license ?? 'unspecified'}\`; ${pkg.files.length ? `missing ${pkg.missingFiles.join(', ')}` : 'no license/notice text in the cached crate'}. Obtain the matching upstream notice before treating redistribution review as complete; no generic license has been substituted.`).join('\n') : 'No missing notice texts were detected by this collector.'}

## Exact-version upstream notice overrides

${registry.filter(pkg => pkg.upstreamOverride).map(pkg => {
  const proof = pkg.upstreamOverride;
  return `- \`${pkg.name} ${pkg.version}\`: published \`.cargo_vcs_info.json\` pins [\`${proof.revision}\`](${proof.repository}/tree/${proof.revision}) and \`${proof.pathInVcs}\`. The [upstream Cargo.toml](${proof.manifestUrl}) matches the cached \`Cargo.toml.orig\` SHA-256 \`${proof.manifestSha256}\`. The package's \`${proof.repositoryField}\` identifies this repository. Original files: ${pkg.files.filter(file => file.sourceUrl).map(file => `[${file.original}](${file.sourceUrl}) (SHA-256 \`${file.sha256}\`)`).join('; ')}. Selected redistribution alternative: **Zlib**.`;
}).join('\n')}

These releases declare \`MIT OR Apache-2.0 OR Zlib\`, including in their source headers. Their repository contains the complete Zlib terms plus an original copyright/dual-license summary in \`LICENSE.md\`; the latter is not a fabricated MIT/Apache full text. Both originals are preserved byte-for-byte. The explicit Zlib selection supplies complete terms without inventing a copyright holder or borrowing another crate's license.

## Workspace and vendored notices

${manifest.packages.filter(pkg => pkg.kind === 'local').map(pkg => `- \`${pkg.name} ${pkg.version}\` (${pkg.license ?? 'unspecified'}): ${pkg.files.map(file => link(file.path)).join(', ')}.`).join('\n')}

The repository-wide ${link('rhwp/LICENSE')} applies to rhwp and its local crates; it does not replace dependency-specific notices. Preserve svg2pdf's MIT/Apache license texts and complete NOTICE, including embedded asset and borrowed-code notices.

## Copyleft review and redistribution conditions

The selected registry package license expressions contain ${manifest.packages.filter(pkg => pkg.kind === 'registry' && /\b(?:A?GPL|LGPL|MPL)-/.test(pkg.license ?? '')).length} explicit GPL/LGPL/AGPL/MPL identifiers. Package-level permissive expressions do not override embedded file notices. Copyleft-text/reference flags (not determinations that a whole crate is copyleft):

${flagged.map(pkg => `- \`${pkg.name} ${pkg.version}\`: ${pkg.files.filter(file => file.copyleftMention).map(file => link(file.path)).join(', ')}.`).join('\n') || '- No copyleft text references found by the keyword check.'}

${link('rhwp/vendor/svg2pdf/NOTICE')} names MPL-2.0 for borrowed resvg helper/path-rendering code and separately for tests. **Recipient source location:** the corresponding source, including local modifications, is provided in this distribution under ${link('rhwp/vendor/svg2pdf/src')}. The MPL-covered material and its modifications are provided under MPL-2.0, whose full terms and attribution are retained in ${link('rhwp/vendor/svg2pdf/NOTICE')}; the root MIT license does not replace those terms. Retain this source-location notice, source, patch record, and original notices when redistributing this complete source+binary candidate.

Mechanical source/notice verification against [the exact vendored upstream revision](${manifest.svg2pdfSourceReview.upstream}):

- All 16 Rust source files and both ICC assets from upstream \`src/\` are present. The manifest records each file's current SHA-256 and original Git blob identity; source bytes are not duplicated into the license inventory.
- The full NOTICE is byte-identical to upstream (SHA-256 \`${manifest.svg2pdfSourceReview.notice.sha256}\`), preserving the explicit MPL license and attribution text.
- ${link('rhwp/vendor/svg2pdf/src/render/path.rs')} contains the MPL-mentioned \`draw_path\` and its resvg attribution. That function body is unchanged from upstream. Its enclosing file includes the documented local fill/stroke helpers, and the complete modified file is supplied.
- ${link('rhwp/vendor/svg2pdf/src/util/helper.rs')} differs only by two explicit return lifetimes. The historical \`image_rect\`, \`fit_view_box\`, and \`calc_node_bbox\` names in NOTICE are absent from both this pinned upstream revision and the bundled source; no missing file is inferred from those old names.
- The four modified files (\`gradient.rs\`, \`path.rs\`, \`text.rs\`, \`helper.rs\`) match ${link('rhwp/vendor/svg2pdf/RHWP_PATCHES.md')}. Cargo's \`[patch.crates-io]\` selects this bundled svg2pdf source. The collector fails if the reviewed file set, modified-file hashes, patch record, or NOTICE changes.

For this complete candidate, the checked mechanical items have **no remaining missing-source or missing-notice blocker**. This is source availability and notice evidence, not a legal certification or a new binary-build attestation. A binary-only distribution that omits this source tree must supply recipients an accessible corresponding-source location instead; that packaging condition is not a missing item in the complete candidate. MPL sections 3.1–3.4 are preserved in the linked NOTICE. Test-specific notices do not alone establish runtime inclusion.

For each selected license, retain the applicable copyright/license text and required attributions with redistribution. Preserve Apache NOTICE material where applicable, and review compound expressions (\`AND\`, \`OR\`, exceptions) and embedded asset conditions in the original texts. Apart from the two explicit Zlib selections above, this collector records license expressions without choosing alternatives; it does not certify compliance.

## Registry package index

| Package | Declared license | Original notice texts |
| --- | --- | --- |
${registry.map(pkg => `| ${pkg.name} ${pkg.version} | ${pkg.license ?? 'unspecified'} | ${pkg.files.length ? pkg.files.map(file => `[${file.original}](../${file.path})`).join(', ') : '**MISSING**'} |`).join('\n')}
`;
}

function writeOrCheck(outputs, check) {
  const existing = existsSync(join(root, 'licenses/rust'))
    ? readdirSync(join(root, 'licenses/rust'), { recursive: true, withFileTypes: true }) : [];
  for (const entry of existing) {
    requireValid(!entry.isSymbolicLink(), 'Symlink in output directory');
    if (entry.isFile()) requireValid(outputs.has(publicPath(join(entry.parentPath, entry.name))), 'Stale notice output; review obsolete files explicitly');
  }
  // Validate all destination components before creating or overwriting anything.
  for (const path of outputs.keys()) {
    const parts = safeRelative(path).split('/');
    for (let i = 1; i <= parts.length; i++) {
      const absolute = join(root, ...parts.slice(0, i));
      if (existsSync(absolute)) requireValid(!lstatSync(absolute).isSymbolicLink(), 'Symlink output path');
    }
  }
  for (const [path, bytes] of outputs) {
    const destination = join(root, path);
    if (check) requireValid(existsSync(destination) && readFileSync(destination).equals(bytes), `Generated artifact differs: ${path}`);
    else {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
  }
}

try {
  requireValid(process.argv.slice(2).every(arg => ['--check', '--fetch-upstream'].includes(arg)), 'Usage: cargo metadata ... | node scripts/collect-rust-licenses.mjs [--check] [--fetch-upstream]');
  requireValid(!process.stdin.isTTY, 'Cargo metadata JSON is required on stdin');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { manifest, outputs, manifestHash } = await collect(JSON.parse(input), process.argv.includes('--fetch-upstream'));
  writeOrCheck(outputs, process.argv.includes('--check'));
  console.log(JSON.stringify({ registryPackages: manifest.packages.filter(pkg => pkg.kind === 'registry').length,
    localPackages: manifest.packages.filter(pkg => pkg.kind === 'local').length,
    copiedNoticeFiles: outputs.size - 3, manifestSha256: manifestHash,
    missing: manifest.packages.filter(pkg => !pkg.files.length || pkg.missingFiles.length).map(pkg => `${pkg.name}@${pkg.version}`),
    svg2pdfSourceReview: manifest.svg2pdfSourceReview.status,
    checked: process.argv.includes('--check') }, null, 2));
} catch (error) {
  // OS/JSON errors may contain host paths or raw metadata: never echo those.
  console.error(`Rust notice collection failed: ${error.code ? error.code : error instanceof SyntaxError || error instanceof TypeError ? 'invalid input or notice encoding' : error.message}`);
  process.exitCode = 1;
}
