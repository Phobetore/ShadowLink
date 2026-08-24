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
//  - I17: marking a node published before the server acknowledged the write.
//
// Everything except the CodeMirror mount runs against the in-memory fakes; the
// mount itself is behind `EditorBinding` and is GUI-verified (spec §10 Group D).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';

import { RECOVERED_DIR } from '../tree/constants.ts';
import { hashOf } from '../tree/paths.ts';
import { TreeDoc } from '../tree/TreeDoc.ts';
import { DeviceState, type StatePort } from './DeviceState.ts';
import { FakeVault } from './fakes.ts';
import type { Kind, VaultPort } from './VaultPort.ts';
import {
  WorkspaceSession,
  type EditorBinding,
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

interface Mount {
  notePath: string;
  text: Y.Text;
}

class FakeEditor implements EditorBinding {
  readonly mounts: Mount[] = [];
  unmounts = 0;
  /** Paths that have no editor view — `mount` refuses them, as a closed leaf would. */
  readonly missing = new Set<string>();

  mount(notePath: string, text: Y.Text, _awareness: SessionAwareness): boolean {
    if (this.missing.has(notePath)) return false;
    this.mounts.push({ notePath, text });
    return true;
  }

  unmount(): void {
    this.unmounts += 1;
  }

  get current(): Mount | undefined {
    return this.mounts[this.mounts.length - 1];
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

interface Harness {
  vault: FakeVault;
  state: DeviceState;
  tree: TreeDoc;
  providers: FakeProviders;
  editor: FakeEditor;
  session: WorkspaceSession;
  notices: string[];
  active: { path: string | null };
  /** Mint a live file node at `Shared/<name>` and put `text` on disk. */
  add(name: string, text: string, over?: { s?: 1; owned?: boolean }): string;
}

function makeHarness(
  over: Partial<WorkspaceSessionDeps> = {},
  opts: { wrapVault?: (inner: FakeVault) => VaultPort } = {},
): Harness {
  const vault = new FakeVault();
  const state = new DeviceState(new MemoryStatePort(), 'device-1', 'ws-1', () => NOW, 0);
  const tree = new TreeDoc();
  const providers = new FakeProviders();
  const editor = new FakeEditor();
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
      state.data.materialized[id] = `${SHARE}/${name}`;
      if (opts.owned) state.data.owned[id] = true;
      active.path = `${SHARE}/${name}`;
      return id;
    },
  };
}

/** Let queued microtasks and 0 ms timers run. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test('an already-seeded empty document is never re-seeded', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'local leftovers', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: '' });

  await h.session.open(`${SHARE}/a.md`);

  const provider = h.providers.created[0];
  assert.equal(provider.flushes, 0, 'no seed was attempted');
  // The shared (empty) doc wins; the local bytes are preserved out of the way.
  assert.equal(provider.doc.getText('content').toString(), '');
  assert.equal(h.editor.current?.notePath, `${SHARE}/a.md`);
});

// ================================================================ divergence

test('a local copy that differs from the shared document is stashed, not overwritten', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'my offline edit', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'the shared text' });

  await h.session.open(`${SHARE}/a.md`);

  const stashed = Object.entries(h.vault.snapshot()).filter(([p]) => p.startsWith(`${RECOVERED_DIR}/`));
  assert.equal(stashed.length, 1, JSON.stringify(h.vault.snapshot()));
  assert.equal(stashed[0][1], 'my offline edit');
  assert.equal(h.vault.wasTrashed(`${SHARE}/a.md`), false, 'nothing was destroyed (I1)');
  assert.equal(h.editor.current?.notePath, `${SHARE}/a.md`);
  assert.ok(h.notices.some((n) => n.includes(RECOVERED_DIR)), h.notices.join('|'));
});

test('a local copy matching the shared document is not stashed', async () => {
  const h = makeHarness();
  const id = h.add('a.md', 'same\r\nbytes', { s: 1, owned: true });
  h.providers.configure(`n_${id}`, { remote: 'same\nbytes' });

  await h.session.open(`${SHARE}/a.md`);

  assert.equal(mutations(h.vault), 0, 'CRLF on disk vs LF in the doc is not a difference (I18)');
  assert.equal(h.editor.current?.notePath, `${SHARE}/a.md`);
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

test('an open superseded while stashing the local copy never mounts', async () => {
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
  await tick();
  assert.equal(vault.parked, true, 'the first open is parked writing the stash');

  h.active.path = `${SHARE}/b.md`;
  const second = h.session.open(`${SHARE}/b.md`);
  vault.release();
  await Promise.all([first, second]);

  // The stash itself must still complete — those are the user's bytes.
  assert.equal(
    Object.keys(h.vault.snapshot()).filter((p) => p.startsWith(`${RECOVERED_DIR}/`)).length,
    1,
  );
  assert.equal(h.providers.forRoom(`n_${a}`)[0].destroyed, true);
  assert.equal(h.editor.mounts.length, 1);
  assert.equal(h.editor.current?.notePath, `${SHARE}/b.md`);
});

test('a re-open of the SAME note supersedes the stashing one without mounting twice', async () => {
  // Obsidian fires `file-open` more than once for one file, so the newer open
  // targets the same path — the active-file re-check cannot tell the two apart
  // and the token is the only thing that can.
  let gated: GatedVault | null = null;
  const h = makeHarness({}, {
    wrapVault: (inner) => { gated = new GatedVault(inner); return gated; },
  });
  const a = h.add('a.md', 'my offline edit', { s: 1, owned: true });
  h.providers.configure(`n_${a}`, { remote: 'the shared text' });
  const vault = gated!;
  vault.gates.add('create');

  const first = h.session.open(`${SHARE}/a.md`);
  await tick();
  assert.equal(vault.parked, true);
  const second = h.session.open(`${SHARE}/a.md`);
  vault.release();
  await Promise.all([first, second]);

  assert.equal(h.editor.mounts.length, 1, 'the superseded open never reached the editor');
  assert.equal(h.editor.unmounts, 0, 'and nothing had to be torn back down');
  assert.equal(h.session.openNodeId(), a);
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
  editor.mount = (path, text, awareness): boolean => {
    const ok = mount(path, text, awareness);
    if (follow === null) {
      h.active.path = `${SHARE}/b.md`;
      follow = h.session.open(`${SHARE}/b.md`);
    }
    return ok;
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
