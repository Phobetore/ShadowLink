// src/sync/Deletions.test.ts
//
// Spec §10 Group B, tests 32-38 (deletion safety) plus 39-44, the extra cases the
// invariants demand that the spec's list does not name.
//
// Every test here drives `Deletions.apply()` against a hand-built DeletionContext
// that is assembled exactly the way `Reconciler.describeDesiredState` assembles
// it — same `deriveTree`, same fold keys, same DiskIndex, same device state. That
// duplication is deliberate: this module is the one that decides whether a user's
// file is moved aside or thrown away, and its tests must be able to construct
// states (a stale binding, a hash mismatch, a file opened mid-pass) that a full
// reconcile pass would repair before step 4 ever saw them.
//
// The load-bearing property under all of it: nothing is trashed unless its bytes
// are PROVEN to be in the shared document. Everything else is rescued.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DIR_SENTINEL, deriveTree } from '../tree/TreeIndex.ts';
import type { NodeFields } from '../tree/types.ts';
import {
  fold, formatBlobRef, hashOf, hashOfBytes, isLive, relPath, validateRel,
} from '../tree/paths.ts';
import {
  PROVE_HASH_MAX_BYTES, REMOTE_DELETE_BUDGET, REMOTE_DELETE_BYTES_ALERT,
  REMOTE_DELETE_WINDOW_MS,
} from '../tree/constants.ts';
import { BlobTransport } from './BlobPort.ts';
import { Deletions, rescueName, type BulkChoice, type BulkSummary } from './Deletions.ts';
import { DeviceState, type StatePort } from './DeviceState.ts';
import { DiskIndex } from './DiskIndex.ts';
import { FakeBlobs, FakeDocs, FakeVault, type VaultOp } from './fakes.ts';
import type { DeletionContext, ReconcileCause, ReconcileFailure } from './Reconciler.ts';
import { Tickets } from './Tickets.ts';
import type { VaultPort } from './VaultPort.ts';

// ---------------------------------------------------------------- fixtures

const SHARE = 'Shared';
const NOW = 1_700_000_000_000;
const RECOVERED = 'ShadowLink Recovered';

/** A 22-character nodeId whose ASCII order is the order of `label`. */
function nid(label: string): string {
  return label + '0'.repeat(22 - label.length);
}

function pad3(n: number): string {
  let s = String(n);
  while (s.length < 3) s = `0${s}`;
  return s;
}

function file(d: string, n: string, extra: Partial<NodeFields> = {}): NodeFields {
  return { k: 'f', d, n, g: 1, c: 0, ...extra };
}

function dir(d: string, n: string, extra: Partial<NodeFields> = {}): NodeFields {
  return { k: 'd', d, n, g: 1, c: 0, ...extra };
}

/** An attachment node. `b` is set by `blobRef` at the call site, never guessed here. */
function blob(d: string, n: string, extra: Partial<NodeFields> = {}): NodeFields {
  return { k: 'b', d, n, g: 1, c: 0, ...extra };
}

/** The packed `b` field for `bytes`, as a first publish. */
async function blobRef(bytes: Uint8Array, parent: string | null = null): Promise<string> {
  return formatBlobRef(await hashOfBytes(bytes), bytes.length, parent);
}

/** Bytes no UTF-8 round trip survives, so a text read of them is visibly wrong. */
function png(seed: number, length = 24): Uint8Array {
  const out = new Uint8Array(length);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < length; i++) out[i] = (seed * 31 + i * 7) & 0xff;
  return out;
}

/** Tombstone a node exactly as §5.3 does: x = g, plus the display-only fields. */
function dead(f: NodeFields, by = 'Ann'): NodeFields {
  return { ...f, x: f.g, xa: NOW - 60_000, xb: by };
}

class MemoryStatePort implements StatePort {
  readonly writes: string[] = [];
  private readonly store = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    const v = this.store.get(key);
    return v === undefined ? null : v;
  }

  async write(key: string, data: string): Promise<void> {
    this.store.set(key, data);
    this.writes.push(data);
  }

  /** Hand the bytes of one earlier write to a fresh port — a simulated restart. */
  fork(key: string, data: string): MemoryStatePort {
    const next = new MemoryStatePort();
    next.store.set(key, data);
    return next;
  }
}

