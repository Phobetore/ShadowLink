// src/sync/WorkspaceSession.test.ts
//
// Spec §6.1. The session is the one component that binds a shared document into
// the live editor, so every test below is about a way that goes wrong:
//
//  - I4: seeding a document whose provider never synced doubles it on reconnect.
//  - I5: seeding a document this device did not create concatenates two copies
//        of the note into every peer's editor.
//  - I7: mounting the wrong document into the wrong leaf, which the (up to ~11 s)
//        wait window makes reachable whenever the user switches notes.
//  - I17: marking a node published before the server acknowledged the write, or
//        recording a watermark for bytes this device does not hold.
//
// This header used to end "everything except the CodeMirror mount runs against
// the in-memory fakes; the mount itself is behind `EditorBinding` and is
// GUI-verified (spec §10 Group D)". That sentence cost a live share. `mount` was
// binding a shared document into an editor it never made equal to it, and the
// fake behind `EditorBinding` had no document to be wrong about — so "mounted a
// 184-character document into an editor showing 166 characters" and "mounted
// correctly" were the same assertion, in every one of these tests.
//
// `EditorState` needs no DOM. `CodeMirrorBinding` is therefore driven directly,
// at the bottom of this file, and the session runs against `FakeEditorBinding`,
// which keeps a real document per leaf and runs that same shipped binding over
// it. What is genuinely GUI-only is narrower than it looked: whether Obsidian
// saves the buffer the mount dirtied, and how soon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { EditorState, Transaction } from '@codemirror/state';
import type { Extension, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { RECOVERED_DIR } from '../tree/constants.ts';
import { hashOf } from '../tree/paths.ts';
import { TreeDoc } from '../tree/TreeDoc.ts';
import { DeviceState, type StatePort } from './DeviceState.ts';
import { FakeEditorBinding, FakeVault } from './fakes.ts';
import type { Kind, VaultPort } from './VaultPort.ts';
import {
  CodeMirrorBinding,
  WorkspaceSession,
  affixEdit,
  decide,
  retains,
  type MountResult,
  type ProviderPort,
  type SessionAwareness,
  type SessionProvider,
  type WorkspaceSessionDeps,
} from './WorkspaceSession.ts';

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

interface RoomConfig {
  /** 'immediate' syncs inside `connect`; 'manual' waits for `emitSync()`. */
  mode: 'immediate' | 'manual';
  /** What the server already holds, applied to the doc when the room syncs. */
  remote: string;
  /**
   * The same thing as the UPDATE it actually is, for the tests where the shared
   * history matters.
   *
   * `remote` inserts a string locally, so two rooms configured with one string
   * hold two disjoint Yjs insertions — which is the right model for "two devices
   * seeded the same doc" (I5) and the wrong one for "two devices received the
   * same doc". Convergence after a concurrent repair is only a question at all in
   * the second case.
   */
  remoteUpdate: Uint8Array | null;
  /** What `flush()` resolves to. False models "the update never came back". */
  flushConfirmed: boolean;
  /** When set, `flush()` blocks until the test releases it. */
  gateFlush: boolean;
}

class FakeAwareness implements SessionAwareness {
  readonly fields = new Map<string, unknown>();
  setLocalStateField(field: string, value: unknown): void {
    this.fields.set(field, value);
  }
}

class FakeProvider implements SessionProvider {
  synced = false;
  destroyed = false;
  disconnected = false;
  flushes = 0;
  readonly awareness = new FakeAwareness();

  /** Resolved by `releaseFlush()` when the room is configured to gate flushes. */
  private flushGate: (() => void) | null = null;
  private readonly handlers = new Set<(isSynced: boolean) => void>();

  constructor(
    readonly room: string,
    readonly doc: Y.Doc,
    private readonly config: RoomConfig,
  ) {}

  on(_event: 'sync', handler: (isSynced: boolean) => void): void {
    this.handlers.add(handler);
  }

  off(_event: 'sync', handler: (isSynced: boolean) => void): void {
    this.handlers.delete(handler);
  }

  async flush(): Promise<boolean> {
    this.flushes += 1;
    if (this.config.gateFlush) {
      await new Promise<void>((resolve) => { this.flushGate = resolve; });
    }
    return this.config.flushConfirmed;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Deliver the server's state and announce a GENUINE sync. */
  emitSync(): void {
    if (this.config.remoteUpdate !== null) {
      Y.applyUpdate(this.doc, this.config.remoteUpdate);
    } else if (this.config.remote.length > 0 && this.doc.getText('content').length === 0) {
      this.doc.getText('content').insert(0, this.config.remote);
    }
    this.synced = true;
    for (const handler of [...this.handlers]) handler(true);
  }

  releaseFlush(): void {
    this.flushGate?.();
    this.flushGate = null;
  }

  /** The server coming back: every later `flush()` confirms. */
  confirmFlushes(): void {
    this.config.flushConfirmed = true;
  }

  get flushPending(): boolean {
    return this.flushGate !== null;
  }
}

class FakeProviders implements ProviderPort {
  readonly created: FakeProvider[] = [];
  private readonly configs = new Map<string, RoomConfig>();

  configure(room: string, over: Partial<RoomConfig>): void {
    this.configs.set(room, { ...this.configOf(room), ...over });
  }

  connect(room: string, doc: Y.Doc): SessionProvider {
    const config = this.configOf(room);
    const provider = new FakeProvider(room, doc, config);
    this.created.push(provider);
    if (config.mode === 'immediate') provider.emitSync();
    return provider;
  }

  forRoom(room: string): FakeProvider[] {
    return this.created.filter((p) => p.room === room);
  }

  private configOf(room: string): RoomConfig {
    return this.configs.get(room)
      ?? {
        mode: 'immediate', remote: '', remoteUpdate: null, flushConfirmed: true, gateFlush: false,
      };
  }
}

/**
 * `FakeVault` with one operation parked until the test releases it, so an open
 * can be superseded at a precise await point rather than by luck of scheduling.
 */
class GatedVault implements VaultPort {
  /** One-shot: the next call of each listed op blocks. */
  readonly gates = new Set<'read' | 'create'>();
  /** When true, the parked call rejects once released. */
  rejectOnRelease = false;

  private waiting: (() => void) | null = null;

  constructor(private readonly inner: FakeVault) {}

  get parked(): boolean {
    return this.waiting !== null;
  }

  release(): void {
    const resume = this.waiting;
    this.waiting = null;
    resume?.();
  }

  private async gate(op: 'read' | 'create'): Promise<void> {
    if (!this.gates.delete(op)) return;
    await new Promise<void>((resolve) => { this.waiting = resolve; });
    if (this.rejectOnRelease) throw new Error('gated failure');
  }

  list(): Array<{ path: string; kind: Kind }> { return this.inner.list(); }
  exists(path: string): Promise<boolean> { return this.inner.exists(path); }
  listDir(path: string): Promise<string[]> { return this.inner.listDir(path); }
  async read(path: string): Promise<string> {
    await this.gate('read');
    return this.inner.read(path);
  }
  async create(path: string, data: string): Promise<void> {
    await this.gate('create');
    return this.inner.create(path, data);
  }
  readBinary(path: string): Promise<Uint8Array> { return this.inner.readBinary(path); }
  createBinary(path: string, data: Uint8Array): Promise<void> {
    return this.inner.createBinary(path, data);
  }
  stat(path: string): ReturnType<VaultPort['stat']> { return this.inner.stat(path); }
  createFolder(path: string): Promise<void> { return this.inner.createFolder(path); }
  rename(from: string, to: string): Promise<void> { return this.inner.rename(from, to); }
  trashLocal(path: string): Promise<void> { return this.inner.trashLocal(path); }
  isOpenInLeaf(path: string): boolean { return this.inner.isOpenInLeaf(path); }
}

/**
 * A vault whose `create` always fails — a full disk, a read-only volume, a
 * permission the user revoked. I15's rule is that the failure must not abort the
 * open and must not be silent; I1's is that it must not be followed by a bind,
 * because a bind lets Obsidian save the shared text over bytes nothing holds.
 */
class RefusingCreate implements VaultPort {
  constructor(private readonly inner: FakeVault) {}

  create(): Promise<void> {
    return Promise.reject(new Error('the disk is full'));
  }

  exists(path: string): Promise<boolean> { return this.inner.exists(path); }
  list(): Array<{ path: string; kind: Kind }> { return this.inner.list(); }
  listDir(path: string): Promise<string[]> { return this.inner.listDir(path); }
  read(path: string): Promise<string> { return this.inner.read(path); }
  readBinary(path: string): Promise<Uint8Array> { return this.inner.readBinary(path); }
  createBinary(path: string, data: Uint8Array): Promise<void> {
    return this.inner.createBinary(path, data);
  }
  stat(path: string): ReturnType<VaultPort['stat']> { return this.inner.stat(path); }
  createFolder(path: string): Promise<void> { return this.inner.createFolder(path); }
  rename(from: string, to: string): Promise<void> { return this.inner.rename(from, to); }
  trashLocal(path: string): Promise<void> { return this.inner.trashLocal(path); }
  isOpenInLeaf(path: string): boolean { return this.inner.isOpenInLeaf(path); }
}

interface Harness {
  vault: FakeVault;
  state: DeviceState;
  tree: TreeDoc;
  providers: FakeProviders;
  editor: FakeEditorBinding;
  session: WorkspaceSession;
  notices: string[];
  active: { path: string | null };
  /**
   * Mint a live file node at `Shared/<name>`, put `text` on disk, and open a leaf
   * showing it. The leaf holds the FILE's bytes, because that is what Obsidian
   * puts in an editor — which is the whole point: it may differ from the shared
   * document, and until this fake had a document no test could say so.
   */
  add(name: string, text: string, over?: { s?: 1; owned?: boolean; initialized?: boolean }): string;
  /** Every path under `ShadowLink Recovered/`, with its contents. */
  stashes(): Array<[string, string]>;
}

function makeHarness(
  over: Partial<WorkspaceSessionDeps> = {},
  opts: { wrapVault?: (inner: FakeVault) => VaultPort } = {},
): Harness {
  const vault = new FakeVault();
  const state = new DeviceState(new MemoryStatePort(), 'device-1', 'ws-1', () => NOW, 0);
  const tree = new TreeDoc();
  const providers = new FakeProviders();
  const editor = new FakeEditorBinding(vault);
  const notices: string[] = [];
  const active: { path: string | null } = { path: null };
  vault.seed(SHARE, 'd');

  const session = new WorkspaceSession({
    vault: opts.wrapVault ? opts.wrapVault(vault) : vault,
    state,
    tree,
    providers,
    editor,
    shareRoot: () => SHARE,
    activePath: () => active.path,
    userName: 'Ada',
    userColor: '#ff0000',
    notice: (msg) => { notices.push(msg); },
    now: () => NOW,
    // Short waits: every timeout below is a real timer, so the suite must not
    // sit through the production 3 s / 8 s windows.
    nodeWaitMs: 20,
    syncTimeoutMs: 20,
    ...over,
  });

  return {
    vault, state, tree, providers, editor, session, notices, active,
    add(name, text, opts = {}) {
      const id = tree.createNode({ k: 'f', d: '', n: name, ...(opts.s ? { s: 1 } : {}) }, NOW);
      vault.seed(`${SHARE}/${name}`, 'f', text);
      editor.openLeaf(`${SHARE}/${name}`, text, { initialized: opts.initialized ?? true });
      state.data.materialized[id] = `${SHARE}/${name}`;
      if (opts.owned) state.data.owned[id] = true;
      active.path = `${SHARE}/${name}`;
      return id;
    },
    stashes() {
      return Object.entries(vault.snapshot()).filter(([p]) => p.startsWith(`${RECOVERED_DIR}/`));
    },
  };
}

/** Let queued microtasks and 0 ms timers run. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spin the event loop until `cond` holds.
 *
 * A fixed number of ticks is a bet on how many awaits a code path contains, and
 * the bet goes stale the moment one is added or removed. This waits for the
 * CONDITION and says what it was waiting for when it never arrives.
 */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

function mutations(vault: FakeVault): number {
  return vault.calls.filter(
    (c) => c.op === 'create' || c.op === 'createFolder' || c.op === 'rename' || c.op === 'trashLocal',
  ).length;
}

// ================================================================ openNodeId

test('openNodeId is null before an open, the bound node while open, and null after close', async () => {
  const h = makeHarness();
  assert.equal(h.session.openNodeId(), null);

  const id = h.add('a.md', 'body', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'body' });
  await h.session.open(`${SHARE}/a.md`);

  assert.equal(h.session.openNodeId(), id, 'the reconciler and the publish queue read this (I7)');

  await h.session.open(null);
  assert.equal(h.session.openNodeId(), null);
  assert.equal(h.editor.unmounts, 1);
});

test('destroy tears the session down and releases the provider', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'body', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'body' });
  await h.session.open(`${SHARE}/a.md`);

  await h.session.destroy();

  assert.equal(h.session.openNodeId(), null);
  assert.equal(h.providers.created[0].destroyed, true);
  assert.equal(h.editor.unmounts, 1);
});

