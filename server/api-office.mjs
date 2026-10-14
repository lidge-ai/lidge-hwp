// /api/office/* — 오피스 형식 보조 경로(상태, 변환). HWP 경로(/api/docs)와 분리한다.
import { findSoffice, convert as sofficeConvert } from '../lib/office/soffice.mjs';
import { parseGoogleUrl, fetchGoogleExport } from '../lib/office/google.mjs';
import { sniffBytes } from '../lib/office/sniff.mjs';
import { needsConversion } from '../lib/formats.mjs';
import { createHash } from 'node:crypto';

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

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// 사본으로 만들 수 있는 형식. 편집기 바이트(본문)로 만들 때와 서버 변환으로 만들 때 모두 이 안에서만.
// PDF는 문서함 형식이 아니므로 사본 대상이 아니다(보기용 PDF는 GET /api/office/pdf/<id>).
const COPY_TARGETS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
// 사본이 들어갈 그룹. 문서함은 프로젝트 한 단계와 추가 폴더 뿌리에만 새 파일을 만든다(createDocument).
// 더 깊은 폴더의 원본은 그 프로젝트(또는 추가 폴더) 뿌리에 사본을 만든다.
function groupOf(prefix) {
  const ext = /^ext:\/\/([^/]+)\//.exec(prefix);
  if (ext) return { kind: 'external', key: ext[1] };
  const first = prefix.split('/')[0];
  return first ? { kind: 'project', name: first } : { kind: 'default' };
}
// 같은 원본 바이트의 변환 결과를 몇 개만 기억한다(sha → 결과). 파일이 바뀌면 sha가 바뀐다.
function createCache(limit = 8) {
  const map = new Map();
  return {
    get(key) { const hit = map.get(key); if (hit) { map.delete(key); map.set(key, hit); } return hit ?? null; },
    set(key, value) { map.set(key, value); while (map.size > limit) map.delete(map.keys().next().value); },
  };
}

export function createOfficeApi({ store, tabs, office = {} }) {
  const convert = office.convert ?? sofficeConvert;
  const locate = office.findSoffice ?? findSoffice;
  const editableCache = createCache();
  const pdfCache = createCache();
  // 원본 → 다른 형식. LibreOffice가 못 여는 파일(최신 Pages/Keynote 등)은 422 UNSUPPORTED_SOURCE.
  async function converted(cache, bytes, from, to) {
    const key = sha256(bytes) + ':' + from + ':' + to;
    const hit = cache?.get(key);
    if (hit) return hit;
    let out;
    try { out = await convert(bytes, { from, to }); }
    catch (cause) {
      if (cause.code === 'SOFFICE_UNAVAILABLE') throw cause;
      throw Object.assign(new Error('UNSUPPORTED_SOURCE'), { status: 422, code: 'UNSUPPORTED_SOURCE', cause });
    }
    if (to !== 'pdf' && !sniffBytes(out, to)) throw Object.assign(new Error('UNSUPPORTED_SOURCE'), { status: 422, code: 'UNSUPPORTED_SOURCE' });
    if (to === 'pdf' && Buffer.from(out.subarray(0, 4)).toString('latin1') !== '%PDF') throw Object.assign(new Error('UNSUPPORTED_SOURCE'), { status: 422, code: 'UNSUPPORTED_SOURCE' });
    cache?.set(key, out);
    return out;
  }
  const decodeId = raw => { try { return decodeURIComponent(raw); } catch { throw Object.assign(new Error('INVALID_ID'), { status: 400, code: 'INVALID_ID' }); } };
  async function handle(req, res, pathname) {
    if (!pathname.startsWith('/api/office/')) return false;
    const route = pathname.slice('/api/office/'.length);
    try {
      if (route === 'status' && req.method === 'GET') {
        send(res, 200, { soffice: Boolean(locate()) });
        return true;
      }
      // GET /api/office/editable/<id>: 편집기가 여는 docx. docx는 원본 그대로, odt·rtf·doc·pages는 LibreOffice로 docx 변환.
      if (route.startsWith('editable/') && req.method === 'GET') {
        const id = decodeId(route.slice('editable/'.length));
        const doc = await store.read(id);
        if (doc.format !== 'docx' && !needsConversion(doc.format)) { error(res, 400, 'INVALID_FORMAT'); return true; }
        const out = doc.format === 'docx' ? doc.bytes : await converted(editableCache, doc.bytes, doc.format, 'docx');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': out.length,
          'X-Editable-Format': 'docx', 'X-Source-Sha256': doc.sha256, 'Cache-Control': 'no-store' });
        res.end(out);
        return true;
      }
      // GET /api/office/pdf/<id>: 보기용 PDF(슬라이드 미리보기, PDF로 보기). LibreOffice가 못 여는 파일은 422.
      if (route.startsWith('pdf/') && req.method === 'GET') {
        const id = decodeId(route.slice('pdf/'.length));
        const doc = await store.read(id);
        if (doc.bytes.length > 32 * 1024 * 1024) { error(res, 413, 'TOO_LARGE'); return true; }
        const out = await converted(pdfCache, doc.bytes, doc.format, 'pdf');
        const name = id.split('/').at(-1).replace(/\.[^.]+$/, '') + '.pdf';
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': out.length,
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
          'Content-Disposition': "inline; filename=\"document.pdf\"; filename*=UTF-8''" + encodeURIComponent(name) });
        res.end(out);
        return true;
      }
      // POST /api/office/copy: 원본 옆에 다른 형식 사본을 만든다. 본문이 있으면 그 바이트(편집기 내보내기), 없으면 서버 변환.
      if (route === 'copy' && req.method === 'POST') {
        const id = decodeId(String(req.headers['x-doc-id'] ?? ''));
        const target = String(req.headers['x-target-format'] ?? '');
        if (!COPY_TARGETS.has(target)) { error(res, 400, 'INVALID_FORMAT'); return true; }
        const source = await store.read(id);
        const supplied = await body(req, 32 * 1024 * 1024);
        let bytes;
        if (supplied.length) {
          if (!sniffBytes(supplied, target)) { error(res, 400, 'INVALID_BYTES'); return true; }
          bytes = supplied;
        } else {
          if (source.format === target) { error(res, 400, 'SAME_FORMAT'); return true; }
          bytes = await converted(null, source.bytes, source.format, target);
        }
        const slash = id.lastIndexOf('/');
        const prefix = id.slice(0, slash + 1);
        const base = id.slice(slash + 1).replace(/\.[^.]+$/, '');
        const group = groupOf(prefix);
        const doc = await createWithRetry(store, group, base + '.' + target, bytes);
        send(res, 201, { ...doc, from: id, source: supplied.length ? 'editor' : 'converted' });
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
