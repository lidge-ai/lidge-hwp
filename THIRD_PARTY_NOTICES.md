# Third-party software and assets

The root MIT license covers original LIDGE HWP code. Third-party files retain
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
- **Fonts**: separate licenses apply. See [web font inventory](rhwp/assets/fonts/FONTS.md),
  [font sources](rhwp/ttfs/opensource/README.md), OFL notices in those directories,
  and [redistributable font notices](rhwp/ttfs/redistributable/README.md).
  System and commercial fonts are not granted a redistribution license by this project.
- **Synthetic font fixtures**: preserve the `.LICENSE.md` notices in `rhwp/tests/fixtures/fonts/`.

Personal documents, application forms, development transcripts and private repository
history are not part of this public distribution. Dependency versions and available
license identifiers are recorded in the npm and Cargo lockfiles.
