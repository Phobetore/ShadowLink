// src/sync/PublishQueue.test.ts
//
// Spec §6.2. Every test runs against the in-memory fakes plus a real `TreeDoc`,
// so the `s` write is observed through the same Y.Map the rest of the workspace
// reads it from.
//
// The queue is the one place in P1 that WRITES a note's first bytes into a shared
// document, so most of what follows is about the four ways that goes wrong:
// two devices seeding the same doc (I5), seeding a doc that never synced (I4),
// writing under a live editor binding (I7), and marking a node published before
// the update came back (I17).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOB_PUBLISH_CONCURRENCY, PUBLISH_BACKOFF_MS, PUBLISH_CONCURRENCY,
} from '../tree/constants.ts';
import { fold, hashOf, hashOfBytes } from '../tree/paths.ts';
import { TreeDoc } from '../tree/TreeDoc.ts';
import type { BlobPort } from './BlobPort.ts';
import { DeviceState, type StatePort } from './DeviceState.ts';
import type { DocHandle, DocPort } from './DocPort.ts';
import { FakeBlobs, FakeDocs, FakeVault } from './fakes.ts';
import { PublishQueue, type PublishQueueDeps } from './PublishQueue.ts';
import type { VaultPort } from './VaultPort.ts';

// ---------------------------------------------------------------- fixtures

const SHARE = 'Shared';
const NOW = 1_700_000_000_000;

class MemoryStatePort implements StatePort {
  private readonly store = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    const v = this.store.get(key);
    return v === undefined ? null : v;
  }

  async write(key: string, data: string): Promise<void> {
    this.store.set(key, data);
  }

  /** The bytes currently persisted under `key` — what a restart would read back. */
  peek(key: string): string | null {
    return this.store.get(key) ?? null;
  }
}

interface Harness {
  vault: FakeVault;
  docs: FakeDocs;
  blobs: FakeBlobs;
  state: DeviceState;
  tree: TreeDoc;
  port: MemoryStatePort;
  queue: PublishQueue;
  /** Mutable clock, so a backoff can be waited out without a real timer. */
  clock: { now: number };
  open: { id: string | null };
  notices: string[];
  /**
   * What the injected `sleep` does — the test's chance to change the file DURING
   * the settle window, which is the only way to exercise the check that exists
   * because Obsidian announces a file before it is finished (§3.2).
   */
  settle: { run: () => Promise<void> };
  /** Mint an owned, materialized, unpublished node holding `text` on disk. */
  add(name: string, text: string): string;
  /** The same for an attachment: a `'b'` node over real bytes. */
  addBlob(name: string, bytes: Uint8Array): string;
}

function makeHarness(over: Partial<PublishQueueDeps> = {}): Harness {
  const vault = new FakeVault();
  const docs = new FakeDocs();
  const blobs = new FakeBlobs();
  const port = new MemoryStatePort();
  const clock = { now: NOW };
  const open: { id: string | null } = { id: null };
  const notices: string[] = [];
  const settle = { run: async (): Promise<void> => undefined };
  const state = new DeviceState(port, 'device-1', 'ws-1', () => clock.now, 0);
  const tree = new TreeDoc();
  vault.seed(SHARE, 'd');

  const queue = new PublishQueue({
    docs,
    vault,
    blobs,
    state,
    tree,
    openNodeId: () => open.id,
    now: () => clock.now,
    // Deterministic, so the settle window (§3.2) is a step the test controls
    // rather than 400 ms of real time in every attachment case.
    settleMs: 0,
    sleep: () => settle.run(),
    displayName: 'Ada',
    notice: (m) => { notices.push(m); },
    ...over,
  });

  return {
    vault, docs, blobs, state, tree, port, queue, clock, open, notices, settle,
    add(name, text) {
      const id = tree.createNode({ k: 'f', d: '', n: name }, clock.now);
      vault.seed(`${SHARE}/${name}`, 'f', text);
      state.data.owned[id] = true;
      state.data.materialized[id] = `${SHARE}/${name}`;
      return id;
    },
    addBlob(name, bytes) {
      const id = tree.createNode({ k: 'b', d: '', n: name }, clock.now);
      vault.seedBinary(`${SHARE}/${name}`, bytes);
      state.data.owned[id] = true;
      state.data.materialized[id] = `${SHARE}/${name}`;
      return id;
    },
  };
}

/** Yield to the event loop, so sibling workers get a chance to start. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/** A plain `VaultPort` view of a `FakeVault`, so one method can be overridden. */
function portOf(inner: FakeVault): VaultPort {
  return {
    list: () => inner.list(),
    exists: (p) => inner.exists(p),
    listDir: (p) => inner.listDir(p),
    read: (p) => inner.read(p),
    readBinary: (p) => inner.readBinary(p),
    stat: (p) => inner.stat(p),
    create: (p, d) => inner.create(p, d),
    createBinary: (p, d) => inner.createBinary(p, d),
    createFolder: (p) => inner.createFolder(p),
    rename: (f, t) => inner.rename(f, t),
    trashLocal: (p) => inner.trashLocal(p),
    isOpenInLeaf: (p) => inner.isOpenInLeaf(p),
  };
}

