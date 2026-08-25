// src/sync/VaultWatcher.test.ts
//
// Spec §10 Group B, tests 44-60.
//
// Everything here drives the handlers with PLAIN PATHS, exactly as P1c will after
// it adapts `vault.on('create', f => watcher.onCreate(f.path, kindOf(f)))`. No
// Obsidian objects, no real timers: the coalesced batches are flushed by hand.
//
// The load-bearing test is 44. It replays every mutation a real reconciler pass
// performed back through the handlers with the ticket book empty, and demands
// ZERO tree writes. Tickets are an optimization (I9); idempotence (I8) is the
// mechanism, and 44 is what proves the mechanism is actually there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RESURRECT_WINDOW_MS, TICKET_TTL_MS } from '../tree/constants.ts';
import { fold, hashOf, isLive, relPath } from '../tree/paths.ts';
import { TreeDoc } from '../tree/TreeDoc.ts';
import type { NodeFields, NodeKind } from '../tree/types.ts';
import { Deletions } from './Deletions.ts';
import { DeviceState, type StatePort } from './DeviceState.ts';
import { FakeDocs, FakeVault } from './fakes.ts';
import { Reconciler } from './Reconciler.ts';
import { Tickets } from './Tickets.ts';
import type { Kind } from './VaultPort.ts';
import { VaultWatcher, type Phase, type WatcherDeps } from './VaultWatcher.ts';

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
}

interface Harness {
  vault: FakeVault;
  docs: FakeDocs;
  tree: TreeDoc;
  state: DeviceState;
  tickets: Tickets;
  watcher: VaultWatcher;
  /** Transactions the tree observed, local and remote alike (I9). */
  counts: { txns: number };
  notices: string[];
  readOnly: string[];
  reconciles: string[];
  published: string[];
  shareRootWrites: string[];
  bulkPrompts: number[];
  unsharePrompts: Array<{ path: string; count: number }>;
  now: () => number;
  setClock: (ms: number) => void;
  setPhase: (p: Phase) => void;
  shareRoot: () => string;
  resetCounts: () => void;
}

function makeHarness(over: Partial<WatcherDeps> = {}): Harness {
  let clock = NOW;
  let phase: Phase = 'ready';
  let shareRoot = SHARE;

  const now = (): number => clock;
  const vault = new FakeVault();
  const docs = new FakeDocs();
  // The tree may be injected (a second replica, or one that counts its writes);
  // the observer has to be attached to whichever one the watcher is actually given.
  const tree = over.tree ?? new TreeDoc();
  const state = new DeviceState(new MemoryStatePort(), 'device-1', 'ws-1', now, 0);
  const tickets = new Tickets(now);

  const counts = { txns: 0 };
  const notices: string[] = [];
  const readOnly: string[] = [];
  const reconciles: string[] = [];
  const published: string[] = [];
  const shareRootWrites: string[] = [];
  const bulkPrompts: number[] = [];
  const unsharePrompts: Array<{ path: string; count: number }> = [];

  tree.observe(() => { counts.txns += 1; });

  const watcher = new VaultWatcher({
    tree,
    entries: () => tree.entries(),
    vault,
    state,
    tickets,
    getShareRoot: () => shareRoot,
    setShareRoot: (next) => { shareRoot = next; shareRootWrites.push(next); },
    displayName: 'Ada',
    phase: () => phase,
    now,
    notice: (m) => { notices.push(m); },
    enterReadOnly: (r) => { readOnly.push(r); },
    scheduleReconcile: (c) => { reconciles.push(c); },
    enqueuePublish: (id) => { published.push(id); },
    confirmLocalBulkDelete: async (count) => { bulkPrompts.push(count); return true; },
    confirmUnshare: async (path, count) => { unsharePrompts.push({ path, count }); return 'unshare'; },
    ...over,
  });

  return {
    vault, docs, tree, state, tickets, watcher, counts,
    notices, readOnly, reconciles, published, shareRootWrites, bulkPrompts, unsharePrompts,
    now,
    setClock: (ms) => { clock = ms; },
    setPhase: (p) => { phase = p; },
    shareRoot: () => shareRoot,
    resetCounts: () => { counts.txns = 0; },
  };
}

/** Mint a node directly in the tree, as a peer would have. */
function mint(tree: TreeDoc, f: Omit<NodeFields, 'g' | 'c'> & { g?: number; c?: number }): string {
  return tree.createNode(f, NOW);
}

/** Zero-padded index, so a generated batch of names sorts the way it was built. */
function pad(n: number): string {
  return String(n).padStart(3, '0');
}

function fieldsOf(
  tree: TreeDoc,
): Array<{ id: string; k: NodeKind; rel: string; g: number; live: boolean }> {
  return tree.entries()
    .map(([id, f]) => ({ id, k: f.k, rel: relPath(f), g: f.g, live: isLive(f) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The whole tree as comparable plain data — what tests 49 and 50 compare. */
function layout(tree: TreeDoc): Array<[string, NodeFields]> {
  return tree.entries().sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------- I14 / share root

// 51. The shared folder is never a node: renaming it moves the MOUNT, and writes
// nothing at all into the tree.
test('51: renaming the share root follows it and writes nothing', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: 'Notes', n: 'todo.md', s: 1 });
  h.resetCounts();

  await h.watcher.onRename('Projects/Shared', SHARE, 'd');

  assert.equal(h.counts.txns, 0, 'zero tree writes');
  assert.deepEqual(h.shareRootWrites, ['Projects/Shared']);
  assert.equal(h.shareRoot(), 'Projects/Shared');
  assert.equal(h.notices.length, 1, 'the user is told the mount moved');
  assert.equal(h.tree.size(), 1);
  assert.equal(relPath(h.tree.get(id)!), 'Notes/todo.md', 'the layout is unchanged');
});

// 52. A vanished share root is a wrong mount, never evidence that the user
// deleted every note in it (I2).
test('52: deleting the share root enters read-only and writes no tombstone', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.resetCounts();

  await h.watcher.onDelete(SHARE, 'd');
  await h.watcher.flushDeleteBatch();

  assert.equal(h.counts.txns, 0);
  assert.equal(h.readOnly.length, 1);
  assert.equal(h.tree.get(id)!.x, undefined, 'zero tombstones');
});

// 53. An ANCESTOR of the share moved. The stored root is rewritten segment-wise;
// nothing about the tree changed, because the tree is share-relative.
test('53: renaming an ancestor of the share rewrites the stored root only', async () => {
  let root = 'Work/Team';
  const h = makeHarness({
    getShareRoot: () => root,
    setShareRoot: (next) => { root = next; },
  });
  const id = mint(h.tree, { k: 'f', d: 'Notes', n: 'todo.md', s: 1 });
  h.resetCounts();

  await h.watcher.onRename('Work2', 'Work', 'd');

  assert.equal(root, 'Work2/Team', 'rewritten segment-wise, not by string arithmetic');
  assert.equal(h.counts.txns, 0, 'zero tree writes');
  assert.equal(relPath(h.tree.get(id)!), 'Notes/todo.md');
});

test('deleting an ancestor of the share enters read-only', async () => {
  let root = 'Work/Team';
  const h = makeHarness({ getShareRoot: () => root, setShareRoot: (n) => { root = n; } });
  mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.resetCounts();

  await h.watcher.onDelete('Work', 'd');
  await h.watcher.flushDeleteBatch();

  assert.equal(h.readOnly.length, 1);
  assert.equal(h.counts.txns, 0);
});

// I14 is checked BEFORE the phase gate, so a share-root move during bootstrap is
// followed rather than replayed later against a mount that no longer exists.
test('the share-root guard runs before the phase gate', async () => {
  const h = makeHarness();
  h.setPhase('boot');

  await h.watcher.onRename('Elsewhere/Shared', SHARE, 'd');

  assert.deepEqual(h.shareRootWrites, ['Elsewhere/Shared']);
  assert.equal(h.watcher.pendingEventCount, 0, 'not queued — handled');
});

// ---------------------------------------------------------------- I9 / phase gate

test('events arriving before ready are queued and replayed, never dropped (I9)', async () => {
  const h = makeHarness();
  h.setPhase('boot');
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'body');

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');

  assert.equal(h.tree.size(), 0, 'nothing written while booting');
  assert.equal(h.watcher.pendingEventCount, 1);

  h.setPhase('ready');
  await h.watcher.flushPending();

  assert.equal(h.tree.size(), 1);
  assert.equal(h.watcher.pendingEventCount, 0);
  assert.equal(relPath(h.tree.get(h.tree.entries()[0][0])!), 'todo.md');
});

