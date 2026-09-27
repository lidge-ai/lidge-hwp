# Public snapshot changes

The engine base is recorded in `rhwp/.lidge-vendor.json`; this repository is not an
unmodified mirror of that fork. Original copyright and license notices are retained.

- Private author/account and local-path metadata in the blank HWP template and two
  embedded OLE fallback streams are anonymized. `scripts/sanitize-rhwp-metadata.mjs`
  follows CFB/property-set structures, pins non-metadata bytes by masked SHA-256,
  and rejects unknown layouts. The document body and non-metadata streams are unchanged.
- The modified Source Han old-Hangul subset is named **LIDGE Old Hangul Serif** internally.
  This avoids use of Adobe's reserved primary font name for the modified subset.
  Original attribution/OFL notices are retained. Compatibility asset filenames and CSS
  lookup aliases identify the existing fallback route; the derived font's primary name
  is LIDGE Old Hangul Serif. Glyphs, outlines, metrics, character maps and shaping tables
  are preserved. The reproducible metadata tool is `scripts/rename-sourcehan-subset.py`.
- Private memory notes, application development logs and unnecessary document corpora
  are not distributed. The old private Git objects and refs are not imported.
- Build paths are remapped in published native/WASM artifacts. `BUILD.json` records the
  CLI checksum and source asset checksums rather than claiming the fork base is unchanged.
- External library-root registration and shadow Git history are application storage features under `lib/` and `server/`. They do not modify the vendored `rhwp/` fork or write Git metadata into a selected document folder.
- The vendored Studio embed adds recovered:true markers to three pre-dispatch lidge.applyOps rejections (invalid router parameters, missing negotiated capability, failed initial state read). Existing post-dispatch snapshot-rollback recovery is unchanged. The host preserves apply failure causes, serializes the next prepare behind release, and unlocks input before acknowledging release.

Font license source files and per-font attribution are included under
`rhwp/assets/fonts/licenses/`. These files accompany the web font assets in Studio builds.
The top-level license does not relicense fonts or third-party dependencies.

Updating the vendored fork must reapply these changes before publication. The metadata
sanitizer deliberately fails on structural changes so a future upstream template needs
explicit review. Do not copy the private repository's branches or tags into this repository.
