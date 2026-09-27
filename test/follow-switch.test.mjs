import test from 'node:test';
import assert from 'node:assert/strict';
import { followSwitch } from '../web/follow-switch.mjs';

function harness({ inert = false, current = true, switchTo, giveBack = null }) {
  const calls = { giveBack: [], say: [] };
  const element = { inert };
  const state = { current };
  const run = () => followSwitch({ id: 'x.hwp', reservation: 'tok', element,
    switchTo: (id, options) => switchTo(element, state, options),
    hasCurrent: () => state.current,
    giveBack: giveBack ?? (async token => { calls.giveBack.push(token); }),
    say: message => calls.say.push(message) });
  return { calls, element, state, run };
}

test('판정(getDocumentState)에서 던지면 예약 반납·inert 복구·알림', async () => {
  const h = harness({ switchTo: async (element, state, options) => {
    assert.equal(element.inert, true); assert.equal(options.agent, true); assert.equal(options.reservation, 'tok');
    throw new Error('boom');
  } });
  assert.equal(await h.run(), false);
  assert.deepEqual(h.calls.giveBack, ['tok']);
  assert.equal(h.element.inert, false);
  assert.match(h.calls.say[0], /AI 문서 전환 취소\(boom\) · x\.hwp는 탭 없이 편집됩니다/);
});
test('DIRTY는 확인 창 없이 이유를 알리고 반납한다', async () => {
  const h = harness({ switchTo: async () => { throw new Error('DIRTY'); } });
  assert.equal(await h.run(), false);
  assert.deepEqual(h.calls.giveBack, ['tok']);
  assert.match(h.calls.say[0], /저장하지 않은 편집 있음/);
});
test('격리된 이전 탭(inert=true)에서 반납이 LEASE_ISOLATED면 inert를 true로 되돌린다', async () => {
  const h = harness({ inert: true, switchTo: async () => { throw new Error('LEASE_ISOLATED'); } });
  await h.run();
  assert.equal(h.element.inert, true);
  assert.deepEqual(h.calls.giveBack, ['tok']);
});
test('이전 문서를 반납한 뒤 loadFile이 실패(예외)하면 반납하고, 문서 없음 화면의 inert=true는 그대로 두고 사유를 한 번 알린다', async () => {
  const h = harness({ switchTo: async (element, state) => { state.current = false; element.inert = true; throw new Error('LOAD_FAILED'); } });
  assert.equal(await h.run(), false);
  assert.deepEqual(h.calls.giveBack, ['tok']);
  assert.equal(h.element.inert, true);
  assert.equal(h.calls.say.length, 1); // AI 전환의 알림은 followSwitch만 쓴다
  assert.match(h.calls.say[0], /LOAD_FAILED/);
});
test('성공하면 반납하지 않고 inert는 switchTo가 정한 값', async () => {
  const h = harness({ switchTo: async element => { element.inert = false; return true; } });
  assert.equal(await h.run(), true);
  assert.deepEqual(h.calls.giveBack, []);
  assert.equal(h.element.inert, false);
});
test('반납 요청이 실패해도 던지지 않고 inert를 되돌린다', async () => {
  const h = harness({ switchTo: async () => { throw new Error('SAVING'); },
    giveBack: async () => { throw new Error('network'); } });
  assert.equal(await h.run(), false);
  assert.equal(h.element.inert, false);
});
test('switchTo가 예외 없이 false면 전환되지 않음을 한 번 알리고, 반납하고, inert를 되돌린다', async () => {
  const h = harness({ inert: false, switchTo: async element => { element.inert = true; return false; } });
  assert.equal(await h.run(), false);
  assert.equal(h.calls.say.length, 1);
  assert.match(h.calls.say[0], /전환되지 않음/);
  assert.deepEqual(h.calls.giveBack, ['tok']);
  assert.equal(h.element.inert, false);
});
