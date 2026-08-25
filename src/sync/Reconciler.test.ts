// src/sync/Reconciler.test.ts
//
// Spec §10 Group B, tests 19-30 and 39-43, plus test 44 (carry-forward CF-1).
//
// Every test drives `reconcile()` directly against the in-memory fakes: no
// timers, no debounce, no Yjs. That is deliberate — the reconciler is the code
// that writes the user's real notes, and a test that needs a clock is a test
// nobody can trust to have caught a data-loss bug.
//
// Two of these are load-bearing beyond their own scenario. Test 41 (twenty
// replays produce zero mutations and byte-identical device state) and test 42
// (the same tree changes in fifty shuffled orders converge identically) are what
// stop the pass being "optimized" into incremental delta application, which is
// spec risk R12.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { NodeFields } from '../tree/types.ts';
import * as Y from 'yjs';

import { fold, forkName, hashOfBytes, parseBlobRef } from '../tree/paths.ts';
import { TreeDoc } from '../tree/TreeDoc.ts';
import { Deletions, type BulkChoice, type BulkSummary } from './Deletions.ts';
import { DeviceState, type StatePort } from './DeviceState.ts';
import type { BlobPort } from './BlobPort.ts';
import { DESKTOP_MEMORY_CAP, FakeBlobs, FakeDocs, FakeVault } from './fakes.ts';
import { PublishQueue } from './PublishQueue.ts';
import { Reconciler, RetryLater, type ReconcilerDeps, type DeletionContext } from './Reconciler.ts';
import { Tickets, type TicketOp } from './Tickets.ts';
import { VaultWatcher } from './VaultWatcher.ts';
import type { VaultPort } from './VaultPort.ts';

// ---------------------------------------------------------------- fixtures

const SHARE = 'Shared';
const NOW = 1_700_000_000_000;

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

/** Tombstone a node exactly as §5.3 does: x = g, plus the display-only fields. */
function dead(f: NodeFields): NodeFields {
  return { ...f, x: f.g, xa: NOW - 60_000, xb: 'Ann' };
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

/**
 * A ticket book that remembers what was armed.
 *
 * The reconciler clears the whole book in its `finally`, so "was a ticket armed
 * before that write?" cannot be answered after the pass by looking at the book —
 * and the echo it suppresses belongs to a handler (`onModify`) that does not
 * exist until P2-d. Recording the arms is the only way to hold this slice to a
 * promise the next one depends on.
 */
class RecordingTickets extends Tickets {
  readonly armed: string[] = [];

  arm(op: 'create' | 'delete' | 'modify', path: string): void;
  arm(op: 'rename', from: string, to: string): void;
  arm(op: TicketOp, a: string, b?: string): void {
    this.armed.push(b === undefined ? `${op} ${a}` : `${op} ${a} -> ${b}`);
    if (op === 'rename') super.arm(op, a, b as string);
    else super.arm(op, a);
  }
}

interface Harness {
  vault: FakeVault;
  docs: FakeDocs;
  blobs: FakeBlobs;
  state: DeviceState;
  tickets: Tickets;
  port: MemoryStatePort;
  nodes: Map<string, NodeFields>;
  reconciler: Reconciler;
  /** Every `publishUntracked` batch this pass handed over, in order. */
  published: string[][];
  notices: string[];
  log: string[];
}

function makeHarness(over: Partial<ReconcilerDeps> & { vaultPort?: VaultPort } = {}): Harness {
  const log: string[] = [];
  const vault = new FakeVault();
  const docs = new FakeDocs();
  const blobs = new FakeBlobs();
  const port = new MemoryStatePort(log);
  const now = () => NOW;
  const state = new DeviceState(port, 'device-1', 'ws-1', now, 0);
  const tickets = new Tickets(now);
  const nodes = new Map<string, NodeFields>();
  const published: string[][] = [];
  const notices: string[] = [];

  const reconciler = new Reconciler({
    vault: over.vaultPort ?? vault,
    docs,
    blobs,
    state,
    tickets,
    shareRoot: SHARE,
    entries: () => [...nodes],
    publishUntracked: async (paths) => { published.push(paths); },
    notice: (m) => { notices.push(m); },
    now,
    ...over,
  });

  return { vault, docs, blobs, state, tickets, port, nodes, reconciler, published, notices, log };
}

/** Files only, so an empty reserved folder never shows up as a phantom difference. */
function stashed(vault: FakeVault): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, data] of Object.entries(vault.snapshot())) {
    if (p.startsWith('ShadowLink Recovered/')) out[p] = data;
  }
  return out;
}

function inShare(vault: FakeVault): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, data] of Object.entries(vault.snapshot())) {
    if (p === SHARE || p.startsWith(`${SHARE}/`)) out[p] = data;
  }
  return out;
}

/** Directory paths under the share, literal casing, sorted. */
function foldersIn(vault: FakeVault): string[] {
  return vault.list()
    .filter((e) => e.kind === 'd' && e.path.startsWith(`${SHARE}/`))
    .map((e) => e.path)
    .sort();
}

function mutations(vault: FakeVault): number {
  return vault.calls.filter(
    (c) => c.op === 'create' || c.op === 'createFolder' || c.op === 'rename' || c.op === 'trashLocal',
  ).length;
}

// ---------------------------------------------------------------- 19-20: materialization

test('19: an unpublished node is never materialized, and publishing it writes the file in one call', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, file('', 'todo.md'));            // `s` unset — nobody has published it

  const first = await h.reconciler.reconcile('sync');

  assert.equal(first.ran, true);
  assert.deepEqual(first.diagnostics.pending, [id], 'the node is reported, not materialized');
  assert.deepEqual(h.vault.snapshot(), {}, 'no stub on disk (I6)');
  assert.equal(h.vault.callsTo('create').length, 0);
  assert.equal(h.state.data.materialized[id], undefined);

  // The author publishes: `s` is set and the content doc holds the bytes.
  h.nodes.set(id, file('', 'todo.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'the body');

  const second = await h.reconciler.reconcile('remote');

  assert.equal(second.failures.length, 0);
  assert.deepEqual(h.vault.snapshot(), { 'Shared/todo.md': 'the body' });
  const creates = h.vault.callsTo('create');
  assert.equal(creates.length, 1, 'exactly one create, never create-then-fill');
  assert.deepEqual(creates[0].args, ['Shared/todo.md', 'the body']);
  for (const call of h.vault.calls) {
    if (call.op === 'create') assert.notEqual(call.args[1], '', 'no zero-byte create, ever');
  }
  assert.equal(h.state.data.materialized[id], 'Shared/todo.md');
  assert.ok(h.state.data.contentHash[id], 'contentHash recorded after the write returned (I17)');
});

test('20: a content doc that did not sync creates nothing and is retried', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, file('', 'note.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'real content');
  h.docs.setSynced(`n_${id}`, false);              // a timeout is not a sync (I4)

  const first = await h.reconciler.reconcile('sync');

  assert.deepEqual(h.vault.snapshot(), {}, 'no file created from an unsynced doc');
  assert.equal(h.vault.callsTo('create').length, 0);
  assert.equal(h.state.data.materialized[id], undefined, 'no binding either');
  assert.equal(h.state.data.contentHash[id], undefined);
  assert.equal(first.failures.length, 1);
  assert.ok(first.failures[0].err instanceof RetryLater);
  assert.ok(first.failures[0].key.includes(id));
  assert.ok(h.docs.allClosed(), 'the handle is released even on the failure path');

  h.docs.setSynced(`n_${id}`, true);
  const second = await h.reconciler.reconcile('retry');

  assert.equal(second.failures.length, 0);
  assert.deepEqual(h.vault.snapshot(), { 'Shared/note.md': 'real content' });
  assert.equal(h.state.data.materialized[id], 'Shared/note.md');
});

// ---------------------------------------------------------------- 21-23: tombstoned paths

test('21: a new live node at a tombstoned path is created and never trashed', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const gone = nid('A');
  const fresh = nid('B');
  h.nodes.set(gone, dead(file('', 'p.md', { s: 1 })));
  h.nodes.set(fresh, file('', 'p.md', { s: 1 }));
  h.docs.setText(`n_${fresh}`, 'brand new');

  await h.reconciler.reconcile('remote');
  assert.deepEqual(h.vault.snapshot(), { 'Shared/p.md': 'brand new' });

  for (let i = 0; i < 5; i++) {
    const r = await h.reconciler.reconcile('retry');
    assert.equal(r.ran, true);
    assert.deepEqual(h.vault.snapshot(), { 'Shared/p.md': 'brand new' }, `pass ${i} kept the file`);
  }

  assert.equal(h.vault.callsTo('trashLocal').length, 0);
  assert.equal(h.vault.wasTrashed('Shared/p.md'), false);
  assert.equal(h.state.data.materialized[fresh], 'Shared/p.md');
});

test('22: a tombstoned path is never handed back to the publisher', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, file('', 'todo.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'body');
  await h.reconciler.reconcile('sync');
  assert.deepEqual(h.vault.snapshot(), { 'Shared/todo.md': 'body' });

  const before = h.nodes.size;
  h.nodes.set(id, dead(file('', 'todo.md', { s: 1 })));   // remote tombstone arrives
  h.published.length = 0;

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(h.published, [[]], 'step 6 offered nothing (I13)');
  assert.deepEqual(r.diagnostics.deletedButPresent, ['Shared/todo.md']);
  assert.equal(h.nodes.size, before, 'the reconciler never writes the tree');
});

test('23: a cold start leaves an untracked file at a tombstoned path alone', async () => {
  const h = makeHarness();
  h.vault.seed('Shared/todo.md', 'f', 'my local copy');
  h.nodes.set(nid('A'), dead(file('', 'todo.md', { s: 1 })));
  assert.deepEqual(h.state.data.materialized, {}, 'cold start: nothing bound');

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(h.vault.snapshot(), { 'Shared/todo.md': 'my local copy' }, 'untouched (I2)');
  assert.equal(h.vault.callsTo('trashLocal').length, 0);
  assert.deepEqual(r.diagnostics.deletedButPresent, ['Shared/todo.md']);
  assert.deepEqual(h.published, [[]]);
});

// ---------------------------------------------------------------- 24-27: occupancy, case, staging

test('24: a case-variant occupant is stashed and adopted, never blind-created over', async () => {
  const h = makeHarness();
  h.vault.seed('Shared/Notes/readme.md', 'f', 'LOCAL BYTES');
  const id = nid('A');
  h.nodes.set(id, file('Notes', 'README.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'SHARED BYTES');

  await h.reconciler.reconcile('bootstrap');

  const created = h.vault.callsTo('create').map((c) => c.args[0]);
  assert.equal(
    created.includes('Shared/Notes/README.md'), false,
    'never create at the tree casing while a fold-variant occupies the path (I11)',
  );
  assert.equal(created.includes('Shared/Notes/readme.md'), true, 'wrote through the literal path');

  const stash = stashed(h.vault);
  assert.equal(Object.keys(stash).length, 1, 'exactly one local copy was stashed');
  assert.equal(Object.values(stash)[0], 'LOCAL BYTES', 'the original bytes are recoverable');
  assert.equal(h.vault.snapshot()['Shared/Notes/readme.md'], 'SHARED BYTES');

  // Converge: the adopted file still carries the disk's casing, so the next pass
  // performs the case-only rename to the casing the tree asks for.
  for (let i = 0; i < 4; i++) await h.reconciler.reconcile('retry');
  assert.equal(h.vault.snapshot()['Shared/Notes/README.md'], 'SHARED BYTES');
  assert.equal(h.state.data.materialized[id], 'Shared/Notes/README.md');
  assert.equal(Object.keys(stashed(h.vault)).length, 1, 'no second stash on any later pass');
});

test('25: a case-only rename routes through staging and does not re-queue forever', async () => {
  const h = makeHarness();
  const id = nid('A');
  h.vault.seed('Shared/notes.md', 'f', 'body');
  h.state.data.materialized[id] = 'Shared/notes.md';
  h.nodes.set(id, file('', 'Notes.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'body');

  await h.reconciler.reconcile('remote');

  const renames = h.vault.callsTo('rename').map((c) => c.args);
  assert.deepEqual(renames, [
    ['Shared/notes.md', `ShadowLink Staging/${id}.md`],
    [`ShadowLink Staging/${id}.md`, 'Shared/Notes.md'],
  ], 'out to staging, then in — a folding filesystem refuses the direct rename');
  assert.deepEqual(h.vault.snapshot(), { 'Shared/Notes.md': 'body' });
  assert.deepEqual(h.state.data.staging, {}, 'journal drained');
  assert.equal(h.state.data.materialized[id], 'Shared/Notes.md');

  h.vault.resetCalls();
  for (let i = 0; i < 10; i++) await h.reconciler.reconcile('retry');
  assert.equal(mutations(h.vault), 0, 'ten further passes are pure no-ops');
});

test('26: an a<->b swap completes with no rescue and an empty journal', async () => {
  const h = makeHarness();
  const a = nid('A');
  const b = nid('B');
  h.vault.seed('Shared/a.md', 'f', 'AAA');
  h.vault.seed('Shared/b.md', 'f', 'BBB');
  h.state.data.materialized = { [a]: 'Shared/a.md', [b]: 'Shared/b.md' };
  h.nodes.set(a, file('', 'b.md', { s: 1 }));
  h.nodes.set(b, file('', 'a.md', { s: 1 }));
  h.docs.setText(`n_${a}`, 'AAA');
  h.docs.setText(`n_${b}`, 'BBB');

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.failures.length, 0);
  assert.deepEqual(inShare(h.vault), { 'Shared/a.md': 'BBB', 'Shared/b.md': 'AAA' });
  assert.deepEqual(stashed(h.vault), {}, 'a genuine swap never rescues');
  assert.deepEqual(h.state.data.staging, {});
  assert.deepEqual(h.state.data.materialized, { [a]: 'Shared/b.md', [b]: 'Shared/a.md' });
  assert.equal(h.vault.callsTo('rename').length, 3, 'stage out, move the unblocked node, stage in');
});

test('27: a crash between stageOut and unstageAll loses nothing', async () => {
  const a = nid('A');
  const b = nid('B');
  const inner = new FakeVault();
  const log: string[] = [];
  let renameCount = 0;
  // Every rename after the stage-out throws, so the pass ends with the file
  // parked in staging and the journal entry still on disk — the observable
  // state a process kill mid-swap leaves behind.
  const crashing = wrapVault(inner, {
    rename: async (from, to) => {
      renameCount += 1;
      log.push(`vault:rename:${renameCount}`);
      if (renameCount >= 2) throw new Error('simulated crash');
      return inner.rename(from, to);
    },
  });

  // The state port writes into the SAME log, so the journal-before-move ordering
  // is observable rather than assumed.
  const port = new MemoryStatePort(log);
  const state = new DeviceState(port, 'device-1', 'ws-1', () => NOW, 0);
  const nodes = new Map<string, NodeFields>();
  const docs = new FakeDocs();
  const crashed = new Reconciler({
    vault: crashing, docs, blobs: new FakeBlobs(), state, tickets: new Tickets(() => NOW),
    shareRoot: SHARE, entries: () => [...nodes], now: () => NOW,
  });

  inner.seed('Shared/a.md', 'f', 'AAA');
  inner.seed('Shared/b.md', 'f', 'BBB');
  state.data.materialized = { [a]: 'Shared/a.md', [b]: 'Shared/b.md' };
  nodes.set(a, file('', 'b.md', { s: 1 }));
  nodes.set(b, file('', 'a.md', { s: 1 }));
  docs.setText(`n_${a}`, 'AAA');
  docs.setText(`n_${b}`, 'BBB');

  await crashed.reconcile('remote');

  // The journal is written BEFORE the move, so a crash between the two is replayable.
  assert.equal(log[0], 'state:write', 'device state was persisted before any rename');
  assert.equal(log[1], 'vault:rename:1');
  const journalled = JSON.parse(port.writes[0]) as { staging: Record<string, unknown> };
  assert.ok(journalled.staging[a], 'the first write already carried the staging entry');
  assert.equal(inner.snapshot()[`ShadowLink Staging/${a}.md`], 'AAA', 'file is parked in staging');

  // Restart: only what reached disk before the crash is available.
  const restarted = new DeviceState(port.fork(state.key, port.writes[0]), 'device-1', 'ws-1', () => NOW, 0);
  await restarted.load();
  assert.ok(restarted.data.staging[a], 'the replayable journal survived the restart');

  const recovered = new Reconciler({
    vault: inner, docs, blobs: new FakeBlobs(), state: restarted, tickets: new Tickets(() => NOW),
    shareRoot: SHARE, entries: () => [...nodes], now: () => NOW,
  });
  await recovered.reconcile('retry');

  assert.deepEqual(inner.snapshot(), {
    'Shared/a.md': 'BBB',
    'Shared/b.md': 'AAA',
    'ShadowLink Recovered/a.md': 'AAA',
  }, 'the staged file reached its target and the rescued copy is visible — nothing lost');
  assert.deepEqual(restarted.data.staging, {}, 'journal drained');
});

// ---------------------------------------------------------------- 28-30: containment and refusal

test('28: one throwing item does not abort the pass', async () => {
  const h = makeHarness();
  const x = nid('X');
  const y = nid('Y');
  const z = nid('Z');
  h.vault.seed('Shared/x.md', 'f', 'XXX');
  h.vault.seed('Shared/y.md', 'f', 'YYY');
  h.state.data.materialized = { [x]: 'Shared/x.md', [y]: 'Shared/y.md' };
  h.nodes.set(x, file('sub', 'x.md', { s: 1 }));
  h.nodes.set(y, file('sub', 'y.md', { s: 1 }));
  h.nodes.set(z, file('', 'z.md', { s: 1 }));
  h.docs.setText(`n_${x}`, 'XXX');
  h.docs.setText(`n_${y}`, 'YYY');
  h.docs.setText(`n_${z}`, 'ZZZ');

  h.vault.failNext('rename', new Error('EPERM'));   // the first rename in the pass is X's

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.ran, true);
  assert.equal(h.reconciler.reconciling, false);
  assert.equal(r.failures.length, 1);
  assert.ok(r.failures[0].key.includes(x));

  assert.deepEqual(inShare(h.vault), {
    'Shared/x.md': 'XXX',            // the failing item stayed put — never a delete
    'Shared/sub/y.md': 'YYY',        // the other move still ran
    'Shared/z.md': 'ZZZ',            // and so did materialization
  });
  // Device state was rebuilt from what is on disk, not from what was desired.
  assert.deepEqual(h.state.data.materialized, {
    [x]: 'Shared/x.md',
    [y]: 'Shared/sub/y.md',
    [z]: 'Shared/z.md',
  });

  const again = await h.reconciler.reconcile('retry');
  assert.equal(again.failures.length, 0);
  assert.deepEqual(inShare(h.vault), {
    'Shared/sub/x.md': 'XXX',
    'Shared/sub/y.md': 'YYY',
    'Shared/z.md': 'ZZZ',
  });
});

test('29: a throwing deletion step never wedges the reconciler', async () => {
  const boom = new Error('deletions exploded');
  const h = makeHarness({ applyDeletions: async () => { throw boom; } });
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, file('', 'a.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'body');

  const first = await h.reconciler.reconcile('remote');

  assert.equal(h.reconciler.reconciling, false, 'the single-flight flag was cleared');
  assert.ok(first.failures.some((f) => f.err === boom));
  assert.deepEqual(h.vault.snapshot(), { 'Shared/a.md': 'body' }, 'earlier steps still ran');

  const second = await h.reconciler.reconcile('remote');
  assert.equal(second.ran, true, 'a later pass genuinely runs');
});

test('30: a mount mismatch enters read-only and mutates nothing', async () => {
  const h = makeHarness();
  for (let i = 0; i < 300; i++) {
    h.state.data.materialized[nid(`N${pad3(i)}`)] = `Work/Team/note-${i}.md`;
  }
  h.vault.seed('Shared/existing.md', 'f', 'still here');
  h.nodes.set(nid('A'), file('', 'wanted.md', { s: 1 }));
  h.docs.setText(`n_${nid('A')}`, 'body');

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.ran, false);
  assert.ok(r.refusedReason);
  assert.equal(h.reconciler.readOnly, true);
  assert.equal(mutations(h.vault), 0, 'zero create / createFolder / rename / trashLocal');
  assert.equal(
    Object.keys(h.state.data.materialized).length, 300,
    'a refusal must not rewrite the very state it refused to trust',
  );

  const again = await h.reconciler.reconcile('sync');
  assert.equal(again.ran, false, 'read-only is sticky');
  assert.equal(mutations(h.vault), 0);
});

// ---------------------------------------------------------------- 39-40: dead folder sweep

test('39: an empty dead folder is trashed but one holding only a dotfile is not', async () => {
  const h = makeHarness();
  h.nodes.set(nid('A'), dead(dir('', 'Archive')));
  h.nodes.set(nid('B'), dead(dir('', 'Empty')));
  h.vault.seed('Shared/Archive/.git/config', 'f', 'gitdir');   // invisible to list(), visible to listDir()
  h.vault.seed('Shared/Empty', 'd');

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.ran, true);
  assert.equal(h.vault.wasTrashed('Shared/Empty'), true, 'a genuinely empty dead folder goes');
  assert.equal(h.vault.wasTrashed('Shared/Archive'), false, '.git is still in there');
  assert.deepEqual(h.vault.callsTo('trashLocal').map((c) => c.args), [['Shared/Empty']]);
  assert.equal(h.vault.snapshot()['Shared/Archive/.git/config'], 'gitdir');
});

test('40: a dead folder node whose path a live node claims is not removed', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.nodes.set(nid('A'), dead(dir('', 'Notes')));
  h.nodes.set(nid('B'), dir('', 'Notes'));

  await h.reconciler.reconcile('remote');

  assert.equal(h.vault.callsTo('trashLocal').length, 0);
  assert.deepEqual(h.vault.callsTo('createFolder').map((c) => c.args), [['Shared/Notes']]);
  assert.equal(h.vault.wasTrashed('Shared/Notes'), false);
});

// ---------------------------------------------------------------- 41-43: convergence properties

