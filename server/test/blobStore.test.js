// server/test/blobStore.test.js
// The content-addressed store (spec §6.4, §6.5).
//
// The store is where "these bytes exist and they are the bytes the tree names"
// is decided, so the cases below are weighted towards the failures that would be
// silent: a digest that is never rechecked, a partial that nobody counts, a
// usage total that drifts, a rename that fails on Windows and is never retried.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobStore, renameWithRetry } from '../blobStore.js';

const WS = 'ws1';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'sl-blobstore-'));
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Deterministic filler, so a failure names the same bytes every run. */
function bytes(n, seed = 7) {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

/** Upload `buf` in `chunkSize` pieces, exactly as the PATCH route does. */
async function upload(store, ws, hash, buf, chunkSize = buf.length || 1) {
  let offset = 0;
  let last = null;
  do {
    const end = Math.min(offset + chunkSize, buf.length);
    const slice = buf.subarray(offset, end);
    last = await store.appendChunk(ws, hash, {
      offset,
      total: buf.length,
      length: slice.length,
      stream: Readable.from([slice]),
    });
    if (!last.ok) return last;
    offset = end;
  } while (offset < buf.length);
  return last;
}

async function withStore(options, fn) {
  const dir = tempDir();
  const store = new BlobStore(dir, options);
  await store.start();
  try {
    return await fn(store, dir);
  } finally {
    store.stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handles */ }
  }
}

// ------------------------------------------------------------ round trip

test('an object round-trips and lands under two levels of fan-out', async () => {
  await withStore({}, async (store, dir) => {
    const buf = bytes(9000);
    const hash = sha256(buf);

    assert.equal(await store.stat(WS, hash), null, 'absent before the upload');

    const result = await upload(store, WS, hash, buf, 4096);
    assert.deepEqual(result, { ok: true, complete: true, received: buf.length, deduped: false });

    const stored = await store.stat(WS, hash);
    assert.equal(stored.bytes, buf.length);

    // Two levels of fan-out, so 100k attachments do not land in one directory.
    const expected = join(dir, 'blobs', WS, hash.slice(0, 2), hash.slice(2, 4), hash);
    assert.equal(stored.path, expected);
    assert.ok(existsSync(expected), 'the object is at the fanned-out path');
    assert.deepEqual(readFileSync(expected), buf, 'byte-identical');

    assert.deepEqual(store.usage(WS), { bytes: buf.length, files: 1 });
    assert.equal(existsSync(join(dir, 'blobs', WS, 'incoming', `${hash}.part`)), false);
  });
});

test('the store is per-workspace: the same hash in another workspace is absent', async () => {
  // Bytes are deliberately NOT shared across workspaces even though the hash is
  // global. Under one shared SERVER_KEY a cross-workspace store would let any key
  // holder use HEAD to prove a specific file exists in a workspace they cannot
  // read. Duplicating the bytes is the cheaper price.
  await withStore({}, async (store) => {
    const buf = bytes(512);
    const hash = sha256(buf);
    await upload(store, WS, hash, buf);

    assert.notEqual(await store.stat(WS, hash), null);
    assert.equal(await store.stat('ws2', hash), null);
    assert.deepEqual(store.usage('ws2'), { bytes: 0, files: 0 });
  });
});

// ------------------------------------------------------------ verification

test('bytes that do not hash to the URL sha are refused with 422 and leave nothing', async () => {
  await withStore({}, async (store, dir) => {
    const real = bytes(3000);
    const lie = sha256(bytes(3000, 99));            // a valid-looking hash of other bytes

    const result = await store.appendChunk(WS, lie, {
      offset: 0,
      total: real.length,
      length: real.length,
      stream: Readable.from([real]),
    });

    assert.deepEqual(result, { ok: false, code: 422 });
    assert.equal(await store.stat(WS, lie), null, 'nothing in the final store');
    assert.equal(await store.stat(WS, sha256(real)), null, 'and not under its true hash either');
    assert.equal(
      existsSync(join(dir, 'blobs', WS, 'incoming', `${lie}.part`)),
      false,
      'the .part is unlinked, not left counting against the quota',
    );
    assert.deepEqual(store.usage(WS), { bytes: 0, files: 0 });
  });
});