// ================================================================ room resolution

test('a path with no node yet falls back to local-only editing, never a guessed room', async () => {
  const h = makeHarness();
  h.vault.seed(`${SHARE}/orphan.md`, 'f', 'local body');
  h.active.path = `${SHARE}/orphan.md`;

  await h.session.open(`${SHARE}/orphan.md`);

  assert.equal(h.providers.created.length, 0, 'no room was guessed');
  assert.equal(h.editor.mounts.length, 0);
  assert.equal(h.session.openNodeId(), null);
  assert.ok(h.notices.some((n) => n.includes('locally only')), h.notices.join('|'));
});

test('a node that appears while the open is waiting is picked up', async () => {
  const h = makeHarness({ nodeWaitMs: 500 });
  h.vault.seed(`${SHARE}/late.md`, 'f', 'body');
  h.editor.openLeaf(`${SHARE}/late.md`, 'body');
  h.active.path = `${SHARE}/late.md`;

  const opening = h.session.open(`${SHARE}/late.md`);
  await tick();
  const id = h.tree.createNode({ k: 'f', d: '', n: 'late.md', s: 1 }, NOW);
  h.providers.configure(`n_${id}`, { remote: 'body' });
  await opening;

  assert.equal(h.session.openNodeId(), id);
  assert.equal(h.providers.created[0].room, `n_${id}`);
});

test('a path outside the share never resolves a room', async () => {
  const h = makeHarness();
  h.tree.createNode({ k: 'f', d: '', n: 'a.md', s: 1 }, NOW);
  h.vault.seed('Elsewhere/a.md', 'f', 'body');
  h.active.path = 'Elsewhere/a.md';

  await h.session.open('Elsewhere/a.md');

  assert.equal(h.providers.created.length, 0);
  assert.equal(h.editor.mounts.length, 0);
});

test('a sibling path that lines up with the share root by length resolves nothing', async () => {
  // The classic prefix trap. `SharedXnotes/x.md` is NOT inside `Shared`, but it
  // is exactly one character longer, so slicing off `root.length + 1` characters
  // yields `notes/x.md` — the share-relative path of a real node. Only the '/'
  // boundary test tells the two apart, and without it this unrelated file would
  // be bound to another note's document and its bytes published into it.
  const h = makeHarness();
  h.tree.createNode({ k: 'd', d: '', n: 'notes' }, NOW);
  h.tree.createNode({ k: 'f', d: 'notes', n: 'x.md', s: 1 }, NOW);
  h.vault.seed(`${SHARE}/notes/x.md`, 'f', 'shared body');
  h.vault.seed('SharedXnotes/x.md', 'f', 'unrelated body');
  h.active.path = 'SharedXnotes/x.md';

  await h.session.open('SharedXnotes/x.md');

  assert.equal(h.providers.created.length, 0, 'no room was borrowed from the share');
  assert.deepEqual(h.vault.callsTo('read'), [], 'resolution stopped before anything was read');
  assert.equal(h.editor.mounts.length, 0);
});

test('the shared folder itself is never a note (I14)', async () => {
  const h = makeHarness();
  h.tree.createNode({ k: 'f', d: '', n: 'a.md', s: 1 }, NOW);
  h.active.path = SHARE;

  await h.session.open(SHARE);

  assert.equal(h.providers.created.length, 0);
  assert.equal(h.session.openNodeId(), null);
});

test('a directory node is never mistaken for a note', async () => {
  // Folders may legitimately be named like notes ("2024.Q1", "Notes.md"), and a
  // folder node carries no content doc at all.
  const h = makeHarness();
  h.tree.createNode({ k: 'd', d: '', n: 'Notes.md' }, NOW);
  h.vault.seed(`${SHARE}/Notes.md`, 'd');
  h.active.path = `${SHARE}/Notes.md`;

  await h.session.open(`${SHARE}/Notes.md`);

  assert.equal(h.providers.created.length, 0, 'a folder has no room');
  assert.deepEqual(h.vault.callsTo('read'), [], 'resolution stopped before anything was read');
  assert.equal(h.editor.mounts.length, 0);
  assert.equal(h.session.openNodeId(), null);
});

test('the room is the node id, so a rename cannot change it', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'body', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'body' });

  await h.session.open(`${SHARE}/a.md`);
  assert.equal(h.providers.created[0].room, `n_${id}`);

  // The reconciler renames the file; the node id is untouched.
  h.tree.patchNode(id, { n: 'b.md' });
  await h.vault.rename(`${SHARE}/a.md`, `${SHARE}/b.md`);
  h.state.data.materialized[id] = `${SHARE}/b.md`;
  h.active.path = `${SHARE}/b.md`;
  h.vault.resetCalls();

  await h.session.open(`${SHARE}/b.md`);
  assert.equal(h.providers.created[1].room, `n_${id}`, 'same room after a rename');
});

// ================================================================ I4 — sync

test('a provider that never syncs is torn down and seeds nothing (I4)', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'local body', { owned: true });
  h.providers.configure(`n_${id}`, { mode: 'manual' });

  await h.session.open(`${SHARE}/a.md`);

  const provider = h.providers.created[0];
  assert.equal(provider.destroyed, true, 'the unsynced provider was released');
  assert.equal(provider.doc.getText('content').toString(), '', 'nothing was seeded (I4)');
  assert.equal(h.editor.mounts.length, 0, 'and nothing was mounted');
  assert.equal(h.session.openNodeId(), null);
  assert.equal(h.tree.get(id)?.s, undefined, 's was not set');
  assert.ok(h.notices.some((n) => n.includes('not syncing')), h.notices.join('|'));
});

// ================================================================ I5 — owner gate

test('a device that does not own an unseeded node never seeds it (I5)', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'my local copy');           // no owned[] entry
  h.providers.configure(`n_${id}`, { remote: '' });

  await h.session.open(`${SHARE}/a.md`);

  const provider = h.providers.created[0];
  assert.equal(provider.doc.getText('content').toString(), '', 'the doc stays empty (I5)');
  assert.equal(provider.destroyed, true);
  assert.equal(h.editor.mounts.length, 0, 'a stub is never mounted (I6)');
  assert.equal(h.tree.get(id)?.s, undefined);
  assert.ok(h.notices.some((n) => n.includes('author')), h.notices.join('|'));
});

test('the owner seeds an empty unseeded doc from the file being opened, then marks it seeded', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'the real bytes', { owned: true });
  h.providers.configure(`n_${id}`, { remote: '' });

  await h.session.open(`${SHARE}/a.md`);

  const provider = h.providers.created[0];
  assert.equal(provider.doc.getText('content').toString(), 'the real bytes');
  assert.equal(h.tree.get(id)?.s, 1, 's is set once the flush confirmed (I17)');
  assert.equal(h.editor.current?.notePath, `${SHARE}/a.md`);
  assert.equal(h.editor.current?.text, provider.doc.getText('content'));
  assert.deepEqual(provider.awareness.fields.get('user'), {
    name: 'Ada', color: '#ff0000', colorLight: '#ff000033',
  }, 'peers can see this cursor');

  // The seed came from the path being opened, not from an ambient editor.
  const reads = h.vault.callsTo('read').map((c) => c.args[0]);
  assert.deepEqual(reads, [`${SHARE}/a.md`]);

  const hash = await hashOf('the real bytes');
  assert.deepEqual(h.state.data.contentHash[id], { sha256: hash, len: 14 }, 'I17 watermark');
});

test('an unconfirmed flush leaves the node unseeded (I17)', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'bytes', { owned: true });
  h.providers.configure(`n_${id}`, { remote: '', flushConfirmed: false });

  await h.session.open(`${SHARE}/a.md`);

  assert.equal(h.tree.get(id)?.s, undefined, 'an unconfirmed flush is a retry, never a completion');
  assert.equal(h.session.openNodeId(), id, 'the user still edits their own note');
  assert.equal(h.state.data.contentHash[id], undefined, 'and no watermark advanced');
});

test('an already-seeded empty document is never re-seeded, and the empty doc wins', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'local leftovers', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: '' });

  await h.session.open(`${SHARE}/a.md`);

  const provider = h.providers.created[0];
  assert.equal(provider.flushes, 0, 'no seed was attempted');
  assert.equal(provider.doc.getText('content').toString(), '');
  assert.equal(h.editor.current?.notePath, `${SHARE}/a.md`);
  // This test's comment used to say "The shared (empty) doc wins; the local
  // bytes are preserved out of the way" and assert neither half. Both halves are
  // the point: the second is I1, and the first is the only thing that stops the
  // next open finding the same divergence and stashing again.
  assert.equal(h.editor.document(`${SHARE}/a.md`), '', 'the shared (empty) doc wins in the editor');
  assert.deepEqual(h.stashes().map(([, text]) => text), ['local leftovers'], 'and the bytes are kept');
});

