# Rust dependency notices for the bundled rhwp CLI

Generated from the locked, offline Cargo metadata for `aarch64-apple-darwin`, matching the default-feature native build in `scripts/build-rhwp-cli.sh`. The normal/build dependency closure contains 191 registry packages and 5 local packages. 386 registry notice files are copied byte-for-byte, including nested notices and license directories. Author names and copyright statements in upstream notices are preserved.

This is a conservative notice inventory, not legal certification or a claim that every listed package is linked into the binary. Cargo metadata may unify features with other workspace members; build dependencies and nested test/data notices are retained conservatively. Dev-only dependency edges are excluded. This inventory does not cover npm tooling, fonts outside these crate notices, Rust toolchain libraries, or platform libraries. It does not replace file-level license review. The older [rhwp/THIRD_PARTY_LICENSES.md](../rhwp/THIRD_PARTY_LICENSES.md) is supplemental and is not the version source for this inventory.

## Reproduce and verify

Run from the repository root with the existing Cargo registry cache populated by the native build. Cargo and Node must already be installed. Normal generation/check uses the committed, hash-pinned upstream notices without network access. No compile or install is performed:

```sh
cargo metadata --locked --offline --format-version 1 --filter-platform aarch64-apple-darwin --manifest-path rhwp/Cargo.toml | node scripts/collect-rust-licenses.mjs
cargo metadata --locked --offline --format-version 1 --filter-platform aarch64-apple-darwin --manifest-path rhwp/Cargo.toml | node scripts/collect-rust-licenses.mjs --check
shasum -a 256 -c licenses/rust/SHA256SUMS
```

To restore the four upstream notice copies from their original commit-fixed URLs, or reverify them online, use `--fetch-upstream` (it can also be combined with `--check`). This opt-in fetch fails on redirects or hash mismatches and never downloads package/source code:

```sh
cargo metadata --locked --offline --format-version 1 --filter-platform aarch64-apple-darwin --manifest-path rhwp/Cargo.toml | node scripts/collect-rust-licenses.mjs --fetch-upstream
```

The input must be produced with the exact metadata command above; Cargo metadata does not encode its filter-platform argument. The script does not infer a different target or feature set. Regenerate with a reviewed command/script change if the native build target/features change. `--check` verifies the generated contents and rejects stale files; it does not certify that missing notices have been resolved. No timestamps, cache directories, absolute host paths, or raw Cargo package IDs are written. Per-file hashes, original relative filenames, package name/version/license/source, and lockfile hashes are in [licenses/rust/manifest.json](../licenses/rust/manifest.json). The manifest SHA-256 is `81e6d712e29870fa187a3afcad71502ad612f32ae0a3bad6c9ad732fa8e13c4c`.

## Missing notice texts

No missing notice texts were detected by this collector.

## Exact-version upstream notice overrides

