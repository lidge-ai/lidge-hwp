// hwp_exec 오류를 MCP 결과까지 옮긴다(010 Revision 2 §R2-1). message만 옮기던 runner·worker가 code와 details도 싣는다.
// 크기 한도: message 4096자, details JSON 16 KiB(넘거나 직렬화할 수 없으면 {truncated:true}), code는 대문자 식별자만.
export const MAX_DETAILS_BYTES = 16384;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
export function wireError(e) {
  const out = { error: String(e?.message ?? e).slice(0, 4096) };
  if (typeof e?.code === 'string' && CODE.test(e.code)) out.code = e.code;
  if (typeof e?.retryable === 'boolean') out.retryable = e.retryable;
  if (e?.hashes && typeof e.hashes === 'object') {
    out.hashes = Object.fromEntries(['snapshotSha256', 'exportSha256', 'tabDiskSha256']
      .filter(key => typeof e.hashes[key] === 'string').map(key => [key, e.hashes[key]]));
  }
  if (e?.details !== undefined) {
    let json;
    try { json = JSON.stringify(e.details); } catch { json = undefined; }
    out.details = json !== undefined && Buffer.byteLength(json) <= MAX_DETAILS_BYTES ? JSON.parse(json) : { truncated: true };
  }
  return out;
}
