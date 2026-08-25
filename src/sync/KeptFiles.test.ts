// src/sync/KeptFiles.test.ts
//
// Group B for the escape hatch spec §5.4 and risk R6 both promise and P1 did not
// have: `declinedPaths` / `declinedNodes` were append-only, so the first-sync
// dialog's "You can share them later" was false and one unchecked box unshared a
// vault's worth of notes for ever.
//
// Everything here runs against the same fakes the rest of Group B uses, and each
// test is written so that it FAILS if the corresponding half of `KeptFiles` is
// removed:
//
//  * clearing without unbinding a dead node turns "share this again" into "delete
//    it after all" — test 4 watches `Deletions` for exactly that;
//  * clearing without adopting publishes nothing at all, because a file at a dead
//    node's path is excluded from the reconciler's step 6 by invariant I13 — tests
//    1 and 4 assert the bytes actually reach the content doc;
//  * persisting after the upload would let a crash re-decline a file every peer
//    has already seen — test 3 asserts the write lands FIRST.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DIR_SENTINEL, deriveTree } from '../tree/TreeIndex.ts';
import { fold, isLive, relPath, validateRel } from '../tree/paths.ts';
import { TreeDoc } from '../tree/TreeDoc.ts';
import type { NodeFields } from '../tree/types.ts';
import { Deletions, type DeletionContext } from './Deletions.ts';
import { DeviceState, type StatePort } from './DeviceState.ts';
import { DiskIndex } from './DiskIndex.ts';
import { FakeBlobs, FakeDocs, FakeVault } from './fakes.ts';
import { KeptFiles, type KeptEntry } from './KeptFiles.ts';
import { PublishQueue } from './PublishQueue.ts';
import type { ReconcileFailure } from './Reconciler.ts';
import { Tickets } from './Tickets.ts';
import { VaultWatcher } from './VaultWatcher.ts';

// ---------------------------------------------------------------- fixtures

const SHARE = 'Shared';
const NOW = 1_700_000_000_000;

/** A 22-character nodeId whose ASCII order is the order of `label`. */
function nid(label: string): string {
  return label + '0'.repeat(22 - label.length);
}

function file(d: string, n: string, extra: Partial<NodeFields> = {}): NodeFields {
  return { k: 'f', d, n, g: 1, c: 0, ...extra };
}

/** A tombstone old enough that §5.6's resurrect window cannot reuse the node. */
function dead(f: NodeFields, by = 'Ann'): NodeFields {
  return { ...f, x: f.g, xa: NOW - 86_400_000, xb: by };
}

class MemoryStatePort implements StatePort {
  readonly writes: string[] = [];
  private readonly store = new Map<string, string>();

  constructor(private readonly log: string[] = []) {}

  async read(key: string): Promise<string | null> {
    const v = this.store.get(key);
    return v === undefined ? null : v;
  }

  async write(key: string, data: string): Promise<void> {
    this.store.set(key, data);
    this.writes.push(data);
    this.log.push('state:write');
  }
}

interface Harness {
  vault: FakeVault;
  blobs: FakeBlobs;
  docs: FakeDocs;
  tree: TreeDoc;
  state: DeviceState;
  tickets: Tickets;
  port: MemoryStatePort;
  queue: PublishQueue;
  watcher: VaultWatcher;
  deletions: Deletions;
  kept: KeptFiles;
  log: string[];
  notices: string[];
  reconciles: string[];
  /** A deletion context assembled the way the reconciler assembles one. */
  ctx: () => DeletionContext;
}

