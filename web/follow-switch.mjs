// AI 전환(agent.follow 수락)의 뒷정리를 한곳에 모은다(wp5). 셸(app.mjs)과 Node 테스트가 같은 파일을 쓴다.
const REASON = { DIRTY: '저장하지 않은 편집 있음', SAVING: '저장 중', ALREADY_OPEN: '이미 열린 문서',
  AGENT_BUSY: 'AI 작업 중', LEASE_ISOLATED: '이 탭이 격리됨', NOT_SWITCHED: '전환되지 않음' };

// switchTo가 true를 돌려줄 때만 성공이다. 그 밖(false·예외)은 모두 실패로 보고,
// (1) 예약을 돌려주고 (2) 이전 문서가 남아 있으면 입력 차단을 전환 전 값으로 되돌리고 (3) 예외면 상태줄에 알린다.
// 이전 문서가 없으면(반납 뒤 실패) switchTo가 이미 "문서 없음" 화면과 inert=true를 정했으므로 건드리지 않는다.
export async function followSwitch({ id, reservation, element, switchTo, hasCurrent, giveBack, say }) {
  const before = element.inert;
  element.inert = true; // 판정부터 새 문서 loadFile까지 사람 입력을 막는다(옛 문서에 친 글자가 조용히 사라지지 않게)
  let switched = false;
  let announced = false;
  try {
    switched = (await switchTo(id, { reservation, agent: true })) === true;
  } catch (error) {
    const code = error?.message ?? String(error);
    say(`AI 문서 전환 취소(${REASON[code] ?? code}) · ${id}는 탭 없이 편집됩니다`);
    announced = true;
  } finally {
    if (!switched) {
      // 예외 없이 false로 끝난 경우(응답 뒤 저장 시작·다른 전환이 먼저 X를 연 경우 등)도 이유를 알린다.
      if (!announced) say(`AI 문서 전환 취소(${REASON.NOT_SWITCHED ?? '전환되지 않음'}) · ${id}는 탭 없이 편집됩니다`);
      try { await giveBack(reservation); } catch { /* 예약은 runner의 finally와 ttl로도 풀린다 */ }
      if (hasCurrent()) element.inert = before;
    }
  }
  return switched;
}