test('a queued create that the tree already describes writes nothing on replay (I8)', async () => {
  const h = makeHarness();
  h.setPhase('boot');
  mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'body');
  h.resetCounts();

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');
  h.setPhase('ready');
  await h.watcher.flushPending();

  assert.equal(h.counts.txns, 0);
  assert.equal(h.tree.size(), 1);
});

// ---------------------------------------------------------------- onCreate

test('a local create mints one node, claims ownership and enqueues a publish (I5)', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/Notes`, 'd');
  h.vault.seed(`${SHARE}/Notes/todo.md`, 'f', 'body');

  await h.watcher.onCreate(`${SHARE}/Notes/todo.md`, 'f');

  assert.equal(h.tree.size(), 1);
  const [id, f] = h.tree.entries()[0];
  assert.deepEqual(
    { k: f.k, d: f.d, n: f.n, g: f.g },
    { k: 'f', d: 'Notes', n: 'todo.md', g: 1 },
  );
  assert.equal(f.s, undefined, 'the publisher sets `s`, not the watcher');
  assert.equal(h.state.data.owned[id], true);
  assert.deepEqual(h.published, [id]);
  assert.equal(h.state.data.materialized[id], `${SHARE}/Notes/todo.md`);
});

test('a local folder create mints a dir node and enqueues no publish', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');

  await h.watcher.onCreate(`${SHARE}/Notes`, 'd');

  assert.equal(h.tree.size(), 1);
  assert.equal(h.tree.entries()[0][1].k, 'd');
  assert.deepEqual(h.published, []);
  assert.deepEqual(h.state.data.owned, {});
});

// The shared folder itself is not a node (I14), and neither is anything outside it.
test('creates outside the share, and of the share root itself, are ignored', async () => {
  const h = makeHarness();
  await h.watcher.onCreate('Elsewhere/todo.md', 'f');
  await h.watcher.onCreate(SHARE, 'd');
  await h.watcher.onCreate('ShadowLink Recovered/rescued.md', 'f');
  assert.equal(h.tree.size(), 0);
});

test('an unsyncable local path is never adopted', async () => {
  const h = makeHarness();
  // `image.png` used to belong in this list: before attachments existed, every
  // non-markdown file was unsyncable. It now mints a 'b' node, covered by
  // 'an attachment dropped into the share mints a b node …'. What is left here
  // is unsyncable for reasons that have nothing to do with kind.
  await h.watcher.onCreate(`${SHARE}/.hidden/note.md`, 'f');  // dot segment (§7)
  await h.watcher.onCreate(`${SHARE}/.DS_Store`, 'f');        // leading-dot name (§7)
  await h.watcher.onCreate(`${SHARE}/setup.exe`, 'f');        // refused extension (§2.3)
  await h.watcher.onCreate(`${SHARE}/payload.dll`, 'f');      // refused extension (§2.3)
  await h.watcher.onCreate(`${SHARE}/noextension`, 'f');      // a 'b' node needs one (§2.3)
  assert.equal(h.tree.size(), 0);
});

test('a ticket swallows exactly the echo of our own create', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'body');
  h.tickets.arm('create', `${SHARE}/todo.md`);

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');
  assert.equal(h.tree.size(), 0, 'the echo is suppressed');

  // Single-shot: a SECOND create at the same path is a real user action.
  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');
  assert.equal(h.tree.size(), 1, 'a ticket never mutes twice');
});

// I13. `declinedPaths` holds fold(VAULT path) — the same key Deletions writes
// when it rescues a file or when the user keeps their copies.
test('a create at a declined path is never re-shared (I13)', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/kept.md`, 'f', 'body');
  h.state.data.declinedPaths.push(fold(`${SHARE}/kept.md`));

  await h.watcher.onCreate(`${SHARE}/kept.md`, 'f');

  assert.equal(h.tree.size(), 0);
  assert.deepEqual(h.published, []);
});

// I8 through the FOLDER set: `Notes` is implied by `Notes/todo.md`, so the tree
// already describes a folder there and a folder node would be pure duplication.
// This is what makes `ensureDirs`' echo harmless once its ticket has expired.
test('a create for a folder the tree already implies mints nothing', async () => {
  const h = makeHarness();
  mint(h.tree, { k: 'f', d: 'Notes/Deep', n: 'todo.md', s: 1 });
  h.resetCounts();

  await h.watcher.onCreate(`${SHARE}/Notes`, 'd');
  await h.watcher.onCreate(`${SHARE}/Notes/Deep`, 'd');

  assert.equal(h.counts.txns, 0);
  assert.equal(h.tree.size(), 1);
});

test('a create at a live node\'s COLLISION-SUFFIXED path binds instead of forking', async () => {
  const h = makeHarness();
  const a = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  const b = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  const high = a < b ? b : a;
  h.resetCounts();

  await h.watcher.onCreate(`${SHARE}/todo (2).md`, 'f');

  assert.equal(h.counts.txns, 0, 'the suffixed path is already the tree\'s doing');
  assert.equal(h.tree.size(), 2);
  assert.equal(h.state.data.materialized[high], `${SHARE}/todo (2).md`);
});

// ---------------------------------------------------------------- 48 / onRename

// 48. The reason the index is recomputed for LOCAL transactions too: without it
// the rename cannot see the node the create just minted, and forks it.
test('48: create-then-rename with no reconcile in between does not fork the node', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/Untitled.md`, 'f', '');

  await h.watcher.onCreate(`${SHARE}/Untitled.md`, 'f');
  await h.watcher.onRename(`${SHARE}/Roadmap.md`, `${SHARE}/Untitled.md`, 'f');

  assert.equal(h.tree.size(), 1, 'exactly ONE node');
  const [id, f] = h.tree.entries()[0];
  assert.equal(f.n, 'Roadmap.md');
  assert.equal(f.d, '');
  assert.equal(h.state.data.materialized[id], `${SHARE}/Roadmap.md`);
});

test('a move rewrites `d` and keeps the node — and its content doc room — intact', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.state.data.materialized[id] = `${SHARE}/todo.md`;
  h.resetCounts();

  await h.watcher.onRename(`${SHARE}/Archive/todo.md`, `${SHARE}/todo.md`, 'f');

  assert.equal(h.counts.txns, 1, 'one transaction');
  assert.equal(h.tree.size(), 1);
  assert.deepEqual(
    { d: h.tree.get(id)!.d, n: h.tree.get(id)!.n },
    { d: 'Archive', n: 'todo.md' },
  );
});

test('a rename whose destination the tree already describes writes nothing (I8)', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: 'Archive', n: 'todo.md', s: 1 });
  h.state.data.materialized[id] = `${SHARE}/todo.md`;
  h.resetCounts();

  await h.watcher.onRename(`${SHARE}/Archive/todo.md`, `${SHARE}/todo.md`, 'f');

  assert.equal(h.counts.txns, 0);
  assert.equal(h.state.data.materialized[id], `${SHARE}/Archive/todo.md`, 'rebound only');
});

// Found by mutation probe: with the I8 early-return removed the suite stayed
// green, because in the simple cases the recomputed patch is empty anyway. It is
// NOT empty for a collision-suffixed node — there the handler would write the
// derived suffix back into `n` and rename the node for the whole workspace, which
// is precisely the write-back §1.4 forbids.
test('the echo of a move never writes a collision suffix back into the node', async () => {
  const h = makeHarness();
  const a = mint(h.tree, { k: 'f', d: 'Archive', n: 'todo.md', s: 1 });
  const b = mint(h.tree, { k: 'f', d: 'Archive', n: 'todo.md', s: 1 });
  const high = a < b ? b : a;
  // The reconciler has just moved the suffixed file from where it used to live.
  h.state.data.materialized[high] = `${SHARE}/Notes/todo (2).md`;
  h.resetCounts();

  await h.watcher.onRename(
    `${SHARE}/Archive/todo (2).md`,
    `${SHARE}/Notes/todo (2).md`,
    'f',
  );

  assert.equal(h.counts.txns, 0, 'the tree already said this (I8)');
  assert.deepEqual(
    { d: h.tree.get(high)!.d, n: h.tree.get(high)!.n },
    { d: 'Archive', n: 'todo.md' },
    'the suffix is a DERIVED path and is never written back',
  );
  assert.equal(h.state.data.materialized[high], `${SHARE}/Archive/todo (2).md`);
});

// Found by mutation probe: a binding can outlive the node it names — a declined
// or failed deletion leaves the file on disk and the binding in place. Editing a
// tombstone's `d`/`n` would drag a dead node around the tree behind the user's back.
test('a rename never edits a node that is already dead (§5.7 mints a new one)', async () => {
  const h = makeHarness();
  const gone = mint(h.tree, { k: 'f', d: '', n: 'gone.md', s: 1 });
  h.tree.patchNode(gone, { x: 1, xa: NOW - 60_000, xb: 'Ann' });
  h.state.data.materialized[gone] = `${SHARE}/gone.md`;      // the user kept their copy
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/kept.md`, 'f', 'my notes');
  h.resetCounts();

  await h.watcher.onRename(`${SHARE}/kept.md`, `${SHARE}/gone.md`, 'f');

  const dead = h.tree.get(gone)!;
  assert.equal(dead.n, 'gone.md', 'the tombstone is not dragged to the new name');
  assert.equal(isLive(dead), false);
  assert.equal(h.tree.size(), 2);
  const fresh = h.tree.entries().find(([id]) => id !== gone)!;
  assert.equal(fresh[1].n, 'kept.md');
  assert.equal(fresh[1].g, 1);
});

