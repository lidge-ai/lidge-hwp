#!/usr/bin/env bash
# rhwp 공식 릴리스 바이너리를 고정 버전으로 설치한다 (~/.local/bin/rhwp).
# 사용법: scripts/install-rhwp.sh [버전]   예) scripts/install-rhwp.sh v0.8.6
set -euo pipefail
VER="${1:-v0.8.6}"
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64)  ASSET="rhwp-$VER-macos-aarch64.tar.gz" ;;
  Darwin-x86_64) ASSET="rhwp-$VER-macos-x86_64.tar.gz" ;;
  Linux-aarch64) ASSET="rhwp-$VER-linux-aarch64.tar.gz" ;;
  Linux-x86_64)  ASSET="rhwp-$VER-linux-x86_64.tar.gz" ;;
  *) echo "unsupported: $OS-$ARCH (Windows 는 릴리스 zip 을 수동 설치)"; exit 1 ;;
esac
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
BASE="https://github.com/edwardkim/rhwp/releases/download/$VER"
curl -fsSL -o "$ASSET" "$BASE/$ASSET"
curl -fsSL -o SHA256SUMS.txt "$BASE/SHA256SUMS.txt"
grep " $ASSET\$" SHA256SUMS.txt | shasum -a 256 -c -
tar xzf "$ASSET"
mkdir -p "$HOME/.local/bin"
install -m 755 rhwp/rhwp "$HOME/.local/bin/rhwp"
# macOS: 다운로드 격리 속성이 남아 있으면 실행 시 SIGKILL 된다
[ "$OS" = Darwin ] && xattr -cr "$HOME/.local/bin/rhwp" || true
"$HOME/.local/bin/rhwp" --version