test('41: twenty replays against an unchanging tree mutate nothing', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const ids = { d1: nid('C'), f1: nid('D'), f2: nid('E'), f3: nid('F') };
  h.nodes.set(ids.d1, dir('', 'Notes'));
  h.nodes.set(ids.f1, file('', 'root.md', { s: 1 }));
  h.nodes.set(ids.f2, file('Notes', 'inner.md', { s: 1 }));
  h.nodes.set(ids.f3, file('Notes/deep', 'deeper.md', { s: 1 }));
  for (const id of Object.values(ids)) h.docs.setText(`n_${id}`, `body of ${id}`);

  await h.reconciler.reconcile('bootstrap');
  const layout = h.vault.snapshot();
  const stateAfterFirst = JSON.stringify(h.state.data);
  const opensAfterFirst = h.docs.calls.filter((c) => c.op === 'openHeadless').length;
  h.vault.resetCalls();

  for (let i = 0; i < 20; i++) {
    const r = await h.reconciler.reconcile('retry');
    assert.equal(r.ran, true);
    assert.equal(r.failures.length, 0, `pass ${i} had failures`);
    assert.deepEqual(h.vault.snapshot(), layout, `pass ${i} changed the disk`);
    assert.equal(JSON.stringify(h.state.data), stateAfterFirst, `pass ${i} changed device state`);
  }

  assert.equal(mutations(h.vault), 0, 'exactly zero vault mutations after the first pass');
  assert.equal(
    h.docs.calls.filter((c) => c.op === 'openHeadless').length, opensAfterFirst,
    'and no content doc is reopened',
  );
});

test('42: the same tree changes in fifty shuffled orders converge identically', async () => {
  interface Change { id: string; fields: NodeFields }
  const changes: Change[] = [
    { id: nid('C'), fields: file('', 'todo.md', { s: 1 }) },          // collides with F, wins the plain name
    { id: nid('F'), fields: file('', 'todo.md', { s: 1 }) },          // therefore lands at "todo (2).md"
    { id: nid('D'), fields: dir('', 'Notes') },
    { id: nid('E'), fields: file('Notes', 'a.md', { s: 1 }) },
    { id: nid('G'), fields: file('Notes/deep', 'b.md', { s: 1 }) },
    { id: nid('H'), fields: dead(file('', 'gone.md', { s: 1 })) },
    { id: nid('I'), fields: file('', 'keep.md', { s: 1 }) },
  ];

  // A tiny seeded PRNG: the shuffles must be reproducible when this test fails.
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function run(order: Change[]): Promise<{ disk: string; state: string; tree: string }> {
    const h = makeHarness();
    h.vault.seed(SHARE, 'd');
    for (const c of changes) h.docs.setText(`n_${c.id}`, `body of ${c.id}`);
    for (const c of order) {
      h.nodes.set(c.id, c.fields);
      const r = await h.reconciler.reconcile('remote');
      assert.equal(r.failures.length, 0, `failure while applying ${c.id}`);
    }
    await h.reconciler.reconcile('retry');
    return {
      disk: JSON.stringify(h.vault.snapshot()),
      state: JSON.stringify(h.state.data),
      tree: JSON.stringify(h.vault.list()),
    };
  }

  const baseline = await run(changes);
  assert.deepEqual(JSON.parse(baseline.disk), {
    'Shared/Notes/a.md': `body of ${nid('E')}`,
    'Shared/Notes/deep/b.md': `body of ${nid('G')}`,
    'Shared/keep.md': `body of ${nid('I')}`,
    'Shared/todo (2).md': `body of ${nid('F')}`,
    'Shared/todo.md': `body of ${nid('C')}`,
  });

  for (let seed = 1; seed <= 50; seed++) {
    const next = rng(seed);
    const order = [...changes];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    const got = await run(order);
    assert.equal(got.disk, baseline.disk, `seed ${seed} produced a different disk layout`);
    assert.equal(got.tree, baseline.tree, `seed ${seed} produced a different folder tree`);
    assert.equal(got.state, baseline.state, `seed ${seed} produced different device state`);
  }
});

test('43: every createFolder the pass issues is covered by an armed ticket', async () => {
  const inner = new FakeVault();
  const tickets = new Tickets(() => NOW);
  const claims: Array<{ path: string; claimed: boolean }> = [];
  // Stand in for the watcher: the echo of our own createFolder arrives while the
  // pass is still running, and it must find a ticket waiting for it.
  const watched = wrapVault(inner, {
    createFolder: async (p) => {
      await inner.createFolder(p);
      claims.push({ path: p, claimed: tickets.claim('create', p) });
    },
  });

  const h = makeHarness({ vaultPort: watched, tickets });
  inner.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(nid('B'), dir('', 'Top'));
  h.nodes.set(id, file('Deep/Nested/Tree', 'note.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'body');

  await h.reconciler.reconcile('bootstrap');

  assert.deepEqual(claims.map((c) => c.path), [
    'Shared/Deep', 'Shared/Top', 'Shared/Deep/Nested', 'Shared/Deep/Nested/Tree',
  ], 'every depth is exhausted before the next one (CF-8), intermediates included (CF-2)');
  for (const c of claims) {
    assert.equal(c.claimed, true, `no ticket was armed for ${c.path}`);
  }
  assert.equal(inner.snapshot()['Shared/Deep/Nested/Tree/note.md'], 'body');
  assert.equal(h.tickets.size(), 0, 'the finally block cleared every armed ticket');
});

// ---------------------------------------------------------------- 44: carry-forward CF-1

test('44: a collision-suffixed dead file is not republished', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const low = nid('A');
  const high = nid('B');
  h.nodes.set(low, file('', 'todo.md', { s: 1 }));
  h.nodes.set(high, file('', 'todo.md', { s: 1 }));
  h.docs.setText(`n_${low}`, 'LOW');
  h.docs.setText(`n_${high}`, 'HIGH');

  await h.reconciler.reconcile('sync');
  assert.deepEqual(h.vault.snapshot(), {
    'Shared/todo (2).md': 'HIGH',
    'Shared/todo.md': 'LOW',
  });
  assert.equal(h.state.data.materialized[high], 'Shared/todo (2).md');

  // The high node is tombstoned; its file survives on disk (the user declined the
  // delete, or the deletion pass was interrupted). `deadFold` only knows the PLAIN
  // path `Shared/todo.md`, which a LIVE node still owns — so only the device
  // state's record of where the dead node actually lived can save this file.
  h.nodes.set(high, dead(file('', 'todo.md', { s: 1 })));
  h.published.length = 0;

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(h.published, [[]], 'the suffixed dead path was never offered for publication');
  assert.deepEqual(r.diagnostics.deletedButPresent, ['Shared/todo (2).md']);
  assert.equal(h.vault.snapshot()['Shared/todo (2).md'], 'HIGH', 'and it was not deleted either (I2)');
});

// ---------------------------------------------------------------- refusals and plumbing

test('a missing share root refuses the pass instead of treating it as a mass delete', async () => {
  const h = makeHarness();
  h.nodes.set(nid('A'), file('', 'a.md', { s: 1 }));

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.ran, false);
  assert.match(String(r.refusedReason), /shared folder/i);
  assert.equal(h.reconciler.readOnly, true);
  assert.equal(mutations(h.vault), 0);
});

test('enterReadOnly refuses every later pass', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.reconciler.enterReadOnly('schema is newer than this client');

  const r = await h.reconciler.reconcile('sync');

  assert.equal(r.ran, false);
  assert.equal(r.refusedReason, 'schema is newer than this client');
  assert.equal(h.vault.calls.length, 0, 'refused before the vault was even read');
});

test('a re-entrant call is single-flighted and re-runs the pass once afterwards', async () => {
  const id = nid('A');
  let reentered: { ran: boolean } | null = null;
  let passes = 0;
  const h2 = makeHarness({
    publishUntracked: async () => {
      passes += 1;
      if (passes === 1) {
        assert.equal(h2.reconciler.reconciling, true);
        reentered = await h2.reconciler.reconcile('remote');
      }
    },
  });
  h2.vault.seed(SHARE, 'd');
  h2.nodes.set(id, file('', 'a.md', { s: 1 }));
  h2.docs.setText(`n_${id}`, 'body');

  const r = await h2.reconciler.reconcile('remote');

  assert.equal(r.ran, true);
  assert.equal(reentered!.ran, false, 'the nested call was refused, not run concurrently');
  assert.equal(passes, 2, 'and the dirty flag caused exactly one extra pass');
  assert.equal(h2.reconciler.reconciling, false);
});

test('the deletion collaborator receives the context its slice needs', async () => {
  let seen: DeletionContext | null = null;
  const h = makeHarness({ applyDeletions: async (ctx) => { seen = ctx; } });
  h.vault.seed(SHARE, 'd');
  const liveId = nid('A');
  const deadId = nid('B');
  h.nodes.set(liveId, file('', 'live.md', { s: 1 }));
  h.nodes.set(deadId, dead(file('', 'gone.md', { s: 1 })));
  h.docs.setText(`n_${liveId}`, 'body');

  await h.reconciler.reconcile('remote');

  const ctx = seen as unknown as DeletionContext;
  assert.ok(ctx, 'applyDeletions was called');
  assert.equal(ctx.cause, 'remote');
  assert.ok(ctx.deadNodes.has(deadId));
  assert.equal(ctx.deadNodes.has(liveId), false);
  assert.equal(ctx.deadFold.has(fold('Shared/gone.md')), true);
  assert.equal(ctx.wantAtFold.get(fold('Shared/live.md')), liveId);
  assert.equal(ctx.have.get(liveId), 'Shared/live.md');
  assert.equal(ctx.disk.hasFold('Shared/live.md'), true);
  assert.ok(Array.isArray(ctx.failures));
  assert.ok(ctx.removedThisPass instanceof Set);
});

// ---------------------------------------------------------------- step 4, wired for real
//
// Everything above drives step 4 as a stub. These three run the REAL `Deletions`
// inside a full pass, because the collaborator and the pass have to agree about
// four things that neither one can verify alone: which path a dead node actually
// occupies, that the disk index stays in step, that a failing removal is
// contained rather than fatal, and that nothing removed here is handed straight
// back to the publisher in the same pass (I13).

interface Wired {
  h: Harness;
  deletions: Deletions;
  /** Summaries handed to the injected bulk dialog, in order. */
  confirms: BulkSummary[];
  /** The context step 4 was called with, once it has run. */
  seen: () => DeletionContext;
}

function wireDeletions(answer: BulkChoice = 'apply', over: Partial<ReconcilerDeps> = {}): Wired {
  const confirms: BulkSummary[] = [];
  let deletions: Deletions | null = null;
  let seen: DeletionContext | null = null;

  const h = makeHarness({
    applyDeletions: async (ctx) => {
      seen = ctx;
      await deletions!.apply(ctx);
    },
    ...over,
  });

  deletions = new Deletions({
    vault: h.vault,
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    now: () => NOW,
    notice: (msg) => { h.notices.push(msg); },
    confirmBulk: async (summary) => {
      confirms.push(summary);
      return answer;
    },
  });

  return {
    h,
    deletions,
    confirms,
    seen: () => {
      assert.ok(seen, 'step 4 never ran');
      return seen as unknown as DeletionContext;
    },
  };
}

test('a wired deletion removes the proven file and the pass still finishes its other steps', async () => {
  const w = wireDeletions();
  const { h } = w;
  h.vault.seed(SHARE, 'd');
  const keep = nid('A');
  const folder = nid('B');
  const goner = nid('C');
  h.nodes.set(keep, file('', 'keep.md', { s: 1 }));
  h.nodes.set(folder, dir('', 'Archive'));
  h.nodes.set(goner, file('Archive', 'gone.md', { s: 1 }));
  h.docs.setText(`n_${keep}`, 'still mine');
  h.docs.setText(`n_${goner}`, 'shared bytes');

  await h.reconciler.reconcile('sync');
  assert.deepEqual(inShare(h.vault), {
    'Shared/keep.md': 'still mine',
    'Shared/Archive/gone.md': 'shared bytes',
  });

  // The folder and its only note are tombstoned together, as a cascade delete does.
  h.nodes.set(folder, dead(dir('', 'Archive')));
  h.nodes.set(goner, dead(file('Archive', 'gone.md', { s: 1 })));
  h.published.length = 0;

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.ran, true);
  assert.deepEqual(r.failures, []);
  assert.equal(w.confirms.length, 0, 'one file is nowhere near the budget');

  // Step 4 removed the note...
  assert.deepEqual(inShare(h.vault), { 'Shared/keep.md': 'still mine' });
  assert.equal(h.vault.trashedFor('Shared/Archive/gone.md')[0].data, 'shared bytes', 'I1');
  // ...and step 5, which runs after it, still swept the folder it emptied.
  assert.equal(h.vault.wasTrashed('Shared/Archive'), true, 'the dead folder was swept too');
  assert.deepEqual(r.diagnostics.deletedButPresent, [], 'nothing was left behind');
  assert.deepEqual(h.published, [[]], 'and nothing was offered for publication (I13)');

  assert.deepEqual(h.state.data.materialized, { [keep]: 'Shared/keep.md' }, 'unbound in device state');
  assert.equal(h.state.data.deleteBudget.length, 1, 'one deletion charged to the rate window');
  assert.equal(h.tickets.size(), 0, 'and the pass left no ticket armed');
});

test('a deletion that fails mid-pass is contained and the pass still reaches its finally (I15)', async () => {
  const w = wireDeletions();
  const { h } = w;
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, file('', 'gone.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'shared bytes');
  await h.reconciler.reconcile('sync');

  h.nodes.set(id, dead(file('', 'gone.md', { s: 1 })));
  h.published.length = 0;
  h.vault.failNext('trashLocal', new Error('EPERM: the file is locked'));

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.ran, true, 'the pass completed');
  assert.equal(h.reconciler.reconciling, false, 'the single-flight flag was cleared');
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].key, `delete:${id}`, 'contained to the one item');

  assert.equal(h.vault.snapshot()['Shared/gone.md'], 'shared bytes', 'the file was not destroyed');
  assert.equal(h.state.data.materialized[id], 'Shared/gone.md', 'still bound, so the next pass retries');
  assert.equal(h.state.data.deleteBudget.length, 0, 'nothing was charged for a removal that failed');
  assert.equal(w.seen().removedThisPass.size, 0);

  // Steps 5-7 still ran: the survivor is reported, never handed to the publisher.
  assert.deepEqual(r.diagnostics.deletedButPresent, ['Shared/gone.md']);
  assert.deepEqual(h.published, [[]], 'I13');

  h.vault.resetCalls();
  const retry = await h.reconciler.reconcile('retry');
  assert.deepEqual(retry.failures, []);
  assert.equal(h.vault.callsTo('trashLocal').length, 1, 'and the retry finished the job');
});

test('a collision-suffixed dead node is removed where it actually sits, and step 6 skips it (I13, CF-1)', async () => {
  const w = wireDeletions();
  const { h } = w;
  h.vault.seed(SHARE, 'd');
  const low = nid('A');
  const high = nid('B');
  h.nodes.set(low, file('', 'note.md', { s: 1 }));
  h.nodes.set(high, file('', 'note.md', { s: 1 }));
  h.docs.setText(`n_${low}`, 'from A');
  h.docs.setText(`n_${high}`, 'from B');

  await h.reconciler.reconcile('sync');
  assert.deepEqual(inShare(h.vault), {
    'Shared/note.md': 'from A',
    'Shared/note (2).md': 'from B',
  });

  // The dead node's DERIVED path is `Shared/note.md` — the live node's file. Only
  // `state.materialized` knows it actually lives at the suffixed path, and keying
  // on anything else here removes somebody else's note.
  h.nodes.set(high, dead(file('', 'note.md', { s: 1 })));
  h.published.length = 0;

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(r.failures, []);
  assert.deepEqual(inShare(h.vault), { 'Shared/note.md': 'from A' }, 'the live node is untouched');
  const trashed = h.vault.callsTo('trashLocal');
  assert.equal(trashed.length, 1);
  assert.deepEqual(trashed[0].args, ['Shared/note (2).md'], 'removed at its real path');
  assert.equal(h.vault.wasTrashed('Shared/note.md'), false, 'and never at the derived one');

  assert.deepEqual(
    [...w.seen().removedThisPass], [fold('Shared/note (2).md')],
    'the removed fold reached step 6\'s exclusion list (I13)',
  );
  assert.deepEqual(h.published, [[]], 'so nothing was republished in the pass that deleted it');
  assert.deepEqual(r.diagnostics.deletedButPresent, []);
  assert.deepEqual(h.state.data.materialized, { [low]: 'Shared/note.md' });
});

test('a wired bulk batch is refused wholesale and never re-prompts', async () => {
  const w = wireDeletions('keep');
  const { h } = w;
  h.vault.seed(SHARE, 'd');
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = nid(`D${pad3(i)}`);
    ids.push(id);
    h.nodes.set(id, file('', `f${pad3(i)}.md`, { s: 1 }));
    h.docs.setText(`n_${id}`, `body ${i}`);
  }
  await h.reconciler.reconcile('sync');
  assert.equal(Object.keys(inShare(h.vault)).length, 12);

  for (let i = 0; i < ids.length; i++) h.nodes.set(ids[i], dead(file('', `f${pad3(i)}.md`, { s: 1 })));
  h.vault.resetCalls();
  h.published.length = 0;

  const first = await h.reconciler.reconcile('remote');

  assert.deepEqual(first.failures, []);
  assert.equal(w.confirms.length, 1, 'one dialog for the whole batch');
  assert.equal(w.confirms[0].count, 12);
  assert.equal(mutations(h.vault), 0, 'and NOTHING was applied');
  assert.equal(h.state.data.declinedPaths.length, 12);

  // The declined files stay on disk, and stay out of the publisher's hands — a
  // remote delete the user refused must not come back as twelve new nodes.
  for (let pass = 0; pass < 3; pass++) {
    const later = await h.reconciler.reconcile('retry');
    assert.deepEqual(later.failures, []);
    assert.deepEqual(h.published[h.published.length - 1], [], `pass ${pass} offered nothing`);
  }
  assert.equal(w.confirms.length, 1, 'never prompted again');
  assert.equal(Object.keys(inShare(h.vault)).length, 12, 'every local copy is still there');
});

// ---------------------------------------------------------------- §5.5: awaiting an unshare answer

// The watcher parks a node in `pendingDecision` from the moment the user drags it
// out of the share until they answer "stop sharing?". Spec §5.5: while it sits
// there the reconciler must treat it exactly like an INVALID node — do nothing,
// report it, and above all do not put the file back where the user just took it
// from. These four tests are the only thing standing between an open modal and a
// pass that undoes the user's drag.

test('a node awaiting an unshare decision is never materialized, and converges once answered', async () => {
  const frozen = new Set<string>();
  const h = makeHarness({ pendingDecision: () => frozen });
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, file('', 'note.md', { s: 1 }));   // live, valid, seeded: nothing else stops it
  h.docs.setText(`n_${id}`, 'shared bytes');
  frozen.add(id);

  const first = await h.reconciler.reconcile('sync');

  assert.equal(first.ran, true);
  assert.deepEqual(first.failures, []);
  assert.deepEqual(inShare(h.vault), {}, 'the file the user dragged out is not put back');
  assert.equal(h.vault.callsTo('create').length, 0);
  assert.deepEqual(first.diagnostics.invalid, [id], 'reported exactly like an invalid node');
  assert.deepEqual(first.diagnostics.pending, [], 'and NOT as merely unpublished');
  assert.equal(h.state.data.materialized[id], undefined, 'no binding was invented for it');

  frozen.clear();                                   // the user chose "undo the move"
  const second = await h.reconciler.reconcile('retry');

  assert.deepEqual(second.failures, []);
  assert.deepEqual(second.diagnostics.invalid, []);
  assert.deepEqual(inShare(h.vault), { 'Shared/note.md': 'shared bytes' });
  assert.equal(h.state.data.materialized[id], 'Shared/note.md');
});