// ---------------------------------------------------------------- I5: only the creator publishes

test('the owner publishes: the doc is seeded, `s` is set and the hash is recorded', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'the body');

  h.queue.enqueue(id);
  assert.equal(h.queue.pendingCount(), 1);

  await h.queue.drain();

  assert.equal(h.docs.text(`n_${id}`), 'the body', 'the content doc was seeded');
  assert.equal(h.tree.get(id)!.s, 1, 'and the node is marked published');
  assert.deepEqual(h.state.data.contentHash[id], {
    sha256: await hashOf('the body'),
    len: 'the body'.length,
  });
  assert.deepEqual(h.state.data.publish[id], { state: 'done', attempts: 0, nextAt: 0 });
  assert.equal(h.queue.pendingCount(), 0);
  assert.ok(h.docs.allClosed(), 'the handle was released');
  assert.deepEqual(h.queue.stalled(), []);
});

// I5 is the invariant with the worst failure mode in P1: two devices seeding one
// content doc do not conflict, they CONCATENATE, and every peer's note ends up
// holding both copies. The gate is therefore checked at both ends of the queue.
test('a node this device does not own is never queued and never published', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'the body');
  delete h.state.data.owned[id];                    // a peer created it, not us

  h.queue.enqueue(id);

  assert.equal(h.queue.pendingCount(), 0, 'nothing was queued');
  assert.equal(h.state.data.publish[id], undefined);

  await h.queue.drain();

  assert.equal(h.docs.text(`n_${id}`), '', 'and the doc was never touched');
  assert.equal(h.docs.calls.length, 0);
  assert.equal(h.tree.get(id)!.s, undefined, '`s` stays unset');
});

test('a pending entry restored for a node we do not own is refused, not acted on', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'the body');
  // Exactly what a state file written before ownership was lost looks like.
  delete h.state.data.owned[id];
  h.state.data.publish[id] = { state: 'pending', attempts: 0, nextAt: 0 };

  await h.queue.drain();

  assert.equal(h.docs.calls.length, 0, 'not one doc call (I5)');
  assert.equal(h.vault.callsTo('read').length, 0, 'and not one disk read');
  assert.equal(h.tree.get(id)!.s, undefined);
  assert.equal(h.queue.pendingCount(), 1, 'the entry is kept and reported, never dropped');
});

// ---------------------------------------------------------------- I4: never seed an unsynced doc

test('a content doc that did not sync is retried, and `pending` survives a restart', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'the body');
  h.docs.setSynced(`n_${id}`, false);               // a timeout is not a sync

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.docs.text(`n_${id}`), '', 'nothing was seeded into an unsynced doc (I4)');
  assert.equal(h.tree.get(id)!.s, undefined, 'and nothing was marked published (I17)');
  assert.equal(h.state.data.publish[id].state, 'pending');
  assert.equal(h.state.data.publish[id].attempts, 1);
  assert.equal(h.state.data.publish[id].nextAt, NOW + PUBLISH_BACKOFF_MS[0]);
  assert.ok(h.docs.allClosed(), 'the handle is released even on the failure path');

  // A laptop that slept mid-queue: same device, same workspace, fresh objects.
  const bytes = h.port.peek(h.state.key);
  assert.ok(bytes !== null, 'the queue was persisted by the drain, not only in memory');
  const restored = new DeviceState(h.port, 'device-1', 'ws-1', () => h.clock.now, 0);
  const cold = await restored.load();
  assert.equal(cold.coldStart, false);
  assert.deepEqual(restored.data.publish[id], {
    state: 'pending', attempts: 1, nextAt: NOW + PUBLISH_BACKOFF_MS[0],
  });

  // And it converges once the provider does sync.
  h.docs.setSynced(`n_${id}`, true);
  h.clock.now = NOW + PUBLISH_BACKOFF_MS[0];
  await h.queue.drain();

  assert.equal(h.docs.text(`n_${id}`), 'the body');
  assert.equal(h.tree.get(id)!.s, 1);
});

// ---------------------------------------------------------------- I7: single writer per file

test('a publish defers while the note is open, issuing no disk and no doc call', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'the body');
  h.open.id = id;                                   // the editing session owns it

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.vault.callsTo('read').length, 0, 'no disk read');
  assert.equal(h.docs.calls.length, 0, 'no doc call at all');
  assert.equal(h.tree.get(id)!.s, undefined);
  assert.equal(h.queue.pendingCount(), 1, 'still queued');
  // A deferral is not a failure: it must not burn a backoff step, or closing the
  // note would leave the publish parked for five minutes for no reason.
  assert.deepEqual(h.state.data.publish[id], { state: 'pending', attempts: 0, nextAt: 0 });

  h.open.id = null;                                 // the session closed
  await h.queue.drain();

  assert.equal(h.docs.text(`n_${id}`), 'the body');
  assert.equal(h.tree.get(id)!.s, 1);
});

// ---------------------------------------------------------------- I17: confirm, then advance

