// server/test/blobRoutes.test.js
// The five blob routes (spec §6.3), over real HTTP against a real `BlobStore`.
//
// The router is mounted on its own `http.createServer` here rather than on the
// spawned server process: no process is spawned, so this stays in the default
// `npm test` glob, and the limits can be set to numbers a test can actually
// reach. The real process is exercised by the end-to-end suite
// (`server/test/harness/blobs.mjs`), which covers the wiring, the resume across a
// restart and the relay-under-load case.
//
// The status codes are the subject. The client branches on all of them and they
// mean genuinely different things — 413 too large, 507 quota exhausted, 422
// digest mismatch, 404 not stored, 503 busy, everything else transport — and only
// 404 is a statement about the bytes. Collapsing any two of them is how "the
// network was down" becomes "the file was deleted".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobStore } from '../blobStore.js';
import { createBlobRoutes } from '../blobRoutes.js';

const KEY = 'sk_0123456789abcdef0123456789abcdef';
const WS = 'ws1';
const ABSENT = 'f'.repeat(64);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function bytes(n, seed = 7) {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

/** One HTTP round trip. `key: null` sends no Authorization header at all. */
function call(port, { method = 'GET', path, headers = {}, body, key = KEY }) {
  return new Promise((resolve, reject) => {
    const merged = { ...headers };
    if (key !== null) merged.authorization = `Bearer ${key}`;
    if (body !== undefined) merged['content-length'] = String(body.length);

    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: merged, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A PATCH that trickles its body, so the transfer is still in flight when the
 *  next request arrives. Resolves with the response; `finish()` completes it. */
function slowPatch(port, path, total) {
  const buf = bytes(total, 3);
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const req = httpRequest({
    host: '127.0.0.1',
    port,
    path,
    method: 'PATCH',
    agent: false,
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-range': `bytes 0-${total - 1}/${total}`,
      'content-length': String(total),
    },
  }, (res) => {
    res.resume();
    res.on('end', () => resolveDone(res.statusCode));
  });
  req.on('error', () => resolveDone(0));
  req.write(buf.subarray(0, 1));                     // in flight, but not finished
  return {
    done,
    finish() { req.end(buf.subarray(1)); },
    abort() { req.destroy(); resolveDone(0); },
  };
}

async function withRoutes(options, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-blobroutes-'));
  const store = new BlobStore(dir, options.store ?? {});
  await store.start();
  const routes = createBlobRoutes({
    store,
    isValidKey: (candidate) => candidate === KEY,
    ...(options.routes ?? {}),
  });
  const server = createServer((req, res) => {
    if (!routes.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn({ port, store, dir, routes });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handles */ }
  }
}

/** Upload `buf` in `chunkSize` pieces, exactly as the client will. */
async function put(port, ws, hash, buf, chunkSize = buf.length) {
  let offset = 0;
  let last = null;
  while (offset < buf.length) {
    const end = Math.min(offset + chunkSize, buf.length);
    last = await call(port, {
      method: 'PATCH',
      path: `/blob/${ws}/${hash}`,
      headers: { 'content-range': `bytes ${offset}-${end - 1}/${buf.length}` },
      body: buf.subarray(offset, end),
    });
    if (last.status >= 400) return last;
    offset = end;
  }
  return last;
}

// ------------------------------------------------------------------- auth (C4)

test('every route refuses a missing, malformed or wrong bearer token with 401', async () => {
  await withRoutes({}, async ({ port }) => {
    const buf = bytes(64);
    const hash = sha256(buf);
    const cases = [
      { method: 'HEAD', path: `/blob/${WS}/${hash}` },
      { method: 'HEAD', path: `/blob/${WS}/${hash}?partial=1` },
      { method: 'GET', path: `/blob/${WS}/${hash}` },
      { method: 'GET', path: `/blob/${WS}/limits` },
      {
        method: 'PATCH',
        path: `/blob/${WS}/${hash}`,
        headers: { 'content-range': `bytes 0-63/64` },
        body: buf,
      },
    ];
    for (const base of cases) {
      for (const key of [null, '', 'sk_wrong', KEY.slice(0, -1)]) {
        const res = await call(port, { ...base, key });
        assert.equal(res.status, 401, `${base.method} ${base.path} with key ${key}`);
      }
    }
  });
});

test('an unauthenticated PATCH stores nothing at all', async () => {
  await withRoutes({}, async ({ port, store }) => {
    const buf = bytes(2048);
    const hash = sha256(buf);
    const res = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes 0-2047/2048` },
      body: buf,
      key: 'sk_wrong',
    });
    assert.equal(res.status, 401);
    assert.equal(await store.stat(WS, hash), null);
    assert.equal(await store.received(WS, hash), 0, 'not even a partial');
  });
});

test('auth is decided before the route is, and before the body is touched', async () => {
  await withRoutes({}, async ({ port, routes }) => {
    // Ordering, over the wire: a request that is BOTH unauthenticated and
    // malformed must answer 401. A 400 here would mean the router had already
    // begun parsing on behalf of an unauthenticated peer.
    const both = await call(port, {
      method: 'PATCH',
      path: `/blob/has%20space/${'A'.repeat(64)}`,
      headers: { 'content-range': 'bytes 0-9/10' },
      body: bytes(10),
      key: 'sk_wrong',
    });
    assert.equal(both.status, 401);

    // And the body itself: this request throws from its iterator, so a router
    // that reads so much as one chunk before deciding fails here rather than in
    // production, where it would mean buffering an unauthenticated 100 MB upload.
    const hostile = {
      url: `/blob/${WS}/${'a'.repeat(64)}`,
      method: 'PATCH',
      headers: { authorization: 'Bearer sk_wrong', 'content-range': 'bytes 0-9/10', 'content-length': '10' },
      socket: { id: 'hostile' },
      on() { throw new Error('the body was subscribed to before auth decided'); },
      [Symbol.asyncIterator]() { throw new Error('the body was read before auth decided'); },
    };
    const res = fakeResponse();
    assert.equal(routes.handle(hostile, res), true);
    assert.equal(res.code, 401);
    assert.equal(res.headers.connection, 'close', 'an unauthenticated peer does not keep the socket');
  });
});

test('a bad workspace or hash charset is 400, and never reaches the filesystem', async () => {
  await withRoutes({}, async ({ port }) => {
    const bad = [
      `/blob/${'w'.repeat(65)}/${'a'.repeat(64)}`,
      `/blob/has%20space/${'a'.repeat(64)}`,
      `/blob/.git/${'a'.repeat(64)}`,
      `/blob/${WS}/${'A'.repeat(64)}`,          // uppercase hex is not the canonical form
      `/blob/${WS}/${'a'.repeat(63)}`,
      `/blob/${WS}/${'a'.repeat(65)}`,
      `/blob/${WS}/not-a-hash`,
      `/blob/${WS}/${'a'.repeat(63)}%2f`,
    ];
    for (const path of bad) {
      const res = await call(port, { method: 'HEAD', path });
      assert.equal(res.status, 400, `${path} must be 400`);
    }
  });
});

test('a path shape that is not a blob route is 404, not a crash', async () => {
  await withRoutes({}, async ({ port }) => {
    const shapes = [
      '/blob',
      '/blob/',
      `/blob/${WS}`,
      `/blob/${WS}/${'a'.repeat(64)}/extra`,
      // Resolves OUT of the blob namespace, so it is not a blob route at all and
      // never becomes a path component. Traversal is refused by normalization, not
      // by a filter that has to anticipate every spelling of "..".
      `/blob/../${'a'.repeat(64)}`,
      '/blob/../../etc/passwd',
      `/blob/%2e%2e/${'a'.repeat(64)}`,          // the encoded spelling resolves too
      `/blob/${WS}/%2e%2e`,
    ];
    for (const path of shapes) {
      const res = await call(port, { method: 'GET', path });
      assert.equal(res.status, 404, `${path} answered ${res.status}`);
    }
  });
});

// ------------------------------------------------------------- round trip (C1)

test('PATCH, HEAD and GET round-trip an object byte-identically', async () => {
  await withRoutes({}, async ({ port }) => {
    const buf = bytes(300_000);
    const hash = sha256(buf);

    const missing = await call(port, { method: 'HEAD', path: `/blob/${WS}/${hash}` });
    assert.equal(missing.status, 404, 'absent before the upload');

    const done = await put(port, WS, hash, buf, 64 * 1024);
    assert.equal(done.status, 201);
    assert.equal(done.headers['x-shadowlink-received'], String(buf.length));
    assert.equal(done.headers.etag, `"${hash}"`);

    const head = await call(port, { method: 'HEAD', path: `/blob/${WS}/${hash}` });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(buf.length));
    assert.equal(head.headers.etag, `"${hash}"`);
    assert.equal(head.headers['accept-ranges'], 'bytes');
    // The dedup probe and the `proven` confirmation before a deletion. A stale
    // yes there is a lost file, so it is never answered from a cache.
    assert.match(head.headers['cache-control'], /no-store/);

    const got = await call(port, { method: 'GET', path: `/blob/${WS}/${hash}` });
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, buf);
    assert.equal(sha256(got.body), hash);
    assert.equal(got.headers.etag, `"${hash}"`);
    assert.match(got.headers['cache-control'], /immutable/);
  });
});

test('GET honours Range, and refuses an unsatisfiable one with 416', async () => {
  await withRoutes({}, async ({ port }) => {
    const buf = bytes(5000);
    const hash = sha256(buf);
    await put(port, WS, hash, buf);

    const middle = await call(port, {
      method: 'GET', path: `/blob/${WS}/${hash}`, headers: { range: 'bytes=1000-1999' },
    });
    assert.equal(middle.status, 206);
    assert.equal(middle.headers['content-range'], `bytes 1000-1999/5000`);
    assert.deepEqual(middle.body, buf.subarray(1000, 2000));

    const tail = await call(port, {
      method: 'GET', path: `/blob/${WS}/${hash}`, headers: { range: 'bytes=4000-' },
    });
    assert.equal(tail.status, 206);
    assert.deepEqual(tail.body, buf.subarray(4000));

    const suffix = await call(port, {
      method: 'GET', path: `/blob/${WS}/${hash}`, headers: { range: 'bytes=-100' },
    });
    assert.equal(suffix.status, 206);
    assert.deepEqual(suffix.body, buf.subarray(4900));

    for (const range of ['bytes=5000-', 'bytes=9000-9100', 'bytes=-', 'chunks=0-10']) {
      const bad = await call(port, {
        method: 'GET', path: `/blob/${WS}/${hash}`, headers: { range },
      });
      assert.equal(bad.status, 416, `"${range}" must be unsatisfiable`);
      assert.equal(bad.headers['content-range'], 'bytes */5000');
    }
  });
});

test('404 is the only answer that is about the bytes, and it is never a delete', async () => {
  await withRoutes({}, async ({ port, store }) => {
    const head = await call(port, { method: 'HEAD', path: `/blob/${WS}/${ABSENT}` });
    assert.equal(head.status, 404);
    const got = await call(port, { method: 'GET', path: `/blob/${WS}/${ABSENT}` });
    assert.equal(got.status, 404);

    // …and nothing about asking removes anything: there is no route that can.
    const buf = bytes(128);
    const hash = sha256(buf);
    await put(port, WS, hash, buf);
    for (const method of ['DELETE', 'PUT', 'POST', 'OPTIONS']) {
      const res = await call(port, { method, path: `/blob/${WS}/${hash}` });
      assert.equal(res.status, 405, `${method} must not be a route`);
    }
    assert.notEqual(await store.stat(WS, hash), null, 'the object is still there');
  });
});

// -------------------------------------------------------------- resume (C2)

test('HEAD ?partial=1 reports the resume offset, and PATCH continues from it', async () => {
  await withRoutes({}, async ({ port }) => {
    const buf = bytes(20_000);
    const hash = sha256(buf);

    const cold = await call(port, { method: 'HEAD', path: `/blob/${WS}/${hash}?partial=1` });
    assert.equal(cold.status, 204);
    assert.equal(cold.headers['x-shadowlink-received'], '0');

    const first = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes 0-7999/20000` },
      body: buf.subarray(0, 8000),
    });
    assert.equal(first.status, 204);
    assert.equal(first.headers['x-shadowlink-received'], '8000');

    const resumed = await call(port, { method: 'HEAD', path: `/blob/${WS}/${hash}?partial=1` });
    assert.equal(resumed.headers['x-shadowlink-received'], '8000');

    const rest = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes 8000-19999/20000` },
      body: buf.subarray(8000),
    });
    assert.equal(rest.status, 201);

    const got = await call(port, { method: 'GET', path: `/blob/${WS}/${hash}` });
    assert.deepEqual(got.body, buf);
  });
});

test('a PATCH at the wrong offset is 409 and carries the true offset back', async () => {
  await withRoutes({}, async ({ port }) => {
    const buf = bytes(10_000);
    const hash = sha256(buf);
    await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes 0-3999/10000` },
      body: buf.subarray(0, 4000),
    });

    const wrong = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes 6000-6999/10000` },
      body: buf.subarray(6000, 7000),
    });
    assert.equal(wrong.status, 409);
    assert.equal(
      wrong.headers['x-shadowlink-received'], '4000',
      'the client must be able to re-seek rather than corrupt',
    );

    // Re-seeking from the reported offset produces the correct object, which is
    // the proof the refused chunk changed nothing.
    const rest = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes 4000-9999/10000` },
      body: buf.subarray(4000),
    });
    assert.equal(rest.status, 201);
    const got = await call(port, { method: 'GET', path: `/blob/${WS}/${hash}` });
    assert.equal(sha256(got.body), hash);
  });
});