function makeHarness(): Harness {
  const log: string[] = [];
  const now = (): number => NOW;
  const vault = new FakeVault();
  const blobs = new FakeBlobs();
  const docs = new FakeDocs();
  const tree = new TreeDoc();
  const port = new MemoryStatePort(log);
  const state = new DeviceState(port, 'device-1', 'ws-1', now, 0);
  const tickets = new Tickets(now);
  const notices: string[] = [];
  const reconciles: string[] = [];

  const queue = new PublishQueue({
    docs,
    vault,
    blobs,
    state,
    tree,
    openNodeId: () => null,
    now,
  });

  const watcher = new VaultWatcher({
    tree,
    entries: () => tree.entries(),
    vault,
    state,
    tickets,
    getShareRoot: () => SHARE,
    setShareRoot: () => { /* not exercised here */ },
    displayName: 'Ada',
    phase: () => 'ready',
    now,
    notice: (m) => { notices.push(m); },
    scheduleReconcile: (c) => { reconciles.push(c); },
    enqueuePublish: (id) => { queue.enqueue(id); },
  });

  const deletions = new Deletions({
    vault,
    blobs,
    state,
    tickets,
    shareRoot: SHARE,
    now,
    notice: (m) => { notices.push(m); },
  });

  const kept = new KeptFiles({
    state,
    entries: () => tree.entries(),
    vault,
    shareRoot: () => SHARE,
    adopt: async (path) => {
      log.push(`adopt:${path}`);
      await watcher.onCreate(path, 'f');
    },
    drain: () => queue.drain(),
    scheduleReconcile: (c) => { reconciles.push(c); },
    notice: (m) => { notices.push(m); },
  });

  const h: Harness = {
    vault, blobs, docs, tree, state, tickets, port, queue, watcher, deletions, kept,
    log, notices, reconciles,
    ctx: () => makeCtx(h),
  };
  return h;
}

/** The same shape `Reconciler.describeDesiredState` hands to `Deletions.apply`. */
function makeCtx(h: Harness): DeletionContext {
  const disk = DiskIndex.build(h.vault, SHARE);
  const entries = h.tree.entries();
  const derived = deriveTree(entries);

  const wantAtFold = new Map<string, string>();
  for (const [id, rel] of derived.files) wantAtFold.set(fold(`${SHARE}/${rel}`), id);
  for (const rel of derived.folders) wantAtFold.set(fold(`${SHARE}/${rel}`), DIR_SENTINEL);

  const deadNodes = new Map<string, NodeFields>();
  const deadFold = new Set<string>();
  for (const [id, f] of entries) {
    if (!validateRel(f.d, f.n, f.k)) continue;
    if (isLive(f)) continue;
    deadNodes.set(id, f);
    deadFold.add(fold(`${SHARE}/${relPath(f)}`));
  }

  const have = new Map<string, string>();
  for (const [id, p] of Object.entries(h.state.data.materialized)) {
    const literal = disk.literal(p);
    if (literal !== undefined) have.set(id, literal);
  }

  const failures: ReconcileFailure[] = [];
  return {
    cause: 'remote',
    deadNodes,
    deadFold,
    wantAtFold,
    have,
    blobRefs: derived.blobs,
    disk,
    failures,
    removedThisPass: new Set<string>(),
    vault: h.vault,
    blobs: h.blobs,
    docs: h.docs,
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    notice: (msg: string) => { h.notices.push(msg); },
    now: () => NOW,
    guarded: async (key, fn) => {
      try {
        await fn();
      } catch (err) {
        failures.push({ key, err });
      }
    },
    unbind: (id) => {
      have.delete(id);
      delete h.state.data.materialized[id];
    },
  };
}

/**
 * The live file node claiming `path`, or null.
 *
 * Read off the tree rather than off `deriveTree`, which lists only nodes that are
 * already published — and a node minted a moment ago is exactly the unpublished
 * case these tests are about.
 */
function liveNodeAt(h: Harness, path: string): string | null {
  for (const [id, f] of h.tree.entries()) {
    if (f.k !== 'f' || !isLive(f)) continue;
    if (fold(`${SHARE}/${relPath(f)}`) === fold(path)) return id;
  }
  return null;
}

function entryFor(entries: KeptEntry[], label: string): KeptEntry {
  const found = entries.find((e) => e.label === label);
  assert.ok(found !== undefined, `no kept entry labelled ${label}; got ${entries.map((e) => e.label).join(', ')}`);
  return found;
}

// ---------------------------------------------------------------- 1