test('a mismatch detected only at the last chunk still leaves nothing behind', async () => {
  // The single most important property of the whole store: the server rehashes
  // what it assembled, so a client that lies about its digest — or a chunk that
  // arrived corrupted — cannot get bad bytes into the store under a good name.
  await withStore({}, async (store) => {
    const good = bytes(8192);
    const hash = sha256(good);
    const tampered = Buffer.from(good);
    tampered[8000] ^= 0xff;                          // same length, last chunk

    const first = await store.appendChunk(WS, hash, {
      offset: 0, total: tampered.length, length: 4096, stream: Readable.from([tampered.subarray(0, 4096)]),
    });
    assert.deepEqual(first, { ok: true, complete: false, received: 4096 });

    const second = await store.appendChunk(WS, hash, {
      offset: 4096, total: tampered.length, length: 4096, stream: Readable.from([tampered.subarray(4096)]),
    });
    assert.deepEqual(second, { ok: false, code: 422 });
    assert.equal(await store.stat(WS, hash), null);
    assert.equal(await store.received(WS, hash), 0, 'the partial is gone, not left at 8192');
  });
});

// ------------------------------------------------------------ resumability

test('a partial upload reports its resume offset and continues from it', async () => {
  await withStore({}, async (store) => {
    const buf = bytes(12_000);
    const hash = sha256(buf);

    assert.equal(await store.received(WS, hash), 0, 'nothing sent yet');

    await store.appendChunk(WS, hash, {
      offset: 0, total: buf.length, length: 5000, stream: Readable.from([buf.subarray(0, 5000)]),
    });
    assert.equal(await store.received(WS, hash), 5000);

    // …two hours later, a different process, no server-side session state.
    await store.appendChunk(WS, hash, {
      offset: 5000, total: buf.length, length: 7000, stream: Readable.from([buf.subarray(5000)]),
    });
    assert.equal(await store.received(WS, hash), buf.length);
    assert.deepEqual(readFileSync((await store.stat(WS, hash)).path), buf);
  });
});

test('a chunk at the wrong offset is refused with 409 and does not corrupt the partial', async () => {
  await withStore({}, async (store) => {
    const buf = bytes(10_000);
    const hash = sha256(buf);

    await store.appendChunk(WS, hash, {
      offset: 0, total: buf.length, length: 4000, stream: Readable.from([buf.subarray(0, 4000)]),
    });

    for (const offset of [0, 3999, 4001, 9000]) {
      const result = await store.appendChunk(WS, hash, {
        offset, total: buf.length, length: 100, stream: Readable.from([bytes(100, 3)]),
      });
      assert.deepEqual(
        result,
        { ok: false, code: 409, received: 4000 },
        `offset ${offset} must be refused and report the true offset`,
      );
    }

    assert.equal(await store.received(WS, hash), 4000, 'the partial is untouched');

    // …and the object still completes correctly from the reported offset.
    await store.appendChunk(WS, hash, {
      offset: 4000, total: buf.length, length: 6000, stream: Readable.from([buf.subarray(4000)]),
    });
    assert.deepEqual(readFileSync((await store.stat(WS, hash)).path), buf);
  });
});

test('an interrupted chunk keeps exactly the bytes that arrived', async () => {
  await withStore({}, async (store) => {
    const buf = bytes(6000);
    const hash = sha256(buf);

    const broken = Readable.from((async function* interrupted() {
      yield buf.subarray(0, 2048);
      throw new Error('connection reset');
    })());

    await assert.rejects(
      store.appendChunk(WS, hash, { offset: 0, total: buf.length, length: 6000, stream: broken }),
      /connection reset/,
    );
    assert.equal(await store.received(WS, hash), 2048, 'the arrived prefix is retained for the resume');

    await store.appendChunk(WS, hash, {
      offset: 2048, total: buf.length, length: buf.length - 2048, stream: Readable.from([buf.subarray(2048)]),
    });
    assert.deepEqual(readFileSync((await store.stat(WS, hash)).path), buf);
  });
});