test('a self-contradictory content-range or content-length is 400', async () => {
  await withRoutes({}, async ({ port }) => {
    const buf = bytes(1000);
    const hash = sha256(buf);
    const bad = [
      {},                                                       // no content-range at all
      { 'content-range': 'bytes 0-999' },
      { 'content-range': 'items 0-999/1000' },
      { 'content-range': 'bytes 999-0/1000' },
      { 'content-range': 'bytes 0-1000/1000' },                 // end past the total
      { 'content-range': 'bytes 0-499/1000' },                  // disagrees with content-length
    ];
    for (const headers of bad) {
      const res = await call(port, {
        method: 'PATCH', path: `/blob/${WS}/${hash}`, headers, body: buf,
      });
      assert.equal(res.status, 400, `${JSON.stringify(headers)} must be refused`);
    }

    // The two framings are checked BEFORE the body is written, so a request that
    // contradicts itself leaves the partial untouched rather than appending
    // whatever arrived and calling the difference the client's problem.
    const short = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes 0-999/1000` },
      body: buf.subarray(0, 500),                    // content-length says 500
    });
    assert.equal(short.status, 400);
    const probe = await call(port, { method: 'HEAD', path: `/blob/${WS}/${hash}?partial=1` });
    assert.equal(probe.headers['x-shadowlink-received'], '0', 'nothing was written');
  });
});

// ------------------------------------------------------------ verification (C3)

test('bytes that do not hash to the URL sha are 422 and leave nothing behind', async () => {
  await withRoutes({}, async ({ port, store }) => {
    const real = bytes(9000);
    const lie = sha256(bytes(9000, 42));

    const first = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${lie}`,
      headers: { 'content-range': `bytes 0-4499/9000` },
      body: real.subarray(0, 4500),
    });
    assert.equal(first.status, 204, 'the server cannot know yet');

    const last = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${lie}`,
      headers: { 'content-range': `bytes 4500-8999/9000` },
      body: real.subarray(4500),
    });
    assert.equal(last.status, 422);

    assert.equal(
      (await call(port, { method: 'HEAD', path: `/blob/${WS}/${lie}` })).status, 404,
      'nothing in the final store',
    );
    assert.equal(
      (await call(port, { method: 'HEAD', path: `/blob/${WS}/${lie}?partial=1` }))
        .headers['x-shadowlink-received'], '0',
      'and no partial left counting against the quota',
    );
    assert.equal(store.usage(WS).files, 0);
  });
});

// -------------------------------------------------------------- limits (C5)

test('an object over the per-file cap is 413 and never lands', async () => {
  await withRoutes({ store: { maxFileBytes: 4096 } }, async ({ port, store }) => {
    const buf = bytes(10_000);
    const hash = sha256(buf);
    const res = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes 0-9999/10000` },
      body: buf,
    });
    assert.equal(res.status, 413);
    assert.equal(await store.stat(WS, hash), null);
    assert.equal(await store.received(WS, hash), 0);
  });
});