/** Delegate every VaultPort method to a FakeVault, overriding the named ones. */
function wrapVault(inner: FakeVault, overrides: Partial<VaultPort>): VaultPort {
  const base: VaultPort = {
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
  return { ...base, ...overrides };
}

interface HarnessOptions {
  /**
   * How the injected bulk dialog answers. Omitted means NO callback is wired at
   * all — which must itself read as 'keep' (test 42).
   */
  answer?: BulkChoice | 'reject' | 'defer';
  openNodeId?: () => string | null;
  /** Replace the port handed to both the DeletionContext and the Deletions deps. */
  vaultPort?: (inner: FakeVault) => VaultPort;
  /** §7.4's per-device whole-file allocation cap. Omitted means the desktop default. */
  memoryCapBytes?: () => number;
}

interface Harness {
  vault: FakeVault;
  vaultPort: VaultPort;
  blobs: FakeBlobs;
  docs: FakeDocs;
  state: DeviceState;
  tickets: Tickets;
  port: MemoryStatePort;
  nodes: Map<string, NodeFields>;
  notices: string[];
  /** Summaries handed to `confirmBulk`, in order. */
  confirms: BulkSummary[];
  /** nodeIds `closeSession` was called for. */
  closed: string[];
  /** Vault ops already performed when `closeSession` was called (I7 ordering). */
  closeSawOps: VaultOp[];
  clock: { at: number };
  deletions: Deletions;
  /** A fresh context, assembled the way the reconciler assembles it. */
  ctx: (cause?: ReconcileCause, over?: Partial<DeletionContext>) => DeletionContext;
  /** Resolve a 'defer' dialog. */
  answer: (choice: BulkChoice) => void;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const vault = new FakeVault();
  const vaultPort = options.vaultPort ? options.vaultPort(vault) : vault;
  const blobs = new FakeBlobs();
  const docs = new FakeDocs();
  const port = new MemoryStatePort();
  const clock = { at: NOW };
  const now = (): number => clock.at;
  const state = new DeviceState(port, 'device-1', 'ws-1', now, 0);
  const tickets = new Tickets(now);
  const nodes = new Map<string, NodeFields>();
  const notices: string[] = [];
  const confirms: BulkSummary[] = [];
  const closed: string[] = [];
  const closeSawOps: VaultOp[] = [];
  let release: ((choice: BulkChoice) => void) | null = null;

  const confirmBulk = options.answer === undefined
    ? undefined
    : async (summary: BulkSummary): Promise<BulkChoice> => {
      confirms.push(summary);
      if (options.answer === 'reject') throw new Error('the user closed the window');
      if (options.answer === 'defer') {
        return new Promise<BulkChoice>((resolve) => { release = resolve; });
      }
      return options.answer as BulkChoice;
    };

  const deletions = new Deletions({
    vault: vaultPort,
    blobs,
    state,
    tickets,
    shareRoot: SHARE,
    now,
    memoryCapBytes: options.memoryCapBytes,
    notice: (msg) => { notices.push(msg); },
    confirmBulk,
    openNodeId: options.openNodeId,
    closeSession: async (nodeId) => {
      closed.push(nodeId);
      for (const call of vault.calls) closeSawOps.push(call.op);
    },
  });

  const h: Harness = {
    vault, vaultPort, blobs, docs, state, tickets, port, nodes, notices, confirms,
    closed, closeSawOps, clock, deletions,
    ctx: (cause = 'remote', over = {}) => makeCtx(h, cause, over),
    answer: (choice) => {
      if (release === null) throw new Error('no deferred dialog is open');
      release(choice);
      release = null;
    },
  };
  return h;
}

/**
 * The same construction `Reconciler.describeDesiredState` + `observeBindings`
 * perform, kept deliberately explicit so a change to either one shows up here as
 * a difference rather than as a silently agreeing helper.
 */
function makeCtx(h: Harness, cause: ReconcileCause, over: Partial<DeletionContext>): DeletionContext {
  const disk = DiskIndex.build(h.vaultPort, SHARE);
  const entries = [...h.nodes];
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
  const ctx: DeletionContext = {
    cause,
    deadNodes,
    deadFold,
    wantAtFold,
    have,
    // The pass's own derivation, exactly as the reconciler hands it over: LIVE
    // published `'b'` nodes only.
    blobRefs: derived.blobs,
    disk,
    failures,
    removedThisPass: new Set<string>(),
    vault: h.vaultPort,
    blobs: h.blobs,
    docs: h.docs,
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    notice: (msg: string) => { h.notices.push(msg); },
    now: () => h.clock.at,
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
    ...over,
  };
  return ctx;
}

/** Bind `id` to `path`, seed the bytes, and (optionally) record the proving hash. */
async function place(
  h: Harness,
  id: string,
  path: string,
  text: string,
  opts: { hash?: string | false } = {},
): Promise<void> {
  h.vault.seed(path, 'f', text);
  h.state.data.materialized[id] = path;
  if (opts.hash === false) return;
  const source = opts.hash ?? text;
  h.state.data.contentHash[id] = { sha256: await hashOf(source), len: source.length };
}

/**
 * `place` for an attachment: seed the BYTES, bind, and record the base the way a
 * converged pass would — the hash, the length and the mtime `stat` reports.
 *
 * `hash`, `len` and `mtime` are overridable one at a time on purpose: the
 * staleness oracle has two independent clauses, and a fixture that could only
 * make them wrong together would let either one be deleted unnoticed.
 */
async function placeBinary(
  h: Harness,
  id: string,
  path: string,
  bytes: Uint8Array,
  opts: { hash?: string | false; len?: number; mtime?: number | null } = {},
): Promise<void> {
  h.vault.seedBinary(path, bytes);
  h.state.data.materialized[id] = path;
  if (opts.hash === false) return;
  const st = await h.vault.stat(path);
  const sha256 = opts.hash ?? await hashOfBytes(bytes);
  const len = opts.len ?? bytes.length;
  // `null` records a base with NO mtime — a hash this device confirmed without
  // ever confirming when, which the oracle must refuse just as firmly.
  h.state.data.contentHash[id] = opts.mtime === null
    ? { sha256, len }
    : { sha256, len, mtime: opts.mtime ?? st!.mtime };
  h.vault.resetCalls();
}

function mutations(vault: FakeVault): number {
  return vault.calls.filter(
    (c) => c.op === 'create' || c.op === 'createFolder' || c.op === 'rename' || c.op === 'trashLocal',
  ).length;
}

function rescuedInto(vault: FakeVault): string[] {
  return Object.keys(vault.snapshot()).filter((p) => p.startsWith(`${RECOVERED}/`)).sort();
}

// ---------------------------------------------------------------- 32: node identity

test('32: a tombstone whose path is held by another node is never applied (I12)', async () => {
  // Case one: the path is bound on disk to a DIFFERENT node whose tree path has
  // moved elsewhere. `wantAtFold` cannot see this — only the live binding can.
  const h = makeHarness();
  const goner = nid('A');
  const other = nid('B');
  h.nodes.set(goner, dead(file('', 'p.md', { s: 1 })));
  h.nodes.set(other, file('', 'q.md', { s: 1 }));
  h.vault.seed(SHARE, 'd');
  await place(h, goner, 'Shared/p.md', 'shared bytes');
  h.state.data.materialized[other] = 'Shared/p.md';        // a move step 2 has not made yet

  const ctx = h.ctx();
  assert.deepEqual(h.deletions.collectDeletable(ctx), [], 'not collectable at all');

  await h.deletions.apply(ctx);

  assert.equal(mutations(h.vault), 0, 'nothing was moved and nothing was trashed');
  assert.equal(h.vault.snapshot()['Shared/p.md'], 'shared bytes');
  assert.equal(ctx.removedThisPass.size, 0);
  assert.deepEqual(ctx.failures, []);

  // Case two: a LIVE node's derived path is the dead node's recorded path.
  const g = makeHarness();
  const ghost = nid('A');
  const fresh = nid('B');
  g.nodes.set(ghost, dead(file('', 'p.md', { s: 1 })));
  g.nodes.set(fresh, file('', 'p.md', { s: 1 }));
  g.vault.seed(SHARE, 'd');
  await place(g, ghost, 'Shared/p.md', 'brand new');

  const gctx = g.ctx();
  assert.equal(gctx.wantAtFold.get(fold('Shared/p.md')), fresh, 'a live node claims the path');
  await g.deletions.apply(gctx);

  assert.equal(mutations(g.vault), 0);
  assert.equal(g.vault.snapshot()['Shared/p.md'], 'brand new');
});

// ---------------------------------------------------------------- 33: rescue on ignorance

test('33: unproven content is rescued, never trashed — no s, no hash, wrong hash', async () => {
  const cases: Array<{ label: string; node: NodeFields; hash?: string | false }> = [
    { label: 'the node was never seeded', node: dead(file('', 'a.md')) },
    { label: 'no hash was ever recorded', node: dead(file('', 'a.md', { s: 1 })), hash: false },
    { label: 'the disk differs from the doc', node: dead(file('', 'a.md', { s: 1 })), hash: 'other bytes' },
  ];

  for (const { label, node, hash } of cases) {
    const h = makeHarness();
    const id = nid('A');
    h.nodes.set(id, node);
    h.vault.seed(SHARE, 'd');
    await place(h, id, 'Shared/a.md', 'the local bytes', { hash });

    const ctx = h.ctx();
    await h.deletions.apply(ctx);

    assert.deepEqual(ctx.failures, [], label);
    assert.equal(h.vault.callsTo('trashLocal').length, 0, `${label}: nothing was trashed`);
    assert.equal(h.vault.wasTrashed('Shared/a.md'), false, label);

    const renames = h.vault.callsTo('rename');
    assert.equal(renames.length, 1, `${label}: exactly one rescue move`);
    const dest = renames[0].args[1] as string;
    assert.ok(dest.startsWith(`${RECOVERED}/`), `${label}: rescued into ${RECOVERED}/, got ${dest}`);
    assert.ok(dest.includes('deleted by Ann'), `${label}: the name says who deleted it`);
    assert.ok(dest.endsWith('.md'), `${label}: still a note`);

    // The whole point of a rescue: the bytes are still readable afterwards.
    assert.equal(await h.vault.read(dest), 'the local bytes', `${label}: bytes survived`);
    assert.equal(h.vault.snapshot()['Shared/a.md'], undefined, `${label}: gone from the share`);

    // The destination is OUTSIDE the share, so it must leave the share-scoped
    // index rather than be relocated inside it — otherwise step 6 would offer the
    // rescued copy back to the publisher as untracked markdown.
    assert.equal(ctx.disk.hasFold('Shared/a.md'), false, `${label}: dropped from the index`);
    assert.equal(ctx.disk.hasFold(dest), false, `${label}: and not re-added outside the share`);
    assert.deepEqual(ctx.disk.filesUnderShare(), [], label);

    assert.deepEqual(h.state.data.declinedNodes, [id], label);
    assert.deepEqual(h.state.data.declinedPaths, [fold('Shared/a.md')], label);
    assert.equal(h.state.data.materialized[id], undefined, `${label}: unbound`);
    assert.equal(ctx.removedThisPass.has(fold('Shared/a.md')), true, `${label}: I13`);
    assert.equal(h.notices.length, 1, `${label}: the user was told`);
  }
});

// ---------------------------------------------------------------- 34: trash on proof

test('34: proven content goes to the vault-local trash and is retained there (I1)', async () => {
  const h = makeHarness();
  const id = nid('A');
  h.nodes.set(id, dead(file('', 'a.md', { s: 1 })));
  h.vault.seed(SHARE, 'd');
  await place(h, id, 'Shared/a.md', 'body');

  const ctx = h.ctx();
  await h.deletions.apply(ctx);

  assert.deepEqual(ctx.failures, []);
  assert.equal(h.vault.callsTo('rename').length, 0, 'no rescue');
  assert.deepEqual(rescuedInto(h.vault), []);

  const trashed = h.vault.callsTo('trashLocal');
  assert.equal(trashed.length, 1, 'exactly one removal');
  assert.deepEqual(trashed[0].args, ['Shared/a.md']);

  // I1, asserted positively: the bytes are still retrievable from `.trash`.
  const retained = h.vault.trashedFor('Shared/a.md');
  assert.equal(retained.length, 1);
  assert.equal(retained[0].data, 'body');
  assert.ok(retained[0].trashPath.startsWith('.trash/'));

  assert.equal(h.state.data.materialized[id], undefined, 'unbound');
  assert.deepEqual(h.state.data.declinedNodes, [], 'a trash is not a decline');
  assert.equal(ctx.removedThisPass.has(fold('Shared/a.md')), true, 'I13');
  assert.equal(h.state.data.deleteBudget.length, 1, 'one budget entry');
  assert.equal(h.tickets.claim('delete', 'Shared/a.md'), true, 'the echo was armed for');
  assert.equal(h.deletions.collectDeletable(h.ctx()).length, 0, 'and it does not come back');
});

test('34b: a dead FOLDER node is left to the reconciler’s own sweep', async () => {
  const h = makeHarness();
  const id = nid('A');
  h.nodes.set(id, dead(dir('', 'Archive')));
  h.vault.seed('Shared/Archive', 'd');
  h.state.data.materialized[id] = 'Shared/Archive';

  const ctx = h.ctx();
  assert.deepEqual(h.deletions.collectDeletable(ctx), [], 'k === "d" is skipped');
  await h.deletions.apply(ctx);
  assert.equal(mutations(h.vault), 0);
});

// ---------------------------------------------------------------- 35-36: the editor

test('35: an open file is rescued, and the session is unbound before it moves (I7)', async () => {
  const id = nid('A');
  const h = makeHarness({ openNodeId: () => id });
  h.nodes.set(id, dead(file('', 'a.md', { s: 1 })));
  h.vault.seed(SHARE, 'd');
  await place(h, id, 'Shared/a.md', 'body');           // proven — and still not trashed
  h.vault.setOpen('Shared/a.md', true);

  const ctx = h.ctx();
  await h.deletions.apply(ctx);

  assert.deepEqual(ctx.failures, []);
  assert.equal(h.vault.callsTo('trashLocal').length, 0, 'an open note is never trashed');
  assert.equal(h.vault.callsTo('rename').length, 1, 'it is rescued instead');
  assert.deepEqual(h.closed, [id], 'the editor was unbound');
  assert.equal(
    h.closeSawOps.includes('rename'), false,
    'closeSession ran BEFORE the file moved (I7)',
  );
  assert.equal(
    h.closeSawOps.includes('read'), false,
    'and before its bytes were read (I7)',
  );
  assert.deepEqual(h.state.data.declinedNodes, [id]);
});

test('35b: the editor session is released before a proven file is read or removed (I7)', async () => {
  // The leaf is closed but the collaboration session is still bound to the node —
  // the case where a read genuinely happens, so the ordering is observable.
  const id = nid('A');
  const h = makeHarness({ openNodeId: () => id });
  h.nodes.set(id, dead(file('', 'a.md', { s: 1 })));
  h.vault.seed(SHARE, 'd');
  await place(h, id, 'Shared/a.md', 'body');

  const ctx = h.ctx();
  await h.deletions.apply(ctx);

  assert.deepEqual(ctx.failures, []);
  assert.deepEqual(h.closed, [id], 'the session was unbound');
  assert.equal(h.closeSawOps.includes('read'), false, 'closeSession ran before the read (I7)');
  assert.equal(h.closeSawOps.includes('trashLocal'), false, 'and before the removal (I7)');
  assert.equal(h.vault.callsTo('trashLocal').length, 1, 'a closed leaf still allows the removal');
});

test('36: a note opened between the verdict and the act is still rescued (TOCTOU)', async () => {
  const id = nid('A');
  let flipped = false;
  const h = makeHarness({
    vaultPort: (inner) => wrapVault(inner, {
      // The last call of the verdict phase. Opening the note here lands the flip
      // strictly after `proven` was computed and strictly before anything moves.
      read: async (p) => {
        const text = await inner.read(p);
        inner.setOpen(p, true);
        flipped = true;
        return text;
      },
    }),
  });
  h.nodes.set(id, dead(file('', 'a.md', { s: 1 })));
  h.vault.seed(SHARE, 'd');
  await place(h, id, 'Shared/a.md', 'body');           // proven at the moment of the verdict

  const ctx = h.ctx();
  await h.deletions.apply(ctx);

  assert.equal(flipped, true, 'the fixture actually opened the note mid-flight');
  assert.deepEqual(ctx.failures, []);
  assert.equal(h.vault.callsTo('trashLocal').length, 0, 'the re-check caught it');
  assert.equal(h.vault.callsTo('rename').length, 1, 'rescued, not trashed');
  assert.equal(rescuedInto(h.vault).length, 1);
});

// ---------------------------------------------------------------- 37: the circuit breaker

test('37: a bulk batch applies nothing and asks once', async () => {
  const h = makeHarness({ answer: 'keep' });
  h.vault.seed(SHARE, 'd');
  for (let i = 0; i < 47; i++) {
    const id = nid(`D${pad3(i)}`);
    h.nodes.set(id, dead(file('', `f${pad3(i)}.md`, { s: 1 }), i === 0 ? 'Bob' : 'Ann'));
    await place(h, id, `Shared/f${pad3(i)}.md`, `body ${i}`);
  }

  const ctx = h.ctx();
  assert.equal(h.deletions.collectDeletable(ctx).length, 47);

  await h.deletions.apply(ctx);

  assert.equal(h.confirms.length, 1, 'exactly one dialog for the whole batch');
  assert.equal(h.confirms[0].count, 47);
  assert.deepEqual(h.confirms[0].deletedBy.sort(), ['Ann', 'Bob']);
  assert.ok(h.confirms[0].samplePaths.length > 0);
  assert.ok(h.confirms[0].samplePaths.every((p) => p.startsWith(`${SHARE}/`)));

  assert.equal(mutations(h.vault), 0, 'NOTHING was applied');
  assert.equal(h.state.data.deleteBudget.length, 0, 'and nothing was charged to the budget');
  assert.equal(h.state.data.declinedNodes.length, 47);
  assert.equal(h.state.data.declinedPaths.length, 47);
});

test('37b: the same batch, applied, removes all 47 and survives a restart', async () => {
  const h = makeHarness({ answer: 'apply' });
  h.vault.seed(SHARE, 'd');
  for (let i = 0; i < 47; i++) {
    const id = nid(`D${pad3(i)}`);
    h.nodes.set(id, dead(file('', `f${pad3(i)}.md`, { s: 1 })));
    await place(h, id, `Shared/f${pad3(i)}.md`, `body ${i}`);
  }

  const ctx = h.ctx();
  await h.deletions.apply(ctx);

  assert.deepEqual(ctx.failures, []);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.vault.callsTo('trashLocal').length, 47, 'every one applied');
  assert.equal(Object.keys(h.state.data.materialized).length, 0, 'all unbound');
  assert.equal(ctx.removedThisPass.size, 47, 'I13');
  assert.equal(h.state.data.deleteBudget.length, 47);

  // The budget is what makes the breaker a containment mechanism rather than a
  // nuisance: a restart must not hand the next batch a clean slate.
  await h.state.flush();
  const bytes = h.port.writes[h.port.writes.length - 1];
  const restarted = new DeviceState(
    h.port.fork(h.state.key, bytes), 'device-1', 'ws-1', () => NOW, 0,
  );
  assert.deepEqual(await restarted.load(), { coldStart: false });
  assert.equal(restarted.data.deleteBudget.length, 47, 'the window survived the restart');
  assert.equal(restarted.deletionsInWindow(NOW), 47);
});