test('a node awaiting an unshare decision is not moved to its desired path', async () => {
  const frozen = new Set<string>();
  const h = makeHarness({ pendingDecision: () => frozen });
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, file('', 'note.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'shared bytes');
  await h.reconciler.reconcile('sync');
  assert.equal(h.state.data.materialized[id], 'Shared/note.md');

  // A remote move arrives while the modal is still open.
  h.nodes.set(id, file('Archive', 'renamed.md', { s: 1 }));
  frozen.add(id);
  h.vault.resetCalls();

  const held = await h.reconciler.reconcile('remote');

  assert.equal(held.ran, true);
  assert.deepEqual(held.failures, []);
  assert.equal(h.vault.callsTo('rename').length, 0, 'no relocation while the decision is open');
  assert.equal(h.vault.callsTo('createFolder').length, 0, 'and it implies no folder either');
  assert.deepEqual(inShare(h.vault), { 'Shared/note.md': 'shared bytes' });
  assert.deepEqual(held.diagnostics.invalid, [id]);

  frozen.clear();
  await h.reconciler.reconcile('retry');

  assert.deepEqual(inShare(h.vault), { 'Shared/Archive/renamed.md': 'shared bytes' });
  assert.equal(h.state.data.materialized[id], 'Shared/Archive/renamed.md');
});

test('a tombstone for a node awaiting an unshare decision is not applied', async () => {
  const frozen = new Set<string>();
  const w = wireDeletions('apply', { pendingDecision: () => frozen });
  const { h } = w;
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, file('', 'gone.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'shared bytes');
  await h.reconciler.reconcile('sync');

  // The tombstone lands (a peer deleted it) before the local user answers.
  h.nodes.set(id, dead(file('', 'gone.md', { s: 1 })));
  frozen.add(id);
  h.published.length = 0;

  const held = await h.reconciler.reconcile('remote');

  assert.equal(held.ran, true);
  assert.deepEqual(held.failures, []);
  assert.equal(w.seen().deadNodes.has(id), false, 'step 4 was never even offered it');
  assert.equal(h.vault.wasTrashed('Shared/gone.md'), false, 'nothing was removed');
  assert.deepEqual(inShare(h.vault), { 'Shared/gone.md': 'shared bytes' });
  assert.equal(h.state.data.deleteBudget.length, 0, 'and nothing was charged to the rate window');
  assert.deepEqual(held.diagnostics.invalid, [id]);
  assert.deepEqual(h.published, [[]], 'nor was the frozen file offered for publication');

  frozen.clear();
  const after = await h.reconciler.reconcile('retry');

  assert.deepEqual(after.failures, []);
  assert.equal(h.vault.wasTrashed('Shared/gone.md'), true, 'the tombstone applies once answered');
});

test('an unshared FOLDER and its cascade are frozen together, implying nothing on disk', async () => {
  const frozen = new Set<string>();
  const h = makeHarness({ pendingDecision: () => frozen });
  h.vault.seed(SHARE, 'd');
  const folder = nid('A');
  const child = nid('B');
  const other = nid('C');
  h.nodes.set(folder, dir('', 'Archive'));
  h.nodes.set(child, file('Archive', 'old.md', { s: 1 }));
  h.nodes.set(other, file('', 'keep.md', { s: 1 }));
  h.docs.setText(`n_${child}`, 'archived');
  h.docs.setText(`n_${other}`, 'kept');

  // The whole cascade the watcher computed sits in pendingDecision at once.
  frozen.add(folder);
  frozen.add(child);

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures, []);
  assert.deepEqual(inShare(h.vault), { 'Shared/keep.md': 'kept' }, 'only the untouched node lands');
  assert.equal(h.vault.callsTo('createFolder').length, 0, 'the frozen folder is not re-created');
  assert.deepEqual(r.diagnostics.invalid, [folder, child].sort());
});

// ---------------------------------------------------------------- CF-4: file vs implied folder

// Carry-forward CF-4, closed. `Notes.md` is claimed by a file node AND implied as
// an ancestor folder by another node's `d`. Before the fix `adopt` refused the
// folder as "not a file" and the item landed in `failures` on EVERY pass, for
// ever. The folder wins — it is a container other nodes live inside — and the
// file materializes at a deterministic suffix instead.

test('CF-4: a file colliding with an implied folder is suffixed, not failed for ever', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const clash = nid('A');
  const child = nid('B');
  h.nodes.set(clash, file('', 'Notes.md', { s: 1 }));
  h.nodes.set(child, file('Notes.md', 'child.md', { s: 1 }));
  h.docs.setText(`n_${clash}`, 'i am a file');
  h.docs.setText(`n_${child}`, 'i live in the folder');

  const first = await h.reconciler.reconcile('sync');

  assert.equal(first.ran, true);
  assert.deepEqual(first.failures, [], 'no permanent per-pass failure any more');
  assert.deepEqual(inShare(h.vault), {
    'Shared/Notes (2).md': 'i am a file',
    'Shared/Notes.md/child.md': 'i live in the folder',
  });
  assert.equal(h.state.data.materialized[clash], 'Shared/Notes (2).md');
  assert.equal(h.state.data.materialized[child], 'Shared/Notes.md/child.md');

  // And it settles: no rename ping-pong between the plain and the suffixed name.
  h.vault.resetCalls();
  for (let pass = 0; pass < 5; pass++) {
    const later = await h.reconciler.reconcile('retry');
    assert.deepEqual(later.failures, [], `pass ${pass} failed`);
  }
  assert.equal(mutations(h.vault), 0, 'five further passes touch nothing');
  assert.deepEqual(inShare(h.vault), {
    'Shared/Notes (2).md': 'i am a file',
    'Shared/Notes.md/child.md': 'i live in the folder',
  });
});

// ---------------------------------------------------------------- the founder path

/**
 * `publishUntracked` stands in for `VaultWatcher.onCreate`: it mints a node for
 * every path the pass offered it, records the binding in device state exactly
 * where the watcher's `bind()` does, and leaves the bytes on disk alone.
 *
 * `s: 1` is set at the same moment because the publish queue seeds the content
 * doc and patches `s` before the next pass runs; the point of the fixture is the
 * BINDING, and a node without `s` would never reach `desired` and so could never
 * exercise the mount guard that the missing binding trips.
 */
function publisher(h: Harness): (paths: string[]) => Promise<void> {
  return async (paths) => {
    h.published.push(paths);
    for (const path of paths) {
      const base = path.slice(path.lastIndexOf('/') + 1);
      const id = nid(`P${base[0].toUpperCase()}`);
      h.nodes.set(id, file('', base, { s: 1 }));
      h.docs.setText(`n_${id}`, h.vault.snapshot()[path]);
      h.state.data.materialized[id] = path;             // VaultWatcher.bind
    }
  };
}

test('a first join that publishes its own notes keeps the bindings the pass created', async () => {
  let publish: (paths: string[]) => Promise<void> = async () => undefined;
  const h = makeHarness({ publishUntracked: (paths) => publish(paths) });
  publish = publisher(h);
  const seeded: Record<string, string> = {};
  for (const name of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
    seeded[`${SHARE}/${name}.md`] = `body of ${name}`;
    h.vault.seed(`${SHARE}/${name}.md`, 'f', `body of ${name}`);
  }

  const first = await h.reconciler.reconcile('bootstrap');

  assert.equal(first.ran, true);
  assert.deepEqual(h.published, [Object.keys(seeded).sort()], 'all five were offered');
  assert.deepEqual(
    h.state.data.materialized,
    Object.fromEntries(Object.keys(seeded).sort().map((p, i) => [
      nid(`P${['A', 'B', 'C', 'D', 'E'][i]}`), p,
    ])),
    'the bindings step 6 created survive the pass that created them',
  );

  // The very next pass is the one that used to wedge the client for the session.
  const second = await h.reconciler.reconcile('remote');

  assert.equal(second.ran, true, 'the mount guard must not fire on a client that just published');
  assert.equal(h.reconciler.readOnly, false);
  assert.deepEqual(inShare(h.vault), seeded, 'and nothing was rewritten');
  assert.equal(Object.keys(h.state.data.materialized).length, 5);
});

// ---------------------------------------------------------------- the mount guard as evidence

test('a transient content-doc failure on first join is not evidence of a wrong mount', async () => {
  const h = makeHarness();
  const names = ['one.md', 'two.md', 'three.md'];
  const ids = ['A', 'B', 'C'].map(nid);
  const seeded: Record<string, string> = {};
  for (let i = 0; i < ids.length; i++) {
    h.nodes.set(ids[i], file('', names[i], { s: 1 }));
    h.docs.setText(`n_${ids[i]}`, `body of ${names[i]}`);
    h.docs.setSynced(`n_${ids[i]}`, false);        // the transient condition I4 requires us to tolerate
    seeded[`${SHARE}/${names[i]}`] = `body of ${names[i]}`;
    h.vault.seed(`${SHARE}/${names[i]}`, 'f', `body of ${names[i]}`);
  }

  const first = await h.reconciler.reconcile('bootstrap');

  assert.equal(first.ran, true);
  assert.deepEqual(first.failures.map((f) => f.key), ids.map((id) => `adopt:${id}`));
  for (const f of first.failures) {
    assert.ok(f.err instanceof RetryLater, `${f.key} was not a RetryLater`);
  }
  assert.deepEqual(h.state.data.materialized, {}, 'an unproven fetch binds nothing (I17)');

  // The content provider recovers, exactly as it is expected to.
  for (const id of ids) h.docs.setSynced(`n_${id}`, true);

  const second = await h.reconciler.reconcile('remote');

  assert.equal(second.ran, true, 'a failed fetch is not evidence of a wrong mount (I2)');
  assert.equal(h.reconciler.readOnly, false);
  assert.deepEqual(second.failures, []);
  assert.deepEqual(
    h.state.data.materialized,
    Object.fromEntries(ids.map((id, i) => [id, `${SHARE}/${names[i]}`])),
  );
  assert.deepEqual(inShare(h.vault), seeded, 'the bytes already matched');
  assert.deepEqual(stashed(h.vault), {}, 'so nothing was stashed either');
});

test('a mount mismatch is re-diagnosed, not remembered, and clears when the evidence does', async () => {
  const h = makeHarness();
  for (let i = 0; i < 300; i++) {
    h.state.data.materialized[nid(`N${pad3(i)}`)] = `Work/Team/note-${i}.md`;
  }
  h.vault.seed('Shared/existing.md', 'f', 'still here');
  const wanted = nid('A');
  h.nodes.set(wanted, file('', 'wanted.md', { s: 1 }));
  h.docs.setText(`n_${wanted}`, 'body');

  const refused = await h.reconciler.reconcile('remote');

  assert.equal(refused.ran, false);
  assert.equal(h.reconciler.readOnly, true);
  assert.equal(mutations(h.vault), 0);

  // The watcher binds the file that was sitting there all along: the share root
  // does point at this workspace's folder after all.
  h.state.data.materialized[nid('Z')] = 'Shared/existing.md';

  const healed = await h.reconciler.reconcile('remote');

  assert.equal(healed.ran, true, 'the guard re-reads the evidence rather than replaying a verdict');
  assert.equal(h.reconciler.readOnly, false);
  assert.equal(h.vault.snapshot()['Shared/wanted.md'], 'body');
  assert.equal(h.notices.length, 1, 'and the user was told once, not once per pass');
});

test('clearReadOnly resumes a self-diagnosed pause but an imposed one survives it', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.reconciler.enterReadOnly('This workspace was created by a newer version of ShadowLink.');

  h.reconciler.clearReadOnly();
  assert.equal(h.reconciler.readOnly, false, 'a reconnect may resume a paused reconciler');

  // ...but the guards themselves are re-run, so a pause that is still warranted
  // comes straight back rather than letting the pass mutate the vault.
  h.reconciler.enterReadOnly('imposed');
  const refused = await h.reconciler.reconcile('sync');

  assert.equal(refused.ran, false);
  assert.equal(refused.refusedReason, 'imposed');
  assert.equal(h.reconciler.readOnly, true, 'an imposed pause is never re-diagnosed away');
});

// ---------------------------------------------------------------- the directory a rename empties

// A folder rename converges as one `d`/`n` rewrite per node (spec §4.1):
// `applyMoves` relocates the FILES, and step 1 creates the folder they are moving
// into. Nothing relocates the directory itself, so the old one is left standing —
// and step 5's sweep only ever visited folders whose NODE was dead, which a
// renamed folder's is not. Every peer that did not perform the rename accumulated
// one empty directory per rename, permanently.

test('a remote folder rename removes the directory it emptied', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const folder = nid('A');
  const note = nid('B');
  const deep = nid('C');
  h.nodes.set(folder, dir('', 'X'));
  h.nodes.set(note, file('X', 'a.md', { s: 1 }));
  h.nodes.set(deep, file('X/inner', 'b.md', { s: 1 }));
  h.docs.setText(`n_${note}`, 'a body');
  h.docs.setText(`n_${deep}`, 'b body');

  await h.reconciler.reconcile('bootstrap');
  assert.deepEqual(foldersIn(h.vault), ['Shared/X', 'Shared/X/inner']);

  // The rename arrives from a peer.
  h.nodes.set(folder, dir('', 'Y'));
  h.nodes.set(note, file('Y', 'a.md', { s: 1 }));
  h.nodes.set(deep, file('Y/inner', 'b.md', { s: 1 }));

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.ran, true);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(inShare(h.vault), {
    'Shared/Y/a.md': 'a body',
    'Shared/Y/inner/b.md': 'b body',
  });
  assert.deepEqual(foldersIn(h.vault), ['Shared/Y', 'Shared/Y/inner'], 'no empty Shared/X survives');
  assert.equal(h.vault.wasTrashed('Shared/X'), true, 'and it went to the vault-local .trash (I1)');
  assert.equal(h.vault.wasTrashed('Shared/X/inner'), true, 'deepest first, so the cascade completes');

  // And it is a fixpoint: nothing to sweep, nothing to recreate.
  h.vault.resetCalls();
  const again = await h.reconciler.reconcile('retry');
  assert.equal(again.ran, true);
  assert.equal(mutations(h.vault), 0);
});

test('a directory a rename emptied is kept when a dot path is still inside it', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const folder = nid('A');
  const note = nid('B');
  h.nodes.set(folder, dir('', 'X'));
  h.nodes.set(note, file('X', 'a.md', { s: 1 }));
  h.docs.setText(`n_${note}`, 'a body');

  await h.reconciler.reconcile('bootstrap');
  // Invisible to `vault.list()` and therefore to the DiskIndex; visible to
  // `listDir`, which is exactly why emptiness is decided by the adapter (I2).
  h.vault.seed('Shared/X/.git/config', 'f', 'gitdir');

  h.nodes.set(folder, dir('', 'Y'));
  h.nodes.set(note, file('Y', 'a.md', { s: 1 }));

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.ran, true);
  assert.equal(h.vault.snapshot()['Shared/Y/a.md'], 'a body');
  assert.equal(h.vault.wasTrashed('Shared/X'), false, 'a .git inside vetoes the removal');
  assert.equal(h.vault.snapshot()['Shared/X/.git/config'], 'gitdir');
});

test('a directory a live node still claims is never swept, even after a move out of it', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const folder = nid('A');
  const note = nid('B');
  h.nodes.set(folder, dir('', 'Keep'));
  h.nodes.set(note, file('Keep', 'a.md', { s: 1 }));
  h.docs.setText(`n_${note}`, 'a body');

  await h.reconciler.reconcile('bootstrap');

  // Only the FILE moves out; the folder node is untouched and still wants to exist.
  h.nodes.set(note, file('', 'a.md', { s: 1 }));

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.ran, true);
  assert.deepEqual(inShare(h.vault), { 'Shared/a.md': 'a body' });
  assert.deepEqual(foldersIn(h.vault), ['Shared/Keep'], 'an empty folder the tree wants stays');
  assert.equal(h.vault.wasTrashed('Shared/Keep'), false);
});

test('a renamed folder that never held a file still leaves no directory behind', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const outer = nid('A');
  const inner = nid('B');
  h.nodes.set(outer, dir('', 'X'));
  h.nodes.set(inner, dir('X', 'inner'));

  await h.reconciler.reconcile('bootstrap');
  assert.deepEqual(foldersIn(h.vault), ['Shared/X', 'Shared/X/inner']);

  // No file ever lived in here, so nothing MOVES: the whole rename is two `d`/`n`
  // rewrites and two `createFolder` calls, and the old pair is left standing.
  h.nodes.set(outer, dir('', 'Y'));
  h.nodes.set(inner, dir('Y', 'inner'));

  const r = await h.reconciler.reconcile('remote');

  assert.equal(r.ran, true);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(foldersIn(h.vault), ['Shared/Y', 'Shared/Y/inner']);
  assert.equal(h.vault.wasTrashed('Shared/X'), true);
  assert.equal(h.vault.wasTrashed('Shared/X/inner'), true);
});

test('an empty folder that predates the first pass is never swept', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed('Shared/Ideas', 'd');            // the user's own, from before ShadowLink ran here
  const id = nid('A');
  h.nodes.set(id, file('', 'note.md', { s: 1 }));
  h.docs.setText(`n_${id}`, 'body');

  await h.reconciler.reconcile('bootstrap');
  const later = await h.reconciler.reconcile('remote');

  assert.equal(later.ran, true);
  assert.deepEqual(
    foldersIn(h.vault), ['Shared/Ideas'],
    'no node claims it because step 6 offers only files — a gap in what gets shared, '
    + 'never a licence to remove the user’s directory',
  );
  assert.equal(h.vault.wasTrashed('Shared/Ideas'), false);
  assert.equal(h.vault.snapshot()['Shared/note.md'], 'body');
});

test('a directory that predates the session is still swept once the pass itself empties it', async () => {
  const h = makeHarness();
  // Both the folder and the file were already there when this session started —
  // the tree moved the note while Obsidian was closed.
  h.vault.seed('Shared/X/a.md', 'f', 'a body');
  const id = nid('A');
  h.nodes.set(id, file('Y', 'a.md', { s: 1 }));
  h.state.data.materialized[id] = 'Shared/X/a.md';
  h.docs.setText(`n_${id}`, 'a body');

  const r = await h.reconciler.reconcile('bootstrap');

  assert.equal(r.ran, true);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(inShare(h.vault), { 'Shared/Y/a.md': 'a body' });
  assert.deepEqual(
    foldersIn(h.vault), ['Shared/Y'],
    'the pass watched the last file leave, which outranks "it was here when we started"',
  );
  assert.equal(h.vault.wasTrashed('Shared/X'), true);
});

// ---------------------------------------------------------------- P2 §3.2 / §3.4: step 6

// B31. Both filters run BEFORE the per-candidate `exists` call, and both exist for
// the same reason: a path that can never become a node is pure cost to ask the
// filesystem about, and handing it to `publishUntracked` only routes it into
// `onCreate`, which refuses it again.
test('B31: step 6 skips refused extensions and oversized paths without calling exists', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed('Shared/setup.exe', 'f', 'MZ');            // refused in both kinds (§2.3)
  h.vault.seed('Shared/huge.mov', 'f', 'x'.repeat(64));   // publication already refused it
  h.vault.seed('Shared/diagram.png', 'f', 'PNG');
  h.vault.seed('Shared/notes.md', 'f', 'body');
  h.state.data.oversized[fold('Shared/huge.mov')] = { bytes: 64, cap: 32, why: 'server' };

  const r = await h.reconciler.reconcile('bootstrap');

  assert.equal(r.ran, true);
  assert.deepEqual(
    h.published, [['Shared/diagram.png', 'Shared/notes.md']],
    'an attachment is offered exactly like a note; the other two never are',
  );
  const asked = h.vault.callsTo('exists').map((c) => c.args[0]);
  assert.equal(asked.includes('Shared/setup.exe'), false, 'no existence probe for a refused path');
  assert.equal(asked.includes('Shared/huge.mov'), false, 'nor for one publication refused');
  assert.deepEqual(h.vault.snapshot()['Shared/huge.mov'], 'x'.repeat(64), 'and nothing is touched');
});

// §3.2's self-healing clause: an oversized record is a statement about a file at a
// size, not a permanent poisoning of the path (that is what `declinedPaths` is for,
// and why the two are separate maps — I13).
test('an oversized record is dropped once the file has shrunk, and the path is offered again', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed('Shared/clip.mov', 'f', 'small');
  h.state.data.oversized[fold('Shared/clip.mov')] = { bytes: 4_000, cap: 1_000, why: 'server' };

  const r = await h.reconciler.reconcile('bootstrap');

  assert.equal(r.ran, true);
  assert.deepEqual(h.published, [['Shared/clip.mov']]);
  assert.equal(
    h.state.data.oversized[fold('Shared/clip.mov')], undefined,
    'the record self-heals rather than being re-decided from a stale number',
  );
});

// ---------------------------------------------------------------- P2 §3.2: after a retract

/** A published attachment node. `b` is the reference every peer fetches by. */
function blob(d: string, n: string, ref: string, extra: Partial<NodeFields> = {}): NodeFields {
  return { k: 'b', d, n, g: 1, c: 0, s: 1, b: ref, ...extra };
}

/** The state `PublishQueue.retract` leaves behind: dead, unpublished, unbound. */
function retracted(d: string, n: string): NodeFields {
  return { k: 'b', d, n, g: 1, c: 0, x: 1, xa: NOW - 60_000, xb: 'Ann' };
}

// ⚠ The retract's own promise, checked from the other side. A node that is DEAD
// and still bound to a real file is exactly what step 4 reads as "a tombstone
// arrived for a file I hold" — and, since a retracted node was never published,
// `isProven` refuses it and the verdict is RESCUE: the user's 200 MB video would
// be renamed into ShadowLink Recovered/ and its path permanently declined, for
// the crime of being too large to share. `retract` drops the binding so that this
// cannot happen; this test is what keeps it dropped.
test('a retracted node leaves the file exactly where it is, and no pass rescues it', async () => {
  const w = wireDeletions();
  const { h } = w;
  h.vault.seed(SHARE, 'd');
  h.vault.seedBinary(`${SHARE}/scan.tiff`, new Uint8Array([1, 2, 3, 4]));
  const id = nid('A');
  h.nodes.set(id, retracted('', 'scan.tiff'));
  h.state.data.oversized[fold(`${SHARE}/scan.tiff`)] = { bytes: 4, cap: 2, why: 'server' };

  const r = await h.reconciler.reconcile('sync');

  assert.equal(r.ran, true);
  assert.deepEqual(
    h.vault.binarySnapshot()[`${SHARE}/scan.tiff`], new Uint8Array([1, 2, 3, 4]),
    'not moved, not trashed, not truncated',
  );
  assert.deepEqual(stashed(h.vault), {}, 'and nothing was rescued out of the share');
  assert.equal(h.vault.wasTrashed(`${SHARE}/scan.tiff`), false);
  assert.deepEqual(h.state.data.declinedPaths, [], 'the path is not poisoned (I13)');
  assert.deepEqual(h.published, [[]], 'and it is not offered for publication while it is too large');
});

// B23's last clause. An `oversized` record is a statement about a file AT A SIZE,
// not a permanent verdict about a path — that is what `declinedPaths` is, and why
// the two are separate maps. The tombstone `retract` wrote sits at this very path,
// so the self-heal has to outrank it; it can, because that tombstone was never
// published and never materialized anywhere, so no peer can be acting on it.
test('B23: shrinking a retracted file below the cap shares it again', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/scan.tiff`, 'f', 'tiny');            // the user re-exported it smaller
  const id = nid('A');
  h.nodes.set(id, retracted('', 'scan.tiff'));
  h.state.data.oversized[fold(`${SHARE}/scan.tiff`)] = { bytes: 4_000, cap: 1_000, why: 'server' };

  const r = await h.reconciler.reconcile('sync');

  assert.equal(r.ran, true);
  assert.deepEqual(h.published, [[`${SHARE}/scan.tiff`]], 'offered again, as a fresh node');
  assert.equal(h.state.data.oversized[fold(`${SHARE}/scan.tiff`)], undefined, 'the record healed');
  assert.deepEqual(
    r.diagnostics.deletedButPresent, [],
    'and it is not reported as a file a tombstone is waiting for',
  );
});

// The other half of the same rule: while the file is still too large, the dead
// node it left behind must not turn the path into a publication candidate either.
test('an oversized path is not offered even though a dead node names it', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/scan.tiff`, 'f', 'x'.repeat(9_000));
  h.nodes.set(nid('A'), retracted('', 'scan.tiff'));
  h.state.data.oversized[fold(`${SHARE}/scan.tiff`)] = { bytes: 4_000, cap: 1_000, why: 'server' };

  await h.reconciler.reconcile('sync');

  assert.deepEqual(h.published, [[]]);
  assert.deepEqual(h.state.data.oversized[fold(`${SHARE}/scan.tiff`)], {
    bytes: 4_000, cap: 1_000, why: 'server',
  }, 'a file that GREW keeps its record');
});

