# 종이 (Jongi)

로컬에서 여러 문서 형식을 여는 문서 작업대. HWP·HWPX부터 시트·문서·슬라이드 형식까지 편집하고, AI 에이전트가 같은 문서를 고칠 수 있다.
제품 표시 이름만 종이(Jongi)로 바뀌었다. 저장소 이름(`lidge-hwp`), 환경 변수 `LIDGE_HWP_*`, 상태 경로 `~/.lidge-hwp`는 이름과 무관하게 그대로 쓴다.
[rhwp](https://github.com/edwardkim/rhwp) 포크의 Studio·WASM·CLI와 문서 저장 서버를 한 저장소에 담았다.
앱 코드는 MIT로 공개하며, 문서함은 저장소 밖에 따로 둔다.

## 열고 고칠 수 있는 형식

| 형식 | 편집 | 방식 |
| --- | --- | --- |
| HWP, HWPX | 편집 | rhwp Studio 편집기 |
| XLSX | 편집 | 시트 편집기(FortuneSheet). 저장은 ExcelJS가 바뀐 셀만 원본 위에 덧쓴다 |
| XLS, ODS, CSV, Numbers | 편집 | 시트 편집기. 열기·저장은 SheetJS가 맡는다 |
| DOCX | 편집 | docx-editor. 손대지 않은 OOXML은 저장 때 보존한다 |
| ODT, RTF, DOC | 편집 | LibreOffice로 DOCX로 바꿔 편집하고, 저장 때 원래 형식으로 되돌린다 |
| Pages | 읽기 전용 | LibreOffice로 DOCX 사본을 만든다 |
| PPTX, PPT, ODP, KEY | 미리보기 | LibreOffice가 만든 PDF를 pdf.js로 본다. PPTX 사본을 만들 수 있다 |
| Google Sheets, Docs, Slides | 가져오기 | 공유 링크에서 XLSX·DOCX·PPTX로 가져온다. 가져온 문서는 로컬에서 편집하고 Google 문서로 다시 쓰지 않는다 |

## 할 수 있는 일

- 프로젝트별 문서 목록과 파일 가져오기, Finder로 외부 폴더 추가·등록 해제, 접고 너비를 조절하는 사이드바
- 사이드바 문서 이름 바꾸기(F2), 원래 확장자·폴더를 유지하며 Git에 변경 기록
- 문서명·저장을 한 줄에 배치한 편집기
- 표 칸·본문 수정, 글자·문단 서식, 표·문단 구조 편집
- 저장할 때 내용 손실 검사와 문서별 Git 커밋
- `hwp_exec` MCP: 열린 편집기에 AI 변경을 반영하고 저장 결과 검증

개발 중인 로컬 도구다. 현재 **macOS Apple Silicon**에서 실행·저장을 검증했다.
서버는 Unix 소켓을 사용하고 문서 가져오기는 macOS에서만 지원한다.
암호화 문서와 일부 요소는 지원하지 않는다. 한컴과 줄바꿈·조판이 다를 수 있으므로
중요한 문서는 원본을 보관하고 최종 제출 프로그램에서 확인해야 한다.

## 시작하기

필수 도구: Node.js 26 이상, npm, Git, Rust/Cargo, `wasm-pack`, Rust의
`wasm32-unknown-unknown` 타깃. 빌드 중 의존성을 내려받으려면 인터넷 연결이 필요하다.
`npm run build:office`는 시트·문서·슬라이드 편집기 번들을 만들고, Rust 없이도 된다.

LibreOffice는 선택 사항이다. 없어도 HWP·HWPX·XLSX·DOCX 편집은 된다. ODT·RTF·DOC·Pages 열기, 슬라이드 미리보기, 형식 사본 만들기처럼 변환이 필요한 기능에 쓴다. 찾는 순서는 `LIDGE_HWP_SOFFICE` 환경 변수 → `/Applications/LibreOffice.app` → Codex 런타임에 딸린 LibreOfficeDev → `PATH`다. 앱에 LibreOffice를 번들하지 않으므로 별도 설치가 필요하다.

```sh
git clone https://github.com/lidge-ai/lidge-hwp.git
cd lidge-hwp
npm ci
rustup target add wasm32-unknown-unknown
npm run build:studio
npm run build:office

mkdir -p "$HOME/.lidge-hwp/docs"
git -C "$HOME/.lidge-hwp/docs" init
npm start
```

[127.0.0.1:10500](http://127.0.0.1:10500/)에서 프로젝트를 만들고 HWP/HWPX 파일을 가져온다.
문서함은 독립된 Git 저장소여야 한다. 저장하면 상태줄에 커밋 ID가 표시된다.
새 문서 버튼이나 ⌥⌘N으로 빈 HWP를 만듭니다. 선택한 그룹, 열린 문서의 그룹, 기본 문서함 순서로 위치를 정합니다. 이름을 생략하면 새 문서.hwp, 새 문서 2.hwp 순서로 중복 없이 저장하고 즉시 이력에 커밋합니다. ⌘N은 Chrome에서 새 창을 여는 예약 키이므로 버튼이나 ⌥⌘N을 쓰세요.
새 문서 버튼 옆 ▾ 메뉴에서 스프레드시트(XLSX)·워드 문서(DOCX)를 같은 방식으로 만들고, "Google에서 가져오기"로 공유 링크의 시트·문서·슬라이드를 가져온다.
편집기 안에 포커스가 있어도 F2·⌘⇧R(이름 바꾸기), ⌘⇧C(경로 복사), ⌥⌘N(새 문서)을 문서함으로 보냅니다. ⌘N도 페이지에 전달되는 환경에서는 새 문서로 처리합니다.
서버 재시작 전에는 편집을 저장하고, 재시작 후에는 문서를 다시 연다.

문서 행의 ‘이름’ 버튼이나 우클릭, 사이드바 포커스에서 F2로 이름을 바꿀 수 있다. 포커스된 문서가 없으면 현재 문서를 선택한다. ⌘⇧R도 이름 바꾸기 단축키이며 검색창에 포커스가 있어도 앱이 먼저 받는다. 미저장 편집은 확인을 받은 뒤 버리고 새 이름으로 다시 열며, 기존 이름이나 다른 형식의 파일을 덮어쓰지 않는다.

문서 행에 포커스를 두고 ⌘⇧C를 누르면 해당 문서의 검증된 절대 경로를 복사합니다. 행 포커스가 없으면 열린 문서의 경로를 복사합니다. 검색창에 포커스가 있어도 앱이 먼저 받습니다. 헤더의 ‘경로 복사’ 버튼으로도 열린 문서의 경로를 복사할 수 있습니다. 클립보드 권한이 거부되면 상태줄에 실패가 표시됩니다.

사이드바의 ‘추가한 폴더’에서 Finder로 HWP/HWPX 폴더를 등록할 수 있다. 등록 해제는 목록에서만 제거하며 원본 파일과 이력은 남긴다. 선택한 폴더의 Git 이력은 ~/.lidge-hwp/history/<루트 UUID>에 따로 보관하고, 폴더 안에 .git를 만들지 않는다. 폴더가 사라지면 ‘찾을 수 없음’으로 표시하며 등록은 유지한다.

기존 문서함 외에 등록한 폴더의 HWP·HWPX도 열 수 있다. 외부 문서 ID는 `ext://<UUID>/<상대경로>`이고, 등록 목록은 `~/.lidge-hwp/roots.json`에 저장된다. 외부 문서의 Git 이력은 원본 폴더가 아닌 `~/.lidge-hwp/history/<UUID>/`에 남는다. 폴더가 이동하거나 사라지면 등록은 유지되고 API에서 `available:false`로 표시된다. 이력 보존 기간은 사용자가 결정해야 한다.

| 설정 | 기본값 / 용도 |
| --- | --- |
| `LIDGE_HWP_DOCS` | 사용자 홈의 `.lidge-hwp/docs`, 독립된 문서함 Git 루트 |
| `LIDGE_HWP_STATE_DIR` | 사용자 홈의 `.lidge-hwp`; 외부 루트 등록(`roots.json`)과 섀도 이력(`history/`) 위치. 테스트에서는 별도 임시 디렉터리로 지정한다. 상태 폴더를 두 서버 프로세스가 동시에 쓰는 구성은 지원하지 않는다. |
| `LIDGE_HWP_PORT` | `10500` |
| `LIDGE_HWP_RHWP` | 이 저장소의 `rhwp/` |
| `LIDGE_HWP_CARGO_TARGET` | 빌드에서 사용할 Cargo target 경로 |
| `LIDGE_HWP_NODE_BIN` | Node가 든 디렉터리, 생략하면 PATH 사용 |
| `LIDGE_HWP_EXPORTS` | 사용자 홈의 `.lidge-hwp/exports`, `hwp.snapshot`·`hwp.exportPdf` 결과 위치(문서함 밖이어야 함) |
| `LIDGE_HWP_RHWP_BIN` | 이 저장소의 `bin/rhwp`, PDF 렌더에 쓸 rhwp CLI |

서버를 인터넷에 노출하거나 다른 사용자와 공유하는 서비스로 운영하지 않는다.
저장한 문서가 Git 기록에 남으므로 문서함을 공개 저장소로 push하지 않는다.

## MCP로 편집하기

먼저 웹 서버를 실행한다. MCP 클라이언트 설정에 아래 항목을 추가하고 실제 설치 경로로 바꾼다.
서버와 MCP는 같은 OS 사용자 계정으로 실행해야 한다.

```json
{
  "mcpServers": {
    "lidge-hwp": {
      "command": "node",
      "args": ["/absolute/path/to/lidge-hwp/mcp/server.mjs"]
    }
  }
}
```

도구는 `hwp_exec` 하나다. 비동기 JavaScript 코드에서 `hwp` API를 사용한다.

```js
return await hwp.docs();
```

```js
const h = await hwp.open('demo/example.hwpx');
await hwp.format(h, await hwp.selectAll(), { italic: true });
await hwp.paraFormat(h, { paragraph: 0 }, { alignment: 'center' });
await hwp.save(h);
return { edited: true };
```

`hwp.docs()`는 기본 문서와 등록한 외부 폴더의 문서를 함께 반환한다. 외부 문서는 `hwp.open('ext://<UUID>/example.hwpx')`처럼 열며, 같은 호출의 저장 결과에도 이 ID가 유지된다.

`await hwp.help()`에서 전체 API와 허용된 저수준 `hwp.api()` 메서드를 확인한다.
`setCell`, `insertText`, `replaceAll`, `splitParagraph`, `createTable`, `insertRow`,
`mergeCells`, `getFormat`, `styles` 등을 제공한다. 좌표는 0부터 시작하며 구조를 바꾸면
다시 읽어야 한다. 한 번의 저장은 편집 호출 4,096개·8MB까지다.

한 호출에서는 문서 하나만 연다. 같은 문서 ID로 `hwp.open(id)`를 다시 부르면 기존 핸들을 돌려주므로
저장한 뒤 이어서 `hwp.snapshot`을 찍을 수 있다. 다른 문서를 열거나 첫 열기가 실패한 뒤 다시 여는 것은
거절한다. `hwp.save(h)` 뒤에는 다시 열어도 변경 호출이 거절된다.

전체 선택은 본문, 최상위 표 칸, 한 겹 중첩 표 칸의 글자 서식을 다룬다.
머리말·꼬리말·각주와 두 겹 이상 중첩 표는 제외된다. 중첩 칸의 문단 서식·스타일은
지원하지 않아 `skipped`로 보고한다.

### 칸 안의 표와 체크박스

신청서는 동의서·팀원 표를 큰 칸 하나 안에 통째로 넣는 경우가 많다. `hwp.cells(h,{table})`에 제목만 보이면
`hwp.nestedTables(h)`로 칸 안 표(한 겹)를 찾고 `{nested,row,col}`로 칸을 가리킨다.

```js
const h = await hwp.open('ku/참가신청서.hwp');
const t = await hwp.nestedTables(h);                 // [{nested:0, rows:7, cols:4, parent:{table:7,row:0,col:0}}]
await hwp.setCell(h, { nested: 0, row: 4, col: 1, text: '홍길동' });
await hwp.setCheckbox(h, { label: '동의함', scope: { nested: 0, row: 4 }, exclusive: true });
await hwp.snapshot(h, { pages: [7], inline: true }); // 저장 전 모습을 결과 이미지로 확인
await hwp.save(h);
```

`hwp.checkboxes(h)`는 □(빈 칸)와 ■ ☑ ▣ ☒(체크)를 뒤 글자(label)와 위치와 함께 돌려준다. ■는 같은 문단에
다른 체크박스가 있을 때만 체크박스로 보고 나머지는 글머리표로 둔다. `hwp.setCheckbox`는 label과 범위로 칸 하나를
고르며, 체크 표시는 그 문단에서 쓰던 표시를 따른다(`mark`로 지정 가능). `exclusive:true`는 같은 문단의 다른
체크를 □로 되돌린다. `hwp.insertTextInCell`, `hwp.replaceText`의 `scope:{nested,...}`, `hwp.format`의 범위도
중첩 칸을 받는다. 두 겹 이상 중첩된 표는 다루지 않는다.

열린 문서에는 편집기에서도 같은 변경을 재생한다. 다른 문서로 전환할 때 미저장 편집이
있으면 자동 전환을 거절한다. 저장 바이트가 기대한 내용과 다르면
`AGENT_VERIFY_MISMATCH`로 거절한다. `kordoc` 보조 저장은 표 칸 쓰기만 지원한다.

열린 탭에 AI 변경을 적용할 때 applyOps가 적용 여부를 확정하지 못하면 MCP 응답에 APPLY_STATE_UNKNOWN과 원래 오류 코드·메시지를 담고 탭을 격리한다. 격리된 탭은 저장·후속 에이전트 호출을 거절하며 새로고침으로 새 임대를 받아야 한다. 편집 전으로 확인된 거절은 recovered:true로 보고하고 격리하지 않는다.

### 쪽 스냅샷과 PDF

편집 결과를 눈으로 확인할 때 브라우저 화면을 찍을 필요가 없다. 번들 rhwp CLI가 문서를 바로 PDF로 그린다.

```js
const h = await hwp.open('demo/example.hwpx');
const s = await hwp.snapshot(h);          // 모든 쪽: 쪽마다 PDF + PNG
const p = await hwp.exportPdf(h);         // 문서 전체 PDF 한 파일
return { dir: s.dir, pages: s.pages.length, pdf: p.path };
```

`snapshot(h, { pages, png, pdf, maxPx })`에서 `pages`는 0부터 센 쪽 번호 배열이다(생략하면 전체, 한 번에 200쪽까지).
PNG는 macOS `sips`로 만들고 긴 변 `maxPx`(기본 1600)에 맞춘다. 결과는 기본 문서의 경우 `~/.lidge-hwp/exports/<문서 ID>/<시각>-<해시>/`, 외부 문서의 경우 `~/.lidge-hwp/exports/external/<UUID>/<상대경로>/<시각>-<해시>/`에 남는다. 출력 위치는 등록된 어느 문서 루트 안에도 둘 수 없다. 응답에는 경로만 담긴다. 같은 호출에서 저장 전에 고친 내용도 그대로 그린다(`origin: 'edited'`).
`pages`와 함께 `inline: true`를 주면 PNG를 MCP 결과에 이미지로 붙여 에이전트가 파일을 따로 열지 않고 쪽을 본다(한 호출 4쪽까지,
`maxPx` 기본 1400). `hwp.exportPdf(h, { open: true })`는 만든 PDF를 macOS 미리보기로 연다.
쪽마다 0.3초 정도 걸리므로 긴 문서는 `timeoutMs`를 늘린다. 쪽 나눔은 CLI 조판을 따르므로 편집기와 조금 다를 수 있다.

### Aside

Aside CLI를 설치하고 로그인한 뒤 원하는 계정을 명시한다. 먼저 dry-run으로 확인한다.

```sh
ASIDE_ACCOUNT=u1 node aside/register.mjs --dry-run
ASIDE_ACCOUNT=u1 node aside/register.mjs
ASIDE_ACCOUNT=u1 node aside/register.mjs --check
```

계정 번호는 예시다. `aside account list`로 자신의 계정을 확인한다.
`ASIDE_ACCOUNT`를 생략하면 Aside의 현재 기본 계정을 사용한다.
CLI 경로는 `ASIDE_BIN`, 호스트는 `ASIDE_HOST`로 지정한다(기본 `local`).
등록 직후 `refreshRequired:true` 또는 exit 2라면 Aside 설정에서 해당 MCP의 **Refresh tools**를
누른다. 확인 결과가 `discovered:true`·`stale:false`가 되면 새 에이전트 세션을 연다.
`CLIENT_DEADLINE`·`stillRunning:true`가 반환되면 재실행하지 말고 저장 결과부터 확인한다.

## CLI와 포크

`bin/rhwp`는 플랫폼별 실행 파일을 선택한다. 현재 macOS arm64 바이너리를 포함하며,
소스와 SHA-256은 `bin/darwin-arm64/BUILD.json`에 기록한다.

```sh
bin/rhwp --version
node scripts/hwp-map.mjs /path/to/example.hwp --empty
sh scripts/build-rhwp-cli.sh
```

포크 소스는 `rhwp/`, 출처는 `rhwp/.lidge-vendor.json`에 있다.
`scripts/rhwp-vendor.sh /path/to/rhwp-fork lidge/studio-host-devel`로 스냅샷을 갱신한다.
Rust를 바꿨다면 WASM·Studio와 CLI를 함께 빌드해야 한다.
스냅샷 갱신 시에는 빈 문서 메타데이터 익명화와 수정 글꼴 이름 변경도 다시 적용한다.
이 유지보수 작업에는 Python의 `fonttools==4.62.1`, `brotli==1.2.0`이 추가로 필요하며
`LIDGE_HWP_FONT_PYTHON`으로 해당 Python 실행 파일을 지정할 수 있다. 일반 실행에는 필요 없다.
`LIDGE_HWP_SKIP_WASM=1`은 Rust 변경이 없고 검증된 `rhwp/pkg/`를 재사용할 때만 쓴다.
사용 중인 Cargo 작업이 없는지 확인한 뒤 완료된 빌드의 target을 정리할 수 있다.

## 개발과 라이선스

`npm test`는 앱 테스트를 실행한다. 실문서 통합 검증에는 외부 fixture 경로가 필요하다:
`npm run test:soffice`는 LibreOffice를 실제로 쓰는 통합 테스트(ODT·RTF 편집, 슬라이드 PDF 변환)다. LibreOffice가 없으면 실패하며 skip되지 않는다.
`LIDGE_HWP_KU_FIXTURE`(HWPX), `LIDGE_HWP_KU_HWP_FIXTURE`(HWP), `LIDGE_HWP_SIG_FIXTURE`(중첩 표 HWP).
설정하지 않은 통합 테스트는 skip된다. 개인 문서·기록은 공개본에 포함하지 않는다.
vendored 엔진의 전체 회귀 테스트에 필요한 일부 원본 문서도 제외되어 있으므로,
엔진 전체 테스트를 실행하려면 배포 권한이 있는 별도 fixture를 준비해야 한다.

GitHub Actions CI는 push와 PR에서 자동으로 돌지 않는다. 필요할 때 브랜치를 지정해 직접 실행한다.

```sh
run_url=$(gh workflow run ci.yml --ref <branch>)   # 방금 만든 실행의 URL을 출력한다
gh run watch "${run_url##*/}" --exit-status
```

CI는 WASM·Studio를 한 번 빌드해 `build/`를 넘기고, 테스트를 세 샤드로 나눠 macOS arm64에서 돌린다.
빌드가 필요 없는 메타데이터·셸 문법 검사는 따로 돈다. 마지막 `ci` 잡이 모든 잡의 성공을 확인한다.
로컬에서 같은 샤드를 재현하려면 `node --test --test-shard=1/3 test/*.test.mjs`처럼 실행한다(1/3, 2/3, 3/3).

- [기여 안내](CONTRIBUTING.md)
- [보안 안내](SECURITY.md)
- [MIT 라이선스](LICENSE)
- [제3자 고지](THIRD_PARTY_NOTICES.md)

rhwp와 포함된 폰트·의존성에는 각자의 라이선스가 적용된다. 한컴의 공식 제품이나 제휴 서비스가 아니다.