// ================================================================ I6 — publishing
//
// `s` is the whole definition of "published" for a note, and it had three
// writers. This one was the unguarded one, and it was also the one that ran
// first: Obsidian's "New note" is a 0-byte file that Obsidian then OPENS, so the
// session reached it before the queue could refuse it, flushed an empty
// document — which round-trips and confirms perfectly, and confirms nothing —
// and told every peer to materialize content that does not exist. A 0-byte file
// on the canonical path looks correct, gets deleted by hand, and that hand
// deletion is a tombstone that propagates to everybody, the author included.

test('an empty new note is not published just because Obsidian opened it (I6)', async () => {
  const h = makeHarness();
  const id = h.add('Untitled.md', '', { owned: true });
  const path = `${SHARE}/Untitled.md`;
  h.providers.configure(`n_${id}`, { remote: '' });

  await h.session.open(path);
  await h.session.open(null);
  await h.session.open(path);

  assert.equal(h.tree.get(id)?.s, undefined, 'nothing has been published, because nothing exists');
  assert.equal(h.state.data.contentHash[id], undefined, 'and no watermark names 0 bytes');
  assert.equal(h.session.openNodeId(), id, 'the note is perfectly editable meanwhile');
  assert.deepEqual(h.notices, []);
});

test('the same note goes live the moment it has a byte in it', async () => {
  // Not when it closes. `publishOne` DEFERS on a node this session holds open
  // (I7), and a deferral is "not now" rather than "not ever", so without this the
  // note is invisible to every peer for as long as it is open and the entry keeps
  // asking the reconciler to look at it.
  //
  // The first byte arrives through the document rather than through `type()`,
  // because the editor -> Y.Text direction is `yCollab`'s and the fake
  // deliberately does not re-implement it. What is being tested is the observer
  // on the document, which is where that direction lands in production too.
  const published: string[] = [];
  const h = makeHarness({ markPublished: (nodeId) => { published.push(nodeId); } });
  const id = h.add('Untitled.md', '', { owned: true });
  const path = `${SHARE}/Untitled.md`;
  h.providers.configure(`n_${id}`, { remote: '' });

  await h.session.open(path);
  assert.equal(h.tree.get(id)?.s, undefined);

  h.editor.remoteDelta(path, (t) => { t.insert(0, 'A'); });
  await until(() => h.tree.get(id)?.s === 1, 'the node to be published');

  assert.deepEqual(published, [id], 'and the queue is told, so its entry stops asking');
  assert.equal(
    h.state.data.contentHash[id], undefined,
    'but no watermark: the disk still holds the old bytes until Obsidian saves (I17)',
  );
  assert.equal(h.editor.document(path), 'A');
});

test('an unconfirmed first flush retries on the next byte rather than giving up', async () => {
  const h = makeHarness();
  const id = h.add('Untitled.md', '', { owned: true });
  const path = `${SHARE}/Untitled.md`;
  h.providers.configure(`n_${id}`, { remote: '', flushConfirmed: false });

  await h.session.open(path);
  h.editor.remoteDelta(path, (t) => { t.insert(0, 'A'); });
  await until(() => h.notices.length > 0, 'the retry notice');

  assert.equal(h.tree.get(id)?.s, undefined, 'an unconfirmed flush is a retry, never a completion');
  assert.deepEqual(h.notices, ['This note has not reached the server yet; it will retry.']);

  h.providers.forRoom(`n_${id}`)[0].confirmFlushes();
  h.editor.remoteDelta(path, (t) => { t.insert(1, 'B'); });
  await until(() => h.tree.get(id)?.s === 1, 'the retry to land');

  assert.equal(h.notices.length, 1, 'and it is not said twice');
});

test('closing the note disarms the publisher', async () => {
  const h = makeHarness();
  const id = h.add('Untitled.md', '', { owned: true });
  const path = `${SHARE}/Untitled.md`;
  h.providers.configure(`n_${id}`, { remote: '' });

  await h.session.open(path);
  const text = h.providers.created[0].doc.getText('content');
  await h.session.open(null);
  text.insert(0, 'typed after the session closed');
  await tick();

  assert.equal(h.tree.get(id)?.s, undefined, 'a closed session publishes nothing');
});

// ================================================================ divergence
//
// The lengths below are the ones that were on disk in the incident: the
// workspace held 184 characters, the peer's file held 166, and the peer's 166
// were NOT a prefix of the 184 — an earlier revision, not a truncation. Nothing
// in this product could tell those apart, which is why the peer displayed a
// stale note indefinitely and nothing ever noticed.

const STALE = '# Sans titre\n\nAn earlier revision, still sitting on the peer\'s disk.'.padEnd(166, '.');
const SHARED = '# Sans titre\n\nThe workspace\'s revision, which that peer has never seen.'.padEnd(184, '.');

test('the divergence fixture matches the incident: 166 vs 184, and not a prefix', () => {
  assert.equal(STALE.length, 166);
  assert.equal(SHARED.length, 184);
  assert.equal(SHARED.startsWith(STALE), false, 'an earlier revision, not a truncation');
});

test('a peer holding a stale revision gets the shared document, on screen and on disk', async () => {
  // The failure the user met, in the shape it was found in: vault B's file is an
  // earlier revision of a note the workspace has moved past, B's editor shows
  // B's file, and no pass in this product will ever revisit a bound note.
  //
  // Before the fix this stopped at the first assertion: `mount` reconfigured a
  // compartment and touched neither the editor nor the file, so the editor still
  // showed the 166 stale characters and the disk still held them — for ever.
  const h = makeHarness();
  const id = h.add('Sans titre.md', STALE, { s: 1 });
  h.providers.configure(`n_${id}`, { remote: SHARED });
  const path = `${SHARE}/Sans titre.md`;

  await h.session.open(path);

  assert.equal(h.editor.document(path), SHARED, 'the editor shows the shared document');
  assert.equal(h.session.openNodeId(), id, 'and it is genuinely bound');

  // Obsidian, not the plugin, is what puts an open note's bytes on disk (I7).
  assert.equal(h.vault.snapshot()[path], STALE, 'until Obsidian saves, the disk still lags');
  h.editor.save(path);
  assert.equal(h.vault.snapshot()[path], SHARED, 'and then the file is the workspace\'s copy');

  // The bytes that were replaced were preserved first, exactly once.
  assert.deepEqual(h.stashes().map(([, text]) => text), [STALE]);
  assert.equal(h.vault.wasTrashed(path), false, 'nothing was destroyed (I1)');
  assert.ok(h.notices.some((n) => n.includes(RECOVERED_DIR)), h.notices.join('|'));
});

test('nine opens of a stale note produce one copy, not nine', async () => {
  // `ShadowLink Recovered/` held nine near-identical files three minutes after
  // the share was created, and one of them — in the surviving evidence — was
  // byte-identical to the file still sitting at the canonical path. A stash of
  // bytes nothing replaced preserves nothing; a second stash of bytes already
  // preserved preserves nothing either.
  const h = makeHarness();
  const id = h.add('Sans titre.md', STALE, { s: 1 });
  h.providers.configure(`n_${id}`, { remote: SHARED });
  const path = `${SHARE}/Sans titre.md`;

  for (let i = 0; i < 9; i++) {
    await h.session.open(path);
    await h.session.open(null);
    // Deliberately NOT saving: this models the window in which Obsidian has not
    // written the buffer yet, which is the window all nine landed in.
  }

  const stashes = h.stashes();
  assert.equal(stashes.length, 1, stashes.map(([p]) => p).join(' | '));
  assert.equal(stashes[0][1], STALE, 'and it holds the revision that was replaced');
});

test('a stale copy that is empty is not stashed at all', async () => {
  // The loud version of the same failure: a peer materialized a 0-byte file from
  // a document that was empty at that instant, and every open wrote a 0-byte
  // "local copy" of it. Nine files, not one of which held anything.
  const h = makeHarness();
  const id = h.add('Sans fasdfa1.md', '', { s: 1 });
  h.providers.configure(`n_${id}`, { remote: 'fasdffasdfsdfs' });
  const path = `${SHARE}/Sans fasdfa1.md`;

  await h.session.open(path);

  assert.deepEqual(h.stashes(), [], 'a copy of nothing preserves nothing');
  assert.equal(
    h.notices.some((n) => n.includes(RECOVERED_DIR)),
    false,
    'and no notice claims a copy was saved',
  );
  assert.equal(h.editor.document(path), 'fasdffasdfsdfs', 'the content finally appears');
  h.editor.save(path);
  assert.equal(h.vault.snapshot()[path], 'fasdffasdfsdfs');
});

test('a remote edit after a divergent open lands in the editor instead of raising', async () => {
  // The user's console, and the reason it was full of RangeErrors:
  //
  //   RangeError: Invalid change range 15 to 16 (in doc of length 0)
  //   RangeError: Invalid position 184 in document of length 166
  //
  // `YSyncPluginValue._observer` turns a Y.Text delta into CodeMirror changes at
  // Y.Text offsets and checks nothing about the editor's length, because the
  // library's contract is that the two were equal at bind time. A mount that
  // does not establish that makes every subsequent remote keystroke an error.
  const h = makeHarness();
  const id = h.add('Sans titre.md', STALE, { s: 1 });
  h.providers.configure(`n_${id}`, { remote: SHARED });
  const path = `${SHARE}/Sans titre.md`;

  await h.session.open(path);
  const text = h.providers.created[0].doc.getText('content');
  text.insert(text.length, ' and one more sentence.');

  assert.equal(h.editor.document(path), `${SHARED} and one more sentence.`);
});

test('an editor whose state has no compartment is refused before anything is decided', async () => {
  // `Compartment.reconfigure` aimed at a state that does not contain the
  // compartment is inert and SILENT. Without a liveness check the session is
  // told a binding exists when none does — so it defers the reconciler's repairs
  // for that node and records a watermark, for a note nothing is bound to.
  //
  // The check now lives in `bufferOf`, which is the first thing the session
  // asks: there is no buffer to decide about, so no plan is made, no arm runs,
  // and nothing is dispatched at the editor at all.
  const h = makeHarness();
  const id = h.add('a.md', 'body', { s: 1, owned: true, initialized: false });
  const path = `${SHARE}/a.md`;
  h.providers.configure(`n_${id}`, { remote: 'body' });

  await h.session.open(path);

  assert.equal(h.editor.bufferOf(path), null, 'there is no bindable leaf');
  assert.deepEqual(h.editor.mounts, [], 'so nothing was bound');
  assert.deepEqual(h.editor.transactions(path), [], 'and nothing was dispatched at it');
  assert.equal(h.session.openNodeId(), null, 'so nothing claims to be bound');
  assert.equal(h.providers.created[0].destroyed, true, 'and the provider was released');
  assert.equal(h.state.data.contentHash[id], undefined, 'and no watermark was recorded');
});