test('a first-sync opt-out is listed, and sharing it publishes the file', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/Kept.md`, 'f', 'my private note');
  // Exactly what Bootstrap's `decline` writes: the folded VAULT path, no node.
  h.state.data.declinedPaths = [fold(`${SHARE}/Kept.md`)];

  // Before: the watcher refuses the path, which is what makes the state a one-way
  // door without this module.
  await h.watcher.onCreate(`${SHARE}/Kept.md`, 'f');
  assert.equal(h.tree.size(), 0, 'a declined path is not adopted');

  const listed = h.kept.list();
  assert.equal(listed.length, 1, 'the kept file is listed');
  const entry = entryFor(listed, `${SHARE}/Kept.md`);
  assert.equal(entry.path, `${SHARE}/Kept.md`, 'the literal path, not the folded key');
  assert.deepEqual([...entry.paths], [fold(`${SHARE}/Kept.md`)]);
  assert.deepEqual([...entry.nodes], []);

  const result = await h.kept.share([entry]);

  assert.equal(result.cleared, 1);
  assert.equal(result.shared, 1);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(h.state.data.declinedPaths, [], 'the decline is gone');

  const id = liveNodeAt(h, `${SHARE}/Kept.md`);
  assert.ok(id !== null, 'a node now claims the path');
  assert.equal(h.state.data.owned[id], true, 'this device owns what it just shared (I5)');
  assert.equal(h.state.data.materialized[id], `${SHARE}/Kept.md`, 'and is bound to it');

  // The whole point: the bytes reached the workspace, not just the tree.
  assert.equal(h.docs.text(`n_${id}`), 'my private note');
  assert.equal(h.tree.get(id)?.s, 1, 'published (I17)');
  assert.equal(h.queue.pendingCount(), 0, 'nothing left owed');
  assert.ok(h.reconciles.includes('sync'), 'a pass was scheduled');
});

// ---------------------------------------------------------------- 2

test('only the selected entries are cleared; the rest stay declined', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/one.md`, 'f', 'one');
  h.vault.seed(`${SHARE}/two.md`, 'f', 'two');
  h.state.data.declinedPaths = [fold(`${SHARE}/one.md`), fold(`${SHARE}/two.md`)];

  const listed = h.kept.list();
  assert.equal(listed.length, 2);
  await h.kept.share([entryFor(listed, `${SHARE}/one.md`)]);

  assert.deepEqual(h.state.data.declinedPaths, [fold(`${SHARE}/two.md`)], 'two.md is still kept');
  assert.ok(liveNodeAt(h, `${SHARE}/one.md`) !== null, 'one.md was shared');
  assert.equal(liveNodeAt(h, `${SHARE}/two.md`), null, 'two.md was not');

  // And the refusal that made it a one-way door is still in force for the rest.
  await h.watcher.onCreate(`${SHARE}/two.md`, 'f');
  assert.equal(liveNodeAt(h, `${SHARE}/two.md`), null, 'still refused');

  assert.deepEqual(h.kept.list().map((e) => e.label), [`${SHARE}/two.md`]);
});

// ---------------------------------------------------------------- 3

test('the decision is persisted BEFORE anything is published', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/Kept.md`, 'f', 'body');
  h.state.data.declinedPaths = [fold(`${SHARE}/Kept.md`)];

  await h.kept.share(h.kept.list());

  const write = h.log.indexOf('state:write');
  const adopt = h.log.indexOf(`adopt:${SHARE}/Kept.md`);
  assert.ok(write !== -1, 'the state was written');
  assert.ok(adopt !== -1, 'the file was adopted');
  assert.ok(write < adopt, `the write must precede the upload; log was ${h.log.join(' ')}`);

  const persisted = JSON.parse(h.port.writes[0]) as { declinedPaths: string[] };
  assert.deepEqual(persisted.declinedPaths, [], 'and the persisted copy is the cleared one');
});

// ---------------------------------------------------------------- 4

test('sharing a kept remote delete re-shares it and never deletes it', async () => {
  const h = makeHarness();
  // `createNode` mints its own id, so read back the one the tree actually holds.
  h.tree.createNode(dead(file('', 'Kept.md', { s: 1 })), NOW);
  const declinedId = h.tree.entries()[0][0];

  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/Kept.md`, 'f', 'the copy I kept');
  h.state.data.materialized[declinedId] = `${SHARE}/Kept.md`;
  // Exactly what `Deletions.declineAll` writes: both halves of one decision.
  h.state.data.declinedNodes = [declinedId];
  h.state.data.declinedPaths = [fold(`${SHARE}/Kept.md`)];

  const listed = h.kept.list();
  assert.equal(listed.length, 1, 'the node and its path are ONE entry');
  const entry = listed[0];
  assert.deepEqual([...entry.nodes], [declinedId]);
  assert.deepEqual([...entry.paths], [fold(`${SHARE}/Kept.md`)]);
  assert.ok(entry.detail.includes('Ann'), 'the user is told who deleted it');

  await h.kept.share([entry]);

  assert.deepEqual(h.state.data.declinedNodes, []);
  assert.deepEqual(h.state.data.declinedPaths, []);
  // The dead node must no longer be bound to the file, or the next deletion pass
  // would remove the very copy the user just asked to share.
  assert.equal(h.state.data.materialized[declinedId], undefined, 'the dead node was unbound');

  const ctx = h.ctx();
  assert.deepEqual(h.deletions.collectDeletable(ctx), [], 'nothing is deletable');
  await h.deletions.apply(ctx);
  assert.equal(h.vault.callsTo('trashLocal').length, 0, 'nothing was trashed');
  assert.equal(h.vault.callsTo('rename').length, 0, 'and nothing was moved aside');
  assert.equal(h.vault.snapshot()[`${SHARE}/Kept.md`], 'the copy I kept', 'the file is still here');

  // And it really was re-shared: a fresh, live node with the bytes uploaded.
  const fresh = liveNodeAt(h, `${SHARE}/Kept.md`);
  assert.ok(fresh !== null, 'a live node claims the path again');
  assert.notEqual(fresh, declinedId, 'a new identity, not the tombstone');
  assert.equal(h.docs.text(`n_${fresh}`), 'the copy I kept');
  assert.equal(h.tree.get(fresh)?.s, 1);
});

