// server/test/sweepBlobs.test.js
// The offline orphan sweeper (spec §6.5, §11 C9).
//
// This is the only code in the project that removes a blob, so almost every test
// below is about a REFUSAL. That is not defensiveness for its own sake: the
// sweeper decides what to delete by reading a tree snapshot, and every way that
// snapshot can be wrong — absent, truncated, empty, or simply older than the
// uploads around it — produces the same wrong answer, "nothing references these
// bytes", about a workspace that references all of them.
//
// The failure it is guarding against is specific and unrecoverable. A blob the
// sweeper removes is a blob some peer's tree still names, and that peer's next
// pass fetches nothing, writes nothing (I2) and reports the node as unavailable.
// A missing file, never a corrupt one, and never a delete — but a missing file is
// still somebody's diagram, so the bar for removing one is a tree that has
// PROVED it is complete and current.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { utimes as utimesAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';

import { sweep } from '../tools/sweep-blobs.mjs';

const WS = 'ws1';
const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'sl-sweep-'));
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Write a `_tree.bin` holding `nodes`, exactly as `DocHub` would have. */
function writeTree(dir, ws, nodes, mtimeMs = NOW) {
  const doc = new Y.Doc();
  const map = doc.getMap('nodes');
  doc.transact(() => {
    for (const [id, fields] of Object.entries(nodes)) {
      const node = new Y.Map();
      for (const [k, v] of Object.entries(fields)) node.set(k, v);
      map.set(id, node);
    }
  });
  const path = join(dir, 'yjs', ws, '_tree.bin');
  mkdirSync(join(dir, 'yjs', ws), { recursive: true });
  writeFileSync(path, Buffer.from(Y.encodeStateAsUpdate(doc)));
  touch(path, mtimeMs);
  return path;
}

/** Put a final object in the store, at its fanned-out address. */
function writeBlob(dir, ws, sha, mtimeMs) {
  const folder = join(dir, 'blobs', ws, sha.slice(0, 2), sha.slice(2, 4));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, sha);
  writeFileSync(path, 'bytes');
  touch(path, mtimeMs);
  return path;
}

function writeAttic(dir, ws, sha, mtimeMs) {
  const folder = join(dir, 'blobs', ws, '.attic');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, sha);
  writeFileSync(path, 'bytes');
  touch(path, mtimeMs);
  return path;
}

/** A content doc's snapshot, beside `_tree.bin` — what a keystroke leaves behind. */
function writeNote(dir, ws, name, mtimeMs) {
  mkdirSync(join(dir, 'yjs', ws), { recursive: true });
  const path = join(dir, 'yjs', ws, name);
  writeFileSync(path, 'x');
  touch(path, mtimeMs);
  return path;
}

function touch(path, mtimeMs) {
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

function atticOf(dir, ws) {
  const folder = join(dir, 'blobs', ws, '.attic');
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

function blobRef(sha, bytes = 10, parent = '-') {
  return `${sha}:${bytes}:${parent}`;
}

/** Run the sweeper against a fresh directory, with a fixed clock. */
function run(dir, options = {}) {
  return sweep({ dataDir: dir, ttlDays: 90, now: () => NOW, ...options });
}

async function withDir(fn) {
  const dir = tempDir();
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the refusals

// ⚠ The default. An admin tool whose first run deletes things is a tool people
// run once, by accident, on the wrong directory.
test('--dry-run is the default: nothing moves unless apply is asked for', async () => {
  await withDir(async (dir) => {
    const orphan = sha256('orphan');
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } });
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    const path = writeBlob(dir, WS, orphan, NOW - 200 * DAY_MS);

    const report = await run(dir);

    assert.equal(report.workspaces[0].attic.length, 1, 'it says what it WOULD move');
    assert.equal(existsSync(path), true, 'and moves nothing');
    assert.deepEqual(atticOf(dir, WS), []);
  });
});

// ⚠ An absent snapshot is the most dangerous input there is: every blob in the
// workspace looks unreferenced, so a sweeper that treated it as "an empty tree"
// would empty the store.
test('a workspace with no tree snapshot is refused whole', async () => {
  await withDir(async (dir) => {
    const sha = sha256('a');
    writeBlob(dir, WS, sha, NOW - 200 * DAY_MS);
    mkdirSync(join(dir, 'yjs', WS), { recursive: true });

    const report = await run(dir, { apply: true });

    assert.equal(report.workspaces[0].refused, 'no tree snapshot');
    assert.deepEqual(report.workspaces[0].attic, []);
    assert.deepEqual(atticOf(dir, WS), []);
  });
});

