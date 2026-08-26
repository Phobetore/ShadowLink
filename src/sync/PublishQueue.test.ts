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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOB_PUBLISH_CONCURRENCY, PUBLISH_BACKOFF_MS, PUBLISH_CONCURRENCY, RECOVERED_DIR,
} from '../tree/constants.ts';
import { fold, hashOf, hashOfBytes, isLive, relPath, validateRel } from '../tree/paths.ts';
import { TreeDoc } from '../tree/TreeDoc.ts';
import { DIR_SENTINEL, deriveTree } from '../tree/TreeIndex.ts';
import type { NodeFields } from '../tree/types.ts';
import { BlobQuotaExceeded, type BlobPort } from './BlobPort.ts';
import { Deletions } from './Deletions.ts';
import { DeviceState, type StatePort } from './DeviceState.ts';
import { DiskIndex } from './DiskIndex.ts';
import type { DocHandle, DocPort } from './DocPort.ts';
import {
  DESKTOP_MEMORY_CAP, DESKTOP_PASS_LIMITS, FakeBlobs, FakeDocs, FakeVault,
} from './fakes.ts';
import { PublishQueue, type PublishQueueDeps } from './PublishQueue.ts';
import { Reconciler, type DeletionContext, type ReconcileFailure } from './Reconciler.ts';
import { Tickets } from './Tickets.ts';
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
    ...DESKTOP_MEMORY_CAP,
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

/**
 * Spin the event loop until `ready()` holds.
 *
 * Bounded and loud: a lane that never fills must fail with the reason rather than
 * hang the suite until the runner's own timeout reports nothing useful.
 */