test('`s` is written only after the flush has come back', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'the body');
  const seenAtFlush: Array<number | undefined> = [];

  // Wrap the port so the tree can be inspected at the exact moment of the flush.
  const probe: DocPort = {
    openHeadless: (room) => h.docs.openHeadless(room),
    insertIfEmpty: (handle, text) => h.docs.insertIfEmpty(handle, text),
    flush: async (handle) => {
      seenAtFlush.push(h.tree.get(id)!.s);
      return h.docs.flush(handle);
    },
    close: (handle) => h.docs.close(handle),
  };
  const q = new PublishQueue({
    docs: probe,
    vault: h.vault,
    blobs: h.blobs,
    state: h.state,
    tree: h.tree,
    openNodeId: () => null,
    now: () => h.clock.now,
  });

  q.enqueue(id);
  await q.drain();

  assert.deepEqual(seenAtFlush, [undefined], '`s` was still unset when the flush was issued');
  assert.equal(h.tree.get(id)!.s, 1, 'and set once it returned');
  assert.deepEqual(
    h.docs.calls.map((c) => c.op),
    ['openHeadless', 'insertIfEmpty', 'flush', 'close'],
    'insert precedes the flush, and the handle is released last',
  );
});

test('an unconfirmed flush publishes nothing and backs off instead', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'the body');
  h.docs.setFlushConfirmed(`n_${id}`, false);       // the update never came back

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.tree.get(id)!.s, undefined, 'no watermark on an unconfirmed write (I17)');
  assert.equal(h.state.data.contentHash[id], undefined);
  assert.equal(h.state.data.publish[id].state, 'pending');
  assert.equal(h.state.data.publish[id].attempts, 1);
});

// ---------------------------------------------------------------- I5: an occupied doc is left alone

test('a content doc that already holds text is never overwritten', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'my local copy');
  h.docs.setText(`n_${id}`, 'someone else got here first');

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.docs.text(`n_${id}`), 'someone else got here first', 'the remote copy stands');
  assert.equal(
    h.docs.calls.filter((c) => c.op === 'insertIfEmpty').length, 0,
    'insertIfEmpty is not even attempted against a non-empty doc',
  );
  // The node IS published — by the other device — so the watermark is the remote
  // text, never the local text this device happened to be holding.
  assert.equal(h.tree.get(id)!.s, 1);
  assert.deepEqual(h.state.data.contentHash[id], {
    sha256: await hashOf('someone else got here first'),
    len: 'someone else got here first'.length,
  });
  assert.equal(h.state.data.publish[id].state, 'done');
});

test('a doc seeded concurrently between the open and the insert is retried, not assumed', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'my local copy');
  const racing: DocPort = {
    openHeadless: (room) => h.docs.openHeadless(room),
    insertIfEmpty: async (handle, text) => {
      h.docs.setText(handle.room, 'a peer won the race');   // after we observed empty
      return h.docs.insertIfEmpty(handle, text);
    },
    flush: (handle) => h.docs.flush(handle),
    close: (handle) => h.docs.close(handle),
  };
  const q = new PublishQueue({
    docs: racing, vault: h.vault, blobs: h.blobs, state: h.state, tree: h.tree,
    openNodeId: () => null, now: () => h.clock.now,
  });

  q.enqueue(id);
  await q.drain();

  assert.equal(h.docs.text(`n_${id}`), 'a peer won the race', 'nothing was concatenated (I5)');
  assert.equal(h.tree.get(id)!.s, undefined, 'and no watermark from a guess');
  assert.equal(h.state.data.publish[id].state, 'pending', 'it is retried instead');
});

// ---------------------------------------------------------------- backoff

test('the backoff ladder advances, is persisted, and holds the entry back until it is due', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'the body');
  h.docs.setSynced(`n_${id}`, false);

  h.queue.enqueue(id);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await h.queue.drain();
    assert.equal(h.state.data.publish[id].attempts, attempt, `attempt ${attempt}`);
    assert.equal(h.state.data.publish[id].nextAt, h.clock.now + PUBLISH_BACKOFF_MS[attempt - 1]);
    h.clock.now = h.state.data.publish[id].nextAt;
  }

  // Not yet due: the drain must leave it strictly alone.
  h.clock.now = h.state.data.publish[id].nextAt - 1;
  const before = h.docs.totalOpens(`n_${id}`);
  await h.queue.drain();
  assert.equal(h.docs.totalOpens(`n_${id}`), before, 'an entry that is not due is not opened');
  assert.equal(h.state.data.publish[id].attempts, 3, 'and its backoff is not advanced either');

  // Re-enqueueing must not reset the ladder, or a chatty caller defeats it entirely.
  h.queue.enqueue(id);
  assert.equal(h.state.data.publish[id].attempts, 3);
  assert.equal(h.state.data.publish[id].nextAt, h.clock.now + 1);

  // The ladder is capped at its last rung and the entry is surfaced, never dropped.
  h.clock.now += 1;
  await h.queue.drain();
  await h.queue.drain();
  assert.equal(h.state.data.publish[id].attempts, 4);
  assert.deepEqual(h.queue.stalled(), [id]);
  assert.equal(h.queue.pendingCount(), 1);

  h.clock.now += PUBLISH_BACKOFF_MS[PUBLISH_BACKOFF_MS.length - 1];
  await h.queue.drain();
  assert.equal(h.state.data.publish[id].attempts, 5);
  assert.equal(
    h.state.data.publish[id].nextAt,
    h.clock.now + PUBLISH_BACKOFF_MS[PUBLISH_BACKOFF_MS.length - 1],
    'the ladder caps rather than running off the end',
  );

  const persisted = JSON.parse(h.port.peek(h.state.key)!);
  assert.deepEqual(persisted.publish[id], h.state.data.publish[id], 'and every step was persisted');
});