test('a body shorter than the declared chunk length is refused, and the offset stays truthful', async () => {
  await withStore({}, async (store) => {
    const buf = bytes(4000);
    const hash = sha256(buf);

    const result = await store.appendChunk(WS, hash, {
      offset: 0, total: buf.length, length: 4000, stream: Readable.from([buf.subarray(0, 1000)]),
    });
    assert.deepEqual(result, { ok: false, code: 400, received: 1000 });
    assert.equal(await store.received(WS, hash), 1000);
  });
});

// ------------------------------------------------------------ dedup

test('a PATCH for a hash already stored is short-circuited and does not double-count', async () => {
  await withStore({}, async (store) => {
    const buf = bytes(2048);
    const hash = sha256(buf);
    await upload(store, WS, hash, buf);
    assert.deepEqual(store.usage(WS), { bytes: 2048, files: 1 });

    const again = await store.appendChunk(WS, hash, {
      offset: 0, total: buf.length, length: buf.length, stream: Readable.from([buf]),
    });
    assert.deepEqual(again, { ok: true, complete: true, received: buf.length, deduped: true });
    assert.deepEqual(store.usage(WS), { bytes: 2048, files: 1 }, 'identical bytes are stored once');
  });
});

// ------------------------------------------------------------ per-file limit

test('a declared size over the per-file cap is refused with 413 before anything is written', async () => {
  await withStore({ maxFileBytes: 4096 }, async (store, dir) => {
    const buf = bytes(8192);
    const hash = sha256(buf);

    const result = await store.appendChunk(WS, hash, {
      offset: 0, total: buf.length, length: buf.length, stream: Readable.from([buf]),
    });
    assert.deepEqual(result, { ok: false, code: 413 });
    assert.equal(await store.stat(WS, hash), null);
    assert.equal(existsSync(join(dir, 'blobs', WS, 'incoming', `${hash}.part`)), false);
  });
});

