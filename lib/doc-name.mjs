// Browser and server share the new-document filename rule. The server also validates the final segment.
// ext는 만들 형식의 확장자('.hwp' 기본, '.xlsx', '.docx'). 다른 확장자가 붙은 이름은 INVALID_FORMAT.
export function normalizeNewDocName(raw, ext = '.hwp') {
  if (typeof raw !== 'string') throw Object.assign(new Error('INVALID_NAME'), { status: 400, code: 'INVALID_NAME' });
  if (typeof ext !== 'string' || !/^\.[a-z0-9]+$/.test(ext)) throw Object.assign(new Error('INVALID_FORMAT'), { status: 400, code: 'INVALID_FORMAT' });
  const name = raw.trim().normalize('NFC');
  if (!name) throw Object.assign(new Error('INVALID_NAME'), { status: 400, code: 'INVALID_NAME' });
  let result;
  if (name.toLowerCase().endsWith(ext)) result = `${name.slice(0, -ext.length)}${ext}`;
  else if (/\.[^/.]+$/.test(name)) throw Object.assign(new Error('INVALID_FORMAT'), { status: 400, code: 'INVALID_FORMAT' });
  else result = `${name}${ext}`;
  if (result.length > 128 || result.startsWith('.') || /[/\\]|[\x00-\x1f\x7f]/.test(result))
    throw Object.assign(new Error('INVALID_NAME'), { status: 400, code: 'INVALID_NAME' });
  return result;
}
