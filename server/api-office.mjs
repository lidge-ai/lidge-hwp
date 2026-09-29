// /api/office/* — 오피스 형식 보조 경로(상태, 변환). HWP 경로(/api/docs)와 분리한다.
import { findSoffice, convert as sofficeConvert } from '../lib/office/soffice.mjs';

const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const error = (res, status, code) => send(res, status, { error: { code, message: code } });

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
      error(res, 404, 'NOT_FOUND');
    } catch (cause) { error(res, cause.status || 500, cause.code || 'OFFICE_FAILED'); }
    return true;
  }
  return { handle, convert, store, tabs };
}

