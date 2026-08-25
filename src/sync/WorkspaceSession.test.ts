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
    if (this.config.remote.length > 0 && this.doc.getText('content').length === 0) {
      this.doc.getText('content').insert(0, this.config.remote);
    }
    this.synced = true;
    for (const handler of [...this.handlers]) handler(true);
  }

  releaseFlush(): void {
    this.flushGate?.();
    this.flushGate = null;
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
      ?? { mode: 'immediate', remote: '', flushConfirmed: true, gateFlush: false };
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
 * A vault in which every candidate name under `ShadowLink Recovered/` is taken,
 * so `uniquify` exhausts its 1000 tries and throws.
 *
 * Reachable for real: the stash name is derived from the note's basename and a
 * timestamp, so a note that is opened repeatedly inside one second competes with
 * its own earlier copies for the same names.
 */
class CrowdedRecovered implements VaultPort {
  constructor(private readonly inner: FakeVault) {}

  exists(path: string): Promise<boolean> {
    if (path.startsWith(`${RECOVERED_DIR}/`)) return Promise.resolve(true);
    return this.inner.exists(path);
  }

  list(): Array<{ path: string; kind: Kind }> { return this.inner.list(); }
  listDir(path: string): Promise<string[]> { return this.inner.listDir(path); }
  read(path: string): Promise<string> { return this.inner.read(path); }
  create(path: string, data: string): Promise<void> { return this.inner.create(path, data); }
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

test('a mount into an editor whose state has no compartment is refused, not assumed', async () => {
  // `Compartment.reconfigure` aimed at a state that does not contain the
  // compartment is inert and SILENT. Without a liveness check the session is
  // told a binding exists when none does — so it defers the reconciler's repairs
  // for that node and records a watermark, for a note nothing is bound to.
  const h = makeHarness();
  const id = h.add('a.md', 'body', { s: 1, owned: true, initialized: false });
  h.providers.configure(`n_${id}`, { remote: 'body' });

  await h.session.open(`${SHARE}/a.md`);

  assert.deepEqual(h.editor.refused, [`${SHARE}/a.md`], 'the mount reported failure');
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
// `vault.read` that starts an open and the `mount` that ends it there is a third
// string, and it is the newest: the buffer the user is typing into. That window
// is the provider's connect-and-sync round trip, i.e. the first second after
// opening a note, i.e. when people type.
//
// `mount` replaces the whole document to establish the equality
// `y-codemirror.next` requires, so whatever is in that buffer is what an open
// destroys — and the file read seconds earlier is not it.

test('keystrokes typed while a healthy note is opening are preserved, not destroyed', async () => {
  // Nothing is wrong with this note. The file and the shared document agree, so
  // the open has no divergence to resolve and takes no stash branch at all — and
  // the mount still throws the user's characters away, because the buffer stopped
  // being the file's bytes the moment they typed.
  const h = makeHarness({ syncTimeoutMs: 5_000 });
  const id = h.add('a.md', 'shared body', { s: 1, owned: true });
  const path = `${SHARE}/a.md`;
  h.providers.configure(`n_${id}`, { mode: 'manual', remote: 'shared body' });

  const open = h.session.open(path);
  await until(() => h.providers.forRoom(`n_${id}`).length === 1, 'the room to be opened');
  h.editor.type(path, ' plus what I just typed');
  h.providers.forRoom(`n_${id}`)[0].emitSync();
  await open;

  assert.equal(h.editor.document(path), 'shared body', 'the shared document wins on screen');
  assert.deepEqual(
    h.stashes().map(([, text]) => text),
    ['shared body plus what I just typed'],
    'and what it replaced is on disk somewhere, not gone',
  );
  assert.ok(h.notices.some((n) => n.includes(RECOVERED_DIR)), h.notices.join(' | '));
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
  h.editor.mount = () => ({ ok: false, replaced: `${STALE} and what I typed` });

  await h.session.open(path);

  assert.equal(h.session.openNodeId(), null, 'nothing claims to be bound');
  assert.equal(h.providers.created[0].destroyed, true, 'and the provider was released');
  assert.deepEqual(h.stashes().map(([, text]) => text), [`${STALE} and what I typed`]);
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

test('a stash that can find no free name is a notice, not an open that gives up', async () => {
  // `uniquify` throws after 1000 collisions, and it used to throw OUTSIDE
  // `stashLocalCopy`'s try — so it propagated out of `doOpen`, past the watermark
  // step, to `open`'s catch-all, which says "ShadowLink: <message>" about bytes
  // nothing preserved. The document had already been replaced by then.
  const h = makeHarness({}, { wrapVault: (inner) => new CrowdedRecovered(inner) });
  const id = h.add('a.md', STALE, { s: 1 });
  const path = `${SHARE}/a.md`;
  h.providers.configure(`n_${id}`, { remote: SHARED });

  await h.session.open(path);

  assert.ok(
    h.notices.some((n) => n.startsWith(`Could not save a local copy of "a.md"`)),
    h.notices.join(' | '),
  );
  assert.equal(
    h.notices.some((n) => n.startsWith('ShadowLink: ')),
    false,
    'and not the generic catch-all, which names neither the file nor the reason',
  );
  assert.equal(h.session.openNodeId(), id, 'the open finished: the note is bound');
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

test('a shared document holding CRLF is not a difference either (I18)', async () => {
  // The normalization has to be applied to BOTH sides. A peer on Windows can
  // seed a document with CRLF, and stashing a copy of every note on every open
  // is exactly the kind of noise that trains users to ignore the folder.
  const h = makeHarness();
  const id = h.add('a.md', 'same\nbytes', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'same\r\nbytes' });

  await h.session.open(`${SHARE}/a.md`);

  assert.equal(mutations(h.vault), 0);
  assert.equal(h.editor.current?.notePath, `${SHARE}/a.md`);
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

test('an open superseded at the flush await neither mounts nor marks its node seeded', async () => {
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
  assert.equal(h.editor.mounts.length, 1);
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

// The stash now runs AFTER the mount, because it exists to preserve bytes the
// mount is replacing and there is nothing to preserve until something replaces
// them. These two tests used to gate the stash as a PRE-mount await point and
// assert that the superseded open "never mounts". That assertion is no longer
// about the stash — the mount happens first now — so they are rewritten around
// what the ordering actually guarantees. The I7 property they were guarding, an
// open that lost its token never reaching the editor, is still covered at every
// pre-mount await: the node wait, the file read, the sync wait and the flush.

test('an open superseded while stashing still preserves the bytes, and loses the editor', async () => {
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

  // The stash itself must still complete — those are the user's bytes.
  assert.deepEqual(h.stashes().map(([, text]) => text), ['my offline edit']);
  assert.equal(h.providers.forRoom(`n_${a}`)[0].destroyed, true);
  assert.equal(h.editor.unmounts, 1, 'the superseded session was torn down');
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
  const mount = editor.mount.bind(editor);
  let follow: Promise<void> | null = null;
  editor.mount = (path, text, awareness): MountResult => {
    const result = mount(path, text, awareness);
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

test('mount makes the editor hold the shared document before it binds anything', () => {
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(STALE, binding.editorExtension());

  const result = binding.mount('Shared/a.md', ytextOf(SHARED), new FakeAwareness());

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

  binding.mount('Shared/a.md', ytextOf(SHARED), new FakeAwareness());

  assert.equal(leaf.transactions[0].annotation(Transaction.addToHistory), false);
});

test('mount reports the text it replaced, so the caller can preserve it', () => {
  // A boolean cannot say what the editor was holding, and the editor is the only
  // place the user's most recent characters exist. The caller stashes THIS, not
  // the file it read before the round trip.
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(`${STALE} and what I typed`, binding.editorExtension());

  const result = binding.mount('Shared/a.md', ytextOf(SHARED), new FakeAwareness());

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

  const result = binding.mount('Shared/a.md', ytextOf(SHARED), new FakeAwareness());

  assert.equal(result.ok, false, 'no binding was installed');
  assert.equal(result.replaced, STALE, 'and it says what it cost to find that out');
  assert.equal(leaf.doc(), SHARED, 'the buffer is not re-dirtied with the stale revision');
});

test('mount leaves a document that already matches completely alone', () => {
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(SHARED, binding.editorExtension());

  const result = binding.mount('Shared/a.md', ytextOf(SHARED), new FakeAwareness());

  assert.equal(result.ok, true);
  assert.equal(result.replaced, undefined, 'nothing was replaced, so nothing is reported');
  assert.deepEqual(leaf.transactions.map((tr) => tr.docChanged), [false], 'one dispatch, no change');
});

test('mount into a state without the compartment is refused, and writes nothing', () => {
  // The silent hole: `Compartment.reconfigure` aimed at a state that does not
  // contain the compartment is inert, and `compartment.get(state)` is undefined
  // there. Checking that BEFORE the replacement is what keeps a mount that
  // cannot bind from having thrown the user's buffer away first.
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(STALE, null);

  assert.deepEqual(
    binding.mount('Shared/a.md', ytextOf(SHARED), new FakeAwareness()),
    { ok: false },
    'refused, and with nothing to preserve: the buffer was never touched',
  );

  assert.equal(leaf.doc(), STALE, 'the user\'s document is exactly as it was found');
  assert.deepEqual(leaf.transactions, [], 'and nothing was dispatched at it');
});

test('mount with no view for the path is refused', () => {
  const binding = new CodeMirrorBinding(() => null);
  assert.deepEqual(binding.mount('Shared/a.md', ytextOf(SHARED), new FakeAwareness()), { ok: false });
});

test('unmount removes the binding and leaves the document where it is', () => {
  const binding = new CodeMirrorBinding(() => leaf.view);
  const leaf = leafOf(STALE, binding.editorExtension());
  binding.mount('Shared/a.md', ytextOf(SHARED), new FakeAwareness());

  binding.unmount();

  assert.equal(leaf.doc(), SHARED, 'the shared text stays: it is what the file will hold');
  binding.unmount();                                  // idempotent
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
