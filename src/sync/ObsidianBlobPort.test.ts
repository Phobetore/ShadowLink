// src/sync/ObsidianBlobPort.test.ts
//
// The port that moves attachment bytes, against the REAL server routes and the
// REAL content-addressed store — mounted in this process rather than spawned, so
// the limits can be set to numbers a test can reach and the whole thing still
// runs under plain `npm test`.
//
// Testing this against a mock would be close to pointless. Every interesting
// behaviour here is a negotiation with the other end: a resume offset the server
// reports, a 409 that says "you are not where you think you are", a 422 that only
// the server can discover, a status the client has to tell apart from four others
// that look the same from a distance. A mock would agree with whatever this file
// believes, which is exactly the failure mode `fakes.ts` warns about.
//
// The distinctions being pinned, because collapsing any of them is a data-loss
// bug rather than a cosmetic one:
//
//   has   throws for "I could not ask", and answers false ONLY for a real 404
//   put   false for 413/507/422 (tell the user), throws for transport (retry)
//   get   null for everything, digest-verified BEFORE it returns a single byte

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { BlobStore } from '../../server/blobStore.js';
import { createBlobRoutes } from '../../server/blobRoutes.js';
import {
  BlobBusy,
  BlobDigestMismatch,
  BlobQuotaExceeded,
  BlobTooLarge,
  BlobTransport,
  BlobUnavailable,
} from './BlobPort.ts';
import { ObsidianBlobPort } from './ObsidianBlobPort.ts';

const KEY = 'sk_0123456789abcdef0123456789abcdef';
const WS = 'ws1';
const ABSENT = 'f'.repeat(64);

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

interface Harness {
  port: ObsidianBlobPort;
  store: { finalPath: (ws: string, sha: string) => string;
           partPath: (ws: string, sha: string) => string;
           stat: (ws: string, sha: string) => Promise<{ bytes: number } | null>;
           received: (ws: string, sha: string) => Promise<number>;
           settled: () => Promise<void> };
  /** Every request the port issued, in order. */
  requests: Array<{ method: string; url: string }>;
  url: string;
}

async function withPort(
  options: {
    store?: Record<string, unknown>;
    routes?: Record<string, unknown>;
    chunkBytes?: number;
    serverKey?: string;
  },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sl-blobport-'));
  const store = new BlobStore(dir, options.store ?? {});
  await store.start();
  const routes = createBlobRoutes({
    store,
    isValidKey: (candidate: string) => candidate === KEY,
    ...(options.routes ?? {}),
  });
  const server: Server = createServer((req, res) => {
    if (!routes.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  const listenPort = typeof address === 'object' && address !== null ? address.port : 0;

  const requests: Array<{ method: string; url: string }> = [];
  const port = new ObsidianBlobPort({
    // Deliberately the WEBSOCKET url: the plugin holds one server URL, and the
    // blob routes ride the same host and port. Converting it here is what keeps
    // "one port, one URL, one key" true for a self-hoster.
    serverUrl: `ws://127.0.0.1:${listenPort}/`,
    serverKey: options.serverKey ?? KEY,
    workspaceId: WS,
    chunkBytes: options.chunkBytes,
    fetchImpl: (input, init) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) });
      return fetch(input, init);
    },
  });

  try {
    await fn({ port, store: store as unknown as Harness['store'], requests, url: `http://127.0.0.1:${listenPort}` });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    store.stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handles */ }
  }
}

// ------------------------------------------------------------------ round trip

test('put, has and get round-trip the bytes, and the ws:// URL is understood', async () => {
  await withPort({}, async ({ port, requests }) => {
    const data = bytes(300_000);
    const hash = sha256(data);

    assert.deepEqual(await port.has(hash), { present: false }, 'absent to begin with');
    assert.equal(await port.put(hash, data), true);
    assert.deepEqual(await port.has(hash), { present: true, bytes: data.length });

    const back = await port.get(hash, data.length);
    assert.notEqual(back, null);
    assert.deepEqual(back, data, 'byte-identical');
    assert.equal(sha256(back!), hash);
    assert.equal(port.lastError, null);

    assert.ok(
      requests.every((r) => r.url.startsWith('http://127.0.0.1:')),
      'the websocket scheme was converted, not passed through',
    );
    assert.ok(
      requests.every((r) => !r.url.includes(KEY)),
      'the key never appears in a URL — it is a header, so it stays out of every log',
    );
  });
});

