// 오피스 탭의 SSE 채널. HWP 탭의 agent-channel.mjs와 달리 탭 안 에이전트 적용을 하지 않는다.
// 서버가 이 임대에 보낼 수 있는 요청 네 가지(agent.prepare·apply·release·follow)에는 모두 바로 답한다.
// 답하지 않으면 runner가 기다리다 임대를 격리한다(server/agent/runner.mjs releaseTab, server/tabs.mjs isolate).
export function startOfficeChannel({ events, docId, lease, showStatus, setSaveLocked, isBusy = () => false,
    canFollow = async () => 'BUSY', onFollow = () => {}, onFollowEnd = () => {}, onChanged = () => {} }) {
  let stopped = false;
  const reply = async (requestId, header) => {
    try {
      await fetch('/api/agent/replies/' + encodeURIComponent(requestId), { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lease': lease }, body: JSON.stringify(header) });
    } catch { /* 끊긴 뒤에는 서버가 요청을 이미 정리했다 */ }
  };
  const unsupported = event => {
    const msg = JSON.parse(event.data);
    if (msg.docId !== docId || msg.leaseId !== lease) return;
    void reply(msg.requestId, { schemaVersion: 1, requestId: msg.requestId, ok: false,
      error: { code: 'AGENT_UNSUPPORTED', message: '이 형식은 office_exec로 편집합니다' } });
  };
  events.addEventListener('agent.prepare', unsupported);
  events.addEventListener('agent.apply', unsupported);
  events.addEventListener('agent.release', event => {
    const msg = JSON.parse(event.data);
    if (msg.docId !== docId || msg.leaseId !== lease) return;
    void reply(msg.requestId, { schemaVersion: 1, requestId: msg.requestId, ok: true });
  });
  events.addEventListener('agent.follow', async event => {
    const msg = JSON.parse(event.data);
    if (msg.docId !== docId || msg.leaseId !== lease) return;
    let code;
    try { code = await canFollow(); } catch { code = 'BUSY'; }
    await reply(msg.requestId, code ? { schemaVersion: 1, requestId: msg.requestId, ok: false, error: { code, message: code } }
      : { schemaVersion: 1, requestId: msg.requestId, ok: true });
    if (!code && typeof msg.targetDocId === 'string') void onFollow(msg.targetDocId, msg.reservation);
    else if (code) showStatus('AI가 ' + msg.targetDocId + '를 편집하지만 전환하지 않았습니다 · 그 문서는 탭 없이 편집됩니다');
  });
  events.addEventListener('agent.followEnd', event => {
    const msg = JSON.parse(event.data);
    if (msg.docId === docId && msg.leaseId === lease) void onFollowEnd(msg);
  });
  events.addEventListener('office.changed', event => {
    const msg = JSON.parse(event.data);
    if (msg.docId === docId && msg.leaseId === lease) void onChanged(msg);
  });
  events.onerror = () => {
    events.close();
    if (stopped) return;
    setSaveLocked(true);
  };
  return async () => {
    if (isBusy()) throw Object.assign(new Error('AGENT_BUSY'), { code: 'AGENT_BUSY' });
    stopped = true;
  };
}