test('a rename claimed by a ticket is the echo of our own move', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.tickets.arm('rename', `${SHARE}/todo.md`, `${SHARE}/Archive/todo.md`);
  h.resetCounts();

  await h.watcher.onRename(`${SHARE}/Archive/todo.md`, `${SHARE}/todo.md`, 'f');

  assert.equal(h.counts.txns, 0);
  assert.equal(h.tree.get(id)!.d, '', 'the tree already said what it meant');
});

test('a rename into the share from outside is a create', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'body');

  await h.watcher.onRename(`${SHARE}/todo.md`, 'Inbox/todo.md', 'f');

  assert.equal(h.tree.size(), 1);
  assert.equal(h.tree.entries()[0][1].n, 'todo.md');
});

test('a rename entirely outside the share is ignored', async () => {
  const h = makeHarness();
  await h.watcher.onRename('B/todo.md', 'A/todo.md', 'f');
  assert.equal(h.tree.size(), 0);
  assert.equal(h.watcher.pendingDecision.size, 0);
});

// ---------------------------------------------------------------- 49 / 50

/** A folder node plus `count` file nodes under it, all seeded. */
function seedFolder(h: Harness, rel: string, count: number): { folder: string; children: string[] } {
  const folder = mint(h.tree, { k: 'd', d: '', n: rel });
  const children: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = mint(h.tree, { k: 'f', d: rel, n: `note-${String(i).padStart(3, '0')}.md`, s: 1 });
    h.state.data.materialized[id] = `${SHARE}/${rel}/note-${String(i).padStart(3, '0')}.md`;
    children.push(id);
  }
  h.state.data.materialized[folder] = `${SHARE}/${rel}`;
  return { folder, children };
}

// 49. Obsidian MAY fan a folder rename out into one event per descendant. Each
// of those hits the idempotence check and writes nothing.
test('49: a folder rename plus 400 descendant events is one transaction and 400 no-ops', async () => {
  const h = makeHarness();
  const { folder, children } = seedFolder(h, 'Folder', 400);
  h.resetCounts();
  const sizeBefore = h.tree.size();

  await h.watcher.onRename(`${SHARE}/Renamed`, `${SHARE}/Folder`, 'd');
  assert.equal(h.counts.txns, 1, 'the folder and all 400 descendants in ONE transaction');

  for (let i = 0; i < 400; i++) {
    const name = `note-${String(i).padStart(3, '0')}.md`;
    await h.watcher.onRename(`${SHARE}/Renamed/${name}`, `${SHARE}/Folder/${name}`, 'f');
  }

  assert.equal(h.counts.txns, 1, '400 descendant events wrote nothing');
  assert.equal(h.tree.size(), sizeBefore, 'no node was minted or lost');
  assert.equal(h.tree.get(folder)!.n, 'Renamed');
  for (const id of children) assert.equal(h.tree.get(id)!.d, 'Renamed');
  // Every descendant's FILE moved too, so its local binding has to move with it.
  // Found by mutation probe: without this the next reconcile sees 400 bindings
  // pointing at paths that no longer exist and re-derives them all from scratch.
  assert.equal(h.state.data.materialized[folder], `${SHARE}/Renamed`);
  assert.equal(h.state.data.materialized[children[0]], `${SHARE}/Renamed/note-000.md`);
  assert.equal(h.state.data.materialized[children[399]], `${SHARE}/Renamed/note-399.md`);
});

// 50. The same rename with NO descendant events must reach the same tree. 49+50
// together are what make the design independent of Obsidian's event fan-out.
test('50: a folder rename without descendant events reaches an identical tree', async () => {
  const withEvents = makeHarness();
  const without = makeHarness();
  const seeded = [withEvents, without].map((h) => seedFolder(h, 'Folder', 20));

  await withEvents.watcher.onRename(`${SHARE}/Renamed`, `${SHARE}/Folder`, 'd');
  for (let i = 0; i < 20; i++) {
    const name = `note-${String(i).padStart(3, '0')}.md`;
    await withEvents.watcher.onRename(`${SHARE}/Renamed/${name}`, `${SHARE}/Folder/${name}`, 'f');
  }
  await without.watcher.onRename(`${SHARE}/Renamed`, `${SHARE}/Folder`, 'd');

  // Compared by CONTENT, sorted by path: nodeIds are random, so a comparison keyed
  // on them would only ever be testing the random number generator.
  const strip = (t: TreeDoc): Array<Omit<NodeFields, 'c'>> =>
    t.entries()
      .map(([, f]) => {
        const { c, ...rest } = f;
        return rest;
      })
      .sort((a, b) => (relPath(a) < relPath(b) ? -1 : 1));
  assert.deepEqual(strip(withEvents.tree), strip(without.tree));

  // And with NO descendant events there is nothing but the folder handler to move
  // the descendants' local bindings, so it has to do it itself. (Found by mutation
  // probe: asserting this in test 49 proves nothing — there the 400 child events
  // rebind one by one and hide a missing subtree rebind.)
  const [, plain] = seeded;
  assert.equal(without.state.data.materialized[plain.folder], `${SHARE}/Renamed`);
  for (let i = 0; i < 20; i++) {
    assert.equal(
      without.state.data.materialized[plain.children[i]],
      `${SHARE}/Renamed/note-${String(i).padStart(3, '0')}.md`,
    );
  }
});

test('a folder rename only rewrites descendants of THAT folder', async () => {
  const h = makeHarness();
  const inside = mint(h.tree, { k: 'f', d: 'Folder/sub', n: 'a.md', s: 1 });
  const sibling = mint(h.tree, { k: 'f', d: 'FolderOther', n: 'b.md', s: 1 });
  const folder = mint(h.tree, { k: 'd', d: '', n: 'Folder' });
  h.state.data.materialized[folder] = `${SHARE}/Folder`;

  await h.watcher.onRename(`${SHARE}/Renamed`, `${SHARE}/Folder`, 'd');

  assert.equal(h.tree.get(inside)!.d, 'Renamed/sub');
  assert.equal(h.tree.get(sibling)!.d, 'FolderOther', 'a prefix is not a path');
});

// ---------------------------------------------------------------- 54 / unshare