test('an unparseable tree snapshot is refused whole', async () => {
  await withDir(async (dir) => {
    writeBlob(dir, WS, sha256('a'), NOW - 200 * DAY_MS);
    mkdirSync(join(dir, 'yjs', WS), { recursive: true });
    const path = join(dir, 'yjs', WS, '_tree.bin');
    writeFileSync(path, Buffer.from([0xff, 0x00, 0x13, 0x37]));
    touch(path, NOW);

    const report = await run(dir, { apply: true });

    assert.match(report.workspaces[0].refused, /could not be decoded/);
    assert.deepEqual(atticOf(dir, WS), []);
  });
});

// ⚠ Zero nodes and "every blob is an orphan" are the same sentence. A tree that
// decodes but holds nothing is a snapshot that was truncated, or written before
// the first node, or belongs to a workspace whose id was mistyped.
test('a tree that decodes to zero nodes is refused whole', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, {});
    writeBlob(dir, WS, sha256('a'), NOW - 200 * DAY_MS);

    const report = await run(dir, { apply: true });

    assert.equal(report.workspaces[0].refused, 'the tree snapshot decodes to zero nodes');
    assert.deepEqual(atticOf(dir, WS), []);
  });
});

// ⚠ The staleness guard. A snapshot is written on a 2 s debounce, so one that is
// an hour behind the uploads beside it is not a snapshot of this workspace's
// current state — and every node minted since is invisible to the scan.
test('a tree snapshot older than the blobs beside it is refused', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } },
      NOW - 10 * DAY_MS);
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    writeBlob(dir, WS, sha256('fresh'), NOW - 100);      // uploaded ten days after the snapshot

    const report = await run(dir, { apply: true });

    assert.match(report.workspaces[0].refused, /newer than the tree snapshot/);
    assert.deepEqual(atticOf(dir, WS), []);
  });
});

test('a note snapshot newer than the tree snapshot is refused too', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } },
      NOW - 10 * DAY_MS);
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    writeBlob(dir, WS, sha256('orphan'), NOW - 200 * DAY_MS);
    writeNote(dir, WS, 'n_abc.bin', NOW - 100);

    const report = await run(dir, { apply: true });

    assert.match(report.workspaces[0].refused, /newer than the tree snapshot/);
  });
});

// ⚠ A refusal an operator cannot act on is a refusal they learn to ignore, and
// this one is easy to misread: it fires on a doc snapshot, and typing in a note
// mints no nodes, so "the tree is stale" is not what the operator did wrong.
// Name the file, print both clocks, and say in one line what rewrites the tree.
test('the staleness refusal names the file that tripped it, both times, and what clears it', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } },
      NOW - 4 * DAY_MS);
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    writeNote(dir, WS, 'n_abc.bin', NOW - 100);

    const { refused } = (await run(dir, { apply: true })).workspaces[0];

    assert.match(refused, /n_abc\.bin/, 'it names the file that tripped it');
    assert.match(refused, new RegExp(new Date(NOW - 100).toISOString()), 'the newer time');
    assert.match(refused, new RegExp(new Date(NOW - 4 * DAY_MS).toISOString()), 'the tree time');
    assert.match(refused, /structural change/, 'and how to clear it');
    assert.match(refused, /server restart/);
  });
});

// An hour of slack, because a snapshot and the upload that provoked it are not
// written in the same instant and a sweeper that refused on a second of skew
// would refuse for ever.
//
// ⚠ The fixture has to put the newest artefact AFTER the tree, or the comparison
// is false by a margin of months and the constant is never exercised: this pair
// straddles STALENESS_SLACK_MS by a second either way, so changing it in either
// direction turns one of them red.
test('a snapshot a second inside the hour of slack is accepted', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } },
      NOW - 3_600_000);
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    writeBlob(dir, WS, sha256('orphan'), NOW - 200 * DAY_MS);
    writeBlob(dir, WS, sha256('fresh'), NOW - 1_000);        // 3_599_000 ms after the snapshot

    const report = await run(dir, { apply: true });

    assert.equal(report.workspaces[0].refused, null);
    assert.deepEqual(atticOf(dir, WS), [sha256('orphan')]);
  });
});

