#!/usr/bin/env bash
# 계획서(plan.json) 하나로 HWP 서식을 채우고, 검증하고, 미리보기 PDF/PNG 까지 만든다.
# 사용법: scripts/fill.sh plans/<계획>.json
# - 먼저 dry-run 으로 전 step 선검증 (좌표 틀리면 아무것도 안 씀)
# - 통과하면 원자 실행 (assertions.verify=true 면 재읽기 대조까지)
# - 산출물 옆에 .pdf 와 1쪽 .png 미리보기 생성
set -euo pipefail
RHWP="${RHWP_BIN:-$(dirname "$0")/../bin/rhwp}"
PLAN="${1:?usage: scripts/fill.sh plans/<plan>.json}"
cd "$(dirname "$0")/.."

echo "[1/3] dry-run 선검증"
"$RHWP" run "$PLAN" --dry-run --json >/dev/null 2>&1 || { "$RHWP" run "$PLAN" --dry-run --json; exit 2; }

echo "[2/3] 실행"
"$RHWP" run "$PLAN" --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
const steps=j.journal||j.steps||[];console.log("  applied steps:",Array.isArray(steps)?steps.length:"?","| output:",j.output||"")})'

OUT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).output)' "$PLAN")"
echo "[3/3] 미리보기"
"$RHWP" export-pdf "$OUT" -o "${OUT%.*}.pdf" 2>/dev/null | tail -1
if command -v sips >/dev/null; then
  sips -s format png "${OUT%.*}.pdf" --out "${OUT%.*}.p1.png" >/dev/null 2>&1 && echo "  → ${OUT%.*}.p1.png"
fi
echo "done: $OUT  (제출 전 한컴오피스에서 한 번 열어 확인할 것)"