test('54: dragging a 300-note folder out of the share asks exactly once', async () => {
  let seen: string[] = [];
  const prompts: Array<{ path: string; count: number }> = [];
  const h = makeHarness({
    confirmUnshare: async (path, count) => {
      prompts.push({ path, count });
      seen = [...h.watcher.pendingDecision];
      return 'undo';
    },
  });
  const { folder, children } = seedFolder(h, 'Archive', 300);
  h.vault.seed(SHARE, 'd');
  h.vault.seed('Archive', 'd');
  h.resetCounts();

  await h.watcher.onRename('Archive', `${SHARE}/Archive`, 'd');
  for (let i = 0; i < 300; i++) {
    const name = `note-${String(i).padStart(3, '0')}.md`;
    await h.watcher.onRename(`Archive/${name}`, `${SHARE}/Archive/${name}`, 'f');
  }
  assert.equal(h.counts.txns, 0, 'nothing is written before the user answers');

  await h.watcher.flushUnshare();

  assert.equal(prompts.length, 1, 'ONE modal for 301 events');
  assert.equal(prompts[0].count, 301);
  assert.equal(prompts[0].path, `${SHARE}/Archive`);
  assert.equal(seen.length, 301, 'every affected node was in pendingDecision');
  for (const id of [folder, ...children]) assert.ok(seen.includes(id));
  assert.equal(h.watcher.pendingDecision.size, 0, 'and released once answered');
});

test('54b: "stop sharing" tombstones the folder and cascades to its descendants', async () => {
  const h = makeHarness();
  const { folder, children } = seedFolder(h, 'Archive', 3);
  h.resetCounts();

  await h.watcher.onRename('Archive', `${SHARE}/Archive`, 'd');
  await h.watcher.flushUnshare();

  assert.equal(h.counts.txns, 1, 'one transaction');
  assert.equal(isLive(h.tree.get(folder)!), false);
  assert.equal(h.tree.get(folder)!.xp, undefined, 'never on the folder itself');
  for (const id of children) {
    assert.equal(isLive(h.tree.get(id)!), false);
    assert.equal(h.tree.get(id)!.xp, 'Archive', 'the cascade marker (§2.2)');
    assert.equal(h.state.data.materialized[id], undefined, 'unbound');
  }
});

test('54c: "undo the move" renames the folder back through the ticket system', async () => {
  const h = makeHarness({ confirmUnshare: async () => 'undo' });
  const { folder } = seedFolder(h, 'Archive', 2);
  h.vault.seed(SHARE, 'd');
  h.vault.seed('Archive', 'd');
  h.vault.seed('Archive/note-000.md', 'f', 'a');
  h.resetCounts();
  h.vault.resetCalls();

  await h.watcher.onRename('Archive', `${SHARE}/Archive`, 'd');
  await h.watcher.flushUnshare();

  assert.equal(h.counts.txns, 0, 'declining writes NOTHING');
  assert.equal(isLive(h.tree.get(folder)!), true);
  assert.deepEqual(
    h.vault.callsTo('rename').map((c) => c.args),
    [['Archive', `${SHARE}/Archive`]],
  );
  assert.equal(h.tickets.size(), 1, 'the reverse move is armed, so its echo is our own');
  assert.equal(h.vault.callsTo('trashLocal').length, 0);

  // And the echo itself changes nothing.
  await h.watcher.onRename(`${SHARE}/Archive`, 'Archive', 'd');
  assert.equal(h.counts.txns, 0);
});

// The rescue path (§5.3) moves a file OUT of the share on purpose. Its ticket is
// cleared by the reconciler's `finally`, so the echo arrives unguarded — and it
// must NOT be read as the user unsharing something.
test('a move out of the share of an already-dead node asks nothing', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'gone.md', s: 1 });
  h.tree.patchNode(id, { x: 1, xa: NOW - 1000, xb: 'Ann' });
  h.resetCounts();

  await h.watcher.onRename('ShadowLink Recovered/gone.md (deleted by Ann).md', `${SHARE}/gone.md`, 'f');
  await h.watcher.flushUnshare();

  assert.equal(h.unsharePrompts.length, 0);
  assert.equal(h.counts.txns, 0);
});

test('a move into a reserved folder is our own staging, not an unshare', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.state.data.materialized[id] = `${SHARE}/todo.md`;
  h.resetCounts();

  await h.watcher.onRename('ShadowLink Staging/abc.md', `${SHARE}/todo.md`, 'f');
  await h.watcher.flushUnshare();

  assert.equal(h.unsharePrompts.length, 0);
  assert.equal(h.counts.txns, 0);
  assert.equal(isLive(h.tree.get(id)!), true);
});

test('an unshare with no confirmation callback defaults to leaving the tree alone', async () => {
  const h = makeHarness({ confirmUnshare: undefined });
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.state.data.materialized[id] = `${SHARE}/todo.md`;
  h.vault.seed(SHARE, 'd');
  h.vault.seed('Inbox', 'd');
  h.vault.seed('Inbox/todo.md', 'f', 'body');
  h.resetCounts();

  await h.watcher.onRename('Inbox/todo.md', `${SHARE}/todo.md`, 'f');
  await h.watcher.flushUnshare();

  assert.equal(h.counts.txns, 0, 'silence is never consent to unshare');
  assert.equal(isLive(h.tree.get(id)!), true);
});

// ---------------------------------------------------------------- 55-57 / resurrect

async function seedTombstone(
  h: Harness,
  opts: { rel: string; xa: number; text: string },
): Promise<string> {
  const { dir, name } = splitOf(opts.rel);
  const id = mint(h.tree, { k: 'f', d: dir, n: name, s: 1 });
  h.tree.patchNode(id, { x: 1, xa: opts.xa, xb: 'Ann', xh: await hashOf(opts.text) });
  return id;
}

function splitOf(rel: string): { dir: string; name: string } {
  const i = rel.lastIndexOf('/');
  return i === -1 ? { dir: '', name: rel } : { dir: rel.slice(0, i), name: rel.slice(i + 1) };
}

// 55. Delete then Ctrl-Z. The node — and therefore the content doc and its whole
// history — comes back.
test('55: recreating inside the window with matching content reuses the node', async () => {
  const h = makeHarness();
  const id = await seedTombstone(h, { rel: 'todo.md', xa: NOW - 60_000, text: 'body' });
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'body');

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');

  assert.equal(h.tree.size(), 1, 'the SAME node, not a second one');
  const f = h.tree.get(id)!;
  assert.equal(isLive(f), true);
  assert.ok(f.g > (f.x ?? 0), `g (${f.g}) must beat x (${f.x})`);
  assert.equal(f.g, 2);
  assert.equal(f.x, 1, 'the tombstone generation stays; liveness is a comparison');
  assert.deepEqual(
    [f.xa, f.xb, f.xh, f.xp],
    [undefined, undefined, undefined, undefined],
  );
  assert.equal(h.state.data.materialized[id], `${SHARE}/todo.md`);
  assert.deepEqual(h.published, [], 'the content doc is still seeded — nothing to publish');
});

test('55b: an empty local file inside the window resurrects too (create fires before the bytes land)', async () => {
  const h = makeHarness();
  const id = await seedTombstone(h, { rel: 'todo.md', xa: NOW - 1_000, text: 'body' });
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', '');

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');

  assert.equal(h.tree.size(), 1);
  assert.equal(h.tree.get(id)!.g, 2);
});