// The rebuild reads what was OBSERVED, and an unbinding performed by a
// collaborator while the pass ran is an observation too. `retract` runs inside
// step 7, long after `observeBindings` recorded the binding it is dropping, so a
// rebuild that keyed on the pass's older view would hand the binding straight
// back — and the next pass would rescue the file (see the test above).
test('a binding a collaborator dropped mid-pass is not rebuilt from the older view', async () => {
  const id = nid('A');
  const h = makeHarness({
    publishUntracked: async () => {
      // Exactly what `PublishQueue.retract` does, at exactly the point it does it.
      delete h.state.data.materialized[id];
    },
  });
  h.vault.seed(SHARE, 'd');
  h.vault.seed(`${SHARE}/scan.tiff`, 'f', 'bytes');
  h.nodes.set(id, blob('', 'scan.tiff', `${'a'.repeat(64)}:5:-`));
  h.state.data.materialized[id] = `${SHARE}/scan.tiff`;

  await h.reconciler.reconcile('sync');

  assert.equal(
    h.state.data.materialized[id], undefined,
    'the drop stands: rebuilding it would resurrect a binding a tombstone can act on',
  );
});

// ---------------------------------------------------------------- P2 §3.3: materialize

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

/** Put bytes in the store and return the node fields that name them. */
async function publishedBlob(
  blobs: FakeBlobs,
  d: string,
  n: string,
  bytes: Uint8Array,
): Promise<NodeFields> {
  const sha = await blobs.seed(bytes);
  return blob(d, n, `${sha}:${bytes.length}:-`);
}

// B4. The peer's side of an attachment: fetch, verify, ONE write. A content doc
// is not involved at any point — `openHeadless` on a `'b'` node would open a room
// that will never hold anything, and the timeout it waits out is charged to every
// attachment in the vault.
test('B4: an attachment materializes in one binary write, with no content doc at all', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const bytes = png();
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, 'img', 'diagram.png', bytes));

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(r.failures, []);
  assert.deepEqual(
    h.vault.binarySnapshot()[`${SHARE}/img/diagram.png`], bytes,
    'byte-identical to what the publisher had',
  );
  const writes = h.vault.callsTo('createBinary');
  assert.equal(writes.length, 1, 'exactly one write, never create-then-fill (I6)');
  assert.equal(h.vault.callsTo('create').length, 0, 'and never the string API');
  assert.deepEqual(h.docs.calls, [], 'no content doc was opened for a `b` node');
  assert.equal(h.state.data.materialized[id], `${SHARE}/img/diagram.png`);
  assert.equal(
    h.state.data.contentHash[id]?.sha256, await hashOfBytes(bytes),
    'the base is recorded, so the next pass costs one stat',
  );
  assert.ok(h.state.data.contentHash[id]?.mtime !== undefined, 'with the mtime the write produced');
});

// ⚠ B5. `BlobPort.get` already verifies length and digest, so this is the second
// of two independent checks — and the point of the second is that the first can
// be wrong. Whatever the reason, the answer is the same: nothing is written. A
// zero-byte file at the canonical path is worse than no file, because it looks
// correct and gets deleted by hand.
test('B5: bytes that do not verify are never written, and the pass records one failure', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const bytes = png();
  const fields = await publishedBlob(h.blobs, '', 'diagram.png', bytes);
  const id = nid('A');
  h.nodes.set(id, fields);
  h.blobs.corrupt(fields.b!.slice(0, 64));                   // same length, other bytes

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(inShare(h.vault), {}, 'not a stub, not a partial file, nothing');
  assert.equal(h.vault.callsTo('createBinary').length, 0);
  assert.deepEqual(r.failures.map((f) => f.key), [`materialize:${id}`]);
  assert.equal(h.state.data.materialized[id], undefined, 'and nothing was bound (I17)');
  assert.equal(h.state.data.contentHash[id], undefined);
});

// The point of TWO independent checks is that the first one can be wrong. A port
// whose `get` hands back bytes it did not verify is not a hypothetical: it is one
// refactor of `ObsidianBlobPort`, or one proxy that rewrites a response body, and
// nothing else between the network and the vault would notice.
test('bytes that arrive unverified are refused by the second check, and nothing is written', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const bytes = png();
  const fields = await publishedBlob(h.blobs, '', 'diagram.png', bytes);
  const id = nid('A');
  h.nodes.set(id, fields);
  const other = png(9);                                       // same length, other bytes
  h.reconciler = new Reconciler({
    vault: h.vault,
    docs: h.docs,
    blobs: blobPortOf(h.blobs, { get: async () => other }),   // a port that verified nothing
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    entries: () => [...h.nodes],
    now: () => NOW,
  });

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(inShare(h.vault), {}, 'the wrong bytes never reached the disk');
  assert.equal(h.vault.callsTo('createBinary').length, 0);
  assert.deepEqual(r.failures.map((f) => f.key), [`materialize:${id}`]);
  assert.equal(h.state.data.materialized[id], undefined);
});

// CHANGED IN P2-f. This used to assert that a store which does not hold the
// object produces a `RetryLater` FAILURE. It no longer does, and the reason is
// §6.5: a definite 404 is the one null `get` can answer that is a statement about
// the object rather than about the network, so it is reported through the
// `unavailable` channel instead of being retried as though the bytes were merely
// late. Nothing about the DISK changed — which is the half this test was really
// for, and it is asserted exactly as before. The node is still re-attempted on
// every later pass, which is what the second half below proves.
test('a fetch that could not complete is a no-op, never a delete and never a stub', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const bytes = png();
  const fields = await publishedBlob(h.blobs, '', 'diagram.png', bytes);
  h.nodes.set(nid('A'), fields);
  h.blobs.setAbsent(fields.b!.slice(0, 64));                 // swept, or never finished

  const first = await h.reconciler.reconcile('remote');

  assert.deepEqual(first.failures, [], 'the bytes are gone, not late: retrying is not the fix');
  assert.deepEqual(first.diagnostics.unavailable, [nid('A')], 'and the user is told which file');
  assert.deepEqual(inShare(h.vault), {});

  // And it converges the moment the bytes are there.
  await h.blobs.seed(bytes);
  const second = await h.reconciler.reconcile('retry');

  assert.deepEqual(second.failures, []);
  assert.deepEqual(h.vault.binarySnapshot()[`${SHARE}/diagram.png`], bytes);
});

// ⚠ B24, the fetch arm. The cap is applied BEFORE the request is made: a phone
// that refuses a 200 MB video keeps working, and one that discovers the problem
// while holding it in a buffer does not. Refusing costs nothing anywhere else —
// the node stays live, valid, published and simply unmaterialized here.
test('B24: an attachment over the memory cap is not fetched and not written', async () => {
  const h = makeHarness({ memoryCapBytes: () => 32 });
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'clip.mov', png(3, 512)));
  h.blobs.resetCalls();

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(h.blobs.calls, [], 'not one request was made');
  assert.deepEqual(inShare(h.vault), {});
  assert.deepEqual(r.diagnostics.tooLarge, [id], 'reported, so the user can be told why');
  assert.deepEqual(r.failures, [], 'and it is not an error: this device simply cannot hold it');
});

// ⚠ §7.5: "refused before any request is made, with a diagnostic naming the file,
// its size and the cap". A node id pushed into an array the pass throws away is
// none of those three, and the surfaces that DO ship then say the opposite —
// "synced", and "every attachment in this workspace is already downloaded".
test('§7.5: an attachment refused by the cap on the way IN is described, not just counted',
  async () => {
    const h = makeHarness({ memoryCapBytes: () => 32 });
    h.vault.seed(SHARE, 'd');
    const bytes = png(3, 512);
    const id = nid('A');
    h.nodes.set(id, await publishedBlob(h.blobs, 'clips', 'clip.mov', bytes));

    const r = await h.reconciler.reconcile('remote');

    assert.deepEqual(r.diagnostics.fetchTooLarge, [id]);
    assert.deepEqual(h.reconciler.tooLargeAttachments, [
      { id, path: `${SHARE}/clips/clip.mov`, sha256: await hashOfBytes(bytes), bytes: 512 },
    ], 'named and sized, and remembered OUTSIDE the pass where the status bar can read it');
    assert.deepEqual(
      h.reconciler.deferredAttachments, [],
      'and never offered as a download: the cap outranks an approval, so that button '
      + 'could only fail',
    );
  });

// ⚠ The trap the obvious version of this fix falls into. `tooLarge` has THREE
// writers and only one of them means "the file is not here": `hashWithBudget` and
// `adoptBlob` fire for a file that IS on disk and complete, where only this
// device's question about it is unanswered. Folding them together would report a
// downloaded attachment as missing — the exact error `rehashDeferred` exists as a
// separate channel to avoid.
test('a file this device cannot HASH is never reported as one it does not have', async () => {
  const h = makeHarness({ memoryCapBytes: () => 32 });
  h.vault.seed(SHARE, 'd');
  const mine = png(1, 512);
  const path = `${SHARE}/diagram.png`;
  h.vault.seedBinary(path, mine);
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'diagram.png', png(2, 512)));

  const r = await h.reconciler.reconcile('bootstrap');

  assert.deepEqual(r.diagnostics.tooLarge, [id], 'the device limit is still reported');
  assert.deepEqual(r.diagnostics.fetchTooLarge, [], 'but NOT as a file that is missing');
  assert.deepEqual(h.reconciler.tooLargeAttachments, []);
  assert.deepEqual(h.vault.binarySnapshot()[path], mine, 'because the file is right there');
});

// §6.5. The third state, and the only one nothing on this device can lift. It
// still has to reach a surface: "bounded" is worth something only if the user is
// told, and a Download button for it would be a button that can only fail.
test('§6.5: an attachment the store no longer holds is described, not offered', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const bytes = png(4, 128);
  const id = nid('A');
  const fields = await publishedBlob(h.blobs, '', 'old.zip', bytes);
  h.nodes.set(id, fields);
  h.blobs.setAbsent(fields.b!.slice(0, 64));

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(r.diagnostics.unavailable, [id]);
  assert.deepEqual(h.reconciler.unavailableAttachments, [
    { id, path: `${SHARE}/old.zip`, sha256: await hashOfBytes(bytes), bytes: 128 },
  ]);
  assert.deepEqual(h.reconciler.deferredAttachments, []);
});

// All three lists are re-derived from scratch every pass, exactly as `lastDeferred`
// is: a status bar counting files that stopped being outstanding last week is worse
// than no status bar.
test('the oversized and unavailable lists clear the moment they stop being true', async () => {
  const h = makeHarness({ memoryCapBytes: () => 32 });
  h.vault.seed(SHARE, 'd');
  const bytes = png(3, 512);
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'clip.mov', bytes));

  await h.reconciler.reconcile('remote');
  assert.equal(h.reconciler.tooLargeAttachments.length, 1);

  // A bigger device, or the same one after the file shrank.
  h.reconciler = new Reconciler({
    vault: h.vault,
    docs: h.docs,
    blobs: h.blobs,
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    entries: () => [...h.nodes],
    now: () => NOW,
  });
  const second = await h.reconciler.reconcile('retry');

  assert.deepEqual(second.diagnostics.fetchTooLarge, []);
  assert.deepEqual(h.reconciler.tooLargeAttachments, []);
  assert.deepEqual(h.vault.binarySnapshot()[`${SHARE}/clip.mov`], bytes);
});

// Both tickets, before the write. Without the `create` ticket the watcher reads
// our own write as a user action; without the `modify` one, so does the modify
// handler P2-d registers — and a `'b'` node's modify handler resolves the node
// and requeues a publish, so the echo becomes an upload of what we just fetched.
test('materializing an attachment arms a create AND a modify ticket before writing', async () => {
  const tickets = new RecordingTickets(() => NOW);
  const h = makeHarness({ tickets });
  h.vault.seed(SHARE, 'd');
  h.nodes.set(nid('A'), await publishedBlob(h.blobs, '', 'diagram.png', png()));

  await h.reconciler.reconcile('remote');

  const path = `${SHARE}/diagram.png`;
  const write = h.vault.calls.findIndex((c) => c.op === 'createBinary');
  assert.ok(write >= 0, 'the file was written');
  assert.deepEqual(
    tickets.armed.filter((a) => a.endsWith(path)),
    [`create ${path}`, `modify ${path}`],
    'both armed, and both before the write',
  );
});

// Ordering, stated as a property rather than as a call count: nothing touches the
// disk until the bytes are in hand and have been checked (§3.3, I6).
test('the fetch and the verify both precede the write', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  h.nodes.set(nid('A'), await publishedBlob(h.blobs, 'img', 'diagram.png', png()));

  await h.reconciler.reconcile('remote');

  const fetched = h.blobs.calls.findIndex((c) => c.op === 'get');
  assert.ok(fetched >= 0);
  const mutations = h.vault.calls
    .map((c, i) => ({ op: c.op, i }))
    .filter((c) => c.op === 'createBinary' || c.op === 'createFolder');
  assert.equal(mutations.length, 2, 'one folder, one file');
  // The store call log and the vault call log are separate, so ordering is
  // asserted through the only thing they share: the fetch had to have finished,
  // because the bytes it returned are what was written.
  assert.deepEqual(h.vault.callsTo('createBinary')[0].args[0], `${SHARE}/img/diagram.png`);
  assert.equal(h.blobs.callsTo('get').length, 1, 'and the fetch happened exactly once');
});

// ---------------------------------------------------------------- P2 §3.4: adopt

// Every call the string-only path would make, for the two tests below. `adopt`
// runs BEFORE materialize whenever a local file already sits at a node's path —
// on every cold start, on every second device, and for every entry in Bootstrap's
// adopt bucket — so an attachment reaching the markdown arm is not an edge case.
function stringCalls(vault: FakeVault, path: string): string[] {
  return vault.calls
    .filter((c) => (c.op === 'read' || c.op === 'create') && c.args[0] === path)
    .map((c) => c.op);
}

// B6, the converged half: the file the user already has IS the file the workspace
// names. Binding is the whole job — writing anything would be a way to get it
// wrong.
test('B6: a local attachment whose bytes match the tree is bound, and nothing is written', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const bytes = png();
  const path = `${SHARE}/diagram.png`;
  h.vault.seedBinary(path, bytes);
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'diagram.png', bytes));
  h.blobs.resetCalls();

  const r = await h.reconciler.reconcile('bootstrap');

  assert.deepEqual(r.failures, []);
  assert.equal(h.state.data.materialized[id], path, 'bound to the file that was already there');
  assert.equal(h.state.data.contentHash[id]?.sha256, await hashOfBytes(bytes));
  assert.ok(h.state.data.contentHash[id]?.mtime !== undefined, 'with the mtime it has on disk');
  assert.deepEqual(h.vault.binarySnapshot()[path], bytes, 'the file is untouched');
  assert.equal(mutations(h.vault), 0, 'not one create, rename or trash');
  assert.deepEqual(stringCalls(h.vault, path), [], 'and it was never read as text');
  assert.deepEqual(h.docs.calls, [], 'nor opened as a content doc');
  assert.deepEqual(h.blobs.calls, [], 'and nothing was fetched: the bytes are already here');
});

// ⚠ B6, and the worst outcome available in P2. Unbranched, `adopt` reads a PNG
// through `cachedRead`, compares the mojibake to a content doc that is empty,
// concludes they differ, renames the user's real attachment into
// `ShadowLink Recovered/` and writes `vault.create(path, '')` — a ZERO-BYTE FILE
// at the canonical path. On every cold start. On every second device. For every
// entry in Bootstrap's adopt bucket.
//
// The assertions below are behavioural on purpose: a source grep for `vault.read`
// proves nothing about which branch a `'b'` node actually takes.
test('B6: a local attachment that differs is never read as text, never exiled, never zeroed', async () => {
  const h = makeHarness({ displayName: 'Ann' });
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2);
  const path = `${SHARE}/diagram.png`;
  h.vault.seedBinary(path, mine);
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'diagram.png', theirs));

  const r = await h.reconciler.reconcile('bootstrap');

  // P2-c recorded the divergence and left both files alone, because the policy
  // that decides between them was this slice. It has landed: unknown ancestry is
  // rule 4, and rule 4 keeps BOTH versions as visible files (§4.1, §4.3). The
  // half of this test that has not changed is the one about HOW: never as text,
  // never exiled outside the share, never a zero-byte file.
  const fork = `${SHARE}/${forkName('diagram.png', await hashOfBytes(mine), 'Ann')}`;
  assert.deepEqual(
    h.vault.binarySnapshot()[fork], mine,
    'the user’s bytes survive in full, under a name of their own',
  );
  assert.deepEqual(h.vault.binarySnapshot()[path], theirs, 'and the workspace version is at the path');
  assert.deepEqual(stashed(h.vault), {}, 'nothing was exiled to ShadowLink Recovered/');
  assert.equal(h.vault.wasTrashed(path), false, 'and nothing was trashed');
  assert.deepEqual(stringCalls(h.vault, path), [], 'no lossy decode, and no empty create');
  assert.deepEqual(h.docs.calls, [], 'no content doc for a `b` node, ever');
  for (const [p, data] of Object.entries(h.vault.binarySnapshot())) {
    assert.notEqual(data.length, 0, `${p} is not a zero-byte file`);
  }
  assert.deepEqual(r.failures, []);
  assert.equal(h.state.data.materialized[id], path, 'the node is bound to the file it names');

  // Idempotent: the second pass is converged and forks nothing further.
  const before = h.vault.binarySnapshot();
  const second = await h.reconciler.reconcile('retry');
  assert.deepEqual(h.vault.binarySnapshot(), before, 'the pass is repeatable and inert');
  assert.deepEqual(second.failures, []);
});

// ⚠ B24, the adopt arm. The hash needs the whole file in memory, so the cap has
// to be applied before the read — and a file this device cannot hash is a file it
// cannot make a decision about, so it does not make one: no binding, no fork, no
// verdict of any kind.
test('B24: a local attachment over the memory cap is not hashed and not bound', async () => {
  const h = makeHarness({ memoryCapBytes: () => 32 });
  h.vault.seed(SHARE, 'd');
  const bytes = png(4, 512);
  h.vault.seedBinary(`${SHARE}/clip.mov`, bytes);
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'clip.mov', bytes));

  const r = await h.reconciler.reconcile('bootstrap');

  assert.equal(h.vault.callsTo('readBinary').length, 0, 'never held in memory');
  assert.deepEqual(r.diagnostics.tooLarge, [id]);
  assert.equal(h.state.data.materialized[id], undefined, 'no binding from a decision never made');
  assert.deepEqual(h.vault.binarySnapshot()[`${SHARE}/clip.mov`], bytes);
});

// I7. The user has the image open; a second writer under a live view is exactly
// what the invariant exists to prevent. Deferring costs one pass.
test('an attachment open in a leaf is not adopted, and not read', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const bytes = png();
  h.vault.seedBinary(`${SHARE}/diagram.png`, bytes);
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'diagram.png', bytes));
  h.vault.setOpen(`${SHARE}/diagram.png`, true);

  const r = await h.reconciler.reconcile('bootstrap');

  assert.deepEqual(r.failures, []);
  assert.equal(h.vault.callsTo('readBinary').length, 0);
  assert.equal(h.state.data.materialized[id], undefined, 'deferred to the next pass');

  // `bootstrap` again only because this vault holds exactly one file: a pass with
  // nothing bound at all is what the mount guard is for, and that guard is not
  // what this test is about.
  h.vault.setOpen(`${SHARE}/diagram.png`, false);
  await h.reconciler.reconcile('bootstrap');
  assert.equal(h.state.data.materialized[id], `${SHARE}/diagram.png`, 'and adopted once closed');
});

// I2. "I could not look" is not an answer. A `stat` that rejects must not become
// a fork, a rescue, or a fetch that overwrites what is there.
test('a stat that could not answer adopts nothing and touches nothing', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const bytes = png();
  h.vault.seedBinary(`${SHARE}/diagram.png`, bytes);
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'diagram.png', bytes));
  h.vault.failNext('stat', new Error('EIO: the volume is unreadable'));

  const r = await h.reconciler.reconcile('bootstrap');

  assert.deepEqual(r.failures.map((f) => f.key), [`adopt:${id}`]);
  assert.equal(mutations(h.vault), 0);
  assert.deepEqual(h.vault.binarySnapshot()[`${SHARE}/diagram.png`], bytes);
  assert.equal(h.state.data.materialized[id], undefined);
});

// ---------------------------------------------------------------- the round trip

// The slice's whole point, in one test: a file dropped into the share on A is on
// B, byte for byte, with the store as the only thing between them — and B never
// holds an empty file at any instant, which is the failure this design keeps
// choosing shapes to avoid (I6).
//
// Both engines share one tree (a `Y.Doc` is what a real workspace shares) and one
// store; everything else — vault, device state, tickets — is per device.
test('an attachment round-trips: published on A, materialized byte-identically on B', async () => {
  const store = new FakeBlobs();
  const tree = new TreeDoc();
  const bytes = png(7, 128);

  // ---- device A: the user drops an image into the shared folder.
  const vaultA = new FakeVault();
  vaultA.seed(SHARE, 'd');
  vaultA.seed(`${SHARE}/img`, 'd');
  vaultA.seedBinary(`${SHARE}/img/diagram.png`, bytes);
  const stateA = new DeviceState(new MemoryStatePort(), 'device-A', 'ws-1', () => NOW, 0);
  const idA = tree.createNode({ k: 'b', d: 'img', n: 'diagram.png' }, NOW);
  stateA.data.owned[idA] = true;
  stateA.data.materialized[idA] = `${SHARE}/img/diagram.png`;

  const queue = new PublishQueue({
    docs: new FakeDocs(),
    vault: vaultA,
    blobs: store,
    state: stateA,
    tree,
    openNodeId: () => null,
    now: () => NOW,
    settleMs: 0,
  });
  queue.enqueue(idA);
  await queue.drain();

  const sha = await hashOfBytes(bytes);
  assert.equal(tree.get(idA)!.b, `${sha}:${bytes.length}:-`, 'A published the reference');
  assert.deepEqual(store.stored(sha), bytes);

  // ---- device B: has never seen this file.
  const vaultB = new FakeVault();
  vaultB.seed(SHARE, 'd');
  const stateB = new DeviceState(new MemoryStatePort(), 'device-B', 'ws-1', () => NOW, 0);
  const reconcilerB = new Reconciler({
    vault: vaultB,
    docs: new FakeDocs(),
    blobs: store,
    state: stateB,
    tickets: new Tickets(() => NOW),
    shareRoot: SHARE,
    entries: () => tree.entries(),
    now: () => NOW,
  });

  const r = await reconcilerB.reconcile('bootstrap');

  assert.deepEqual(r.failures, []);
  assert.deepEqual(
    vaultB.binarySnapshot()[`${SHARE}/img/diagram.png`], bytes,
    'byte-identical on the other side of the store',
  );
  // "Never an empty file at any point" is asserted over the CALL LOG, not over the
  // end state: a stub that was written and then filled in would leave no trace in
  // a snapshot taken afterwards.
  for (const call of vaultB.calls) {
    if (call.op === 'create') assert.fail(`B wrote a note-shaped file: ${String(call.args[0])}`);
    if (call.op === 'createBinary') {
      assert.equal((call.args[1] as Uint8Array).length, bytes.length, 'one full write, no stub');
    }
  }
  assert.equal(stateB.data.contentHash[idA]?.sha256, sha, 'and B recorded what it confirmed');

  // A second pass on B changes nothing and fetches nothing: converged.
  store.resetCalls();
  vaultB.resetCalls();
  await reconcilerB.reconcile('sync');
  assert.deepEqual(store.calls, [], 'no re-fetch');
  assert.equal(mutations(vaultB), 0, 'and no second write');
});

