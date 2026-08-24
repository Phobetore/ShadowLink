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

import { PUBLISH_BACKOFF_MS, PUBLISH_CONCURRENCY } from '../tree/constants.ts';
import { hashOf } from '../tree/paths.ts';
import { TreeDoc } from '../tree/TreeDoc.ts';
import { DeviceState, type StatePort } from './DeviceState.ts';
import type { DocHandle, DocPort } from './DocPort.ts';
import { FakeDocs, FakeVault } from './fakes.ts';
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
  state: DeviceState;
  tree: TreeDoc;
  port: MemoryStatePort;
  queue: PublishQueue;
  /** Mutable clock, so a backoff can be waited out without a real timer. */
  clock: { now: number };
  open: { id: string | null };
  /** Mint an owned, materialized, unpublished node holding `text` on disk. */
  add(name: string, text: string): string;
}

function makeHarness(over: Partial<PublishQueueDeps> = {}): Harness {
  const vault = new FakeVault();
  const docs = new FakeDocs();
  const port = new MemoryStatePort();
  const clock = { now: NOW };
  const open: { id: string | null } = { id: null };
  const state = new DeviceState(port, 'device-1', 'ws-1', () => clock.now, 0);
  const tree = new TreeDoc();
  vault.seed(SHARE, 'd');

  const queue = new PublishQueue({
    docs,
    vault,
    state,
    tree,
    openNodeId: () => open.id,
    now: () => clock.now,
    ...over,
  });

  return {
    vault, docs, state, tree, port, queue, clock, open,
    add(name, text) {
      const id = tree.createNode({ k: 'f', d: '', n: name }, clock.now);
      vault.seed(`${SHARE}/${name}`, 'f', text);
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
    create: (p, d) => inner.create(p, d),
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
    docs: racing, vault: h.vault, state: h.state, tree: h.tree,
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
    docs: gated, vault: h.vault, state: h.state, tree: h.tree,
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
    docs: gated, vault: h.vault, state: h.state, tree: h.tree,
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
    docs: h.docs, vault: locked, state: h.state, tree: h.tree,
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
