// docx-editor 쪽 그리기 조각 재사용 빌드 패치(scripts/docx-paint-reuse.mjs) 단위 검사.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, transform } from 'esbuild';
import { patchDocxPaint, docxPaintReusePlugin, DOCX_PAINT_ANCHORS } from '../scripts/docx-paint-reuse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'node_modules/@docx-editor.dev/core/dist');
const [HEAD, PICK, PARAMS] = DOCX_PAINT_ANCHORS;
const EXTRA = '|fs:${p.fieldShading??""}:${p.shadeFormFields??""}:${p.activeHeaderFooterRId??""}:${p.activeHeaderFooterPageIndex??""}`';

// 설치된 엔진의 쪽 그리기 Ln과 같은 모양의 작은 모듈. 조각 그리기 O(문단)·K(표)는 호출을 센다.
function fakeModule(prefix = '') {
  return prefix + 'export const calls = { O: 0, K: 0 };\n'
    + 'function O(t,h,a){calls.O++;return { el: "O:" + h.id, paint: a.paintInstance }}\n'
    + 'function K(t,h,a){calls.K++;return { el: "K:" + h.id }}\n'
    + 'export function Ln(t,r,o,n){let a={...n,paintInstance:"p"+o.index,' + HEAD
    + 'for(let h of o.fragments){' + PICK + 's.set(h,p),l.push(p);}return { blocks: s, list: l }}\n'
    + 'export function params(p){return `x' + PARAMS + '}\n';
}
async function importPatched(source) {
  const dir = await mkdtemp(join(tmpdir(), 'lidge-docx-paint-'));
  const file = join(dir, 'ln.mjs');
  await writeFile(file, source);
  try { return await import(pathToFileURL(file).href); } finally { await rm(dir, { recursive: true, force: true }); }
}
const page = (fragments, index = 0) => ({ index, contentBox: { x: 72 }, box: { x: 0 }, fragments });

test('설치된 @docx-editor.dev/core 청크 가운데 정확히 하나에 세 치환이 들어간다', async () => {
  const files = (await readdir(CORE)).filter(name => /^chunk-.*\.js$/.test(name));
  const patched = [];
  for (const name of files) {
    const out = patchDocxPaint(await readFile(join(CORE, name), 'utf8'));
    if (out !== null) patched.push({ name, out });
  }
  assert.equal(patched.length, 1, 'patched chunks: ' + patched.map(p => p.name).join(','));
  const { out } = patched[0];
  assert.ok(out.includes(HEAD + 'const __lidgeRep='), 'signature helpers follow the Ln head');
  assert.ok(out.includes('let p=r.get(h);if(!p){const __k=__lidgeSig(h)'), 'fragment pick falls back to the signature');
  assert.ok(!out.includes(PICK), 'identity-only pick is gone');
  assert.ok(out.includes(EXTRA), 'paint parameter key gains the four span options');
  assert.ok(!out.includes(PARAMS), 'old parameter key ending is gone');
  await transform(out, { loader: 'js', format: 'esm' }); // 문법이 깨지지 않았다
});

test('앵커가 하나도 없으면 null, 일부만 있거나 두 번 있으면 DOCX_PAINT_PATCH_DRIFT', () => {
  assert.equal(patchDocxPaint('export const x = 1;'), null);
  const drift = source => assert.throws(() => patchDocxPaint(source), error => error.code === 'DOCX_PAINT_PATCH_DRIFT');
  drift(HEAD);
  drift(HEAD + PICK);
  drift(PICK + PARAMS);
  drift(HEAD + PICK + PARAMS + HEAD);
  drift(HEAD + PICK + PARAMS + PICK + PARAMS);
});

test('치환 문자열의 $ 패턴은 특수 해석 없이 그대로 들어간다', () => {
  const out = patchDocxPaint('A' + HEAD + 'B' + PICK + 'C' + PARAMS + 'D');
  assert.ok(out.includes('fs:${p.fieldShading'), out);
  assert.ok(out.endsWith('C' + PARAMS.slice(0, -1) + EXTRA + 'D'), 'the bars key is kept and fs options follow it');
  assert.ok(out.startsWith('A' + HEAD + 'const __lidgeRep='));
  assert.equal(out.split('__lidgeSig=').length - 1, 1);
  // 원문에 $&·$`·$' 같은 치환 패턴 모양이 있어도 그대로 남는다.
  const tricky = patchDocxPaint("x='$&$1$$';" + HEAD + PICK + PARAMS + "y='$`$'';");
  assert.ok(tricky.startsWith("x='$&$1$$';") && tricky.endsWith("y='$`$'';"));
});

