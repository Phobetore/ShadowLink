// server/test/httpAuth.test.js
// The bearer check that guards every blob route (spec §6.2).
//
// Two properties are load-bearing and are what most of this file is about:
//
//  * the key travels in a HEADER and nowhere else. `upgradeAuth.js` reads it from
//    the query string because a WebSocket upgrade has no other place to put it and
//    happens once per session; a blob endpoint is hit hundreds of times per
//    session, and a query string lands in access logs, proxy logs and browser
//    history. So `?t=<key>` must NOT authorize, and there is a test that says so.
//  * a failed auth answers before a single byte of body is read. The hostile
//    request below throws from every stream method, so a check that so much as
//    attaches a `data` listener before deciding fails loudly here rather than in
//    production, where it would mean the server had buffered an unauthenticated
//    100 MB upload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeBearer } from '../httpAuth.js';

const KEY = 'sk_0123456789abcdef0123456789abcdef';
const isValidKey = (candidate) => candidate === KEY;

/**
 * An `IncomingMessage` that is only safe to read headers from. Every method that
 * could consume the body throws, so "rejected before the body was read" is proven
 * by the check surviving rather than by a comment claiming it.
 */
function hostileRequest(headers, url = '/blob/ws1/' + 'a'.repeat(64)) {
  const explode = (name) => () => {
    throw new Error(`the body was touched via ${name}() before auth decided`);
  };
  return {
    url,
    method: 'PATCH',
    headers,
    on: explode('on'),
    once: explode('once'),
    addListener: explode('addListener'),
    read: explode('read'),
    resume: explode('resume'),
    pipe: explode('pipe'),
    setEncoding: explode('setEncoding'),
    [Symbol.asyncIterator]: explode('asyncIterator'),
  };
}

test('a correct bearer header authorizes', () => {
  const result = authorizeBearer(hostileRequest({ authorization: `Bearer ${KEY}` }), isValidKey);
  assert.deepEqual(result, { ok: true });
});

test('the bearer scheme is matched case-insensitively (RFC 7235)', () => {
  for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
    const result = authorizeBearer(hostileRequest({ authorization: `${scheme} ${KEY}` }), isValidKey);
    assert.deepEqual(result, { ok: true }, `scheme "${scheme}" must authorize`);
  }
});

test('a missing Authorization header is 401', () => {
  assert.deepEqual(authorizeBearer(hostileRequest({}), isValidKey), { ok: false, code: 401 });
});

test('a wrong key is 401', () => {
  const result = authorizeBearer(hostileRequest({ authorization: 'Bearer sk_nope' }), isValidKey);
  assert.deepEqual(result, { ok: false, code: 401 });
});

test('a malformed header is 401', () => {
  const malformed = [
    KEY,                       // no scheme at all
    `Basic ${KEY}`,            // wrong scheme
    `Token ${KEY}`,
    'Bearer',                  // scheme, no credential
    'Bearer ',
    `Bearer ${KEY} extra`,     // a credential is one token
    `Bearerx ${KEY}`,
    '',
  ];
  for (const authorization of malformed) {
    assert.deepEqual(
      authorizeBearer(hostileRequest({ authorization }), isValidKey),
      { ok: false, code: 401 },
      `"${authorization}" must not authorize`,
    );
  }
});

test('a non-string header value is 401 rather than a crash', () => {
  for (const authorization of [undefined, null, 123, [`Bearer ${KEY}`], {}]) {
    assert.deepEqual(
      authorizeBearer(hostileRequest({ authorization }), isValidKey),
      { ok: false, code: 401 },
    );
  }
});

test('a request with no headers object at all is 401 rather than a crash', () => {
  assert.deepEqual(authorizeBearer({ url: '/blob/w/x' }, isValidKey), { ok: false, code: 401 });
  assert.deepEqual(authorizeBearer(null, isValidKey), { ok: false, code: 401 });
});

test('the key in a query parameter does NOT authorize (§6.2)', () => {
  // The whole reason this is a header: a query string is logged by every proxy in
  // the path, and this endpoint is hit hundreds of times per session.
  const req = hostileRequest({}, `/blob/ws1/${'a'.repeat(64)}?t=${KEY}`);
  assert.deepEqual(authorizeBearer(req, isValidKey), { ok: false, code: 401 });
});

test('the body is never read, on success or on failure', () => {
  // hostileRequest throws from every stream method; reaching the assertions means
  // neither branch touched one.
  assert.doesNotThrow(() => authorizeBearer(hostileRequest({}), isValidKey));
  assert.doesNotThrow(() => authorizeBearer(hostileRequest({ authorization: 'Bearer x' }), isValidKey));
  assert.doesNotThrow(
    () => authorizeBearer(hostileRequest({ authorization: `Bearer ${KEY}` }), isValidKey),
  );
});

test('the validator is called with the credential exactly as sent', () => {
  const seen = [];
  authorizeBearer(hostileRequest({ authorization: `Bearer ${KEY}` }), (k) => {
    seen.push(k);
    return true;
  });
  assert.deepEqual(seen, [KEY]);
});

test('the validator is never called for a header that is not a bearer credential', () => {
  // `Auth.validateServerKey` is a timing-safe compare against the real key. Calling
  // it with junk is not dangerous, but not calling it at all is what keeps the
  // parse and the comparison separable — and what stops a future "empty key means
  // unset means allow" bug from having a route in.
  let calls = 0;
  const count = () => { calls += 1; return true; };
  for (const authorization of ['', 'Bearer', 'Basic abc', 'Bearer  ']) {
    authorizeBearer(hostileRequest({ authorization }), count);
  }
  assert.equal(calls, 0);
});