test('an existing partial for an object now over the cap is dropped, not left to rot', async () => {
  // The admin lowered MAX_FILE_SIZE_MB between two runs. The partial can never
  // complete, so leaving it would mean bytes counting against the quota until the
  // TTL sweep, for an upload that is refused every time it is retried.
  const dir = tempDir();
  try {
    const first = new BlobStore(dir, { maxFileBytes: 16_384 });
    await first.start();
    const buf = bytes(9000);
    const hash = sha256(buf);
    await first.appendChunk(WS, hash, {
      offset: 0, total: 9000, length: 4000, stream: Readable.from([buf.subarray(0, 4000)]),
    });
    assert.equal(first.incomingBytes(), 4000);
    first.stop();

    const second = new BlobStore(dir, { maxFileBytes: 4096 });
    await second.start();
    assert.equal(second.incomingBytes(), 4000, 'still counted while it exists');
    const result = await second.appendChunk(WS, hash, {
      offset: 4000, total: 9000, length: 5000, stream: Readable.from([buf.subarray(4000)]),
    });
    assert.deepEqual(result, { ok: false, code: 413 });
    assert.equal(existsSync(join(dir, 'blobs', WS, 'incoming', `${hash}.part`)), false);
    assert.equal(second.incomingBytes(), 0);
    assert.equal(await second.stat(WS, hash), null);
    second.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a body longer than the declared chunk writes nothing past the declared range', async () => {
  // The declared range is the bookkeeping the resume offset is built on, so it is
  // the bound that is enforced: writing the excess would corrupt a partial in a
  // way only the final rehash could catch, throwing the whole upload away.
  await withStore({}, async (store) => {
    const buf = bytes(9000);
    const hash = sha256(buf);

    const result = await store.appendChunk(WS, hash, {
      offset: 0, total: buf.length, length: 4000, stream: Readable.from([buf]),
    });

    assert.deepEqual(result, { ok: false, code: 400, received: 4000 });
    assert.equal(await store.received(WS, hash), 4000, 'exactly the declared prefix landed');

    // …and the object still completes from there, so the excess corrupted nothing.
    await store.appendChunk(WS, hash, {
      offset: 4000, total: buf.length, length: 5000, stream: Readable.from([buf.subarray(4000)]),
    });
    assert.deepEqual(readFileSync((await store.stat(WS, hash)).path), buf);
  });
});

test('a chunk whose range runs past the object total is refused', async () => {
  await withStore({}, async (store) => {
    const buf = bytes(1000);
    const hash = sha256(buf);
    const result = await store.appendChunk(WS, hash, {
      offset: 0, total: 1000, length: 2000, stream: Readable.from([buf]),
    });
    assert.deepEqual(result, { ok: false, code: 400, received: 0 });
    assert.equal(await store.received(WS, hash), 0, 'and not a byte was written');
  });
});

// ------------------------------------------------------------ quota

test('over quota is 507, and the partials in incoming/ count towards it', async () => {
  await withStore({ maxTotalBytes: 10_000 }, async (store) => {
    const stored = bytes(6000);
    const storedHash = sha256(stored);
    await upload(store, WS, storedHash, stored);
    assert.equal(store.usage(WS).bytes, 6000);

    // A partial that is invisible to the quota is how the volume fills up while
    // usage.json still reports room, after which DocHub._writeSnapshot starts
    // failing into lastPersistError where nothing surfaces it.
    const partial = bytes(3000, 11);
    const partialHash = sha256(partial);
    await store.appendChunk(WS, partialHash, {
      offset: 0, total: 6000, length: 3000, stream: Readable.from([partial]),
    });
    assert.equal(store.incomingBytes(), 3000);

    const next = bytes(2000, 13);
    const nextHash = sha256(next);
    const result = await store.appendChunk(WS, nextHash, {
      offset: 0, total: next.length, length: next.length, stream: Readable.from([next]),
    });

    // 6000 stored + 3000 incoming + 2000 asked = 11000 > 10000.
    assert.deepEqual(result, { ok: false, code: 507 });
    assert.equal(await store.stat(WS, nextHash), null);
  });
});

test('quota is counted across workspaces, and 0 means unlimited', async () => {
  await withStore({ maxTotalBytes: 5000 }, async (store) => {
    const a = bytes(4000);
    await upload(store, WS, sha256(a), a);
    const b = bytes(4000, 21);
    const refused = await store.appendChunk('ws2', sha256(b), {
      offset: 0, total: b.length, length: b.length, stream: Readable.from([b]),
    });
    assert.deepEqual(refused, { ok: false, code: 507 });
  });

  await withStore({ maxTotalBytes: 0 }, async (store) => {
    const big = bytes(50_000);
    const result = await upload(store, WS, sha256(big), big);
    assert.equal(result.ok, true, '0 still means unlimited');
  });
});

test('limits() reports the per-file cap and the remaining free bytes', async () => {
  await withStore({ maxFileBytes: 1234, maxTotalBytes: 10_000 }, async (store) => {
    assert.deepEqual(store.limits(), { maxFileBytes: 1234, freeBytes: 10_000 });
    const buf = bytes(1000);
    await upload(store, WS, sha256(buf), buf);
    assert.deepEqual(store.limits(), { maxFileBytes: 1234, freeBytes: 9000 });
  });

  await withStore({ maxFileBytes: 99, maxTotalBytes: 0 }, async (store) => {
    assert.deepEqual(store.limits(), { maxFileBytes: 99, freeBytes: null }, 'unlimited is null');
  });
});

// ------------------------------------------------------------ usage accounting

test('concurrent finalisations all land in usage.json — the read-modify-write race', async () => {
  // This is the reason usage.json goes through a per-workspace promise chain. A
  // plain read-modify-write loses the smaller of every concurrent pair, silently
  // and monotonically, without ever producing a torn file the rebuild would notice.
  await withStore({}, async (store, dir) => {
    const objects = [];
    for (let i = 0; i < 12; i++) {
      const buf = bytes(1000 + i, 100 + i);
      objects.push({ buf, hash: sha256(buf) });
    }

    await Promise.all(objects.map(({ buf, hash }) => store.appendChunk(WS, hash, {
      offset: 0, total: buf.length, length: buf.length, stream: Readable.from([buf]),
    })));
    await store.settled();

    const expected = objects.reduce((sum, o) => sum + o.buf.length, 0);
    assert.deepEqual(store.usage(WS), { bytes: expected, files: objects.length });

    const onDisk = JSON.parse(readFileSync(join(dir, 'blobs', WS, 'usage.json'), 'utf8'));
    assert.deepEqual(
      onDisk,
      { bytes: expected, files: objects.length },
      'the persisted total must match, not merely the in-memory one',
    );
  });
});

test('usage survives a restart and is rebuilt by a rescan when the file is lost', async () => {
  const dir = tempDir();
  try {
    const first = new BlobStore(dir, {});
    await first.start();
    const a = bytes(1500);
    const b = bytes(2500, 31);
    await upload(first, WS, sha256(a), a);
    await upload(first, WS, sha256(b), b);
    await first.settled();
    first.stop();

    // Restart: the persisted usage is loaded as it stands.
    const second = new BlobStore(dir, {});
    await second.start();
    assert.deepEqual(second.usage(WS), { bytes: 4000, files: 2 });
    second.stop();

    // Now lose the bookkeeping entirely and prove the scan reconstructs it.
    rmSync(join(dir, 'blobs', WS, 'usage.json'));
    const third = new BlobStore(dir, {});
    await third.start();
    assert.deepEqual(third.usage(WS), { bytes: 4000, files: 2 });
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, 'blobs', WS, 'usage.json'), 'utf8')),
      { bytes: 4000, files: 2 },
      'and writes it back',
    );
    third.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt usage.json is rebuilt from the objects rather than believed', async () => {
  const dir = tempDir();
  try {
    const first = new BlobStore(dir, {});
    await first.start();
    const a = bytes(777);
    await upload(first, WS, sha256(a), a);
    await first.settled();
    first.stop();

    writeFileSync(join(dir, 'blobs', WS, 'usage.json'), '{"bytes":999999,"fi');

    const second = new BlobStore(dir, {});
    await second.start();
    assert.deepEqual(second.usage(WS), { bytes: 777, files: 1 });
    second.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rescan ignores files that are not objects at their fanned-out path', async () => {
  await withStore({}, async (store, dir) => {
    const a = bytes(400);
    const hash = sha256(a);
    await upload(store, WS, hash, a);
    await store.settled();

    const wsDir = join(dir, 'blobs', WS);
    writeFileSync(join(wsDir, 'stray.txt'), 'not an object');
    mkdirSync(join(wsDir, 'zz', 'zz'), { recursive: true });
    writeFileSync(join(wsDir, 'zz', 'zz', 'nonsense'), 'not a hash');
    // A correctly-named object in the WRONG fan-out bucket is not addressable and
    // must not be counted either.
    const other = sha256(bytes(400, 5));
    mkdirSync(join(wsDir, '00', '00'), { recursive: true });
    writeFileSync(join(wsDir, '00', '00', other), bytes(400, 5));

    await store.rescan(WS);
    assert.deepEqual(store.usage(WS), { bytes: 400, files: 1 });
  });
});