test('a large object is chunked, and progress is reported as it goes', async () => {
  await withPort({ chunkBytes: 32 * 1024 }, async ({ port, requests }) => {
    const data = bytes(200_000, 3);
    const hash = sha256(data);

    const sentTo: number[] = [];
    assert.equal(await port.put(hash, data, (sent, total) => {
      assert.equal(total, data.length);
      sentTo.push(sent);
    }), true);

    const patches = requests.filter((r) => r.method === 'PATCH');
    assert.ok(patches.length >= 6, `expected several chunks, sent ${patches.length}`);
    assert.deepEqual([...sentTo].sort((a, b) => a - b), sentTo, 'progress is monotonic');
    assert.equal(sentTo[sentTo.length - 1], data.length);

    const received: number[] = [];
    const back = await port.get(hash, data.length, undefined, (got) => received.push(got));
    assert.deepEqual(back, data);
    assert.ok(received.length >= 6, `expected a ranged fetch, made ${received.length} steps`);
    assert.equal(received[received.length - 1], data.length);
  });
});

test('a second put of bytes the store already holds sends no chunk at all', async () => {
  await withPort({}, async ({ port, requests }) => {
    const data = bytes(50_000, 5);
    const hash = sha256(data);
    await port.put(hash, data);

    requests.length = 0;
    assert.equal(await port.put(hash, data), true);
    assert.equal(
      requests.filter((r) => r.method === 'PATCH').length, 0,
      'dedup is intrinsic: one HEAD settles it',
    );
  });
});

// --------------------------------------------------------------- verification

test('put recomputes the digest itself and refuses to send bytes under a wrong name', async () => {
  await withPort({}, async ({ port, store, requests }) => {
    const data = bytes(4096, 9);
    const wrongName = sha256(bytes(4096, 10));

    assert.equal(await port.put(wrongName, data), false);
    assert.ok(port.lastError instanceof BlobDigestMismatch, `got ${String(port.lastError)}`);
    assert.equal(requests.length, 0, 'nothing was even asked of the server');
    assert.equal(await store.stat(WS, wrongName), null);
  });
});

test('a 422 from the server is a refusal, not a transport failure', async () => {
  // The client verified its own bytes, so the only way to reach a 422 is for the
  // store to already hold a prefix that is NOT this object's. That is exactly the
  // case both-ends-verify exists for: the client's own check cannot see it.
  await withPort({}, async ({ port, store }) => {
    const data = bytes(8000, 11);
    const hash = sha256(data);

    const part = store.partPath(WS, hash);
    mkdirSync(dirname(part), { recursive: true });
    writeFileSync(part, Buffer.from(bytes(4000, 12)));       // a prefix of something else

    assert.equal(await port.put(hash, data), false);
    assert.ok(port.lastError instanceof BlobDigestMismatch, `got ${String(port.lastError)}`);
    assert.equal(await store.stat(WS, hash), null, 'and nothing landed under that name');
  });
});

test('get verifies the digest before returning, and returns nothing when it fails', async () => {
  await withPort({}, async ({ port, store }) => {
    const data = bytes(20_000, 13);
    const hash = sha256(data);
    await port.put(hash, data);

    // Same LENGTH, different bytes: only a digest check catches this, which is
    // the difference between a broken fetch and a corrupt file in the vault.
    const damaged = data.slice();
    damaged[0] ^= 0xff;
    writeFileSync(store.finalPath(WS, hash), Buffer.from(damaged));

    assert.equal(await port.get(hash, data.length), null);
    assert.ok(port.lastError instanceof BlobDigestMismatch, `got ${String(port.lastError)}`);
  });
});

test('get refuses an object whose stored length is not the length the tree names', async () => {
  await withPort({}, async ({ port }) => {
    const data = bytes(9000, 15);
    const hash = sha256(data);
    await port.put(hash, data);

    assert.equal(await port.get(hash, 9001), null);
    assert.ok(port.lastError instanceof BlobDigestMismatch, `got ${String(port.lastError)}`);
  });
});

// ------------------------------------------------------------------- resume

test('put resumes from the offset the server reports', async () => {
  await withPort({ chunkBytes: 4096 }, async ({ port, store, requests }) => {
    const data = bytes(20_000, 17);
    const hash = sha256(data);

    // A previous session got half way and then the laptop lid closed.
    const part = store.partPath(WS, hash);
    mkdirSync(dirname(part), { recursive: true });
    writeFileSync(part, Buffer.from(data.subarray(0, 12_000)));
    assert.equal(await store.received(WS, hash), 12_000);

    const progress: number[] = [];
    assert.equal(await port.put(hash, data, (sent) => progress.push(sent)), true);
    assert.equal(progress[0], 12_000, 'it started where the server said, not at zero');

    const patched = requests.filter((r) => r.method === 'PATCH').length;
    assert.equal(patched, 2, `8000 bytes in 4096-byte chunks, not the whole object (${patched})`);
    assert.deepEqual(await port.get(hash, data.length), data);
  });
});

