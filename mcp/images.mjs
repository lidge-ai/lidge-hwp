// hwp.snapshot(h,{inline:true})가 남긴 쪽 PNG를 MCP 이미지 블록으로 만든다(mcp/server.mjs).
// 내보내기 폴더(LIDGE_HWP_EXPORTS, 기본 ~/.lidge-hwp/exports) 안의 page-NNN.png만 읽는다.
import { readFile, realpath, stat } from 'node:fs/promises';
import { sep, basename } from 'node:path';
import { EXPORTS_ROOT } from '../lib/config.mjs';
export const MAX_IMAGES = 4, MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export async function imageBlocks(images, root = EXPORTS_ROOT) {
  const blocks = [], skipped = [];
  if (!Array.isArray(images) || !images.length) return { blocks, skipped };
  let base;
  try { base = await realpath(root); } catch { return { blocks, skipped: images.map(i => ({ page: i?.page, why: 'exports root missing' })) }; }
  for (const [i, item] of images.entries()) {
    try {
      if (i >= MAX_IMAGES) throw new Error(`more than ${MAX_IMAGES} images`);
      if (typeof item?.path !== 'string' || !/^page-\d{3,}\.png$/.test(basename(item.path))) throw new Error('not a page png');
      const real = await realpath(item.path);
      if (!real.startsWith(base + sep)) throw new Error('outside exports root');
      if ((await stat(real)).size > MAX_IMAGE_BYTES) throw new Error('too large; pass a smaller maxPx');
      blocks.push({ type: 'text', text: `page ${item.page} (0-based): ${real}` });
      blocks.push({ type: 'image', data: (await readFile(real)).toString('base64'), mimeType: 'image/png' });
    } catch (error) { skipped.push({ page: item?.page, why: error.message }); }
  }
  return { blocks, skipped };
}