// ---------------------------------------------------------------- 5

test('a rescued file is listed honestly, and clearing it reopens the path', async () => {
  const h = makeHarness();
  h.tree.createNode(dead(file('', 'Gone.md', { s: 1 })), NOW);
  const declinedId = h.tree.entries()[0][0];
  h.vault.seed(SHARE, 'd');
  // A rescue moved the copy out of the share, so nothing is at the path.
  h.state.data.declinedNodes = [declinedId];
  h.state.data.declinedPaths = [fold(`${SHARE}/Gone.md`)];

  const listed = h.kept.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].path, null, 'no file on disk to share');
  assert.ok(listed[0].detail.includes('Nothing is at this path'), listed[0].detail);

  const result = await h.kept.share(listed);
  assert.equal(result.shared, 0, 'nothing to upload');
  assert.equal(result.cleared, 2, 'both halves of the decision were cleared');

  // The path is usable again: putting a file back there now shares it, which is
  // precisely what `VaultWatcher.onCreate` refused while the decline stood.
  h.vault.seed(`${SHARE}/Gone.md`, 'f', 'written again');
  await h.watcher.onCreate(`${SHARE}/Gone.md`, 'f');
  assert.ok(liveNodeAt(h, `${SHARE}/Gone.md`) !== null, 'the path takes a node again');
});

// ---------------------------------------------------------------- 6

test('an empty selection writes nothing at all', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/Kept.md`, 'f', 'body');
  h.state.data.declinedPaths = [fold(`${SHARE}/Kept.md`)];

  const result = await h.kept.share([]);

  assert.deepEqual(result, { cleared: 0, shared: 0, failed: [] });
  assert.deepEqual(h.state.data.declinedPaths, [fold(`${SHARE}/Kept.md`)], 'still declined');
  assert.deepEqual(h.port.writes, [], 'and nothing was written');
  assert.equal(h.tree.size(), 0);
});

// ---------------------------------------------------------------- 7

test('an adoption that throws is reported, and the rest of the selection proceeds', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/bad.md`, 'f', 'bad');
  h.vault.seed(`${SHARE}/good.md`, 'f', 'good');
  h.state.data.declinedPaths = [fold(`${SHARE}/bad.md`), fold(`${SHARE}/good.md`)];

  const kept = new KeptFiles({
    state: h.state,
    entries: () => h.tree.entries(),
    vault: h.vault,
    shareRoot: () => SHARE,
    adopt: async (path) => {
      if (path.endsWith('bad.md')) throw new Error('nope');
      await h.watcher.onCreate(path, 'f');
    },
    drain: () => h.queue.drain(),
    scheduleReconcile: (c) => { h.reconciles.push(c); },
    notice: (m) => { h.notices.push(m); },
  });

  const result = await kept.share(kept.list());

  assert.deepEqual(result.failed, [`${SHARE}/bad.md`]);
  assert.equal(result.shared, 1, 'the other file was still shared');
  assert.ok(liveNodeAt(h, `${SHARE}/good.md`) !== null);
  assert.ok(h.notices.some((n) => n.includes('could not share')), 'and the user was told');
});
