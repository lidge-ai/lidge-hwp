#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# 기본은 이 저장소에 스냅샷된 포크(rhwp/)다. 포크 체크아웃에서 바로 빌드하려면 LIDGE_HWP_RHWP를 준다.
FORK=${LIDGE_HWP_RHWP:-"$ROOT/rhwp"}
# PATH의 Node를 쓴다. LIDGE_HWP_NODE_BIN은 Node 실행 파일 또는 bin 디렉터리로 재정의한다.
NODE_BIN=${LIDGE_HWP_NODE_BIN:-node}
[ ! -d "$NODE_BIN" ] || NODE_BIN="$NODE_BIN/node"
NODE_BIN=$(command -v "$NODE_BIN") || { echo 'Node >=26 required (node on PATH or LIDGE_HWP_NODE_BIN)' >&2; exit 1; }
NODE_DIR=$(CDPATH= cd -- "$(dirname -- "$NODE_BIN")" && pwd)
NODE_BIN="$NODE_DIR/$(basename -- "$NODE_BIN")"
export PATH="$NODE_DIR:$HOME/.cargo/bin:$PATH"
# 다른 체크아웃의 cargo target을 같이 쓰면 의존성 컴파일을 다시 하지 않는다.
[ -n "${LIDGE_HWP_CARGO_TARGET:-}" ] && export CARGO_TARGET_DIR="$LIDGE_HWP_CARGO_TARGET"
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 26) { console.error("Node >=26 required; found " + process.version); process.exit(1); }'
[ -f "$FORK/Cargo.lock" ] && [ -f "$FORK/rhwp-studio/package-lock.json" ]
# wasm-pack도 public/rhwp.js를 덮어쓴다. 인덱스를 건드리지 않고 기존 작업 파일을 보관·복구한다.
PUBLIC_JS="$FORK/rhwp-studio/public/rhwp.js"
[ ! -L "$PUBLIC_JS" ] && { [ ! -e "$PUBLIC_JS" ] || [ -f "$PUBLIC_JS" ]; } || {
  echo "Expected a regular file or absent path: $PUBLIC_JS" >&2; exit 1;
}
PUBLIC_BACKUP=$(mktemp -d)
if [ -f "$PUBLIC_JS" ]; then
  cp -p "$PUBLIC_JS" "$PUBLIC_BACKUP/rhwp.js"
fi
restore_public_js() {
  if [ -f "$PUBLIC_BACKUP/rhwp.js" ]; then
    cp -p "$PUBLIC_BACKUP/rhwp.js" "$PUBLIC_JS" || {
      echo "Could not restore $PUBLIC_JS; backup kept at $PUBLIC_BACKUP" >&2; return 1;
    }
  else
    rm -f "$PUBLIC_JS" || return 1
  fi
  rm -r "$PUBLIC_BACKUP"
}
trap restore_public_js EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# 탭 쪽 TS만 바뀌었으면 LIDGE_HWP_SKIP_WASM=1로 기존 pkg를 쓴다(cargo 빌드·target 폴더를 만들지 않는다).
if [ "${LIDGE_HWP_SKIP_WASM:-0}" = 1 ] && [ -s "$FORK/pkg/rhwp.js" ] && [ -s "$FORK/pkg/rhwp_bg.wasm" ]; then
  echo 'wasm-pack 생략: 기존 pkg 재사용'
else
  (cd "$FORK" && sh scripts/wasm-pack-locked.sh --target web --release --out-dir pkg)
fi
[ -s "$FORK/pkg/rhwp.js" ] && [ -s "$FORK/pkg/rhwp_bg.wasm" ]
(cd "$FORK/rhwp-studio" && npm ci --include=optional)
cp "$FORK/pkg/rhwp.js" "$FORK/pkg/rhwp_bg.wasm" "$FORK/rhwp-studio/public/"
(cd "$FORK/rhwp-studio" && LIDGE_STUDIO_BASE=/studio/ npm run build -- --base=/studio/)
mkdir -p "$ROOT/build/studio" "$ROOT/build/editor" "$ROOT/build/wasm"
cp -R "$FORK/rhwp-studio/dist/." "$ROOT/build/studio/"
for file in index.js index.d.ts transport.js document-agent-contract.js package.json; do
  cp "$FORK/npm/editor/$file" "$ROOT/build/editor/$file"
done
cp "$FORK/pkg/rhwp.js" "$FORK/pkg/rhwp_bg.wasm" "$ROOT/build/wasm/"
test -s "$ROOT/build/studio/index.html"
test -s "$ROOT/build/editor/index.js"
test -s "$ROOT/build/wasm/rhwp_bg.wasm"