test('55c: a resurrect at a NEW path moves the node there', async () => {
  const h = makeHarness();
  const id = await seedTombstone(h, { rel: 'Archive/todo.md', xa: NOW - 60_000, text: 'body' });
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/Archive`, 'd');
  h.vault.seed(`${SHARE}/Archive/todo.md`, 'f', 'body');

  await h.watcher.onCreate(`${SHARE}/Archive/todo.md`, 'f');
  assert.equal(h.tree.get(id)!.d, 'Archive');
});

// 56. Bob drags his own `inbox.md` in three months later. He gets HIS file, as a
// brand-new node, and Alice's tombstone is left exactly as it was.
test('56: recreating outside the window mints a fresh node and leaves the tombstone alone', async () => {
  const h = makeHarness();
  const id = await seedTombstone(h, {
    rel: 'todo.md',
    xa: NOW - (RESURRECT_WINDOW_MS + 1),
    text: 'the old note',
  });
  const before = h.tree.get(id)!;
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'a completely different note');

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');

  assert.equal(h.tree.size(), 2, 'a FRESH node');
  const fresh = h.tree.entries().find(([nodeId]) => nodeId !== id)!;
  assert.notEqual(fresh[0], id);
  assert.notEqual(`n_${fresh[0]}`, `n_${id}`, 'a different content doc room');
  assert.equal(fresh[1].g, 1);
  assert.equal(fresh[1].s, undefined);
  assert.deepEqual(h.tree.get(id)!, before, 'the tombstone is untouched');
  assert.deepEqual(h.published, [fresh[0]]);
});

// The window ALONE must be sufficient. Found by mutation probe: with only test 56
// in place, deleting the window check still passed, because 56's content differs
// too and the hash check caught it. Matching content months later is the case the
// bound actually exists for — the same note restored from a backup, or a peer's
// copy of a file that was legitimately deleted and rewritten since.
test('56d: outside the window, MATCHING content still mints a fresh node', async () => {
  const h = makeHarness();
  const id = await seedTombstone(h, {
    rel: 'todo.md',
    xa: NOW - (RESURRECT_WINDOW_MS + 1),
    text: 'body',
  });
  const before = h.tree.get(id)!;
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'body');

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');

  assert.equal(h.tree.size(), 2, 'the window is checked before the content, and it is decisive');
  assert.deepEqual(h.tree.get(id)!, before, 'the tombstone is untouched');
});

// The same, for an EMPTY local file: `local.length === 0` is a concession to
// Obsidian's create-then-write ordering, not a way around the window.
test('56e: outside the window, an empty local file still mints a fresh node', async () => {
  const h = makeHarness();
  const id = await seedTombstone(h, {
    rel: 'todo.md',
    xa: NOW - (RESURRECT_WINDOW_MS + 1),
    text: 'body',
  });
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', '');

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');

  assert.equal(h.tree.size(), 2);
  assert.equal(h.tree.get(id)!.g, 1);
});

test('56b: inside the window but with different content, a fresh node is minted', async () => {
  const h = makeHarness();
  const id = await seedTombstone(h, { rel: 'todo.md', xa: NOW - 1_000, text: 'the old note' });
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'somebody else entirely');

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');

  assert.equal(h.tree.size(), 2);
  assert.equal(h.tree.get(id)!.g, 1, 'the tombstone did not move');
});

test('56c: a tombstone with no recorded hash never resurrects on non-empty content', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.tree.patchNode(id, { x: 1, xa: NOW - 1_000, xb: 'Ann' });   // no xh
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'unknown bytes');

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');
  assert.equal(h.tree.size(), 2);
});

// 57. The generation counter is why liveness is a comparison rather than a
// boolean: a recreate concurrent with a delete always wins.
test('57: a resurrect merged with a concurrent delete leaves the node live on both replicas', async () => {
  const a = new TreeDoc();
  const id = a.createNode({ k: 'f', d: '', n: 'todo.md', s: 1 }, NOW);
  a.patchNode(id, { x: 1, xa: NOW - 1_000, xb: 'Ann', xh: await hashOf('body') });

  const b = new TreeDoc();
  b.applyUpdate(a.encodeState());

  // Replica B resurrects through the watcher, using the real handler.
  const hb = makeHarness({ tree: b });
  hb.vault.seed(SHARE, 'd');
  hb.vault.seed(`${SHARE}/todo.md`, 'f', 'body');
  await hb.watcher.onCreate(`${SHARE}/todo.md`, 'f');
  assert.equal(b.get(id)!.g, 2);

  // Meanwhile replica A, which has not seen the resurrect, re-applies its delete.
  a.patchNode(id, { x: 1, xa: NOW, xb: 'Ann' });

  const updateA = a.encodeState();
  const updateB = b.encodeState();
  a.applyUpdate(updateB);
  b.applyUpdate(updateA);

  assert.equal(isLive(a.get(id)!), true, 'live on A');
  assert.equal(isLive(b.get(id)!), true, 'live on B');
  assert.deepEqual(a.get(id), b.get(id), 'and converged');
});

// ---------------------------------------------------------------- 44

// 44. The whole design in one test: replay everything a real reconcile pass did
// to the vault, with the ticket book EMPTY, and demand zero tree writes.
test('44: replaying every reconciler mutation with no tickets writes nothing to the tree', async () => {
  const h = makeHarness();
  const docs = h.docs;

  // A tree a peer built: a folder node, a file in an implied folder, a file whose
  // disk casing differs from the tree's (forcing a staging round trip), and a
  // tombstone whose local copy cannot be proven (forcing a rescue OUT of the share).
  const folder = mint(h.tree, { k: 'd', d: '', n: 'Notes' });
  const todo = mint(h.tree, { k: 'f', d: 'Notes', n: 'todo.md', s: 1 });
  const leaf = mint(h.tree, { k: 'f', d: 'Deep/Nested', n: 'leaf.md', s: 1 });
  const cased = mint(h.tree, { k: 'f', d: '', n: 'Readme.md', s: 1 });
  const gone = mint(h.tree, { k: 'f', d: '', n: 'gone.md', s: 1 });
  h.tree.patchNode(gone, { x: 1, xa: NOW - 60_000, xb: 'Ann' });

  docs.setText(`n_${todo}`, 'todo body');
  docs.setText(`n_${leaf}`, 'leaf body');
  docs.setText(`n_${cased}`, 'readme body');

  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/readme.md`, 'f', 'readme body');    // wrong case on disk
  h.vault.seed(`${SHARE}/gone.md`, 'f', 'unproven bytes');
  h.state.data.materialized[cased] = `${SHARE}/readme.md`;
  h.state.data.materialized[gone] = `${SHARE}/gone.md`;

  const deletions = new Deletions({
    vault: h.vault,
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    now: h.now,
    confirmBulk: async () => 'apply',
  });
  const reconciler = new Reconciler({
    vault: h.vault,
    docs,
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    entries: () => h.tree.entries(),
    applyDeletions: (ctx) => deletions.apply(ctx),
    now: h.now,
  });

  const result = await reconciler.reconcile('sync');
  assert.equal(result.ran, true);
  assert.deepEqual(result.failures.map((f) => f.key), [], 'the pass itself was clean');

  const mutations = h.vault.calls.filter(
    (c) => c.op === 'create' || c.op === 'createFolder' || c.op === 'rename' || c.op === 'trashLocal',
  );
  assert.ok(mutations.length >= 6, `expected a busy pass, saw ${mutations.length}`);
  assert.ok(
    mutations.some((c) => c.op === 'rename' && String(c.args[1]).startsWith('ShadowLink Recovered/')),
    'the pass rescued the unproven file out of the share',
  );
  assert.ok(
    mutations.some((c) => c.op === 'rename' && String(c.args[1]).startsWith('ShadowLink Staging/')),
    'the pass staged the case-only rename',
  );

  // The reconciler's `finally` already cleared the ticket book; expire the clock
  // too, so nothing at all can be suppressed by a ticket.
  h.tickets.clearArmed();
  h.setClock(NOW + TICKET_TTL_MS * 10);
  assert.equal(h.tickets.size(), 0);

  const sizeBefore = h.tree.size();
  const before = layout(h.tree);
  h.resetCounts();

  for (const call of mutations) {
    if (call.op === 'createFolder') await h.watcher.onCreate(String(call.args[0]), 'd');
    else if (call.op === 'create') await h.watcher.onCreate(String(call.args[0]), 'f');
    else if (call.op === 'rename') {
      const from = String(call.args[0]);
      const to = String(call.args[1]);
      await h.watcher.onRename(to, from, from.endsWith('.md') ? 'f' : 'd');
    } else {
      await h.watcher.onDelete(String(call.args[0]), 'd');
    }
  }
  await h.watcher.flushDeleteBatch();
  await h.watcher.flushUnshare();

  assert.equal(h.counts.txns, 0, 'ZERO tree writes (I8)');
  assert.equal(h.tree.size(), sizeBefore);
  assert.deepEqual(layout(h.tree), before);
  assert.equal(h.unsharePrompts.length, 0, 'a rescue is not an unshare');
  assert.equal(h.bulkPrompts.length, 0);
  assert.deepEqual(h.published, []);
  assert.deepEqual(fieldsOf(h.tree).map((n) => n.id).sort(), [folder, todo, leaf, cased, gone].sort());
});

