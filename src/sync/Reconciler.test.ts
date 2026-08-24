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
import { fold } from '../tree/paths.ts';
import { Deletions, type BulkChoice, type BulkSummary } from './Deletions.ts';
import { DeviceState, type StatePort } from './DeviceState.ts';
import { FakeDocs, FakeVault } from './fakes.ts';
import { Reconciler, RetryLater, type ReconcilerDeps, type DeletionContext } from './Reconciler.ts';
import { Tickets } from './Tickets.ts';
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
    create: (p, d) => inner.create(p, d),
    createFolder: (p) => inner.createFolder(p),
    rename: (f, t) => inner.rename(f, t),
    trashLocal: (p) => inner.trashLocal(p),
    isOpenInLeaf: (p) => inner.isOpenInLeaf(p),
  };
  return { ...base, ...overrides };
}

interface Harness {
  vault: FakeVault;
  docs: FakeDocs;
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
    state,
    tickets,
    shareRoot: SHARE,
    entries: () => [...nodes],
    publishUntracked: async (paths) => { published.push(paths); },
    notice: (m) => { notices.push(m); },
    now,
    ...over,
  });

  return { vault, docs, state, tickets, port, nodes, reconciler, published, notices, log };
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
    vault: crashing, docs, state, tickets: new Tickets(() => NOW), shareRoot: SHARE,
    entries: () => [...nodes], now: () => NOW,
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
    vault: inner, docs, state: restarted, tickets: new Tickets(() => NOW),
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
