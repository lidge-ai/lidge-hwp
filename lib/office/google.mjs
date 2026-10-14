// Google Docs/Sheets/Slides 가져오기. docs.google.com URL만 받고 export 엔드포인트에서
// 바이트를 받는다. 최종 응답 URL이 Google 계열 호스트인지 확인해 오픈 리다이렉트를 막는다.
import { validateSegment } from '../docstore.mjs';

const DOCS_HOST = 'docs.google.com';
const ID_RE = /^[A-Za-z0-9_-]{20,}$/;
const GID_RE = /(?:^|[#&])gid=(\d+)/;
const SEARCH_GID_RE = /(?:^|[?&])gid=(\d+)/;
const ALLOWED_HOST_SUFFIXES = ['.google.com', '.googleusercontent.com'];

const KINDS = {
  spreadsheets: {
    kind: 'sheet',
    ext: 'xlsx',
    defaultName: 'Google 시트.xlsx',
    exportUrl: (id, gid) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx${gid ? `&gid=${gid}` : ''}`,
  },
  document: {
    kind: 'doc',
    ext: 'docx',
    defaultName: 'Google 문서.docx',
    exportUrl: id => `https://docs.google.com/document/d/${id}/export?format=docx`,
  },
  presentation: {
    kind: 'slides',
    ext: 'pptx',
    defaultName: 'Google 슬라이드.pptx',
    exportUrl: id => `https://docs.google.com/presentation/d/${id}/export/pptx`,
  },
};

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };

export function parseGoogleUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { fail(400, 'INVALID_URL'); }
  if (url.protocol !== 'https:' || url.hostname !== DOCS_HOST) fail(400, 'INVALID_URL');
  const match = /^\/(spreadsheets|document|presentation)\/d\/([^/?#]+)/.exec(url.pathname);
  const spec = match && KINDS[match[1]];
  if (!spec || !ID_RE.test(match[2])) fail(400, 'INVALID_URL');
  const gid = GID_RE.exec(url.hash)?.[1] ?? SEARCH_GID_RE.exec(url.search)?.[1] ?? null;
  return {
    kind: spec.kind,
    id: match[2],
    gid,
    exportUrl: spec.exportUrl(match[2], gid),
    ext: spec.ext,
    defaultName: spec.defaultName,
  };
}

// content-disposition 파일명이 validateSegment를 통과하지 못하면 기본 이름으로 바꾼다.
// 확장자는 kind 기준으로 강제한다.
function coerceFileName(raw, parsed) {
  try {
    const dot = raw.lastIndexOf('.');
    const base = dot > 0 ? raw.slice(0, dot) : raw;
    return validateSegment(`${base}.${parsed.ext}`);
  } catch {
    return parsed.defaultName;
  }
}

function fileNameFromDisposition(disposition, parsed) {
  if (typeof disposition !== 'string') return parsed.defaultName;
  const star = /filename\*=UTF-8''([^;]*)/i.exec(disposition);
  if (star) {
    try { return coerceFileName(decodeURIComponent(star[1]), parsed); }
    catch { return parsed.defaultName; }
  }
  const plain = /filename="([^"]*)"/i.exec(disposition);
  return plain ? coerceFileName(plain[1], parsed) : parsed.defaultName;
}

export async function fetchGoogleExport(parsed, { fetchImpl = fetch, timeoutMs = 20000, maxBytes = 64 * 1024 * 1024 } = {}) {
  let response;
  try {
    response = await fetchImpl(parsed.exportUrl, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw Object.assign(new Error('GOOGLE_FETCH_FAILED'), { status: 502, code: 'GOOGLE_FETCH_FAILED', cause });
  }
  let finalHost;
  try { finalHost = new URL(response.url).hostname.toLowerCase(); }
  catch { fail(403, 'GOOGLE_REDIRECT_BLOCKED'); }
  if (finalHost !== DOCS_HOST && !ALLOWED_HOST_SUFFIXES.some(suffix => finalHost.endsWith(suffix))) {
    fail(403, 'GOOGLE_REDIRECT_BLOCKED');
  }
  if (!response.ok) {
    // Google이 401/403/404로 답하면 공유되지 않은 문서(또는 삭제됨)다.
    if (response.status === 401 || response.status === 403 || response.status === 404) fail(403, 'GOOGLE_NOT_SHARED');
    fail(502, 'GOOGLE_FETCH_FAILED');
  }
  if (response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) fail(403, 'GOOGLE_NOT_SHARED');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) fail(413, 'TOO_LARGE');
    chunks.push(chunk);
  }
  return {
    bytes: Buffer.concat(chunks),
    fileName: fileNameFromDisposition(response.headers.get('content-disposition'), parsed),
  };
}