// ---------------------------------------------------------------- P2 §3.5: step 2.5

/** One `requeue` the pass asked for: which node, and for which bytes. */
interface Requeued {
  id: string;
  intent: string;
}

/**
 * A bound, published attachment: the file on disk, the node in the tree, and the
 * device-state binding a device that materialized it would hold.
 *
 * `base` is what makes this a step-2.5 fixture rather than an adopt fixture. A
 * device that has confirmed its copy records one; a device whose post-write
 * `stat` threw has none, and must re-hash rather than assume (§3.5).
 */
async function bindBlob(
  h: Harness,
  id: string,
  rel: string,
  onDisk: Uint8Array,
  ref: { sha256: string; bytes: number; parent: string | null },
  /** `mtimeShift` moves the recorded mtime off the file's real one, as an external edit does. */
  base?: { sha256: string; len: number; mtimeShift?: number },
): Promise<string> {
  const path = `${SHARE}/${rel}`;
  const cut = rel.lastIndexOf('/');
  const d = cut === -1 ? '' : rel.slice(0, cut);
  const n = rel.slice(cut + 1);
  h.vault.seedBinary(path, onDisk);
  h.nodes.set(id, blob(d, n, `${ref.sha256}:${ref.bytes}:${ref.parent ?? '-'}`));
  h.state.data.materialized[id] = path;
  if (base !== undefined) {
    h.state.data.contentHash[id] = {
      sha256: base.sha256,
      len: base.len,
      mtime: (await mtimeOf(h.vault, path)) + (base.mtimeShift ?? 0),
    };
  }
  return path;
}

/** The mtime the fake reports for a path, without leaving a `stat` in the call log. */
async function mtimeOf(vault: FakeVault, path: string): Promise<number> {
  const before = vault.calls.length;
  const st = await vault.stat(path);
  vault.calls.length = before;
  return st!.mtime;
}

// B27. The whole affordability claim of the design, as a number: a pass over a
// converged share asks the filesystem one question per attachment and nothing
// else. No re-hash, no read, and not one call to the store — `b` is in the tree,
// which is already synced, so "is my copy current?" is decided locally.
test('B27: a pass over 200 converged attachments costs 200 stats and nothing else', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  for (let i = 0; i < 200; i++) {
    const bytes = png(i + 1);
    const sha = await h.blobs.seed(bytes);
    await bindBlob(h, nid(`N${pad3(i)}`), `img/f${pad3(i)}.png`, bytes, {
      sha256: sha, bytes: bytes.length, parent: null,
    });
  }

  // The first pass records every base; the second is the steady state.
  await h.reconciler.reconcile('sync');
  h.vault.resetCalls();
  h.blobs.resetCalls();
  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures, []);
  assert.equal(h.vault.callsTo('stat').length, 200, 'one stat per attachment, and no more');
  assert.equal(h.vault.callsTo('readBinary').length, 0, 'nothing was re-hashed');
  assert.deepEqual(h.blobs.calls, [], 'and the store was not asked anything at all');
  assert.equal(mutations(h.vault), 0);
});

// ⚠ B28. The cold-start sweep is budgeted, so a 3 GB share amortizes its first
// full hash over several passes instead of freezing one — and a node the budget
// deferred is NEVER reported as converged, which is the difference between "not
// yet" and a wrong answer.
test('B28: a cold start hashes at most the budget per pass and converges over several', async () => {
  const h = makeHarness({ rehashBudgetBytes: () => 200 });      // three 64-byte files a pass
  h.vault.seed(SHARE, 'd');
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const bytes = png(i + 1);
    const sha = await h.blobs.seed(bytes);
    const id = nid(`N${pad3(i)}`);
    ids.push(id);
    // No base at all: the state file predates the hash, or a post-write `stat`
    // never answered. Either way the bytes have to be hashed.
    await bindBlob(h, id, `f${pad3(i)}.png`, bytes, { sha256: sha, bytes: bytes.length, parent: null });
  }

  let passes = 0;
  for (let i = 0; i < 10; i++) {
    h.vault.resetCalls();
    const r = await h.reconciler.reconcile('sync');
    passes += 1;
    const hashed = h.vault.callsTo('readBinary').length;
    assert.ok(hashed <= 4, `pass ${i} hashed ${hashed} files, over the budget`);
    // Whatever the budget deferred is absent from `contentHash` — never recorded
    // as confirmed on the strength of not having looked.
    for (const id of ids) {
      const recorded = h.state.data.contentHash[id];
      if (recorded === undefined) continue;
      assert.equal(
        recorded.sha256, h.nodes.get(id)!.b!.slice(0, 64),
        `${id} recorded a hash it never computed`,
      );
    }
    if (ids.every((id) => h.state.data.contentHash[id] !== undefined)) break;
    assert.ok(r.diagnostics.rehashDeferred.length > 0, 'the deferral is reported, not silent');
  }

  assert.ok(passes > 2, `the budget was not applied at all (converged in ${passes} passes)`);
  for (const id of ids) assert.ok(h.state.data.contentHash[id] !== undefined, `${id} never converged`);
  assert.equal(mutations(h.vault), 0, 'and hashing never wrote anything');
});

// ---------------------------------------------------------------- P2 §7.2: fetch policy

/** A reconciler over the SAME vault, store, state and tree: a restarted session. */
function freshSession(h: Harness, over: Partial<ReconcilerDeps> = {}): Reconciler {
  return new Reconciler({
    vault: h.vault,
    docs: h.docs,
    blobs: h.blobs,
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    entries: () => [...h.nodes],
    publishUntracked: async (paths) => { h.published.push(paths); },
    notice: (m) => { h.notices.push(m); },
    now: () => NOW,
    ...over,
  });
}

/** Let a zero-delay `schedulePersist` timer fire, so write counts are settled. */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 5); });
}

// B25, the persisted half. Over the auto-fetch ceiling the node is DEFERRED: the
// decision is taken before a request is made, the record survives a restart so
// the download button knows the file exists and how big it is, and — §7.3, I6
// applied literally — nothing whatsoever lands on disk. A 0-byte `poster.png` at
// the canonical path looks correct, so the user deletes it, and a local delete is
// a tombstone that propagates to everyone.
test('B25: an attachment over the auto-fetch ceiling is deferred, and nothing lands on disk', async () => {
  const h = makeHarness({ autofetchMaxBytes: () => 100 });
  h.vault.seed(SHARE, 'd');
  const bytes = png(3, 512);
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'poster.png', bytes));
  h.blobs.resetCalls();

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(h.blobs.calls, [], 'the decision is taken BEFORE any request');
  assert.deepEqual(inShare(h.vault), {}, 'no file, no placeholder, no stub, no sidecar');
  assert.deepEqual(r.diagnostics.deferred, [id]);
  assert.deepEqual(r.diagnostics.tooLarge, [], 'policy, not a device limit: a separate channel');
  assert.deepEqual(r.failures, [], 'and not an error — this is a decision, not a fault');
  assert.deepEqual(
    h.state.data.fetchDeferred[id],
    { sha256: await hashOfBytes(bytes), bytes: bytes.length },
    'persisted, so the UI can offer it without a pass having to be running',
  );
});

// B25, the NOT-persisted half. A session budget is a statement about this
// afternoon on this connection, never about the share — writing it down would
// make a tethered morning permanent.
test('B25: a session-budget refusal is not persisted, and the next session fetches it', async () => {
  const limits = { autofetchMaxBytes: () => 10_000, sessionBudgetBytes: () => 600 };
  const h = makeHarness(limits);
  h.vault.seed(SHARE, 'd');
  const a = png(1, 512);
  const b = png(2, 512);
  h.nodes.set(nid('A'), await publishedBlob(h.blobs, '', 'a.png', a));
  h.nodes.set(nid('B'), await publishedBlob(h.blobs, '', 'b.png', b));

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(h.vault.binarySnapshot()[`${SHARE}/a.png`], a, 'the budget bought one');
  assert.equal(h.vault.binarySnapshot()[`${SHARE}/b.png`], undefined, 'and stopped');
  assert.deepEqual(r.diagnostics.deferred, [nid('B')]);
  assert.deepEqual(h.state.data.fetchDeferred, {}, 'nothing about this session is written down');

  // A restart is what clears it. The budget resets to zero, and the pass picks up
  // exactly where the last one stopped.
  const next = freshSession(h, limits);
  const second = await next.reconcile('sync');

  assert.deepEqual(second.diagnostics.deferred, []);
  assert.deepEqual(h.vault.binarySnapshot()[`${SHARE}/b.png`], b);
});

// B25, the approval half. The commands and the download button do exactly this:
// set `fetchApproved[id]`, then run the pass.
test('B25: approving a deferred attachment is what fetches it, and drops its record', async () => {
  const h = makeHarness({ autofetchMaxBytes: () => 100 });
  h.vault.seed(SHARE, 'd');
  const bytes = png(3, 512);
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'poster.png', bytes));

  await h.reconciler.reconcile('remote');
  assert.notEqual(h.state.data.fetchDeferred[id], undefined, 'deferred first');

  h.state.data.fetchApproved[id] = true;
  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(h.vault.binarySnapshot()[`${SHARE}/poster.png`], bytes);
  assert.deepEqual(r.diagnostics.deferred, []);
  assert.equal(
    h.state.data.fetchDeferred[id], undefined,
    'a record for a file that is now on disk is a lie the UI would repeat',
  );
});

// ⚠ B25, the ordering clause. A budget cutoff has to be a decision, not an
// accident of 22 random nodeId characters: ascending byte order makes the same
// share converge to the same set on every device, and maximizes the FILE COUNT
// that fits in a given allowance.
test('B25: materialize iterates blob nodes in ascending byte order', async () => {
  // nodeId order is A, B, C. Byte order is B(100) < C(200) < A(300), and the
  // budget stops after 300 bytes — so nodeId order would buy ONE file and byte
  // order buys TWO.
  const h = makeHarness({ autofetchMaxBytes: () => 10_000, sessionBudgetBytes: () => 350 });
  h.vault.seed(SHARE, 'd');
  h.nodes.set(nid('A'), await publishedBlob(h.blobs, '', 'big.png', png(1, 300)));
  h.nodes.set(nid('B'), await publishedBlob(h.blobs, '', 'small.png', png(2, 100)));
  h.nodes.set(nid('C'), await publishedBlob(h.blobs, '', 'mid.png', png(3, 200)));
  h.blobs.resetCalls();

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(
    h.blobs.callsTo('get').map((c) => c.args[1]), [100, 200],
    'smallest first, and the cutoff falls where the budget runs out',
  );
  assert.deepEqual(r.diagnostics.deferred, [nid('A')], 'the one that did not fit');
  assert.deepEqual(Object.keys(inShare(h.vault)).sort(), [`${SHARE}/mid.png`, `${SHARE}/small.png`]);
});

// ⚠ The charge is taken on a COMPLETED fetch. Charging on the attempt means a
// flaky link burns the whole session allowance retrying one file, and the user
// sees an afternoon of "not downloaded" for a connection that was merely bad.
test('the session budget is charged on a completed fetch, never on an attempt', async () => {
  const h = makeHarness({ autofetchMaxBytes: () => 10_000, sessionBudgetBytes: () => 512 });
  h.vault.seed(SHARE, 'd');
  const bytes = png(1, 512);                       // exactly the whole session budget
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'a.png', bytes));
  h.blobs.failNext('get', new Error('socket hang up'));

  const first = await h.reconciler.reconcile('remote');
  assert.equal(first.failures.length, 1, 'the attempt failed');
  assert.equal(h.vault.binarySnapshot()[`${SHARE}/a.png`], undefined, 'and wrote nothing');

  const second = await h.reconciler.reconcile('retry');

  assert.deepEqual(second.diagnostics.deferred, [], 'the failed attempt cost nothing');
  assert.deepEqual(h.vault.binarySnapshot()[`${SHARE}/a.png`], bytes);
});

// ⚠ B29. `DeviceState.flush()` serializes the WHOLE state object, so an
// unconditional per-pass write of ~1,100 deferral records is a multi-megabyte
// write every couple of seconds — on a phone, on battery. The record is written
// only when its value actually changes, and a pass that decided nothing new
// writes nothing at all.
test('B29: fetchDeferred does not grow across passes, and a converged pass writes no state', async () => {
  const h = makeHarness({ autofetchMaxBytes: () => 100 });
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'poster.png', png(3, 512)));

  await h.reconciler.reconcile('bootstrap');
  await settle();
  const writesAfterFirstPass = h.port.writes.length;
  const recorded = JSON.stringify(h.state.data.fetchDeferred);

  // The write site itself, not just its effect on the disk. `flushIfChanged`
  // would swallow an unconditional re-write of an identical record, so without
  // this counter the rule "write only when the value changes" is untestable and
  // the next refactor drops it for free.
  let scheduled = 0;
  const realSchedule = h.state.schedulePersist.bind(h.state);
  h.state.schedulePersist = (): void => { scheduled += 1; realSchedule(); };

  for (let i = 0; i < 5; i++) {
    await h.reconciler.reconcile('sync');
    await settle();
  }

  assert.deepEqual(Object.keys(h.state.data.fetchDeferred), [id], 'one record, not six');
  assert.equal(JSON.stringify(h.state.data.fetchDeferred), recorded, 'and it never changed');
  assert.equal(scheduled, 0, 'an unchanged deferral is not re-written on every pass');
  assert.equal(
    h.port.writes.length, writesAfterFirstPass,
    'five passes that decided nothing new wrote nothing at all',
  );
});

// The other end of the same rule: a record whose node stopped being deferred is
// DROPPED. A map that only ever grows is a status bar that counts files the user
// downloaded last week.
test('a fetchDeferred record for a node the tree no longer has is dropped', async () => {
  const h = makeHarness({ autofetchMaxBytes: () => 100 });
  h.vault.seed(SHARE, 'd');
  h.state.data.fetchDeferred[nid('Z')] = { sha256: 'b'.repeat(64), bytes: 9_000 };

  await h.reconciler.reconcile('sync');

  assert.deepEqual(h.state.data.fetchDeferred, {});
});

// ---------------------------------------------------------------- P2 §7.3: deferred is NOTHING

// ⚠ B26. A deferred node is not a node that stepped out of the tree: it is
// published, so it RESERVES ITS PATH, and the next attachment with the same name
// gets the collision suffix exactly as it would have if the bytes were here.
// Without that, the moment a device defers a fetch it starts handing that path to
// somebody else — and the two peers disagree about which file lives where.
test('B26: a deferred attachment still reserves its path', async () => {
  const h = makeHarness({ autofetchMaxBytes: () => 100 });
  h.vault.seed(SHARE, 'd');
  const deferredId = nid('A');
  const fetchedId = nid('B');
  h.nodes.set(deferredId, await publishedBlob(h.blobs, '', 'diagram.png', png(1, 512)));
  h.nodes.set(fetchedId, await publishedBlob(h.blobs, '', 'diagram.png', png(2, 50)));

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(r.diagnostics.deferred, [deferredId]);
  assert.deepEqual(
    Object.keys(inShare(h.vault)), [`${SHARE}/diagram (2).png`],
    'the deferred node holds "diagram.png" — and holds it EMPTY, which is the point',
  );
  assert.equal(h.state.data.materialized[fetchedId], `${SHARE}/diagram (2).png`);
  assert.equal(h.state.data.materialized[deferredId], undefined);

  // A second pass, because that is the first one that runs with the deferral
  // already written down: a reconciler that read `fetchDeferred` as "this node is
  // no longer my business" would hand `diagram.png` over here.
  const second = await h.reconciler.reconcile('sync');

  assert.deepEqual(second.diagnostics.deferred, [deferredId]);
  assert.deepEqual(Object.keys(inShare(h.vault)), [`${SHARE}/diagram (2).png`]);
});

// ⚠ B26, the structural half. `deferred` is not `pending`: a pending node is one
// NOBODY may materialize, so it reserves nothing at all, while a deferred node is
// fully published and this device merely chose not to fetch it. Folding the two
// channels together would be a statement that the two states are the same, and
// they differ on exactly the question that matters — who owns that path.
test('B26: a deferred node is a full structural participant, never a deletion candidate', async () => {
  let seen: DeletionContext | null = null;
  const h = makeHarness({
    autofetchMaxBytes: () => 100,
    applyDeletions: async (ctx) => { seen = ctx; },
  });
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, 'img', 'big.png', png(1, 512)));

  const r = await h.reconciler.reconcile('remote');
  const ctx = seen as unknown as DeletionContext;

  assert.deepEqual(r.diagnostics.deferred, [id]);
  assert.deepEqual(r.diagnostics.pending, [], 'published: nothing here is waiting on an author');
  assert.deepEqual(r.diagnostics.invalid, []);
  assert.equal(ctx.deadNodes.has(id), false, 'live, so step 4 cannot reach it at all');
  assert.equal(
    ctx.wantAtFold.get(fold(`${SHARE}/img/big.png`)), id,
    'claimed in wantAtFold, which is what keeps the empty-folder sweep off its directory',
  );
  assert.equal(ctx.blobRefs.has(id), true, 'and it is still an attachment to the whole pass');
});

// ⚠ B26's last clause, over two passes because the first is the one that creates
// the directory: `preexistingDirs` exempts only folders that were there before
// the session began, so `Shared/img` is a live sweep candidate from pass two on.
// The only thing standing between it and the trash is the deferred node claiming
// it — and the directory is EMPTY, which is exactly the shape the sweep removes.
test('B26: the empty folder a deferred attachment lives in is never swept', async () => {
  const h = makeHarness({ autofetchMaxBytes: () => 100 });
  h.vault.seed(SHARE, 'd');
  h.nodes.set(nid('A'), await publishedBlob(h.blobs, 'img', 'big.png', png(1, 512)));

  await h.reconciler.reconcile('remote');
  assert.deepEqual(foldersIn(h.vault), [`${SHARE}/img`], 'created for a file that never arrived');

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(foldersIn(h.vault), [`${SHARE}/img`], 'and still there a pass later');
  assert.equal(h.vault.wasTrashed(`${SHARE}/img`), false);
  assert.deepEqual(r.diagnostics.deferred, [nid('A')]);
});

// §6.5, from the other end. The offline sweeper ran with a short TTL and removed
// bytes a long-absent peer still needed. The consequence is bounded by design —
// I2 makes a failed fetch a no-op — but "bounded" only means something if the
// user is TOLD, and `unavailable` is the channel that tells them. It is neither a
// failure (retrying will not bring the bytes back) nor a deferral (nobody chose
// this), so it gets a channel of its own.
test('an attachment whose bytes the store no longer holds is reported as unavailable', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  const node = await publishedBlob(h.blobs, '', 'gone.png', png(1, 64));
  h.nodes.set(id, node);
  h.blobs.setAbsent(parseBlobRef(node.b)!.sha256);

  const r = await h.reconciler.reconcile('remote');

  assert.deepEqual(r.diagnostics.unavailable, [id]);
  assert.deepEqual(r.diagnostics.deferred, [], 'nobody decided this');
  assert.deepEqual(r.diagnostics.tooLarge, []);
  assert.deepEqual(r.failures, [], 'and it is not a retry: the bytes are gone, not late');
  assert.deepEqual(inShare(h.vault), {}, 'I2: a missing blob is never a change on disk');
  assert.equal(h.state.data.materialized[id], undefined);
  assert.deepEqual(h.state.data.fetchDeferred, {}, 'nor a file the UI should offer to download');
});

// The distinction the channel rests on. A `get` that answered null WITHOUT a
// definite 404 behind it is a network that did not answer, and reporting that as
// "the bytes are gone" would tell the user their attachment is lost every time a
// proxy hiccups.
test('a fetch that returns nothing for any other reason is a retry, never "unavailable"', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'diagram.png', png()));

  const r = await freshSession(h, {
    blobs: blobPortOf(h.blobs, { get: async () => null }),
  }).reconcile('remote');

  assert.deepEqual(r.diagnostics.unavailable, []);
  assert.equal(r.failures.length, 1, 'a RetryLater, so the next pass asks again');
  assert.ok(r.failures[0].err instanceof RetryLater);
  assert.deepEqual(inShare(h.vault), {});
});

// ⚠ The staleness oracle, and the reason it has two clauses. A recorded hash is
// trusted only when size AND mtime agree; drop the mtime clause and an external
// edit that happens to keep the file's size is invisible for ever.
test('a recorded hash whose mtime no longer matches is re-hashed, not trusted', async () => {
  const requeued: Requeued[] = [];
  const h = makeHarness({ requeuePublish: (id, intent) => { requeued.push({ id, intent }); } });
  h.vault.seed(SHARE, 'd');
  const theirs = png(1);
  const mine = png(2, theirs.length);                          // SAME size, other bytes
  const sha = await hashOfBytes(theirs);
  const id = nid('A');
  const path = await bindBlob(h, id, 'diagram.png', mine, {
    sha256: sha, bytes: theirs.length, parent: null,
  }, {
    // The base claims the tree's hash, at the right size, with an mtime from
    // before the user's external edit.
    sha256: sha, len: theirs.length, mtimeShift: -5_000,
  });

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures, []);
  assert.equal(h.vault.callsTo('readBinary').length, 1, 'the stale mtime forced a re-hash');
  assert.deepEqual(
    requeued, [{ id, intent: await hashOfBytes(mine) }],
    'and the local change is published rather than silently lost',
  );
  assert.deepEqual(h.vault.binarySnapshot()[path], mine, 'the file itself is untouched');
});