test('a snapshot a second outside the hour of slack is refused', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } },
      NOW - 3_602_000);
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    writeBlob(dir, WS, sha256('orphan'), NOW - 200 * DAY_MS);
    writeBlob(dir, WS, sha256('fresh'), NOW - 1_000);        // 3_601_000 ms after the snapshot

    const report = await run(dir, { apply: true });

    assert.match(report.workspaces[0].refused, /newer than the tree snapshot/);
    assert.deepEqual(atticOf(dir, WS), []);
  });
});

// ⚠ A `b` this build cannot parse is bytes it cannot account for. Guessing is
// how a future reference format turns into a mass deletion of everything using it.
test('a blob reference this build cannot parse refuses the workspace', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, {
      a: { k: 'b', d: '', n: 'x.png', b: 'not-a-reference' },
    });
    writeBlob(dir, WS, sha256('orphan'), NOW - 200 * DAY_MS);

    const report = await run(dir, { apply: true });

    assert.match(report.workspaces[0].refused, /reference/);
    assert.deepEqual(atticOf(dir, WS), []);
  });
});

// ---------------------------------------------------------------- what it keeps

// ⚠ The clause the whole design of §5 depends on. A tombstoned node's bytes are
// exactly the bytes a resurrect needs, an undelete from `.trash` needs, and the
// `proven` probe asks about before it removes anybody's local copy. Counting them
// as dead makes every one of those silently impossible.
test('a hash named by a TOMBSTONED node is live', async () => {
  await withDir(async (dir) => {
    const dead = sha256('dead');
    writeTree(dir, WS, {
      a: { k: 'b', d: '', n: 'gone.png', b: blobRef(dead), g: 1, x: 1 },
      b: { k: 'f', d: '', n: 'note.md', g: 1 },
    });
    writeBlob(dir, WS, dead, NOW - 400 * DAY_MS);

    const report = await run(dir, { apply: true });

    assert.equal(report.workspaces[0].refused, null);
    assert.deepEqual(report.workspaces[0].attic, [], 'a deleted file is not a deleted blob');
    assert.deepEqual(atticOf(dir, WS), []);
  });
});

// The TTL is a grace period for the peer that has been offline, not a formality.
test('an orphan younger than the TTL is left alone', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } });
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    writeBlob(dir, WS, sha256('young'), NOW - 10 * DAY_MS);

    const report = await run(dir, { apply: true });

    assert.deepEqual(report.workspaces[0].attic, []);
  });
});

// §6.5: `parent` is CAUSAL METADATA, not a retention promise. Pinning every
// ancestor for ever is precisely the unbounded growth the in-tree revision log
// was rejected for.
test('an ancestor named only by a parent hash is not retained', async () => {
  await withDir(async (dir) => {
    const current = sha256('v2');
    const ancestor = sha256('v1');
    writeTree(dir, WS, {
      a: { k: 'b', d: '', n: 'x.png', b: blobRef(current, 10, ancestor) },
    });
    writeBlob(dir, WS, current, NOW - 200 * DAY_MS);
    writeBlob(dir, WS, ancestor, NOW - 200 * DAY_MS);

    const report = await run(dir, { apply: true });

    assert.deepEqual(report.workspaces[0].attic, [ancestor]);
    assert.deepEqual(atticOf(dir, WS), [ancestor]);
  });
});

// Isolation: one workspace's tree says nothing about another's bytes, and the
// store keeps them apart by design (§6.5).
test('a hash live in one workspace does not keep it alive in another', async () => {
  await withDir(async (dir) => {
    const shared = sha256('shared');
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(shared) } });
    writeTree(dir, 'ws2', { a: { k: 'f', d: '', n: 'note.md' } });
    writeBlob(dir, WS, shared, NOW - 200 * DAY_MS);
    writeBlob(dir, 'ws2', shared, NOW - 200 * DAY_MS);

    await run(dir, { apply: true });

    assert.deepEqual(atticOf(dir, WS), [], 'still referenced here');
    assert.deepEqual(atticOf(dir, 'ws2'), [shared], 'and referenced by nothing there');
  });
});

// ---------------------------------------------------------------- what it moves