// ---------------------------------------------------------------- 45-47, 58-60

/** A TreeDoc that counts node patches, so "written once" is directly observable. */
class CountingTree extends TreeDoc {
  patches = 0;

  override patchNode(nodeId: string, patch: Parameters<TreeDoc['patchNode']>[1]): void {
    this.patches += 1;
    super.patchNode(nodeId, patch);
  }
}

/** A harness whose tree counts patches. */
function makeCountingHarness(over: Partial<WatcherDeps> = {}): Harness & { counting: CountingTree } {
  const counting = new CountingTree();
  return { ...makeHarness({ tree: counting, ...over }), counting };
}

test('a local delete tombstones the node with x = g, and unbinds it', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.state.data.materialized[id] = `${SHARE}/todo.md`;
  h.state.data.contentHash[id] = { sha256: 'abc123', len: 4 };
  h.vault.seed(SHARE, 'd');
  h.resetCounts();

  h.watcher.onDelete(`${SHARE}/todo.md`, 'f');
  await h.watcher.flushDeleteBatch();

  const f = h.tree.get(id)!;
  assert.equal(isLive(f), false);
  assert.equal(f.x, f.g);
  assert.equal(f.xa, NOW);
  assert.equal(f.xb, 'Ada');
  assert.equal(f.xh, 'abc123', 'the last CONFIRMED text, for the bounded resurrect');
  assert.equal(f.xp, undefined, 'not a cascade victim');
  assert.equal(h.state.data.materialized[id], undefined);
  assert.equal(h.bulkPrompts.length, 0, 'one file is not a bulk delete');
});

// 45. The idempotence check that stops every peer writing its own explicit
// tombstone for the same node — the hole that sank candidate 1.
test('45: a delete event for an already-dead node writes nothing', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'gone.md', s: 1 });
  h.tree.patchNode(id, { x: 1, xa: NOW - 60_000, xb: 'Ann' });
  h.state.data.materialized[id] = `${SHARE}/gone.md`;
  h.vault.seed(SHARE, 'd');
  h.resetCounts();

  h.watcher.onDelete(`${SHARE}/gone.md`, 'f');      // no ticket armed
  await h.watcher.flushDeleteBatch();

  assert.equal(h.counts.txns, 0);
  assert.equal(h.tree.get(id)!.xa, NOW - 60_000, 'the existing tombstone is not rewritten');
});

test('45b: a delete of a path no node owns writes nothing', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.resetCounts();

  h.watcher.onDelete(`${SHARE}/never-ours.md`, 'f');
  await h.watcher.flushDeleteBatch();

  assert.equal(h.counts.txns, 0);
  assert.equal(h.tree.size(), 0);
});

// 46. I2. A staging move and a rename both surface as delete-then-create, and the
// batch window is exactly long enough for the file to be back before we look.
test('46: a path that is present again when the batch flushes is never tombstoned', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.state.data.materialized[id] = `${SHARE}/todo.md`;
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'body');    // back on disk before the flush
  h.resetCounts();

  h.watcher.onDelete(`${SHARE}/todo.md`, 'f');
  await h.watcher.flushDeleteBatch();

  assert.equal(h.counts.txns, 0);
  assert.equal(isLive(h.tree.get(id)!), true);
});

test('46b: an `exists` that throws reads as present, never as a delete (I2)', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.state.data.materialized[id] = `${SHARE}/todo.md`;
  h.vault.seed(SHARE, 'd');
  h.vault.failNext('exists', new Error('EPERM'));
  h.resetCounts();

  h.watcher.onDelete(`${SHARE}/todo.md`, 'f');
  await h.watcher.flushDeleteBatch();

  assert.equal(h.counts.txns, 0);
  assert.equal(isLive(h.tree.get(id)!), true);
});

// 47. `git checkout`, Syncthing and Dropbox all remove files behind Obsidian's
// back, and each looks exactly like the user deleting them.
test('47: 300 local deletes raise ONE modal, and declining writes nothing', async () => {
  const prompts: number[] = [];
  const h = makeHarness({
    confirmLocalBulkDelete: async (count) => { prompts.push(count); return false; },
  });
  h.vault.seed(SHARE, 'd');
  const ids: string[] = [];
  for (let i = 0; i < 300; i++) {
    const name = `note-${String(i).padStart(3, '0')}.md`;
    const id = mint(h.tree, { k: 'f', d: '', n: name, s: 1 });
    h.state.data.materialized[id] = `${SHARE}/${name}`;
    ids.push(id);
  }
  h.resetCounts();

  for (let i = 0; i < 300; i++) {
    h.watcher.onDelete(`${SHARE}/note-${String(i).padStart(3, '0')}.md`, 'f');
  }
  await h.watcher.flushDeleteBatch();

  assert.deepEqual(prompts, [300], 'exactly one modal, for the whole batch');
  assert.equal(h.counts.txns, 0, 'declining writes NOTHING');
  for (const id of ids) assert.equal(isLive(h.tree.get(id)!), true);
  assert.deepEqual(h.reconciles, ['declined-local-delete'], 'the next pass restores them');
  // The bindings survive too: the files are coming back.
  assert.equal(h.state.data.materialized[ids[0]], `${SHARE}/note-000.md`);
});

// Silence is never consent to delete 300 files for the whole workspace.
test('47b: a bulk delete with no confirmation callback is declined', async () => {
  const h = makeHarness({ confirmLocalBulkDelete: undefined });
  h.vault.seed(SHARE, 'd');
  for (let i = 0; i < 30; i++) {
    const name = `note-${String(i).padStart(3, '0')}.md`;
    const id = mint(h.tree, { k: 'f', d: '', n: name, s: 1 });
    h.state.data.materialized[id] = `${SHARE}/${name}`;
  }
  h.resetCounts();

  for (let i = 0; i < 30; i++) {
    h.watcher.onDelete(`${SHARE}/note-${String(i).padStart(3, '0')}.md`, 'f');
  }
  await h.watcher.flushDeleteBatch();

  assert.equal(h.counts.txns, 0);
  assert.deepEqual(h.reconciles, ['declined-local-delete']);
});

test('47c: accepting the bulk gate applies every tombstone in one transaction', async () => {
  const h = makeHarness();     // the default callback accepts
  h.vault.seed(SHARE, 'd');
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const name = `note-${String(i).padStart(3, '0')}.md`;
    const id = mint(h.tree, { k: 'f', d: '', n: name, s: 1 });
    h.state.data.materialized[id] = `${SHARE}/${name}`;
    ids.push(id);
  }
  h.resetCounts();

  for (let i = 0; i < 30; i++) {
    h.watcher.onDelete(`${SHARE}/note-${String(i).padStart(3, '0')}.md`, 'f');
  }
  await h.watcher.flushDeleteBatch();

  assert.deepEqual(h.bulkPrompts, [30]);
  assert.equal(h.counts.txns, 1);
  for (const id of ids) assert.equal(isLive(h.tree.get(id)!), false);
});