// ---------------------------------------------------------------- concurrency

// The cap is not a nicety: each publish holds an open provider on its own room,
// and an uncapped queue opens one per untracked file the very first time a vault
// is shared.
test('no more than PUBLISH_CONCURRENCY publishes are ever in flight', async () => {
  const h = makeHarness();
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(h.add(`note-${i}.md`, `body ${i}`));

  let inFlight = 0;
  let peak = 0;
  const gated: DocPort = {
    openHeadless: async (room) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      return h.docs.openHeadless(room);
    },
    insertIfEmpty: async (handle, text) => {
      await tick();
      return h.docs.insertIfEmpty(handle, text);
    },
    flush: async (handle) => {
      await tick();
      return h.docs.flush(handle);
    },
    close: (handle) => { inFlight -= 1; h.docs.close(handle); },
  };
  const q = new PublishQueue({
    docs: gated, vault: h.vault, blobs: h.blobs, state: h.state, tree: h.tree,
    openNodeId: () => null, now: () => h.clock.now,
  });

  for (const id of ids) q.enqueue(id);
  assert.equal(q.pendingCount(), 12);

  await q.drain();

  assert.equal(peak, PUBLISH_CONCURRENCY, 'the cap is exact, not merely respected');
  assert.equal(q.pendingCount(), 0, 'and every one of them finished');
  for (let i = 0; i < 12; i++) {
    assert.equal(h.docs.text(`n_${ids[i]}`), `body ${i}`);
    assert.equal(h.tree.get(ids[i])!.s, 1);
  }
});

test('a lower concurrency is honoured, and a second drain during one is not a second pass', async () => {
  const h = makeHarness({ concurrency: 2 });
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push(h.add(`note-${i}.md`, `body ${i}`));

  let inFlight = 0;
  let peak = 0;
  const gated: DocPort = {
    openHeadless: async (room) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      return h.docs.openHeadless(room);
    },
    insertIfEmpty: (handle, text) => h.docs.insertIfEmpty(handle, text),
    flush: (handle) => h.docs.flush(handle),
    close: (handle) => { inFlight -= 1; h.docs.close(handle); },
  };
  const q = new PublishQueue({
    docs: gated, vault: h.vault, blobs: h.blobs, state: h.state, tree: h.tree,
    openNodeId: () => null, now: () => h.clock.now, concurrency: 2,
  });

  for (const id of ids) q.enqueue(id);
  await Promise.all([q.drain(), q.drain(), q.drain()]);

  assert.equal(peak, 2);
  for (const id of ids) assert.equal(h.docs.totalOpens(`n_${id}`), 1, 'opened exactly once');
  assert.equal(q.pendingCount(), 0);
});

// ---------------------------------------------------------------- containment

test('a node with no local binding yet is held, not lost', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'the body');
  delete h.state.data.materialized[id];             // the reconciler has not bound it

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.docs.calls.length, 0);
  assert.equal(h.tree.get(id)!.s, undefined);
  assert.equal(h.queue.pendingCount(), 1, 'kept for the next pass');
  assert.equal(h.state.data.publish[id].attempts, 1, 'behind a backoff, so it cannot hot-loop');
});

test('one failing publish does not stop the others in the same drain', async () => {
  const h = makeHarness();
  const bad = h.add('bad.md', 'unreadable');
  const good = h.add('good.md', 'fine');
  // Keyed on the path, not on `failNext`: the two items publish concurrently and
  // the drain order follows their nodeIds, so "fail the next read" would land on
  // whichever one happened to start first.
  const locked: VaultPort = {
    ...portOf(h.vault),
    read: async (p) => {
      if (p === `${SHARE}/bad.md`) throw new Error('EPERM: the file is locked');
      return h.vault.read(p);
    },
  };
  const q = new PublishQueue({
    docs: h.docs, vault: locked, blobs: h.blobs, state: h.state, tree: h.tree,
    openNodeId: () => null, now: () => h.clock.now,
  });

  q.enqueue(bad);
  q.enqueue(good);
  await q.drain();

  assert.equal(h.docs.text(`n_${good}`), 'fine', 'the healthy one still published');
  assert.equal(h.tree.get(good)!.s, 1);
  assert.equal(h.state.data.publish[bad].state, 'pending');
  assert.equal(h.state.data.publish[bad].attempts, 1);
  assert.ok(q.lastError(bad) instanceof Error);
  assert.ok(h.docs.allClosed());
});

