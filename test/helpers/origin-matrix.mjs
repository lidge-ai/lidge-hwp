import assert from 'node:assert/strict';

export async function assertOriginMatrix(request, sameStatus) {
  for (const origin of [undefined, 'http://evil.example']) {
    const response = await request(origin);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'BAD_ORIGIN');
  }
  assert.equal((await request('same')).status, sameStatus);
}