// 58. Spec §2.2: `xp` is what lets a child that concurrently moved OUT of the
// folder survive its deletion. Rename beats delete, deterministically.
test('58: deleting a folder cascades to its live descendants and leaves escapees alone', async () => {
  const h = makeHarness();
  const folder = mint(h.tree, { k: 'd', d: '', n: 'Archive' });
  const inside = mint(h.tree, { k: 'f', d: 'Archive', n: 'a.md', s: 1 });
  const deeper = mint(h.tree, { k: 'f', d: 'Archive/sub', n: 'b.md', s: 1 });
  const movedOut = mint(h.tree, { k: 'f', d: 'Active', n: 'kept.md', s: 1 });
  const alreadyDead = mint(h.tree, { k: 'f', d: 'Archive', n: 'old.md', s: 1 });
  h.tree.patchNode(alreadyDead, { x: 1, xa: NOW - 90_000, xb: 'Ann' });
  h.state.data.materialized[folder] = `${SHARE}/Archive`;
  h.state.data.materialized[inside] = `${SHARE}/Archive/a.md`;
  h.state.data.contentHash[inside] = { sha256: 'hash-a', len: 1 };
  h.vault.seed(SHARE, 'd');
  h.resetCounts();

  h.watcher.onDelete(`${SHARE}/Archive`, 'd');
  await h.watcher.flushDeleteBatch();

  assert.equal(h.counts.txns, 1);
  assert.equal(isLive(h.tree.get(folder)!), false);
  assert.equal(h.tree.get(folder)!.xp, undefined, 'never on the folder itself');

  for (const id of [inside, deeper]) {
    const f = h.tree.get(id)!;
    assert.equal(isLive(f), false, 'cascaded');
    assert.equal(f.xp, 'Archive');
    assert.equal(f.x, f.g);
  }
  assert.equal(h.tree.get(inside)!.xh, 'hash-a');

  assert.equal(isLive(h.tree.get(movedOut)!), true, 'a node that moved out survives');
  assert.equal(h.tree.get(movedOut)!.xp, undefined);
  assert.equal(h.tree.get(alreadyDead)!.xa, NOW - 90_000, 'an already-dead node is not rewritten');
  assert.equal(h.state.data.materialized[inside], undefined, 'unbound');
});

test('58b: a cascaded child that later moves out of the folder comes back to life', async () => {
  const h = makeHarness();
  const folder = mint(h.tree, { k: 'd', d: '', n: 'Archive' });
  const child = mint(h.tree, { k: 'f', d: 'Archive', n: 'a.md', s: 1 });
  h.state.data.materialized[folder] = `${SHARE}/Archive`;
  h.vault.seed(SHARE, 'd');

  h.watcher.onDelete(`${SHARE}/Archive`, 'd');
  await h.watcher.flushDeleteBatch();
  assert.equal(isLive(h.tree.get(child)!), false);

  // A peer moves it out; `xp` no longer covers it (§2.2's escape rule).
  h.tree.patchNode(child, { d: 'Active' });
  assert.equal(isLive(h.tree.get(child)!), true);
});

// 59. 300 events, ONE transaction. Not 300 — every one of them would be a
// separate update broadcast to every peer.
test('59: 300 coalesced deletes produce exactly one transaction', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  for (let i = 0; i < 300; i++) {
    const name = `note-${String(i).padStart(3, '0')}.md`;
    const id = mint(h.tree, { k: 'f', d: '', n: name, s: 1 });
    h.state.data.materialized[id] = `${SHARE}/${name}`;
  }
  h.resetCounts();

  for (let i = 0; i < 300; i++) {
    h.watcher.onDelete(`${SHARE}/note-${String(i).padStart(3, '0')}.md`, 'f');
  }
  assert.equal(h.counts.txns, 0, 'nothing is written until the batch flushes');

  await h.watcher.flushDeleteBatch();
  assert.equal(h.counts.txns, 1);
});

// Found by mutation probe: test 59 fires all 300 events in one synchronous loop,
// so even a handler that flushed on EVERY event would still see one batch — the
// flushes are microtasks and cannot run until the loop ends. Real events arrive
// one macrotask apart, so the coalescing window has to be tested with the event
// loop actually turning between them.
test('59b: deletes arriving in separate ticks still coalesce into one transaction', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const names = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
  for (const name of names) {
    const id = mint(h.tree, { k: 'f', d: '', n: name, s: 1 });
    h.state.data.materialized[id] = `${SHARE}/${name}`;
  }
  h.resetCounts();

  for (const name of names) {
    h.watcher.onDelete(`${SHARE}/${name}`, 'f');
    await new Promise((resolve) => { setTimeout(resolve, 0); });   // let the loop turn
  }
  assert.equal(h.counts.txns, 0, 'still inside the coalescing window');

  await h.watcher.flushDeleteBatch();
  assert.equal(h.counts.txns, 1);
  for (const [, f] of h.tree.entries()) assert.equal(isLive(f), false);
});

// 60. Deleting a folder in Obsidian emits an event for the folder AND for each of
// its files. The folder must be written once and the children reached through the
// cascade, or the subfolder among them loses the `xp` that lets it escape.
test('60: a folder and its children in one batch write each node exactly once', async () => {
  const h = makeCountingHarness();
  const folder = mint(h.counting, { k: 'd', d: '', n: 'Archive' });
  const sub = mint(h.counting, { k: 'd', d: 'Archive', n: 'sub' });
  const a = mint(h.counting, { k: 'f', d: 'Archive', n: 'a.md', s: 1 });
  const b = mint(h.counting, { k: 'f', d: 'Archive/sub', n: 'b.md', s: 1 });
  for (const [id, path] of [
    [folder, `${SHARE}/Archive`], [sub, `${SHARE}/Archive/sub`],
    [a, `${SHARE}/Archive/a.md`], [b, `${SHARE}/Archive/sub/b.md`],
  ] as const) h.state.data.materialized[id] = path;
  h.vault.seed(SHARE, 'd');
  h.resetCounts();
  h.counting.patches = 0;

  // The whole subtree arrives in one batch, in the order a filesystem walk emits it.
  h.watcher.onDelete(`${SHARE}/Archive/sub/b.md`, 'f');
  h.watcher.onDelete(`${SHARE}/Archive/a.md`, 'f');
  h.watcher.onDelete(`${SHARE}/Archive/sub`, 'd');
  h.watcher.onDelete(`${SHARE}/Archive`, 'd');
  await h.watcher.flushDeleteBatch();

  assert.equal(h.counts.txns, 1);
  assert.equal(h.counting.patches, 4, 'four nodes, four writes — no double tombstoning');
  assert.equal(h.counting.get(folder)!.xp, undefined, 'the root carries no cascade marker');
  for (const id of [sub, a, b]) {
    assert.equal(isLive(h.counting.get(id)!), false);
    assert.equal(h.counting.get(id)!.xp, 'Archive', 'reached through the cascade, so it can escape');
  }
});

test('60b: deleting several unrelated files writes one tombstone each, with no cascade marker', async () => {
  const h = makeCountingHarness();
  h.vault.seed(SHARE, 'd');
  const ids: string[] = [];
  for (const name of ['a.md', 'b.md', 'c.md']) {
    const id = mint(h.counting, { k: 'f', d: '', n: name, s: 1 });
    h.state.data.materialized[id] = `${SHARE}/${name}`;
    ids.push(id);
    h.watcher.onDelete(`${SHARE}/${name}`, 'f');
  }
  h.counting.patches = 0;
  await h.watcher.flushDeleteBatch();

  assert.equal(h.counting.patches, 3);
  for (const id of ids) {
    assert.equal(isLive(h.counting.get(id)!), false);
    assert.equal(h.counting.get(id)!.xp, undefined);
  }
});

test('a delete event claimed by a ticket is the echo of our own removal', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.state.data.materialized[id] = `${SHARE}/todo.md`;
  h.vault.seed(SHARE, 'd');
  h.tickets.arm('delete', `${SHARE}/todo.md`);
  h.resetCounts();

  h.watcher.onDelete(`${SHARE}/todo.md`, 'f');
  await h.watcher.flushDeleteBatch();

  assert.equal(h.counts.txns, 0);
  assert.equal(isLive(h.tree.get(id)!), true);
});

test('a delete arriving before ready is queued and applied on replay (I9)', async () => {
  const h = makeHarness();
  const id = mint(h.tree, { k: 'f', d: '', n: 'todo.md', s: 1 });
  h.state.data.materialized[id] = `${SHARE}/todo.md`;
  h.vault.seed(SHARE, 'd');
  h.setPhase('boot');
  h.resetCounts();

  h.watcher.onDelete(`${SHARE}/todo.md`, 'f');
  assert.equal(h.watcher.pendingEventCount, 1);
  assert.equal(h.counts.txns, 0);

  h.setPhase('ready');
  await h.watcher.flushPending();

  assert.equal(isLive(h.tree.get(id)!), false);
});

