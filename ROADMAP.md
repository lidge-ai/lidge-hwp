# 로드맵: 문서함 확장·단축키·MCP 개선 (2026-09)

Aside로 QA를 돌리다 나온 MCP 문제 두 개와, 문서함을 더 편하게 쓰기 위한 기능 여섯 개를 이슈 여덟 개로 나눴다.
앞 이슈가 main에 병합된 뒤에 다음 이슈를 시작한다. 이슈 하나가 PR 하나다.

| 순서 | 이슈 | 내용 | 먼저 필요한 것 |
| --- | --- | --- | --- |
| 1 | [#4](https://github.com/lidge-ai/lidge-hwp/issues/4) | MCP: 같은 호출에서 같은 문서를 다시 열면 기존 핸들을 돌려준다 | - |
| 2 | [#5](https://github.com/lidge-ai/lidge-hwp/issues/5) | MCP: 실패한 호출 뒤 탭이 격리되는 문제, 원래 오류 보존 | #4 |
| 3 | [#6](https://github.com/lidge-ai/lidge-hwp/issues/6) | 기본 문서함 밖 폴더(추가 폴더)를 목록·열기·저장. 이력은 `~/.lidge-hwp/history`에 두고 폴더에는 `.git`을 만들지 않는다 | #5 |
| 4 | [#7](https://github.com/lidge-ai/lidge-hwp/issues/7) | 사이드바에서 Finder로 폴더 추가·제거 | #6 |
| 5 | [#8](https://github.com/lidge-ai/lidge-hwp/issues/8) | 문서 이름 바꾸기, ⌘⇧R | #6, #7 |
| 6 | [#9](https://github.com/lidge-ai/lidge-hwp/issues/9) | 절대 경로 복사, ⌘⇧C | #6, #8 |
| 7 | [#10](https://github.com/lidge-ai/lidge-hwp/issues/10) | 새 한글 문서, ⌘N(버튼과 ⌥⌘N 포함) | #6, #7, #8 |
| 8 | [#11](https://github.com/lidge-ai/lidge-hwp/issues/11) | 편집기 안에서도 ⌘⇧R·⌘⇧C·⌘N이 동작 | #8, #9, #10 |

## 사람이 확인해야 하는 것

자동 테스트로는 증명할 수 없어서 병합 뒤 실제 앱에서 확인한다.

- Finder 폴더 선택 창에서 고르기와 취소. macOS가 자동화 권한을 물을 수 있다.
- 브라우저가 ⌘N·⌘⇧R·⌘⇧C를 페이지에 넘기는지. 크롬 계열은 ⌘N을 새 창용으로 잡아 둘 수 있어서 버튼과 ⌥⌘N을 같이 둔다.
- 대소문자만 바꾸는 이름 변경(대소문자를 구분하지 않는 디스크).
- 추가 폴더 이력을 얼마나 보관할지.

각 이슈의 완료 기준은 로컬 `npm test` 실패 0, 수동 CI(`gh workflow run ci.yml --ref <branch>`) 성공이다.
화면이 바뀌는 이슈는 테스트 서버를 브라우저로 열어 실제 동작을 확인한다.

## 2026-09-28 이슈 묶음 (#22~#30)

작업 브랜치는 `dev`에서 따고 PR도 `dev`로 보낸다. 묶음마다 PR 하나.

| 순서 | 이슈 | 내용 |
|---|---|---|
| 1 | [#26](https://github.com/lidge-ai/lidge-hwp/issues/26) [#27](https://github.com/lidge-ai/lidge-hwp/issues/27) [#28](https://github.com/lidge-ai/lidge-hwp/issues/28) [#29](https://github.com/lidge-ai/lidge-hwp/issues/29) [#30](https://github.com/lidge-ai/lidge-hwp/issues/30) | MCP helper: 간격 단위(pt 선택), help의 `hwp.` 접두사, 여러 줄 입력과 invalid text 위치, `replaceText` n번째·범위와 일치 위치 보고, `setCell` 글자 모양 선택 |
| 2 | [#24](https://github.com/lidge-ai/lidge-hwp/issues/24) [#25](https://github.com/lidge-ai/lidge-hwp/issues/25) | 탭 연동: 읽기·실패 호출은 사용자 탭을 끌고 가지 않고(`{follow:false}`, 원복), 새로고침 직후 해시 불일치는 재시도 가능한 코드와 해시를 담아 보고 |
| 3 | [#22](https://github.com/lidge-ai/lidge-hwp/issues/22) [#23](https://github.com/lidge-ai/lidge-hwp/issues/23) | 엔진: 글자 크기 변경이 쪽 나눔을 만들지 않게, 편집 뒤 쪽 수를 스냅숏과 같은 기준으로. WASM·CLI 재빌드 |

서식·쪽 배치가 바뀌는 수정은 저장한 복사본을 한컴 한글에서 열어 쪽 수와 모양을 대조한다.

## 2026-09-29 종이(Jongi): 여러 형식을 여는 문서 작업대

HWP/HWPX는 지금의 rhwp 경로를 그대로 쓴다. 다른 형식은 형식 레지스트리(`lib/formats.mjs`) 뒤에 엔진을 따로 붙인다. 작업 브랜치 `codex/office-platform`, PR은 `dev`로.

| 단계 | 내용 | 엔진 |
|---|---|---|
| 1 | 형식 레지스트리, 문서함·API가 모든 형식을 나열·저장, LibreOffice headless 변환 계층, 오피스 번들 빌드 | LibreOffice(soffice, 번들하지 않음) |
| 2 | 시트 편집: xlsx·xls·ods·csv·Apple Numbers, Google Sheets 공유 링크 가져오기 | SheetJS CE, FortuneSheet, ExcelJS(xlsx 서식 보존) |
| 3 | 문서 편집: docx, odt·rtf·doc은 docx로 바꿔 편집한 뒤 원래 형식으로 저장, 옛 Pages 가져오기 | docx-editor(Apache-2.0 부분만) |
| 4 | 슬라이드: pptx·odp·ppt·key 미리보기와 사본 변환 | LibreOffice PDF + pdf.js |
| 5 | 이름을 "종이(Jongi)"로, 셸 UI 새로 그리기 | - |
| 6 | MCP `office_exec`: 시트 읽기·셀 쓰기, 문서 문단 읽기·바꾸기, 저장 전 재검증 | 위 엔진 |

범위 밖: Google 쪽 되쓰기(OAuth 필요), pptx 본문 편집, 최신 Pages/Keynote 편집(LibreOffice가 열지 못함), Docker 문서 서버.
LibreOffice가 필요한 테스트는 `npm run test:soffice`로 따로 돈다. 건너뛰지 않고, soffice가 없으면 실패한다.

### 상태와 남은 일 (2026-09-29)

1~6단계는 PR [#41](https://github.com/lidge-ai/lidge-hwp/pull/41)에 들어 있다(`dev` 대상, 병합 전). 로컬 `npm test` 0 실패, `npm run test:soffice` 9/9, 브라우저 시나리오 전부 통과. 수동 CI는 아직 돌리지 않았다.

알고 있는 한계:

- SheetJS CE로 쓴 .numbers를 다시 읽으면 큰 수에 부동소수 오차가 붙는 경우가 있다(예: 30004500 → 30004500.000000004). 값 대부분은 그대로다.
- xls·numbers·csv는 수식을 저장하지 못한다(편집기는 저장 전 경고, office_exec는 `FORMULA_NOT_SAVED`로 거절).
- 시트 화면에서 값을 바꿔도 다른 셀의 수식 결과가 곧바로 다시 계산되지 않는다. 저장한 xlsx는 열 때 다시 계산하도록 표시한다.
- 최신 Pages·Keynote(iWork 2013 이후)는 LibreOffice가 열지 못한다.
- docx 편집기는 글꼴 측정 없이 쪽 나눔을 추정한다(저장 바이트에는 영향 없음).
- `office_exec`는 두 번째 MCP 서버(`mcp/office-server.mjs`)다. Aside 자동 등록은 아직 `hwp_exec`만 한다.
- 다크 모드와 아이콘 세트 교체는 뒤로 미뤘다.
