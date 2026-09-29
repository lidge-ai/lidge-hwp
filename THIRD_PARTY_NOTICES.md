# Third-party software and assets

The root MIT license covers original code of this project. Third-party files retain
their original copyright notices and licenses; the root license does not replace them.

- **rhwp / rhwp-studio**: Copyright (c) 2025–2026 Edward Kim, MIT.
  See [rhwp/LICENSE](rhwp/LICENSE), [upstream](https://github.com/edwardkim/rhwp)
  and [fork provenance](rhwp/.lidge-vendor.json).
- **Bundled CLI**: its source commit and checksum are recorded in
  [bin/darwin-arm64/BUILD.json](bin/darwin-arm64/BUILD.json).
  Source is included in `rhwp/`; rebuild with `scripts/build-rhwp-cli.sh`.
- **rhwp dependencies**: [rhwp/THIRD_PARTY_LICENSES.md](rhwp/THIRD_PARTY_LICENSES.md)
  and vendored license files apply, including [svg2pdf notices](rhwp/vendor/svg2pdf/NOTICE).
  Collected original notices for the native binary are in
  [licenses/RUST-DEPENDENCIES.md](licenses/RUST-DEPENDENCIES.md).
- **kordoc 4.15.4**: MIT; installed through npm, not vendored.
  Preserve its own NOTICE and third-party files if redistributing installed dependencies.
- **SheetJS Community Edition (xlsx) 0.20.3**: Apache-2.0; installed through npm, not vendored.
  [SheetJS CE](https://git.sheetjs.com/SheetJS/sheetjs).
- **ExcelJS 4.4.0**: MIT; installed through npm, not vendored.
  [ExcelJS](https://github.com/exceljs/exceljs).
- **React 18.3.1 / react-dom 18.3.1**: MIT; installed through npm, not vendored.
  [React](https://github.com/facebook/react).
- **FortuneSheet (@fortune-sheet/react 1.0.4, @fortune-sheet/core 1.0.4)**: MIT;
  installed through npm, not vendored. [FortuneSheet](https://github.com/ruilisi/fortune-sheet).
- **docx-editor (@docx-editor.dev/react 2.23.0, @docx-editor.dev/core 2.23.0)**: Apache-2.0;
  installed through npm, not vendored. [docx-editor](https://docx-editor.dev).
  Only the Apache-2.0 community packages are used; the Pro packages
  (@docx-editor.dev/editor-api, @docx-editor.dev/pro, @docx-editor.dev/docx-to-pdf)
  are NOT used and are not installed.
- **yjs 13.6.33**: MIT; installed through npm, not vendored.
  [yjs](https://github.com/yjs/yjs).
- **pdf-lib 1.17.1**: MIT; installed through npm, not vendored.
  [pdf-lib](https://github.com/Hopding/pdf-lib).
- **pdfjs-dist 6.3.289**: Apache-2.0; installed through npm, not vendored.
  [PDF.js](https://github.com/mozilla/pdf.js).
- **Pretendard 1.3.9**: SIL Open Font License 1.1; installed through npm, not vendored.
  [Pretendard](https://github.com/orioncactus/pretendard).
- **esbuild 0.28.2**: MIT; build-time only, installed through npm, not vendored.
  [esbuild](https://github.com/evanw/esbuild).
- **LibreOffice**: NOT bundled with this app. When locally installed it is invoked as an
  external binary for document conversion. [LibreOffice](https://www.libreoffice.org/)
  is licensed under MPL-2.0; its terms apply to the installed copy, not to this repository.
- **Fonts**: separate licenses apply. See [web font inventory](rhwp/assets/fonts/FONTS.md),
  [font sources](rhwp/ttfs/opensource/README.md), OFL notices in those directories,
  and [redistributable font notices](rhwp/ttfs/redistributable/README.md).
  System and commercial fonts are not granted a redistribution license by this project.
- **Synthetic font fixtures**: preserve the `.LICENSE.md` notices in `rhwp/tests/fixtures/fonts/`.

Personal documents, application forms, development transcripts and private repository
history are not part of this public distribution. Dependency versions and available
license identifiers are recorded in the npm and Cargo lockfiles.
