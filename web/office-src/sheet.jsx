// wp1 자리: 셸 어댑터 계약만 세운다. 실제 편집기는 다음 단계에서 붙는다.
export async function createEditor(host) {
  const element = document.createElement('div');
  element.className = 'office-pending';
  element.textContent = '시트 편집기는 곧 붙습니다';
  host.replaceChildren(element);
  return {
    element,
    async loadFile() { throw Object.assign(new Error('EDITOR_PENDING'), { code: 'EDITOR_PENDING' }); },
    async getDocumentState() { return { dirty: false }; },
    async exportWithReport() { throw Object.assign(new Error('EDITOR_PENDING'), { code: 'EDITOR_PENDING' }); },
    async notifySaved() {},
    destroy() { element.remove(); },
  };
}

