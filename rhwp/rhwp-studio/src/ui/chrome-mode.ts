/**
 * UI chrome 프로파일 리졸버 (#4564).
 *
 * `?chrome=embed` — iframe 임베드처럼 문서 수명주기(열기/저장)를 호스트가 소유하는
 * 구성용 opt-in 프로파일. `?renderer=`와 같은 패턴을 따른다: 순수 resolve 함수,
 * URL 파라미터만 읽고(저장소 지속 없음), 미지원 값은 기본(full)으로 폴백하며
 * unsupportedReason으로 보고한다.
 */

import { isTextEditingTarget } from '../command/document-shortcut-guard.ts';

export type ChromeMode = 'full' | 'embed';
export type ChromeModeRequestSource = 'default' | 'url';
export type ChromeModeUnsupportedReason = 'unsupportedChromeMode';

export interface ChromeModeRequest {
  mode: ChromeMode;
  source: ChromeModeRequestSource;
  requested?: string;
  unsupportedReason?: ChromeModeUnsupportedReason;
}

/**
 * embed 프로파일에서 등록하지 않는 파일 수명주기 커맨드.
 *
 * 문서 수명주기를 호스트가 소유하는 구성에서 로컬 저장류는 "저장됐다"는 오인을
 * 만들고(다운로드 폴더로 떨어질 뿐 호스트 저장소에는 반영되지 않는다), 열기/새
 * 문서는 호스트가 감지할 수 없는 문서 교체 경로를 연다. `file:page-setup`과
 * `file:about`은 수명주기가 아니라 편집·정보 표면이므로 유지한다.
 * `file:save`는 예외로 등록한다: embed 저장은 로컬 다운로드가 아니라 lidge 호스트
 * 저장(`lidge.hostSaveRequested`)으로 보낸다.
 */
export const EMBED_HIDDEN_FILE_COMMAND_IDS: readonly string[] = [
  'file:new-doc',
  'file:open',
  'file:open-recent',
  'file:clear-recent',
  'file:save-as',
  'file:save-as-hwp',
  'file:save-as-hwpx',
  'file:export-html',
  'file:export-doc',
  'file:print-to-pdf',
  'file:print',
];

/**
 * embed 프로파일에서 등록하지 않는 편집 커맨드.
 *
 * 문서 비교는 비교 실행 시 오른쪽 문서를 현재 에디터에 로드하므로, 파일 열기와
 * 같은 급의 문서 교체 진입점이다 — 호스트는 문서 A를 열었다고 알고 있는데 Studio
 * 내부 문서가 B로 바뀔 수 있다.
 */
export const EMBED_HIDDEN_EDIT_COMMAND_IDS: readonly string[] = [
  'edit:compare-documents',
];

/** KeyboardEvent에서 단축키 판정에 쓰는 부분 — 순수 함수 테스트용 구조적 타입. */
export interface EmbedShortcutKeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type EmbedHostAction = 'lidge.hostRenameRequested' | 'lidge.hostCopyPathRequested' | 'lidge.hostNewRequested';

export function embedHostKey(e: EmbedShortcutKeyEventLike & { code?: string }): EmbedHostAction | null {
  if ((e.code === 'F2' || e.key === 'F2') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)
    return 'lidge.hostRenameRequested';
  if (!e.metaKey || e.ctrlKey) return null;
  const code = e.code;
  const key = e.key.toLowerCase();
  if (e.shiftKey && !e.altKey && (code === 'KeyR' || key === 'r' || key === 'ㄱ'))
    return 'lidge.hostRenameRequested';
  if (e.shiftKey && !e.altKey && (code === 'KeyC' || key === 'c' || key === 'ㅊ'))
    return 'lidge.hostCopyPathRequested';
  if (!e.shiftKey && (code === 'KeyN' || key === 'n' || key === 'ㅜ'))
    return 'lidge.hostNewRequested';
  return null;
}

export function embedHostAction(e: EmbedShortcutKeyEventLike & { code?: string; isComposing?: boolean }): EmbedHostAction | null {
  return e.isComposing ? null : embedHostKey(e);
}

export function shouldForwardHostShortcut(target: EventTarget | null, modalOpen: boolean): boolean {
  if (modalOpen) return false;
  if (!isTextEditingTarget(target)) return true;
  return (target as HTMLElement).closest?.('[data-rhwp-editor-input="true"]') != null;
}

export function hostShortcutDecision(
  e: EmbedShortcutKeyEventLike & { code?: string; isComposing?: boolean },
  target: EventTarget | null,
  modalOpen: boolean,
): { prevent: boolean; forward: EmbedHostAction | null } {
  const key = embedHostKey(e);
  if (!key) return { prevent: false, forward: null };
  if (e.isComposing) return { prevent: true, forward: null };
  return { prevent: true, forward: shouldForwardHostShortcut(target, modalOpen) ? key : null };
}

/**
 * embed에서 브라우저 기본 동작으로 새면 안 되는 파일 수명주기 단축키 판정.
 *
 * InputHandler가 활성이면 shortcut-map 매칭이 Ctrl+S/Ctrl+Shift+S/Ctrl+P를
 * preventDefault로 삼키지만, 문서 로드 전에는 그 경로 자체가 없어 브라우저
 * 저장/인쇄 대화상자로 빠진다. Alt+N/Ctrl+O는 전역 단축키 핸들러가 문서 유무와
 * 무관하게 이미 삼키므로 제외한다. 한글 IME 키(ㄴ/ㅔ)는 전역 핸들러의 ㅜ/ㅐ
 * 처리와 같은 이유로 함께 받는다. IME가 키를 먹으면 key가 'Process'로 오므로
 * 물리 키(code KeyS/KeyP)도 본다.
 */
export function isEmbedSwallowedFileShortcut(e: EmbedShortcutKeyEventLike): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const key = e.key.toLowerCase();
  // Ctrl+S 저장, Ctrl+Shift+S 다른 이름으로 저장
  if (e.code === 'KeyS' || key === 's' || key === 'ㄴ') return true;
  // Ctrl+P 인쇄, Ctrl+Shift+P 크롬 시스템 인쇄 대화상자 — 후자의 문서 로드 후
  // 매핑(table:block-product)은 InputHandler가 어차피 preventDefault하므로
  // 전역 흡수가 그 경로를 해치지 않는다.
  return e.code === 'KeyP' || key === 'p' || key === 'ㅔ';
}

export function resolveChromeMode(search = ''): ChromeMode {
  return resolveChromeModeRequest(search).mode;
}

export function resolveChromeModeRequest(search = ''): ChromeModeRequest {
  const explicit = new URLSearchParams(search).get('chrome');
  const normalized = explicit?.trim().toLowerCase();
  if (!normalized) return { mode: 'full', source: 'default' };
  if (normalized === 'embed') {
    return { mode: 'embed', source: 'url', requested: normalized };
  }
  if (normalized === 'full') {
    return { mode: 'full', source: 'url', requested: normalized };
  }
  return {
    mode: 'full',
    source: 'url',
    requested: explicit ?? normalized,
    unsupportedReason: 'unsupportedChromeMode',
  };
}