test('37c: one deletion on a full window trips the breaker; a stale window does not', async () => {
  const full = makeHarness({ answer: 'keep' });
  full.vault.seed(SHARE, 'd');
  for (let i = 0; i < REMOTE_DELETE_BUDGET; i++) full.state.data.deleteBudget.push({ at: NOW - 1_000 });
  const id = nid('A');
  full.nodes.set(id, dead(file('', 'a.md', { s: 1 })));
  await place(full, id, 'Shared/a.md', 'body');

  await full.deletions.apply(full.ctx());

  assert.equal(full.confirms.length, 1, 'budget 10 + batch 1 > 10 (CF-6)');
  assert.equal(full.confirms[0].count, 1);
  assert.equal(mutations(full.vault), 0);

  // CF-5: pruning uses the INJECTED clock, so entries older than the window are
  // gone and the same single deletion goes through without a prompt.
  const stale = makeHarness({ answer: 'keep' });
  stale.vault.seed(SHARE, 'd');
  for (let i = 0; i < REMOTE_DELETE_BUDGET; i++) {
    stale.state.data.deleteBudget.push({ at: NOW - REMOTE_DELETE_WINDOW_MS - 1 });
  }
  stale.nodes.set(id, dead(file('', 'a.md', { s: 1 })));
  await place(stale, id, 'Shared/a.md', 'body');

  await stale.deletions.apply(stale.ctx());

  assert.equal(stale.confirms.length, 0, 'the stale window did not trip anything');
  assert.equal(stale.vault.callsTo('trashLocal').length, 1);
  assert.equal(stale.state.data.deleteBudget.length, 1, 'and the stale entries were pruned');
});