test('a local copy matching the shared document is not stashed', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'same\r\nbytes', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'same\nbytes' });

  await h.session.open(`${SHARE}/a.md`);

  assert.equal(mutations(h.vault), 0, 'CRLF on disk vs LF in the doc is not a difference (I18)');
  assert.equal(h.editor.current?.notePath, `${SHARE}/a.md`);
});

// ================================================================ the typing window
//
// Everything above reasons about two strings — the file's bytes and the shared
// document — and treats the editor as showing the first of them. Between the
// `vault.read` that starts an open and the bind that ends it there is a third
// string, and it is the newest: the buffer the user is typing into. That window
// is the provider's connect-and-sync round trip, i.e. the first second after
// opening a note, i.e. when people type.
//
// The previous round answered that with "preserve it elsewhere before you throw
// it away". These two say the answer is not to throw it away: on both arms below
// the buffer is PROVABLY this device's own continuation of the shared text, so
// it goes into the CRDT and the editor is never dispatched into at all. The
// cursor, the selection and the undo history all survive with it.

test('a brand-new note typed into while it opens keeps the typing, and shares it', async () => {
  // Blocker 1, and the worst of the six, because this is the SEEDING arm: the
  // shared document is empty by definition, the file is a 0-byte "New note", and
  // the buffer is the ONLY copy of that note in existence anywhere. The open
  // replaced it with the empty shared document and filed the user's first
  // sentence under ShadowLink Recovered/, beside a notice about "the shared
  // copy" that this very device was about to seed and that was empty.
  const h = makeHarness({ syncTimeoutMs: 5_000 });
  const id = h.add('Untitled.md', '', { owned: true });
  const path = `${SHARE}/Untitled.md`;
  h.providers.configure(`n_${id}`, { mode: 'manual', remote: '' });

  const open = h.session.open(path);
  await until(() => h.providers.forRoom(`n_${id}`).length === 1, 'the room to be opened');
  h.editor.type(path, 'the first sentence of a new note');
  h.providers.forRoom(`n_${id}`)[0].emitSync();
  await open;

  assert.equal(h.editor.document(path), 'the first sentence of a new note',
    'the typing is exactly where the user left it');
  const text = h.providers.created[0].doc.getText('content');
  assert.equal(text.toString(), 'the first sentence of a new note', 'and it is what got shared');
  assert.equal(h.editor.inStep(path), true);
  assert.equal(mutations(h.vault), 0, 'nothing was written anywhere else');
  assert.deepEqual(h.notices, [], 'and nothing was said, because nothing went wrong');
  assert.equal(h.tree.get(id)?.s, 1, 'the node is published, from content that exists');
});

test('keystrokes typed while a healthy note is opening stay in the editor', async () => {
  // Blocker 2. Nothing is wrong with this note: the file and the shared document
  // agree, so the open had no divergence to resolve and took no stash branch at
  // all — and it still threw the user's characters away, with no copy and no
  // notice, because the buffer stopped being the file's bytes the moment they
  // typed and the mount replaced the buffer unconditionally.
  const h = makeHarness({ syncTimeoutMs: 5_000 });
  const id = h.add('a.md', 'shared body', { s: 1, owned: true });
  const path = `${SHARE}/a.md`;
  h.providers.configure(`n_${id}`, { mode: 'manual', remote: 'shared body' });

  const open = h.session.open(path);
  await until(() => h.providers.forRoom(`n_${id}`).length === 1, 'the room to be opened');
  h.editor.type(path, ' plus what I just typed');
  h.providers.forRoom(`n_${id}`)[0].emitSync();
  await open;

  assert.equal(h.editor.document(path), 'shared body plus what I just typed');
  const text = h.providers.created[0].doc.getText('content');
  assert.equal(text.toString(), 'shared body plus what I just typed',
    'the workspace caught up to the buffer, not the other way round');
  assert.deepEqual(h.stashes(), [], 'nothing was displaced, so nothing was filed');
  assert.deepEqual(h.notices, []);

  // The editor was never dispatched into: one transaction, and it is the bind.
  const dispatched = h.editor.transactions(path).slice(1);   // [0] is the user's own typing
  assert.deepEqual(dispatched.map((tr) => tr.docChanged), [false],
    'the cursor, the selection and the undo history all survive');
});

test('the catch-up produces genuine ops, so a peer\'s edit after it still lands', async () => {
  // A converge-up that "worked" by replacing the Y.Text wholesale would pass the
  // assertion above and desynchronise every peer. This is the check that it is an
  // edit rather than a string.
  const h = makeHarness({ syncTimeoutMs: 5_000 });
  const id = h.add('a.md', 'one two three', { s: 1, owned: true });
  const path = `${SHARE}/a.md`;
  h.providers.configure(`n_${id}`, { mode: 'manual', remote: 'one two three' });

  const open = h.session.open(path);
  await until(() => h.providers.forRoom(`n_${id}`).length === 1, 'the room to be opened');
  h.editor.type(path, ' four', 'one two three'.length);
  h.providers.forRoom(`n_${id}`)[0].emitSync();
  await open;

  h.editor.remoteDelta(path, (t) => { t.insert(0, 'zero '); });

  assert.equal(h.editor.document(path), 'zero one two three four');
  assert.equal(h.editor.inStep(path), true);
});

test('a buffer that is not a continuation of this note never enters the CRDT', async () => {
  // The one hazard master did not have and none of the three designs closed.
  // `viewFor` resolves a leaf by `view.file.path` while reading `view.editor.cm`,
  // and Obsidian sets the file before it loads the document — so the buffer this
  // arm is about to broadcast can belong to a different note. It shares a prefix
  // and a suffix with the shared text, so an affix check alone accepts it.
  //
  // The retention bound refuses it: an edit may not delete more than half of the
  // shared text. Nothing is lost — the buffer is preserved and the user is told —
  // and the CRDT is untouched.
  const shared = `# Notes\n${'the workspace\'s own paragraph. '.repeat(12)}\nend`;
  const foreign = '# Notes\na line from another note entirely.\nend';
  const h = makeHarness({ syncTimeoutMs: 5_000 });
  const id = h.add('a.md', shared, { s: 1, owned: true });
  const path = `${SHARE}/a.md`;
  h.providers.configure(`n_${id}`, { mode: 'manual', remote: shared });

  const open = h.session.open(path);
  await until(() => h.providers.forRoom(`n_${id}`).length === 1, 'the room to be opened');
  h.editor.cut(path, '# Notes\n'.length, shared.length - '\nend'.length);
  h.editor.type(path, 'a line from another note entirely.', '# Notes\n'.length);
  assert.equal(h.editor.document(path), foreign, 'the fixture really is prefix- and suffix-sharing');
  h.providers.forRoom(`n_${id}`)[0].emitSync();
  await open;

  const text = h.providers.created[0].doc.getText('content');
  assert.equal(text.toString(), shared, 'nothing entered the CRDT');
  assert.equal(h.editor.document(path), shared, 'and the editor shows the workspace\'s copy');
  assert.deepEqual(h.stashes().map(([, t]) => t), [foreign], 'the buffer was preserved first');
  assert.ok(h.notices.some((n) => n.includes(RECOVERED_DIR)), h.notices.join(' | '));
});

test('a one-word deletion inside a long note is still a catch-up, not a refusal', async () => {
  // The other side of the bound, and the reason it is one HALF rather than
  // anything tighter: an ordinary edit made during the open window has to pass.
  const shared = `# Notes\n${'the workspace\'s own paragraph. '.repeat(12)}\nend`;
  const h = makeHarness({ syncTimeoutMs: 5_000 });
  const id = h.add('a.md', shared, { s: 1, owned: true });
  const path = `${SHARE}/a.md`;
  h.providers.configure(`n_${id}`, { mode: 'manual', remote: shared });

  const open = h.session.open(path);
  await until(() => h.providers.forRoom(`n_${id}`).length === 1, 'the room to be opened');
  h.editor.cut(path, 20, 30);
  const kept = h.editor.document(path)!;
  h.providers.forRoom(`n_${id}`)[0].emitSync();
  await open;

  assert.equal(h.providers.created[0].doc.getText('content').toString(), kept);
  assert.equal(h.editor.document(path), kept, 'the buffer was never touched');
  assert.deepEqual(h.stashes(), [], 'and no conflict file was invented');
});

test('an empty buffer against a non-empty file is refused, never taken as a deletion', async () => {
  // A leaf Obsidian has not populated looks exactly like a select-all-delete. One
  // of those two is the user emptying a shared note and the other is a note that
  // has not loaded, and from inside the plugin they are the same state — so the
  // open goes local-only for this turn rather than emptying a shared note on the
  // strength of a transient editor state. It costs one open and heals on the next.
  const h = makeHarness();
  const id = h.add('a.md', 'a body that exists', { s: 1, owned: true });
  const path = `${SHARE}/a.md`;
  h.editor.openLeaf(path, '');
  h.providers.configure(`n_${id}`, { remote: 'a body that exists' });

  await h.session.open(path);

  assert.equal(h.session.openNodeId(), null, 'nothing was bound');
  assert.deepEqual(h.editor.mounts, [], 'and nothing was dispatched at the editor');
  assert.equal(h.providers.created[0].doc.getText('content').toString(), 'a body that exists',
    'the shared document is exactly as it was found');
  assert.deepEqual(h.stashes(), [], 'a copy of nothing preserves nothing');
  assert.equal(h.notices.length, 1, h.notices.join(' | '));
});

test('a divergent open preserves what was on screen, not the revision read off disk', async () => {
  // I1's rule applied to the right string. The stash used to hold `localText` —
  // the bytes read before the round trip — so a user who typed into a stale note
  // while it opened had a revision they had already moved past carefully
  // preserved for them, and the paragraph they had just written destroyed.
  const h = makeHarness({ syncTimeoutMs: 5_000 });
  const id = h.add('Sans titre.md', STALE, { s: 1 });
  const path = `${SHARE}/Sans titre.md`;
  h.providers.configure(`n_${id}`, { mode: 'manual', remote: SHARED });

  const open = h.session.open(path);
  await until(() => h.providers.forRoom(`n_${id}`).length === 1, 'the room to be opened');
  h.editor.type(path, '\n\nA paragraph I wrote while it was opening.');
  h.providers.forRoom(`n_${id}`)[0].emitSync();
  await open;

  assert.equal(h.editor.document(path), SHARED, 'the shared document still wins');
  assert.deepEqual(
    h.stashes().map(([, text]) => text),
    [`${STALE}\n\nA paragraph I wrote while it was opening.`],
    'the stash holds what the mount destroyed, superseding the disk revision',
  );
});