test('a drain is idempotent: a published node is never opened or seeded twice', async () => {
  const h = makeHarness();
  const id = h.add('todo.md', 'the body');

  h.queue.enqueue(id);
  await h.queue.drain();
  h.queue.enqueue(id);                              // an over-eager caller
  await h.queue.drain();
  await h.queue.drain();

  assert.equal(h.docs.totalOpens(`n_${id}`), 1, 'opened exactly once, ever');
  assert.equal(h.docs.text(`n_${id}`), 'the body');
  assert.equal(h.queue.pendingCount(), 0);
});

// ---------------------------------------------------------------- P2 §3.2: requeue

// Spec test A13. Markdown publication happens once, so `enqueue` refuses a node it
// already has an entry for. Attachment publication REPEATS — the same node's bytes
// can change — so admission needs a second door, and that door must not become a
// way to reset the backoff ladder on every pass.
test('requeue admits new content and is a genuine no-op for content already queued', () => {
  const h = makeHarness();
  const id = h.add('diagram.png', 'not really bytes');
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);

  h.queue.requeue(id, first);
  assert.deepEqual(h.state.data.publish[id], {
    state: 'pending', attempts: 0, nextAt: 0, intent: first,
  });

  // Charge the ladder, as a failed attempt would.
  h.state.data.publish[id] = { state: 'pending', attempts: 3, nextAt: 99_000, intent: first };
  h.queue.requeue(id, first);
  assert.deepEqual(
    h.state.data.publish[id],
    { state: 'pending', attempts: 3, nextAt: 99_000, intent: first },
    'requeueing the same intent must not reset the backoff — the reconciler does this every pass',
  );

  // New bytes are new work: the ladder restarts and the entry is due immediately.
  h.queue.requeue(id, second);
  assert.deepEqual(h.state.data.publish[id], {
    state: 'pending', attempts: 0, nextAt: 0, intent: second,
  });
});

test('requeue resets a done entry only when the content actually changed', () => {
  const h = makeHarness();
  const id = h.add('diagram.png', 'not really bytes');
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);

  h.state.data.publish[id] = { state: 'done', attempts: 0, nextAt: 0, intent: first };
  h.queue.requeue(id, first);
  assert.equal(h.state.data.publish[id].state, 'done', 'the same bytes are already published');
  assert.equal(h.queue.pendingCount(), 0);

  h.queue.requeue(id, second);
  assert.deepEqual(h.state.data.publish[id], {
    state: 'pending', attempts: 0, nextAt: 0, intent: second,
  });
  assert.equal(h.queue.pendingCount(), 1);
});

test('requeue reopens an entry left over from the markdown path, which carries no intent', () => {
  const h = makeHarness();
  const id = h.add('diagram.png', 'not really bytes');
  const sha = 'a'.repeat(64);

  h.state.data.publish[id] = { state: 'done', attempts: 2, nextAt: 7 };
  h.queue.requeue(id, sha);

  assert.deepEqual(h.state.data.publish[id], {
    state: 'pending', attempts: 0, nextAt: 0, intent: sha,
  });
});

// ---------------------------------------------------------------- P2 §3.2: publishBlobOne
//
// The attachment arm. Everything below is about the four ways it can put bytes in
// front of a peer that are not the bytes the user has: publishing a file that is
// still being written, trusting our own account of an upload instead of the
// store's, writing `s` and `b` where a peer can observe one without the other,
// and letting a file that can never be published sit pending on every device.

/** The `b` field a first publish writes: hash, length, and no parent. */
function refOf(sha: string, len: number): string {
  return `${sha}:${len}:-`;
}

/** Bytes that a UTF-8 round trip would destroy — a PNG header and then some. */
function png(seed = 1, length = 64): Uint8Array {
  const out = new Uint8Array(length);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < length; i++) out[i] = (i * 31 + seed * 97) & 0xff;
  return out;
}

/** A `BlobPort` view of the harness's store, so one method can be replaced. */
function blobPortOf(inner: FakeBlobs, overrides: Partial<BlobPort>): BlobPort {
  const base: BlobPort = {
    has: (sha) => inner.has(sha),
    put: (sha, data, onProgress) => inner.put(sha, data, onProgress),
    get: (sha, n, signal, onProgress) => inner.get(sha, n, signal, onProgress),
    limits: () => inner.limits(),
    get lastError(): unknown { return inner.lastError; },
  };
  return { ...base, ...overrides };
}