test('put re-seeks on a 409 rather than appending over the server\'s bytes', async () => {
  await withPort({ chunkBytes: 4096 }, async ({ port, store }) => {
    const data = bytes(16_000, 19);
    const hash = sha256(data);
    const part = store.partPath(WS, hash);
    mkdirSync(dirname(part), { recursive: true });

    // The port asks for the offset once, at the start. Move the server on behind
    // its back so its first chunk lands at the wrong place and comes back 409.
    let moved = false;
    const original = store.received.bind(store);
    (store as unknown as { received: (ws: string, sha: string) => Promise<number> }).received =
      async (ws: string, sha: string) => {
        const answer = await original(ws, sha);
        if (!moved && sha === hash) {
          moved = true;
          writeFileSync(part, Buffer.from(data.subarray(0, 6000)));
          return 0;                        // the lie the port acts on
        }
        return answer;
      };

    assert.equal(await port.put(hash, data), true);
    assert.deepEqual(await port.get(hash, data.length), data, 'the object still hashes to its name');
  });
});

// ------------------------------------------------------- the distinct statuses

test('413 is a refusal the user is told about, not a retry', async () => {
  await withPort({ store: { maxFileBytes: 4096 } }, async ({ port, store }) => {
    const data = bytes(10_000, 21);
    const hash = sha256(data);

    assert.equal(await port.put(hash, data), false);
    assert.ok(port.lastError instanceof BlobTooLarge, `got ${String(port.lastError)}`);
    assert.equal(await store.stat(WS, hash), null);
  });
});

test('507 is a refusal too, and it is NOT the same as too large', async () => {
  await withPort({ store: { maxTotalBytes: 10_000 } }, async ({ port }) => {
    const first = bytes(8000, 23);
    assert.equal(await port.put(sha256(first), first), true);

    const second = bytes(5000, 25);
    assert.equal(await port.put(sha256(second), second), false);
    assert.ok(port.lastError instanceof BlobQuotaExceeded, `got ${String(port.lastError)}`);
    // Quota exhaustion is a clean degradation: the admin raises the limit and the
    // same publish entry succeeds untouched. Reporting it as "too large" would
    // send the user to shrink a file that was never the problem.
    assert.equal(port.lastError instanceof BlobTooLarge, false);
  });
});

test('503 THROWS, because busy is transport and the publish ladder retries it', async () => {
  await withPort({ routes: { maxConcurrency: 0, retryAfterSeconds: 7 } }, async ({ port }) => {
    const data = bytes(2048, 27);
    const hash = sha256(data);
    await assert.rejects(port.put(hash, data), (err: unknown) => {
      assert.ok(err instanceof BlobBusy, `got ${String(err)}`);
      assert.equal((err as BlobBusy).retryAfterSeconds, 7, 'the interval the server named');
      return true;
    });
    assert.ok(port.lastError instanceof BlobBusy);
  });
});

test('404 on get is the only answer about the bytes, and it is still not a delete', async () => {
  await withPort({}, async ({ port }) => {
    assert.equal(await port.get(ABSENT, 128), null);
    assert.ok(port.lastError instanceof BlobUnavailable, `got ${String(port.lastError)}`);
  });
});

test('has answers false ONLY for a definite 404, and throws for anything else', async () => {
  await withPort({}, async ({ port }) => {
    assert.deepEqual(await port.has(ABSENT), { present: false });
  });

  // A wrong key is 401: "I could not ask". Answering `false` there would mean a
  // deletion pass reading "the server does not have your bytes" from a typo in a
  // setting, and trashing the local copy on the strength of it (I2).
  await withPort({ serverKey: 'sk_wrong' }, async ({ port }) => {
    await assert.rejects(port.has(ABSENT), (err: unknown) => {
      assert.ok(err instanceof BlobTransport, `got ${String(err)}`);
      return true;
    });
  });
});