// ⚠ `.attic` FIRST, and only then unlinked. The gap between the two is the only
// chance anybody gets to notice that the sweeper was wrong — an admin who reads
// the report, or a peer that comes back and finds its attachment unavailable.
test('an orphan past the TTL moves to .attic, and is not unlinked in the same run', async () => {
  await withDir(async (dir) => {
    const orphan = sha256('orphan');
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } });
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    const path = writeBlob(dir, WS, orphan, NOW - 200 * DAY_MS);

    const report = await run(dir, { apply: true });

    assert.deepEqual(report.workspaces[0].attic, [orphan]);
    assert.deepEqual(report.workspaces[0].unlinked, [], 'nothing is removed on the same pass');
    assert.equal(existsSync(path), false, 'moved out of the store');
    assert.deepEqual(atticOf(dir, WS), [orphan], 'and into the attic, still on disk');
  });
});

test('an attic entry past a FURTHER TTL is unlinked', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } });
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    const old = writeAttic(dir, WS, sha256('very old'), NOW - 200 * DAY_MS);
    const recent = writeAttic(dir, WS, sha256('recent'), NOW - 10 * DAY_MS);

    const report = await run(dir, { apply: true });

    assert.deepEqual(report.workspaces[0].unlinked, [sha256('very old')]);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(recent), true, 'the grace period is a period, not a formality');
  });
});

// ⚠ The second TTL protects nothing unless the unlink pass looks again. The
// scenario is an operator who swept against a tree restored from a stale backup,
// condemned bytes that were never dead, then put the right snapshot back and left
// the cron running: every later run reads a tree that names those hashes, and if
// it does not consult that answer, the age test alone removes them. For an
// attachment no peer ever fetched, the store's copy was the only copy.
test('an attic entry the tree names again is never unlinked, and is reported', async () => {
  await withDir(async (dir) => {
    const back = sha256('condemned by mistake');
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(back) } });
    const path = writeAttic(dir, WS, back, NOW - 200 * DAY_MS);

    const report = await run(dir, { apply: true });

    assert.deepEqual(report.workspaces[0].unlinked, [], 'a live hash is never unlinked');
    assert.deepEqual(report.workspaces[0].liveInAttic, [back], 'and the operator is told');
    assert.equal(existsSync(path), true, 'the bytes are still there to be restored by hand');
  });
});

// It is reported the FIRST time it is noticed, not on the run that would finally
// have removed it — the whole value of the report is that a human reads it while
// there is still something to save.
test('a live attic entry is reported even while it is younger than the TTL', async () => {
  await withDir(async (dir) => {
    const back = sha256('condemned yesterday');
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(back) } });
    writeAttic(dir, WS, back, NOW - DAY_MS);

    const report = await run(dir, { apply: true });

    assert.deepEqual(report.workspaces[0].liveInAttic, [back]);
    assert.deepEqual(report.workspaces[0].unlinked, []);
  });
});

// ---------------------------------------------------------------- when a move fails

// ⚠ One rejecting call must not cost the operator the record of everything the
// run already did. `rename` and `utimes` on this path are exactly the calls
// Windows fails transiently when a scanner holds a handle, and an unhandled
// rejection unwinds out of `main` before a single line is printed.
test('a move that cannot stamp its clock is reported, and the run carries on', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } });
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    const orphan = writeBlob(dir, WS, sha256('orphan'), NOW - 200 * DAY_MS);
    writeTree(dir, 'ws2', { a: { k: 'f', d: '', n: 'note.md' } });
    writeBlob(dir, 'ws2', sha256('b'), NOW - 200 * DAY_MS);

    const report = await run(dir, {
      apply: true,
      utimes: (path, ...rest) => (path.endsWith(sha256('orphan'))
        ? Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
        : utimesAsync(path, ...rest)),
    });

    const byId = Object.fromEntries(report.workspaces.map((w) => [w.workspace, w]));
    assert.equal(byId[WS].failed.length, 1, 'the failure is in the report, not a stack trace');
    assert.equal(byId[WS].failed[0].sha, sha256('orphan'));
    assert.deepEqual(byId[WS].attic, [], 'and the report never claims a move that did not happen');
    assert.equal(existsSync(orphan), true, 'the object is still where a peer can fetch it');
    assert.deepEqual(atticOf(dir, 'ws2'), [sha256('b')], 'one bad object does not stop the run');
  });
});