test('an upload over the total quota is 507, counting what sits in incoming/', async () => {
  await withRoutes({ store: { maxTotalBytes: 10_000 } }, async ({ port, store }) => {
    const stored = bytes(6000);
    assert.equal((await put(port, WS, sha256(stored), stored)).status, 201);

    const partial = bytes(6000, 11);
    const partialHash = sha256(partial);
    const started = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${partialHash}`,
      headers: { 'content-range': `bytes 0-2999/6000` },
      body: partial.subarray(0, 3000),
    });
    assert.equal(started.status, 204);

    const next = bytes(2000, 13);
    const nextHash = sha256(next);
    const refused = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${nextHash}`,
      headers: { 'content-range': `bytes 0-1999/2000` },
      body: next,
    });
    assert.equal(refused.status, 507, '6000 stored + 3000 incoming + 2000 asked > 10000');
    assert.equal(await store.stat(WS, nextHash), null);
  });
});

test('GET limits reports the ceilings the client re-fetches after a 413 or 507', async () => {
  await withRoutes({ store: { maxFileBytes: 4096, maxTotalBytes: 10_000 } }, async ({ port }) => {
    const before = await call(port, { method: 'GET', path: `/blob/${WS}/limits` });
    assert.equal(before.status, 200);
    assert.deepEqual(JSON.parse(before.body.toString()), { maxFileBytes: 4096, freeBytes: 10_000 });

    const buf = bytes(1000);
    await put(port, WS, sha256(buf), buf);

    const after = await call(port, { method: 'GET', path: `/blob/${WS}/limits` });
    assert.deepEqual(JSON.parse(after.body.toString()), { maxFileBytes: 4096, freeBytes: 9000 });
  });

  await withRoutes({ store: { maxFileBytes: 99, maxTotalBytes: 0 } }, async ({ port }) => {
    const res = await call(port, { method: 'GET', path: `/blob/${WS}/limits` });
    assert.deepEqual(JSON.parse(res.body.toString()), { maxFileBytes: 99, freeBytes: null });
  });
});

