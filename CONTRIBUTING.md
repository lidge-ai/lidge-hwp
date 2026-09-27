# Contributing

작은 변경부터 환영한다. 버그 제보에는 재현 순서, 운영체제, Node 버전과 오류 메시지를 적는다.
실제 개인정보가 든 문서 대신 직접 만든 최소 샘플을 사용한다.

앱 코드는 `web/`, `server/`, `lib/`, `mcp/`에 있다. `rhwp/`는 포크 스냅샷이고
출처는 `rhwp/.lidge-vendor.json`에 기록한다. 엔진 수정은 해당 포크에도 반영해야
다음 스냅샷 갱신 때 사라지지 않는다. 원저작권과 제3자 라이선스 고지를 유지한다.

```sh
npm ci
npm run build:studio
npm test
```

일부 통합 테스트는 외부 문서 경로 환경변수가 없으면 건너뛴다. 실행 수와 skip 수를
구분해 보고한다. 개인정보가 든 fixture를 저장소에 추가하면 안 된다.
검증에는 별도 임시 문서함을 사용하고 작업 중인 문서를 대상으로 실행하지 않는다.
경로 복사 API는 문서 ID를 다시 검증한 뒤 경로만 반환한다. 테스트에는 임시 문서함 경로만 쓰고 실제 사용자 경로를 fixture·로그에 남기지 않는다.
다중 루트 테스트는 `createServer({ docsRoot, stateDir, startAgentSocket: null })`로 임시 문서함과 상태 디렉터리를 주입한다. 실제 `~/.lidge-hwp/roots.json`이나 사용자 폴더를 fixture로 쓰지 않는다. 섀도 Git 테스트는 원본 폴더에 `.git`가 생기지 않는지, 대상 파일 하나만 커밋되는지, 실패 때 바이트와 index가 복구되는지 확인한다.
빈 HWP는 Node WASM의 createEmpty()와 createBlankDocument()를 연속 호출하고 HWP export 후 재열어 검증한다. 문서 생성 테스트는 임시 Git 문서함과 외부 섀도 이력을 사용하며 원본 사용자 문서를 대상으로 하지 않는다.
외부 폴더 API 테스트는 `createServer`의 `pickFolder` 주입과 임시 `stateDir`을 사용한다. 실제 Finder 창·취소·macOS 자동화 권한은 로그인한 사람의 화면에서 확인하며, 테스트가 사용자 홈의 등록 파일이나 문서를 변경하면 안 된다.
이름 변경 테스트는 두 파일명과 두 Git index 항목의 실패 전후 값을 비교한다. 커밋 실패 시 원래 이름·바이트·index·임대가 유지되는지, 복구 실패 시 양쪽 id가 격리되는지 확인한다. 대소문자/NFC 충돌은 실제 볼륨과 임시 fixture에서 각각 확인한다. 사이드바의 F2가 기본 단축키이며 ⌘⇧R은 브라우저 새로고침과 충돌할 수 있으므로 실제 macOS Chromium 키 입력은 사람이 확인한다.
MCP 재열기와 탭 연동은 `node --test test/live-tab.test.mjs`로 확인한다. 빌드된 WASM으로 빈 문서를
테스트 안에서 만들므로 개인 문서 fixture가 필요 없다.
Studio embed 또는 agent-ops 변경 시 npm run build:studio, npm --prefix rhwp/rhwp-studio test, npm test를 각각 실행하고 실제 실행 수·skip·실패를 보고한다. apply 상태 불명과 recovered:true의 경계는 test/live-tab.test.mjs와 Studio 단위 테스트로 확인한다.
Studio의 호스트 단축키를 바꾸면 chrome-mode, lidge-host-v1 transport, npm wrapper 타입, 셸 핸들러를 함께 검증하고 npm run build:studio를 실행한다. 단독 Studio와 ⌥C 서식 복사는 회귀 기준이다.

CI는 push·PR에서 자동으로 돌지 않는 수동 실행 전용이다. 병합 전 검증이 필요하면
`gh workflow run ci.yml --ref <branch>`로 실행하고 결과 링크를 PR에 붙인다.
CI는 요청형 검증일 뿐 병합을 막는 게이트가 아니므로, 실제로 돌린 검증을 PR에 적는 책임은 작성자에게 있다.
테스트는 `node --test --test-shard=N/3 test/*.test.mjs`로 CI와 같은 샤드를 로컬에서 재현할 수 있다.

PR에는 변경 이유와 실제 실행한 검증을 적는다. 기본 브랜치는 `main`이다.