test('a recorded hash whose size and mtime both agree costs one stat and no read', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const bytes = png();
  const sha = await hashOfBytes(bytes);
  const id = nid('A');
  await bindBlob(h, id, 'diagram.png', bytes, { sha256: sha, bytes: bytes.length, parent: null }, {
    sha256: sha, len: bytes.length,
  });

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures, []);
  assert.equal(h.vault.callsTo('readBinary').length, 0);
  assert.equal(h.vault.callsTo('stat').length, 1);
});

// ⚠ The P2-c handover, stated as a test: a node materialized by a pass whose
// post-write `stat` threw carries NO base. An absent base is not "converged" —
// it is "this device has confirmed nothing", and the only honest answer is to
// hash the file and find out.
test('a bound attachment with no recorded base is re-hashed rather than assumed current', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const bytes = png();
  const sha = await h.blobs.seed(bytes);
  const id = nid('A');
  await bindBlob(h, id, 'diagram.png', bytes, { sha256: sha, bytes: bytes.length, parent: null });

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures, []);
  assert.equal(h.vault.callsTo('readBinary').length, 1, 'it looked instead of assuming');
  assert.equal(h.state.data.contentHash[id]?.sha256, sha, 'and recorded what it found');
  assert.ok(h.state.data.contentHash[id]?.mtime !== undefined);
  assert.equal(mutations(h.vault), 0);
});

// ⚠ B7. A local replacement is PUBLISHED, and the user's file is never written to
// on the way. `requeue` carries the hash it was queued for, so a pass that runs
// every few seconds cannot defeat the publish ladder.
test('B7: locally edited bytes are requeued for publication and never overwritten', async () => {
  const requeued: Requeued[] = [];
  const h = makeHarness({ requeuePublish: (id, intent) => { requeued.push({ id, intent }); } });
  h.vault.seed(SHARE, 'd');
  const first = png(1);
  const edited = png(2, 96);
  const sha0 = await h.blobs.seed(first);
  const id = nid('A');
  const path = await bindBlob(h, id, 'diagram.png', first, {
    sha256: sha0, bytes: first.length, parent: null,
  }, {
    sha256: sha0, len: first.length,
  });

  // The user edits the file in an external editor.
  h.vault.seedBinary(path, edited);
  h.blobs.resetCalls();

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures, []);
  assert.deepEqual(requeued, [{ id, intent: await hashOfBytes(edited) }]);
  assert.deepEqual(h.vault.binarySnapshot()[path], edited, 'the edit is still there, in full');
  assert.equal(mutations(h.vault), 0, 'step 2.5 did not touch the disk');
  assert.deepEqual(h.blobs.calls, [], 'and did not fetch anything: the difference is ours');
  assert.equal(
    h.state.data.contentHash[id]?.sha256, sha0,
    'the base still names what the tree names: it advances when the publish confirms (I17)',
  );
});

// ⚠ B24, the step-2.5 arm. Hashing needs the whole file in memory, so a file over
// the cap is not hashed — and, because it was not hashed, no verdict is reached
// about it at all: not converged, not conflicted, not published.
test('B24: an attachment over the memory cap is not re-hashed and reaches no verdict', async () => {
  const requeued: Requeued[] = [];
  const h = makeHarness({
    memoryCapBytes: () => 32,
    requeuePublish: (id, intent) => { requeued.push({ id, intent }); },
  });
  h.vault.seed(SHARE, 'd');
  const bytes = png(3, 512);
  const sha = await h.blobs.seed(png(4, 512));                  // the tree names something else
  const id = nid('A');
  await bindBlob(h, id, 'clip.mov', bytes, { sha256: sha, bytes: 512, parent: null });
  h.blobs.resetCalls();

  const r = await h.reconciler.reconcile('sync');

  assert.equal(h.vault.callsTo('readBinary').length, 0, 'never held in memory');
  assert.deepEqual(r.diagnostics.tooLarge, [id]);
  assert.deepEqual(requeued, [], 'no publish was queued for bytes nobody hashed');
  assert.equal(h.state.data.contentHash[id], undefined, 'and no base was recorded');
  assert.deepEqual(r.failures, [], 'this is a fact about the device, not an error');
});

// A path the modify handler named is hashed even when the budget is spent: the
// user just saved that file, and answering "not this pass" for the one change
// they made is the wrong trade.
test('a path the modify handler flagged bypasses the re-hash budget', async () => {
  const requeued: Requeued[] = [];
  const dirty = new Set<string>([fold(`${SHARE}/diagram.png`)]);
  const h = makeHarness({
    rehashBudgetBytes: () => 0,
    takeDirtyPaths: () => dirty,
    requeuePublish: (id, intent) => { requeued.push({ id, intent }); },
  });
  h.vault.seed(SHARE, 'd');
  const first = png(1);
  const edited = png(2, 96);
  const sha0 = await h.blobs.seed(first);
  const id = nid('A');
  const other = nid('B');
  await bindBlob(h, id, 'diagram.png', edited, {
    sha256: sha0, bytes: first.length, parent: null,
  }, { sha256: sha0, len: first.length, mtimeShift: -5_000 });
  const otherBytes = png(5);
  const otherSha = await h.blobs.seed(otherBytes);
  await bindBlob(h, other, 'other.png', otherBytes, {
    sha256: otherSha, bytes: otherBytes.length, parent: null,
  });

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(requeued, [{ id, intent: await hashOfBytes(edited) }], 'the saved file was hashed');
  assert.deepEqual(
    r.diagnostics.rehashDeferred, [other],
    'and the one nobody asked about waits for a pass with budget left',
  );
});

// I2. "I could not look" is not an answer, and must not become a verdict: no
// publish, no fetch, no write — one recorded failure, and the next pass asks again.
test('a stat that could not answer decides nothing about an attachment', async () => {
  const requeued: Requeued[] = [];
  const h = makeHarness({ requeuePublish: (id, intent) => { requeued.push({ id, intent }); } });
  h.vault.seed(SHARE, 'd');
  const bytes = png();
  const sha = await h.blobs.seed(png(9));                       // the tree names other bytes
  const id = nid('A');
  const path = await bindBlob(h, id, 'diagram.png', bytes, { sha256: sha, bytes: 64, parent: null });
  h.vault.failNext('stat', new Error('EIO: the volume is unreadable'));
  h.blobs.resetCalls();

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures.map((f) => f.key), [`bytes:${id}`]);
  assert.deepEqual(requeued, []);
  assert.deepEqual(h.blobs.calls, []);
  assert.equal(mutations(h.vault), 0);
  assert.deepEqual(h.vault.binarySnapshot()[path], bytes);
});

// ---------------------------------------------------------------- P2 §3.5: rule 3

/**
 * A node whose tree reference SUPERSEDES what is on disk: the publisher's version
 * descends from exactly the bytes this device holds, which is rule 3.
 */
async function supersededBlob(
  h: Harness,
  id: string,
  rel: string,
  mine: Uint8Array,
  theirs: Uint8Array,
): Promise<{ path: string; mineSha: string; theirsSha: string }> {
  const mineSha = await hashOfBytes(mine);
  const theirsSha = await h.blobs.seed(theirs);
  const path = await bindBlob(h, id, rel, mine, {
    sha256: theirsSha, bytes: theirs.length, parent: mineSha,
  }, { sha256: mineSha, len: mine.length });
  return { path, mineSha, theirsSha };
}

// B8. The ordinary remote replace, and the only one that is allowed to overwrite
// anything: the reference the workspace converged on names bytes that descend
// from exactly what is on this disk, so nothing here is anybody's unpublished
// work. The previous bytes still go to the vault-local trash (I1) — every sync
// tool does this, and it is what "recoverable" means when there is no merge.
test('B8: a peer replacement that descends from our bytes is fetched and swapped in', async () => {
  const tickets = new RecordingTickets(() => NOW);
  const h = makeHarness({ tickets });
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const { path, theirsSha } = await supersededBlob(h, id, 'img/diagram.png', mine, theirs);

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures, []);
  assert.deepEqual(h.vault.binarySnapshot()[path], theirs, 'the workspace version is at the path');
  assert.equal(h.vault.callsTo('createBinary').length, 1, 'one write, never create-then-fill');
  assert.equal(h.state.data.contentHash[id]?.sha256, theirsSha, 'the base advanced (I17)');
  assert.ok(h.state.data.contentHash[id]?.mtime !== undefined, 'with the mtime the write produced');
  assert.equal(h.state.data.materialized[id], path, 'and the node is still bound to its file');
  assert.deepEqual(h.state.data.staging, {}, 'the journal is clear');

  // I1, positively: the superseded bytes are retained, not destroyed.
  const retained = [...h.vault.trashed.values()].filter((e) => e.bytes.length === mine.length);
  assert.equal(retained.length, 1, 'exactly one retained copy');
  assert.deepEqual(retained[0].bytes, mine, 'byte-identical to what was replaced');

  // Nothing is left parked outside the share.
  for (const p of Object.keys(h.vault.snapshot())) {
    assert.ok(!p.startsWith('ShadowLink Staging/'), `${p} was left in staging`);
  }

  const staged = `ShadowLink Staging/${id}.png`;
  assert.deepEqual(
    tickets.armed.filter((a) => a.includes(path) || a.includes(staged)),
    [`rename ${path} -> ${staged}`, `create ${path}`, `modify ${path}`, `delete ${staged}`],
    'the old bytes leave through staging BEFORE the new ones exist, and every echo is armed',
  );
});

// A second pass is inert: rule 1, one stat, no fetch, no write.
test('a replaced attachment converges after one pass and re-fetches nothing', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const id = nid('A');
  await supersededBlob(h, id, 'diagram.png', png(1), png(2, 96));

  await h.reconciler.reconcile('sync');
  h.vault.resetCalls();
  h.blobs.resetCalls();
  const second = await h.reconciler.reconcile('sync');

  assert.deepEqual(second.failures, []);
  assert.deepEqual(h.blobs.calls, [], 'nothing was fetched a second time');
  assert.equal(mutations(h.vault), 0);
  assert.equal(h.vault.callsTo('stat').length, 1, 'one stat, and the pass is over');
});

// ⚠ B11. The re-check after the fetch, which is the whole reason the fetch comes
// first. `isOpenInLeaf` was false when the verdict was reached and true by the
// time the bytes arrived — a fetch is bounded by file size, not by an 8 s doc
// timeout, so this window is minutes wide (I7).
test('B11: a file opened DURING the fetch is not replaced', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const { path } = await supersededBlob(h, id, 'diagram.png', mine, theirs);

  h.reconciler = new Reconciler({
    vault: h.vault,
    docs: h.docs,
    blobs: blobPortOf(h.blobs, {
      get: async (sha, n) => {
        // The user double-clicks the image while the download is running.
        h.vault.setOpen(path, true);
        return h.blobs.get(sha, n);
      },
    }),
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    entries: () => [...h.nodes],
    now: () => NOW,
  });

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures, []);
  assert.deepEqual(h.vault.binarySnapshot()[path], mine, 'the open file was left exactly as it was');
  assert.equal(h.vault.callsTo('createBinary').length, 0);
  assert.equal(h.vault.callsTo('rename').length, 0, 'and it was not staged out either');
  assert.deepEqual(h.state.data.staging, {}, 'no journal entry for a swap that never began');
});

// I7 again, before the fetch: a file the user has open is not even downloaded for.
test('an attachment open in a leaf is not replaced, and nothing is fetched for it', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const id = nid('A');
  const { path } = await supersededBlob(h, id, 'diagram.png', mine, png(2, 96));
  h.vault.setOpen(path, true);
  h.blobs.resetCalls();

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures, []);
  assert.deepEqual(h.blobs.calls, [], 'no fetch at all');
  assert.deepEqual(h.vault.binarySnapshot()[path], mine);
});

// ⚠ B12. The file changed under us while the bytes were in flight — the user
// saved a new version, or an external tool rewrote it. Those bytes are now
// unpublished local work, and overwriting them would destroy the only copy.
test('B12: bytes that changed during the fetch are not overwritten', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const edited = png(3, 48);
  const id = nid('A');
  const { path } = await supersededBlob(h, id, 'diagram.png', mine, theirs);

  h.reconciler = new Reconciler({
    vault: h.vault,
    docs: h.docs,
    blobs: blobPortOf(h.blobs, {
      get: async (sha, n) => {
        const bytes = await h.blobs.get(sha, n);
        h.vault.seedBinary(path, edited);          // the user saves over it mid-download
        return bytes;
      },
    }),
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    entries: () => [...h.nodes],
    now: () => NOW,
  });

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(h.vault.binarySnapshot()[path], edited, 'the newer local bytes survived');
  assert.equal(h.vault.callsTo('createBinary').length, 0);
  assert.deepEqual(h.state.data.staging, {}, 'and nothing was staged out');
  assert.deepEqual(r.failures, [], 'this is a deferral, not an error');
});

// ⚠ B12, the same-size case. Only the mtime distinguishes a file that was
// rewritten with a same-length version, which is exactly what an image editor
// re-exporting a PNG produces.
test('B12: a same-size rewrite during the fetch is still not overwritten', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const edited = png(4, mine.length);              // SAME size, different bytes
  const id = nid('A');
  const { path } = await supersededBlob(h, id, 'diagram.png', mine, theirs);

  h.reconciler = new Reconciler({
    vault: h.vault,
    docs: h.docs,
    blobs: blobPortOf(h.blobs, {
      get: async (sha, n) => {
        const bytes = await h.blobs.get(sha, n);
        h.vault.seedBinary(path, edited);
        return bytes;
      },
    }),
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    entries: () => [...h.nodes],
    now: () => NOW,
  });

  await h.reconciler.reconcile('sync');

  assert.deepEqual(h.vault.binarySnapshot()[path], edited, 'the same-size rewrite survived');
  assert.equal(h.vault.callsTo('createBinary').length, 0);
});

// ⚠ A fetch that did not complete is a no-op, never a hole and never a delete.
//
// CHANGED IN P2-f, for the reason given at the materialize-arm test above: a
// store that answers a definite 404 is reported as `unavailable` rather than
// retried as a failure (§6.5). Every assertion about the user's file is
// untouched, because that is what this test exists to hold.
test('a replacement whose bytes will not fetch leaves the local file in place', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const { path, theirsSha } = await supersededBlob(h, id, 'diagram.png', mine, theirs);
  h.blobs.setAbsent(theirsSha);                    // swept, or lost with the volume

  const first = await h.reconciler.reconcile('sync');

  assert.deepEqual(first.failures, []);
  assert.deepEqual(first.diagnostics.unavailable, [id]);
  assert.deepEqual(h.vault.binarySnapshot()[path], mine, 'nothing moved, nothing was staged');
  assert.deepEqual(h.state.data.staging, {});

  // …and it converges the moment the bytes are there.
  await h.blobs.seed(theirs);
  const second = await h.reconciler.reconcile('retry');
  assert.deepEqual(second.failures, []);
  assert.deepEqual(h.vault.binarySnapshot()[path], theirs);
});

// The other side of the same branch, on the replace path: a `get` that answered
// null with no definite verdict behind it is a network that did not answer, and
// it stays a retry. Without this the RetryLater arm here would be dead code that
// no test distinguishes from the 404 arm above.
test('a replacement whose fetch merely failed is still a retry', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const { path } = await supersededBlob(h, id, 'diagram.png', mine, theirs);

  const r = await freshSession(h, {
    blobs: blobPortOf(h.blobs, { get: async () => null }),
  }).reconcile('sync');

  assert.equal(r.failures.length, 1);
  assert.ok(r.failures[0].err instanceof RetryLater);
  assert.deepEqual(r.diagnostics.unavailable, []);
  assert.deepEqual(h.vault.binarySnapshot()[path], mine);
  assert.deepEqual(h.state.data.staging, {});
});

// The second of two independent checks, on the replace path. A port that hands
// back bytes it did not verify is one refactor away, and this is the only thing
// between it and the user's file.
test('replacement bytes that arrive unverified are refused and nothing is swapped', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const { path } = await supersededBlob(h, id, 'diagram.png', mine, theirs);
  const other = png(9, 96);                        // same length, other bytes

  h.reconciler = new Reconciler({
    vault: h.vault,
    docs: h.docs,
    blobs: blobPortOf(h.blobs, { get: async () => other }),
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    entries: () => [...h.nodes],
    now: () => NOW,
  });

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(h.vault.binarySnapshot()[path], mine, 'the wrong bytes never reached the disk');
  assert.equal(h.vault.callsTo('createBinary').length, 0);
  assert.deepEqual(r.failures.map((f) => f.key), [`bytes:${id}`]);
  assert.equal(h.state.data.contentHash[id]?.sha256, await hashOfBytes(mine), 'the base still names ours');
});

// ⚠ B13. The crash window, and why the swap goes through the journal at all: the
// process dies between the rename and the write. What is left is a VISIBLE file
// plus a journal line, and the next pass puts the bytes back — never a hole where
// the user's attachment used to be.
test('B13: a crash between the stage-out and the write restores the old bytes next pass', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const { path, mineSha, theirsSha } = await supersededBlob(h, id, 'diagram.png', mine, theirs);

  // The state a process death mid-swap leaves behind, built by hand because a
  // crash is not something a failing call models: the journal line is on disk,
  // the bytes are parked in the visible staging folder, and the binding is gone.
  h.vault.seedBinary(`ShadowLink Staging/${id}.png`, mine);
  h.state.data.staging[id] = { from: path, to: path, at: NOW };
  delete h.state.data.materialized[id];
  await h.vault.trashLocal(`${SHARE}/diagram.png`);        // the rename had removed it
  h.vault.trashed.clear();
  h.vault.resetCalls();
  // The store cannot serve the replacement either, so the pass restores and stops
  // there: what is asserted below is the RESTORE, not a second swap on top of it.
  h.blobs.setAbsent(theirsSha);

  const next = await h.reconciler.reconcile('retry');

  assert.deepEqual(
    h.vault.binarySnapshot()[path], mine,
    'the old bytes are back at the canonical path — never a hole where the file was',
  );
  assert.equal(
    h.vault.binarySnapshot()[`ShadowLink Staging/${id}.png`], undefined,
    'and nothing is left parked in staging',
  );
  assert.deepEqual(h.state.data.staging, {}, 'the journal is clear again');
  assert.equal(h.state.data.materialized[id], path, 'with the binding restored');
  assert.equal(h.state.data.contentHash[id]?.sha256, mineSha, 'and the base still names what is there');
  // The replace itself is simply owed again; it is a deferral, not a loss.
  //
  // CHANGED IN P2-f: the store answering "I do not hold that" is now reported
  // through `unavailable` rather than as a `bytes:<id>` failure (§6.5). What this
  // test is actually about — the RESTORE, and the absence of a hole — is
  // unchanged above.
  assert.deepEqual(next.failures, []);
  assert.deepEqual(next.diagnostics.unavailable, [id]);
});

// The same interruption from the other direction: the write itself failed. The
// pass must not end with an empty canonical path, and the bytes it staged must
// still exist — this one is about what the pass does with its own failure, not
// about what a restart finds.
test('a swap whose write fails leaves neither a hole nor a lost copy', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const { path } = await supersededBlob(h, id, 'diagram.png', mine, theirs);
  h.vault.failNext('createBinary', new Error('EIO: the disk went away mid-write'));

  const crashed = await h.reconciler.reconcile('sync');

  assert.deepEqual(crashed.failures.map((f) => f.key), [`bytes:${id}`]);
  assert.notEqual(h.vault.binarySnapshot()[path], undefined, 'the path is not left empty');
  const survivors = Object.values(h.vault.binarySnapshot())
    .filter((b) => b.length === mine.length && b.every((x, i) => x === mine[i]));
  assert.equal(survivors.length, 1, 'and the staged copy still exists somewhere visible');

  const next = await h.reconciler.reconcile('retry');

  assert.deepEqual(h.vault.binarySnapshot()[path], theirs, 'the replacement lands');
  assert.deepEqual(h.state.data.staging, {}, 'the journal is clear');
  const rescued = Object.entries(h.vault.binarySnapshot())
    .filter(([p]) => p.startsWith('ShadowLink Recovered/'));
  assert.equal(rescued.length, 1, 'and the old bytes are visible, not dropped');
  assert.deepEqual(rescued[0][1], mine);
  assert.deepEqual(next.failures, []);
});

// ⚠ I17, on the replace path: a watermark may only describe a write that
// RETURNED. Recording the base before the swap would leave device state claiming
// the file holds the workspace's bytes while it holds the user's — and the
// staleness oracle would then trust that claim for as long as the mtime happens
// to match, which is how a replace that never happened becomes "converged".
test('a swap that could not write records no base for bytes that never landed', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const { path, mineSha, theirsSha } = await supersededBlob(h, id, 'diagram.png', mine, theirs);
  // Twice: the swap's write, and step 3's attempt to re-materialize afterwards.
  // What is left is the state a disk that stopped answering really produces.
  h.vault.failNext('createBinary', new Error('EIO: the disk went away mid-write'));
  h.vault.failNext('createBinary', new Error('EIO: still gone'));

  const stormed = await h.reconciler.reconcile('sync');

  assert.deepEqual(stormed.failures.map((f) => f.key).sort(), [`bytes:${id}`, `materialize:${id}`]);
  assert.equal(
    h.state.data.contentHash[id]?.sha256, mineSha,
    'the base still names the bytes this device actually confirmed',
  );
  assert.deepEqual(
    h.vault.binarySnapshot()[`ShadowLink Staging/${id}.png`], mine,
    'and the user’s bytes are parked where they can be seen',
  );

  const next = await h.reconciler.reconcile('retry');

  assert.deepEqual(next.failures, []);
  assert.deepEqual(h.vault.binarySnapshot()[path], theirs, 'the next pass converges');
  assert.equal(h.state.data.contentHash[id]?.sha256, theirsSha);
  assert.deepEqual(h.state.data.staging, {});
});

