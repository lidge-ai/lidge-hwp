#!/bin/sh
# 포크(lidge-ai/rhwp)의 한 커밋을 이 저장소의 rhwp/ 로 스냅샷한다.
# 포크 기록은 4GB가 넘어서 기록째 합치지 않는다. 대신 빌드와 단위 테스트에 필요한 파일만 가져오고,
# 어느 커밋에서 왔는지 rhwp/.lidge-vendor.json 에 남긴다.
# 사용법: scripts/rhwp-vendor.sh <포크 경로> [ref]
#   포크 경로는 인자 또는 LIDGE_HWP_FORK로 지정한다. ref 기본값: lidge/studio-host-devel
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FORK=${1:-${LIDGE_HWP_FORK:-}}
[ -n "$FORK" ] || { echo 'Provide a fork path as the first argument or set LIDGE_HWP_FORK' >&2; exit 1; }
REF=${2:-lidge/studio-host-devel}
DEST="$ROOT/rhwp"
COMMIT=$(git -C "$FORK" rev-parse --verify "$REF^{commit}")
BASE=$(git -C "$FORK" merge-base "$COMMIT" upstream/devel 2>/dev/null || echo unknown)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

# 무거운 기록물과 비공개 문서·샘플·검증 증거는 공개 스냅샷에서 뺀다.
git -C "$FORK" archive "$COMMIT" -- . \
  ':(exclude)mydocs' ':(exclude)pdf' ':(exclude)samples' \
  ':(exclude)tests/fixtures' ':(exclude)tests/golden_svg' ':(exclude)fuzz/corpus' \
  ':(exclude)saved' ':(exclude)rhwp-studio/public/samples' ':(exclude)tools/task2279/evidence' \
  ':(exclude)scripts/survey_korea_downloads_font_jsdelivr.mjs' \
  ':(exclude,glob)tools/llm_verifier/*/corpus/**' ':(exclude,glob)tools/llm_verifier/*/fixtures/**' \
  | tar -x -C "$TMP"
# 빌드가 include_str!/include_bytes! 로 끌어다 쓰는 파일은 되살린다(mcp_serve 안내문, 단위 테스트 표본).
git -C "$FORK" archive "$COMMIT" -- \
  mydocs/manual ':(exclude)mydocs/manual/memory' ':(exclude)mydocs/manual/codex' \
  mydocs/tech/agent_roadmap/atlas_r1_r200.md tests/fixtures/fonts saved/blank2010.hwp \
  samples/hml/formatting_table.hml samples/render-p35-font-native-bitmap.hwpx \
  'samples/3-09월_교육_통합_2022.hwp' samples/hwp3-sample16-hwp5.hwp \
  samples/hwpx/ref/ref_empty.hwpx \
  | tar -x -C "$TMP"

cat > "$TMP/.lidge-vendor.json" <<EOF
{
  "repository": "https://github.com/lidge-ai/rhwp",
  "upstream": "https://github.com/edwardkim/rhwp",
  "ref": "$REF",
  "commit": "$COMMIT",
  "upstreamDevelBase": "$BASE",
  "localPatches": ["sanitize embedded blank-document author and local-path metadata", "rename modified Source Han subset primary names to LIDGE Old Hangul Serif without glyph changes"],
  "excluded": ["mydocs (manual 제외)", "mydocs/manual/memory", "mydocs/manual/codex", "pdf", "samples (빌드 참조 표본 제외)", "samples/hwpx/aift.hwpx", "tests/fixtures (fonts 제외)", "tests/golden_svg", "fuzz/corpus", "saved (blank2010.hwp 제외)", "rhwp-studio/public/samples", "tools/task2279/evidence", "scripts/survey_korea_downloads_font_jsdelivr.mjs", "tools/llm_verifier/*/corpus", "tools/llm_verifier/*/fixtures"]
}
EOF

mkdir -p "$DEST"
node "$ROOT/scripts/sanitize-rhwp-metadata.mjs" --root "$TMP" --apply
"${LIDGE_HWP_FONT_PYTHON:-python3}" "$ROOT/scripts/rename-sourcehan-subset.py" --root "$TMP" --apply
# 빌드 산출물(target, pkg, node_modules, dist)은 스냅샷 대상이 아니라서 지우지 않는다.
rsync -a --delete \
  --exclude '/target/' --exclude '/pkg/' --exclude 'node_modules/' --exclude '/rhwp-studio/dist/' \
  --exclude '/assets/fonts/licenses/' \
  "$TMP/" "$DEST/"
echo "rhwp/ <- $COMMIT ($REF)"