- `zune-core 0.4.12`: published `.cargo_vcs_info.json` pins [`f8fbb123d5ed04441e8324a555bfcda0cb1bd28f`](https://github.com/etemesi254/zune-image/tree/f8fbb123d5ed04441e8324a555bfcda0cb1bd28f) and `crates/zune-core`. The [upstream Cargo.toml](https://raw.githubusercontent.com/etemesi254/zune-image/f8fbb123d5ed04441e8324a555bfcda0cb1bd28f/crates/zune-core/Cargo.toml) matches the cached `Cargo.toml.orig` SHA-256 `cc3fa616bb3dd673abbdebce2d8b2a1a1ecb6a3dd9654313d6fcc0ab2d3c5f84`. The package's `homepage` identifies this repository. Original files: [LICENSE-ZLIB](https://raw.githubusercontent.com/etemesi254/zune-image/f8fbb123d5ed04441e8324a555bfcda0cb1bd28f/LICENSE-ZLIB) (SHA-256 `7fa429541e55b1509909e058f2d21a37467e4958ec713b357f6e0cf9dc4ee352`); [LICENSE.md](https://raw.githubusercontent.com/etemesi254/zune-image/f8fbb123d5ed04441e8324a555bfcda0cb1bd28f/LICENSE.md) (SHA-256 `c6dff146a9f31848ac296faa5a08a4253caf2c384c86f906dc99e7fc0a39cc8c`). Selected redistribution alternative: **Zlib**.
- `zune-jpeg 0.4.21`: published `.cargo_vcs_info.json` pins [`fa2c767a01d7d9373911d0bf63e0588553d67e0e`](https://github.com/etemesi254/zune-image/tree/fa2c767a01d7d9373911d0bf63e0588553d67e0e) and `crates/zune-jpeg`. The [upstream Cargo.toml](https://raw.githubusercontent.com/etemesi254/zune-image/fa2c767a01d7d9373911d0bf63e0588553d67e0e/crates/zune-jpeg/Cargo.toml) matches the cached `Cargo.toml.orig` SHA-256 `b84874c67f2b66aa79164f0a946d36b673a8e2a3e6bcc6a5ecdfc1b1c1e04530`. The package's `repository` identifies this repository. Original files: [LICENSE-ZLIB](https://raw.githubusercontent.com/etemesi254/zune-image/fa2c767a01d7d9373911d0bf63e0588553d67e0e/LICENSE-ZLIB) (SHA-256 `7fa429541e55b1509909e058f2d21a37467e4958ec713b357f6e0cf9dc4ee352`); [LICENSE.md](https://raw.githubusercontent.com/etemesi254/zune-image/fa2c767a01d7d9373911d0bf63e0588553d67e0e/LICENSE.md) (SHA-256 `c6dff146a9f31848ac296faa5a08a4253caf2c384c86f906dc99e7fc0a39cc8c`). Selected redistribution alternative: **Zlib**.

These releases declare `MIT OR Apache-2.0 OR Zlib`, including in their source headers. Their repository contains the complete Zlib terms plus an original copyright/dual-license summary in `LICENSE.md`; the latter is not a fabricated MIT/Apache full text. Both originals are preserved byte-for-byte. The explicit Zlib selection supplies complete terms without inventing a copyright holder or borrowing another crate's license.

## Workspace and vendored notices

- `rhwp-contracts 0.1.0` (MIT): [rhwp/LICENSE](../rhwp/LICENSE).
- `rhwp-ooxml-chart 0.1.0` (MIT): [rhwp/LICENSE](../rhwp/LICENSE).
- `rhwp-password-crypto 0.1.0` (MIT): [rhwp/LICENSE](../rhwp/LICENSE).
- `rhwp 0.8.6` (MIT): [rhwp/LICENSE](../rhwp/LICENSE).
- `svg2pdf 0.13.0` (MIT OR Apache-2.0): [rhwp/vendor/svg2pdf/LICENSE-APACHE](../rhwp/vendor/svg2pdf/LICENSE-APACHE), [rhwp/vendor/svg2pdf/LICENSE-MIT](../rhwp/vendor/svg2pdf/LICENSE-MIT), [rhwp/vendor/svg2pdf/NOTICE](../rhwp/vendor/svg2pdf/NOTICE).

The repository-wide [rhwp/LICENSE](../rhwp/LICENSE) applies to rhwp and its local crates; it does not replace dependency-specific notices. Preserve svg2pdf's MIT/Apache license texts and complete NOTICE, including embedded asset and borrowed-code notices.

## Copyleft review and redistribution conditions

The selected registry package license expressions contain 0 explicit GPL/LGPL/AGPL/MPL identifiers. Package-level permissive expressions do not override embedded file notices. Copyleft-text/reference flags (not determinations that a whole crate is copyleft):

- `svg2pdf 0.13.0`: [rhwp/vendor/svg2pdf/NOTICE](../rhwp/vendor/svg2pdf/NOTICE).

[rhwp/vendor/svg2pdf/NOTICE](../rhwp/vendor/svg2pdf/NOTICE) names MPL-2.0 for borrowed resvg helper/path-rendering code and separately for tests. **Recipient source location:** the corresponding source, including local modifications, is provided in this distribution under [rhwp/vendor/svg2pdf/src](../rhwp/vendor/svg2pdf/src). The MPL-covered material and its modifications are provided under MPL-2.0, whose full terms and attribution are retained in [rhwp/vendor/svg2pdf/NOTICE](../rhwp/vendor/svg2pdf/NOTICE); the root MIT license does not replace those terms. Retain this source-location notice, source, patch record, and original notices when redistributing this complete source+binary candidate.

Mechanical source/notice verification against [the exact vendored upstream revision](https://github.com/edwardkim/svg2pdf/tree/2caeb0a038f9128b79833d803b94c2667565c4da):

- All 16 Rust source files and both ICC assets from upstream `src/` are present. The manifest records each file's current SHA-256 and original Git blob identity; source bytes are not duplicated into the license inventory.
- The full NOTICE is byte-identical to upstream (SHA-256 `74544feeaa2083014e5c62c4d3eda0e6dfb77f621310b5b602b074df199dcc20`), preserving the explicit MPL license and attribution text.
- [rhwp/vendor/svg2pdf/src/render/path.rs](../rhwp/vendor/svg2pdf/src/render/path.rs) contains the MPL-mentioned `draw_path` and its resvg attribution. That function body is unchanged from upstream. Its enclosing file includes the documented local fill/stroke helpers, and the complete modified file is supplied.
- [rhwp/vendor/svg2pdf/src/util/helper.rs](../rhwp/vendor/svg2pdf/src/util/helper.rs) differs only by two explicit return lifetimes. The historical `image_rect`, `fit_view_box`, and `calc_node_bbox` names in NOTICE are absent from both this pinned upstream revision and the bundled source; no missing file is inferred from those old names.
- The four modified files (`gradient.rs`, `path.rs`, `text.rs`, `helper.rs`) match [rhwp/vendor/svg2pdf/RHWP_PATCHES.md](../rhwp/vendor/svg2pdf/RHWP_PATCHES.md). Cargo's `[patch.crates-io]` selects this bundled svg2pdf source. The collector fails if the reviewed file set, modified-file hashes, patch record, or NOTICE changes.

For this complete candidate, the checked mechanical items have **no remaining missing-source or missing-notice blocker**. This is source availability and notice evidence, not a legal certification or a new binary-build attestation. A binary-only distribution that omits this source tree must supply recipients an accessible corresponding-source location instead; that packaging condition is not a missing item in the complete candidate. MPL sections 3.1–3.4 are preserved in the linked NOTICE. Test-specific notices do not alone establish runtime inclusion.

For each selected license, retain the applicable copyright/license text and required attributions with redistribution. Preserve Apache NOTICE material where applicable, and review compound expressions (`AND`, `OR`, exceptions) and embedded asset conditions in the original texts. Apart from the two explicit Zlib selections above, this collector records license expressions without choosing alternatives; it does not certify compliance.

## Registry package index

| Package | Declared license | Original notice texts |
| --- | --- | --- |
| adler2 2.0.1 | 0BSD OR MIT OR Apache-2.0 | [LICENSE-0BSD](../licenses/rust/adler2-2.0.1/LICENSE-0BSD), [LICENSE-APACHE](../licenses/rust/adler2-2.0.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/adler2-2.0.1/LICENSE-MIT) |
| aead 0.6.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/aead-0.6.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/aead-0.6.1/LICENSE-MIT) |
| aes 0.9.3 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/aes-0.9.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/aes-0.9.3/LICENSE-MIT) |
| argon2 0.6.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/argon2-0.6.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/argon2-0.6.0/LICENSE-MIT) |
| arrayref 0.3.9 | BSD-2-Clause | [LICENSE](../licenses/rust/arrayref-0.3.9/LICENSE) |
| arrayvec 0.7.8 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/arrayvec-0.7.8/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/arrayvec-0.7.8/LICENSE-MIT) |
| autocfg 1.5.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/autocfg-1.5.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/autocfg-1.5.1/LICENSE-MIT) |
| base64 0.22.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/base64-0.22.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/base64-0.22.1/LICENSE-MIT) |
| base64 0.23.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/base64-0.23.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/base64-0.23.1/LICENSE-MIT) |
| base64ct 1.8.3 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/base64ct-1.8.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/base64ct-1.8.3/LICENSE-MIT) |
| bitflags 1.3.2 | MIT/Apache-2.0 | [LICENSE-APACHE](../licenses/rust/bitflags-1.3.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/bitflags-1.3.2/LICENSE-MIT) |
| bitflags 2.13.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/bitflags-2.13.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/bitflags-2.13.1/LICENSE-MIT) |
| blake2 0.11.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/blake2-0.11.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/blake2-0.11.0/LICENSE-MIT) |
| blake3 1.8.7 | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception | [LICENSE_A2](../licenses/rust/blake3-1.8.7/LICENSE_A2), [LICENSE_A2LLVM](../licenses/rust/blake3-1.8.7/LICENSE_A2LLVM), [LICENSE_CC0](../licenses/rust/blake3-1.8.7/LICENSE_CC0) |
| block-buffer 0.12.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/block-buffer-0.12.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/block-buffer-0.12.1/LICENSE-MIT) |
| block-padding 0.4.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/block-padding-0.4.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/block-padding-0.4.2/LICENSE-MIT) |
| bumpalo 3.20.3 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/bumpalo-3.20.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/bumpalo-3.20.3/LICENSE-MIT) |
| bytemuck 1.25.2 | Zlib OR Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/bytemuck-1.25.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/bytemuck-1.25.2/LICENSE-MIT), [LICENSE-ZLIB](../licenses/rust/bytemuck-1.25.2/LICENSE-ZLIB) |
| bytemuck_derive 1.12.0 | Zlib OR Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/bytemuck_derive-1.12.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/bytemuck_derive-1.12.0/LICENSE-MIT), [LICENSE-ZLIB](../licenses/rust/bytemuck_derive-1.12.0/LICENSE-ZLIB) |
| byteorder-lite 0.1.0 | Unlicense OR MIT | [LICENSE-MIT](../licenses/rust/byteorder-lite-0.1.0/LICENSE-MIT), [UNLICENSE](../licenses/rust/byteorder-lite-0.1.0/UNLICENSE) |
| byteorder 1.5.0 | Unlicense OR MIT | [COPYING](../licenses/rust/byteorder-1.5.0/COPYING), [LICENSE-MIT](../licenses/rust/byteorder-1.5.0/LICENSE-MIT), [UNLICENSE](../licenses/rust/byteorder-1.5.0/UNLICENSE) |
| cbc 0.2.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/cbc-0.2.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/cbc-0.2.1/LICENSE-MIT) |
| cc 1.4.3 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/cc-1.4.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/cc-1.4.3/LICENSE-MIT) |
| cfb 0.14.0 | MIT | [LICENSE](../licenses/rust/cfb-0.14.0/LICENSE) |
| cfg-if 1.0.4 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/cfg-if-1.0.4/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/cfg-if-1.0.4/LICENSE-MIT) |
| chacha20 0.10.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/chacha20-0.10.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/chacha20-0.10.1/LICENSE-MIT) |
| chacha20poly1305 0.11.0 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/chacha20poly1305-0.11.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/chacha20poly1305-0.11.0/LICENSE-MIT) |
| cipher 0.5.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/cipher-0.5.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/cipher-0.5.2/LICENSE-MIT) |
| cmov 0.5.4 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/cmov-0.5.4/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/cmov-0.5.4/LICENSE-MIT) |
| codepage 0.1.3 | Apache-2.0 OR MIT | [COPYRIGHT](../licenses/rust/codepage-0.1.3/COPYRIGHT), [LICENSE-APACHE](../licenses/rust/codepage-0.1.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/codepage-0.1.3/LICENSE-MIT) |
| color_quant 1.1.0 | MIT | [LICENSE](../licenses/rust/color_quant-1.1.0/LICENSE) |
| console_error_panic_hook 0.1.7 | Apache-2.0/MIT | [LICENSE-APACHE](../licenses/rust/console_error_panic_hook-0.1.7/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/console_error_panic_hook-0.1.7/LICENSE-MIT) |
| const-oid 0.10.2 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/const-oid-0.10.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/const-oid-0.10.2/LICENSE-MIT) |
| constant_time_eq 0.4.2 | CC0-1.0 OR MIT-0 OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/constant_time_eq-0.4.2/LICENSE-APACHE), [LICENSE-CC0](../licenses/rust/constant_time_eq-0.4.2/LICENSE-CC0), [LICENSE-MIT0](../licenses/rust/constant_time_eq-0.4.2/LICENSE-MIT0) |
| core_maths 0.1.1 | MIT | [LICENSE](../licenses/rust/core_maths-0.1.1/LICENSE) |
| cpubits 0.1.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/cpubits-0.1.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/cpubits-0.1.1/LICENSE-MIT) |
| cpufeatures 0.3.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/cpufeatures-0.3.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/cpufeatures-0.3.0/LICENSE-MIT) |
| crc32fast 1.5.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/crc32fast-1.5.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/crc32fast-1.5.2/LICENSE-MIT) |
| crypto-common 0.2.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/crypto-common-0.2.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/crypto-common-0.2.2/LICENSE-MIT) |
| ctutils 0.4.2 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/ctutils-0.4.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/ctutils-0.4.2/LICENSE-MIT) |
| curve25519-dalek 5.0.0 | BSD-3-Clause | [LICENSE](../licenses/rust/curve25519-dalek-5.0.0/LICENSE) |
| data-url 0.3.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/data-url-0.3.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/data-url-0.3.2/LICENSE-MIT) |
| der 0.8.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/der-0.8.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/der-0.8.1/LICENSE-MIT) |
| des 0.9.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/des-0.9.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/des-0.9.0/LICENSE-MIT) |
| digest 0.11.3 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/digest-0.11.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/digest-0.11.3/LICENSE-MIT) |
| ed25519-dalek 3.0.0 | BSD-3-Clause | [LICENSE](../licenses/rust/ed25519-dalek-3.0.0/LICENSE) |
| ed25519 3.0.0 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/ed25519-3.0.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/ed25519-3.0.0/LICENSE-MIT) |
| embedded-io 0.7.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/embedded-io-0.7.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/embedded-io-0.7.1/LICENSE-MIT) |
| encoding_rs 0.8.41 | (Apache-2.0 OR MIT) AND BSD-3-Clause | [COPYRIGHT](../licenses/rust/encoding_rs-0.8.41/COPYRIGHT), [LICENSE-APACHE](../licenses/rust/encoding_rs-0.8.41/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/encoding_rs-0.8.41/LICENSE-MIT), [LICENSE-WHATWG](../licenses/rust/encoding_rs-0.8.41/LICENSE-WHATWG) |
| equivalent 1.0.2 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/equivalent-1.0.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/equivalent-1.0.2/LICENSE-MIT) |
| euclid 0.22.14 | MIT OR Apache-2.0 | [COPYRIGHT](../licenses/rust/euclid-0.22.14/COPYRIGHT), [LICENSE-APACHE](../licenses/rust/euclid-0.22.14/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/euclid-0.22.14/LICENSE-MIT) |
| fax 0.2.7 | MIT | [LICENSE](../licenses/rust/fax-0.2.7/LICENSE) |
| fdeflate 0.3.7 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/fdeflate-0.3.7/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/fdeflate-0.3.7/LICENSE-MIT) |
| find-msvc-tools 0.1.11 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/find-msvc-tools-0.1.11/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/find-msvc-tools-0.1.11/LICENSE-MIT) |
| flate2 1.1.10 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/flate2-1.1.10/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/flate2-1.1.10/LICENSE-MIT) |
| float-cmp 0.9.0 | MIT | [LICENSE](../licenses/rust/float-cmp-0.9.0/LICENSE) |
| fnv 1.0.7 | Apache-2.0 / MIT | [LICENSE-APACHE](../licenses/rust/fnv-1.0.7/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/fnv-1.0.7/LICENSE-MIT) |
| font-types 0.11.3 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/font-types-0.11.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/font-types-0.11.3/LICENSE-MIT) |
| fontdb 0.23.0 | MIT | [LICENSE](../licenses/rust/fontdb-0.23.0/LICENSE), [tests/fonts/LICENSE.txt](../licenses/rust/fontdb-0.23.0/tests/fonts/LICENSE.txt) |
| getrandom 0.4.3 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/getrandom-0.4.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/getrandom-0.4.3/LICENSE-MIT) |
| gif 0.13.3 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/gif-0.13.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/gif-0.13.3/LICENSE-MIT) |
| gif 0.14.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/gif-0.14.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/gif-0.14.2/LICENSE-MIT) |
| half 2.7.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/half-2.7.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/half-2.7.1/LICENSE-MIT) |
| hashbrown 0.17.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/hashbrown-0.17.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/hashbrown-0.17.1/LICENSE-MIT) |
| heck 0.5.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/heck-0.5.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/heck-0.5.0/LICENSE-MIT) |
| hmac 0.13.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/hmac-0.13.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/hmac-0.13.0/LICENSE-MIT) |
| hybrid-array 0.4.14 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/hybrid-array-0.4.14/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/hybrid-array-0.4.14/LICENSE-MIT) |
| image-webp 0.2.4 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/image-webp-0.2.4/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/image-webp-0.2.4/LICENSE-MIT) |
| image 0.25.10 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/image-0.25.10/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/image-0.25.10/LICENSE-MIT) |
| imagesize 0.13.0 | MIT | [LICENSE](../licenses/rust/imagesize-0.13.0/LICENSE) |
| indexmap 2.14.0 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/indexmap-2.14.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/indexmap-2.14.0/LICENSE-MIT) |
| inout 0.2.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/inout-0.2.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/inout-0.2.2/LICENSE-MIT) |
| itoa 1.0.18 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/itoa-1.0.18/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/itoa-1.0.18/LICENSE-MIT) |
| keccak 0.2.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/keccak-0.2.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/keccak-0.2.1/LICENSE-MIT) |
| kem 0.3.0 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/kem-0.3.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/kem-0.3.0/LICENSE-MIT) |
| kurbo 0.11.3 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/kurbo-0.11.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/kurbo-0.11.3/LICENSE-MIT) |
| kurbo 0.13.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/kurbo-0.13.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/kurbo-0.13.1/LICENSE-MIT) |
| libc 0.2.189 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/libc-0.2.189/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/libc-0.2.189/LICENSE-MIT) |
| libm 0.2.16 | MIT | [LICENSE.txt](../licenses/rust/libm-0.2.16/LICENSE.txt) |
| log 0.4.34 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/log-0.4.34/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/log-0.4.34/LICENSE-MIT) |
| memchr 2.8.3 | Unlicense OR MIT | [COPYING](../licenses/rust/memchr-2.8.3/COPYING), [LICENSE-MIT](../licenses/rust/memchr-2.8.3/LICENSE-MIT), [UNLICENSE](../licenses/rust/memchr-2.8.3/UNLICENSE) |
| memmap2 0.9.11 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/memmap2-0.9.11/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/memmap2-0.9.11/LICENSE-MIT) |
| miniz_oxide 0.8.9 | MIT OR Zlib OR Apache-2.0 | [LICENSE](../licenses/rust/miniz_oxide-0.8.9/LICENSE), [LICENSE-APACHE.md](../licenses/rust/miniz_oxide-0.8.9/LICENSE-APACHE.md), [LICENSE-MIT.md](../licenses/rust/miniz_oxide-0.8.9/LICENSE-MIT.md), [LICENSE-ZLIB.md](../licenses/rust/miniz_oxide-0.8.9/LICENSE-ZLIB.md) |
| miniz_oxide 0.9.1 | MIT OR Zlib OR Apache-2.0 | [LICENSE](../licenses/rust/miniz_oxide-0.9.1/LICENSE), [LICENSE-APACHE.md](../licenses/rust/miniz_oxide-0.9.1/LICENSE-APACHE.md), [LICENSE-MIT.md](../licenses/rust/miniz_oxide-0.9.1/LICENSE-MIT.md), [LICENSE-ZLIB.md](../licenses/rust/miniz_oxide-0.9.1/LICENSE-ZLIB.md) |
| ml-dsa 0.1.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/ml-dsa-0.1.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/ml-dsa-0.1.1/LICENSE-MIT) |
| ml-kem 0.3.2 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/ml-kem-0.3.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/ml-kem-0.3.2/LICENSE-MIT) |
| module-lattice 0.2.3 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/module-lattice-0.2.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/module-lattice-0.2.3/LICENSE-MIT) |
| moxcms 0.8.1 | BSD-3-Clause OR Apache-2.0 | [LICENSE-APACHE.md](../licenses/rust/moxcms-0.8.1/LICENSE-APACHE.md), [LICENSE.md](../licenses/rust/moxcms-0.8.1/LICENSE.md) |
| multiversion_no_op 1.0.0 | Apache-2.0 OR MIT | [COPYRIGHT](../licenses/rust/multiversion_no_op-1.0.0/COPYRIGHT), [LICENSE-APACHE](../licenses/rust/multiversion_no_op-1.0.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/multiversion_no_op-1.0.0/LICENSE-MIT) |
| num-traits 0.2.19 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/num-traits-0.2.19/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/num-traits-0.2.19/LICENSE-MIT) |
| once_cell 1.21.4 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/once_cell-1.21.4/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/once_cell-1.21.4/LICENSE-MIT) |
| password-hash 0.6.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/password-hash-0.6.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/password-hash-0.6.1/LICENSE-MIT) |
| paste 1.0.15 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/paste-1.0.15/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/paste-1.0.15/LICENSE-MIT) |
| pbkdf2 0.13.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/pbkdf2-0.13.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/pbkdf2-0.13.0/LICENSE-MIT) |
| pcx 0.2.5 | MIT OR Apache-2.0 OR WTFPL | [LICENSE-APACHE](../licenses/rust/pcx-0.2.5/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/pcx-0.2.5/LICENSE-MIT), [LICENSE-WTFPL](../licenses/rust/pcx-0.2.5/LICENSE-WTFPL) |
| pdf-writer 0.12.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/pdf-writer-0.12.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/pdf-writer-0.12.1/LICENSE-MIT) |
| phc 0.6.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/phc-0.6.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/phc-0.6.1/LICENSE-MIT) |
| pico-args 0.5.0 | MIT | [LICENSE](../licenses/rust/pico-args-0.5.0/LICENSE) |
| pkcs8 0.11.0 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/pkcs8-0.11.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/pkcs8-0.11.0/LICENSE-MIT) |
| png 0.17.16 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/png-0.17.16/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/png-0.17.16/LICENSE-MIT) |
| png 0.18.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/png-0.18.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/png-0.18.1/LICENSE-MIT) |
| poly1305 0.9.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/poly1305-0.9.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/poly1305-0.9.1/LICENSE-MIT) |
| polycool 0.4.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/polycool-0.4.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/polycool-0.4.0/LICENSE-MIT) |
| proc-macro2 1.0.107 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/proc-macro2-1.0.107/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/proc-macro2-1.0.107/LICENSE-MIT) |
| pxfm 0.1.30 | BSD-3-Clause OR Apache-2.0 | [LICENSE-APACHE.md](../licenses/rust/pxfm-0.1.30/LICENSE-APACHE.md), [LICENSE.md](../licenses/rust/pxfm-0.1.30/LICENSE.md) |
| quick-error 2.0.1 | MIT/Apache-2.0 | [LICENSE-APACHE](../licenses/rust/quick-error-2.0.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/quick-error-2.0.1/LICENSE-MIT) |
| quick-xml 0.42.0 | MIT | [LICENSE-MIT.md](../licenses/rust/quick-xml-0.42.0/LICENSE-MIT.md) |
| quote 1.0.47 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/quote-1.0.47/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/quote-1.0.47/LICENSE-MIT) |
| rand_core 0.10.1 | MIT OR Apache-2.0 | [COPYRIGHT](../licenses/rust/rand_core-0.10.1/COPYRIGHT), [LICENSE-APACHE](../licenses/rust/rand_core-0.10.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/rand_core-0.10.1/LICENSE-MIT) |
| read-fonts 0.39.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/read-fonts-0.39.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/read-fonts-0.39.2/LICENSE-MIT) |
| resvg 0.45.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/resvg-0.45.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/resvg-0.45.1/LICENSE-MIT) |
| rgb 0.8.53 | MIT | [LICENSE](../licenses/rust/rgb-0.8.53/LICENSE) |
| roxmltree 0.20.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/roxmltree-0.20.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/roxmltree-0.20.0/LICENSE-MIT) |
| roxmltree 0.21.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/roxmltree-0.21.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/roxmltree-0.21.1/LICENSE-MIT) |
| rustc-hash 2.1.3 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/rustc-hash-2.1.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/rustc-hash-2.1.3/LICENSE-MIT) |
| rustc_version 0.4.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/rustc_version-0.4.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/rustc_version-0.4.1/LICENSE-MIT) |
| rustversion 1.0.23 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/rustversion-1.0.23/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/rustversion-1.0.23/LICENSE-MIT) |
| rustybuzz 0.20.1 | MIT | [LICENSE](../licenses/rust/rustybuzz-0.20.1/LICENSE), [scripts/ms-use/COPYING](../licenses/rust/rustybuzz-0.20.1/scripts/ms-use/COPYING) |
| ryu 1.0.23 | Apache-2.0 OR BSL-1.0 | [LICENSE-APACHE](../licenses/rust/ryu-1.0.23/LICENSE-APACHE), [LICENSE-BOOST](../licenses/rust/ryu-1.0.23/LICENSE-BOOST) |
| scopeguard 1.2.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/scopeguard-1.2.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/scopeguard-1.2.0/LICENSE-MIT) |
| semver 1.0.28 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/semver-1.0.28/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/semver-1.0.28/LICENSE-MIT) |
| serde 1.0.229 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/serde-1.0.229/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/serde-1.0.229/LICENSE-MIT) |
| serde_core 1.0.229 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/serde_core-1.0.229/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/serde_core-1.0.229/LICENSE-MIT) |
| serde_derive 1.0.229 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/serde_derive-1.0.229/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/serde_derive-1.0.229/LICENSE-MIT) |
| serde_json 1.0.151 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/serde_json-1.0.151/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/serde_json-1.0.151/LICENSE-MIT) |
| sha1 0.11.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/sha1-0.11.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/sha1-0.11.0/LICENSE-MIT) |
| sha2 0.11.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/sha2-0.11.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/sha2-0.11.0/LICENSE-MIT) |
| sha3 0.11.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/sha3-0.11.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/sha3-0.11.0/LICENSE-MIT) |
| shake 0.1.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/shake-0.1.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/shake-0.1.0/LICENSE-MIT) |
| shlex 2.0.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/shlex-2.0.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/shlex-2.0.1/LICENSE-MIT) |
| signature 3.0.0 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/signature-3.0.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/signature-3.0.0/LICENSE-MIT) |
| simd-adler32 0.3.10 | MIT | [LICENSE.md](../licenses/rust/simd-adler32-0.3.10/LICENSE.md) |
| simdutf8 0.1.5 | MIT OR Apache-2.0 | [LICENSE-Apache](../licenses/rust/simdutf8-0.1.5/LICENSE-Apache), [LICENSE-MIT](../licenses/rust/simdutf8-0.1.5/LICENSE-MIT) |
| simplecss 0.2.2 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/simplecss-0.2.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/simplecss-0.2.2/LICENSE-MIT) |
| siphasher 1.0.3 | MIT/Apache-2.0 | [COPYING](../licenses/rust/siphasher-1.0.3/COPYING) |
| skrifa 0.42.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/skrifa-0.42.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/skrifa-0.42.1/LICENSE-MIT) |
| slotmap 1.1.1 | Zlib | [LICENSE](../licenses/rust/slotmap-1.1.1/LICENSE) |
| smallvec 1.15.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/smallvec-1.15.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/smallvec-1.15.2/LICENSE-MIT) |
| snafu-derive 0.9.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/snafu-derive-0.9.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/snafu-derive-0.9.2/LICENSE-MIT) |
| snafu 0.9.2 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/snafu-0.9.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/snafu-0.9.2/LICENSE-MIT) |
| spki 0.8.0 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/spki-0.8.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/spki-0.8.0/LICENSE-MIT) |
| sponge-cursor 0.1.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/sponge-cursor-0.1.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/sponge-cursor-0.1.0/LICENSE-MIT) |
| strict-num 0.1.1 | MIT | [LICENSE](../licenses/rust/strict-num-0.1.1/LICENSE) |
| strum 0.28.0 | MIT | [LICENSE](../licenses/rust/strum-0.28.0/LICENSE) |
| strum_macros 0.28.0 | MIT | [LICENSE](../licenses/rust/strum_macros-0.28.0/LICENSE) |
| subsetter 0.2.6 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/subsetter-0.2.6/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/subsetter-0.2.6/LICENSE-MIT), [NOTICE](../licenses/rust/subsetter-0.2.6/NOTICE) |
| subtle 2.6.1 | BSD-3-Clause | [LICENSE](../licenses/rust/subtle-2.6.1/LICENSE) |
| svgtypes 0.15.3 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/svgtypes-0.15.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/svgtypes-0.15.3/LICENSE-MIT) |
| svgtypes 0.16.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/svgtypes-0.16.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/svgtypes-0.16.1/LICENSE-MIT) |
| syn 2.0.119 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/syn-2.0.119/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/syn-2.0.119/LICENSE-MIT) |
| syn 3.0.3 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/syn-3.0.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/syn-3.0.3/LICENSE-MIT) |
| tiff 0.11.3 | MIT | [LICENSE](../licenses/rust/tiff-0.11.3/LICENSE), [tests/COPYRIGHT](../licenses/rust/tiff-0.11.3/tests/COPYRIGHT) |
| tiny-skia-path 0.11.4 | BSD-3-Clause | [LICENSE](../licenses/rust/tiny-skia-path-0.11.4/LICENSE) |
| tiny-skia 0.11.4 | BSD-3-Clause | [LICENSE](../licenses/rust/tiny-skia-0.11.4/LICENSE) |
| tinyvec 1.12.0 | Zlib OR Apache-2.0 OR MIT | [LICENSE-APACHE.md](../licenses/rust/tinyvec-1.12.0/LICENSE-APACHE.md), [LICENSE-MIT.md](../licenses/rust/tinyvec-1.12.0/LICENSE-MIT.md), [LICENSE-ZLIB.md](../licenses/rust/tinyvec-1.12.0/LICENSE-ZLIB.md) |
| tinyvec_macros 0.1.1 | MIT OR Apache-2.0 OR Zlib | [LICENSE-APACHE.md](../licenses/rust/tinyvec_macros-0.1.1/LICENSE-APACHE.md), [LICENSE-MIT.md](../licenses/rust/tinyvec_macros-0.1.1/LICENSE-MIT.md), [LICENSE-ZLIB.md](../licenses/rust/tinyvec_macros-0.1.1/LICENSE-ZLIB.md) |
| ttf-parser 0.25.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/ttf-parser-0.25.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/ttf-parser-0.25.1/LICENSE-MIT) |
| typed-path 0.12.3 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/typed-path-0.12.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/typed-path-0.12.3/LICENSE-MIT) |
| typenum 1.20.1 | MIT OR Apache-2.0 | [LICENSE](../licenses/rust/typenum-1.20.1/LICENSE), [LICENSE-APACHE](../licenses/rust/typenum-1.20.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/typenum-1.20.1/LICENSE-MIT) |
| unicode-bidi-mirroring 0.4.0 | MIT/Apache-2.0 | [LICENSE-APACHE](../licenses/rust/unicode-bidi-mirroring-0.4.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/unicode-bidi-mirroring-0.4.0/LICENSE-MIT) |
| unicode-bidi 0.3.18 | MIT OR Apache-2.0 | [COPYRIGHT](../licenses/rust/unicode-bidi-0.3.18/COPYRIGHT), [LICENSE-APACHE](../licenses/rust/unicode-bidi-0.3.18/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/unicode-bidi-0.3.18/LICENSE-MIT) |
| unicode-ccc 0.4.0 | MIT/Apache-2.0 | [LICENSE-APACHE](../licenses/rust/unicode-ccc-0.4.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/unicode-ccc-0.4.0/LICENSE-MIT) |
| unicode-ident 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 | [LICENSE-APACHE](../licenses/rust/unicode-ident-1.0.24/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/unicode-ident-1.0.24/LICENSE-MIT), [LICENSE-UNICODE](../licenses/rust/unicode-ident-1.0.24/LICENSE-UNICODE) |
| unicode-properties 0.1.4 | MIT/Apache-2.0 | [COPYRIGHT](../licenses/rust/unicode-properties-0.1.4/COPYRIGHT), [LICENSE-APACHE](../licenses/rust/unicode-properties-0.1.4/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/unicode-properties-0.1.4/LICENSE-MIT) |
| unicode-script 0.5.8 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/unicode-script-0.5.8/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/unicode-script-0.5.8/LICENSE-MIT) |
| unicode-segmentation 1.13.3 | MIT OR Apache-2.0 | [COPYRIGHT](../licenses/rust/unicode-segmentation-1.13.3/COPYRIGHT), [LICENSE-APACHE](../licenses/rust/unicode-segmentation-1.13.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/unicode-segmentation-1.13.3/LICENSE-MIT) |
| unicode-vo 0.1.0 | MIT/Apache-2.0 | [LICENSE-APACHE](../licenses/rust/unicode-vo-0.1.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/unicode-vo-0.1.0/LICENSE-MIT) |
| unicode-width 0.2.2 | MIT OR Apache-2.0 | [COPYRIGHT](../licenses/rust/unicode-width-0.2.2/COPYRIGHT), [LICENSE-APACHE](../licenses/rust/unicode-width-0.2.2/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/unicode-width-0.2.2/LICENSE-MIT) |
| universal-hash 0.6.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/universal-hash-0.6.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/universal-hash-0.6.1/LICENSE-MIT) |
| usvg 0.45.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/usvg-0.45.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/usvg-0.45.1/LICENSE-MIT) |
| uuid 1.24.1 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/uuid-1.24.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/uuid-1.24.1/LICENSE-MIT) |
| version_check 0.9.5 | MIT/Apache-2.0 | [LICENSE-APACHE](../licenses/rust/version_check-0.9.5/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/version_check-0.9.5/LICENSE-MIT) |
| wasm-bindgen-macro-support 0.2.127 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/wasm-bindgen-macro-support-0.2.127/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/wasm-bindgen-macro-support-0.2.127/LICENSE-MIT) |
| wasm-bindgen-macro 0.2.127 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/wasm-bindgen-macro-0.2.127/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/wasm-bindgen-macro-0.2.127/LICENSE-MIT) |
| wasm-bindgen-shared 0.2.127 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/wasm-bindgen-shared-0.2.127/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/wasm-bindgen-shared-0.2.127/LICENSE-MIT) |
| wasm-bindgen 0.2.127 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/wasm-bindgen-0.2.127/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/wasm-bindgen-0.2.127/LICENSE-MIT) |
| web-time 1.1.0 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/web-time-1.1.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/web-time-1.1.0/LICENSE-MIT) |
| weezl 0.1.12 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/weezl-0.1.12/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/weezl-0.1.12/LICENSE-MIT) |
| write-fonts 0.48.1 | MIT OR Apache-2.0 | [LICENSE-APACHE](../licenses/rust/write-fonts-0.48.1/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/write-fonts-0.48.1/LICENSE-MIT) |
| xmlwriter 0.1.0 | MIT | [LICENSE](../licenses/rust/xmlwriter-0.1.0/LICENSE) |
| zerocopy-derive 0.8.56 | BSD-2-Clause OR Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/zerocopy-derive-0.8.56/LICENSE-APACHE), [LICENSE-BSD](../licenses/rust/zerocopy-derive-0.8.56/LICENSE-BSD), [LICENSE-MIT](../licenses/rust/zerocopy-derive-0.8.56/LICENSE-MIT) |
| zerocopy 0.8.56 | BSD-2-Clause OR Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/zerocopy-0.8.56/LICENSE-APACHE), [LICENSE-BSD](../licenses/rust/zerocopy-0.8.56/LICENSE-BSD), [LICENSE-MIT](../licenses/rust/zerocopy-0.8.56/LICENSE-MIT) |
| zeroize 1.9.0 | Apache-2.0 OR MIT | [LICENSE-APACHE](../licenses/rust/zeroize-1.9.0/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/zeroize-1.9.0/LICENSE-MIT) |
| zip 8.6.0 | MIT | [LICENSE](../licenses/rust/zip-8.6.0/LICENSE) |
| zlib-rs 0.6.7 | Zlib | [LICENSE](../licenses/rust/zlib-rs-0.6.7/LICENSE) |
| zmij 1.0.23 | MIT | [LICENSE-MIT](../licenses/rust/zmij-1.0.23/LICENSE-MIT) |
| zopfli 0.8.3 | Apache-2.0 | [COPYING](../licenses/rust/zopfli-0.8.3/COPYING) |
| zune-core 0.4.12 | MIT OR Apache-2.0 OR Zlib | [LICENSE-ZLIB](../licenses/rust/zune-core-0.4.12/LICENSE-ZLIB), [LICENSE.md](../licenses/rust/zune-core-0.4.12/LICENSE.md) |
| zune-core 0.5.3 | MIT OR Apache-2.0 OR Zlib | [LICENSE-APACHE](../licenses/rust/zune-core-0.5.3/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/zune-core-0.5.3/LICENSE-MIT), [LICENSE-ZLIB](../licenses/rust/zune-core-0.5.3/LICENSE-ZLIB) |
| zune-jpeg 0.4.21 | MIT OR Apache-2.0 OR Zlib | [LICENSE-ZLIB](../licenses/rust/zune-jpeg-0.4.21/LICENSE-ZLIB), [LICENSE.md](../licenses/rust/zune-jpeg-0.4.21/LICENSE.md) |
| zune-jpeg 0.5.15 | MIT OR Apache-2.0 OR Zlib | [LICENSE-APACHE](../licenses/rust/zune-jpeg-0.5.15/LICENSE-APACHE), [LICENSE-MIT](../licenses/rust/zune-jpeg-0.5.15/LICENSE-MIT), [LICENSE-ZLIB](../licenses/rust/zune-jpeg-0.5.15/LICENSE-ZLIB) |