test('a dead server throws from has and returns null from get — never false, never bytes', async () => {
  const port = new ObsidianBlobPort({
    serverUrl: 'ws://127.0.0.1:9',                 // discard; nothing listens
    serverKey: KEY,
    workspaceId: WS,
  });

  await assert.rejects(port.has(ABSENT), (err: unknown) => {
    assert.ok(err instanceof BlobTransport, `got ${String(err)}`);
    return true;
  });
  await assert.rejects(port.limits());
  assert.equal(await port.get(ABSENT, 10), null, 'get never throws');
  assert.notEqual(port.lastError, null);
});

test('an unauthenticated put throws rather than reporting a refusal', async () => {
  // A refusal means "tell the user their file is too big or the disk is full". A
  // wrong key is neither, and reporting it as one would put a permanent, wrong
  // message in front of the user instead of a retry.
  await withPort({ serverKey: 'sk_wrong' }, async ({ port }) => {
    const data = bytes(1024, 29);
    await assert.rejects(port.put(sha256(data), data), (err: unknown) => {
      assert.ok(err instanceof BlobTransport, `got ${String(err)}`);
      return true;
    });
  });
});

// ------------------------------------------------------------------- limits

test('limits reports the ceilings, and null for an unlimited store', async () => {
  await withPort({ store: { maxFileBytes: 4096, maxTotalBytes: 10_000 } }, async ({ port }) => {
    assert.deepEqual(await port.limits(), { maxFileBytes: 4096, freeBytes: 10_000 });
    const data = bytes(1000, 31);
    await port.put(sha256(data), data);
    assert.deepEqual(await port.limits(), { maxFileBytes: 4096, freeBytes: 9000 });
  });

  await withPort({ store: { maxFileBytes: 99, maxTotalBytes: 0 } }, async ({ port }) => {
    assert.deepEqual(await port.limits(), { maxFileBytes: 99, freeBytes: null });
  });
});

// -------------------------------------------------------------------- abort

test('an aborted get returns null and never a partial object', async () => {
  await withPort({ chunkBytes: 4096 }, async ({ port }) => {
    const data = bytes(60_000, 33);
    const hash = sha256(data);
    await port.put(hash, data);

    const controller = new AbortController();
    const got = await port.get(hash, data.length, controller.signal, (received) => {
      if (received > 0) controller.abort();
    });
    assert.equal(got, null, 'an incomplete fetch is a no-op, never a partial write');
    assert.notEqual(port.lastError, null);

    // …and the object is untouched, so a later attempt still succeeds.
    assert.deepEqual(await port.get(hash, data.length), data);
  });
});

test('the abort is honoured by the port itself, not only by fetch', async () => {
  // `fetch` rejects on an aborted signal, which makes the port's own check look
  // redundant — until the transport is one that has no signal at all. Obsidian's
  // `requestUrl` is exactly that, and it is the documented fallback if a CORS
  // proxy ever forces the switch. The loop must stop on its own.
  const dir = mkdtempSync(join(tmpdir(), 'sl-blobabort-'));
  const store = new BlobStore(dir, {});
  await store.start();
  const routes = createBlobRoutes({ store, isValidKey: (k: string) => k === KEY });
  const server: Server = createServer((req, res) => {
    if (!routes.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  const listenPort = typeof address === 'object' && address !== null ? address.port : 0;

  let calls = 0;
  const deaf = new ObsidianBlobPort({
    serverUrl: `http://127.0.0.1:${listenPort}`,
    serverKey: KEY,
    workspaceId: WS,
    chunkBytes: 4096,
    // A transport that cannot be cancelled: the signal is dropped on the floor.
    fetchImpl: (input, init) => {
      calls += 1;
      const { signal, ...rest } = init ?? {};
      return fetch(input, rest);
    },
  });

  try {
    const data = bytes(60_000, 35);
    const hash = sha256(data);
    assert.equal(await deaf.put(hash, data), true);

    const controller = new AbortController();
    const before = calls;
    const got = await deaf.get(hash, data.length, controller.signal, (received) => {
      if (received > 0) controller.abort();
    });

    assert.equal(got, null, 'an aborted fetch produces nothing at all');
    assert.ok(
      calls - before < Math.ceil(data.length / 4096),
      `the port kept fetching after the abort (${calls - before} requests)`,
    );
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    store.stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handles */ }
  }
});

test('a zero-length object is refused rather than sent', async () => {
  await withPort({}, async ({ port, requests }) => {
    const empty = new Uint8Array(0);
    assert.equal(await port.put(sha256(empty), empty), false);
    assert.ok(port.lastError instanceof BlobDigestMismatch, `got ${String(port.lastError)}`);
    assert.equal(requests.length, 0);
  });
});