// ⚠ `renameWithRetry`'s default cleanup is `rm(from)` — right for `_finalize`,
// where the source is a `.part`, and catastrophic here, where the source is the
// object itself. An exhausted retry must leave the blob alone.
test('a rename that never succeeds leaves the object in the store, not deleted', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } });
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    const orphan = writeBlob(dir, WS, sha256('orphan'), NOW - 200 * DAY_MS);

    const report = await run(dir, {
      apply: true,
      rename: () => { const err = new Error('EPERM'); err.code = 'EPERM'; throw err; },
    });

    assert.equal(report.workspaces[0].failed.length, 1);
    assert.deepEqual(report.workspaces[0].attic, []);
    assert.equal(existsSync(orphan), true, 'the tool must never delete what it refused to move');
    assert.deepEqual(atticOf(dir, WS), []);
  });
});

// The attic entry's mtime is the ONLY record of when the bytes were condemned,
// and a move that lands without it is unlinkable on the next run with no second
// grace period at all. So the stamp is not allowed to be the step that fails
// after the point of no return.
test('an attic entry always carries the condemnation clock, never the object\'s', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } });
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    writeBlob(dir, WS, sha256('orphan'), NOW - 200 * DAY_MS);

    await run(dir, { apply: true });

    const moved = join(dir, 'blobs', WS, '.attic', sha256('orphan'));
    assert.equal(Math.round(statSync(moved).mtimeMs), NOW, 'stamped with the time it was condemned');
  });
});

// A blob whose name is not its address is unreachable through `finalPath`, so it
// is not an object anybody can fetch — and the sweeper must not pretend it is one
// or invent a live reference for it.
test('files that are not fanned-out objects are ignored entirely', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } });
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    const stray = join(dir, 'blobs', WS, 'usage.json');
    writeFileSync(stray, '{}');
    touch(stray, NOW - 300 * DAY_MS);
    const partial = join(dir, 'blobs', WS, 'incoming', `${sha256('part')}.part`);
    mkdirSync(join(dir, 'blobs', WS, 'incoming'), { recursive: true });
    writeFileSync(partial, 'x');
    touch(partial, NOW - 300 * DAY_MS);

    const report = await run(dir, { apply: true });

    assert.deepEqual(report.workspaces[0].attic, []);
    assert.equal(existsSync(stray), true, 'usage.json is not an object');
    assert.equal(existsSync(partial), true, 'a partial is the store\'s own TTL sweep, not this');
  });
});

// Idempotence, because an admin runs this on a timer and a second run must not
// re-decide the first one's work.
test('a second run over the same directory does nothing further', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, { a: { k: 'b', d: '', n: 'x.png', b: blobRef(sha256('kept')) } });
    writeBlob(dir, WS, sha256('kept'), NOW - 200 * DAY_MS);
    writeBlob(dir, WS, sha256('orphan'), NOW - 200 * DAY_MS);

    await run(dir, { apply: true });
    const second = await run(dir, { apply: true });

    assert.deepEqual(second.workspaces[0].attic, []);
    assert.deepEqual(second.workspaces[0].unlinked, [], 'the attic entry is only hours old');
    assert.deepEqual(atticOf(dir, WS), [sha256('orphan')]);
  });
});

// One workspace's refusal is not another's. An admin with twelve workspaces and
// one stale snapshot should still reclaim the other eleven.
test('a refusal is per workspace, and does not stop the run', async () => {
  await withDir(async (dir) => {
    writeTree(dir, WS, {});                                        // refused: zero nodes
    writeBlob(dir, WS, sha256('a'), NOW - 200 * DAY_MS);
    writeTree(dir, 'ws2', { a: { k: 'f', d: '', n: 'note.md' } });
    writeBlob(dir, 'ws2', sha256('b'), NOW - 200 * DAY_MS);

    const report = await run(dir, { apply: true });

    const byId = Object.fromEntries(report.workspaces.map((w) => [w.workspace, w]));
    assert.notEqual(byId[WS].refused, null);
    assert.equal(byId.ws2.refused, null);
    assert.deepEqual(atticOf(dir, WS), []);
    assert.deepEqual(atticOf(dir, 'ws2'), [sha256('b')]);
  });
});