/** A tree big enough that its walk is unmistakably still in flight — measured at
 *  ~190ms for 1024 objects, against the few ms a usage delta takes to land. */
function seedObjects(root, perBucket = 4) {
  for (let a = 0; a < 256; a++) {
    const aa = a.toString(16).padStart(2, '0');
    for (let b = 0; b < perBucket; b++) {
      const bb = b.toString(16).padStart(2, '0');
      mkdirSync(join(root, aa, bb), { recursive: true });
      writeFileSync(join(root, aa, bb, aa + bb + '0'.repeat(60)), Buffer.alloc(64));
    }
  }
  return { bytes: 256 * perBucket * 64, files: 256 * perBucket };
}

test('a rescan racing a finalisation must not erase its delta', async () => {
  // `rescan` walks the tree OUTSIDE the per-workspace usage chain and then writes
  // an ABSOLUTE total. An upload that finalises mid-walk is therefore counted by
  // nobody: the walk had already passed its bucket, and the absolute write lands
  // last on the chain and overwrites the delta — in memory and in usage.json,
  // which every later delta then reads back as its base. Boot is safe because
  // `start()` completes before `listen`, but the 6-hour maintenance timer runs
  // while the server is serving uploads.
  await withStore({}, async (store, dir) => {
    const root = join(dir, 'blobs', WS);
    const seeded = seedObjects(root);
    await store.rescan(WS);
    await store.settled();
    assert.deepEqual(store.usage(WS), seeded, 'baseline');

    const walking = store.rescan(WS);   // parked on its first readdir
    await null;
    await store._addUsage(WS, 4096, 1); // a finalisation lands mid-walk
    await walking;
    await store.settled();

    const expected = { bytes: seeded.bytes + 4096, files: seeded.files + 1 };
    assert.deepEqual(store.usage(WS), expected, 'the in-memory total must not lose the delta');
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'usage.json'), 'utf8')),
      expected,
      'and neither must the persisted one',
    );
  });
});

