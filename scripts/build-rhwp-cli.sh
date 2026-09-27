#!/bin/sh
# rhwp/(스냅샷된 포크)에서 rhwp CLI를 릴리스로 빌드해 bin/<os>-<arch>/rhwp 에 넣는다.
# LIDGE_HWP_CARGO_TARGET 을 주면 그 cargo target을 같이 써서 의존성 컴파일을 건너뛴다.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
[ -n "${LIDGE_HWP_CARGO_TARGET:-}" ] && export CARGO_TARGET_DIR="$LIDGE_HWP_CARGO_TARGET"
TARGET_DIR=${CARGO_TARGET_DIR:-"$ROOT/rhwp/target"}
(cd "$ROOT/rhwp" && cargo build --release --locked --bin rhwp)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
[ "$ARCH" = aarch64 ] && ARCH=arm64
mkdir -p "$ROOT/bin/$OS-$ARCH"
install -m 755 "$TARGET_DIR/release/rhwp" "$ROOT/bin/$OS-$ARCH/rhwp"
# Record the fork base and local source-asset patches, not just the unpatched fork SHA.
node --input-type=module - "$ROOT" "$OS-$ARCH" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [root, platform] = process.argv.slice(2);
const vendor = JSON.parse(readFileSync(join(root, 'rhwp/.lidge-vendor.json'), 'utf8'));
const sum = file => createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
const assets = ['rhwp/saved/blank2010.hwp',
  'rhwp/src/parser/hwpx/blank2010_assets/hwp_summary_information.bin',
  'rhwp/src/parser/hwpx/blank2010_assets/doc_options_link_doc.bin'];
writeFileSync(join(root, 'bin', platform, 'BUILD.json'), JSON.stringify({
  source: `rhwp/ (lidge-ai/rhwp base ${vendor.commit}; local patches listed below)`,
  localPatches: vendor.localPatches ?? [],
  sourceAssets: Object.fromEntries(assets.map(file => [file, sum(file)])),
  sha256: sum(`bin/${platform}/rhwp`),
}, null, 2) + '\n');
NODE
"$ROOT/bin/rhwp" --version