test('B1: an attachment uploads once, sets `s` and `b` together, and records the base', async () => {
  const h = makeHarness();
  const bytes = png();
  const id = h.addBlob('diagram.png', bytes);
  const sha = await hashOfBytes(bytes);

  // Every state the tree was OBSERVED in, one entry per transaction. A peer sees
  // exactly this sequence, so a two-transaction publish shows up here as a frame
  // in which the node is published and names no bytes.
  const seen: Array<{ s?: number; b?: string }> = [];
  h.tree.observe(() => { seen.push({ s: h.tree.get(id)?.s, b: h.tree.get(id)?.b }); });

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.blobs.callsTo('put').length, 1, 'uploaded exactly once');
  assert.deepEqual(h.blobs.stored(sha), bytes, 'and the store holds the real bytes');
  assert.equal(h.tree.get(id)!.s, 1);
  assert.equal(h.tree.get(id)!.b, refOf(sha, bytes.length), 'first version: parent is "-"');
  assert.deepEqual(
    seen.filter((f) => f.s === 1 && f.b === undefined), [],
    '`s` was never observable without `b` (§3.2)',
  );

  const st = (await h.vault.stat(`${SHARE}/diagram.png`))!;
  assert.deepEqual(h.state.data.contentHash[id], {
    sha256: sha, len: bytes.length, mtime: st.mtime,
  }, 'the base carries the mtime, or every later pass re-hashes the whole share');
  assert.deepEqual(h.state.data.publish[id], {
    state: 'done', attempts: 0, nextAt: 0, intent: sha,
  });
  assert.equal(h.docs.calls.length, 0, 'no content doc is involved in an attachment at all');
});

// ⚠ B2. Obsidian fires `create` when a file APPEARS. A publish that skips the
// settle check uploads whatever prefix has landed — and because the store
// verifies what it is given, the truncated object is then authoritative for every
// peer, for ever, under a hash that matches it perfectly.
test('B2: a file still being written is not published, and publishes once it settles', async () => {
  const h = makeHarness();
  const half = png(1, 32);
  const whole = png(1, 64);
  const id = h.addBlob('capture.png', half);
  const path = `${SHARE}/capture.png`;

  // The rest of the file lands DURING the settle window — exactly the race the
  // two stats exist to lose.
  h.settle.run = async (): Promise<void> => { h.vault.seedBinary(path, whole); };

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.blobs.callsTo('put').length, 0, 'nothing was uploaded');
  assert.equal(h.blobs.objectCount(), 0, 'and no truncated object exists anywhere');
  assert.equal(h.tree.get(id)!.s, undefined);
  assert.equal(h.tree.get(id)!.b, undefined);
  assert.equal(h.state.data.publish[id].state, 'pending');
  assert.equal(h.state.data.publish[id].attempts, 1, 'behind a backoff, never dropped');

  // It settles, and the SAME entry converges on the whole file.
  h.settle.run = async (): Promise<void> => undefined;
  h.clock.now = h.state.data.publish[id].nextAt;
  await h.queue.drain();

  const sha = await hashOfBytes(whole);
  assert.deepEqual(h.blobs.stored(sha), whole);
  assert.equal(h.tree.get(id)!.b, refOf(sha, whole.length));
});

// ⚠ B2, the half a length check cannot cover. A writer that replaces a file's
// contents IN PLACE — an export re-run, a screenshot tool rewriting its buffer —
// leaves the size identical, so "the bytes I read are as long as the bytes I
// stat'd" agrees perfectly with a file that changed underneath. Only the mtime
// clause of the settle check sees it, and without that clause a half-written
// version is uploaded, verified and handed to every peer.
test('B2: a file rewritten in place during the settle window is not published', async () => {
  const h = makeHarness();
  const before = png(1, 64);
  const after = png(2, 64);                                   // same length, other bytes
  const id = h.addBlob('capture.png', before);

  h.settle.run = async (): Promise<void> => {
    h.vault.seedBinary(`${SHARE}/capture.png`, after);
  };

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.blobs.objectCount(), 0, 'neither version was uploaded');
  assert.equal(h.tree.get(id)!.s, undefined);
  assert.equal(h.state.data.publish[id].attempts, 1, 'it waits for the writer to stop');

  h.settle.run = async (): Promise<void> => undefined;
  h.clock.now = h.state.data.publish[id].nextAt;
  await h.queue.drain();

  const sha = await hashOfBytes(after);
  assert.equal(h.tree.get(id)!.b, refOf(sha, after.length), 'and then publishes what settled');
  assert.equal(h.blobs.objectCount(), 1, 'exactly one object, ever');
});

test('B2: a zero-byte file is never published, however settled it looks', async () => {
  const h = makeHarness();
  const id = h.addBlob('empty.png', new Uint8Array(0));

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.blobs.calls.length, 0, 'not even a dedup probe');
  assert.equal(h.tree.get(id)!.s, undefined, 'an empty attachment is a file mid-write (I6)');
  assert.equal(h.state.data.publish[id].state, 'pending');
});

// ⚠ B3, and the sharpest form of I17. `put` resolving true is OUR account of a
// round trip; only a fresh `has` is the store's. A node whose `s` is set is never
// re-offered by anybody, so advancing it against bytes the store does not hold is
// permanent — not a retry.
test('B3: an upload the store will not confirm publishes nothing and retries', async () => {
  const h = makeHarness();
  const bytes = png();
  const id = h.addBlob('diagram.png', bytes);
  // Answers a definite "not stored" every time, and never throws: the store is
  // reachable, it simply does not have the object the upload claims to have left.
  const unconfirming = blobPortOf(h.blobs, { has: async () => ({ present: false }) });
  const q = new PublishQueue({
    docs: h.docs, vault: h.vault, blobs: unconfirming, state: h.state, tree: h.tree,
    openNodeId: () => null, now: () => h.clock.now, settleMs: 0,
  });

  q.enqueue(id);
  await q.drain();

  assert.equal(h.tree.get(id)!.s, undefined, '`s` is not advanced on our own say-so (I17)');
  assert.equal(h.tree.get(id)!.b, undefined);
  assert.equal(h.state.data.contentHash[id], undefined, 'and no base is recorded');
  assert.equal(h.state.data.publish[id].state, 'pending');
  assert.equal(h.state.data.publish[id].attempts, 1);
});