async function until(ready: () => boolean, why: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (ready()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${why}`);
}

/** A latch a test opens by hand: work parks on `open` until `release` is called. */
function gate(): { open: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const open = new Promise<void>((resolve) => { release = () => { resolve(); }; });
  return { open, release };
}

/** How many nodes of `kind` the tree currently reports as published. */
function publishedCount(h: Harness, kind: 'f' | 'b'): number {
  return h.tree.entries().filter(([, f]) => f.k === kind && f.s === 1).length;
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

/**
 * I17, asserted against the two places the invariant actually names.
 *
 * A base is a claim that these exact bytes are simultaneously in the WORKSPACE and
 * on THIS DISK. A test that spells the expected sha256 out as a literal cannot
 * tell the two apart — it passes just as happily when the literal is the remote
 * document's text and the disk holds something else, which is precisely the bug
 * this file used to assert. So the expectation is read back from the disk and from
 * the content doc rather than written down.
 */
async function assertBaseIsOnDisk(h: Harness, id: string): Promise<void> {
  const path = h.state.data.materialized[id];
  const onDisk = normLF(await h.vault.read(path));
  const inWorkspace = normLF(h.docs.text(`n_${id}`));
  const base = h.state.data.contentHash[id];
  assert.ok(base !== undefined, `no base was recorded for ${path}`);
  assert.equal(base.sha256, await hashOf(onDisk), `the base does not name what is on disk (${path})`);
  assert.equal(base.len, onDisk.length, `the base's length is not the disk's (${path})`);
  assert.equal(onDisk, inWorkspace, `the disk and the workspace differ, so there is no base to name`);
}

/** I18, exactly as the engine applies it: compare and hash on normalized endings. */
function normLF(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** What a peer's reconcile pass left in its own vault. */
interface PeerVault {
  /** Every file the peer holds, path -> text. Folders are not files. */
  files: Record<string, string>;
  notices: string[];
}

/**
 * Run the REAL reconciler on a second device against the tree this harness's queue
 * just wrote — its own vault, its own device state, and the SAME `FakeDocs`,
 * because one workspace has one content document and the peer opens the very room
 * the publish arm just touched.
 *
 * A queue test can only assert what the tree says. What `s` MEANS happens on the
 * other machine, and for a note it means exactly one thing: `Reconciler.materialize`
 * writes the document's text to the canonical path. That is the assertion worth
 * having, because a 0-byte file there is the harm — not the bit in the tree.
 */
async function peerReconcile(h: Harness): Promise<PeerVault> {
  const vault = new FakeVault();
  vault.seed(SHARE, 'd');
  const now = (): number => h.clock.now;
  const state = new DeviceState(new MemoryStatePort(), 'device-2', 'ws-1', now, 0);
  const notices: string[] = [];

  const reconciler = new Reconciler({
    ...DESKTOP_PASS_LIMITS,
    vault,
    docs: h.docs,
    blobs: h.blobs,
    state,
    tickets: new Tickets(now),
    shareRoot: SHARE,
    entries: () => h.tree.entries(),
    notice: (m) => { notices.push(m); },
    now,
  });
  await reconciler.reconcile('remote');

  return { files: vault.snapshot(), notices };
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

test('a file holding a lone \\r seeds a document that holds none (I18)', async () => {
  // The queue is one of only two writers that put disk bytes into a content
  // document, so it is one of the two places the "a content document contains no
  // `\r`, ever" guarantee is made. The normalizer here handled `\r\n` and not a
  // lone `\r`, so a classic-Mac file seeded a document that could never afterwards
  // be bound into an editor: CodeMirror normalizes both, the two sides never
  // compared equal, and the note refused to mount for the rest of its life.
  const h = makeHarness();
  const id = h.add('mac.md', 'one\rtwo\r\nthree');

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.docs.text(`n_${id}`), 'one\ntwo\nthree');
  assert.equal(h.tree.get(id)!.s, 1);
  assert.deepEqual(h.state.data.contentHash[id], {
    sha256: await hashOf('one\ntwo\nthree'),
    len: 'one\ntwo\nthree'.length,
  }, 'and the base names the normalized form, which is the only form there is');
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
  // KEPT AND REPORTED, NEVER DROPPED — and this assertion used to read
  // `pendingCount() === 1`, which is where the entry was reported and it was the
  // wrong number: nothing about this entry is waiting to upload, and no amount
  // of waiting changes it, so the status bar promised an upload for the lifetime
  // of the vault. Kept is the half that matters and it is unchanged.
  assert.deepEqual(h.state.data.publish[id].state, 'pending', 'the entry is kept');
  assert.equal(h.queue.pendingCount(), 0, 'and is not an upload in progress');
  assert.deepEqual(h.queue.blocked().map((b) => b.id), [id], 'it is reported here instead');
  assert.notEqual(h.queue.lastError(id), undefined, 'and it is not invisible');
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
    ...DESKTOP_MEMORY_CAP,
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
  // The node IS published — by the other device.
  assert.equal(h.tree.get(id)!.s, 1);
  // ⚠ CHANGED, deliberately. This used to read "so the watermark is the remote
  // text, never the local text this device happened to be holding", and assert
  // `contentHash = hash('someone else got here first')`. That is the second site
  // of the lying watermark: I17 says a base names bytes simultaneously in the
  // WORKSPACE and on THIS DISK, and here the disk holds 'my local copy'. Recording
  // the remote's hash makes the base describe a file that is not there — and
  // recording the local's would let `isProvenNote` trash unpublished work. Neither
  // is true, so neither is written. The full argument, with the deletion pass that
  // measures the cost, is in "a base is not recorded for a remote text this disk
  // does not hold (I17)" below.
  assert.equal(
    h.state.data.contentHash[id], undefined,
    'no bytes are in the workspace and on this disk at once, so there is no base',
  );
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
    ...DESKTOP_MEMORY_CAP,
  });

  q.enqueue(id);
  await q.drain();

  assert.equal(h.docs.text(`n_${id}`), 'a peer won the race', 'nothing was concatenated (I5)');
  assert.equal(h.tree.get(id)!.s, undefined, 'and no watermark from a guess');
  assert.equal(h.state.data.publish[id].state, 'pending', 'it is retried instead');
});

// ------------------------------------------------ I6: an empty note is a note mid-write

/**
 * ⚠ The defect that corrupted the first real share, and the reason `s` may not
 * mean "a flush came back".
 *
 * Obsidian's "New note" writes a ZERO-BYTE file and opens it, so for as long as it
 * takes the author to reach for the keyboard the vault holds a real, ordinary,
 * empty note. A drain in that window seeds nothing — `remote.length === 0 &&
 * text.length > 0` is false — flushes an empty document, which round-trips
 * perfectly, and marks the node published anyway.
 *
 * `s === 1` is the WHOLE definition of "published" for a note (`isPublished`), so
 * every peer promotes the node out of `pending` and materializes it, and
 * materializing a document that holds nothing writes a 0-byte file on the
 * canonical path. `Reconciler`'s own comment states the rule that breaks: a
 * zero-byte file there is "worse than no file, because it looks correct and gets
 * deleted by hand". The hand deletion is a tombstone, and the tombstone propagates
 * to everyone — including the author, who was still typing.
 *
 * The attachment arm has refused exactly this since P2 ("a zero-byte file is never
 * published, however settled it looks"). This is the same refusal, for the arm
 * where the consequence is worse: a 0-byte attachment is obviously broken, a
 * 0-byte note looks like a note the user emptied.
 */
test('an empty note is not published, and no peer writes a 0-byte decoy (I6)', async () => {
  const h = makeHarness();
  const id = h.add('Sans titre.md', '');                  // Obsidian's "New note"

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.tree.get(id)!.s, undefined, 'an empty document is not published content');
  assert.equal(h.state.data.contentHash[id], undefined, 'and names no bytes anybody could hold');
  // Refusing is not failing. A rung of the ladder would park the note for minutes
  // after the author's first keystroke, over a condition their next keystroke ends.
  assert.equal(h.state.data.publish[id].state, 'pending', 'the publish is still owed');
  assert.equal(h.state.data.publish[id].attempts, 0, 'and no rung of the ladder was charged');
  assert.deepEqual(h.notices, [], 'an empty note is ordinary; nobody is warned about one');

  // Refusing to PUBLISH is not refusing to EXIST. The node keeps its id, its name
  // and its place in the tree; what a peer sees is a node under Pending.
  const derived = deriveTree(h.tree.entries());
  assert.deepEqual(derived.pending, [id], 'peers list it as pending, not as a file');
  assert.equal(derived.files.has(id), false, 'so nothing is ever materialized for it');

  // And the real reconciler on the other device, over the tree this drain wrote.
  const ben = await peerReconcile(h);
  assert.deepEqual(ben.files, {}, 'nothing at the canonical path — not even 0 bytes');
  assert.deepEqual(ben.notices, [], 'and the peer is told nothing about a note being written');
});

test('a node the session published itself stops being work the queue owes (I7)', async () => {
  // `publishOne` defers on a node the session holds open, and a deferral is "not
  // now" rather than "not ever", so the entry stays pending and stays counted.
  // The session publishes a brand-new note the moment it has a byte in it — it
  // has to, because the queue may not touch a live document — so it is the one
  // writer of `s` that owes the queue an answer. Without one, a note held open
  // asks the reconciler for a full pass every 30 seconds for as long as it is
  // open, and the status bar says "1 file waiting to upload" the whole time.
  const h = makeHarness();
  const id = h.add('Untitled.md', 'the author started typing');
  h.queue.enqueue(id);
  h.open.id = id;

  await h.queue.drain();
  assert.equal(h.queue.pendingCount(), 1, 'a deferral is still an upload this device owes');

  h.tree.patchNode(id, { s: 1 });                        // what the session does
  h.queue.markPublished(id);

  assert.deepEqual(h.state.data.publish[id], { state: 'done', attempts: 0, nextAt: 0 });
  assert.equal(h.queue.pendingCount(), 0);
  assert.deepEqual(h.queue.parked(), []);
  assert.equal(h.queue.lastError(id), undefined);
});

/**
 * The other half of the refusal, and the regression it would be easy to ship.
 *
 * A note that is empty when it is created is the NORMAL case, not an edge one, so
 * "an empty note is never published" must not mean "a note created empty is never
 * published". Nothing re-admits the node — `enqueue` is a deliberate no-op for a
 * node that already has an entry — so the pending entry the refusal leaves behind
 * is the entire mechanism, and the next drain must be all it takes.
 */
test('the same note publishes itself as soon as it has a byte in it', async () => {
  const h = makeHarness();
  const id = h.add('Sans titre.md', '');

  h.queue.enqueue(id);
  await h.queue.drain();
  assert.equal(h.tree.get(id)!.s, undefined, 'refused while it was empty');

  // The author types. `enqueue` refuses the node — it already has an entry — so
  // what publishes it is the entry the refusal kept, and nothing else.
  h.vault.seed(`${SHARE}/Sans titre.md`, 'f', 'the first line');
  h.queue.enqueue(id);
  assert.equal(h.state.data.publish[id].attempts, 0, 're-admission changed nothing');
  await h.queue.drain();

  assert.equal(h.docs.text(`n_${id}`), 'the first line', 'the document is seeded now');
  assert.equal(h.tree.get(id)!.s, 1, 'and the node is published');
  await assertBaseIsOnDisk(h, id);
  assert.equal(h.state.data.publish[id].state, 'done');
  assert.equal(h.docs.totalOpens(`n_${id}`), 2, 'one open per drain, and no seed was lost');

  const ben = await peerReconcile(h);
  assert.deepEqual(
    ben.files, { [`${SHARE}/Sans titre.md`]: 'the first line' },
    'and the peer materializes the note the author wrote, not a decoy',
  );
});

/**
 * ⚠ The regression the refusal above ships on its own, and the reason `parked`
 * exists.
 *
 * A refused entry stays `pending` on purpose — nothing else will ever re-offer
 * the node, because `VaultWatcher.onModify` returns early for notes, so the
 * 30-second retry IS the mechanism that publishes it after the first keystroke.
 * But the status bar reads `pendingCount()` and says "ShadowLink: syncing…" /
 * "N file(s) waiting to upload" for as long as it is above zero, and never
 * reaches `syncedStatus()`.
 *
 * So one permanently-empty note in the share pins the status bar on "syncing…"
 * for the lifetime of the vault. A note created and deleted before its first
 * character is worse: publish entries are never pruned, so nothing can ever
 * clear it.
 *
 * An empty note is not waiting to upload. There is nothing to upload.
 */
test('an empty note does not pin the status bar on "syncing…" for ever', async () => {
  const h = makeHarness();
  const id = h.add('Sans titre.md', '');

  h.queue.enqueue(id);
  await h.queue.drain();

  // Both halves matter, and they point in opposite directions.
  assert.equal(h.state.data.publish[id].state, 'pending', 'the entry stays: it is the retry');
  assert.equal(h.queue.pendingCount(), 0, 'and nothing is reported as waiting to upload');
  assert.deepEqual(h.queue.parked(), [{ id, reason: 'empty' }], 'it is not invisible either');
});

test('a parked note rejoins the count the moment a drain sees content in it', async () => {
  const h = makeHarness();
  const id = h.add('Sans titre.md', '');
  h.queue.enqueue(id);
  await h.queue.drain();
  assert.deepEqual(h.queue.parked(), [{ id, reason: 'empty' }]);

  h.vault.seed(`${SHARE}/Sans titre.md`, 'f', 'the first line');
  await h.queue.drain();

  assert.equal(h.tree.get(id)!.s, 1, 'the note published on the retry, as designed');
  assert.deepEqual(h.queue.parked(), [], 'and the park went with it');
  assert.equal(h.queue.pendingCount(), 0);
});

test('a note that is not text is parked too, and stops pinning the bar as well', async () => {
  // The same permanent shape, and it predates the empty-note refusal: a `.md`
  // node over bytes that are not UTF-8 is refused on every drain for ever, and
  // the file has to be renamed by hand before that can change. The user is told
  // once, by Notice. The status bar has nothing to add and no business claiming
  // an upload is in progress.
  const h = makeHarness();
  const notText = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc0, 0x80]);
  const id = h.tree.createNode({ k: 'f', d: '', n: 'notes.md' }, NOW);
  h.vault.seedBinary(`${SHARE}/notes.md`, notText);
  h.state.data.owned[id] = true;
  h.state.data.materialized[id] = `${SHARE}/notes.md`;
  h.queue.enqueue(id);

  await h.queue.drain();

  assert.equal(h.state.data.publish[id].state, 'pending', 'still retried');
  assert.deepEqual(h.queue.parked(), [{ id, reason: 'not-text' }]);
  assert.equal(h.queue.pendingCount(), 0, 'and not counted as an upload in progress');
  assert.ok(h.queue.lastError(id) !== undefined, 'the reason is still in diagnostics');
});

/**
 * ⚠ The regression the PARK ships on its own, and it is worse than the one the
 * park fixed.
 *
 * Nothing else in the plugin ever re-offers a note. `VaultWatcher.onModify`
 * returns early for one by design (I7), so `main.ts`'s 30-second interval is the
 * ONLY periodic drain there is — and that interval asks `pendingCount() > 0`.
 * Take parked entries out of that number without giving the interval a second
 * question, and the drain can never reach them again: an empty note publishes
 * itself on the first keystroke and then never, and a `.md` file the user
 * renames back to text stays refused for the lifetime of the vault.
 *
 * `repark()` is that second question, and it is a `stat` per parked entry —
 * typically zero of them — rather than a full pass, because an idle vault
 * holding one permanently empty note would otherwise pay a tree derivation and a
 * stat per attachment every 30 seconds for ever.
 */
test('a park is not a grave: repark is what lets the drain reach one again', async () => {
  const h = makeHarness();
  const id = h.add('Sans titre.md', '');
  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.queue.pendingCount(), 0, 'the interval\'s first question says nothing is owed');
  assert.equal(await h.queue.repark(), false, 'and its second agrees while the file is empty');
  assert.equal(h.vault.callsTo('stat').length > 0, true, 'having actually looked at the file');

  h.vault.seed(`${SHARE}/Sans titre.md`, 'f', 'the first line');

  assert.equal(await h.queue.repark(), true, 'the file changed, so there is work again');
  assert.equal(h.queue.pendingCount(), 1, 'and the bar says so too');
  await h.queue.drain();
  assert.equal(h.tree.get(id)!.s, 1);
  assert.deepEqual(h.queue.parked(), []);
});

test('an ordinary drain does not destroy a park it cannot lift', async () => {
  // The two halves this round built disagreed, and the drain won. `publishOne`
  // unparked BEFORE it looked at the path, so an entry whose file has gone —
  // the exact case the park exists for, a note created and deleted before its
  // first character — was unparked, failed, left pending, and counted for ever.
  // `repark` gets the same case right: it skips an entry with no bound path.
  //
  // The drain is not hypothetical. Every reconcile pass ends in one.
  const h = makeHarness();
  const id = h.add('Sans titre.md', '');
  h.queue.enqueue(id);
  await h.queue.drain();
  assert.deepEqual(h.queue.parked().map((p) => p.id), [id]);
  assert.equal(h.queue.pendingCount(), 0, 'the bar reads "synced"');

  // The user deletes the empty note: the watcher tombstones it and unbinds it.
  await h.vault.trashLocal(`${SHARE}/Sans titre.md`);
  delete h.state.data.materialized[id];

  assert.equal(await h.queue.repark(), false, 'repark leaves an entry it cannot look at');
  assert.equal(h.queue.pendingCount(), 0, 'and the bar is still honest');

  await h.queue.drain();
  assert.equal(h.queue.pendingCount(), 0, 'ONE ordinary drain must not contradict repark');

  // And it stays that way however long the vault runs.
  for (let i = 0; i < 6; i++) {
    h.clock.now += 3_600_000;
    await h.queue.drain();
    await h.queue.repark();
  }
  assert.equal(h.queue.pendingCount(), 0,
    'nothing is owed for a note that does not exist, at any point');
});

/**
 * FOUR STATES NOTHING CAN EVER LIFT, and `park` cannot express any of them.
 *
 * `park` says "the user's file can lift this" — an empty note, a `.md` file that
 * is not text — and `repark` is how the drain reaches one again. There was no
 * state for "nothing can lift this", so a dead node, an unowned entry and a
 * deleted attachment all stayed `pending` and counted for ever, and because no
 * rung of the ladder is charged on those paths `stalled()` was empty and
 * `lastError` was undefined, so they were invisible in diagnostics as well.
 *
 * Every one of these winds the clock past every rung of the ladder and drains
 * again, because "for ever" is the claim being tested.
 */
async function drainForYears(h: Harness): Promise<void> {
  for (let i = 0; i < 8; i++) {
    h.clock.now += 3_600_000;
    await h.queue.drain();
    await h.queue.repark();
  }
}

test('a note deleted before its first character stops being work', async () => {
  const h = makeHarness();
  const id = h.add('Sans titre.md', '');
  h.queue.enqueue(id);

  // The user deletes it: the watcher tombstones the node and unbinds the file.
  h.tree.patchNode(id, { x: h.tree.get(id)!.g });
  await h.vault.trashLocal(`${SHARE}/Sans titre.md`);
  delete h.state.data.materialized[id];

  await h.queue.drain();
  assert.equal(h.queue.pendingCount(), 0, 'nothing is owed for a note that does not exist');
  assert.deepEqual(h.queue.parked(), [], 'and nothing is offered to the user to fix');
  assert.notEqual(h.queue.lastError(id), undefined, 'but it is not invisible either');
  assert.deepEqual(h.queue.blocked().map((b) => b.id), [id]);

  await drainForYears(h);
  assert.equal(h.queue.pendingCount(), 0);
});

test('an attachment deleted before it publishes stops being work', async () => {
  const h = makeHarness();
  const id = h.addBlob('clip.png', new Uint8Array([1, 2, 3, 4]));
  h.queue.enqueue(id);
  h.tree.patchNode(id, { x: h.tree.get(id)!.g });

  await h.queue.drain();
  assert.equal(h.queue.pendingCount(), 0);
  assert.notEqual(h.queue.lastError(id), undefined);
  assert.deepEqual(h.queue.blocked().map((b) => b.id), [id]);

  await drainForYears(h);
  assert.equal(h.queue.pendingCount(), 0);
});

test('an entry for a node this device does not own stops being work', async () => {
  // The restart case the I5 re-check exists for: an entry read back from a state
  // file written before ownership was resolved.
  const h = makeHarness();
  const id = h.add('theirs.md', 'a peer wrote this');
  h.queue.enqueue(id);
  delete h.state.data.owned[id];

  await h.queue.drain();
  assert.equal(h.queue.pendingCount(), 0);
  assert.notEqual(h.queue.lastError(id), undefined);

  await drainForYears(h);
  assert.equal(h.queue.pendingCount(), 0);

  // And it is a conclusion, not a verdict: ownership arriving makes it work again.
  h.state.data.owned[id] = true;
  assert.equal(await h.queue.repark(), true, 'the drain is asked for, once there is work');
  assert.equal(h.queue.pendingCount(), 1);
  await h.queue.drain();
  assert.equal(h.tree.get(id)!.s, 1);
  assert.deepEqual(h.queue.blocked(), []);
});

test('a stat that cannot answer leaves the entry parked (I2)', async () => {
  // "I could not look" must never become "assume it changed": an unparked entry
  // that is still empty is a drain that publishes nothing and re-parks, on a
  // 30-second cadence, for as long as the filesystem is unhappy.
  const inner = new FakeVault();
  const blind = { on: false };
  const h = makeHarness({
    vault: {
      ...portOf(inner),
      stat: (path: string) => (blind.on
        ? Promise.reject(new Error('EIO'))
        : inner.stat(path)),
    },
  });
  const id = h.tree.createNode({ k: 'f', d: '', n: 'Sans titre.md' }, NOW);
  inner.seed(SHARE, 'd');
  inner.seed(`${SHARE}/Sans titre.md`, 'f', '');
  h.state.data.owned[id] = true;
  h.state.data.materialized[id] = `${SHARE}/Sans titre.md`;
  h.queue.enqueue(id);
  await h.queue.drain();
  assert.deepEqual(h.queue.parked().map((p) => p.id), [id], 'parked while it is empty');

  // The author types, and the filesystem stops answering in the same moment.
  inner.seed(`${SHARE}/Sans titre.md`, 'f', 'the first line');
  blind.on = true;

  assert.equal(await h.queue.repark(), false, 'a stat that throws unparks nothing');
  assert.equal(h.queue.pendingCount(), 0);
  assert.deepEqual(h.queue.parked().map((p) => p.id), [id], 'and the entry is still there');

  blind.on = false;
  assert.equal(await h.queue.repark(), true, 'once it can look again, the work is found');
});

test('parked entries carry the reason, because the two are worded differently', async () => {
  const h = makeHarness();
  const empty = h.add('Sans titre.md', '');
  const notText = h.tree.createNode({ k: 'f', d: '', n: 'notes.md' }, NOW);
  h.vault.seedBinary(`${SHARE}/notes.md`, new Uint8Array([0xff, 0xfe, 0xc0, 0x80]));
  h.state.data.owned[notText] = true;
  h.state.data.materialized[notText] = `${SHARE}/notes.md`;
  h.queue.enqueue(empty);
  h.queue.enqueue(notText);

  await h.queue.drain();

  const parked = h.queue.parked();
  assert.equal(parked.length, 2);
  assert.equal(parked.find((p) => p.id === empty)?.reason, 'empty');
  assert.equal(parked.find((p) => p.id === notText)?.reason, 'not-text');
});

test('a note that is not text unparks when its size or mtime moves', async () => {
  const h = makeHarness();
  const id = h.tree.createNode({ k: 'f', d: '', n: 'notes.md' }, NOW);
  h.vault.seedBinary(`${SHARE}/notes.md`, new Uint8Array([0xff, 0xfe, 0xc0, 0x80]));
  h.state.data.owned[id] = true;
  h.state.data.materialized[id] = `${SHARE}/notes.md`;
  h.queue.enqueue(id);
  await h.queue.drain();
  assert.equal(await h.queue.repark(), false, 'nothing about the file has moved');

  h.vault.seed(`${SHARE}/notes.md`, 'f', 'the user fixed it by hand');

  assert.equal(await h.queue.repark(), true);
  await h.queue.drain();
  assert.equal(h.tree.get(id)!.s, 1);
});

test('a note deferred because it is open is still an upload this device owes', async () => {
  // The line the park must not cross. Deferring a note the user has open (I7) is
  // "not now", not "not ever": closing the tab is all it takes, and the file is
  // full of the user's words in the meantime. That IS a file waiting to upload.
  const h = makeHarness();
  const id = h.add('open.md', 'a note the user is looking at');
  h.open.id = id;

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.tree.get(id)!.s, undefined, 'nothing was published under the binding');
  assert.deepEqual(h.queue.parked(), [], 'and it was not parked');
  assert.equal(h.queue.pendingCount(), 1, 'the status bar is right to say so');
});

/**
 * ⚠ I17's second site, and the sharper half of it: a base is a claim that these
 * exact bytes are simultaneously IN THE WORKSPACE and ON THIS DISK.
 *
 * When the content doc already holds a peer's text, the queue publishes nothing
 * and marks the node `s: 1` — correctly, the workspace really does hold published
 * content. But the disk still holds this device's own copy, so there are no bytes
 * that satisfy both halves, and there is therefore no base to record. Both
 * available answers are lies with different victims:
 *
 *  * the REMOTE's hash names bytes this disk does not hold — every reader of the
 *    base is then reasoning about a file that is not there;
 *  * the LOCAL's hash names bytes the workspace does not hold — and that one has
 *    teeth, because `isProvenNote` compares the base with the disk, finds they
 *    agree, and lets the deletion pass TRASH unpublished local work that no peer
 *    can give back.
 *
 * So: no base. Ignorance is the answer that keeps the file, and the pass below is
 * the real `Deletions` proving it.
 */
test('a base is not recorded for a remote text this disk does not hold (I17)', async () => {
  const h = makeHarness();
  const local = 'my own unpublished draft';                       // 24
  const remote = 'the body a peer published first, which is longer';  // 48
  const id = h.add('todo.md', local);
  h.docs.setText(`n_${id}`, remote);

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.docs.text(`n_${id}`), remote, 'the remote copy stands (I5)');
  assert.equal(h.tree.get(id)!.s, 1, 'and the node IS published — by the other device');
  assert.equal(
    h.state.data.contentHash[id], undefined,
    'but no bytes are in the workspace and on this disk at once, so no base is recorded',
  );
  assert.equal(h.state.data.publish[id].state, 'done');

  // What the missing base is worth. Somebody deletes the node; this device's copy
  // is 24 bytes of work that is in no content doc anywhere.
  const f = h.tree.get(id)!;
  h.tree.patchNode(id, { x: f.g, xa: h.clock.now, xb: 'Ben' });
  const verdict = await deletionPassHere(h, `${SHARE}/todo.md`);

  assert.equal(verdict.batch, 1, 'the tombstone is acted on');
  assert.equal(verdict.trashed, false, 'the unpublished draft is not trashed');
  assert.equal(verdict.rescued, true, 'it is moved aside into ShadowLink Recovered/ instead');
  const rescued = Object.entries(h.vault.snapshot())
    .filter(([p]) => p.startsWith(`${RECOVERED_DIR}/`))
    .map(([, text]) => text);
  assert.deepEqual(rescued, [local], 'with the bytes the user actually had');
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
    ...DESKTOP_MEMORY_CAP,
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
    ...DESKTOP_MEMORY_CAP,
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
    ...DESKTOP_MEMORY_CAP,
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

/** What a peer's deletion pass did with the tree this queue produced. */
interface PeerVerdict {
  /** How many tombstones `collectDeletable` was willing to act on. */
  batch: number;
  trashed: boolean;
  /** Moved aside into `ShadowLink Recovered/`. */
  rescued: boolean;
  /** The bytes still at the shared path afterwards, or undefined if it is gone. */
  onDisk: Uint8Array | undefined;
  notices: string[];
}

/**
 * Run the REAL deletion pass on a second device against the tree this harness's
 * queue just wrote.
 *
 * A queue test can only assert what the tree says; the harm a bad tombstone does
 * happens on the other machine, so this builds Ben: his own vault holding the
 * last published version, his own device state with the node bound and its base
 * recorded, and the SAME content-addressed store Ada uploaded to.
 */
async function peerDeletionPass(
  h: Harness, id: string, name: string, bytes: Uint8Array,
): Promise<PeerVerdict> {
  const path = `${SHARE}/${name}`;
  const vault = new FakeVault();
  vault.seed(SHARE, 'd');
  vault.seedBinary(path, bytes);

  const now = (): number => h.clock.now;
  const state = new DeviceState(new MemoryStatePort(), 'device-2', 'ws-1', now, 0);
  const notices: string[] = [];
  state.data.materialized[id] = path;                      // Ben materialized it (§3.3)
  const st = (await vault.stat(path))!;
  state.data.contentHash[id] = {
    sha256: await hashOfBytes(bytes), len: bytes.length, mtime: st.mtime,
  };
  vault.resetCalls();

  return await runDeletionPass(h, vault, state, path, notices);
}

/**
 * The same pass, on THIS device, over the vault and device state the queue has
 * just been publishing from.
 *
 * The queue writes the base a later deletion reads, so "what does a tombstone do
 * to the file this device is holding?" is a question about the queue's own output
 * and not only about a peer's. `isProvenNote` is three clauses — `s`, the recorded
 * base, and the disk — and the queue writes two of them.
 */
async function deletionPassHere(h: Harness, path: string): Promise<PeerVerdict> {
  h.vault.resetCalls();
  return await runDeletionPass(h, h.vault, h.state, path, h.notices);
}

/**
 * The `DeletionContext` a reconcile pass assembles, spelled out here the way
 * `Reconciler.describeDesiredState` spells it out rather than shared with it, so a
 * change to either one shows up as a difference instead of as a silently agreeing
 * abstraction. Shared between the two callers ABOVE, which are the same pass on
 * two devices and must not drift apart from each other.
 */
async function runDeletionPass(
  h: Harness, vault: FakeVault, state: DeviceState, path: string, notices: string[],
): Promise<PeerVerdict> {
  const now = (): number => h.clock.now;
  const tickets = new Tickets(now);

  const entries = h.tree.entries();
  const derived = deriveTree(entries);
  const wantAtFold = new Map<string, string>();
  for (const [nodeId, rel] of derived.files) wantAtFold.set(fold(`${SHARE}/${rel}`), nodeId);
  for (const rel of derived.folders) wantAtFold.set(fold(`${SHARE}/${rel}`), DIR_SENTINEL);

  const deadNodes = new Map<string, NodeFields>();
  const deadFold = new Set<string>();
  for (const [nodeId, f] of entries) {
    if (!validateRel(f.d, f.n, f.k)) continue;
    if (isLive(f)) continue;
    deadNodes.set(nodeId, f);
    deadFold.add(fold(`${SHARE}/${relPath(f)}`));
  }

  const disk = DiskIndex.build(vault, SHARE);
  const have = new Map<string, string>();
  for (const [nodeId, p] of Object.entries(state.data.materialized)) {
    const literal = disk.literal(p);
    if (literal !== undefined) have.set(nodeId, literal);
  }

  const failures: ReconcileFailure[] = [];
  const ctx: DeletionContext = {
    cause: 'remote',
    deadNodes,
    deadFold,
    wantAtFold,
    have,
    blobRefs: derived.blobs,
    disk,
    failures,
    removedThisPass: new Set<string>(),
    vault,
    blobs: h.blobs,
    docs: h.docs,
    state,
    tickets,
    shareRoot: SHARE,
    notice: (msg: string) => { notices.push(msg); },
    now,
    guarded: async (key, fn) => {
      try {
        await fn();
      } catch (err) {
        failures.push({ key, err });
      }
    },
    unbind: (nodeId) => {
      have.delete(nodeId);
      delete state.data.materialized[nodeId];
    },
  };

  const deletions = new Deletions({
    vault, blobs: h.blobs, state, tickets, shareRoot: SHARE, now,
    notice: (msg) => { notices.push(msg); },
    // A batch big enough to need the dialog would be answered 'keep'; this one is
    // a single file, so nothing here depends on how the dialog answers.
    confirmBulk: async () => 'keep',
    ...DESKTOP_MEMORY_CAP,
  });

  const batch = deletions.collectDeletable(ctx).length;
  await deletions.apply(ctx);
  assert.deepEqual(failures, [], 'the deletion pass ran cleanly');

  const after = vault.binarySnapshot();
  return {
    batch,
    trashed: vault.wasTrashed(path),
    rescued: Object.keys(vault.snapshot()).some((p) => p.startsWith(`${RECOVERED_DIR}/`)),
    onDisk: after[path],
    notices,
  };
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

/** The same for the note lane's document access, so one method can be gated. */
function docPortOf(inner: FakeDocs, overrides: Partial<DocPort>): DocPort {
  const base: DocPort = {
    openHeadless: (room) => inner.openHeadless(room),
    insertIfEmpty: (handle, text) => inner.insertIfEmpty(handle, text),
    flush: (handle) => inner.flush(handle),
    close: (handle) => { inner.close(handle); },
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
  assert.equal(h.tree.get(id)!.s, undefined, 'I6: nothing to publish is not published');
  assert.equal(h.state.data.publish[id].state, 'pending');
});

test('a settled 0-byte attachment is refused by I6, not by the settle check', async () => {
  // The blob arm was the writer of `s: 1` that made NO I6 statement. A 0-byte
  // attachment was rejected incidentally, by the settle check reading
  // `st.bytes === 0` as "the writer has not finished" — so the rule held by
  // accident, the diagnostic said something that was not true, and the entry
  // charged a rung of the ladder and stayed counted for the lifetime of the
  // vault. Relax that one comparison for zero-length files and `s: 1` lands on
  // an empty blob with no guard anywhere.
  const h = makeHarness();
  const id = h.addBlob('clip.png', new Uint8Array(0));
  h.queue.enqueue(id);

  await h.queue.drain();

  assert.equal(h.tree.get(id)!.s, undefined);
  assert.deepEqual(h.queue.parked().map((p) => p.reason), ['empty-attachment'],
    'refused over the state of the user\'s own file, which is what a park is');
  assert.equal(h.queue.pendingCount(), 0, 'so it is not an upload in progress');
  assert.equal(h.state.data.publish[id].attempts, 0, 'and no rung of the ladder is charged');
  assert.match(
    String((h.queue.lastError(id) as Error).message), /empty/,
    'the diagnostic says what is true, not "still being written"',
  );

  // And it is a park rather than a grave: bytes arriving lift it.
  h.vault.seedBinary(`${SHARE}/clip.png`, png());
  assert.equal(await h.queue.repark(), true);
  assert.equal(h.queue.pendingCount(), 1);
  await h.queue.drain();
  assert.equal(h.tree.get(id)!.s, 1);
  assert.deepEqual(h.queue.parked(), []);
});

test('a file still being written is still told apart from an empty one', async () => {
  // The two used to be the same answer. They are different states: one ends by
  // waiting and charges the ladder, the other never does and must not.
  const h = makeHarness();
  const id = h.addBlob('clip.png', png());
  h.queue.enqueue(id);
  h.settle.run = async (): Promise<void> => {
    h.vault.seedBinary(`${SHARE}/clip.png`, new Uint8Array([...png(), 9, 9]));
  };

  await h.queue.drain();

  assert.equal(h.tree.get(id)!.s, undefined);
  assert.deepEqual(h.queue.parked(), [], 'a growing file is not parked');
  assert.equal(h.state.data.publish[id].attempts, 1, 'it waits, and the ladder says so');
  assert.match(String((h.queue.lastError(id) as Error).message), /still being written/);
});

test('every writer of `s: 1` is one of the three, so a fourth cannot ship silently', () => {
  // `s` is the whole definition of "published", it is never re-offered by
  // anybody, and it has three writers that each have to make the same I6
  // statement in their own words. Nothing anywhere greps for it, so a fourth
  // would land with no guard and no test — which is the shape of the bug that
  // started this whole investigation.
  //
  // This does not prove the three are right; the behavioural tests above and in
  // WorkspaceSession.test.ts do that, one per writer. It proves that the set is
  // the set, so adding to it is a decision somebody has to come here and make.
  const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
  const found: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Not the dependencies, not the worktrees, not the build output.
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const hits = (readFileSync(full, 'utf8').match(/\bs:\s*1\b/g) ?? []).length;
      if (hits > 0) found[full.slice(root.length + 1).replace(/\\/g, '/')] = hits;
    }
  };
  walk(root);

  assert.deepEqual(
    found,
    {
      // the note arm and the attachment arm
      'src/sync/PublishQueue.ts': 2,
      // the editing session, which owns a node it holds open (I7)
      'src/sync/WorkspaceSession.ts': 1,
    },
    'a new writer of `s: 1` must state I6 where it writes it, and be listed here',
  );
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
    ...DESKTOP_MEMORY_CAP,
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
  // Kept, and reported where it is true. See the note on the markdown twin.
  assert.equal(h.state.data.publish[id].state, 'pending', 'the entry is kept');
  assert.equal(h.queue.pendingCount(), 0, 'and is not an upload in progress');
  assert.deepEqual(h.queue.blocked().map((b) => b.id), [id]);
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
//
// ⚠ A PIN ON §7.4 AS AMENDED. The `why: 'server'` arm below only exists because
// the two ceilings are two numbers: folded with `min()` there would be one, and
// nothing could reach this verdict or say which remedy the user has.
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
  assert.equal(
    h.blobs.callsTo('limits').length, 1,
    'the ceiling is asked for ONCE and remembered: it is a policy that moves, and '
    + 'the publish path is the only consumer that can afford a value which does',
  );
  assert.equal(h.state.data.publish[id].state, 'done', 'the entry is closed, not retried for ever');
  assert.equal(h.notices.length, 1, 'the user is told exactly once');
  assert.match(h.notices[0], /scan\.tiff/);
});

// ⚠ B24, the publish arm: the cap is checked BEFORE the bytes are allocated. A
// cap enforced after `readBinary` is no cap at all on the device it protects —
// the phone is already out of memory by then.
//
// ⚠ AND THE ARCHITECTURAL PIN ON §7.4 AS AMENDED. The store is not asked
// ANYTHING here — not even `/limits`. That is the machine-checkable form of "the
// memory cap is a fact about the device, knowable offline": under a folded
// `min(platformCap, maxFileBytes)` the device cap could not be computed without a
// network round trip, and this line would have to be deleted.
test('B24: a file over the device cap is retracted without ever being read', async () => {
  const h = makeHarness({ memoryCapBytes: () => 100 });
  const id = h.addBlob('clip.mov', png(2, 512));

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.vault.callsTo('readBinary').length, 0, 'never held in memory');
  assert.equal(h.blobs.calls.length, 0, 'and the store was never asked about it');
  assert.equal(
    h.blobs.callsTo('limits').length, 0,
    'the device arm needs no network: a phone learns it cannot hold a file offline',
  );
  assert.equal(h.state.data.oversized[fold(`${SHARE}/clip.mov`)]?.why, 'device');
  assert.equal(h.tree.get(id)!.x, 1);
});

// ------------------------------------------------- §3.2: retract, on a REPLACE
//
// ⚠ Everything above tests retract against a node that was NEVER PUBLISHED, and
// that is the only case §3.2's safety argument covers: "the node was never
// published, so no peer materialized it and `collectDeletable` skips it".
//
// `publishBlobOne` admits a published node on purpose — I5a at PublishQueue.ts
// lets any peer holding the node materialized publish a REPLACE — so the
// argument's precondition is one `requeue` away from being false, and §3.5's
// rule 2 makes that requeue on every pass. Against a published node the
// tombstone retract writes is indistinguishable from a deliberate delete: every
// peer has the file materialized, its bytes still hash to the reference the tree
// names, and the store still holds them, so the peer's deletion pass PROVES the
// content and trashes it. Worse than a delete, in fact — retract writes no `xh`,
// so `canResurrect` can never bring the node back.
//
// A size refusal must therefore refuse the BYTES, never the node. §7.5 promises
// the user "the file untouched and simply not shared. Nothing is moved, nothing
// is deleted", and for a replace that promise is about the previous version too.
//
// ⚠ A PIN ON §7.4 AS AMENDED: the server ceiling is a policy about writing and
// is folded into nothing. This test is the server arm; the device cap is nowhere
// near it, and the two are only independently reachable while they stay apart.

test('an oversized replace refuses the new bytes and leaves the published node live', async () => {
  const h = makeHarness();
  const old = png(1, 512);
  const id = h.addBlob('scan.tiff', old);
  const oldSha = await h.blobs.seed(old);
  h.tree.patchNode(id, { s: 1, b: refOf(oldSha, old.length) });        // already shared
  const g = h.tree.get(id)!.g;
  const st = (await h.vault.stat(`${SHARE}/scan.tiff`))!;
  h.state.data.contentHash[id] = { sha256: oldSha, len: old.length, mtime: st.mtime };
  h.vault.resetCalls();
  h.blobs.resetCalls();

  // The user drops a 4 KB scan over the 512-byte one, against a server that
  // accepts 1 KB. This is the server arm; the device cap is nowhere near.
  const big = png(2, 4_096);
  const bigSha = await hashOfBytes(big);
  h.vault.seedBinary(`${SHARE}/scan.tiff`, big);
  h.blobs.setLimits({ maxFileBytes: 1_024 });

  h.queue.requeue(id, bigSha);
  await h.queue.drain();

  const f = h.tree.get(id)!;
  assert.equal(f.x, undefined, 'still LIVE: a tombstone here deletes it on every peer');
  assert.notEqual(f.x, g);
  assert.equal(f.s, 1, 'still published');
  assert.equal(f.b, refOf(oldSha, old.length), 'and still names the last good version');
  assert.equal(h.state.data.materialized[id], `${SHARE}/scan.tiff`, 'still bound');
  assert.deepEqual(
    h.state.data.contentHash[id], { sha256: oldSha, len: old.length, mtime: st.mtime },
    'the base still names what is simultaneously in the tree and on some disk (I17)',
  );
  // `oversized` is keyed by folded PATH and self-heals in reconciler step 6 —
  // which skips any path a LIVE node claims, before it ever asks the size. A
  // record written here would sit in device state for ever and, if the node were
  // properly deleted later, stop `onCreate` re-adopting the file at all.
  assert.deepEqual(h.state.data.oversized, {}, 'and no path was poisoned');
  assert.equal(h.blobs.callsTo('put').length, 0, 'nothing was uploaded');
  assert.equal(h.vault.wasTrashed(`${SHARE}/scan.tiff`), false);
  assert.deepEqual(
    h.vault.binarySnapshot()[`${SHARE}/scan.tiff`], big,
    'the file the user just put there is left exactly where they put it',
  );
  assert.equal(h.state.data.publish[id].state, 'done', 'the entry is closed, not retried for ever');
  assert.equal(h.state.data.publish[id].intent, bigSha, 'carrying what it refused');
  assert.ok(h.queue.lastError(id) !== undefined, 'the reason reaches diagnostics');
  assert.equal(h.notices.length, 1, 'the user is told exactly once');
  assert.match(h.notices[0], /scan\.tiff/);
  assert.match(
    h.notices[0], /previous version/,
    '"it is not being shared" would be a lie about the version that still is',
  );

  // §3.5 rule 2 requeues on EVERY pass. The intent travels with the closed entry,
  // so the same disk bytes are a no-op rather than a Notice per pass.
  h.queue.requeue(id, bigSha);
  await h.queue.drain();
  assert.equal(h.notices.length, 1, 'and not once per pass');
  assert.equal(h.tree.get(id)!.x, undefined);
  assert.equal(h.blobs.callsTo('put').length, 0);

  // ⚠ THE GAP THIS TEST LEFT OPEN. "Not once per pass" was asserted of the
  // NOTICE, and INSTALL.md promises it of the WORK: "a refused replacement is
  // retried only when the file changes again". The closed entry carries the
  // intent, so a requeue for the same bytes must cost nothing at all — no stat,
  // no read, no upload, and no second question to the server about its ceiling.
  h.vault.resetCalls();
  h.blobs.resetCalls();
  h.queue.requeue(id, bigSha);
  await h.queue.drain();
  h.queue.requeue(id, bigSha);
  await h.queue.drain();

  assert.equal(h.vault.callsTo('readBinary').length, 0, 'the file is not re-read');
  assert.equal(h.vault.callsTo('stat').length, 0, 'not even stat-ed');
  assert.equal(h.blobs.callsTo('put').length, 0, 'and nothing is offered');
  assert.equal(h.blobs.callsTo('limits').length, 0, 'and the ceiling is not re-asked');
  assert.equal(h.notices.length, 1);
});

// ⚠ The other half of that pin (§7.4 as amended): the device arm, reached with no
// lowered server ceiling anywhere. Two arms, independently reachable, which is
// only a meaningful sentence while the two numbers stay two numbers.
test('the device-cap arm refuses a published attachment too, without ever reading it', async () => {
  const h = makeHarness({ memoryCapBytes: () => 100 });
  const old = png(1, 64);
  const id = h.addBlob('clip.mov', old);
  const oldSha = await h.blobs.seed(old);
  h.tree.patchNode(id, { s: 1, b: refOf(oldSha, old.length) });
  h.vault.resetCalls();

  // A file that grew past the device cap between the pass that queued it and the
  // drain that reached it — the route that needs no lowered server ceiling at all.
  const big = png(3, 512);
  h.vault.seedBinary(`${SHARE}/clip.mov`, big);

  h.queue.requeue(id, await hashOfBytes(big));
  await h.queue.drain();

  const f = h.tree.get(id)!;
  assert.equal(h.vault.callsTo('readBinary').length, 0, 'never held in memory');
  assert.equal(f.x, undefined, 'and never tombstoned: peers hold this file');
  assert.equal(f.b, refOf(oldSha, old.length), 'the last good version stays shared');
  assert.equal(h.state.data.materialized[id], `${SHARE}/clip.mov`);
  assert.deepEqual(h.state.data.oversized, {});
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /this device can handle/);
  assert.match(h.notices[0], /previous version/);
});

// ⚠ The pin on §7.4 as amended that measures the actual COST of getting it wrong,
// rather than the shape of the answer. Nothing below is added to or reworded.
//
// The user-visible half, and the only assertion that measures the actual harm:
// what the OTHER device does with the tree the queue just produced. Ben's pass
// is the real `Deletions`, over a context assembled the way the reconciler
// assembles it — so this fails today for the reason it would fail a user.
test('a peer holding the published attachment does not lose it to an oversized replace', async () => {
  const h = makeHarness();
  const old = png(1, 512);
  const id = h.addBlob('scan.tiff', old);
  const oldSha = await h.blobs.seed(old);
  h.tree.patchNode(id, { s: 1, b: refOf(oldSha, old.length) });

  const big = png(2, 4_096);
  h.vault.seedBinary(`${SHARE}/scan.tiff`, big);
  h.blobs.setLimits({ maxFileBytes: 1_024 });

  h.queue.requeue(id, await hashOfBytes(big));
  await h.queue.drain();

  const ben = await peerDeletionPass(h, id, 'scan.tiff', old);

  assert.equal(ben.trashed, false, 'his copy is not trashed');
  assert.equal(ben.batch, 0, "Ada's size refusal is not a deletion on Ben's device");
  assert.equal(ben.rescued, false, 'and not exiled to ShadowLink Recovered/ either');
  assert.deepEqual(ben.onDisk, old, 'the last good version is still his file');
  assert.deepEqual(
    ben.notices, [],
    'and he is not told Ada deleted a file she only tried to replace',
  );
});

// I2, in the one place where it cannot be undone by a later pass: an unknown
// ceiling must never be read as a small one. §7.4 as amended states this as
// "the publish proceeds"; the test below is what makes that literal.
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

// ⚠ The property §8.4 exists for is not "the attachment lane is capped" — it is
// "a 200 MB video occupying every slot must not park the publication of every
// note in the vault behind it for the whole upload". A test that instruments only
// the attachment path measures the cap and says nothing at all about that:
// serializing the two lanes outright, `await Promise.all(lane(attachments, …))`
// and only then the notes, leaves such a test green.
//
// So this one holds BOTH lanes open at once and watches them overlap. Each lane
// is parked at its own gate; the test waits for both to fill to their own width
// SIMULTANEOUSLY, which is unreachable under any serialization in either order,
// and then releases the notes alone and watches every one of them publish while
// an attachment upload is still open.
test('attachments drain in their own lane, and notes keep theirs', async () => {
  const h = makeHarness();
  for (let i = 0; i < 6; i++) h.addBlob(`img-${i}.png`, png(i));
  for (let i = 0; i < 6; i++) h.add(`note-${i}.md`, `body ${i}`);

  const uploads = gate();
  const seeds = gate();
  let blobsInFlight = 0;
  let blobPeak = 0;
  let notesInFlight = 0;
  let notePeak = 0;

  // The 200 MB video: a `has` probe that does not come back until the test says so.
  const gatedBlobs = blobPortOf(h.blobs, {
    has: async (sha) => {
      blobsInFlight += 1;
      blobPeak = Math.max(blobPeak, blobsInFlight);
      await uploads.open;
      const answer = await h.blobs.has(sha);
      blobsInFlight -= 1;
      return answer;
    },
  });
  const gatedDocs = docPortOf(h.docs, {
    openHeadless: async (room) => {
      notesInFlight += 1;
      notePeak = Math.max(notePeak, notesInFlight);
      await seeds.open;
      const opened = await h.docs.openHeadless(room);
      notesInFlight -= 1;
      return opened;
    },
  });
  const q = new PublishQueue({
    docs: gatedDocs, vault: h.vault, blobs: gatedBlobs, state: h.state, tree: h.tree,
    openNodeId: () => null, now: () => h.clock.now, settleMs: 0,
    ...DESKTOP_MEMORY_CAP,
  });

  for (const id of Object.keys(h.state.data.owned)) q.enqueue(id);
  const drained = q.drain();

  // Both lanes saturated at the same instant. Under `lane(attachments)` then
  // `lane(notes)` the note count never leaves zero; under the reverse ordering the
  // attachment count never does. Either way this never becomes true.
  await until(
    () => blobsInFlight === BLOB_PUBLISH_CONCURRENCY && notesInFlight === PUBLISH_CONCURRENCY,
    'both lanes to fill to their own width at once',
  );
  assert.equal(blobPeak, BLOB_PUBLISH_CONCURRENCY, 'the attachment lane is capped at its width');
  assert.equal(notePeak, PUBLISH_CONCURRENCY, 'and the note lane runs at its own, wider one');

  // The whole point, stated as the user would state it: the notes finish while
  // the upload is still going.
  seeds.release();
  await until(() => publishedCount(h, 'f') === 6, 'every note to publish');
  assert.ok(blobsInFlight > 0, 'and the attachment lane was still mid-upload the whole time');
  assert.equal(publishedCount(h, 'b'), 0, 'no attachment had finished yet');

  uploads.release();
  await drained;

  assert.equal(publishedCount(h, 'b'), 6, 'and then the attachments land too');
  assert.equal(q.pendingCount(), 0, 'everything published');
});

// ---------------------------------------------------------------- P2 §3.6: the seed guard

// ⚠ B21's other half. A `.md` node whose file is not text is reachable today: a
// kind-crossing rename mints one, and so does `publishUntracked` for any
// non-text file somebody named `.md`. `vault.read` decodes it as UTF-8, which is
// LOSSY — every invalid byte becomes U+FFFD — and seeding that into a `Y.Text` is
// irreversible, because `s` is never re-offered. Refusing costs one `stat`.
test('B21: a markdown node whose bytes are not UTF-8 is never seeded', async () => {
  const h = makeHarness();
  // A PNG signature and a run of bytes no UTF-8 decoder can round-trip.
  const notText = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc0, 0x80]);
  const id = h.tree.createNode({ k: 'f', d: '', n: 'notes.md' }, NOW);
  h.vault.seedBinary(`${SHARE}/notes.md`, notText);
  h.state.data.owned[id] = true;
  h.state.data.materialized[id] = `${SHARE}/notes.md`;
  h.queue.enqueue(id);

  await h.queue.drain();

  assert.equal(h.tree.get(id)!.s, undefined, 'the node is not published');
  assert.equal(h.docs.text(`n_${id}`), '', 'and the content doc holds nothing at all');
  assert.deepEqual(
    h.docs.calls.filter((c) => c.op === 'insertIfEmpty'), [],
    'the mojibake never reached the document',
  );
  assert.equal(h.state.data.contentHash[id], undefined);
  assert.equal(h.notices.length, 1, 'the user is told, once');
  assert.ok(h.notices[0].includes('notes.md'), h.notices[0]);
  // Refusing is not failing: a backoff step would park the entry for minutes
  // over a file that will never become text on its own.
  assert.equal(h.state.data.publish[id].attempts, 0, 'no rung of the ladder was charged');
  assert.equal(h.state.data.publish[id].state, 'pending');
  assert.ok(h.queue.lastError(id) !== undefined, 'and the reason is available to diagnostics');

  // Repeated drains stay quiet: the Notice is not re-shown on every pass.
  await h.queue.drain();
  assert.equal(h.notices.length, 1);
  assert.equal(h.tree.get(id)!.s, undefined);
});

// The guard must not refuse ordinary notes. CRLF is the case that would break a
// naive length check on the NORMALIZED text: `normLF` shortens it by one byte per
// line, and the file on disk is the length the encoder sees, not the length after
// normalization.
//
// ⚠ `empty.md` CHANGED, deliberately. It used to be asserted alongside the others,
// `s === 1` — an EMPTY note publishing — which is the defect the I6 tests above
// describe: `s` is the whole definition of "published" for a note, so a peer
// materializes it and writes a 0-byte file on the canonical path. That assertion
// and "an empty attachment is a file mid-write (I6)" three hundred lines below it
// were the same question answered two opposite ways; this is the arm that was
// wrong, and it is the arm where the consequence is worse.
//
// It stays in the table rather than being removed, because it is a genuine case
// for the guard THIS test is about: 0 bytes on disk re-encode to 0 bytes, so an
// empty file must not be mistaken for a lossy decode. What changes is only the
// expectation — the guard passes it, and it is refused one step later, by I6.
test('the seed guard passes ordinary text, including CRLF and non-ASCII', async () => {
  const h = makeHarness();
  const cases: Array<[string, string]> = [
    ['plain.md', 'a plain note'],
    ['crlf.md', 'line one\r\nline two\r\n'],
    ['unicode.md', 'Ünïcødé — a note with an em dash and an emoji 🌍'],
    ['empty.md', ''],
  ];
  const ids = cases.map(([name, text]) => h.add(name, text));
  for (const id of ids) h.queue.enqueue(id);

  await h.queue.drain();

  for (const [i, id] of ids.entries()) {
    const [name, text] = cases[i];
    if (text.length === 0) {
      assert.equal(h.tree.get(id)!.s, undefined, `${name} is refused by I6, not published`);
      assert.equal(h.queue.lastError(id), undefined, `${name} was not refused by the seed guard`);
      continue;
    }
    assert.equal(h.tree.get(id)!.s, 1, `${name} was refused`);
  }
  assert.deepEqual(h.notices, [], 'and nobody was warned about a note that is fine');
});

// ----------------------------------------------- §7.4: one consumer of /limits

/**
 * The publish path is the ONLY consumer that gets a value which moves.
 *
 * This is the assertion that generalizes to a seventh consumer, which is why it
 * is written over the source rather than over one harness: a contributor who
 * folds the server's ceiling into the reconciler, the deletion pass, the vault
 * watcher or the bootstrap classifier has to call `limits()` from there, and this
 * trips on the call rather than on whatever it went on to break.
 *
 * What it would break is not subtle. `GET /blob/<ws>/<sha>` enforces no size
 * limit at all — `MAX_FILE_SIZE_MB` is checked only on the PATCH ingress — so the
 * bytes of an over-limit object are served on request. A device that folded the
 * ceiling into its memory cap would refuse to hash, bind, prove, resurrect or
 * download a file it is perfectly able to hold, and every remote tombstone for
 * one would become a `ShadowLink Recovered/` rescue.
 */
test('limits() has exactly one production caller, and it is the publish path (§7.4)', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const callers: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    // The port's own declaration and its HTTP implementation are what `limits()`
    // IS; the question here is who ASKS.
    if (name === 'BlobPort.ts' || name === 'ObsidianBlobPort.ts') continue;
    const src = readFileSync(join(dir, name), 'utf8');
    if (/\bblobs\.limits\s*\(/.test(src)) callers.push(name);
  }
  assert.deepEqual(
    callers, ['PublishQueue.ts'],
    'The server ceiling is an acceptance policy for uploads. It gates exactly one '
    + 'decision — whether to offer bytes to the store — and never a read, a hash, '
    + 'a proof, a resurrect, a fetch, a modal count or a deletion verdict.',
  );
});

// ------------------------------------------- §9: the ceiling after a 413 / 507

/**
 * The natural next paragraph of "a limits() that could not be asked does not
 * retract anything", and the bug that paragraph's memo introduced.
 *
 * `/limits` is asked once per session and remembered, which is right: it is the
 * one value in the publish path that moves, and asking per file would be a round
 * trip per attachment. But the memo had no invalidation, while §9's endpoint
 * table, `BlobPort.limits` and `ObsidianBlobPort` all promise it is "re-fetched
 * after a 413/507".
 *
 * Without that, a self-hoster who LOWERS `MAX_FILE_SIZE_MB` mid-session puts
 * every over-limit attachment into an unbounded silent loop: the cached ceiling
 * still says the old number, so nothing retracts; the whole file is re-read and
 * re-hashed and re-offered on every rung; the server answers 413 every time; and
 * the user is told nothing, because §7.5's Notice lives on the retract path this
 * never reaches.
 */
test('a 413 re-reads the ceiling, so a lowered limit converges instead of looping', async () => {
  const h = makeHarness();
  // Warm the memo the way a real session warms it: one attachment published
  // successfully, against a ceiling that accepted it.
  h.blobs.setLimits({ maxFileBytes: 64 * 1024 });
  const small = png(1, 256);
  const first = h.addBlob('logo.png', small);
  h.queue.enqueue(first);
  await h.queue.drain();
  assert.equal(h.tree.get(first)!.s, 1, 'the warm-up really did publish');
  assert.equal(h.blobs.callsTo('limits').length, 1, 'and asked the ceiling exactly once');

  // The operator edits MAX_FILE_SIZE_MB down and restarts the server. Nothing
  // tells the plugin.
  h.blobs.setLimits({ maxFileBytes: 1_024 });
  const big = png(2, 4_096);
  const id = h.addBlob('scan.tiff', big);

  h.queue.enqueue(id);
  await h.queue.drain();

  // First contact with the new reality is the 413 itself: the stale ceiling let
  // the publish through, the store refused it, and the rung was charged.
  assert.equal(h.blobs.callsTo('put').length, 2, 'the warm-up and this one');
  assert.equal(h.state.data.publish[id].attempts, 1);
  assert.equal(h.tree.get(id)!.x, undefined, 'nothing was decided on a stale number');
  assert.deepEqual(h.notices, [], 'and a 413 alone is not something to tell the user');

  // The next rung. This is the whole change: the ceiling is unknown again, so it
  // is asked again, and the answer is now the number that will actually decide.
  h.clock.now = h.state.data.publish[id].nextAt;
  await h.queue.drain();

  assert.equal(h.blobs.callsTo('limits').length, 2, 'the ceiling was re-read after the 413');
  assert.equal(
    h.blobs.callsTo('put').length, 2,
    'and the file was not offered a third time: the verdict now precedes the upload',
  );
  assert.deepEqual(h.state.data.oversized[fold(`${SHARE}/scan.tiff`)], {
    bytes: big.length, cap: 1_024, why: 'server',
  }, 'refused against the NEW number, not the remembered one');
  assert.equal(h.state.data.publish[id].state, 'done', 'the entry is closed, not retried for ever');
  assert.equal(h.state.data.publish[id].attempts, 0);
  assert.equal(h.notices.length, 1, 'and the user is finally told, exactly once');
  assert.match(h.notices[0], /scan\.tiff/);
  assert.match(h.notices[0], /this server accepts/);

  // The memo is NARROWED, not disabled. A publish that is not refused must not
  // turn into a `/limits` round trip per attachment.
  const quiet = h.addBlob('note.png', png(3, 128));
  h.queue.enqueue(quiet);
  await h.queue.drain();
  await h.queue.drain();
  assert.equal(h.tree.get(quiet)!.s, 1);
  assert.equal(h.blobs.callsTo('limits').length, 2, 'still asked once per known ceiling');
});

/**
 * The other half, and the reason to invalidate on 507 rather than only on 413.
 *
 * §9, `BlobPort.limits` and `ObsidianBlobPort` all say "413/507". Only the 413
 * changes a decision — a full store is a RETRY, not a refusal, and the node must
 * stay live and pending with nothing recorded and nothing said. Invalidating on
 * quota costs one extra `/limits` GET per rung and changes nothing else, which is
 * the price of a contract that is true rather than half-true.
 */
test('a 507 re-reads the ceiling too, and is still a retry rather than a refusal', async () => {
  const h = makeHarness();
  const bytes = png(1, 512);
  const id = h.addBlob('scan.tiff', bytes);
  h.blobs.refuseNextPut(new BlobQuotaExceeded('507: the store has no room'));

  h.queue.enqueue(id);
  await h.queue.drain();

  assert.equal(h.state.data.publish[id].state, 'pending', 'the node is still queued');
  assert.equal(h.state.data.publish[id].attempts, 1, 'one rung charged, and it retries');
  assert.equal(h.tree.get(id)!.x, undefined, 'never tombstoned: the store being full is not a size');
  assert.equal(h.tree.get(id)!.s, undefined);
  assert.deepEqual(h.state.data.oversized, {}, 'and no path was poisoned');
  assert.deepEqual(h.notices, [], 'a full store is not a refusal the user has to act on');

  // Room is made. The retry goes through, and the ceiling was re-read at most
  // once for the rung that failed.
  h.clock.now = h.state.data.publish[id].nextAt;
  await h.queue.drain();

  assert.equal(h.tree.get(id)!.s, 1, 'it goes through on its own once there is room');
  assert.equal(
    h.blobs.callsTo('limits').length, 2,
    'the ceiling was re-read after the 507 as well — one GET per refused rung, and '
    + 'not one per attempt: this is the assertion that keeps "413/507" in §9, in '
    + 'BlobPort.limits and in ObsidianBlobPort from being a contract naming two '
    + 'codes while the client honours one',
  );
  assert.deepEqual(h.notices, []);
});