// ---------------------------------------------------------------- 38: durable decline

test('38: "keep my copies" is persisted and never re-prompts', async () => {
  const h = makeHarness({ answer: 'keep' });
  h.vault.seed(SHARE, 'd');
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = nid(`D${pad3(i)}`);
    ids.push(id);
    h.nodes.set(id, dead(file('', `f${pad3(i)}.md`, { s: 1 })));
    await place(h, id, `Shared/f${pad3(i)}.md`, `body ${i}`);
  }

  await h.deletions.apply(h.ctx());
  assert.equal(h.confirms.length, 1);

  await h.state.flush();
  const persisted = JSON.parse(h.port.writes[h.port.writes.length - 1]) as {
    declinedNodes: string[]; declinedPaths: string[];
  };
  assert.deepEqual(persisted.declinedNodes.sort(), [...ids].sort(), 'ids persisted');
  assert.deepEqual(
    persisted.declinedPaths.sort(),
    ids.map((_, i) => fold(`Shared/f${pad3(i)}.md`)).sort(),
    'folds persisted (I13)',
  );

  for (let pass = 0; pass < 20; pass++) {
    const ctx = h.ctx();
    assert.deepEqual(h.deletions.collectDeletable(ctx), [], `pass ${pass} still excludes them`);
    await h.deletions.apply(ctx);
  }

  assert.equal(h.confirms.length, 1, 'never prompted again');
  assert.equal(mutations(h.vault), 0, 'and never applied');
  assert.equal(Object.keys(h.vault.snapshot()).length, 12, 'every local copy is still there');
});

