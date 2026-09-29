// /api/office/* — 오피스 형식 보조 경로(상태, 변환). HWP 경로(/api/docs)와 분리한다.
import { findSoffice, convert as sofficeConvert } from '../lib/office/soffice.mjs';
import { parseGoogleUrl, fetchGoogleExport } from '../lib/office/google.mjs';
import { sniffBytes } from '../lib/office/sniff.mjs';

const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const error = (res, status, code) => send(res, status, { error: { code, message: code } });

async function body(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('TOO_LARGE'), { status: 413, code: 'TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// DOC_EXISTS면 " (2)"…" (10)"를 확장자 앞에 붙여 다시 시도한다.
async function createWithRetry(store, group, fileName, bytes) {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  for (let n = 1; n <= 10; n += 1) {
    const name = n === 1 ? fileName : `${base} (${n})${ext}`;
    try { return await store.createDocument(group, name, bytes); }
    catch (cause) { if (cause.code !== 'DOC_EXISTS' || n === 10) throw cause; }
  }
}

export function createOfficeApi({ store, tabs, office = {} }) {
  const convert = office.convert ?? sofficeConvert;
  const locate = office.findSoffice ?? findSoffice;
  async function handle(req, res, pathname) {
    if (!pathname.startsWith('/api/office/')) return false;
    const route = pathname.slice('/api/office/'.length);
    try {
      if (route === 'status' && req.method === 'GET') {
        send(res, 200, { soffice: Boolean(locate()) });
        return true;
      }
      if (route === 'import-url' && req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
          error(res, 415, 'INVALID_CONTENT_TYPE'); return true;
        }
        let data;
        try { data = JSON.parse((await body(req, 8192)).toString('utf8')); }
        catch (cause) {
          const code = cause instanceof SyntaxError ? 'INVALID_JSON' : cause.code || 'IMPORT_FAILED';
          error(res, cause instanceof SyntaxError ? 400 : cause.status || 500, code);
          return true;
        }
        const group = data?.group;
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.url !== 'string'
            || !group || typeof group !== 'object' || Array.isArray(group)
            || !['default', 'project', 'external'].includes(group.kind)
            || (group.kind === 'project' && typeof group.name !== 'string')
            || (group.kind === 'external' && typeof group.key !== 'string')) {
          error(res, 400, 'INVALID_GROUP'); return true;
        }
        const parsed = parseGoogleUrl(data.url);
        const fetched = await fetchGoogleExport(parsed, { fetchImpl: office.fetchImpl ?? fetch });
        // export 결과가 kind에 맞는 오피스 바이트인지 본다(로그인 HTML·오류 페이지는 위에서 걸러진다).
        if (!sniffBytes(fetched.bytes, parsed.ext)) { error(res, 502, 'GOOGLE_BAD_BYTES'); return true; }
        const doc = await createWithRetry(store, group, fetched.fileName, fetched.bytes);
        send(res, 201, { ...doc, source: 'google' });
        return true;
      }
      error(res, 404, 'NOT_FOUND');
    } catch (cause) { error(res, cause.status || 500, cause.code || 'OFFICE_FAILED'); }
    return true;
  }
  return { handle, convert, store, tabs };
}