test('a real upload that finalises during a rescan is still counted exactly once', async () => {
  // The same race driven end to end rather than through `_addUsage`, and the
  // reason the guard has to abandon the walk rather than merge with it: whether
  // the walk happened to reach the new object's bucket before or after the
  // rename is a coin toss, so the only safe reading is "this count is stale".
  // Counting it once — never zero times, never twice — is the whole assertion.
  await withStore({}, async (store, dir) => {
    const root = join(dir, 'blobs', WS);
    const seeded = seedObjects(root);
    await store.rescan(WS);
    await store.settled();

    const buf = bytes(4096, 77);
    const hash = sha256(buf);

    const walking = store.rescan(WS);
    await null;
    const result = await upload(store, WS, hash, buf);
    assert.equal(result.ok, true);
    await walking;
    await store.settled();

    const expected = { bytes: seeded.bytes + 4096, files: seeded.files + 1 };
    assert.deepEqual(store.usage(WS), expected);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'usage.json'), 'utf8')),
      expected,
      'and the persisted total agrees',
    );
  });
});

test('a rescan with nothing in flight still repairs a drifted total', async () => {
  // The other half of the guard: abandoning is only acceptable because a QUIET
  // rescan still does its job. This is the repair path for a total that drifted
  // from the objects — the offline sweeper moving bytes to `.attic`, or an
  // operator clearing objects by hand — so a guard that abandoned
  // unconditionally, or one left armed by a delta that has already landed, would
  // be a silent regression here. Note the drift has to be real on disk: `rescan`
  // deliberately skips the write when its walk agrees with the in-memory copy.
  await withStore({}, async (store, dir) => {
    const a = bytes(1500);
    const b = bytes(2500, 31);
    await upload(store, WS, sha256(a), a);
    await upload(store, WS, sha256(b), b);
    await store.settled();
    assert.deepEqual(store.usage(WS), { bytes: 4000, files: 2 });

    rmSync(store.finalPath(WS, sha256(b)));   // the sweeper, or a human with rm
    await store.rescan(WS);
    await store.settled();

    assert.deepEqual(store.usage(WS), { bytes: 1500, files: 1 });
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, 'blobs', WS, 'usage.json'), 'utf8')),
      { bytes: 1500, files: 1 },
      'a quiet rescan must still write the corrected total through',
    );
  });
});

