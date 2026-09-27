import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, functionBodyFrom } from './support/source-guard.ts';

// 셀 블록 지우기 키 정합 (한컴 Mac 단축키표: 셀 내용 지우기 = ⌃E/Delete, 지우기 = ⌘E).
//
// macOS 에서 한컴의 "Delete" 는 delete 키로 브라우저에는 Backspace 로 보고된다 —
// 셀 블록의 내용 지우기는 Backspace 와 forward Delete 양쪽을 받아야 한다.
// ⌘⌫/⌘Delete 는 한컴 표에는 없지만 macOS "항목 지우기" 관례로 edit:delete 에 태운다.

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (p: string) => readFileSync(join(rootDir, p), 'utf8');

/** 셀 선택 모드 분기 본문만 잘라낸다 (issue-6741 가드와 동일 경계). */
function cellSelectionBranch(kb: string): string {
  const at = kb.indexOf('if (this.cursor.isInCellSelectionMode()) {');
  assert.notEqual(at, -1, '셀 선택 모드 분기를 찾지 못했다');
  const end = kb.indexOf('handleNavigationShortcut.call(this, e)', at);
  assert.notEqual(end, -1, '분기 끝(내비게이션 단축키 처리)을 찾지 못했다');
  return kb.slice(at, end);
}

test('셀 블록에서 Backspace·Delete(무보조)는 내용 지우기 — 블록 해제보다 먼저', () => {
  const block = cellSelectionBranch(codeOnly(source('src/engine/input-handler-keyboard.ts')));
  const fallthroughAt = block.lastIndexOf('this.cursor.exitCellSelectionMode();');

  const clearAt = block.indexOf("e.key === 'Delete' || e.key === 'Backspace'");
  assert.notEqual(clearAt, -1, 'Backspace+Delete 무보조 내용 지우기 분기가 없다');
  assert.ok(clearAt < fallthroughAt, '내용 지우기가 블록 해제 폴백보다 뒤에 있다');
  assert.match(
    block.slice(clearAt, fallthroughAt),
    /!e\.ctrlKey && !e\.metaKey && !e\.altKey[\s\S]*this\.clearSelectedCellBlock\(\)/,
    '무보조 Backspace/Delete 가 clearSelectedCellBlock 로 가지 않는다',
  );
});

test('셀 블록에서 ⌘⌫·⌘Delete 는 edit:delete 로 태운다 — 블록 해제보다 먼저', () => {
  const block = cellSelectionBranch(codeOnly(source('src/engine/input-handler-keyboard.ts')));
  const fallthroughAt = block.lastIndexOf('this.cursor.exitCellSelectionMode();');

  assert.match(
    block.slice(0, fallthroughAt),
    /e\.metaKey && !e\.ctrlKey && !e\.altKey[\s\S]{0,300}this\.dispatcher\?\.dispatch\('edit:delete'\)/,
    'Meta+Backspace/Delete 가 edit:delete 로 디스패치되지 않는다',
  );
});

test('edit:delete 는 셀 블록을 해제하지 않고 통과한다 (⌘E 경로)', () => {
  const kb = codeOnly(source('src/engine/input-handler-keyboard.ts'));
  assert.match(
    kb,
    /CELL_BLOCK_GLOBAL_COMMANDS = new Set\(\[[^\]]*'edit:delete'[^\]]*\]\)/,
    'CELL_BLOCK_GLOBAL_COMMANDS 에 edit:delete 가 없다 — ⌘E 가 블록을 먼저 해제한다',
  );
});

test('edit:delete 는 셀 선택 모드에서도 실행 가능하다', () => {
  const edit = codeOnly(source('src/command/commands/edit.ts'));
  const cmd = edit.slice(edit.indexOf("id: 'edit:delete'"), edit.indexOf("id: 'edit:select-all'"));
  assert.match(cmd, /canExecute:[\s\S]*ctx\.inCellSelectionMode/,
    'edit:delete 의 canExecute 가 inCellSelectionMode 를 인정하지 않는다');
});

test('performDelete 는 셀 선택 모드를 deleteSelectedCellBlock 로 라우팅한다', () => {
  const ih = codeOnly(source('src/engine/input-handler.ts'));
  const fn = functionBodyFrom(ih, 'performDelete(): void');
  const routeAt = fn.indexOf('this.cursor.isInCellSelectionMode()');
  assert.notEqual(routeAt, -1, 'performDelete 에 셀 선택 모드 분기가 없다');
  assert.match(fn.slice(routeAt), /void this\.deleteSelectedCellBlock\(\)/,
    '셀 선택 모드가 deleteSelectedCellBlock 으로 가지 않는다');
});

test('구조 삭제는 전체 줄/칸 정렬·중첩·제외 셀·병합 걸침을 가린다', () => {
  const ih = codeOnly(source('src/engine/input-handler.ts'));
  const fn = functionBodyFrom(ih, 'private async deleteSelectedCellBlock()');
  assert.match(fn, /isProtectedCellSelectionMode/, '보호 셀 선택 가드가 없다');
  assert.match(fn, /cellPath/, '중첩 표 제외 가드가 없다');
  assert.match(fn, /getExcludedCells\(\)\.size === 0/, '제외 셀 가드가 없다');
  assert.match(fn, /getTableDimensions/, '표 차수를 읽지 않는다');
  assert.match(fn, /getTableCellBboxes/, '병합 셀 걸침 검사가 없다');
  assert.match(fn, /askCellBlockDelete/, '구조 삭제 확인 대화상자를 묻지 않는다');
  assert.match(fn, /kind: 'snapshot'/, '구조 삭제가 스냅샷으로 기록되지 않는다');
  assert.match(fn, /mode: 'cellBlock'/, '지우기 전 셀 블록을 selectionBefore 에 싣지 않는다');
});
