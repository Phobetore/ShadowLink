import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeUpgrade, isValidDocId, isValidWorkspaceId } from '../upgradeAuth.js';

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

// The two ids are now named predicates, because the P3 mux has to ask the same
// questions at frame time rather than at upgrade time. These pin what they mean;
// `mux.test.js` pins that the mux really is asking THESE and not a second copy.

test('isValidDocId is the charset that makes a room name safe as a path segment', () => {
  for (const good of ['_tree', '_mux', 'n_AbCdEfGhIjKlMnOpQrStUv', 'a', 'A-b_C9', 'a'.repeat(300)]) {
    assert.equal(isValidDocId(good), true, `${JSON.stringify(good)} should be a valid docId`);
  }
  for (const bad of [
    '', '..', '../etc', 'a/b', 'a.b', 'a b', 'a\u0000b', 'a\nb', '\u00fcn\u00efcode', 'a'.repeat(301),
    null, undefined, 42, {},
  ]) {
    assert.equal(isValidDocId(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
});

test('isValidWorkspaceId is the same charset, capped at 64', () => {
  assert.equal(isValidWorkspaceId('demo'), true);
  assert.equal(isValidWorkspaceId('a'.repeat(64)), true);
  assert.equal(isValidWorkspaceId('a'.repeat(65)), false);
  assert.equal(isValidWorkspaceId(''), false);
  assert.equal(isValidWorkspaceId('a/b'), false);
  assert.equal(isValidWorkspaceId(undefined), false);
});