// ------------------------------------------------------------ .part sweep

test('.part files older than the TTL are swept, and stop counting against the quota', async () => {
  const dir = tempDir();
  try {
    const first = new BlobStore(dir, { incompleteUploadTtlHours: 24 });
    await first.start();

    const stale = bytes(3000);
    const staleHash = sha256(stale);
    await first.appendChunk(WS, staleHash, {
      offset: 0, total: 9000, length: 3000, stream: Readable.from([stale]),
    });

    const fresh = bytes(1000, 41);
    const freshHash = sha256(fresh);
    await first.appendChunk(WS, freshHash, {
      offset: 0, total: 5000, length: 1000, stream: Readable.from([fresh]),
    });
    assert.equal(first.incomingBytes(), 4000);
    first.stop();

    // Age the first partial past the TTL.
    const stalePath = join(dir, 'blobs', WS, 'incoming', `${staleHash}.part`);
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(stalePath, old, old);

    const second = new BlobStore(dir, { incompleteUploadTtlHours: 24 });
    await second.start();                                  // sweeps on boot
    assert.equal(existsSync(stalePath), false, 'the stale partial is swept');
    assert.equal(
      existsSync(join(dir, 'blobs', WS, 'incoming', `${freshHash}.part`)),
      true,
      'a partial inside the TTL is a resumable upload, not garbage',
    );
    assert.equal(second.incomingBytes(), 1000, 'and the swept bytes stop counting');
    assert.equal(await second.received(WS, staleHash), 0);
    assert.equal(await second.received(WS, freshHash), 1000);
    second.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sweep can be driven on demand and reports what it removed', async () => {
  await withStore({ incompleteUploadTtlHours: 1 }, async (store, dir) => {
    const buf = bytes(500);
    const hash = sha256(buf);
    await store.appendChunk(WS, hash, {
      offset: 0, total: 9999, length: 500, stream: Readable.from([buf]),
    });
    assert.equal(await store.sweepPartials(), 0, 'nothing is stale yet');

    const path = join(dir, 'blobs', WS, 'incoming', `${hash}.part`);
    const old = new Date(Date.now() - 7200_000);
    utimesSync(path, old, old);

    assert.equal(await store.sweepPartials(), 1);
    assert.equal(existsSync(path), false);
    assert.equal(store.incomingBytes(), 0);
  });
});

// ------------------------------------------------------------ atomic rename

test('renameWithRetry retries the transient Windows failures and then succeeds', async () => {
  // POSIX rename over an existing path cannot fail because somebody is reading the
  // destination; Windows fails with EPERM/EACCES/EBUSY when any other handle is
  // open — an antivirus scanner, a backup agent, a concurrent reader. Here that
  // would corrupt a store rather than a snapshot. This is the same retry DocHub
  // carries, and the same reason: CI on windows-latest caught it.
  const attempts = [];
  let calls = 0;
  const rename = async () => {
    calls += 1;
    attempts.push(calls);
    if (calls < 3) {
      const err = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    }
  };
  await renameWithRetry('a.tmp', 'a', { rename, attempts: 5, delayMs: 1, cleanup: async () => {} });
  assert.equal(calls, 3);
});

test('renameWithRetry gives up on a non-transient error and removes the temp file', async () => {
  let cleaned = 0;
  const rename = async () => {
    const err = new Error('ENOSPC');
    err.code = 'ENOSPC';
    throw err;
  };
  await assert.rejects(
    renameWithRetry('a.tmp', 'a', {
      rename, attempts: 5, delayMs: 1, cleanup: async () => { cleaned += 1; },
    }),
    /ENOSPC/,
  );
  assert.equal(cleaned, 1, 'an incomplete object is never the file to keep');
});

test('a finalisation whose rename never succeeds leaves no half-stored object', async () => {
  await withStore({}, async (store, dir) => {
    const buf = bytes(1024);
    const hash = sha256(buf);
    store._rename = async () => {
      const err = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    };
    store.renameDelayMs = 1;

    // Matched on `code`, not merely "something threw": an unmatched `rejects`
    // is satisfied by any rejection at all, including one raised long before the
    // rename this test is about. `code` rather than the message because it is the
    // field `renameWithRetry` actually branches on for its transient set.
    await assert.rejects(
      store.appendChunk(WS, hash, {
        offset: 0, total: buf.length, length: buf.length, stream: Readable.from([buf]),
      }),
      { code: 'EPERM' },
    );

    assert.equal(await store.stat(WS, hash), null);
    assert.deepEqual(store.usage(WS), { bytes: 0, files: 0 }, 'usage never counted it');
    assert.equal(
      existsSync(join(dir, 'blobs', WS, 'incoming', `${hash}.part`)),
      false,
      'and the partial is cleaned up rather than left to count against the quota',
    );
    assert.equal(store.incomingBytes(), 0);
  });
});

test('a finalisation retries a transient rename failure and still stores the object', async () => {
  // The unit test above proves `renameWithRetry` retries. This proves the
  // FINALISER goes through it — the mutation that hard-codes one attempt there is
  // invisible to every other case in this file, and on Windows it is the
  // difference between a stored object and a lost upload under ordinary
  // antivirus contention.
  await withStore({}, async (store) => {
    const buf = bytes(2048);
    const hash = sha256(buf);
    const real = store._rename.bind(store);
    let attempts = 0;
    store._rename = async (from, to) => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('EPERM: file is open in another process');
        err.code = 'EPERM';
        throw err;
      }
      return real(from, to);
    };
    store.renameDelayMs = 1;

    const result = await upload(store, WS, hash, buf);
    assert.equal(result.complete, true);
    assert.ok(attempts >= 3, `the rename was retried (attempts: ${attempts})`);
    assert.deepEqual(readFileSync((await store.stat(WS, hash)).path), buf);
  });
});

