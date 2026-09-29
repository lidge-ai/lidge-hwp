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
- In the vendored Studio, embed chrome forwards F2, Cmd+Shift+R, Cmd+Shift+C, Cmd+N and Option+Cmd+N through lidge-host-v1 as rename, copy-path and new-document requests. The transport and npm wrapper explicitly allow and type these events; full chrome and Option+C format copy retain their existing behavior. Reapply this patch when refreshing rhwp/.
- The vendored Studio agent replay allowlist (`rhwp-studio/src/lidge/api-registry.ts`) adds the existing engine methods insertTextInCellByPath, deleteTextInCellByPath, splitParagraphInCellByPath and mergeParagraphInCellByPath so agent edits to cells of one-level nested tables replay in the open editor tab. The engine (Rust) is unchanged.
- The DOCX editor bundle (`build/office`) applies a build-time patch to `@docx-editor.dev/core` 2.23.0 (Apache-2.0); the installed package in `node_modules` is not modified. Reason: the page painter `Ln` reuses fragment DOM only by object identity, and layout creates new fragment objects on every keystroke, so the edited page's fragments were repainted from scratch (about 1,000 new nodes per key in a 600-paragraph document). Browsers whose extensions observe whole-document DOM changes, such as Aside, turn that churn into typing latency. `scripts/docx-paint-reuse.mjs` reuses a previous fragment element of the same page when its JSON signature is equal (fragments carrying Map, Set, functions or DOM nodes are never reused) and adds `fieldShading`, `shadeFormFields`, `activeHeaderFooterRId` and `activeHeaderFooterPageIndex` to the paint-parameter key so a change there forces a full page repaint. It matches three minified anchors (the `Ln` head, the fragment pick `r.get(h)??…`, the end of the `Tn` parameter key) and fails the build with `DOCX_PAINT_PATCH_DRIFT` unless each occurs exactly once in exactly one chunk, so an engine upgrade needs explicit review. To revert, remove the `plugins: [docxPaintReusePlugin({ readFile })]` line (and its import) from `scripts/build-office.mjs` and rebuild with `npm run build:office`. Checks: `test/docx-paint-reuse.test.mjs` and `test/docx-typing-browser.mjs`.

Font license source files and per-font attribution are included under
`rhwp/assets/fonts/licenses/`. These files accompany the web font assets in Studio builds.
The top-level license does not relicense fonts or third-party dependencies.

Updating the vendored fork must reapply these changes before publication. The metadata
sanitizer deliberately fails on structural changes so a future upstream template needs
explicit review. Do not copy the private repository's branches or tags into this repository.