// ⚠ B13, the other half: the process died AFTER the new bytes landed. The staged
// copy cannot go back to a path that is now occupied, so it is rescued into
// `ShadowLink Recovered/` with a Notice — visible, and never silently dropped.
test('B13: a crash after the new bytes landed rescues the staged copy instead of losing it', async () => {
  const h = makeHarness();
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const { path } = await supersededBlob(h, id, 'diagram.png', mine, theirs);
  // The trash call is the last step of the swap: failing it models a crash with
  // the new bytes already at the canonical path and the old ones still staged.
  h.vault.failNext('trashLocal', new Error('EPERM: the trash folder is locked'));

  await h.reconciler.reconcile('sync');
  assert.deepEqual(h.vault.binarySnapshot()[path], theirs, 'the new bytes did land');

  const next = await h.reconciler.reconcile('retry');

  assert.deepEqual(h.vault.binarySnapshot()[path], theirs, 'and they stay');
  const rescued = Object.entries(h.vault.binarySnapshot())
    .filter(([p]) => p.startsWith('ShadowLink Recovered/'));
  assert.equal(rescued.length, 1, 'the staged copy was rescued, not dropped');
  assert.deepEqual(rescued[0][1], mine, 'byte-identical to what was replaced');
  assert.deepEqual(h.state.data.staging, {}, 'and the journal is clear');
  assert.deepEqual(next.failures, []);
});

// ⚠ B24, the replace arm. A device that cannot hold the incoming object does not
// ask for it: the node stays live, valid, published and simply not current here.
test('B24: a replacement over the memory cap is not fetched and the local file stands', async () => {
  const h = makeHarness({ memoryCapBytes: () => 80 });
  h.vault.seed(SHARE, 'd');
  const mine = png(1, 64);
  const theirs = png(2, 512);
  const id = nid('A');
  const { path } = await supersededBlob(h, id, 'clip.mov', mine, theirs);
  h.blobs.resetCalls();

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(h.blobs.calls, [], 'not one request was made');
  assert.deepEqual(h.vault.binarySnapshot()[path], mine);
  assert.deepEqual(r.diagnostics.tooLarge, [id]);
  assert.deepEqual(r.failures, []);
});

// ---------------------------------------------------------------- P2 §4.3: fork and take

/** What `forkName` produces for these fixtures, spelled out rather than computed. */
async function forkPathOf(dir: string, name: string, mine: Uint8Array, who: string): Promise<string> {
  const hash = await hashOfBytes(mine);
  return `${dir}/${forkName(name, hash, who)}`;
}

// ⚠ B9's local half, and the reason the whole P2 design was chosen: two people
// changed one attachment without seeing each other, so BOTH versions survive as
// visible files. The rename IS the preservation — there is no copy, and no
// instant in which the user's bytes exist only in memory.
test('rule 4: our version is renamed aside and the workspace version takes the path', async () => {
  const h = makeHarness({ displayName: 'Ann' });
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const base = png(3, 32);                       // what both versions descend from
  const id = nid('A');
  const theirsSha = await h.blobs.seed(theirs);
  const path = await bindBlob(h, id, 'img/diagram.png', mine, {
    sha256: theirsSha, bytes: theirs.length, parent: await hashOfBytes(base),
  }, { sha256: await hashOfBytes(mine), len: mine.length });

  const r = await h.reconciler.reconcile('sync');

  const fork = await forkPathOf(`${SHARE}/img`, 'diagram.png', mine, 'Ann');
  assert.deepEqual(r.failures, []);
  assert.deepEqual(h.vault.binarySnapshot()[fork], mine, 'our bytes, under a name of their own');
  assert.deepEqual(h.vault.binarySnapshot()[path], theirs, 'and the workspace version at the path');
  assert.equal(h.state.data.materialized[id], path, 'the node is bound to the canonical file');
  assert.equal(h.state.data.contentHash[id]?.sha256, theirsSha, 'with the base it just confirmed');
  assert.equal(h.vault.wasTrashed(path), false, 'nothing was trashed: both versions are files');
  assert.deepEqual(stashed(h.vault), {}, 'and nothing was exiled outside the share');

  // The order is the promise: RENAME first, and only then the new file. A copy
  // would mean an interval in which the only copy of the user's bytes is a
  // JavaScript array.
  const ops = h.vault.calls
    .filter((c) => c.op === 'rename' || c.op === 'createBinary' || c.op === 'trashLocal')
    .map((c) => `${c.op} ${String(c.args[0])}`);
  assert.deepEqual(ops, [`rename ${path}`, `createBinary ${path}`]);

  assert.equal(h.notices.length, 1, 'the user is told, once');
  assert.ok(h.notices[0].includes('diagram.png'), h.notices[0]);
  assert.ok(h.notices[0].includes(baseOfPath(fork)), 'and the notice names the fork');
});

/** Basename helper for the assertions above — the tests read paths, users read names. */
function baseOfPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// ⚠ A failed fetch must leave the user's file EXACTLY where it was. This is why
// the fetch happens before the rename and not after it: the alternative is a
// vault in which the canonical path is empty and the attachment has been renamed
// to something the user never chose, because the network blinked.
test('a fork whose fetch fails moves nothing at all', async () => {
  const h = makeHarness({ displayName: 'Ann' });
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const theirsSha = await h.blobs.seed(theirs);
  const path = await bindBlob(h, id, 'diagram.png', mine, {
    sha256: theirsSha, bytes: theirs.length, parent: 'f'.repeat(64),
  }, { sha256: await hashOfBytes(mine), len: mine.length });
  h.blobs.setAbsent(theirsSha);

  const r = await h.reconciler.reconcile('sync');

  // CHANGED IN P2-f: a definite 404 is `unavailable`, not a retryable failure
  // (§6.5). The three assertions this test exists for are untouched.
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.diagnostics.unavailable, [id]);
  assert.deepEqual(h.vault.binarySnapshot()[path], mine, 'still there, still called what it was');
  assert.equal(h.vault.callsTo('rename').length, 0, 'not renamed aside on a fetch that failed');
  assert.deepEqual(h.notices, [], 'and the user was not told about a fork that did not happen');
});

// The second of two independent digest checks, on the fork path. Bytes that do
// not verify never reach the disk — and, because the fetch comes first, they
// never cause the rename either.
test('fork bytes that arrive unverified are refused and nothing moves', async () => {
  const h = makeHarness({ displayName: 'Ann' });
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const theirsSha = await h.blobs.seed(theirs);
  const path = await bindBlob(h, id, 'diagram.png', mine, {
    sha256: theirsSha, bytes: theirs.length, parent: 'f'.repeat(64),
  }, { sha256: await hashOfBytes(mine), len: mine.length });

  h.reconciler = new Reconciler({
    vault: h.vault,
    docs: h.docs,
    blobs: blobPortOf(h.blobs, { get: async () => png(9, 96) }),   // a port that verified nothing
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    entries: () => [...h.nodes],
    displayName: 'Ann',
    now: () => NOW,
  });

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures.map((f) => f.key), [`bytes:${id}`]);
  assert.deepEqual(h.vault.binarySnapshot()[path], mine);
  assert.equal(h.vault.callsTo('rename').length, 0);
  assert.equal(h.vault.callsTo('createBinary').length, 0);
});

// I7. The file is open in a view; renaming it out from under that view is exactly
// what the invariant exists to prevent. Deferring costs one pass.
test('a conflicted attachment open in a leaf is not forked', async () => {
  const h = makeHarness({ displayName: 'Ann' });
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const theirsSha = await h.blobs.seed(theirs);
  const path = await bindBlob(h, id, 'diagram.png', mine, {
    sha256: theirsSha, bytes: theirs.length, parent: 'f'.repeat(64),
  }, { sha256: await hashOfBytes(mine), len: mine.length });
  h.vault.setOpen(path, true);
  h.blobs.resetCalls();

  const r = await h.reconciler.reconcile('sync');

  assert.deepEqual(r.failures, []);
  assert.deepEqual(h.blobs.calls, [], 'not even fetched for');
  assert.deepEqual(h.vault.binarySnapshot()[path], mine);
  assert.deepEqual(h.notices, []);
});

/**
 * The fork path's version of B8/B11's harness: a rule-4 divergence whose `get`
 * runs `duringFetch` while the bytes are in flight.
 *
 * The window it opens is the point. A fetch is bounded by file size, not by an
 * 8 s doc timeout, so on a 200 MB attachment over a phone link it is minutes
 * wide — and everything the verdict was based on can change inside it.
 */
async function forkWithInterference(
  h: Harness,
  id: string,
  rel: string,
  mine: Uint8Array,
  theirs: Uint8Array,
  duringFetch: (path: string) => void,
): Promise<string> {
  const theirsSha = await h.blobs.seed(theirs);
  const path = await bindBlob(h, id, rel, mine, {
    sha256: theirsSha, bytes: theirs.length, parent: 'f'.repeat(64),
  }, { sha256: await hashOfBytes(mine), len: mine.length });

  h.reconciler = new Reconciler({
    vault: h.vault,
    docs: h.docs,
    blobs: blobPortOf(h.blobs, {
      get: async (sha, n) => {
        const bytes = await h.blobs.get(sha, n);
        duringFetch(path);
        return bytes;
      },
    }),
    state: h.state,
    tickets: h.tickets,
    shareRoot: SHARE,
    entries: () => [...h.nodes],
    displayName: 'Ann',
    now: () => NOW,
  });
  return path;
}

// ⚠ B11's twin, on the fork path, and the worse half of the pair: `cleanReplace`
// swaps a file's bytes, while this RENAMES the file out from under whatever view
// is showing it. `isOpenInLeaf` was false when the verdict was reached and true by
// the time the bytes arrived (I7).
test('B11 fork twin: a file opened DURING the fork fetch is not renamed out from under the view',
  async () => {
    const h = makeHarness({ displayName: 'Ann' });
    h.vault.seed(SHARE, 'd');
    const mine = png(1);
    const path = await forkWithInterference(
      h, nid('A'), 'diagram.png', mine, png(2, 96),
      // The user double-clicks the image while the download is running.
      (p) => { h.vault.setOpen(p, true); },
    );

    const r = await h.reconciler.reconcile('sync');

    assert.deepEqual(r.failures, []);
    assert.equal(h.vault.callsTo('rename').length, 0, 'the open file was not moved');
    assert.deepEqual(h.vault.binarySnapshot()[path], mine, 'and it still holds its own bytes');
    assert.equal(h.vault.callsTo('createBinary').length, 0, 'nothing was written over it either');
    assert.deepEqual(
      Object.keys(h.vault.binarySnapshot()).filter((p) => p.includes('conflicted copy')), [],
      'no half-done fork was left behind',
    );
    assert.deepEqual(h.notices, [], 'and nobody was told about a fork that did not happen');
  });

// ⚠ B12's twin, on the fork path. Nothing here is destroyed by a stale verdict —
// the rename preserves whatever bytes are there — but the NAME it preserves them
// under carries the hash they had before the user saved, and §4.3 makes that name
// load-bearing. Worse, the fresh bytes may not be a fork case at all: a save that
// happened to land on `ref.sha256` is rule 1, and one whose base still matches is
// rule 2, a republish. Deferring one pass re-derives the verdict from what is
// actually on disk.
test('B12 fork twin: bytes that changed during the fork fetch are not forked on the old verdict',
  async () => {
    const h = makeHarness({ displayName: 'Ann' });
    h.vault.seed(SHARE, 'd');
    const mine = png(1);
    const edited = png(3, 48);
    const path = await forkWithInterference(
      h, nid('A'), 'diagram.png', mine, png(2, 96),
      // The user saves over it mid-download.
      (p) => { h.vault.seedBinary(p, edited); },
    );

    const r = await h.reconciler.reconcile('sync');

    assert.deepEqual(r.failures, []);
    assert.deepEqual(
      h.vault.binarySnapshot()[path], edited,
      'the bytes the user just saved are still at the path they saved them to',
    );
    assert.equal(h.vault.callsTo('rename').length, 0, 'nothing was renamed on a stale verdict');
    assert.deepEqual(
      Object.keys(h.vault.binarySnapshot()).filter((p) => p.includes('conflicted copy')), [],
      'and no fork was named after a hash the file no longer has',
    );
    assert.deepEqual(h.notices, []);
  });

// ⚠ B10. Fork idempotence, which is what the missing timestamp buys. The fork
// file is untracked until step 6 hands it to the publisher, so a pass that runs
// before the node is minted must not fork a second time — and must offer the same
// name it produced before.
test('B10: a re-run pass forks once, keeps the name, and offers the fork for publication', async () => {
  const h = makeHarness({ displayName: 'Ann' });
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const id = nid('A');
  const theirsSha = await h.blobs.seed(theirs);
  const path = await bindBlob(h, id, 'diagram.png', mine, {
    sha256: theirsSha, bytes: theirs.length, parent: 'f'.repeat(64),
  }, { sha256: await hashOfBytes(mine), len: mine.length });
  const fork = await forkPathOf(SHARE, 'diagram.png', mine, 'Ann');

  await h.reconciler.reconcile('sync');
  const afterFirst = h.vault.binarySnapshot();
  const second = await h.reconciler.reconcile('retry');

  assert.deepEqual(second.failures, []);
  assert.deepEqual(h.vault.binarySnapshot(), afterFirst, 'the second pass is inert');
  const conflicted = Object.keys(h.vault.binarySnapshot()).filter((p) => p.includes('conflicted copy'));
  assert.deepEqual(conflicted, [fork], 'exactly one conflicted copy, with the same name');
  assert.deepEqual(h.vault.binarySnapshot()[path], theirs);
  // Step 6 offers the untracked fork on every pass until a node claims it — that
  // is the seam that mints and publishes it (§4.2 step 7).
  assert.deepEqual(h.published[h.published.length - 1], [fork]);
  assert.equal(h.notices.length, 1, 'and the user is told once, not once per pass');
});

// The adopt route reaches the same rule: a local file sitting at a published
// node's path whose bytes are neither the tree's nor anything this device ever
// confirmed. Unknown ancestry is rule 4, and rule 4 keeps both.
test('an adopted file with unknown ancestry forks instead of being overwritten', async () => {
  const h = makeHarness({ displayName: 'Ann' });
  h.vault.seed(SHARE, 'd');
  const mine = png(1);
  const theirs = png(2, 96);
  const path = `${SHARE}/diagram.png`;
  h.vault.seedBinary(path, mine);
  const id = nid('A');
  h.nodes.set(id, await publishedBlob(h.blobs, '', 'diagram.png', theirs));

  const r = await h.reconciler.reconcile('bootstrap');

  const fork = await forkPathOf(SHARE, 'diagram.png', mine, 'Ann');
  assert.deepEqual(r.failures, []);
  assert.deepEqual(h.vault.binarySnapshot()[fork], mine, 'the local file was preserved by name');
  assert.deepEqual(h.vault.binarySnapshot()[path], theirs);
  assert.equal(h.state.data.materialized[id], path);
});

// ---------------------------------------------------------------- P2 §4.2: the hard case

/**
 * One whole client: vault, device state, tickets, watcher, publish queue and
 * reconciler, wired exactly as `main.ts` wires them.
 *
 * Only the tree and the store are shared, because in a real workspace those are
 * the only two things that are.
 */
interface Peer {
  name: string;
  vault: FakeVault;
  state: DeviceState;
  tree: TreeDoc;
  queue: PublishQueue;
  watcher: VaultWatcher;
  reconciler: Reconciler;
  notices: string[];
}

function makePeer(name: string, tree: TreeDoc, store: FakeBlobs): Peer {
  const vault = new FakeVault();
  vault.seed(SHARE, 'd');
  const docs = new FakeDocs();
  const state = new DeviceState(new MemoryStatePort(), `device-${name}`, 'ws-1', () => NOW, 0);
  const tickets = new Tickets(() => NOW);
  const notices: string[] = [];

  const queue = new PublishQueue({
    docs,
    vault,
    blobs: store,
    state,
    tree,
    openNodeId: () => null,
    displayName: name,
    now: () => NOW,
    settleMs: 0,
  });

  const watcher = new VaultWatcher({
    tree,
    entries: () => tree.entries(),
    vault,
    state,
    tickets,
    getShareRoot: () => SHARE,
    setShareRoot: () => undefined,
    displayName: name,
    phase: () => 'ready',
    now: () => NOW,
    notice: (m) => { notices.push(m); },
    enqueuePublish: (id) => { queue.enqueue(id); },
    ...DESKTOP_MEMORY_CAP,
  });

  const reconciler = new Reconciler({
    vault,
    docs,
    blobs: store,
    state,
    tickets,
    shareRoot: SHARE,
    entries: () => tree.entries(),
    displayName: name,
    now: () => NOW,
    notice: (m) => { notices.push(m); },
    requeuePublish: (id, intent) => { queue.requeue(id, intent); },
    publishUntracked: async (paths) => {
      for (const path of paths) await watcher.onCreate(path, 'f');
      await queue.drain();
    },
  });

  return { name, vault, state, tree, queue, watcher, reconciler, notices };
}

/** A tree doc with a fixed clientID, so the LWW winner is the same in every run. */
function treeWithClient(clientId: number): TreeDoc {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  return new TreeDoc(doc);
}

function syncTrees(a: TreeDoc, b: TreeDoc): void {
  b.applyUpdate(a.encodeState());
  a.applyUpdate(b.encodeState());
}

/** Everything under the share, as path -> bytes. */
function shareBytes(vault: FakeVault): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(vault.binarySnapshot())) {
    if (path.startsWith(`${SHARE}/`)) out[path] = data;
  }
  return out;
}

/** Byte-comparable, id-free view: the tree, keyed by what each node IS. */
function treeShape(tree: TreeDoc): string {
  return JSON.stringify(
    tree.entries()
      .map(([, f]) => [f.k, f.d, f.n, f.s ?? 0, f.b ?? ''])
      .sort((x, y) => cmpJson(x, y)),
  );
}

/** Device state with nodeIds replaced by the path each node claims: run-comparable. */
function stateShape(peer: Peer): string {
  const rel = new Map<string, string>();
  for (const [id, f] of peer.tree.entries()) rel.set(id, `${f.d}/${f.n}`);
  const materialized: Array<[string, string]> = Object.entries(peer.state.data.materialized)
    .map(([id, path]) => [rel.get(id) ?? id, path]);
  const hashes: Array<[string, string]> = Object.entries(peer.state.data.contentHash)
    .map(([id, entry]) => [rel.get(id) ?? id, entry.sha256]);
  return JSON.stringify({
    materialized: materialized.sort((a, b) => cmpJson(a, b)),
    contentHash: hashes.sort((a, b) => cmpJson(a, b)),
  });
}