// ---------------------------------------------------------------- P2 §3.1: kind derivation

// The whole `'f'`/`'b'` split rests on ONE rule — `nodeKindOf` — being the only
// place a path becomes a tree kind. The handler is handed Obsidian's DISK kind,
// which is all Obsidian knows, and derives the tree kind itself.
test('an attachment dropped into the share mints a b node and is offered to the publisher', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seedBinary(`${SHARE}/diagram.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

  await h.watcher.onCreate(`${SHARE}/diagram.png`, 'f');

  const nodes = fieldsOf(h.tree);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].k, 'b', 'a non-markdown file is an attachment node');
  assert.equal(nodes[0].rel, 'diagram.png');
  assert.equal(h.state.data.owned[nodes[0].id], true, 'I5: creator-ness is recorded locally');
  assert.deepEqual(h.published, [nodes[0].id], 'and its bytes are offered for publication');
  assert.equal(h.state.data.materialized[nodes[0].id], `${SHARE}/diagram.png`);
  assert.equal(h.tree.get(nodes[0].id)!.s, undefined, 'nothing is published by the watcher');
  assert.equal(h.vault.callsTo('read').length, 0, 'and the bytes are never decoded as text');
});

test('markdown still mints f, in any casing, and a folder still mints d', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/todo.md`, 'f', 'body');
  h.vault.seed(`${SHARE}/Notes.MD`, 'f', 'body');
  h.vault.seed(`${SHARE}/Album`, 'd');

  await h.watcher.onCreate(`${SHARE}/todo.md`, 'f');
  await h.watcher.onCreate(`${SHARE}/Notes.MD`, 'f');
  await h.watcher.onCreate(`${SHARE}/Album`, 'd');

  const byRel = new Map(fieldsOf(h.tree).map((n) => [n.rel, n.k]));
  assert.deepEqual(
    [...byRel].sort(),
    [['Album', 'd'], ['Notes.MD', 'f'], ['todo.md', 'f']],
    'the extension test is case-folded: Notes.MD is a note and never an attachment',
  );
});

test('a refused extension mints nothing at all', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/setup.exe`, 'f', 'MZ');
  h.resetCounts();

  await h.watcher.onCreate(`${SHARE}/setup.exe`, 'f');

  assert.equal(h.tree.size(), 0, 'an executable is not shareable in either kind');
  assert.equal(h.counts.txns, 0);
  assert.deepEqual(h.published, []);
});

// B19. The single most common attachment operation there is. The scope test used
// to be handed Obsidian's DISK kind, so `validateRel(d, n, 'f')` refused every
// non-`.md` name and the move was misrouted to `queueUnshare` — a workspace-wide
// tombstone, or a silent undo of the user's move.
test('B19: moving an attachment inside the share rewrites d and never asks to unshare', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const id = mint(h.tree, { k: 'b', d: '', n: 'x.png', s: 1, b: `${'a'.repeat(64)}:12:-` });
  h.state.data.materialized[id] = `${SHARE}/x.png`;
  h.vault.seedBinary(`${SHARE}/img/x.png`, new Uint8Array([1, 2, 3]));
  h.resetCounts();

  await h.watcher.onRename(`${SHARE}/img/x.png`, `${SHARE}/x.png`, 'f');
  await h.watcher.flushUnshare();

  const f = h.tree.get(id)!;
  assert.equal(relPath(f), 'img/x.png', 'the move is a `d` rewrite, nothing more');
  assert.equal(isLive(f), true, 'and never a tombstone');
  assert.equal(f.x, undefined);
  assert.deepEqual(h.unsharePrompts, [], 'the user is not asked to stop sharing their own move');
  assert.equal(h.state.data.materialized[id], `${SHARE}/img/x.png`);
  assert.equal(h.vault.callsTo('readBinary').length, 0, 'a move never reads the bytes');
});

// B20. A folder rename is one `d` rewrite per descendant and nothing else: the
// bytes never move over the wire, and renaming a 200 MB video costs nothing.
test('B20: renaming a folder of 50 attachments rewrites one d per node and moves no bytes', async () => {
  const h = makeCountingHarness();
  h.vault.seed(SHARE, 'd');
  const folder = mint(h.counting, { k: 'd', d: '', n: 'Album' });
  h.state.data.materialized[folder] = `${SHARE}/Album`;
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) {
    const name = `photo-${pad(i)}.png`;
    const id = mint(h.counting, { k: 'b', d: 'Album', n: name, s: 1, b: `${'b'.repeat(64)}:9:-` });
    h.state.data.materialized[id] = `${SHARE}/Album/${name}`;
    ids.push(id);
  }
  h.vault.seed(`${SHARE}/Photos`, 'd');
  for (let i = 0; i < 50; i++) h.vault.seedBinary(`${SHARE}/Photos/photo-${pad(i)}.png`, new Uint8Array([i]));
  h.resetCounts();
  h.counting.patches = 0;

  await h.watcher.onRename(`${SHARE}/Photos`, `${SHARE}/Album`, 'd');

  assert.equal(h.counts.txns, 1, 'one transaction for the whole subtree');
  assert.equal(h.counting.patches, 51, 'the folder plus one `d` rewrite per attachment');
  for (const id of ids) {
    const f = h.counting.get(id)!;
    assert.equal(f.d, 'Photos');
    assert.equal(isLive(f), true);
    assert.equal(h.state.data.materialized[id]?.startsWith(`${SHARE}/Photos/`), true);
  }
  assert.deepEqual(h.unsharePrompts, []);
  assert.equal(h.vault.callsTo('readBinary').length, 0, 'zero byte transfers');

  // Obsidian may or may not emit an event per descendant; either way the tree
  // already says what those events are about to claim (I8).
  h.counting.patches = 0;
  h.resetCounts();
  for (let i = 0; i < 50; i++) {
    await h.watcher.onRename(
      `${SHARE}/Photos/photo-${pad(i)}.png`,
      `${SHARE}/Album/photo-${pad(i)}.png`,
      'f',
    );
  }
  assert.equal(h.counting.patches, 0, 'every descendant event is a no-op');
  assert.equal(h.counts.txns, 0);
});

// §3.8's first clause. A dead node's `xh` is a hash of TEXT for a note and of RAW
// BYTES for an attachment; letting one kind adopt the other's tombstone binds a
// node whose `b` names completely different content.
test('a dead note never resurrects into an attachment at the same path', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const gone = mint(h.tree, {
    k: 'b', d: '', n: 'diagram.png', s: 1, b: `${'c'.repeat(64)}:3:-`,
    x: 1, xa: NOW - 1_000, xh: 'c'.repeat(64),
  });
  h.vault.seed(`${SHARE}/diagram.png`, 'f', '');       // a zero-length file at the same path

  await h.watcher.onCreate(`${SHARE}/diagram.png`, 'f');

  assert.equal(isLive(h.tree.get(gone)!), false, 'the dead attachment stays dead');
  const live = fieldsOf(h.tree).filter((n) => n.live);
  assert.equal(live.length, 1, 'a fresh node is minted instead');
  assert.notEqual(live[0].id, gone);
  assert.equal(live[0].k, 'b');
  assert.equal(h.vault.callsTo('read').length, 0, 'and the PNG is never decoded as text');
});

// ---------------------------------------------------------------- I1 guard

test('the watcher never names an irreversible vault call (I1)', () => {
  // Spelled indirectly for the same reason Deletions.test.ts does: invariant I1
  // requires these two strings to appear NOWHERE under src/, and a test that
  // wrote them out would itself break the grep.
  const banned = [`vault.${'delete'}(`, `${'trash'}(file, true)`];
  const source = readFileSync(new URL('./VaultWatcher.ts', import.meta.url), 'utf8');
  for (const needle of banned) {
    assert.ok(!source.includes(needle), `VaultWatcher.ts must not contain ${JSON.stringify(needle)}`);
  }
  assert.ok(!/from ['"]obsidian['"]/.test(source), 'no obsidian import');
});
