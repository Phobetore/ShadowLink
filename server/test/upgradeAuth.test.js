import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeUpgrade } from '../upgradeAuth.js';

const ok = (k) => k === 'sk_good';

test('accepts a valid key, a single-segment docId path, and a workspace query param', () => {
  const r = authorizeUpgrade('/aGVsbG8?t=sk_good&w=demo', ok);
  assert.equal(r.ok, true);
  assert.equal(r.workspaceId, 'demo');
  assert.equal(r.docId, 'aGVsbG8');
  assert.equal(r.docName, 'demo/aGVsbG8');
});

test('rejects a missing or wrong key with 401', () => {
  assert.deepEqual(authorizeUpgrade('/aGVsbG8?w=demo', ok), { ok: false, code: 401 });
  assert.deepEqual(authorizeUpgrade('/aGVsbG8?t=sk_bad&w=demo', ok), { ok: false, code: 401 });
});

test('rejects a path that is not exactly one segment with 400', () => {
  assert.equal(authorizeUpgrade('/?t=sk_good&w=demo', ok).code, 400);
  assert.equal(authorizeUpgrade('/a/b?t=sk_good&w=demo', ok).code, 400);
});

test('rejects out-of-charset ids (traversal, dots, spaces) with 400', () => {
  assert.equal(authorizeUpgrade('/..%2f..%2fetc?t=sk_good&w=demo', ok).code, 400);
  assert.equal(authorizeUpgrade('/a.b?t=sk_good&w=demo', ok).code, 400);
  assert.equal(authorizeUpgrade('/abc?t=sk_good&w=de%20mo', ok).code, 400);
  assert.equal(authorizeUpgrade('/abc?t=sk_good', ok).code, 400); // missing workspace
});

test('rejects a malformed URL with 400', () => {
  assert.equal(authorizeUpgrade(undefined, ok).code, 400);
});
