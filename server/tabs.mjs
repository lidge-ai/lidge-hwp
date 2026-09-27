import { randomUUID } from 'node:crypto';

// claim 뒤 SSE가 붙을 때까지의 한도. 셸은 loadFile(SDK 한도 60초)을 끝낸 뒤 SSE를 연다.
const CLAIM_TTL_MS = 90000;
const SAVE_STATE_TTL_MS = 10 * 60 * 1000;
const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

export function createTabs() {
  const byLease = new Map();
  const byDoc = new Map();
  const pending = new Map();    // requestId → {lease, docId, type, lockToken, used, resolve, reject, timer}
  const saves = new Map();      // requestId → {lease, done, finish}: 승인된 에이전트 PUT이 끝날 때까지
  const saveStates = new Map(); // requestId → {state, lease, ...}: lease 해제와 무관하게 10분 보관
  const reservations = new Map(); // docId → {token, claimLease, timer}: agent.follow 동안 그 문서의 claim을 한 셸에만 허용(wp5)
  const watchers = new Set();     // 탭 상태가 바뀔 때 부르는 함수(waitConnected)
  const bump = () => { for (const check of [...watchers]) check(); };

  // 대기 중 요청을 어떤 경로로 끝내든 requestId를 오류에 싣는다. runner가 그 값으로 release 토큰을 안다.
  function settle(requestId, job, code) {
    clearTimeout(job.timer);
    pending.delete(requestId);
    job.reject(coded(code, { requestId }));
  }

  function claim(docId, reservation = null) {
    const reserved = reservations.get(docId);
    // 에이전트 전환 예약 중에는 그 예약 토큰을 받은 셸이 한 번만 claim할 수 있다. 다른 창·다른 셸은 409다.
    if (reserved && (reserved.token !== reservation || reserved.claimLease)) throw coded('DOC_RESERVED', { status: 409 });
    if (!reserved && reservation) throw coded('RESERVATION_EXPIRED', { status: 409 });
    if (byDoc.has(docId)) return null;
    const lease = randomUUID();
    const tab = { docId, response: null, timer: null, claimTimer: null, isolated: false, connectedAt: 0 };
    tab.claimTimer = setTimeout(() => {
      if (byLease.get(lease) === tab && !tab.response) release(lease);
    }, CLAIM_TTL_MS);
    tab.claimTimer.unref?.();
    byLease.set(lease, tab);
    byDoc.set(docId, lease);
    if (reserved) reserved.claimLease = lease;
    bump();
    return lease;
  }
  function owns(lease, docId) { return byLease.get(lease)?.docId === docId; }
  function canRename(lease, docId, nextId = null) {
    const tab = byLease.get(lease);
    if (!tab || tab.docId !== docId || !tab.response || tab.response.writableEnded) return 'LEASE_REQUIRED';
    if (tab.isolated) return 'LEASE_ISOLATED';
    if ([...pending.values()].some(job => job.lease === lease)
        || [...saves.values()].some(save => save.lease === lease)) return 'AGENT_BUSY';
    if (reservations.has(docId)) return 'DOC_RESERVED';
    if (nextId && (reservations.has(nextId) || byDoc.has(nextId))) return 'DOC_RESERVED';
    return null;
  }
  // SSE가 붙은 탭만 주인이다.
  function owner(docId) {
    const lease = byDoc.get(docId);
    return lease && byLease.get(lease)?.response ? lease : null;
  }
  // 임대는 받았지만 SSE가 아직 없다(셸이 문서를 여는 중).
  function claimed(docId) {
    const lease = byDoc.get(docId);
    return Boolean(lease && !byLease.get(lease)?.response);
  }
  function release(lease) {
    const tab = byLease.get(lease);
    if (!tab) return false;
    if (tab.timer) clearInterval(tab.timer);
    if (tab.claimTimer) clearTimeout(tab.claimTimer);
    for (const [id, job] of pending) if (job.lease === lease) settle(id, job, 'TAB_DISCONNECTED');
    if (tab.response && !tab.response.writableEnded) tab.response.end();
    byLease.delete(lease);
    byDoc.delete(tab.docId);
    bump();
    return true;
  }
  function events(lease, response) {
    const tab = byLease.get(lease);
    if (!tab || tab.response) return false;
    clearTimeout(tab.claimTimer);
    tab.claimTimer = null;
    tab.response = response;
    tab.connectedAt = Date.now();
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store', Connection: 'keep-alive' });
    response.write(`event: hello\ndata: ${JSON.stringify({ lease, docId: tab.docId })}\n\n`);
    tab.timer = setInterval(() => response.write('event: heartbeat\ndata: {}\n\n'), 15000);
    response.on('close', () => release(lease));
    bump();
    return true;
  }
  function close() {
    for (const entry of reservations.values()) clearTimeout(entry.timer);
    reservations.clear();
    for (const lease of [...byLease.keys()]) release(lease);
  }

  // expected는 서버 전용이다(SSE로 보내지 않는다). agent.apply의 PUT 확인(api-docs)만 agentExpected로 읽는다.
  function requestAgent(lease, type, payload, timeoutMs, lockToken = null, expected = null) {
    return new Promise((resolve, reject) => {
      const tab = byLease.get(lease);
      if (!tab?.response || tab.response.writableEnded) return reject(coded('TAB_DISCONNECTED'));
      if (tab.isolated && type !== 'agent.release') return reject(coded('LEASE_ISOLATED'));
      const requestId = randomUUID();
      const job = { lease, docId: tab.docId, type, lockToken, expected, used: false, resolve, reject, timer: null };
      job.timer = setTimeout(() => settle(requestId, job, 'AGENT_REPLY_TIMEOUT'), timeoutMs);
      pending.set(requestId, job);
      try {
        tab.response.write(`event: ${type}\ndata: ${JSON.stringify({ schemaVersion: 1, type, requestId,
          docId: tab.docId, leaseId: lease, ...payload })}\n\n`);
      } catch { settle(requestId, job, 'TAB_DISCONNECTED'); }
    });
  }

  function acceptReply(requestId, lease, header, bytes) {
    const job = pending.get(requestId);
    if (!job || job.lease !== lease || header?.requestId !== requestId || header.schemaVersion !== 1) {
      throw coded('INVALID_AGENT_REPLY');
    }
    if ((bytes.length > 0 || header.bytesLength !== undefined) && header.bytesLength !== bytes.length) {
      throw coded('INVALID_REPLY_LENGTH');
    }
    const save = saveStates.get(requestId) ?? null;
    if (job.type === 'agent.apply' && header.ok && save?.state !== 'committed') {
      // 성공 응답은 서버가 기록한 커밋이 있을 때만 받는다. 셸의 주장만으로 성공 처리하지 않는다.
      settle(requestId, job, 'AGENT_SAVE_MISSING');
      throw coded('AGENT_SAVE_MISSING');
    }
    clearTimeout(job.timer);
    pending.delete(requestId);
    if (header.tab?.isolated === true) { const tab = byLease.get(lease); if (tab) tab.isolated = true; }
    if (header.ok) job.resolve({ ...header, bytes, requestId, save });
    else job.reject(Object.assign(new Error(header.error?.code || 'AGENT_FAILED'), header.error ?? {},
      { requestId, tab: header.tab ?? null }));
  }

  // 대기 중인 agent.apply 한 건에만 저장 토큰(store.lock 토큰 객체)을 한 번 내준다. 임의 헤더는 권한이 아니다.
  function agentLockFor(docId, lease, requestId) {
    const job = pending.get(requestId);
    if (!job || job.type !== 'agent.apply' || job.docId !== docId || job.lease !== lease
        || !job.lockToken || job.used) return null;
    job.used = true;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    saves.set(requestId, { lease, done, finish });
    saveStates.set(requestId, { state: 'pending', lease });
    return job.lockToken;
  }
  // api-docs.mjs:79-88이 커밋·실패 결과를 넘긴다.
  function finishAgentSave(requestId, outcome) {
    const prior = saveStates.get(requestId);
    if (prior) {
      saveStates.set(requestId, { ...outcome, lease: prior.lease });
      setTimeout(() => saveStates.delete(requestId), SAVE_STATE_TTL_MS).unref?.();
    }
    const save = saves.get(requestId);
    if (save) { saves.delete(requestId); save.finish(); }
  }
  function saveStatus(requestId, lease) {
    const entry = saveStates.get(requestId);
    if (!entry) return { status: 404, body: { error: { code: 'UNKNOWN_REQUEST', message: 'UNKNOWN_REQUEST' } } };
    if (entry.lease !== lease) return { status: 409, body: { error: { code: 'LEASE_MISMATCH', message: 'LEASE_MISMATCH' } } };
    const { lease: _lease, ...body } = entry;
    return { status: 200, body };
  }
  async function waitAgentSave(lease) {
    await Promise.all([...saves.values()].filter(save => save.lease === lease).map(save => save.done));
  }
  // 격리된 임대는 사람 PUT과 새 prepare를 거부한다. 새로고침(임대 해제)만이 복구다.
  function isIsolated(lease) { return byLease.get(lease)?.isolated === true; }
  // runner가 agent.release 응답을 deadline 안에 못 받았을 때 문서 잠금을 풀기 전에 부른다.
  function isolate(lease) { const tab = byLease.get(lease); if (tab) tab.isolated = true; }

  // ── wp5 따라가기 ──
  // runner가 X를 열 때 옮겨 올 셸: SSE가 붙어 있고 격리되지 않은 탭 중 가장 늦게 붙은 것. X를 보는 탭은 뺀다.
  function followTarget(docId) {
    let best = null;
    for (const [lease, tab] of byLease) {
      if (!tab.response || tab.response.writableEnded || tab.isolated || tab.docId === docId) continue;
      if (!best || tab.connectedAt > best.connectedAt) best = { lease, docId: tab.docId, connectedAt: tab.connectedAt };
    }
    return best && { lease: best.lease, docId: best.docId };
  }
  // X를 잠시 예약한다. ttl이 지나면 스스로 풀린다. X에 이미 임대나 예약이 있으면 null.
  function reserve(docId, ttlMs) {
    if (reservations.has(docId) || byDoc.has(docId)) return null;
    const entry = { token: randomUUID(), claimLease: null, timer: null };
    entry.timer = setTimeout(() => cancelReservation(entry.token), ttlMs);
    entry.timer.unref?.();
    reservations.set(docId, entry);
    return entry.token;
  }
  function cancelReservation(token) {
    for (const [docId, entry] of reservations) {
      if (entry.token !== token) continue;
      clearTimeout(entry.timer);
      reservations.delete(docId);
      bump();
      return true;
    }
    return false;
  }
  // docId 탭이 SSE로 붙을 때까지 기다린다. reservation이 있으면 그 예약으로 claim한 임대만 인정한다.
  // 실패 코드: 예약 없음 → TAB_CONNECTING(claim이 사라짐·시간 초과),
  //           예약 있음 → FOLLOW_CANCELLED(예약 반납·만료), FOLLOW_LOAD_FAILED(claim 뒤 임대 해제), FOLLOW_TIMEOUT.
  function waitConnected(docId, { reservation = null, ms }) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (code, lease) => {
        clearTimeout(timer);
        watchers.delete(check);
        if (code) reject(coded(code)); else resolve(lease);
      };
      function check() {
        const entry = reservation ? reservations.get(docId) : null;
        if (reservation && entry?.token !== reservation) return finish('FOLLOW_CANCELLED');
        const lease = reservation ? entry.claimLease : byDoc.get(docId);
        if (lease && byLease.get(lease)?.response) return finish(null, lease);
        if (reservation && lease && !byLease.has(lease)) return finish('FOLLOW_LOAD_FAILED');
        if (!reservation && !lease) return finish('TAB_CONNECTING');
      }
      timer = setTimeout(() => finish(reservation ? 'FOLLOW_TIMEOUT' : 'TAB_CONNECTING'), Math.max(0, ms));
      watchers.add(check);
      check();
    });
  }
  // 문서가 잠긴 동안에도 claim을 허용할지(index.mjs). 이 문서의 예약이 있고, 토큰이 맞고, 아직 쓰이지 않았을 때만 true.
  function reservedFor(docId, token) {
    const entry = reservations.get(docId);
    return Boolean(entry && typeof token === 'string' && entry.token === token && !entry.claimLease);
  }
  // 대기 중인 agent.apply에 runner가 넣은 서버 전용 기대값. 저장 토큰을 이미 받은(used) PUT만 읽는다.
  function agentExpected(requestId) {
    const job = pending.get(requestId);
    return job?.type === 'agent.apply' && job.used ? job.expected : null;
  }
  function hasRootActivity(key) {
    const prefix = `ext://${key}/`;
    return [...byDoc.keys(), ...reservations.keys()].some(id => id.startsWith(prefix));
  }

  return { claim, owns, owner, claimed, release, events, close, requestAgent, acceptReply,
    agentLockFor, finishAgentSave, saveStatus, waitAgentSave, isIsolated, isolate,
    followTarget, reserve, cancelReservation, waitConnected, reservedFor, agentExpected, hasRootActivity, canRename };
}