test('a mount that refuses AFTER replacing the buffer still preserves what it replaced', async () => {
  // `CodeMirrorBinding.mount`'s belt-and-braces arm: the replacement went in, the
  // bind did not take, and the buffer is deliberately left holding the shared
  // text rather than re-dirtied with bytes the workspace has moved past. The
  // displaced characters are gone from the editor either way, so a refusal owes
  // the same copy a success does.
  const h = makeHarness();
  const id = h.add('a.md', STALE, { s: 1 });
  const path = `${SHARE}/a.md`;
  h.providers.configure(`n_${id}`, { remote: SHARED });
  h.editor.apply = () => ({ ok: false, replaced: `${STALE} and what I typed` });

  await h.session.open(path);

  assert.equal(h.session.openNodeId(), null, 'nothing claims to be bound');
  assert.equal(h.providers.created[0].destroyed, true, 'and the provider was released');
  assert.deepEqual(
    h.stashes().map(([, text]) => text).sort(),
    [STALE, `${STALE} and what I typed`].sort(),
    'the buffer the plan was made about, and the one the apply says it displaced',
  );
  // And the user is told, on the refusal as well: the same thing happened to
  // their screen either way, so silence would leave them looking at a note that
  // changed under them with nothing to explain it.
  assert.equal(h.notices.length, 1, h.notices.join(' | '));
  assert.ok(h.notices[0].includes(RECOVERED_DIR), h.notices[0]);
  assert.ok(h.notices[0].includes('not syncing yet'), h.notices[0]);
});

test('a mount that replaced nothing and found no divergence stashes nothing', async () => {
  // The other direction, and the reason `replaced` is optional rather than
  // "whatever the editor held": a stash of bytes nothing replaced preserves
  // nothing, and that is what nine near-identical files in three minutes was.
  const h = makeHarness();
  const id = h.add('a.md', 'shared body', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'shared body' });

  await h.session.open(`${SHARE}/a.md`);

  assert.deepEqual(h.stashes(), []);
  assert.equal(mutations(h.vault), 0);
});

test('a preservation that fails means NO BIND, and says so (I15)', async () => {
  // The ordering that makes I1 a rule rather than an aspiration. The copy is
  // written BEFORE the buffer is displaced, so a `create` that throws leaves the
  // user's text exactly where it is — and the note deliberately does not bind,
  // because binding would let Obsidian save the shared text over bytes nothing
  // holds. Every step is inside the try, hashing and name-finding included: a
  // rule that only holds for the failures somebody happened to wrap is not one.
  const h = makeHarness({}, { wrapVault: (inner) => new RefusingCreate(inner) });
  const id = h.add('a.md', STALE, { s: 1 });
  const path = `${SHARE}/a.md`;
  h.providers.configure(`n_${id}`, { remote: SHARED });

  await h.session.open(path);

  assert.ok(
    h.notices.some((n) => n.startsWith('Could not save a copy of "a.md"')
      && n.includes('the disk is full')
      && n.includes('has not been applied')),
    h.notices.join(' | '),
  );
  assert.equal(
    h.notices.some((n) => n.startsWith('ShadowLink: ')),
    false,
    'and not the generic catch-all, which names neither the file nor the reason',
  );
  assert.equal(h.session.openNodeId(), null, 'nothing is bound');
  assert.equal(h.editor.document(path), STALE, 'and the user\'s text is untouched');
  assert.equal(h.providers.created[0].destroyed, true);
});

// ================================================================ redundancy
//
// Notes are never rewritten from the CRDT while closed — the reconciler skips
// every bound node — and the only two writers of a note's bytes are materialize
// (unbound only) and adopt. So a STALE DISK COPY IS THE NORMAL STATE of every
// note a collaborator has touched, and a design that preserves on every
// divergence writes a recovery file and a "your local copy differed" notice on
// the single most common event in the product.
//
// A copy is owed only for bytes nothing else holds. Two watermarks can answer
// that, and they answer different questions: `contentHash` says THIS DISK held
// these bytes, and the session's own record of what it last BOUND says THIS
// WORKSPACE'S DOCUMENT held them.

test('an ordinary collaborative open preserves nothing, because the disk is redundant', async () => {
  const h = makeHarness();
  const id = h.add('Sans titre.md', STALE, { s: 1 });
  const path = `${SHARE}/Sans titre.md`;
  h.providers.configure(`n_${id}`, { remote: SHARED });
  // What every note this device has ever materialized or published carries.
  h.state.data.contentHash[id] = { sha256: await hashOf(STALE), len: STALE.length };

  await h.session.open(path);

  assert.deepEqual(h.stashes(), [], 'the workspace can give those bytes back');
  assert.equal(h.editor.document(path), SHARED);
  assert.deepEqual(h.notices, ['"Sans titre.md" was updated to the shared version.']);
});

test('with nothing able to vouch for the disk, the same open preserves exactly once', async () => {
  const h = makeHarness();
  const id = h.add('Sans titre.md', STALE, { s: 1 });
  const path = `${SHARE}/Sans titre.md`;
  h.providers.configure(`n_${id}`, { remote: SHARED });

  await h.session.open(path);

  const stashes = h.stashes();
  assert.deepEqual(stashes.map(([, t]) => t), [STALE]);
  const digest = await hashOf(STALE);
  assert.equal(
    stashes[0][0],
    `${RECOVERED_DIR}/Sans titre (conflicted copy — Ada, ${digest.slice(0, 8)}).md`,
    'the name is derived from the CONTENT, so re-observing the same divergence lands on it',
  );
  assert.ok(h.notices[0].includes(stashes[0][0]), h.notices.join(' | '));
});

test('a second divergent open does not fork the revision the workspace itself gave it', async () => {
  // The case `contentHash` cannot answer: a divergent open deliberately deletes
  // the watermark (I17 — after it there are no bytes both in the workspace and
  // on this disk), so on the NEXT divergence nothing would vouch for a buffer
  // this very session put there. Without a second record, every peer edit after
  // a conflict files another copy of the workspace's own text.
  const h = makeHarness();
  const id = h.add('Sans titre.md', STALE, { s: 1 });
  const path = `${SHARE}/Sans titre.md`;
  h.providers.configure(`n_${id}`, { remote: SHARED });

  await h.session.open(path);
  assert.equal(h.stashes().length, 1, 'the first divergence is genuine');
  h.editor.save(path);                                   // Obsidian catches the disk up

  await h.session.open(null);
  const later = `${SHARED} — and then a collaborator added this.`;
  h.providers.configure(`n_${id}`, { remote: later });
  await h.session.open(path);

  assert.equal(h.editor.document(path), later);
  assert.equal(h.stashes().length, 1, 'no second copy of what the workspace already holds');
});

test('typing during the preservation is preserved too, rather than replacing it', async () => {
  // The one arm with an await between reading the buffer and acting on it. The
  // pre-write covers the buffer the decision was made about; `replaced` is the
  // belt-and-braces report for whatever the editor held by the time it ran.
  let gated: GatedVault | null = null;
  const h = makeHarness({}, {
    wrapVault: (inner) => { gated = new GatedVault(inner); return gated; },
  });
  const id = h.add('a.md', STALE, { s: 1 });
  const path = `${SHARE}/a.md`;
  h.providers.configure(`n_${id}`, { remote: SHARED });
  const vault = gated!;
  vault.gates.add('create');

  const open = h.session.open(path);
  await until(() => vault.parked, 'the open to park writing the copy');
  h.editor.type(path, ' and one more thought');
  vault.release();
  await open;

  assert.deepEqual(
    h.stashes().map(([, t]) => t).sort(),
    [STALE, `${STALE} and one more thought`].sort(),
    'both the buffer that was decided about and the one that was displaced',
  );
  assert.equal(h.editor.document(path), SHARED);
});

// ================================================================ I17 — the watermark

test('a divergent open records no watermark, and removes the one it finds (I17)', async () => {
  // Read off the two live vaults on the day this was written:
  //
  //   SL-A: file 184 bytes (matches the server), watermark len 166 — B's file
  //   SL-B: file 166 bytes,                      watermark len 184 — the server's
  //
  // Each device had recorded the OTHER side's content as its own base, because
  // the base was taken from the CRDT immediately after a mount that wrote
  // nothing. §5.3's `proven` check reads this to choose between the vault trash
  // and a rescue, so it is a data-loss path, not a cosmetic one.
  const h = makeHarness();
  const id = h.add('Sans titre.md', STALE, { s: 1 });
  h.providers.configure(`n_${id}`, { remote: SHARED });
  h.state.data.contentHash[id] = { sha256: await hashOf(SHARED), len: SHARED.length };

  await h.session.open(`${SHARE}/Sans titre.md`);

  assert.equal(
    h.state.data.contentHash[id],
    undefined,
    'a device that cannot vouch for its own copy names no bytes at all (I17)',
  );
});

test('once the disk has caught up, the next open records what is on it (I17)', async () => {
  // The evidence a watermark waits for is a `vault.read` of this path returning
  // exactly the workspace's bytes. It arrives at the next open, because that is
  // where the file is read; until then, absence is the honest answer and the
  // safe one (an unproven note is rescued, never trashed).
  const h = makeHarness();
  const id = h.add('Sans titre.md', STALE, { s: 1 });
  h.providers.configure(`n_${id}`, { remote: SHARED });
  const path = `${SHARE}/Sans titre.md`;

  await h.session.open(path);
  assert.equal(h.state.data.contentHash[id], undefined, 'nothing yet: the disk still lags');

  h.editor.save(path);                       // Obsidian writes the dirty buffer
  await h.session.open(null);
  await h.session.open(path);

  assert.deepEqual(
    h.state.data.contentHash[id],
    { sha256: await hashOf(SHARED), len: SHARED.length },
    'and now it names bytes this device read off its own disk',
  );
});

// ================================================================ line endings
//
// This section replaces a test that asserted a CRLF `Y.Text` bound into an LF
// buffer was "not a difference" and that the mount succeeded. It did succeed —
// with 21 characters in the document and 19 in the editor — and that is the
// incident. A test that pins a bug is worse than no test, so it is inverted
// rather than adjusted.
//
// CodeMirror cannot hold a `\r` AT ALL. `EditorState.create({doc:'a\r\nb'})`
// gives "a\nb"; `{doc:'a\rb'}` gives "a\nb"; `lineSeparator` does not change it,
// and `y-sync.js` sends `sliceString(0, len, '\n')`. There is therefore no
// configuration in which a `Y.Text` holding `\r` and a buffer are equal — so a
// comparison that decides a BINDING cannot be normalised into agreement, and the
// document has to be repaired instead.

