export function startAgentChannel({ editor, events, docId, lease, getDiskSha, setDiskSha, putDocument, showStatus, setSaveLocked,
    canFollow = async () => 'BUSY', onFollow = () => {} }) {
  let active = null;        // 잠금을 쥔 prepare requestId(= 잠금 토큰)
  let applyState = null;    // agent.apply 진행 상태 {applied, saved, putStarted, token}
  let isolated = false;     // 되돌리기까지 실패하거나 적용 여부를 모르면 true. 잠금·저장 차단 유지, 새로고침만 복구
  let disconnected = false; // SSE가 끊긴 뒤에는 저장 확정 후 잠금만 풀고 Save는 계속 막는다(새 lease 필요)
  let reloadRequired = false; // 디스크는 커밋됐는데 탭이 옛 문서다(kordoc reload 실패). 새로고침만 복구
  let applyDone = Promise.resolve(); // 진행 중인 agent.apply 처리기. release는 이것이 끝난 뒤에만 처리한다
  let releaseDone = Promise.resolve(); // 다음 prepare는 release 처리 뒤에만 시작한다
  let releasing = false;
  const fileName = docId.split('/').at(-1);
  const FOLLOW_WHY = { DIRTY: '저장하지 않은 편집이 있어', SAVING: '저장 중이라', BUSY: '다른 작업 중이라', ISOLATED: '이 탭이 격리돼 있어' };
  const unlock = token => editor.lidge.request('lockInput', { on: false, reason: '', token });
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    x => x.toString(16).padStart(2, '0')).join('');
  const reply = async (requestId, header, bytes) => {
    try {
      const body = bytes ? new Blob([JSON.stringify(header), '\n', bytes]) : JSON.stringify(header);
      const response = await fetch(`/api/agent/replies/${encodeURIComponent(requestId)}`, {
        method: 'POST', body,
        headers: { 'Content-Type': bytes ? 'application/vnd.lidge.agent-reply' : 'application/json', 'X-Lease': lease },
      });
      if (!response.ok) throw new Error(`REPLY_HTTP_${response.status}`);
    } catch (error) {
      // 끊긴 뒤에는 서버가 이미 요청을 TAB_DISCONNECTED로 정리했다(409). 로컬 판단은 바꾸지 않는다.
      if (!disconnected) throw error;
    }
  };

  const onMessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.docId !== docId || msg.leaseId !== lease) return;
    try {
      if (msg.type === 'agent.prepare') {
        if (isolated) throw new Error('LEASE_ISOLATED');
        if (active) throw new Error('AGENT_ALREADY_ACTIVE');
        active = msg.requestId;
        await editor.lidge.request('lockInput', { on: true, reason: 'AI가 문서를 편집 중입니다', token: active });
        setSaveLocked(true);
        const state = await editor.getDocumentState();
        const exported = await editor.lidge.request('exportWithReport', { format: msg.format });
        const exportSha256 = await digest(exported.bytes);
        if (exported.contentLoss.count === 0 && exportSha256 !== state.documentSha256) throw new Error('SNAPSHOT_HASH_MISMATCH');
        await reply(msg.requestId, { schemaVersion: 1, requestId: msg.requestId, ok: true, state, diskSha256: getDiskSha(),
          exportSha256, contentLoss: exported.contentLoss, bytesLength: exported.bytes.length }, exported.bytes);
      } else if (msg.type === 'agent.apply') {
        if (active !== msg.token || msg.batch?.token !== msg.token) throw new Error('AGENT_LOCK_REQUIRED');
        applyState = { applied: null, saved: false, putStarted: false, token: msg.token };
        let applied;
        try {
          applied = await editor.lidge.request('applyOps', { batch: msg.batch });
        } catch (error) {
          // recovered:true만 "탭 문서 변화 없음"으로 확정된 실패다(agent-ops.ts의 사전 검사, SnapshotCommand·render 롤백 완료).
          if (error?.recovered === true) throw error;
          // 그 밖(시간 초과·응답 유실·복구 실패)은 상태를 추측하지 않고 격리한다.
          isolated = true;
          throw Object.assign(new Error('APPLY_STATE_UNKNOWN'), { code: 'APPLY_STATE_UNKNOWN', cause: error });
        }
        applyState.applied = applied;
        await editor.lidge.request('highlightCells', { cells: applied.changedCells, ms: 15000 });
        const exported = await editor.lidge.request('exportWithReport', { format: msg.format });
        const exportSha256 = await digest(exported.bytes);
        // 적용 뒤 다른 변경이 끼지 않았는지는 changeSeq로 본다. HWP는 강조 렌더 뒤 줄 배치(lineseg)가 다시 계산돼
        // 같은 탭에서도 export 바이트가 달라지므로 바이트 비교를 쓰지 않는다(wp5 C 실측). 내용 대조는 서버가 PUT에서 서명으로 한다.
        const stateNow = await editor.getDocumentState();
        if (stateNow.changeSeq !== applied.afterChangeSeq) throw new Error('POST_APPLY_CHANGED');
        void exportSha256; // 관측용
        if (exported.contentLoss.count !== 0) throw new Error('CONTENT_LOSS');
        // 연결이 끊겼으면 바이트를 보내지 않고 되돌리기로 간다(되돌리기의 주인은 이 처리기 하나).
        if (disconnected) throw new Error('DISCONNECTED_BEFORE_SAVE');
        applyState.putStarted = true;
        let saved;
        try {
          saved = await putDocument(docId, exported.bytes, { ifMatch: msg.batch.base.diskSha256, lease,
            format: msg.format, contentLoss: exported.contentLoss, agentRequestId: msg.requestId });
        } catch (error) {
          // 403 AGENT_AUTH_REQUIRED는 서버가 저장 토큰을 내주지 않은 경우다(api-docs.mjs:49). 디스크 쓰기는 시작되지 않았다.
          if (error?.message === 'AGENT_AUTH_REQUIRED') applyState.putStarted = false;
          throw error;
        }
        applyState.saved = true;
        setDiskSha(saved.sha256);
        await editor.notifySaved(fileName).catch(e => showStatus(`커밋 ${saved.commit} 완료, 편집기 상태 갱신 실패: ${e.message}`));
        if (disconnected) {
          // release SSE가 오지 않으므로 스스로 잠금을 푼다. Save 버튼은 새 lease 전까지 막힌 채 둔다.
          await unlock(applyState.token).catch(() => {});
          active = null;
        }
        await reply(msg.requestId, { schemaVersion: 1, requestId: msg.requestId, ok: true, changedCells: applied.changedCells,
          afterChangeSeq: applied.afterChangeSeq, exportSha256, diskSha256: saved.sha256, commit: saved.commit });
        showStatus(`AI 편집을 저장했습니다 · 커밋 ${saved.commit}`);
      }
    } catch (error) {
      const code = error?.code || error?.message || 'AGENT_FAILED';
      const cause = error?.cause;
      const causeCode = cause ? (typeof cause.code === 'string' ? cause.code : 'APPLY_OPS_ERROR') : null;
      const causeMessage = cause ? String(cause.message || cause) : null;
      const message = cause ? `${code}: ${causeCode}: ${causeMessage}` : String(error?.message || error);
      let rollback = null;
      if (msg.type === 'agent.apply' && applyState?.applied && !applyState.saved && applyState.putStarted) {
        // PUT을 보낸 뒤 실패: 서버가 이미 커밋했을 수 있다. 서버 저장 작업 상태로만 판단한다.
        const status = await saveStatus(msg.requestId).catch(() => ({ state: 'unknown' }));
        if (status.state === 'committed') {
          applyState.saved = true;
          setDiskSha(status.diskSha256);
          await editor.notifySaved(fileName).catch(() => {});
          if (disconnected && active) { await unlock(active).catch(() => {}); active = null; }
          // 편집은 디스크에 커밋됐다. 실패로 보고하지 않는다. 잠금 해제는 평소처럼 agent.release가 한다.
          await reply(msg.requestId, { schemaVersion: 1, requestId: msg.requestId, ok: true,
            commit: status.commit, diskSha256: status.diskSha256, recoveredFrom: code }).catch(() => {});
          return;
        } else if (status.state === 'failed' && status.diskSha256 === msg.batch.base.diskSha256) {
          rollback = await rollbackAppliedBatch(applyState.applied).catch(e => ({ ok: false, code: e?.code || e?.message || 'ROLLBACK_FAILED' }));
          if (!rollback.ok) isolated = true;
        } else {
          isolated = true;
          rollback = { ok: false, code: 'SAVE_STATE_UNKNOWN' };
        }
      } else if (msg.type === 'agent.apply' && applyState?.applied && !applyState.saved) {
        // 탭에는 적용됐지만 디스크 저장을 시작하지 않았다. 잠금을 쥔 채 스냅샷 1단계를 되돌린다.
        rollback = await rollbackAppliedBatch(applyState.applied).catch(e => ({ ok: false, code: e?.code || e?.message || 'ROLLBACK_FAILED' }));
        if (!rollback.ok) isolated = true;
      }
      if (isolated) showStatus(`AI 편집 결과를 확정할 수 없음 (${causeCode ?? code}: ${causeMessage ?? message}) · 이 탭은 잠긴 채 격리됨 · 새로고침으로 복구`);
      else showStatus(`AI 편집 실패: ${message}`);
      // 연결이 끊긴 뒤 apply가 확정 실패로 끝났다면 release가 오지 않으므로 스스로 푼다.
      if (msg.type === 'agent.apply' && disconnected && !isolated && active) {
        await unlock(active).catch(() => {});
        active = null;
      }
      await reply(msg.requestId, { schemaVersion: 1, requestId: msg.requestId, ok: false,
        error: { code, message, recovered: error?.recovered ?? null,
          ...(cause ? { causeCode, causeMessage } : {}) },
        tab: { applied: Boolean(applyState?.applied), committed: Boolean(applyState?.saved), rollback, isolated },
      }).catch(e => showStatus(`응답 전송 실패: ${e.message}`));
    }
  };

  // applyOps가 성공하고 저장 전에 실패했을 때만 쓴다. 토큰은 apply 시작 때 보관한 값(끊겨서 active가 비어도 유지).
  function rollbackAppliedBatch(applied) {
    return editor.lidge.request('rollbackOps', { token: applyState.token, commandId: applied.commandId,
      beforeDocumentSha256: applied.beforeDocumentSha256 });
  }
  // 서버 저장 작업 상태. committed/failed만 확정 값이다. pending이면 1초 간격으로 최대 150초.
  async function saveStatus(requestId) {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const response = await fetch(`/api/agent/saves/${encodeURIComponent(requestId)}`, { cache: 'no-store', headers: { 'X-Lease': lease } });
      if (!response.ok) throw new Error('SAVE_STATUS_FAILED');
      const status = await response.json();
      if (status.state !== 'pending') return status;
      await new Promise(r => setTimeout(r, 1000));
    }
    return { state: 'unknown' };
  }

  // 탭을 끝까지 잠그는 두 경우: 결과 불명(isolated), 디스크 커밋 뒤 탭 갱신 실패(reloadRequired).
  // 입력 잠금을 다시 걸고(같은 토큰이면 멱등, 안내 문구만 바뀜) iframe을 inert로 두고 Save를 막는다.
  async function holdTab(token, reason) {
    isolated = true;
    editor.element.inert = true;
    await editor.lidge.request('lockInput', { on: true, reason, token }).catch(() => {});
    setSaveLocked(true);
    showStatus(reason);
  }

  // agent.release. onMessage와 달리 실패해도 잠금을 풀지 않는다. 푸는 경로는 "서버가 release 응답을 받음" 하나뿐이다.
  async function handleRelease(msg) {
    if (msg.docId !== docId || msg.leaseId !== lease) return;
    if (isolated) {
      // 격리된 탭: 잠금과 Save 차단을 유지하고 서버에 상태만 알린다(서버가 임대를 isolated로 표시).
      await reply(msg.requestId, { schemaVersion: 1, requestId: msg.requestId, ok: true,
        tab: { isolated: true, reloadRequired } }).catch(() => {});
      return;
    }
    releasing = true;
    try {
      if (msg.reload) {
        try {
          const response = await fetch(`/api/docs/${encodeURIComponent(docId)}`, { cache: 'no-store' });
          if (!response.ok) throw new Error('RELOAD_FAILED');
          const bytes = await response.arrayBuffer();
          editor.element.inert = true;       // 잠금을 푼 뒤 loadFile이 끝날 때까지 사람 입력을 막는다
          if (active) await unlock(active);  // studio loadFile은 잠금 중 거절한다(main.ts loadFile 핸들러)
          await editor.loadFile(bytes, fileName, { skipUnsavedGuard: true });
          setDiskSha(msg.reload.diskSha256);
          active = null; // loadFile 전에 이미 잠금을 풀었다
        } catch (error) {
          // 디스크는 이미 커밋됐는데 탭은 옛 문서다. 풀어 두면 옛 문서를 편집·저장하게 되므로 격리한다.
          reloadRequired = true;
          await holdTab(msg.token, '디스크는 커밋됨 · 새로고침 필요');
          await reply(msg.requestId, { schemaVersion: 1, requestId: msg.requestId, ok: true,
            error: { code: 'RELOAD_FAILED', message: String(error?.message || error), recovered: null },
            tab: { isolated: true, reloadRequired: true } }).catch(() => {});
          return;
        }
      }
      if (!editor.element.inert) editor.element.inert = true;
      if (active) {
        try { await unlock(active); }
        catch (error) {
          await holdTab(active, `입력 잠금 해제 실패: ${error?.message || error} · 새로고침으로 복구`);
          await reply(msg.requestId, { schemaVersion: 1, requestId: msg.requestId, ok: true,
            tab: { isolated: true, reloadRequired } }).catch(() => {});
          return;
        }
      }
      const released = active;
      active = null;
      applyState = null;
      try {
        // 입력 잠금 해제 뒤 서버 응답을 확인한다. 그동안 Save와 사람 입력은 차단한다.
        const header = { schemaVersion: 1, requestId: msg.requestId, ok: true };
        const response = await fetch(`/api/agent/replies/${encodeURIComponent(msg.requestId)}`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Lease': lease }, body: JSON.stringify(header) });
        if (!response.ok) throw new Error(`REPLY_HTTP_${response.status}`);
      } catch {
        // 응답만 유실됐다면 서버는 격리하지 않았을 수도 있다.
        await holdTab(released ?? msg.token, msg.reload ? '디스크는 커밋됨 · 새로고침 필요'
          : 'unlock 또는 release 응답이 확인되지 않음 · 이 탭은 잠긴 채 격리됨 · 새로고침으로 복구');
        return;
      }
      setSaveLocked(false);
      editor.element.inert = false;
      if (msg.reload) showStatus(`kordoc 저장 완료 · 커밋 ${msg.reload.commit} · 되돌리기 기록 초기화`);
    } finally { releasing = false; }
  }

  // agent.follow(wp5): 에이전트가 다른 문서(targetDocId)를 편집하려 한다. 바쁘면 확인 창 없이 거절하고 알림만 남긴다.
  // 수락은 서버가 reply를 받아들인 뒤에만 전환한다. runner가 이미 포기했으면 reply가 409라 전환하지 않는다.
  async function handleFollow(msg) {
    if (msg.docId !== docId || msg.leaseId !== lease) return;
    if (typeof msg.targetDocId !== 'string' || typeof msg.reservation !== 'string') return;
    let code;
    try {
      code = isolated || reloadRequired ? 'ISOLATED' : active || applyState || releasing ? 'BUSY' : await canFollow();
    } catch { code = 'BUSY'; }
    if (disconnected) return; // 서버가 이 요청을 이미 TAB_DISCONNECTED로 정리했다
    const header = code ? { schemaVersion: 1, requestId: msg.requestId, ok: false, error: { code, message: code } }
      : { schemaVersion: 1, requestId: msg.requestId, ok: true };
    try { await reply(msg.requestId, header); }
    catch (error) { showStatus(`AI 문서 전환 응답 실패: ${error.message}`); return; }
    if (disconnected) return; // reply는 끊긴 뒤 오류를 삼킨다(20-23). 끊겼으면 전환하지 않는다
    if (code) {
      showStatus(`AI가 ${msg.targetDocId}를 편집하지만 ${FOLLOW_WHY[code] ?? code} 전환하지 않았습니다 · 그 문서는 탭 없이 편집됩니다`);
      return;
    }
    void onFollow(msg.targetDocId, msg.reservation);
  }

  // release는 진행 중인 apply가 확정(커밋·되돌림·격리·적용 안 됨)될 때까지 줄을 세운다.
  // apply 처리기는 모든 경로에서 reply 뒤 끝나므로 applyDone이 풀리면 applyState는 확정 상태다.
  events.addEventListener('agent.prepare', event => { void releaseDone.then(() => onMessage(event)); });
  events.addEventListener('agent.apply', event => { applyDone = onMessage(event); });
  events.addEventListener('agent.release', event => {
    const msg = JSON.parse(event.data);
    releaseDone = applyDone.then(() => handleRelease(msg), () => handleRelease(msg)).catch(() => {});
  });
  events.addEventListener('agent.follow', event => { void handleFollow(JSON.parse(event.data)); });
  events.onerror = () => {
    events.close();
    // 진행 중인 apply가 있으면(저장 확정 전) 표시만 하고 잠금을 유지한다. 되돌리기·저장 확정·해제·격리는 apply 처리기가 정한다.
    if (applyState && !applyState.saved) {
      disconnected = true;
      showStatus('편집기 연결이 끊김 · AI 편집을 마무리하는 중');
    } else if (active && !isolated) {
      const token = active;
      active = null;
      void unlock(token).catch(error => showStatus(`입력 잠금 해제 실패: ${error.message}`));
    }
    disconnected = true;
    setSaveLocked(true); // SSE가 끊긴 문서는 새 lease로 다시 열기 전까지 Save 금지
  };
  return async () => {
    // 격리된 탭은 정리 경로에서도 잠금과 Save 차단을 유지한다. 복구는 새로고침뿐이다.
    if (isolated) throw Object.assign(new Error('LEASE_ISOLATED'), { code: 'LEASE_ISOLATED' });
    // 에이전트 작업이 끝나지 않았으면(prepare 뒤 release 전, 또는 apply 확정 전) 정리를 거부한다.
    if (active || releasing || (applyState && !applyState.saved)) throw Object.assign(new Error('AGENT_BUSY'), { code: 'AGENT_BUSY' });
    setSaveLocked(false);
  };
}