// ---------------------------------------------------------------- 39-40: replay and absence

test('39: replaying the same tombstone does nothing further', async () => {
  const h = makeHarness();
  const id = nid('A');
  h.nodes.set(id, dead(file('', 'a.md', { s: 1 })));
  h.vault.seed(SHARE, 'd');
  await place(h, id, 'Shared/a.md', 'body');

  await h.deletions.apply(h.ctx());
  assert.equal(h.vault.callsTo('trashLocal').length, 1);

  for (let pass = 0; pass < 5; pass++) {
    const ctx = h.ctx();
    await h.deletions.apply(ctx);
    assert.deepEqual(ctx.failures, [], `pass ${pass} was clean`);
  }

  assert.equal(h.vault.callsTo('trashLocal').length, 1, 'still exactly one removal');
  assert.equal(h.vault.callsTo('rename').length, 0);
  assert.equal(h.state.data.deleteBudget.length, 1, 'and one budget entry, not six');
});

test('40: a tombstone whose file is not on disk is a no-op, never an error (I2)', async () => {
  const h = makeHarness();
  const id = nid('A');
  h.nodes.set(id, dead(file('', 'ghost.md', { s: 1 })));
  h.vault.seed(SHARE, 'd');
  h.state.data.materialized[id] = 'Shared/ghost.md';        // bound, but nothing is there

  const ctx = h.ctx();
  h.vault.resetCalls();
  await h.deletions.apply(ctx);

  assert.equal(h.vault.calls.length, 0, 'the vault was not touched at all');
  assert.deepEqual(ctx.failures, [], 'and it is not a failure');
  assert.equal(h.state.data.materialized[id], undefined, 'just unbound');
  assert.equal(ctx.removedThisPass.size, 0, 'nothing was removed by this pass');
  assert.equal(h.state.data.deleteBudget.length, 0);
  assert.deepEqual(h.state.data.declinedNodes, []);
});

// ---------------------------------------------------------------- 41-42: the breaker's defaults

test('41: a bootstrap batch always confirms, however small', async () => {
  const h = makeHarness({ answer: 'keep' });
  const id = nid('A');
  h.nodes.set(id, dead(file('', 'a.md', { s: 1 })));
  h.vault.seed(SHARE, 'd');
  await place(h, id, 'Shared/a.md', 'body');

  await h.deletions.apply(h.ctx('bootstrap'));

  assert.equal(h.confirms.length, 1, '"you were offline while the team reorganized"');
  assert.equal(h.confirms[0].count, 1);
  assert.equal(mutations(h.vault), 0);

  const g = makeHarness({ answer: 'apply' });
  const gid = nid('A');
  g.nodes.set(gid, dead(file('', 'a.md', { s: 1 })));
  g.vault.seed(SHARE, 'd');
  await place(g, gid, 'Shared/a.md', 'body');

  await g.deletions.apply(g.ctx('bootstrap'));

  assert.equal(g.confirms.length, 1);
  assert.equal(g.vault.callsTo('trashLocal').length, 1, 'and "apply" still applies');
});

test('42: a missing or rejected dialog means keep — never a silent apply', async () => {
  for (const answer of [undefined, 'reject'] as const) {
    const h = makeHarness(answer === undefined ? {} : { answer });
    h.vault.seed(SHARE, 'd');
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = nid(`D${pad3(i)}`);
      ids.push(id);
      h.nodes.set(id, dead(file('', `f${pad3(i)}.md`, { s: 1 })));
      await place(h, id, `Shared/f${pad3(i)}.md`, `body ${i}`);
    }

    const ctx = h.ctx();
    await h.deletions.apply(ctx);

    const label = answer === undefined ? 'no callback' : 'a rejected dialog';
    assert.equal(mutations(h.vault), 0, `${label}: nothing applied`);
    assert.deepEqual(ctx.failures, [], `${label}: and it is not an error`);
    assert.deepEqual(h.state.data.declinedNodes.sort(), [...ids].sort(), `${label}: all declined`);
    assert.equal(h.state.data.declinedPaths.length, 12, label);
    assert.equal(h.state.data.deleteBudget.length, 0, label);
    assert.equal(ctx.removedThisPass.size, 0, label);
  }
});

// ---------------------------------------------------------------- 43: containment

test('43: one failing item does not abort the batch (I15)', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  for (const label of ['A', 'B', 'C']) {
    const id = nid(label);
    h.nodes.set(id, dead(file('', `${label}.md`)));         // unseeded => every one rescues
    await place(h, id, `Shared/${label}.md`, `body ${label}`, { hash: false });
  }
  h.vault.failNext('rename', new Error('EPERM: antivirus lock'));

  const ctx = h.ctx();
  await h.deletions.apply(ctx);

  assert.equal(ctx.failures.length, 1, 'exactly one contained failure');
  assert.equal(ctx.failures[0].key, `delete:${nid('A')}`);
  assert.match(String((ctx.failures[0].err as Error).message), /EPERM/);

  assert.equal(h.vault.snapshot()['Shared/A.md'], 'body A', 'the failed item was not destroyed');
  assert.equal(h.state.data.materialized[nid('A')], 'Shared/A.md', 'still bound, so it retries');
  assert.equal(ctx.removedThisPass.has(fold('Shared/A.md')), false);

  assert.equal(rescuedInto(h.vault).length, 2, 'the other two still processed');
  assert.equal(h.state.data.materialized[nid('B')], undefined);
  assert.equal(h.state.data.materialized[nid('C')], undefined);
  assert.equal(h.vault.callsTo('trashLocal').length, 0, 'and nothing was trashed on the way');
});

// ------------------------------------------------------- B14-B15: proving a binary

