// Browser and server share the new HWP filename rule. The server also validates the final segment.
export function normalizeNewDocName(raw) {
  if (typeof raw !== 'string') throw Object.assign(new Error('INVALID_NAME'), { status: 400, code: 'INVALID_NAME' });
  const name = raw.trim().normalize('NFC');
  if (!name) throw Object.assign(new Error('INVALID_NAME'), { status: 400, code: 'INVALID_NAME' });
  let result;
  if (/\.hwp$/i.test(name)) result = `${name.slice(0, -4)}.hwp`;
  else if (/\.[^/.]+$/.test(name)) throw Object.assign(new Error('INVALID_FORMAT'), { status: 400, code: 'INVALID_FORMAT' });
  else result = `${name}.hwp`;
  if (result.length > 128 || result.startsWith('.') || /[/\\]|[\x00-\x1f\x7f]/.test(result))
    throw Object.assign(new Error('INVALID_NAME'), { status: 400, code: 'INVALID_NAME' });
  return result;
}