function cmpJson(a: unknown, b: unknown): number {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Spec §4.2's assigned hard case, run for real.
 *
 * Ann publishes an attachment; Bob materializes it; both replace it while
 * partitioned; the partition heals. `order` decides which of them reconciles
 * first afterwards — the outcome must not depend on it, which is the property
 * that makes this design work with no coordinator.
 */
async function runConcurrentReplace(order: 'ann-first' | 'bob-first'): Promise<{
  ann: Peer; bob: Peer; store: FakeBlobs; id: string;
  original: Uint8Array; annBytes: Uint8Array; bobBytes: Uint8Array;
  putsAfterMerge: number;
}> {
  const store = new FakeBlobs();
  const ann = makePeer('Ann', treeWithClient(1), store);
  const bob = makePeer('Bob', treeWithClient(2), store);
  const rel = 'img/diagram.png';
  const path = `${SHARE}/${rel}`;
  const original = png(1, 120);
  const annBytes = png(2, 130);
  const bobBytes = png(3, 145);

  // 1. Ann drops the image into the shared folder, and it publishes.
  ann.vault.seed(`${SHARE}/img`, 'd');
  ann.vault.seedBinary(path, original);
  await ann.watcher.onCreate(path, 'f');
  await ann.queue.drain();
  const id = ann.tree.entries()[0][0];

  // 2. Bob materializes it, byte for byte.
  syncTrees(ann.tree, bob.tree);
  await bob.reconciler.reconcile('bootstrap');

  // 3. The partition. Neither tree is exchanged; both users edit and save.
  ann.vault.seedBinary(path, annBytes);
  await ann.reconciler.reconcile('sync');
  bob.vault.seedBinary(path, bobBytes);
  await bob.reconciler.reconcile('sync');

  // 4. It heals. `b` is ONE register, so the workspace converges on one of the
  //    two references — and the store holds both objects, because a
  //    content-addressed store has no concept of overwriting.
  syncTrees(ann.tree, bob.tree);
  store.resetCalls();

  const peers = order === 'ann-first' ? [ann, bob] : [bob, ann];
  for (let round = 0; round < 3; round++) {
    for (const peer of peers) await peer.reconciler.reconcile('remote');
    syncTrees(ann.tree, bob.tree);
  }

  return {
    ann, bob, store, id, original, annBytes, bobBytes,
    putsAfterMerge: store.callsTo('put').length,
  };
}

// ⚠ B9. The whole slice, end to end, against two engines and one store: both
// peers publish, the LWW register settles on one of them, the loser's version
// becomes a visible sibling instead of disappearing, and every peer ends up
// holding BOTH files with identical names and identical bytes.
test('B9: two concurrent replacements converge on two files, and nobody loses bytes', async () => {
  const run = await runConcurrentReplace('ann-first');
  const { ann, bob, store, id, annBytes, bobBytes } = run;

  const winner = parseBlobRef(ann.tree.get(id)!.b)!;
  assert.equal(
    winner.sha256, parseBlobRef(bob.tree.get(id)!.b)!.sha256,
    'both peers agree on which reference the workspace converged on',
  );
  const winnerBytes = winner.sha256 === await hashOfBytes(annBytes) ? annBytes : bobBytes;
  const loserBytes = winnerBytes === annBytes ? bobBytes : annBytes;
  const loser = winnerBytes === annBytes ? bob : ann;

  // Neither upload destroyed the other: the store holds both objects.
  assert.deepEqual(store.stored(await hashOfBytes(annBytes)), annBytes);
  assert.deepEqual(store.stored(await hashOfBytes(bobBytes)), bobBytes);

  const canonical = `${SHARE}/img/diagram.png`;
  const fork = `${SHARE}/img/${forkName('diagram.png', await hashOfBytes(loserBytes), loser.name)}`;

  for (const peer of [ann, bob]) {
    const files = shareBytes(peer.vault);
    assert.deepEqual(
      Object.keys(files).sort(), [fork, canonical].sort(),
      `${peer.name} does not hold both files`,
    );
    assert.deepEqual(files[canonical], winnerBytes, `${peer.name}'s canonical file`);
    assert.deepEqual(files[fork], loserBytes, `${peer.name}'s conflicted copy`);
  }

  // The fork is a real shared node, owned by the peer whose bytes it holds.
  assert.equal(ann.tree.entries().filter(([, f]) => isLiveNode(f)).length, 2);
  assert.equal(treeShape(ann.tree), treeShape(bob.tree), 'and both trees say the same thing');

  // ⚠ ZERO BYTES UPLOADED for the fork: the store already holds those bytes under
  // that hash, so publishing it is a HEAD hit plus a tree write.
  assert.equal(run.putsAfterMerge, 0, 'the conflicted copy was published without an upload');

  // The loser is told, once, and the notice names both files.
  const told = loser.notices.filter((m) => m.includes('conflicted copy'));
  assert.equal(told.length, 1, loser.notices.join(' | '));
  assert.ok(told[0].includes('diagram.png'));
});

/** `isLive` under a name that cannot be confused with the fixture helpers above. */
function isLiveNode(f: NodeFields): boolean {
  return f.x === undefined || f.x < f.g;
}

// ⚠ B33. The same events, delivered in the opposite order, and the outcome is
// identical down to the bytes: which peer reconciles first is not an input to
// anything. Nothing in the rule reads a clock, a device id or an arrival order,
// and the fork's name carries no timestamp — this test is what would notice if
// any of that changed.
test('B33: the concurrent case converges identically whichever peer reconciles first', async () => {
  const first = await runConcurrentReplace('ann-first');
  const second = await runConcurrentReplace('bob-first');

  for (const name of ['ann', 'bob'] as const) {
    assert.deepEqual(
      shareBytes(first[name].vault), shareBytes(second[name].vault),
      `${name} converged on different files depending on who went first`,
    );
    assert.equal(
      stateShape(first[name]), stateShape(second[name]),
      `${name}'s device state depends on the order`,
    );
  }
  assert.equal(treeShape(first.ann.tree), treeShape(second.ann.tree));
  assert.equal(first.putsAfterMerge, second.putsAfterMerge);

  // …and both peers hold the same two files as each other, in both runs.
  assert.deepEqual(shareBytes(first.ann.vault), shareBytes(first.bob.vault));
  assert.deepEqual(shareBytes(second.ann.vault), shareBytes(second.bob.vault));
});

// ------------------------------------------- P2 §3.5: the per-session hash memo
//
// A local hash is computed once per CHANGE, not once per PASS. Everything below
// is about the gap between those two sentences, which is where the plugin spent
// a whole file read and a whole SHA-256 per attachment per pass, for as long as
// anything failed to converge — and four ordinary situations fail to converge
// indefinitely with no error anywhere.
//
// The memo's contract, which every test here is a reading of:
//
//   IT SUBSTITUTES FOR THE HASH AND FOR NOTHING ELSE. No caller branches on
//   whether the hash came from the memo, and nothing returns early on a hit. It
//   may change what a pass COSTS; it may never change what a pass WRITES.

/** The four measured churn entrances, minus the two that need an injected fault. */
interface ChurnWorld {
  /** Bound and published, edited locally, requeued for ever because nothing publishes. */
  churn: string;
  /** Published, UNBOUND, local bytes differ, incoming version over the fetch ceiling. */
  adopt: string;
  /** Converged and confirmed: the control that must stay one stat and no read. */
  quiet: string;
  churnPath: string;
  adoptPath: string;
  edited: Uint8Array;
  editedSha: string;
  baseSha: string;
  /** What a collaborator publishes partway through: new, smaller, fetchable. */
  peer: Uint8Array;
  peerSha: string;
}

/**
 * One vault holding three attachments in three states, none of them an error.
 *
 * Default constants, default server limits, no injected failure and no network
 * fault anywhere: the churn below is what a perfectly healthy share does.
 */
async function seedChurnWorld(h: Harness): Promise<ChurnWorld> {
  h.vault.seed(SHARE, 'd');

  // ENTRANCE A. The user edited a published attachment. §3.5 rule 2 requeues the
  // publish on every pass, and the base deliberately does not advance until the
  // publish confirms (I17) — so while the publish is refused, on a backoff rung,
  // or deferred by I7's open-leaf check, this node re-hashes for ever.
  const original = png(1, 64);
  const baseSha = await h.blobs.seed(original);
  const churn = nid('A');
  const churnPath = await bindBlob(h, churn, 'churn.png', original, {
    sha256: baseSha, bytes: original.length, parent: null,
  }, { sha256: baseSha, len: original.length });
  const edited = png(2, 96);
  h.vault.seedBinary(churnPath, edited);

  // ENTRANCE D, and the widest one. Nothing is bound here, so `ctx.have` does not
  // know this node — which is why a memo pruned to `ctx.have` would close every
  // entrance except this one. The incoming version is merely over the auto-fetch
  // ceiling; `adoptBlob` hashes the local file, cannot fork without fetching, and
  // decides nothing. Next pass, same again.
  const theirs = png(3, 512);
  const theirsSha = await h.blobs.seed(theirs);
  const adopt = nid('B');
  const adoptPath = `${SHARE}/adopt.png`;
  h.nodes.set(adopt, blob('', 'adopt.png', `${theirsSha}:${theirs.length}:-`));
  h.vault.seedBinary(adoptPath, png(4, 200));

  // The control. Converged and confirmed, so the `(len, mtime)` oracle already
  // answers it and the memo must not change its cost either way.
  const still = png(5, 64);
  const stillSha = await h.blobs.seed(still);
  const quiet = nid('C');
  await bindBlob(h, quiet, 'quiet.png', still, {
    sha256: stillSha, bytes: still.length, parent: null,
  }, { sha256: stillSha, len: still.length });

  const peer = png(6, 64);
  const peerSha = await h.blobs.seed(peer);
  return {
    churn, adopt, quiet, churnPath, adoptPath,
    edited, editedSha: await hashOfBytes(edited), baseSha, peer, peerSha,
  };
}

/** A harness wired the way every test in this section wants it. */
function churnHarness(requeued: Requeued[]): Harness {
  return makeHarness({
    // Low enough that the unbound node's 512-byte incoming version is held back,
    // high enough that the 64-byte one a collaborator publishes later is fetched.
    autofetchMaxBytes: () => 100,
    // A spy, so the requeue is observed and the publish never confirms — which is
    // exactly the state a refused publish, a backoff rung and an open leaf leave.
    requeuePublish: (id, intent) => { requeued.push({ id, intent }); },
  });
}

/**
 * ⚠ TEST 0, and the strongest guard on the memo: it changes what a pass COSTS and
 * never what a pass WRITES.
 *
 * Two identical worlds, five identical passes, and the same external events at
 * the same pass index. `warm` keeps one reconciler, so the memo survives between
 * passes; `cold` builds a new one before each pass, so every hash is computed
 * from the file. If the two ever disagree about device state or about the bytes
 * on disk, the memo has started substituting for a VERDICT rather than for a
 * hash — and the verdict it would be substituting for is `replaceVerdict`, whose
 * `fork` arm renames the user's file.
 *
 * This is also why the memo may not be keyed on, or short-circuit around, the
 * incoming reference: pass 3 changes it under both worlds.
 */
test('the hash memo changes what a pass costs and never what it writes', async () => {
  const warmRequeued: Requeued[] = [];
  const coldRequeued: Requeued[] = [];
  const warm = churnHarness(warmRequeued);
  const cold = churnHarness(coldRequeued);
  const wa = await seedChurnWorld(warm);
  const wb = await seedChurnWorld(cold);

  let warmReads = 0;
  let coldReads = 0;
  for (let pass = 0; pass < 5; pass++) {
    // The same collaborator publish, at the same moment, in both worlds.
    if (pass === 2) {
      warm.nodes.set(wa.churn, blob('', 'churn.png', `${wa.peerSha}:${wa.peer.length}:${wa.baseSha}`));
      cold.nodes.set(wb.churn, blob('', 'churn.png', `${wb.peerSha}:${wb.peer.length}:${wb.baseSha}`));
    }
    warm.vault.resetCalls();
    cold.vault.resetCalls();
    const ra = await warm.reconciler.reconcile('sync');
    const rb = await freshSession(cold, {
      autofetchMaxBytes: () => 100,
      requeuePublish: (id, intent) => { coldRequeued.push({ id, intent }); },
    }).reconcile('sync');
    // Trap: a pass that REFUSED reports zero of everything, which is
    // indistinguishable from "no churn" if nobody looks.
    assert.equal(ra.ran, true, `warm pass ${pass} did not run: ${ra.refusedReason}`);
    assert.equal(rb.ran, true, `cold pass ${pass} did not run: ${rb.refusedReason}`);
    assert.deepEqual(ra.failures, [], `warm pass ${pass}`);
    assert.deepEqual(rb.failures, [], `cold pass ${pass}`);
    warmReads += warm.vault.callsTo('readBinary').length;
    coldReads += cold.vault.callsTo('readBinary').length;
  }

  assert.deepEqual(
    JSON.parse(JSON.stringify(warm.state.data)),
    JSON.parse(JSON.stringify(cold.state.data)),
    'the memo changed what the pass RECORDED, which is a bug that renames files',
  );
  assert.deepEqual(
    warm.vault.binarySnapshot(), cold.vault.binarySnapshot(),
    'and the bytes on disk must be identical, forks and all',
  );
  assert.deepEqual(warmRequeued, coldRequeued, 'and the same publishes were asked for');
  assert.deepEqual(warm.notices, cold.notices);
  assert.ok(
    warmReads < coldReads,
    `the memo saved nothing: ${warmReads} reads warm against ${coldReads} cold`,
  );
});

/**
 * ⚠ TEST 1 — churn entrance A, alone and counted: the republish that never
 * confirms.
 *
 * The memo is a CACHE, not a suppressor. The requeue must still happen on every
 * pass — §3.5 rule 2 says so, and the publish ladder relies on it — and the base
 * must NOT advance, because `contentHash` is I17's base and advancing it to a
 * local hash flips `replaceVerdict` from `republish` to `fork`.
 */
test('a publish that never confirms hashes its file once, not once per pass', async () => {
  const requeued: Requeued[] = [];
  const h = churnHarness(requeued);
  const w = await seedChurnWorld(h);

  const reads: number[] = [];
  for (let pass = 0; pass < 5; pass++) {
    h.vault.resetCalls();
    const r = await h.reconciler.reconcile('sync');
    assert.equal(r.ran, true, `pass ${pass} did not run: ${r.refusedReason}`);
    assert.deepEqual(r.failures, [], `pass ${pass}`);
    reads.push(h.vault.callsTo('readBinary').length);
  }

  assert.deepEqual(
    reads.map((n) => n > 0), [true, false, false, false, false],
    'the file is read on the pass that first sees the change, and never again',
  );
  assert.deepEqual(
    requeued.filter((q) => q.id === w.churn),
    Array.from({ length: 5 }, () => ({ id: w.churn, intent: w.editedSha })),
    'and the requeue still happens every pass: this is a cache, not a suppressor',
  );
  assert.deepEqual(
    h.state.data.contentHash[w.churn],
    { sha256: w.baseSha, len: 64, mtime: h.state.data.contentHash[w.churn]!.mtime },
    'the base still names what is simultaneously on disk and in the tree (I17)',
  );
  assert.deepEqual(
    h.vault.binarySnapshot()[w.churnPath], w.edited,
    'and the file the user edited is exactly as they left it',
  );
});

/**
 * ⚠ TEST 2 — churn entrance D: the `adoptBlob` that never binds.
 *
 * The widest entrance, and the one a memo wired only into `hashWithBudget` misses
 * entirely: `adoptBlob` has its own cap check and its own inline read. It is also
 * the reason the memo is pruned to `ctx.blobRefs` and never to `ctx.have` — this
 * node is not in `ctx.have`, because nothing is bound to it.
 *
 * Default memory cap, default server limits, no `setLimits`, no publish, no
 * injected failure. Nothing here is broken; this is what a healthy share does.
 */
test('an adopt that cannot fork hashes its file once, not once per pass', async () => {
  const requeued: Requeued[] = [];
  const h = churnHarness(requeued);
  const w = await seedChurnWorld(h);

  const reads: number[] = [];
  for (let pass = 0; pass < 5; pass++) {
    h.vault.resetCalls();
    const r = await h.reconciler.reconcile('sync');
    assert.equal(r.ran, true, `pass ${pass} did not run: ${r.refusedReason}`);
    assert.deepEqual(r.failures, [], `pass ${pass}`);
    reads.push(h.vault.callsTo('readBinary').length);
    assert.ok(
      r.diagnostics.deferred.includes(w.adopt),
      `pass ${pass} forgot the outstanding download — the memo must not silence the status bar`,
    );
  }

  assert.deepEqual(
    reads, [2, 0, 0, 0, 0],
    'two files read on the first pass — the edited one and this one — and nothing after',
  );
  assert.equal(h.state.data.materialized[w.adopt], undefined, 'still unbound: nothing was claimed');
  assert.equal(h.state.data.contentHash[w.adopt], undefined, 'and no base was invented');
  assert.equal(mutations(h.vault), 0, 'and adopting decided nothing, so it wrote nothing');
});

/**
 * ⚠ TEST 3 — the memo never skips a verdict. Write this one first.
 *
 * `replaceVerdict(local, ref, base)` takes the INCOMING reference as an input. A
 * record keyed on the local file that returned early on a hit would strand this
 * device on its own version for ever, because the thing that changed is not the
 * thing the memo remembers.
 */
test('a warm memo still reaches the verdict when the collaborator publishes', async () => {
  const requeued: Requeued[] = [];
  const h = churnHarness(requeued);
  const w = await seedChurnWorld(h);

  // Warm: two quiet passes with the file untouched.
  await h.reconciler.reconcile('sync');
  h.vault.resetCalls();
  await h.reconciler.reconcile('sync');
  assert.equal(h.vault.callsTo('readBinary').length, 0, 'the memo really is warm');

  // A collaborator replaces it with a new, smaller, fetchable version. The local
  // file does not change at all, so nothing the memo remembers is any different.
  h.nodes.set(w.churn, blob('', 'churn.png', `${w.peerSha}:${w.peer.length}:${w.baseSha}`));
  h.vault.resetCalls();
  const r = await h.reconciler.reconcile('sync');

  assert.equal(r.ran, true);
  assert.deepEqual(r.failures, []);
  const disk = h.vault.binarySnapshot();
  assert.deepEqual(disk[w.churnPath], w.peer, "the collaborator's version is at the canonical path");
  const forked = Object.keys(disk).filter(
    (p) => p.startsWith(`${SHARE}/`) && p.includes('churn') && p !== w.churnPath,
  );
  assert.equal(forked.length, 1, 'and the user\'s bytes survive under a fork name');
  assert.deepEqual(disk[forked[0]], w.edited);
  assert.deepEqual(stashed(h.vault), {}, 'nothing was exiled to ShadowLink Recovered/');
  assert.equal(h.state.data.contentHash[w.churn]?.sha256, w.peerSha, 'the base advanced (I17)');
});

/**
 * ⚠ TEST 4 — the memo dies on a change.
 *
 * Its trust is the same two-clause `(len, mtime)` oracle the staleness check
 * already uses, over a strictly shorter window: it lives in memory only, so a
 * restart re-derives everything from the disk and the tree.
 */
test('a warm memo is dropped the moment the file changes, and the new bytes are hashed', async () => {
  const requeued: Requeued[] = [];
  const h = churnHarness(requeued);
  const w = await seedChurnWorld(h);

  await h.reconciler.reconcile('sync');
  h.vault.resetCalls();
  await h.reconciler.reconcile('sync');
  assert.equal(h.vault.callsTo('readBinary').length, 0, 'the memo really is warm');

  const again = png(7, 128);
  h.vault.seedBinary(w.churnPath, again);
  requeued.length = 0;
  h.vault.resetCalls();
  const r = await h.reconciler.reconcile('sync');

  assert.equal(r.ran, true);
  assert.deepEqual(r.failures, []);
  assert.equal(h.vault.callsTo('readBinary').length, 1, 'exactly one file was re-read');
  assert.deepEqual(
    requeued.filter((q) => q.id === w.churn),
    [{ id: w.churn, intent: await hashOfBytes(again) }],
    'and the verdict was reached against the bytes that are actually there',
  );
});

/**
 * The memo is per-session, and this is what keeps it from rotting: a restart
 * re-derives everything from the disk and the tree, which is what makes I8
 * literally true. Nothing about it is persisted, so `DeviceState` cannot carry a
 * hash nobody confirmed across a crash.
 */
test('the hash memo does not survive a restart, and no part of it is persisted', async () => {
  const requeued: Requeued[] = [];
  const h = churnHarness(requeued);
  const w = await seedChurnWorld(h);

  await h.reconciler.reconcile('sync');
  h.vault.resetCalls();
  await h.reconciler.reconcile('sync');
  assert.equal(h.vault.callsTo('readBinary').length, 0);

  const serialized = JSON.stringify(h.state.data);
  assert.ok(!serialized.includes(w.editedSha), 'an unconfirmed local hash was persisted');

  // A new session over the same vault, store, state and tree.
  h.vault.resetCalls();
  const restarted = await freshSession(h, {
    autofetchMaxBytes: () => 100,
    requeuePublish: (id, intent) => { requeued.push({ id, intent }); },
  }).reconcile('sync');

  assert.equal(restarted.ran, true);
  assert.equal(
    h.vault.callsTo('readBinary').length, 2,
    'a restart looks at the files again rather than trusting a cache it cannot check',
  );
});

// ----------------------------------- §7.5: a local file this device cannot check

/**
 * ⚠ THE FOURTH STATE, and the only one no surface had a word for.
 *
 * `tooLarge` has three writers and they do not mean the same thing. `mayFetch`
 * means "the bytes are not on this disk" — which is why `fetchTooLarge` was split
 * out of it, so the status bar would stop calling a downloaded attachment
 * missing. The other two, here and in `adoptBlob`, mean the opposite: the file IS
 * on this disk, complete, and only this device's QUESTION about it is unanswered.
 *
 * That state is not harmless and it was completely silent. The pass reaches no
 * verdict, so an edit to the file is never noticed and never published, and
 * nothing anywhere says so — not a notice, not the status bar, not the download
 * command, which would be the wrong place anyway because there is nothing to
 * download.
 */
test('a local attachment this device cannot hash is reported apart from the missing ones', async () => {
  const h = makeHarness({ memoryCapBytes: () => 32 });
  h.vault.seed(SHARE, 'd');
  const onDisk = png(3, 512);
  const sha = await h.blobs.seed(png(4, 512));                  // the tree names something else
  const id = nid('A');
  // The tree's version is a DIFFERENT size from the one on disk, deliberately: if
  // both were 512 the surface below could read either number and still look right.
  const path = await bindBlob(h, id, 'clip.mov', onDisk, { sha256: sha, bytes: 256, parent: null });

  const r = await h.reconciler.reconcile('sync');

  assert.equal(r.ran, true);
  assert.deepEqual(r.failures, [], 'this is a fact about the device, not an error');
  assert.deepEqual(
    r.diagnostics.localTooLarge, [{ id, bytes: onDisk.length }],
    'the LOCAL size, not the tree\'s: they describe different versions of the file',
  );
  assert.deepEqual(r.diagnostics.tooLarge, [id], 'and the old channel is unchanged');
  assert.deepEqual(
    r.diagnostics.fetchTooLarge, [],
    'reporting this as missing is the exact error fetchTooLarge was split out to avoid',
  );
  assert.deepEqual(h.reconciler.tooLargeAttachments, [], 'so no "not downloaded" list names it');
  assert.deepEqual(h.reconciler.uncheckableAttachments, [{
    id, path, sha256: sha, bytes: onDisk.length,
  }]);
  assert.deepEqual(
    h.vault.binarySnapshot()[path], onDisk,
    'and the user\'s file is exactly where they left it',
  );
});

// The `adoptBlob` arm of the same thing: an unbound local file the device cannot
// hash. A memo cannot help here and neither can a download — the bytes are here,
// and the only missing thing is this device's ability to look at them.
test('an unbound local attachment over the cap is reported the same way', async () => {
  const h = makeHarness({ memoryCapBytes: () => 32 });
  h.vault.seed(SHARE, 'd');
  const theirs = png(5, 16);                                    // small: the FETCH is fine
  const theirsSha = await h.blobs.seed(theirs);
  const id = nid('A');
  const path = `${SHARE}/clip.mov`;
  h.nodes.set(id, blob('', 'clip.mov', `${theirsSha}:${theirs.length}:-`));
  const mine = png(6, 512);
  h.vault.seedBinary(path, mine);

  // A first pass with nothing bound is exactly the shape `mountMismatch` reads as
  // a wrong mount, and a refused pass reports zero of everything — which looks
  // identical to "nothing to report" unless `ran` is checked.
  const r = await h.reconciler.reconcile('bootstrap');

  assert.equal(r.ran, true, r.refusedReason);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.diagnostics.localTooLarge, [{ id, bytes: mine.length }]);
  assert.deepEqual(r.diagnostics.tooLarge, [id]);
  assert.deepEqual(r.diagnostics.fetchTooLarge, [], 'nothing here is a refused download');
  assert.equal(h.state.data.materialized[id], undefined, 'nothing was bound');
  assert.deepEqual(h.vault.binarySnapshot()[path], mine, 'and nothing was touched');
});

// It is a PASSIVE surface, deliberately. The condition lasts as long as the file
// and the device do, so a notice would be a notice every pass for ever — which is
// how a user learns to dismiss notices without reading them.
test('the uncheckable bucket is re-derived every pass and never becomes a notice', async () => {
  const h = makeHarness({ memoryCapBytes: () => 32 });
  h.vault.seed(SHARE, 'd');
  const sha = await h.blobs.seed(png(4, 512));
  const id = nid('A');
  await bindBlob(h, id, 'clip.mov', png(3, 512), { sha256: sha, bytes: 512, parent: null });

  for (let pass = 0; pass < 5; pass++) {
    const r = await h.reconciler.reconcile('sync');
    assert.equal(r.ran, true, `pass ${pass} did not run: ${r.refusedReason}`);
    assert.deepEqual(r.diagnostics.localTooLarge, [{ id, bytes: 512 }], `pass ${pass}`);
    assert.equal(h.reconciler.uncheckableAttachments.length, 1, `pass ${pass}`);
  }
  assert.deepEqual(h.notices, [], 'five passes and not one popup');

  // And it stops being reported the moment it stops being true.
  h.nodes.delete(id);
  const r = await h.reconciler.reconcile('sync');
  assert.deepEqual(r.diagnostics.localTooLarge, []);
  assert.deepEqual(h.reconciler.uncheckableAttachments, []);
});