test('B14: an attachment the store still holds is trashed, and the trash keeps its bytes', async () => {
  const h = makeHarness();
  const id = nid('A');
  const bytes = png(1);
  h.nodes.set(id, dead(blob('', 'shot.png', { s: 1, b: await blobRef(bytes) })));
  h.vault.seed(SHARE, 'd');
  await placeBinary(h, id, 'Shared/shot.png', bytes);
  await h.blobs.seed(bytes);

  const ctx = h.ctx();
  await h.deletions.apply(ctx);

  assert.deepEqual(ctx.failures, []);
  assert.deepEqual(rescuedInto(h.vault), [], 'the common case does not fill Recovered/');

  const trashed = h.vault.callsTo('trashLocal');
  assert.equal(trashed.length, 1, 'exactly one removal');
  assert.deepEqual(trashed[0].args, ['Shared/shot.png']);

  // B32, and I1 asserted positively: a UTF-8 round trip would not give these back.
  const retained = h.vault.trashedFor('Shared/shot.png');
  assert.equal(retained.length, 1);
  assert.deepEqual(retained[0].bytes, bytes, 'the exact bytes are retrievable from .trash');

  // The live probe is what made this a trash rather than a rescue, and it asked
  // about the TREE's digest.
  const asked = h.blobs.callsTo('has');
  assert.equal(asked.length, 1, 'one HEAD, never a cached answer');
  assert.deepEqual(asked[0].args, [await hashOfBytes(bytes)]);

  assert.equal(h.state.data.materialized[id], undefined, 'unbound');
  assert.deepEqual(h.state.data.declinedNodes, [], 'a trash is not a decline');
});

test('B14: a HEAD that throws removes nothing at all and records one failure (I2)', async () => {
  const h = makeHarness();
  const id = nid('A');
  const bytes = png(2);
  h.nodes.set(id, dead(blob('', 'shot.png', { s: 1, b: await blobRef(bytes) })));
  h.vault.seed(SHARE, 'd');
  await placeBinary(h, id, 'Shared/shot.png', bytes);
  await h.blobs.seed(bytes);
  h.blobs.failNext('has', new BlobTransport('ECONNRESET'));

  const ctx = h.ctx();
  await h.deletions.apply(ctx);

  // A transport failure is CONTAINED, not answered: nothing is trashed and
  // nothing is rescued either, because "I could not ask" is evidence of nothing.
  assert.equal(mutations(h.vault), 0, 'no rescue and no removal');
  assert.deepEqual(h.vault.binarySnapshot()['Shared/shot.png'], bytes);
  assert.equal(ctx.failures.length, 1, 'one contained failure');
  assert.equal(ctx.failures[0].key, `delete:${id}`);

  // And the decision is not remembered, so the next pass simply asks again.
  assert.equal(h.state.data.materialized[id], 'Shared/shot.png', 'still bound');
  assert.deepEqual(h.state.data.declinedNodes, []);
  assert.deepEqual(h.state.data.declinedPaths, []);
  assert.equal(ctx.removedThisPass.size, 0);
  assert.equal(h.deletions.collectDeletable(h.ctx()).length, 1, 'a later pass retries it');
});

test('B14: a definite absence means this copy may be the only one, so it is rescued', async () => {
  const h = makeHarness();
  const id = nid('A');
  const bytes = png(3);
  h.nodes.set(id, dead(blob('', 'shot.png', { s: 1, b: await blobRef(bytes) })));
  h.vault.seed(SHARE, 'd');
  await placeBinary(h, id, 'Shared/shot.png', bytes);
  // The store was swept, or never finished the upload: `has` answers a definite no.
  h.blobs.setAbsent(await hashOfBytes(bytes));

  const ctx = h.ctx();
  await h.deletions.apply(ctx);

  assert.deepEqual(ctx.failures, []);
  assert.equal(h.vault.callsTo('trashLocal').length, 0, 'nothing was removed');
  const rescued = rescuedInto(h.vault);
  assert.equal(rescued.length, 1);
  assert.match(rescued[0], /^ShadowLink Recovered\/shot\.png \(deleted by Ann \d{4}-\d\d-\d\d\)\.png$/);
  assert.deepEqual(h.vault.binarySnapshot()[rescued[0]], bytes, 'byte-for-byte, moved not copied');
  assert.deepEqual(h.state.data.declinedNodes, [id], 'and never revisited');
});

test('B14: bytes that are some other version are rescued without asking the store', async () => {
  const h = makeHarness();
  const id = nid('A');
  const theirs = png(4);
  const ours = png(5);
  h.nodes.set(id, dead(blob('', 'shot.png', { s: 1, b: await blobRef(theirs) })));
  h.vault.seed(SHARE, 'd');
  // Our disk holds a different version, and the base agrees with the disk — a
  // device-local memory of our OWN bytes is not evidence about the workspace's.
  await placeBinary(h, id, 'Shared/shot.png', ours);
  await h.blobs.seed(theirs);
  await h.blobs.seed(ours);
  h.blobs.resetCalls();

  const ctx = h.ctx();
  await h.deletions.apply(ctx);

  assert.deepEqual(ctx.failures, []);
  assert.equal(h.vault.callsTo('trashLocal').length, 0);
  assert.equal(rescuedInto(h.vault).length, 1, 'our version was kept');
  assert.deepEqual(h.blobs.calls, [], 'the tree already said these are not its bytes');
});

test('B14: an attachment that was never properly published is never proven', async () => {
  const bytes = png(6);
  const ref = await blobRef(bytes);
  const cases: Array<{ label: string; node: NodeFields }> = [
    { label: 'never seeded', node: dead(blob('', 'a.png', { b: ref })) },
    { label: 'no reference at all', node: dead(blob('', 'a.png', { s: 1 })) },
    { label: 'a malformed reference', node: dead(blob('', 'a.png', { s: 1, b: `${ref}:extra` })) },
    {
      label: 'an uppercase digest',
      node: dead(blob('', 'a.png', { s: 1, b: ref.toUpperCase() })),
    },
  ];

  for (const { label, node } of cases) {
    const h = makeHarness();
    const id = nid('A');
    h.nodes.set(id, node);
    h.vault.seed(SHARE, 'd');
    await placeBinary(h, id, 'Shared/a.png', bytes);
    await h.blobs.seed(bytes);
    h.blobs.resetCalls();

    await h.deletions.apply(h.ctx());

    assert.equal(h.vault.callsTo('trashLocal').length, 0, `${label}: nothing removed`);
    assert.equal(rescuedInto(h.vault).length, 1, `${label}: rescued`);
    assert.deepEqual(h.blobs.calls, [], `${label}: the store was never asked`);
  }
});