test('패치된 Ln: 동일성·같은 구조는 재사용하고 Map이 든 조각과 중복은 새로 그린다', async () => {
  const mod = await importPatched(patchDocxPaint(fakeModule()));
  const f1 = { id: 1, kind: 'paragraph', lines: [{ text: 'a' }] };
  const f2 = { id: 2, kind: 'paragraph', lines: [{ text: 'b' }] };
  const t3 = { id: 3, kind: 'table', rows: [[{ text: 'c' }]] };
  const withMap = { id: 4, kind: 'paragraph', extra: new Map([['k', 'v']]) };
  const first = mod.Ln(null, new Map(), page([f1, f2, t3, withMap]), { scale: 1 });
  assert.deepEqual(mod.calls, { O: 3, K: 1 });
  // 다음 레이아웃: f1은 같은 객체, f2·t3는 JSON이 같은 새 객체, Map 조각은 JSON({})만 같은 새 객체, f2 복제 하나 더.
  const f2b = structuredClone(f2), t3b = structuredClone(t3), f2c = structuredClone(f2);
  const withMap2 = { id: 4, kind: 'paragraph', extra: new Map([['k', 'other']]) };
  const second = mod.Ln(null, first.blocks, page([f1, f2b, t3b, withMap2, f2c]), { scale: 1 });
  assert.equal(second.blocks.get(f1), first.blocks.get(f1), 'identity hit keeps the element');
  assert.equal(second.blocks.get(f2b), first.blocks.get(f2), 'same JSON reuses the old element');
  assert.equal(second.blocks.get(t3b), first.blocks.get(t3), 'tables reuse by signature too');
  assert.notEqual(second.blocks.get(withMap2), first.blocks.get(withMap), 'a Map-bearing fragment is never reused');
  assert.notEqual(second.blocks.get(f2c), first.blocks.get(f2), 'an old element is reused at most once');
  assert.deepEqual(mod.calls, { O: 5, K: 1 }, 'only the Map fragment and the duplicate were painted again');
  const changed = { ...f1, lines: [{ text: 'a!' }] };
  const third = mod.Ln(null, second.blocks, page([changed]), { scale: 1 });
  assert.notEqual(third.blocks.get(changed), second.blocks.get(f1), 'different content paints anew');
});

test('서명: 함수·Set·DOM 노드가 들어 있으면 재사용하지 않는다', async () => {
  const mod = await importPatched(patchDocxPaint(fakeModule('globalThis.Node ??= class Node {};\n')));
  const node = new globalThis.Node();
  const make = () => [{ id: 1, kind: 'p', fn: () => 1 }, { id: 2, kind: 'p', set: new Set([1]) }, { id: 3, kind: 'p', node }];
  const before = make();
  const first = mod.Ln(null, new Map(), page(before), {});
  const again = make();
  const second = mod.Ln(null, first.blocks, page(again), {});
  for (let i = 0; i < 3; i++) assert.notEqual(second.blocks.get(again[i]), first.blocks.get(before[i]));
  assert.equal(mod.calls.O, 6);
});

test('그리기 설정 문자열: 스팬 옵션 네 개가 바뀌면 키가 달라진다', async () => {
  const mod = await importPatched(patchDocxPaint(fakeModule()));
  const key = extra => mod.params({ changeBars: 'all-markup', changeBarsToggle: false, ...extra });
  assert.equal(key({}), 'x|bars:all-markup:false|fs::::');
  for (const extra of [{ fieldShading: 'always' }, { shadeFormFields: true }, { activeHeaderFooterRId: 'rId7' }, { activeHeaderFooterPageIndex: 0 }])
    assert.notEqual(key(extra), key({}), JSON.stringify(extra));
});

test('esbuild 플러그인: 앵커 청크에 한 번 적용되고, 한 번도 안 되면 빌드가 실패한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lidge-docx-plugin-'));
  try {
    const pkg = join(dir, 'node_modules/@docx-editor.dev/core/dist');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'chunk-A.js'), fakeModule());
    await writeFile(join(pkg, 'chunk-B.js'), 'export const other = 1;\n');
    const entry = (name, chunks) => writeFile(join(dir, name), chunks.map(c => "export * from './node_modules/@docx-editor.dev/core/dist/" + c + "';").join('\n'));
    const run = name => build({ entryPoints: [join(dir, name)], bundle: true, write: false, format: 'esm', logLevel: 'silent', plugins: [docxPaintReusePlugin({ readFile })] });
    await entry('ok.mjs', ['chunk-A.js', 'chunk-B.js']);
    assert.ok((await run('ok.mjs')).outputFiles[0].text.includes('__lidgeSig'));
    await entry('none.mjs', ['chunk-B.js']);
    await assert.rejects(run('none.mjs'), error => /applied 0 times/.test(error.message) || (error.errors ?? []).some(e => /applied 0 times/.test(e.text)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