test('a `has` that cannot answer is a retry, never a publish and never a refusal', async () => {
  const h = makeHarness();
  const id = h.addBlob('diagram.png', png());
  h.blobs.failNext('has', new Error('ECONNRESET'));

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.blobs.callsTo('put').length, 0);
  assert.equal(h.tree.get(id)!.s, undefined);
  assert.equal(h.state.data.publish[id].attempts, 1, 'the ladder, not a permanent refusal');
  assert.deepEqual(h.notices, [], 'and the user is not told their file is unshareable');
});

test('a refused upload (413/507/422) charges the ladder and publishes nothing', async () => {
  const h = makeHarness();
  const id = h.addBlob('diagram.png', png());
  const why = new Error('507: the workspace is full');
  h.blobs.refuseNextPut(why);

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.tree.get(id)!.s, undefined);
  assert.equal(h.state.data.publish[id].state, 'pending');
  assert.equal(h.queue.lastError(id), why, 'the reason is kept for diagnostics');
  assert.equal(
    h.state.data.oversized[fold(`${SHARE}/diagram.png`)], undefined,
    'a refusal the server explained is not a size retraction: the node stays live',
  );
  assert.equal(h.tree.get(id)!.x, undefined);
});

// I8. The steady state of every converged attachment on every device: the tree
// already names these exact bytes, so the pass costs one stat pair and nothing
// else — no read, no upload, and above all no second object.
test('a node whose reference already names the bytes on disk is not re-uploaded', async () => {
  const h = makeHarness();
  const bytes = png();
  const id = h.addBlob('diagram.png', bytes);
  const sha = await h.blobs.seed(bytes);
  h.tree.patchNode(id, { s: 1, b: refOf(sha, bytes.length) });
  h.blobs.resetCalls();

  h.queue.requeue(id, sha);
  await h.queue.drain();

  assert.deepEqual(
    h.blobs.calls.map((c) => c.op), ['limits'],
    'the ceiling is asked for once per session, and nothing is uploaded or probed',
  );
  assert.equal(h.state.data.publish[id].state, 'done');
  assert.equal(h.state.data.contentHash[id]?.sha256, sha, 'the base is recorded all the same');

  // And the ceiling is CACHED: a second publish of the same node — here admitted
  // with a stale intent, as a device that had not seen the tree yet would — costs
  // the store nothing at all.
  h.blobs.resetCalls();
  h.queue.requeue(id, 'f'.repeat(64));
  await h.queue.drain();
  assert.deepEqual(h.blobs.calls.map((c) => c.op), []);
  assert.equal(h.state.data.publish[id].intent, sha, 'and the entry converges on the real hash');
});

// I5a. The first publish stays creator-only, and the gate is re-checked at drain
// rather than trusted from admission.
test('an unpublished attachment this device does not own is never uploaded', async () => {
  const h = makeHarness();
  const id = h.addBlob('diagram.png', png());
  h.state.data.publish[id] = { state: 'pending', attempts: 0, nextAt: 0 };
  delete h.state.data.owned[id];

  await h.queue.drain();

  assert.equal(h.blobs.calls.length, 0);
  assert.equal(h.vault.callsTo('readBinary').length, 0);
  assert.equal(h.tree.get(id)!.s, undefined);
  assert.equal(h.queue.pendingCount(), 1, 'kept and reported, never dropped');
});

// I13. A node the user deleted while its publish was queued is not published back
// into existence.
test('a dead attachment node is never published', async () => {
  const h = makeHarness();
  const id = h.addBlob('diagram.png', png());
  h.queue.enqueue(id);
  h.tree.patchNode(id, { x: 1, xa: NOW });

  await h.queue.drain();

  assert.equal(h.blobs.calls.length, 0);
  assert.equal(h.tree.get(id)!.s, undefined);
});

// I7, and no backoff is charged: the user merely has the image open in a leaf.
test('an attachment open in a leaf defers without touching the disk or the ladder', async () => {
  const h = makeHarness();
  const id = h.addBlob('diagram.png', png());
  h.vault.setOpen(`${SHARE}/diagram.png`, true);

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.vault.callsTo('stat').length, 0, 'not even a stat');
  assert.equal(h.blobs.calls.length, 0);
  assert.deepEqual(h.state.data.publish[id], { state: 'pending', attempts: 0, nextAt: 0 });
});

// ---------------------------------------------------------------- §3.2: retract