test('B14/B24: a file too big to prove is rescued rather than guessed at', async () => {
  const PATH = 'Shared/video.webm';
  const bytes = png(7);

  // Case one: over PROVE_HASH_MAX_BYTES but under the memory cap — hashing it
  // would work and is simply too expensive to spend on a deletion verdict.
  const big = makeHarness({
    vaultPort: (inner) => wrapVault(inner, {
      stat: async (p) => {
        const st = await inner.stat(p);
        if (st === null || fold(p) !== fold(PATH)) return st;
        return { ...st, bytes: PROVE_HASH_MAX_BYTES + 1 };
      },
    }),
  });
  const id = nid('A');
  big.nodes.set(id, dead(blob('', 'video.webm', { s: 1, b: await blobRef(bytes) })));
  big.vault.seed(SHARE, 'd');
  await placeBinary(big, id, PATH, bytes, { hash: false });
  await big.blobs.seed(bytes);

  await big.deletions.apply(big.ctx());

  assert.equal(big.vault.callsTo('trashLocal').length, 0, 'nothing removed');
  assert.equal(rescuedInto(big.vault).length, 1, 'rescued');
  assert.equal(big.vault.callsTo('readBinary').length, 0, 'and never read into memory');
  assert.deepEqual(big.blobs.calls, [], 'no verdict was reached, so nothing was asked');

  // Case two: under the prove cap but over what THIS device may hold at once.
  const phone = makeHarness({ memoryCapBytes: () => 8 });
  phone.nodes.set(id, dead(blob('', 'video.webm', { s: 1, b: await blobRef(bytes) })));
  phone.vault.seed(SHARE, 'd');
  await placeBinary(phone, id, PATH, bytes, { hash: false });
  await phone.blobs.seed(bytes);

  await phone.deletions.apply(phone.ctx());

  assert.equal(phone.vault.callsTo('trashLocal').length, 0, 'nothing removed');
  assert.equal(rescuedInto(phone.vault).length, 1, 'rescued');
  assert.equal(phone.vault.callsTo('readBinary').length, 0, 'and never read into memory');
});

test('B15: a cached hash the disk contradicts is not trusted — either clause alone', async () => {
  const theirs = png(8);
  const ours = png(9);                                    // same length, different bytes
  assert.equal(ours.length, theirs.length, 'the fixture must isolate the mtime clause');
  const ref = await blobRef(theirs);

  // The base claims the workspace's digest, so trusting it would prove the file.
  // Only the staleness oracle stands between that claim and a deletion.
  const claimed = await hashOfBytes(theirs);
  const cases: Array<{ label: string; opts: { hash: string; len?: number; mtime?: number | null } }> = [
    { label: 'a stale mtime', opts: { hash: claimed, mtime: 1 } },
    { label: 'a stale length', opts: { hash: claimed, len: 999 } },
    { label: 'no mtime at all', opts: { hash: claimed, mtime: null } },
  ];

  for (const { label, opts } of cases) {
    const h = makeHarness();
    const id = nid('A');
    h.nodes.set(id, dead(blob('', 'shot.png', { s: 1, b: ref })));
    h.vault.seed(SHARE, 'd');
    await placeBinary(h, id, 'Shared/shot.png', ours, opts);
    await h.blobs.seed(theirs);
    h.blobs.resetCalls();
    h.vault.resetCalls();

    await h.deletions.apply(h.ctx());

    assert.equal(h.vault.callsTo('readBinary').length, 1, `${label}: re-hashed from disk`);
    assert.equal(h.vault.callsTo('trashLocal').length, 0, `${label}: nothing removed`);
    assert.equal(rescuedInto(h.vault).length, 1, `${label}: our copy was kept`);
    assert.deepEqual(h.blobs.calls, [], `${label}: the disk answered before the store was asked`);
  }
});

test('B15: a base that still matches size and mtime answers without re-reading the file', async () => {
  const h = makeHarness();
  const id = nid('A');
  const bytes = png(10);
  h.nodes.set(id, dead(blob('', 'shot.png', { s: 1, b: await blobRef(bytes) })));
  h.vault.seed(SHARE, 'd');
  await placeBinary(h, id, 'Shared/shot.png', bytes);
  await h.blobs.seed(bytes);

  await h.deletions.apply(h.ctx());

  assert.equal(h.vault.callsTo('readBinary').length, 0, 'the size+mtime cache was enough');
  assert.equal(h.vault.callsTo('stat').length, 1, 'one stat per item');
  assert.equal(h.blobs.callsTo('has').length, 1, 'but the store is asked every time');
  assert.equal(h.vault.callsTo('trashLocal').length, 1);
});

test('A14: a rescued attachment keeps its own extension, and the fallback is never .md', () => {
  const shot = dead(blob('', 'shot.png', { s: 1 }));
  assert.equal(
    rescueName('Shared/shot.png', shot, NOW),
    'shot.png (deleted by Ann 2023-11-14).png',
    'the name Obsidian shows is the name it had, plus why it moved',
  );
  assert.equal(
    rescueName('Shared/deck.excalidraw', dead(blob('', 'deck.excalidraw', { s: 1 })), NOW),
    'deck.excalidraw (deleted by Ann 2023-11-14).excalidraw',
  );

  // `validateRel` guarantees a `'b'` node HAS an extension, so this is
  // unreachable today — which is exactly why it is asserted. A hardcoded `.md`
  // on a rescued PNG would be silently wrong the day it stops being unreachable.
  assert.equal(
    rescueName('Shared/scan', dead(blob('', 'scan', { s: 1 })), NOW),
    'scan (deleted by Ann 2023-11-14).bin',
  );
  assert.equal(
    rescueName('Shared/note', dead(file('', 'note')), NOW),
    'note (deleted by Ann 2023-11-14).md',
    'and markdown is unchanged',
  );
});

test('the pass\'s own blob store decides, not the one the module was built with', async () => {
  // §5.2: step 4 decides against the same collaborators the rest of the pass
  // used. The deps hold a store that has never heard of these bytes; the context
  // holds the pass's, which has them.
  const h = makeHarness();
  const id = nid('A');
  const bytes = png(11);
  h.nodes.set(id, dead(blob('', 'shot.png', { s: 1, b: await blobRef(bytes) })));
  h.vault.seed(SHARE, 'd');
  await placeBinary(h, id, 'Shared/shot.png', bytes);

  const passStore = new FakeBlobs();
  await passStore.seed(bytes);
  await h.deletions.apply(h.ctx('remote', { blobs: passStore }));

  assert.equal(h.vault.callsTo('trashLocal').length, 1, 'the context answered');
  assert.equal(passStore.callsTo('has').length, 1);
  assert.deepEqual(h.blobs.calls, [], 'and the constructor store was never consulted');
});

