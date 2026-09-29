// docx-editor(@docx-editor.dev/core, Apache-2.0) 빌드 단계 패치: 쪽 그리기의 조각(fragment) 재사용.
//
// 엔진의 쪽 그리기 Ln은 바뀐 쪽에서 이전 조각 DOM을 객체 동일성(r.get(h))으로만 찾는다. 레이아웃이 키마다 새
// 조각 객체를 만들면 모두 빗나가 편집한 쪽의 조각을 전부 새 DOM으로 그린다(600문단에서 키당 노드 약 1,065개).
// Aside처럼 확장이 문서 전체 DOM 변경을 관찰하는 브라우저에서는 이 비용이 그대로 입력 지연이 된다.
//
// 패치는 (1) 동일성으로 못 찾은 조각을, 같은 쪽의 이전 조각 중 구조 서명(JSON)이 같은 것의 DOM으로 재사용하고
// (2) 그리기 설정 문자열에 조각 그리기가 읽지만 빠져 있던 옵션 네 개를 더해, 그 옵션이 바뀌면 전체 다시 그리기로 가게 한다.
// 조각 그리기(O·K)는 조각 객체와 그리기 옵션만 읽고, 이 청크의 그려진 DOM에는 리스너가 없다.
// 서명에 Map·Set·함수·DOM 노드가 섞이면(JSON으로 내용이 사라짐) 그 조각은 재사용하지 않는다.
// 앵커가 정확히 한 번씩 있지 않으면 DOCX_PAINT_PATCH_DRIFT로 빌드를 멈춘다(버전이 바뀌면 다시 검토).

const HEAD = 'tabLeaderOriginXPt:o.contentBox.x-o.box.x},s=new Map,l=[];';
const PICK = 'let p=r.get(h)??(h.kind==="table"?K(t,h,a):O(t,h,a));';
const PARAMS = '|bars:${p.changeBars}:${p.changeBarsToggle}`';

const SIGNATURE = 'const __lidgeRep=(k,v)=>{if(v instanceof Map||v instanceof Set||typeof v==="function"'
  + '||(typeof Node!=="undefined"&&v instanceof Node))throw 0;return v},'
  + '__lidgeSig=f=>{try{return JSON.stringify(f,__lidgeRep)}catch{return null}},__lidgePrev=new Map;'
  + 'for(const[__f,__e]of r){const __k=__lidgeSig(__f);__k!==null&&!__lidgePrev.has(__k)&&__lidgePrev.set(__k,__e)}';
const REUSE = 'let p=r.get(h);if(!p){const __k=__lidgeSig(h),__e=__k!==null?__lidgePrev.get(__k):void 0;'
  + '__e?(__lidgePrev.delete(__k),p=__e):p=h.kind==="table"?K(t,h,a):O(t,h,a)}';
const EXTRA_PARAMS = '|bars:${p.changeBars}:${p.changeBarsToggle}'
  + '|fs:${p.fieldShading??""}:${p.shadeFormFields??""}:${p.activeHeaderFooterRId??""}:${p.activeHeaderFooterPageIndex??""}`';

export const DOCX_PAINT_ANCHORS = Object.freeze([HEAD, PICK, PARAMS]);

const count = (source, needle) => source.split(needle).length - 1;

// 세 앵커가 모두 없으면 이 청크가 아니다(null). 일부만 있거나 두 번 이상이면 버전이 바뀐 것이다.
export function patchDocxPaint(source) {
  const counts = DOCX_PAINT_ANCHORS.map(anchor => count(source, anchor));
  if (counts.every(n => n === 0)) return null;
  if (counts.some(n => n !== 1)) {
    throw Object.assign(new Error('docx-editor paint patch anchors drifted: ' + counts.join(',')),
      { code: 'DOCX_PAINT_PATCH_DRIFT' });
  }
  // 치환 문자열에 $가 들어 있으므로 함수형 대체로 특수 패턴 해석을 막는다.
  return source.replace(HEAD, () => HEAD + SIGNATURE).replace(PICK, () => REUSE).replace(PARAMS, () => EXTRA_PARAMS);
}

export function docxPaintReusePlugin({ readFile }) {
  return {
    name: 'lidge-docx-paint-reuse',
    setup(build) {
      let applied = 0;
      build.onLoad({ filter: /@docx-editor\.dev[\\/]core[\\/]dist[\\/]chunk-.*\.js$/ }, async ({ path }) => {
        const patched = patchDocxPaint(await readFile(path, 'utf8'));
        if (patched === null) return undefined;
        applied += 1;
        return { contents: patched, loader: 'js' };
      });
      build.onEnd(result => {
        if (result.errors.length === 0 && applied !== 1) {
          throw Object.assign(new Error('docx-editor paint patch applied ' + applied + ' times (expected 1)'),
            { code: 'DOCX_PAINT_PATCH_DRIFT' });
        }
      });
    },
  };
}