// ----------------------------------------------------------------- dedup

test('a PATCH for a hash the workspace already holds is short-circuited', async () => {
  await withRoutes({}, async ({ port, store }) => {
    const buf = bytes(4000);
    const hash = sha256(buf);
    assert.equal((await put(port, WS, hash, buf)).status, 201);

    const again = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes 0-3999/4000` },
      body: buf,
    });
    assert.equal(again.status, 200, 'already stored, not created');
    await store.settled();
    assert.deepEqual(store.usage(WS), { bytes: 4000, files: 1 });
  });
});

test('the same hash in another workspace is a separate object', async () => {
  // Not a leak of an existence oracle: under one shared SERVER_KEY a
  // cross-workspace store would let any key holder use HEAD to prove a specific
  // file exists in a workspace they cannot otherwise read.
  await withRoutes({}, async ({ port }) => {
    const buf = bytes(700);
    const hash = sha256(buf);
    await put(port, WS, hash, buf);

    const elsewhere = await call(port, { method: 'HEAD', path: `/blob/ws2/${hash}` });
    assert.equal(elsewhere.status, 404);
  });
});

// ------------------------------------------------------------ concurrency (C10)

test('transfers over the workspace cap are 503 with a Retry-After', async () => {
  await withRoutes({ routes: { maxConcurrency: 3, retryAfterSeconds: 4 } }, async ({ port }) => {
    const inFlight = [];
    for (let i = 0; i < 3; i++) {
      inFlight.push(slowPatch(port, `/blob/${WS}/${sha256(bytes(4000, i + 1))}`, 4000));
    }
    // Give the three transfers time to be accepted and parked on their bodies.
    await new Promise((r) => { setTimeout(r, 150); });

    const overflow = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${sha256(bytes(100, 99))}`,
      headers: { 'content-range': 'bytes 0-99/100' },
      body: bytes(100, 99),
    });
    assert.equal(overflow.status, 503);
    assert.equal(overflow.headers['retry-after'], '4');

    for (const transfer of inFlight) transfer.finish();
    await Promise.all(inFlight.map((t) => t.done));

    // …and the slot is released, so the next transfer is accepted.
    const after = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${sha256(bytes(100, 99))}`,
      headers: { 'content-range': 'bytes 0-99/100' },
      body: bytes(100, 99),
    });
    assert.equal(after.status, 201);
  });
});

test('another workspace is unaffected by a saturated one', async () => {
  await withRoutes({ routes: { maxConcurrency: 2 } }, async ({ port }) => {
    const inFlight = [
      slowPatch(port, `/blob/${WS}/${sha256(bytes(4000, 1))}`, 4000),
      slowPatch(port, `/blob/${WS}/${sha256(bytes(4000, 2))}`, 4000),
    ];
    await new Promise((r) => { setTimeout(r, 150); });

    const buf = bytes(500, 5);
    const other = await call(port, {
      method: 'PATCH',
      path: `/blob/ws2/${sha256(buf)}`,
      headers: { 'content-range': `bytes 0-499/500` },
      body: buf,
    });
    assert.equal(other.status, 201, 'the cap is per workspace');

    for (const transfer of inFlight) transfer.finish();
    await Promise.all(inFlight.map((t) => t.done));
  });
});

test('one connection cannot take more than its share of the workspace', async () => {
  // HTTP/1.1 will not pipeline two concurrent requests down one socket, so this
  // drives the dispatcher directly with two requests that share a socket object —
  // which is exactly what the per-connection counter is keyed on.
  await withRoutes({ routes: { maxConcurrency: 6, maxPerConnection: 1 } }, async ({ routes }) => {
    const socket = { id: 'one-connection' };
    const buf = bytes(600);
    const hash = sha256(buf);

    let unblock;
    const blocked = new Promise((resolve) => { unblock = resolve; });
    const parked = {
      url: `/blob/${WS}/${hash}`,
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-range': `bytes 0-599/600`,
        'content-length': '600',
      },
      socket,
      async *[Symbol.asyncIterator]() {
        yield buf.subarray(0, 100);
        await blocked;
        yield buf.subarray(100);
      },
    };
    const parkedRes = fakeResponse();
    assert.equal(routes.handle(parked, parkedRes), true);
    await new Promise((r) => { setTimeout(r, 50); });

    const second = {
      url: `/blob/${WS}/${sha256(bytes(600, 2))}`,
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-range': `bytes 0-599/600`,
        'content-length': '600',
      },
      socket,
      async *[Symbol.asyncIterator]() { yield bytes(600, 2); },
    };
    const secondRes = fakeResponse();
    routes.handle(second, secondRes);
    await new Promise((r) => { setTimeout(r, 50); });

    assert.equal(secondRes.code, 503, 'the second transfer on the same socket is refused');
    assert.equal(secondRes.headers['retry-after'], '2');

    unblock();
    await new Promise((r) => { setTimeout(r, 50); });
    assert.equal(parkedRes.code, 201, 'and the first one still completes');
  });
});

test('a GET aborted while the store is being consulted releases its slot', async () => {
  // The cap counts CONCURRENT transfers (spec §6.4). A slot taken and never given
  // back turns it into a count of HISTORY instead, and once a workspace has
  // accumulated `maxConcurrency` of them every later GET and PATCH in that share
  // answers 503 until the process is restarted. Nothing clears it — while HEAD,
  // which never acquires, keeps cheerfully reporting the bytes are present.
  await withRoutes({ routes: { maxConcurrency: 1 } }, async ({ port, store }) => {
    const buf = bytes(600);
    const hash = sha256(buf);
    assert.equal((await put(port, WS, hash, buf)).status, 201);

    // Park `stat`, which is the one window `getBlob` has: after the request has
    // been dispatched and before `acquire()` hands out a slot. `res` emits its
    // one and only 'close' in there, while the listeners that would release the
    // slot do not exist yet — and an EventEmitter does not replay a fired event
    // for a listener that arrives late. Gating rather than racing `fs.stat`
    // makes the window infinite, so this is deterministic rather than timing.
    const realStat = store.stat.bind(store);
    let open;
    const gate = new Promise((r) => { open = r; });
    let parked;
    const reached = new Promise((r) => { parked = r; });
    store.stat = async (ws, sha) => { parked(); await gate; return realStat(ws, sha); };

    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: `/blob/${WS}/${hash}`,
      method: 'GET',
      agent: false,
      headers: { authorization: `Bearer ${KEY}` },
    });
    req.on('error', () => { /* the abort below is the point of the test */ });
    req.end();
    await reached;                                     // the handler is inside the window
    req.destroy();                                     // the lid closing, mid-download
    await new Promise((r) => { setTimeout(r, 100); }); // …and the server noticing
    open();
    store.stat = realStat;
    await new Promise((r) => { setTimeout(r, 100); });

    const after = await call(port, { path: `/blob/${WS}/${hash}` });
    assert.equal(after.status, 200, 'the aborted GET must not have kept its concurrency slot');
  });
});

test('GETs pipelined onto a socket that dies take no slot with them', async () => {
  // The same leak, one step further out. For a PIPELINED second response Node
  // never marks `res` destroyed and never fires 'close' on it at all, so the
  // response object alone cannot tell you the peer is gone — only the socket
  // can. Two GETs written in one packet and then a reset therefore leak a slot
  // apiece unless the guard consults `req.socket` as well.
  await withRoutes({ routes: { maxConcurrency: 1 } }, async ({ port, store }) => {
    const buf = bytes(600);
    const hash = sha256(buf);
    assert.equal((await put(port, WS, hash, buf)).status, 201);

    const realStat = store.stat.bind(store);
    let open;
    const gate = new Promise((r) => { open = r; });
    let reaches = 0;
    let bothIn;
    const both = new Promise((r) => { bothIn = r; });
    store.stat = async (ws, sha) => {
      reaches += 1;
      if (reaches >= 2) bothIn();
      await gate;
      return realStat(ws, sha);
    };

    const raw = `GET /blob/${WS}/${hash} HTTP/1.1\r\nHost: x\r\n`
      + `Authorization: Bearer ${KEY}\r\n\r\n`;
    const socket = netConnect(port, '127.0.0.1', () => { socket.write(raw + raw); });
    socket.on('error', () => { /* expected: we destroy it below */ });

    await both;                                        // both are parked in the window
    socket.destroy();
    await new Promise((r) => { setTimeout(r, 100); });
    open();
    store.stat = realStat;
    await new Promise((r) => { setTimeout(r, 100); });

    const after = await call(port, { path: `/blob/${WS}/${hash}` });
    assert.equal(after.status, 200, 'neither pipelined GET may keep a concurrency slot');
  });
});

test('an aborted PATCH releases its slot, because its finally covers the whole body', async () => {
  // The asymmetry between the two transfer paths, pinned. `patchBlob` awaits the
  // body inside `try { … } finally { release(); }`, so every exit releases;
  // `getBlob` hands the response to `stream.pipe` and outlives its own function
  // call, so no `finally` can guard it and the check has to be explicit. This
  // test passes before and after that fix — it is here so that deleting PATCH's
  // `finally`, or "unifying" the two paths onto the weaker one, reddens.
  await withRoutes({ routes: { maxConcurrency: 1 } }, async ({ port }) => {
    const transfer = slowPatch(port, `/blob/${WS}/${sha256(bytes(4000, 1))}`, 4000);
    await new Promise((r) => { setTimeout(r, 150); });
    transfer.abort();
    await transfer.done;
    await new Promise((r) => { setTimeout(r, 100); });

    const buf = bytes(500, 5);
    const after = await call(port, {
      method: 'PATCH',
      path: `/blob/${WS}/${sha256(buf)}`,
      headers: { 'content-range': 'bytes 0-499/500' },
      body: buf,
    });
    assert.equal(after.status, 201, 'the aborted upload must not have kept its slot either');
  });
});

function fakeResponse() {
  return {
    code: null,
    headers: null,
    headersSent: false,
    writeHead(code, headers) { this.code = code; this.headers = headers ?? {}; this.headersSent = true; },
    end() { this.ended = true; },
    destroy() { this.destroyed = true; },
    on() {},
  };
}