test('a dead node the same derivation also reports as live is rescued, never trashed (I2)', async () => {
  const h = makeHarness();
  const id = nid('A');
  const bytes = png(12);
  const ref = await blobRef(bytes);
  h.nodes.set(id, dead(blob('', 'shot.png', { s: 1, b: ref })));
  h.vault.seed(SHARE, 'd');
  await placeBinary(h, id, 'Shared/shot.png', bytes);
  await h.blobs.seed(bytes);

  // The two halves of one derivation contradict each other: dead here, live and
  // published there. Acting on a contradiction is how a file goes missing.
  const live = new Map([[id, { sha256: ref.slice(0, 64), bytes: bytes.length, parent: null }]]);
  await h.deletions.apply(h.ctx('remote', { blobRefs: live }));

  assert.equal(h.vault.callsTo('trashLocal').length, 0, 'nothing removed');
  assert.equal(rescuedInto(h.vault).length, 1, 'the copy was kept');
  assert.deepEqual(h.blobs.calls, [], 'and no verdict was even attempted');
});

// ------------------------------------------------------- B16: the byte trip condition

/**
 * Seed one attachment whose TREE reference claims `claimBytes`, with real bytes
 * on disk that are nothing like that big.
 *
 * That is not a contrived state: `ref.bytes` is what the workspace says the file
 * is, it is already in the tree, and reading it costs no I/O at all — which is
 * exactly why the breaker may use it. The fixture keeps the test honest about
 * that by never allocating the megabytes it is talking about.
 */
async function placeClaimed(
  h: Harness,
  id: string,
  name: string,
  claimBytes: number,
): Promise<Uint8Array> {
  const bytes = png(id.charCodeAt(0));
  const ref = formatBlobRef(await hashOfBytes(bytes), claimBytes, null);
  h.nodes.set(id, dead(blob('', name, { s: 1, b: ref })));
  await placeBinary(h, id, `${SHARE}/${name}`, bytes);
  await h.blobs.seed(bytes);
  return bytes;
}

test('B16: two attachments over the byte alert trip the breaker and report their size', async () => {
  const h = makeHarness({ answer: 'keep' });
  h.vault.seed(SHARE, 'd');
  await placeClaimed(h, nid('A'), 'a.webm', 130_000_000);
  await placeClaimed(h, nid('B'), 'b.webm', 120_000_000);

  const ctx = h.ctx();
  assert.equal(h.deletions.collectDeletable(ctx).length, 2, 'two files, far under the count budget');

  await h.deletions.apply(ctx);

  assert.equal(h.confirms.length, 1, 'one coalesced dialog');
  assert.equal(h.confirms[0].count, 2);
  assert.equal(h.confirms[0].bytes, 250_000_000, 'so the dialog can say "2 files (238 MB)"');

  // Declined: nothing on disk changed, and the decision is remembered.
  assert.equal(mutations(h.vault), 0, 'a declined batch removes nothing');
  assert.deepEqual([...h.state.data.declinedNodes].sort(), [nid('A'), nid('B')]);
  assert.deepEqual(h.blobs.callsTo('has'), [], 'and no verdict was even reached');
});

test('B16: the byte alert is a ceiling, not a floor — a small batch still applies silently', async () => {
  const h = makeHarness({ answer: 'keep' });
  h.vault.seed(SHARE, 'd');
  // Exactly AT the alert, which must not trip: the gate is `>`, and a breaker
  // that fires on the ordinary case is a breaker users learn to click through.
  await placeClaimed(h, nid('A'), 'a.png', REMOTE_DELETE_BYTES_ALERT);
  h.nodes.set(nid('B'), dead(file('', 'b.md', { s: 1 })));
  await place(h, nid('B'), `${SHARE}/b.md`, 'body');

  await h.deletions.apply(h.ctx());

  assert.deepEqual(h.confirms, [], 'no dialog');
  assert.equal(h.vault.callsTo('trashLocal').length, 2, 'both removed, both restorable');
  assert.equal(h.vault.trashedFor(`${SHARE}/a.png`).length, 1);
});

test('B16: a batch of notes carries no bytes at all, so only the count can trip it', async () => {
  const h = makeHarness({ answer: 'keep' });
  h.vault.seed(SHARE, 'd');
  for (let i = 0; i < 3; i++) {
    const id = nid(`N${pad3(i)}`);
    h.nodes.set(id, dead(file('', `n${pad3(i)}.md`, { s: 1 })));
    await place(h, id, `${SHARE}/n${pad3(i)}.md`, `body ${i}`);
  }

  await h.deletions.apply(h.ctx());

  assert.deepEqual(h.confirms, [], 'markdown has no size in the tree and no dialog is owed');
  assert.equal(h.vault.callsTo('trashLocal').length, 3);
});

test('B14: a note is still decided by the markdown rule and never touches the store', async () => {
  const h = makeHarness();
  const id = nid('A');
  h.nodes.set(id, dead(file('', 'a.md', { s: 1 })));
  h.vault.seed(SHARE, 'd');
  await place(h, id, 'Shared/a.md', 'body');

  await h.deletions.apply(h.ctx());

  assert.equal(h.vault.callsTo('trashLocal').length, 1, 'proven by the recorded hash');
  assert.deepEqual(h.blobs.calls, [], 'markdown has no bytes in the blob store');
  assert.equal(h.vault.callsTo('readBinary').length, 0, 'and is read as text');
});

// ---------------------------------------------------------------- 44: the banned calls

test('44: the irreversible vault calls appear nowhere in Deletions.ts (I1)', () => {
  // Assembled from fragments on purpose: the definition of done requires these
  // two strings to appear NOWHERE under src/, and a test that spelled them out
  // would itself break that grep.
  const banned = [`vault.${'delete'}(`, `${'trash'}(file, true)`];
  const source = readFileSync(new URL('./Deletions.ts', import.meta.url), 'utf8');

  for (const needle of banned) {
    assert.equal(source.includes(needle), false, `Deletions.ts must not contain ${needle}`);
  }
  assert.ok(source.includes('trashLocal('), 'removal goes through the vault-local trash');
  assert.equal(source.includes("from 'obsidian'"), false, 'no obsidian import');
});

// ---------------------------------------------------------------- the dialog mutex

test('a second batch coalesces into an open dialog rather than opening another', async () => {
  const h = makeHarness({ answer: 'defer' });
  h.vault.seed(SHARE, 'd');
  for (let i = 0; i < 12; i++) {
    const id = nid(`D${pad3(i)}`);
    h.nodes.set(id, dead(file('', `f${pad3(i)}.md`, { s: 1 })));
    await place(h, id, `Shared/f${pad3(i)}.md`, `body ${i}`);
  }

  const first = h.deletions.apply(h.ctx());
  const second = h.deletions.apply(h.ctx());       // arrives while the dialog is open

  h.answer('keep');
  await Promise.all([first, second]);

  assert.equal(h.confirms.length, 1, 'one dialog, not two');
  assert.equal(mutations(h.vault), 0, 'and both batches followed that one decision');
  assert.equal(h.state.data.declinedNodes.length, 12, 'declined once, not twice');
});