// ⚠ B23, the publish arm. Above the cap the node is RETRACTED: tombstoned,
// recorded, explained once — and the file is left exactly where the user put it.
// The binding goes with it, because a dead node still bound to a real file is
// what the deletion pass reads as "rescue this into ShadowLink Recovered/".
test('B23: a file over the server limit is retracted, and the file is untouched', async () => {
  const h = makeHarness();
  const bytes = png(1, 4_096);
  const id = h.addBlob('scan.tiff', bytes);
  h.blobs.setLimits({ maxFileBytes: 1_024 });
  const g = h.tree.get(id)!.g;

  h.queue.enqueue(id);
  await h.queue.drain();

  const f = h.tree.get(id)!;
  assert.equal(f.x, g, 'tombstoned, so no peer keeps it in a Pending list for ever');
  assert.equal(f.s, undefined, 'and it was never published');
  assert.equal(f.xb, 'Ada');
  assert.deepEqual(h.state.data.oversized[fold(`${SHARE}/scan.tiff`)], {
    bytes: bytes.length, cap: 1_024, why: 'server',
  });
  assert.equal(h.state.data.materialized[id], undefined, 'unbound: no tombstone may claim it');
  assert.deepEqual(
    h.vault.binarySnapshot()[`${SHARE}/scan.tiff`], bytes,
    'the file is not moved, not trashed, not truncated',
  );
  assert.equal(h.vault.wasTrashed(`${SHARE}/scan.tiff`), false);
  assert.equal(h.blobs.callsTo('put').length, 0, 'and nothing was uploaded');
  assert.equal(h.state.data.publish[id].state, 'done', 'the entry is closed, not retried for ever');
  assert.equal(h.notices.length, 1, 'the user is told exactly once');
  assert.match(h.notices[0], /scan\.tiff/);
});

// ⚠ B24, the publish arm: the cap is checked BEFORE the bytes are allocated. A
// cap enforced after `readBinary` is no cap at all on the device it protects —
// the phone is already out of memory by then.
test('B24: a file over the device cap is retracted without ever being read', async () => {
  const h = makeHarness({ memoryCapBytes: () => 100 });
  const id = h.addBlob('clip.mov', png(2, 512));

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.vault.callsTo('readBinary').length, 0, 'never held in memory');
  assert.equal(h.blobs.calls.length, 0, 'and the store was never asked about it');
  assert.equal(h.state.data.oversized[fold(`${SHARE}/clip.mov`)]?.why, 'device');
  assert.equal(h.tree.get(id)!.x, 1);
});

// I2, in the one place where it cannot be undone by a later pass: an unknown
// ceiling must never be read as a small one.
test('a limits() that could not be asked does not retract anything', async () => {
  const h = makeHarness();
  const bytes = png();
  const id = h.addBlob('diagram.png', bytes);
  h.blobs.failNext('limits', new Error('ETIMEDOUT'));

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.tree.get(id)!.x, undefined, 'the node is still live');
  assert.deepEqual(h.state.data.oversized, {});
  assert.equal(
    h.tree.get(id)!.b, refOf(await hashOfBytes(bytes), bytes.length),
    'and the publish went ahead: a server that really refuses it answers 413',
  );
});

// ---------------------------------------------------------------- the ladder, with intent

// A13's other half. `fail` must carry the intent forward, or the very next
// requeue for the same bytes reads as new work and resets `attempts` to zero —
// and §3.5 requeues on EVERY reconcile pass, so the ladder would never advance.
test('a failed attachment publish keeps its intent, so requeueing cannot reset the ladder', async () => {
  const h = makeHarness();
  const bytes = png();
  const id = h.addBlob('diagram.png', bytes);
  const sha = await hashOfBytes(bytes);
  h.blobs.failNext('has', new Error('ECONNRESET'));

  h.queue.requeue(id, sha);
  await h.queue.drain();

  assert.equal(h.state.data.publish[id].attempts, 1);
  assert.equal(h.state.data.publish[id].intent, sha, 'the entry still knows what it is publishing');

  h.queue.requeue(id, sha);
  assert.equal(h.state.data.publish[id].attempts, 1, 'a same-intent requeue is still a no-op');
  assert.equal(h.state.data.publish[id].nextAt, NOW + PUBLISH_BACKOFF_MS[0]);
});

// One 200 MB upload must not occupy every slot and park the publication of every
// note in the vault behind it.
test('attachments drain in their own lane, and notes keep theirs', async () => {
  const h = makeHarness();
  for (let i = 0; i < 6; i++) h.addBlob(`img-${i}.png`, png(i));
  for (let i = 0; i < 6; i++) h.add(`note-${i}.md`, `body ${i}`);

  let inFlight = 0;
  let peak = 0;
  const gated = blobPortOf(h.blobs, {
    has: async (sha) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      const answer = await h.blobs.has(sha);
      inFlight -= 1;
      return answer;
    },
  });
  const q = new PublishQueue({
    docs: h.docs, vault: h.vault, blobs: gated, state: h.state, tree: h.tree,
    openNodeId: () => null, now: () => h.clock.now, settleMs: 0,
  });

  for (const id of Object.keys(h.state.data.owned)) q.enqueue(id);
  await q.drain();

  assert.equal(peak, BLOB_PUBLISH_CONCURRENCY, 'the attachment lane is capped at its own width');
  assert.equal(q.pendingCount(), 0, 'and everything published');
});