test('a note containing a lone \\r is repaired, bound, and forks nothing', async () => {
  // Blocker 5. `normLF` handled `\r\n` and not `\r`, and CodeMirror normalises
  // both — so the buffer was 'one\ntwo' for ever, the document was 'one\rtwo'
  // for ever, the two never compared equal, and every launch refused the mount
  // and manufactured another recovery file for a note nothing was wrong with.
  const h = makeHarness();
  const id = h.add('mac.md', 'one\rtwo', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'one\rtwo' });
  const path = `${SHARE}/mac.md`;

  await h.session.open(path);

  const text = h.providers.created[0].doc.getText('content');
  assert.equal(text.toString(), 'one\ntwo', 'the break the user typed survives as a break');
  assert.equal(h.session.openNodeId(), id, 'and the note binds');
  assert.equal(h.editor.inStep(path), true);
  assert.deepEqual(h.stashes(), [], 'nothing was displaced, so nothing was preserved');

  for (let i = 0; i < 3; i++) {
    await h.session.open(null);
    await h.session.open(path);
  }
  assert.deepEqual(h.stashes(), [], 'and three more launches manufacture nothing');
  assert.equal(mutations(h.vault), 0);
});

test('a CRLF document is repaired before it is bound, so a peer\'s edit lands where it aimed', async () => {
  // Blocker 6, and the incident's own error class. Measured on the shipped
  // binding: a `Y.Text` holding 'alpha\r\nbravo\r\ncharlie' (21) bound into a
  // 19-character buffer returned ok, a peer's insert after `bravo` showed up
  // before `charlie`, and the next append raised
  // `Invalid change range 22 to 22 (in doc of length 20)`.
  const h = makeHarness();
  const id = h.add('win.md', 'alpha\nbravo\ncharlie', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'alpha\r\nbravo\r\ncharlie' });
  const path = `${SHARE}/win.md`;

  await h.session.open(path);

  const text = h.providers.created[0].doc.getText('content');
  assert.equal(text.toString().includes('\r'), false, 'no \\r reaches a bound document');
  assert.equal(text.length, h.editor.document(path)?.length, 'and the two sides are one length');
  assert.equal(h.editor.inStep(path), true);

  h.editor.remoteDelta(path, (t) => { t.insert('alpha\nbravo'.length, '!'); });

  assert.equal(h.editor.document(path), 'alpha\nbravo!\ncharlie');
  assert.equal(h.editor.inStep(path), true, 'a peer\'s insert past the first break stays in step');
  assert.deepEqual(h.stashes(), [], 'and a repair is not a divergence');
});

test('the repair converges however many peers run it at once', async () => {
  // The design rests on this and it was measured rather than reasoned about, so
  // it is pinned. The session's repair is driven through a real open on each
  // simulated peer, and the resulting documents are merged pairwise.
  const repaired = async (seed: string, peers: number): Promise<string[]> => {
    // ONE history, handed to every peer — which is what `remoteUpdate` is for.
    // Seeding each of them from the same STRING would give disjoint insertions,
    // and their merge would concatenate rather than converge.
    const origin = new Y.Doc();
    origin.getText('content').insert(0, seed);
    const snapshot = Y.encodeStateAsUpdate(origin);
    const docs: Y.Doc[] = [];
    for (let i = 0; i < peers; i++) {
      const h = makeHarness();
      const id = h.add('mac.md', seed, { s: 1, owned: true });
      h.providers.configure(`n_${id}`, { remoteUpdate: snapshot });
      await h.session.open(`${SHARE}/mac.md`);
      docs.push(h.providers.created[0].doc);
    }
    for (const a of docs) for (const b of docs) if (a !== b) Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    return docs.map((d) => d.getText('content').toString());
  };

  for (const peers of [1, 2, 3]) {
    const out = await repaired('one\r\ntwo\r\nthree', peers);
    assert.ok(out.every((x) => x === out[0]), `CRLF diverged with ${peers} peers`);
    assert.equal(out[0], 'one\ntwo\nthree', `CRLF costs nothing with ${peers} peers`);
  }

  // A LONE `\r` is the case with a price, and it is N-1 extra breaks per site.
  // Convergent and cosmetic. The alternative rule — delete without inserting —
  // is idempotent, but it JOINS those lines on every device with no concurrency
  // required at all, which is destroying structure the user typed.
  const two = await repaired('one\rtwo\rthree', 2);
  assert.ok(two.every((x) => x === two[0]));
  assert.equal(two[0], 'one\n\ntwo\n\nthree');
  const three = await repaired('one\rtwo\rthree', 3);
  assert.ok(three.every((x) => x === three[0]));
  assert.equal(three[0], 'one\n\n\ntwo\n\n\nthree');
});

test('binding an UNREPAIRED CRLF document is what raised the incident\'s RangeError', () => {
  // The half that has to stay red if the repair is ever deleted. The shipped
  // binding, a real `EditorState`, and a `Y.Text` nobody repaired: the gate now
  // refuses it, and the observer shows why refusing is the only honest answer.
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf('alpha\nbravo\ncharlie', binding.editorExtension());
  const text = ytextOf('alpha\r\nbravo\r\ncharlie');

  const result = takeShared(binding, 'Shared/win.md', text, new FakeAwareness());

  assert.equal(result.ok, false, 'the two sides cannot be made equal, so nothing is bound');
  assert.equal(text.length, 21);
  assert.equal(leaf.view.state.doc.length, 19, 'CodeMirror will not hold the \\r, ever');

  // And this is what a bind would have cost, run by hand at the offsets the
  // observer would have used.
  assert.throws(
    () => leaf.view.dispatch({ changes: { from: 21, to: 21, insert: '!' } }),
    /Invalid change range 21 to 21 \(in doc of length 19\)/,
  );
});

// ================================================================ I7 — cancellation

test('an open superseded while waiting for sync never mounts and releases its doc', async () => {
  const h = makeHarness({ syncTimeoutMs: 5_000 });
  const a = h.add('a.md', 'body a', { s: 1, owned: true });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { mode: 'manual', remote: 'body a' });
  h.providers.configure(`n_${b}`, { remote: 'body b' });

  h.active.path = `${SHARE}/a.md`;
  const first = h.session.open(`${SHARE}/a.md`);
  await tick();
  assert.equal(h.providers.forRoom(`n_${a}`).length, 1, 'the first open reached its provider');

  h.active.path = `${SHARE}/b.md`;
  const second = h.session.open(`${SHARE}/b.md`);
  await Promise.all([first, second]);

  const providerA = h.providers.forRoom(`n_${a}`)[0];
  assert.equal(providerA.destroyed, true, 'the superseded provider was released');
  assert.equal(h.editor.mounts.length, 1, 'only the winner mounted');
  assert.equal(h.editor.current?.notePath, `${SHARE}/b.md`);
  assert.equal(h.session.openNodeId(), b);
  // The token is tested BEFORE `synced`. Testing `synced` first would announce
  // "this note is not syncing" about a note the user has already navigated away
  // from — a wait that was cancelled is not a wait that failed.
  assert.deepEqual(h.notices, [], 'a superseded open says nothing');
});

test('a sync that lands in the same turn as a newer open still loses to the newer open', async () => {
  const h = makeHarness({ syncTimeoutMs: 5_000 });
  const a = h.add('a.md', 'body a', { s: 1, owned: true });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { mode: 'manual', remote: 'body a' });
  h.providers.configure(`n_${b}`, { remote: 'body b' });

  h.active.path = `${SHARE}/a.md`;
  const first = h.session.open(`${SHARE}/a.md`);
  await tick();
  const providerA = h.providers.forRoom(`n_${a}`)[0];

  // The genuine sync arrives and the user switches note in the SAME turn, so the
  // resumed open wakes up already superseded — `synced` is true and the token is
  // the only thing standing between note A's document and note B's editor.
  providerA.emitSync();
  h.active.path = `${SHARE}/b.md`;
  const second = h.session.open(`${SHARE}/b.md`);
  await Promise.all([first, second]);

  assert.equal(providerA.destroyed, true);
  assert.equal(h.editor.mounts.length, 1);
  assert.equal(h.editor.current?.notePath, `${SHARE}/b.md`);
  assert.equal(h.session.openNodeId(), b);
  assert.deepEqual(h.notices, []);
});

test('an open superseded at the flush await marks no node seeded and keeps no session', async () => {
  const h = makeHarness();
  const a = h.add('a.md', 'body a', { owned: true });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { remote: '', gateFlush: true });
  h.providers.configure(`n_${b}`, { remote: 'body b' });

  h.active.path = `${SHARE}/a.md`;
  const first = h.session.open(`${SHARE}/a.md`);
  await tick();
  const providerA = h.providers.forRoom(`n_${a}`)[0];
  assert.equal(providerA.flushPending, true, 'the first open is parked mid-flush');

  h.active.path = `${SHARE}/b.md`;
  const second = h.session.open(`${SHARE}/b.md`);
  providerA.releaseFlush();
  await Promise.all([first, second]);

  assert.equal(h.tree.get(a)?.s, undefined, 'a superseded open advances no watermark');
  assert.equal(h.state.data.contentHash[a], undefined);
  assert.equal(providerA.destroyed, true);
  // The seeding arm binds FIRST and publishes after, because the buffer is the
  // only copy of a brand-new note and the way to keep it is to keep it where it
  // is. So `a` did bind, and losing the token is what unbinds it again.
  assert.deepEqual(h.editor.mounts.map((m) => m.notePath), [`${SHARE}/a.md`, `${SHARE}/b.md`]);
  assert.equal(h.editor.unmounts, 1, 'and the superseded session was torn down');
  assert.equal(h.editor.current?.notePath, `${SHARE}/b.md`);
  assert.equal(h.session.openNodeId(), b);
});

test('a newer open interrupts the previous wait instead of letting it run its course', async () => {
  // The token alone is not enough: it is only READ at an await boundary, so a
  // wait that is not woken keeps the user staring at an unbound editor for the
  // whole (production: 3 s + 8 s) window after they switched notes.
  const h = makeHarness({ syncTimeoutMs: 30_000, nodeWaitMs: 30_000 });
  const a = h.add('a.md', 'body a', { s: 1, owned: true });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { mode: 'manual', remote: 'body a' });
  h.providers.configure(`n_${b}`, { remote: 'body b' });

  h.active.path = `${SHARE}/a.md`;
  const first = h.session.open(`${SHARE}/a.md`);
  await tick();

  const started = Date.now();
  h.active.path = `${SHARE}/b.md`;
  const second = h.session.open(`${SHARE}/b.md`);
  await Promise.all([first, second]);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2_000, `a cancelled wait blocked the next note for ${elapsed} ms`);
  assert.equal(h.session.openNodeId(), b);
});

test('an open superseded before it starts never opens a room at all', async () => {
  const h = makeHarness({ syncTimeoutMs: 5_000, nodeWaitMs: 5_000 });
  const a = h.add('a.md', 'body a', { s: 1, owned: true });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { mode: 'manual', remote: 'body a' });
  h.providers.configure(`n_${b}`, { remote: 'body b' });

  h.active.path = `${SHARE}/b.md`;
  const first = h.session.open(`${SHARE}/a.md`);     // never awaited
  const second = h.session.open(`${SHARE}/b.md`);
  await Promise.all([first, second]);

  // Opens are serialized, so the first one is still queued when the second
  // arrives. Without the token test at the top of the open it would go on to
  // spend the whole (up to ~11 s) wait window on a note nobody is looking at,
  // and hold a socket open for it.
  assert.deepEqual(h.providers.created.map((p) => p.room), [`n_${b}`]);
  assert.equal(h.session.openNodeId(), b);
});

