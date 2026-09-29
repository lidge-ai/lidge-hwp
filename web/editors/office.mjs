// 셸이 쓰는 오피스 편집기 공장. 형식 가족별 번들(/office/*.js)을 늦게 불러 #office-host에 붙인다.
import { familyOf } from '/formats.mjs';

const BUNDLES = { sheet: '/office/sheet.js', doc: '/office/doc.js', slides: '/office/slides.js' };
const STYLES = { sheet: '/office/sheet.css', doc: '/office/doc.css' };
function ensureStyle(href) {
  if (document.querySelector('link[data-office-style="' + href + '"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = href; link.dataset.officeStyle = href;
  document.head.append(link);
}
export async function createOfficeEditor(host, format, context = {}) {
  const family = familyOf(format);
  const bundle = BUNDLES[family];
  if (!bundle) throw Object.assign(new Error('INVALID_FORMAT'), { code: 'INVALID_FORMAT' });
  if (STYLES[family]) ensureStyle(STYLES[family]);
  const module = await import(bundle);
  const editor = await module.createEditor(host, { format, ...context });
  return { family, ...editor };
}