test('usage.json is written atomically, through the same retry', async () => {
  await withStore({}, async (store, dir) => {
    const buf = bytes(640);
    const hash = sha256(buf);
    const real = store._rename.bind(store);
    let usageRenames = 0;
    store._rename = async (from, to) => {
      if (from.endsWith('usage.json.tmp')) {
        usageRenames += 1;
        if (usageRenames === 1) {
          const err = new Error('EBUSY');
          err.code = 'EBUSY';
          throw err;
        }
      }
      return real(from, to);
    };
    store.renameDelayMs = 1;

    await upload(store, WS, hash, buf);
    await store.settled();

    assert.ok(usageRenames >= 2, 'the transient failure was retried, not swallowed');
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, 'blobs', WS, 'usage.json'), 'utf8')),
      { bytes: 640, files: 1 },
    );
    assert.equal(
      existsSync(join(dir, 'blobs', WS, 'usage.json.tmp')),
      false,
      'and no temp file is left beside it',
    );
  });
});

// ------------------------------------------------------------ misc

test('a large object round-trips through many chunks', async () => {
  await withStore({}, async (store) => {
    const buf = randomBytes(1_000_003);
    const hash = sha256(buf);
    const result = await upload(store, WS, hash, buf, 64 * 1024);
    assert.equal(result.complete, true);
    assert.deepEqual(readFileSync((await store.stat(WS, hash)).path), buf);
    assert.deepEqual(store.usage(WS), { bytes: buf.length, files: 1 });
  });
});

test('there is no delete API on the store', () => {
  // The server never removes a blob because a client asked. The only removals are
  // the .part sweep and the offline admin sweeper (P2-f).
  const names = new Set(Object.getOwnPropertyNames(BlobStore.prototype));
  for (const banned of ['delete', 'remove', 'unlink', 'destroy', 'purge']) {
    assert.equal(names.has(banned), false, `BlobStore must not expose ${banned}()`);
  }
});