test('an open superseded while waiting for its node stays silent and opens no room', async () => {
  const h = makeHarness({ nodeWaitMs: 5_000 });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${b}`, { remote: 'body b' });
  h.vault.seed(`${SHARE}/ghost.md`, 'f', 'body');    // on disk, no node yet

  h.active.path = `${SHARE}/ghost.md`;
  const first = h.session.open(`${SHARE}/ghost.md`);
  await tick();
  h.active.path = `${SHARE}/b.md`;
  const second = h.session.open(`${SHARE}/b.md`);
  await Promise.all([first, second]);

  assert.deepEqual(h.notices, [], 'no "not synced yet" about a note already left');
  assert.deepEqual(h.providers.created.map((p) => p.room), [`n_${b}`]);
  assert.equal(h.session.openNodeId(), b);
});

test('an open superseded while reading the file never opens a room', async () => {
  let gated: GatedVault | null = null;
  const h = makeHarness({ syncTimeoutMs: 5_000 }, {
    wrapVault: (inner) => { gated = new GatedVault(inner); return gated; },
  });
  const a = h.add('a.md', 'body a', { s: 1, owned: true });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { mode: 'manual', remote: 'body a' });
  h.providers.configure(`n_${b}`, { remote: 'body b' });
  const vault = gated!;
  vault.gates.add('read');

  h.active.path = `${SHARE}/a.md`;
  const first = h.session.open(`${SHARE}/a.md`);
  await tick();
  assert.equal(vault.parked, true, 'the first open is parked mid-read');

  h.active.path = `${SHARE}/b.md`;
  const second = h.session.open(`${SHARE}/b.md`);
  vault.release();
  await Promise.all([first, second]);

  assert.deepEqual(h.providers.created.map((p) => p.room), [`n_${b}`]);
  assert.deepEqual(h.notices, []);
  assert.equal(h.session.openNodeId(), b);
});

test('an open superseded by a read failure stays silent', async () => {
  let gated: GatedVault | null = null;
  const h = makeHarness({}, {
    wrapVault: (inner) => { gated = new GatedVault(inner); return gated; },
  });
  const a = h.add('a.md', 'body a', { s: 1, owned: true });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${b}`, { remote: 'body b' });
  const vault = gated!;
  vault.gates.add('read');
  vault.rejectOnRelease = true;

  h.active.path = `${SHARE}/a.md`;
  const first = h.session.open(`${SHARE}/a.md`);
  await tick();
  h.active.path = `${SHARE}/b.md`;
  const second = h.session.open(`${SHARE}/b.md`);
  vault.release();
  await Promise.all([first, second]);

  assert.deepEqual(h.notices, [], 'the unreadable note is one the user already left');
  assert.equal(h.session.openNodeId(), b);
  assert.equal(a in h.state.data.contentHash, false);
});

// The preservation runs BEFORE the displacement, so it is a pre-bind await point
// again — and the strongest one there is. An open that loses its token there has
// written the user's bytes to disk and has NOT touched the editor, which is
// exactly the pair of guarantees I1 and I7 want out of it.

test('an open superseded while preserving still writes the bytes, and binds nothing', async () => {
  let gated: GatedVault | null = null;
  const h = makeHarness({ syncTimeoutMs: 5_000 }, {
    wrapVault: (inner) => { gated = new GatedVault(inner); return gated; },
  });
  const a = h.add('a.md', 'my offline edit', { s: 1, owned: true });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { remote: 'the shared text' });
  h.providers.configure(`n_${b}`, { remote: 'body b' });
  const vault = gated!;
  vault.gates.add('create');

  h.active.path = `${SHARE}/a.md`;
  const first = h.session.open(`${SHARE}/a.md`);
  await until(() => vault.parked, 'the first open to park writing the stash');

  h.active.path = `${SHARE}/b.md`;
  const second = h.session.open(`${SHARE}/b.md`);
  vault.release();
  await Promise.all([first, second]);

  // The copy itself must still complete — those are the user's bytes.
  assert.deepEqual(h.stashes().map(([, text]) => text), ['my offline edit']);
  assert.equal(h.providers.forRoom(`n_${a}`)[0].destroyed, true);
  assert.deepEqual(h.editor.mounts.map((m) => m.notePath), [`${SHARE}/b.md`],
    'the superseded open never bound: it lost the token before it displaced anything');
  assert.equal(h.editor.document(`${SHARE}/a.md`), 'my offline edit', 'so a.md is untouched');
  assert.equal(h.editor.current?.notePath, `${SHARE}/b.md`);
  assert.equal(h.session.openNodeId(), b);
});

test('a re-open of the SAME note stashes once and replaces the document once', async () => {
  // Obsidian fires `file-open` more than once for one file, so the newer open
  // targets the same path — the active-file re-check cannot tell the two apart
  // and the token is the only thing that can.
  //
  // The re-open matters more than it used to. Obsidian's save of the editor's
  // buffer is asynchronous, so the second open still reads the STALE bytes off
  // disk and still sees a divergence. Without the session remembering what it
  // already preserved, that is a fresh "local copy" per `file-open` — the nine
  // files in three minutes the user actually met.
  let gated: GatedVault | null = null;
  const h = makeHarness({}, {
    wrapVault: (inner) => { gated = new GatedVault(inner); return gated; },
  });
  const a = h.add('a.md', 'my offline edit', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { remote: 'the shared text' });
  const vault = gated!;
  vault.gates.add('create');

  const first = h.session.open(`${SHARE}/a.md`);
  await until(() => vault.parked, 'the first open to park writing the stash');
  const second = h.session.open(`${SHARE}/a.md`);
  vault.release();
  await Promise.all([first, second]);

  assert.deepEqual(h.stashes().map(([, text]) => text), ['my offline edit'], 'exactly one copy');
  assert.equal(h.session.openNodeId(), a);
  assert.equal(h.editor.document(`${SHARE}/a.md`), 'the shared text');
  // The second mount found the editor already holding the shared text, so it
  // reconfigured the compartment and left the document alone.
  const replacements = h.editor.transactions(`${SHARE}/a.md`).filter((tr) => tr.docChanged);
  assert.equal(replacements.length, 1, 'the user\'s document was replaced once, not once per open');
});

test('a session superseded by its own mount records no content watermark (I17)', async () => {
  // Reconfiguring the compartment is an observable event: Obsidian can fire a
  // further `file-open` from it. A watermark written after that says this device
  // holds content it is already tearing down.
  const h = makeHarness();
  const a = h.add('a.md', 'body a', { s: 1, owned: true });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { remote: 'body a' });
  h.providers.configure(`n_${b}`, { remote: 'body b' });

  const editor = h.editor;
  const apply = editor.apply.bind(editor);
  let follow: Promise<void> | null = null;
  editor.apply = (path, text, awareness, plan): MountResult => {
    const result = apply(path, text, awareness, plan);
    if (follow === null) {
      h.active.path = `${SHARE}/b.md`;
      follow = h.session.open(`${SHARE}/b.md`);
    }
    return result;
  };

  h.active.path = `${SHARE}/a.md`;
  await h.session.open(`${SHARE}/a.md`);
  await follow;

  assert.equal(h.state.data.contentHash[a], undefined, 'no watermark for a superseded session');
  assert.equal(h.state.data.contentHash[b] !== undefined, true, 'the winner recorded one');
});

test('an open whose file stopped being active never touches the editor', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'body', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'body' });
  h.active.path = 'Shared/somewhere-else.md';        // the user moved on

  await h.session.open(`${SHARE}/a.md`);

  assert.equal(h.editor.mounts.length, 0);
  assert.equal(h.providers.created[0].destroyed, true);
  assert.equal(h.session.openNodeId(), null);
});

test('an open with no editor view for the target releases the provider', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'body', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'body' });
  h.editor.missing.add(`${SHARE}/a.md`);

  await h.session.open(`${SHARE}/a.md`);

  assert.equal(h.providers.created[0].destroyed, true);
  assert.equal(h.session.openNodeId(), null);
});

test('opening a second note closes the first', async () => {
  const h = makeHarness();
  const a = h.add('a.md', 'body a', { s: 1, owned: true });
  const b = h.add('b.md', 'body b', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { remote: 'body a' });
  h.providers.configure(`n_${b}`, { remote: 'body b' });

  h.active.path = `${SHARE}/a.md`;
  await h.session.open(`${SHARE}/a.md`);
  h.active.path = `${SHARE}/b.md`;
  await h.session.open(`${SHARE}/b.md`);

  assert.equal(h.providers.forRoom(`n_${a}`)[0].destroyed, true);
  assert.equal(h.providers.forRoom(`n_${b}`)[0].destroyed, false);
  assert.equal(h.session.openNodeId(), b);
  assert.equal(h.editor.unmounts, 1);
});

// ================================================================ CodeMirrorBinding
//
// The shipped binding, driven directly against a real `EditorState`. This used
// to be declared untestable and left to a GUI checklist, which is how a mount
// that never made the editor equal the document it bound survived three phases.
// `EditorState` needs no DOM; the only thing that does is `EditorView`, and
// `CodeMirrorBinding` uses nothing from it but `state` and `dispatch`.

/** A leaf, as `CodeMirrorBinding` sees one: a state and a way to update it. */
function leafOf(doc: string, extension: Extension | null): {
  view: EditorView;
  doc: () => string;
  transactions: Transaction[];
} {
  const transactions: Transaction[] = [];
  const view = {
    state: EditorState.create({ doc, extensions: extension === null ? [] : [extension] }),
    dispatch(spec: TransactionSpec): void {
      const tr = view.state.update(spec);
      transactions.push(tr);
      view.state = tr.state;
    },
  };
  return { view: view as unknown as EditorView, doc: () => view.state.doc.toString(), transactions };
}

function ytextOf(content: string): Y.Text {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  if (content.length > 0) text.insert(0, content);
  return text;
}

/**
 * `bufferOf` + `apply` on the `take-shared` arm — which is what the single
 * `mount` these tests used to call always did, and is now one arm of three. It
 * is spelled out rather than hidden behind a helper on the binding, because
 * choosing the arm is the whole of what the session decides.
 */
function takeShared(
  binding: CodeMirrorBinding,
  notePath: string,
  text: Y.Text,
  awareness: SessionAwareness,
): MountResult {
  const expect = binding.bufferOf(notePath);
  if (expect === null) return { ok: false };
  return binding.apply(notePath, text, awareness, { kind: 'take-shared', expect });
}

