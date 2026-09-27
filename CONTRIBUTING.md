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
MCP 재열기와 탭 연동은 `node --test test/live-tab.test.mjs`로 확인한다. 빌드된 WASM으로 빈 문서를
테스트 안에서 만들므로 개인 문서 fixture가 필요 없다.
Studio embed 또는 agent-ops 변경 시 npm run build:studio, npm --prefix rhwp/rhwp-studio test, npm test를 각각 실행하고 실제 실행 수·skip·실패를 보고한다. apply 상태 불명과 recovered:true의 경계는 test/live-tab.test.mjs와 Studio 단위 테스트로 확인한다.

CI는 push·PR에서 자동으로 돌지 않는 수동 실행 전용이다. 병합 전 검증이 필요하면
`gh workflow run ci.yml --ref <branch>`로 실행하고 결과 링크를 PR에 붙인다.
CI는 요청형 검증일 뿐 병합을 막는 게이트가 아니므로, 실제로 돌린 검증을 PR에 적는 책임은 작성자에게 있다.
테스트는 `node --test --test-shard=N/3 test/*.test.mjs`로 CI와 같은 샤드를 로컬에서 재현할 수 있다.

PR에는 변경 이유와 실제 실행한 검증을 적는다. 기본 브랜치는 `main`이다.
