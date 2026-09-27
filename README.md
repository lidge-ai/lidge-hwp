# LIDGE HWP

브라우저에서 HWP·HWPX를 편집하고, AI 에이전트가 같은 문서를 고칠 수 있는 로컬 작업대.
[rhwp](https://github.com/edwardkim/rhwp) 포크의 Studio·WASM·CLI와 문서 저장 서버를 한 저장소에 담았다.
앱 코드는 MIT로 공개하며, 문서함은 저장소 밖에 따로 둔다.

## 할 수 있는 일

- 프로젝트별 문서 목록, 파일 가져오기, 접고 너비를 조절하는 사이드바
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

```sh
git clone https://github.com/lidge-ai/lidge-hwp.git
cd lidge-hwp
npm ci
rustup target add wasm32-unknown-unknown
npm run build:studio

mkdir -p "$HOME/.lidge-hwp/docs"
git -C "$HOME/.lidge-hwp/docs" init
npm start
```

[localhost:10500](http://localhost:10500/)에서 프로젝트를 만들고 HWP/HWPX 파일을 가져온다.
문서함은 독립된 Git 저장소여야 한다. 저장하면 상태줄에 커밋 ID가 표시된다.
서버 재시작 전에는 편집을 저장하고, 재시작 후에는 문서를 다시 연다.

| 설정 | 기본값 / 용도 |
| --- | --- |
| `LIDGE_HWP_DOCS` | 사용자 홈의 `.lidge-hwp/docs`, 독립된 문서함 Git 루트 |
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

열린 문서에는 편집기에서도 같은 변경을 재생한다. 다른 문서로 전환할 때 미저장 편집이
있으면 자동 전환을 거절한다. 저장 바이트가 기대한 내용과 다르면
`AGENT_VERIFY_MISMATCH`로 거절한다. `kordoc` 보조 저장은 표 칸 쓰기만 지원한다.

### 쪽 스냅샷과 PDF

편집 결과를 눈으로 확인할 때 브라우저 화면을 찍을 필요가 없다. 번들 rhwp CLI가 문서를 바로 PDF로 그린다.

```js
const h = await hwp.open('demo/example.hwpx');
const s = await hwp.snapshot(h);          // 모든 쪽: 쪽마다 PDF + PNG
const p = await hwp.exportPdf(h);         // 문서 전체 PDF 한 파일
return { dir: s.dir, pages: s.pages.length, pdf: p.path };
```

`snapshot(h, { pages, png, pdf, maxPx })`에서 `pages`는 0부터 센 쪽 번호 배열이다(생략하면 전체, 한 번에 200쪽까지).
PNG는 macOS `sips`로 만들고 긴 변 `maxPx`(기본 1600)에 맞춘다. 결과는
`~/.lidge-hwp/exports/<문서 ID>/<시각>-<해시>/`에 `page-001.pdf`, `page-001.png`, `document.pdf`로 남고,
응답에는 경로만 담긴다. 같은 호출에서 저장 전에 고친 내용도 그대로 그린다(`origin: 'edited'`).
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