test('take-shared makes the editor hold the shared document before it binds anything', () => {
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(STALE, binding.editorExtension());

  const result = takeShared(binding, 'Shared/a.md', ytextOf(SHARED), new FakeAwareness());

  assert.equal(result.ok, true);
  assert.equal(leaf.doc(), SHARED, 'the editor holds the workspace\'s text');
  assert.equal(leaf.transactions.length, 2, 'the replacement and the bind are separate dispatches');
  assert.equal(leaf.transactions[0].docChanged, true, 'the replacement goes first…');
  assert.equal(leaf.transactions[1].docChanged, false, '…and the bind changes nothing');
});

test('the replacement is kept out of the undo history', () => {
  // Once `yCollab` is installed, one Ctrl+Z over an undoable replacement would
  // push the stale local revision back through `YSyncPluginValue.update` as a
  // local edit — and broadcast it to every peer.
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(STALE, binding.editorExtension());

  takeShared(binding, 'Shared/a.md', ytextOf(SHARED), new FakeAwareness());

  assert.equal(leaf.transactions[0].annotation(Transaction.addToHistory), false);
});

test('mount reports the text it replaced, so the caller can preserve it', () => {
  // A boolean cannot say what the editor was holding, and the editor is the only
  // place the user's most recent characters exist. The caller stashes THIS, not
  // the file it read before the round trip.
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(`${STALE} and what I typed`, binding.editorExtension());

  const result = takeShared(binding, 'Shared/a.md', ytextOf(SHARED), new FakeAwareness());

  assert.deepEqual(result, { ok: true, replaced: `${STALE} and what I typed` });
});

test('mount reports what it replaced even when it then refuses', () => {
  // Obsidian rebuilt the editor's state between the two dispatches, so the
  // replacement landed and the reconfigure did not. The buffer is left holding
  // the shared text either way, so the displaced characters are just as gone as
  // they are after a success — and just as owed a copy.
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(STALE, binding.editorExtension());
  const rebuildOnNextDispatch = (): void => {
    const original = leaf.view.dispatch.bind(leaf.view);
    (leaf.view as { dispatch: (spec: TransactionSpec) => void }).dispatch = (spec) => {
      original(spec);
      // Obsidian's own rebuild: a fresh state, without the plugin's compartment.
      (leaf.view as { state: EditorState }).state = EditorState.create({
        doc: leaf.view.state.doc.toString(),
      });
    };
  };
  rebuildOnNextDispatch();

  const result = takeShared(binding, 'Shared/a.md', ytextOf(SHARED), new FakeAwareness());

  assert.equal(result.ok, false, 'no binding was installed');
  assert.equal(result.replaced, STALE, 'and it says what it cost to find that out');
  assert.equal(leaf.doc(), SHARED, 'the buffer is not re-dirtied with the stale revision');
});

test('the agree arm leaves a document that already matches completely alone', () => {
  // Arm 1, and the only arm `decide` can return for a buffer that already equals
  // the shared text. Nothing is written to either side, so nothing is reported
  // and nothing is ever preserved here — which is half of why nine `file-open`s
  // on one note no longer produce nine files.
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(SHARED, binding.editorExtension());

  const result = binding.apply(
    'Shared/a.md', ytextOf(SHARED), new FakeAwareness(), { kind: 'agree', expect: SHARED },
  );

  assert.equal(result.ok, true);
  assert.equal(result.replaced, undefined, 'nothing was replaced, so nothing is reported');
  assert.deepEqual(leaf.transactions.map((tr) => tr.docChanged), [false], 'one dispatch, no change');
});

test('a plan made about a buffer that has since moved is refused, not executed', () => {
  // The can't-happen guard. On the two arms that write the buffer INTO the CRDT
  // there is no await between reading it and acting on it — but what this would
  // otherwise write is a string nobody looked at, into a document every peer
  // reads, so it costs one comparison.
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf('what the editor holds now', binding.editorExtension());
  const text = ytextOf('the shared text');

  const result = binding.apply('Shared/a.md', text, new FakeAwareness(), {
    kind: 'converge-up',
    expect: 'what the editor held a moment ago',
    edit: { from: 0, to: 'the shared text'.length, insert: 'what the editor held a moment ago' },
  });

  assert.deepEqual(result, { ok: false, stale: true });
  assert.equal(text.toString(), 'the shared text', 'the CRDT is untouched');
  assert.deepEqual(leaf.transactions, [], 'and so is the editor');
});

test('mount into a state without the compartment is refused, and writes nothing', () => {
  // The silent hole: `Compartment.reconfigure` aimed at a state that does not
  // contain the compartment is inert, and `compartment.get(state)` is undefined
  // there. Checking that BEFORE the replacement is what keeps a mount that
  // cannot bind from having thrown the user's buffer away first.
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(STALE, null);

  assert.deepEqual(
    takeShared(binding, 'Shared/a.md', ytextOf(SHARED), new FakeAwareness()),
    { ok: false },
    'refused, and with nothing to preserve: the buffer was never touched',
  );

  assert.equal(leaf.doc(), STALE, 'the user\'s document is exactly as it was found');
  assert.deepEqual(leaf.transactions, [], 'and nothing was dispatched at it');
});

test('mount with no view for the path is refused', () => {
  const binding = new CodeMirrorBinding(() => null);
  assert.deepEqual(takeShared(binding, 'Shared/a.md', ytextOf(SHARED), new FakeAwareness()), { ok: false });
});

test('unmount removes the binding and leaves the document where it is', () => {
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(STALE, binding.editorExtension());
  takeShared(binding, 'Shared/a.md', ytextOf(SHARED), new FakeAwareness());

  binding.unmount();

  assert.equal(leaf.doc(), SHARED, 'the shared text stays: it is what the file will hold');
  binding.unmount();                                  // idempotent
});

// ================================================================ I19, as a table
//
// `decide` is pure, so the whole of I19 is a table rather than a set of
// scenarios. Every arm of it is here, including the ones the session's own
// early checks make unreachable — a rule with a hole in the table is a rule
// somebody will re-derive differently next time.

test('affixEdit is exact: applying it reproduces the target', () => {
  const cases: Array<[string, string]> = [
    ['', ''],
    ['', 'inserted'],
    ['removed', ''],
    ['abc', 'abc'],
    ['abc', 'abXc'],
    ['abcdef', 'abef'],
    ['one two three', 'one TWO three'],
    ['aaa', 'aa'],
    ['aa', 'aaa'],
    ['prefix middle suffix', 'prefix entirely different suffix'],
  ];
  for (const [from, to] of cases) {
    const edit = affixEdit(from, to);
    const applied = from.slice(0, edit.from) + edit.insert + from.slice(edit.to);
    assert.equal(applied, to, `${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
    assert.ok(edit.from <= edit.to, 'the range is never inverted');
    assert.ok(edit.to <= from.length, 'and never runs past the source');
  }
});

test('retains bounds the claim that a buffer was built from this note', () => {
  assert.equal(retains('', 'anything at all'), true, 'nothing to retain, nothing to prove');
  assert.equal(retains('a body', 'a body'), true);
  assert.equal(retains('a body', 'a body plus more'), true, 'appending keeps all of it');
  assert.equal(retains('a body', ''), false, 'emptying keeps none of it');

  const base = 'x'.repeat(400);
  assert.equal(retains(base, `${base}extra`), true);
  assert.equal(retains(base, `${'x'.repeat(390)}y`), true, 'a small edit inside a long note');
  assert.equal(retains(base, 'x'.repeat(100)), false, 'three quarters of it gone');
  assert.equal(retains(base, 'x'.repeat(200)), true, 'exactly half is the boundary, and passes');
});

test('decide covers every arm of I19', () => {
  const D = (B: string, R: string, f: string, own: boolean, seeded: boolean): string =>
    decide(B, R, f, own, seeded).kind;

  // 1. AGREE, whatever else is true — including two empty strings, which is a
  //    brand-new note nobody has typed into yet.
  assert.equal(D('same', 'same', 'other', false, true), 'agree');
  assert.equal(D('', '', '', true, false), 'agree');

  // 2. The buffer is empty and the file is not: a leaf that has not loaded and a
  //    select-all-delete are the same state from in here.
  assert.equal(D('', 'body', 'body', true, true), 'local-only');
  assert.equal(D('', 'body', '', true, true), 'take-shared', 'an empty FILE is not that case');

  // 3. The shared document has never held anything.
  assert.equal(D('typed', '', '', false, false), 'local-only', 'I5: not ours to seed');
  assert.equal(D('typed', '', '', true, false), 'converge-up', 'SEED, from the buffer');
  assert.equal(D('typed', '', 'a long file the buffer does not resemble at all', true, false),
    'take-shared', 'unless the buffer cannot be shown to belong to this note');
  assert.equal(D('typed', '', '', true, true), 'take-shared', 'a SEEDED empty doc is a deletion');

  // 4. The workspace and this disk agree, so only the buffer has moved.
  assert.equal(D('body plus typing', 'body', 'body', false, true), 'converge-up');
  assert.equal(D('x', 'a much longer shared body', 'a much longer shared body', false, true),
    'take-shared', 'the retention bound refuses a buffer that kept almost none of it');

  // 5. Genuine divergence.
  assert.equal(D('the local revision', 'the shared revision', 'the local revision', false, true),
    'take-shared');
});

test('nothing in the decision is normalised, at any point', () => {
  // I18's second clause, as a guard rather than a comment: a `\r` reaching
  // `decide` must NOT be smoothed into agreement with its own normalisation.
  // The repair upstream is what makes the equality achievable; a normaliser here
  // would make it a lie again.
  assert.equal(decide('a\nb', 'a\r\nb', 'a\nb', true, true).kind, 'take-shared');
  assert.equal(decide('a\nb', 'a\nb', 'a\r\nb', true, true).kind, 'agree');
});

// ================================================================ source guards

test('the path-derived room encoder is gone (spec §6.3: no migration)', () => {
  const source = readFileSync(new URL('./WorkspaceSession.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('toDocId'), false, 'toDocId must be deleted entirely');
  assert.equal(source.includes('btoa'), false, 'no base64url path encoding survives');
  assert.ok(source.includes('`n_${'), 'rooms are keyed by node id');
});

test('the irreversible vault calls appear nowhere in WorkspaceSession.ts (I1)', () => {
  // Assembled from fragments: the definition of done requires these strings to
  // appear NOWHERE under src/, so spelling them out would break that grep.
  const banned = [`vault.${'delete'}(`, `${'trash'}(file, true)`];
  const source = readFileSync(new URL('./WorkspaceSession.ts', import.meta.url), 'utf8');
  for (const needle of banned) {
    assert.equal(source.includes(needle), false, `WorkspaceSession.ts must not contain ${needle}`);
  }
  assert.equal(source.includes("from 'obsidian'"), false, 'the session needs no obsidian import');
});
