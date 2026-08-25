// src/sync/Bootstrap.test.ts
//
// Spec §4.5 (first join) and §4.6 (reconnect).
//
// Bootstrap is the one moment where the plugin has the LEAST evidence and the
// MOST power: no device state, a tree it has never seen, and a vault full of the
// user's real notes. Every test below is about a way that combination goes wrong.
//
//  I3 — never act on an unsynced tree. A timeout is not a sync, and a client that
//       bootstraps on one reads an empty workspace as "nothing is shared".
//  I2 — classification touches nothing. Absence of evidence is never a delete,
//       and the user has not agreed to anything yet.
//  §4.5 step 5 — the founder claim is a LATENCY optimization. Losing it must be
//       harmless, which is only true if adoption merges rather than duplicates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';

import { deriveTree } from '../tree/TreeIndex.ts';
import { fold } from '../tree/paths.ts';
import { TreeDoc } from '../tree/TreeDoc.ts';
import {
  Bootstrap,
  type BootstrapConfirmation,
  type BootstrapDecision,
  type BootstrapDeps,
} from './Bootstrap.ts';
import { DeviceState, deviceStateKey, type StatePort } from './DeviceState.ts';
import {
  DESKTOP_FETCH_LIMITS, DESKTOP_PASS_LIMITS, FakeBlobs, FakeVault,
} from './fakes.ts';
import { Reconciler } from './Reconciler.ts';
import { Tickets } from './Tickets.ts';

// ---------------------------------------------------------------- fixtures

const SHARE = 'Shared';
const NOW = 1_700_000_000_000;
const DEVICE = 'device-1';
const WORKSPACE = 'ws-1';

class MemoryStatePort implements StatePort {
  readonly store = new Map<string, string>();
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
  tree: TreeDoc;
  state: DeviceState;
  port: MemoryStatePort;
  boot: Bootstrap;
  notices: string[];
  confirms: BootstrapConfirmation[];
  reconciles: string[];
  replays: number;
  /** Tree transactions observed since the harness was built. */
  treeWrites: () => number;
  /** `tombstonesEnabled` sampled inside the bootstrap reconcile. */
  tombstonesDuringReconcile: boolean | null;
}

interface Options {
  synced?: boolean;
  decision?: BootstrapDecision;
  snapshot?: Uint8Array | null;
  deps?: Partial<BootstrapDeps>;
}

function makeHarness(options: Options = {}): Harness {
  const vault = new FakeVault();
  const tree = new TreeDoc();
  const port = new MemoryStatePort();
  const state = new DeviceState(port, DEVICE, WORKSPACE, () => NOW, 0);
  const notices: string[] = [];
  const confirms: BootstrapConfirmation[] = [];
  const reconciles: string[] = [];
  vault.seed(SHARE, 'd');

  let writes = 0;
  tree.doc.on('update', () => { writes += 1; });

  const h = {
    vault, tree, state, port, notices, confirms, reconciles,
    replays: 0,
    treeWrites: () => writes,
    tombstonesDuringReconcile: null as boolean | null,
  } as Harness;

  h.boot = new Bootstrap({
    state,
    tree,
    vault,
    shareRoot: SHARE,
    deviceId: DEVICE,
    loadSnapshot: async () => options.snapshot ?? null,
    connectTree: async () => options.synced ?? true,
    confirm: async (c) => {
      confirms.push(c);
      return options.decision ?? { proceed: true, shareLocalFiles: true };
    },
    reconcile: async (cause) => {
      reconciles.push(cause);
      h.tombstonesDuringReconcile = h.boot.tombstonesEnabled;
    },
    replayPendingEvents: async () => { h.replays += 1; },
    notice: (msg) => { notices.push(msg); },
    now: () => NOW,
    sleep: async () => undefined,
    founderWaitCapMs: 20,
    ...DESKTOP_FETCH_LIMITS,
    ...options.deps,
  });

  return h;
}

/** Persist a state file this device WILL trust, so the run is a warm start. */
function warmState(port: MemoryStatePort, over: Record<string, unknown> = {}): void {
  port.store.set(deviceStateKey(WORKSPACE, DEVICE), JSON.stringify({
    v: 1, deviceId: DEVICE, workspaceId: WORKSPACE,
    materialized: {}, owned: {}, publish: {}, contentHash: {},
    declinedNodes: [], declinedPaths: [], deleteBudget: [], staging: {},
    ...over,
  }));
}

/** A live, seeded file node at `Shared/<name>`. */
function seededNode(tree: TreeDoc, rel: string): string {
  const i = rel.lastIndexOf('/');
  const d = i === -1 ? '' : rel.slice(0, i);
  const n = i === -1 ? rel : rel.slice(i + 1);
  return tree.createNode({ k: 'f', d, n, s: 1 }, NOW);
}

/**
 * A live, published attachment node whose reference CLAIMS `bytes`.
 *
 * The size rides in the tree, so a classification can talk about gigabytes
 * without any test ever allocating one — which is exactly why the first-sync
 * modal can tell the user what 3 GB means before it starts.
 */
function blobNode(tree: TreeDoc, rel: string, bytes: number): string {
  const i = rel.lastIndexOf('/');
  const d = i === -1 ? '' : rel.slice(0, i);
  const n = i === -1 ? rel : rel.slice(i + 1);
  return tree.createNode({ k: 'b', d, n, s: 1, b: `${'a'.repeat(64)}:${bytes}:-` }, NOW);
}

function mutations(vault: FakeVault): number {
  return vault.calls.filter(
    (c) => c.op === 'create' || c.op === 'createFolder' || c.op === 'rename' || c.op === 'trashLocal',
  ).length;
}

// ================================================================ step 7

test('classification sorts every path and node into the four buckets and touches nothing', async () => {
  const h = makeHarness();

  const adopted = seededNode(h.tree, 'adopt me.md');
  h.vault.seed(`${SHARE}/adopt me.md`, 'f', 'local bytes');

  const missing = seededNode(h.tree, 'notes/download me.md');
  h.tree.createNode({ k: 'd', d: '', n: 'notes' }, NOW);

  const unpublished = h.tree.createNode({ k: 'f', d: '', n: 'someone elses.md' }, NOW);

  h.vault.seed(`${SHARE}/mine.md`, 'f', 'never shared before');
  h.vault.seed(`${SHARE}/notes/also mine.md`, 'f', 'nested');

  const result = await h.boot.run();

  assert.equal(result.outcome, 'ready');
  assert.deepEqual([...result.buckets.adopt], [[adopted, `${SHARE}/adopt me.md`]]);
  assert.deepEqual([...result.buckets.download], [[missing, `${SHARE}/notes/download me.md`]]);
  assert.deepEqual(result.buckets.upload, [`${SHARE}/mine.md`, `${SHARE}/notes/also mine.md`]);
  assert.deepEqual(result.buckets.pending, [unpublished]);

  // The classification runs BEFORE the confirmation, so at the moment the user
  // is asked, nothing whatsoever has been done to their vault (I2).
  //
  // CHANGED IN P2-e: `stat` joins the allowed reads. §7.5 requires the modal to
  // state the byte total of the local files about to be uploaded, and `list()`
  // reports paths and kinds and no sizes — so one `stat` per upload candidate is
  // the only way to answer it. It is a READ: the property this assertion is about
  // is unchanged, and it is now also asserted directly.
  assert.equal(h.confirms.length, 1);
  assert.equal(mutations(h.vault), 0, 'a plan is not a mutation');
  const reads = new Set(['list', 'exists', 'listDir', 'stat']);
  assert.equal(
    h.vault.calls.findIndex((c) => !reads.has(c.op)),
    -1,
    JSON.stringify(h.vault.calls),
  );
});

test('B30: notes and attachments are counted separately, with byte totals', async () => {
  const h = makeHarness({ deps: { memoryCapBytes: () => 1_000 } });

  // Two notes to download (no size: a note's bytes live in a doc that has not
  // synced yet, and inventing one would be a claim this pass cannot support).
  seededNode(h.tree, 'theirs.md');
  seededNode(h.tree, 'notes/more.md');
  // One attachment this device will fetch, and one it will not: over the memory
  // cap is a per-device refusal, so the count the user is shown has to say so.
  blobNode(h.tree, 'small.png', 400);
  blobNode(h.tree, 'huge.mov', 5_000);
  // Local files of both kinds, whose sizes are on disk and therefore knowable.
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'abcde');            // 5 bytes
  h.vault.seedBinary(`${SHARE}/scan.png`, new Uint8Array(64));

  const result = await h.boot.run();
  const b = result.buckets;

  assert.deepEqual(b.downloadNotes, { count: 2, bytes: 0 });
  assert.deepEqual(b.downloadNow, { count: 1, bytes: 400 });
  assert.deepEqual(b.downloadDeferred, { count: 1, bytes: 5_000 });
  assert.deepEqual(b.uploadNotes, { count: 1, bytes: 5 });
  assert.deepEqual(b.uploadAttachments, { count: 1, bytes: 64 });

  // The union is still what the confirmation acts on, so nothing is lost between
  // the counts the user reads and the decision they take.
  assert.deepEqual(b.upload, [`${SHARE}/mine.md`, `${SHARE}/scan.png`]);
  assert.equal(b.download.size, 4, 'every live seeded node is still downloadable');
  assert.deepEqual(h.confirms[0].uploadAttachments, { count: 1, bytes: 64 });
});

/** Real bytes in the store, and the node that names them. Sized to order. */
async function realBlobNode(
  tree: TreeDoc,
  blobs: FakeBlobs,
  rel: string,
  length: number,
  seed: number,
): Promise<string> {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = (i * 31 + seed * 97) & 0xff;
  const sha = await blobs.seed(data);
  const i = rel.lastIndexOf('/');
  const d = i === -1 ? '' : rel.slice(0, i);
  const n = i === -1 ? rel : rel.slice(i + 1);
  return tree.createNode({ k: 'b', d, n, s: 1, b: `${sha}:${length}:-` }, NOW);
}

// ⚠ B25/B30. The modal's honesty rests entirely on this: `classify` splitting on
// a different rule from the one `materialize` applies makes its counts a guess,
// and the user is told 412 attachments will arrive while 40 do. So both sides ask
// the SAME pure predicate, in the SAME ascending byte order — and this test runs
// a real reconcile pass over the same tree and the same store to prove it, rather
// than asserting the arithmetic twice.
test('B25: the download split is the predicate the pass will actually apply', async () => {
  const blobs = new FakeBlobs();
  const limits = {
    memoryCapBytes: () => 10_000,
    autofetchMaxBytes: () => 1_000,
    sessionBudgetBytes: () => 900,
  };
  let reconciler: Reconciler | null = null;
  const h = makeHarness({
    deps: {
      ...limits,
      sessionSpentBytes: () => reconciler?.fetchedThisSession ?? 0,
      reconcile: async (cause) => { await reconciler!.reconcile(cause); },
    },
  });
  reconciler = new Reconciler({
    ...DESKTOP_PASS_LIMITS,
    vault: h.vault,
    docs: { openHeadless: async () => { throw new Error('no note is involved'); } } as never,
    blobs,
    state: h.state,
    tickets: new Tickets(() => NOW),
    shareRoot: SHARE,
    entries: () => h.tree.entries(),
    now: () => NOW,
    ...limits,
  });

  // Ascending byte order: 400 fits, 600 then overruns the 900-byte session
  // budget, and 5,000 is over the per-file ceiling before the budget is reached.
  await realBlobNode(h.tree, blobs, 'a.png', 400, 1);
  await realBlobNode(h.tree, blobs, 'b.png', 600, 2);
  await realBlobNode(h.tree, blobs, 'c.png', 5_000, 3);

  const b = (await h.boot.run()).buckets;

  assert.deepEqual(b.downloadNow, { count: 1, bytes: 400 });
  assert.deepEqual(b.downloadDeferred, { count: 2, bytes: 5_600 });

  // …and the pass that followed did exactly what the modal said it would.
  const landed = h.vault.list()
    .filter((e) => e.kind === 'f' && e.path.startsWith(`${SHARE}/`))
    .map((e) => e.path);
  assert.deepEqual(landed, [`${SHARE}/a.png`], 'one file, the one the user was promised');
});

// The gate the memory cap alone cannot express. A share of ten-megabyte scans
// passes every per-file check on a desktop and still costs a data plan, so the
// ceiling has to be able to defer a file the device could perfectly well hold.
test('B25: an attachment over the auto-fetch ceiling counts as deferred, not as "now"', async () => {
  const h = makeHarness({
    deps: { memoryCapBytes: () => 1_000_000, autofetchMaxBytes: () => 1_000 },
  });
  blobNode(h.tree, 'scan.png', 4_000);

  const b = (await h.boot.run()).buckets;

  assert.deepEqual(b.downloadNow, { count: 0, bytes: 0 });
  assert.deepEqual(b.downloadDeferred, { count: 1, bytes: 4_000 });
});

test('B30: unchecking "share my local files" declines BOTH upload buckets', async () => {
  const h = makeHarness({ decision: { proceed: true, shareLocalFiles: false } });
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'a note');
  h.vault.seedBinary(`${SHARE}/scan.png`, new Uint8Array(32));

  const result = await h.boot.run();

  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.buckets.uploadNotes.count, 1);
  assert.deepEqual(result.buckets.uploadAttachments.count, 1);
  assert.deepEqual(
    h.state.data.declinedPaths,
    [fold(`${SHARE}/mine.md`), fold(`${SHARE}/scan.png`)],
    'an attachment nobody declined would be uploaded on the very next pass',
  );
});

test('B30: a workspace with no attachments reports empty attachment buckets', async () => {
  const h = makeHarness();
  seededNode(h.tree, 'theirs.md');
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'x');

  const b = (await h.boot.run()).buckets;

  assert.deepEqual(b.downloadNow, { count: 0, bytes: 0 });
  assert.deepEqual(b.downloadDeferred, { count: 0, bytes: 0 });
  assert.deepEqual(b.uploadAttachments, { count: 0, bytes: 0 });
  assert.deepEqual(b.downloadNotes, { count: 1, bytes: 0 });
});

test('the buckets are ordered by node id and by path, whatever order the tree yields', async () => {
  // The counts and lists end up in a modal, in diagnostics and in the device
  // state file, all of which are compared byte for byte across runs. Yjs makes
  // no promise about the order it hands nodes back.
  const h = makeHarness();
  const ids: string[] = [];
  for (const name of ['c.md', 'a.md', 'b.md']) {
    ids.push(seededNode(h.tree, name));
    h.vault.seed(`${SHARE}/${name}`, 'f', name);
  }
  h.vault.seed(`${SHARE}/zz.md`, 'f', 'mine');
  h.vault.seed(`${SHARE}/aa.md`, 'f', 'mine');

  const result = await h.boot.run();

  assert.deepEqual([...result.buckets.adopt.keys()], [...ids].sort());
  assert.deepEqual(result.buckets.upload, [`${SHARE}/aa.md`, `${SHARE}/zz.md`]);
});

test('the schema version is written once the client is allowed to touch the tree', async () => {
  const h = makeHarness();
  assert.equal(h.tree.getMeta()?.v, undefined);

  await h.boot.run();

  assert.equal(h.tree.getMeta()?.v, 2);
});

test("a dead node's last path is never offered for upload (I13)", async () => {
  const h = makeHarness();
  h.tree.createNode({ k: 'f', d: '', n: 'deleted.md', s: 1, g: 1, x: 1, xa: NOW }, NOW);
  h.vault.seed(`${SHARE}/deleted.md`, 'f', 'still on disk');

  const result = await h.boot.run();

  assert.deepEqual(result.buckets.upload, [], 'republishing would undo the delete');
});

test("an unseeded node's path is never offered for upload", async () => {
  // The node already exists; offering its path would fork it into a second node
  // at the same place instead of letting the author publish.
  const h = makeHarness();
  h.tree.createNode({ k: 'f', d: '', n: 'theirs.md' }, NOW);
  h.vault.seed(`${SHARE}/theirs.md`, 'f', 'my own file with the same name');

  const result = await h.boot.run();

  assert.deepEqual(result.buckets.upload, []);
});

test('a path already declined is never offered for upload again', async () => {
  const h = makeHarness();
  h.vault.seed(`${SHARE}/kept.md`, 'f', 'mine');
  warmState(h.port, { declinedPaths: [fold(`${SHARE}/kept.md`)] });

  const result = await h.boot.run();

  assert.deepEqual(result.buckets.upload, []);
});

// CHANGED IN P2-c. This test used to assert that `diagram.png` was NOT offered
// for upload, because P1 shared markdown only and `classify` hardcoded
// `validateRel(d, n, 'f')`. P2 shares attachments, so an image under the share is
// now a `'b'` node the user is told about — dropping it on the floor is exactly
// what spec §7.5 names as the bug this hardcoded kind caused. The refusal the
// test is really about is still asserted, with a path P2 also refuses.
test('a local file the path filter rejects is never offered for upload', async () => {
  const h = makeHarness();
  h.vault.seed(`${SHARE}/setup.exe`, 'f', 'MZ');             // §2.3: refused in both kinds
  h.vault.seed(`${SHARE}/diagram.png`, 'f', 'binary');
  h.vault.seed(`${SHARE}/notes.md`, 'f', 'fine');

  const result = await h.boot.run();

  assert.deepEqual(
    result.buckets.upload,
    [`${SHARE}/diagram.png`, `${SHARE}/notes.md`],
    'the attachment is classified with the tree kind its path derives, never as markdown',
  );
});

// ================================================================ I3 — step 4

test('a tree that never syncs yields read-only, zero mutations and zero tree writes (I3)', async () => {
  const h = makeHarness({ synced: false });
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'local');

  const result = await h.boot.run();

  assert.equal(result.outcome, 'readonly');
  assert.equal(h.boot.phase, 'readonly');
  assert.ok(h.boot.readOnlyReason !== null);
  assert.equal(mutations(h.vault), 0);
  assert.equal(h.treeWrites(), 0, 'not one byte was written to the tree');
  assert.deepEqual(h.confirms, [], 'and the user was never asked to agree to anything');
  assert.deepEqual(h.reconciles, []);
  assert.equal(h.replays, 0);
  assert.ok(h.notices.length > 0, 'the read-only state is surfaced');
});

test('a connect attempt that THROWS is a failure to sync, never a licence to bootstrap', async () => {
  const h = makeHarness({
    deps: { connectTree: async () => { throw new Error('ECONNREFUSED'); } },
  });
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'local');

  const result = await h.boot.run();

  assert.equal(result.outcome, 'readonly');
  assert.equal(h.treeWrites(), 0);
  assert.equal(mutations(h.vault), 0);
  assert.deepEqual(h.confirms, []);
  assert.deepEqual(h.reconciles, []);
});

test('the share-relative path is taken by segment count, not by string length', async () => {
  // SD-5. `fold` is `toLowerCase` on an NFC string, and case mapping is not
  // length-preserving: `İstanbul` (8) folds to the same key as `i̇stanbul` (9).
  // Slicing `root.length + 1` characters off the real disk path therefore lands
  // one character short and produces `/note.md`, which no filter recognises and
  // no vault call can use.
  const root = 'İstanbul';                       // İstanbul
  const onDisk = 'i̇stanbul';                    // the same folder, lowercased
  assert.equal(fold(root), fold(onDisk));
  assert.notEqual(root.length, onDisk.length);

  const h = makeHarness({ deps: { shareRoot: root } });
  h.vault.seed(`${onDisk}/sub/note.md`, 'f', 'mine');

  const result = await h.boot.run();

  assert.deepEqual(result.buckets.upload, [`${onDisk}/sub/note.md`]);
});

test('a share root configured with a trailing slash still classifies', async () => {
  const h = makeHarness({ deps: { shareRoot: `${SHARE}/` } });
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'local');
  const id = seededNode(h.tree, 'theirs.md');

  const result = await h.boot.run();

  assert.deepEqual(result.buckets.upload, [`${SHARE}/mine.md`]);
  assert.deepEqual([...result.buckets.download], [[id, `${SHARE}/theirs.md`]]);
});

test('a future schema stops before the provider is even connected', async () => {
  let connects = 0;
  const h = makeHarness({ deps: { connectTree: async () => { connects += 1; return true; } } });
  h.tree.doc.getMap('meta').set('v', 3);

  const result = await h.boot.run();

  assert.equal(result.outcome, 'readonly');
  assert.equal(h.boot.phase, 'readonly');
  assert.equal(connects, 0);
  assert.equal(mutations(h.vault), 0);
});

test('a future schema is never retried on reconnect', async () => {
  const h = makeHarness();
  h.tree.doc.getMap('meta').set('v', 3);
  await h.boot.run();

  const again = await h.boot.onReconnect();

  assert.equal(again.outcome, 'readonly');
  assert.equal(h.boot.phase, 'readonly');
  assert.deepEqual(h.reconciles, []);
});

// ================================================================ steps 1-2

test('device state written by another device cold-starts', async () => {
  const h = makeHarness();
  h.port.store.set(deviceStateKey(WORKSPACE, DEVICE), JSON.stringify({
    v: 1,
    deviceId: 'some-other-laptop',
    workspaceId: WORKSPACE,
    materialized: { abc: `${SHARE}/somewhere else.md` },
    owned: { abc: true },
    publish: {}, contentHash: {},
    declinedNodes: [], declinedPaths: [], deleteBudget: [], staging: {},
  }));

  const result = await h.boot.run();

  assert.equal(result.coldStart, true);
  assert.deepEqual(h.state.data.materialized, {}, "another machine's layout is not replayed");
  assert.deepEqual(h.state.data.owned, {});
  assert.equal(h.confirms.length, 1, 'a cold start always asks');
});

test('the local tree snapshot is loaded before the provider is connected', async () => {
  const offline = new TreeDoc();
  seededNode(offline, 'from the snapshot.md');
  const snapshot = offline.encodeState();

  let sizeAtConnect = -1;
  const h = makeHarness({
    snapshot,
    deps: { connectTree: async () => { sizeAtConnect = 0; return true; } },
  });
  // Capture the tree size the instant the provider is asked to connect.
  const boot = new Bootstrap({
    state: h.state, tree: h.tree, vault: h.vault, shareRoot: SHARE, deviceId: DEVICE,
    loadSnapshot: async () => snapshot,
    connectTree: async () => { sizeAtConnect = h.tree.size(); return true; },
    confirm: async () => ({ proceed: true, shareLocalFiles: true }),
    reconcile: async () => undefined,
    replayPendingEvents: async () => undefined,
    now: () => NOW,
    sleep: async () => undefined,
    ...DESKTOP_FETCH_LIMITS,
  });

  await boot.run();

  assert.equal(sizeAtConnect, 1, 'the offline baseline is in place first');
});

test('a corrupt local snapshot does not abort boot', async () => {
  const h = makeHarness({ snapshot: new Uint8Array([9, 9, 9, 9, 9]) });
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'local');

  const result = await h.boot.run();

  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.buckets.upload, [`${SHARE}/mine.md`]);
  assert.ok(h.notices.some((n) => n.toLowerCase().includes('snapshot')), h.notices.join('|'));
});

// ================================================================ step 8

test('declining the upload bucket routes every path to declinedPaths', async () => {
  const h = makeHarness({ decision: { proceed: true, shareLocalFiles: false } });
  h.vault.seed(`${SHARE}/one.md`, 'f', 'a');
  h.vault.seed(`${SHARE}/Two.md`, 'f', 'b');

  const result = await h.boot.run();

  assert.equal(result.outcome, 'ready');
  assert.deepEqual(h.state.data.declinedPaths, [fold(`${SHARE}/one.md`), fold(`${SHARE}/Two.md`)]);
  assert.equal(h.boot.phase, 'ready', 'declining to share is not declining to sync');
  assert.deepEqual(h.reconciles, ['bootstrap']);
});

test('cancelling the confirmation stops everything', async () => {
  const h = makeHarness({ decision: { proceed: false, shareLocalFiles: true } });
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'local');
  seededNode(h.tree, 'theirs.md');

  const result = await h.boot.run();

  assert.equal(result.outcome, 'cancelled');
  assert.equal(h.boot.phase, 'readonly');
  assert.deepEqual(h.reconciles, []);
  assert.equal(h.replays, 0);
  assert.equal(mutations(h.vault), 0);
  assert.deepEqual(h.state.data.declinedPaths, [], 'cancelling is not declining');
});

test('a cancelled first sync is not undone by the next reconnect', async () => {
  // The user was shown what would happen and said no. A network blip a minute
  // later must not quietly do it anyway.
  const h = makeHarness({ decision: { proceed: false, shareLocalFiles: true } });
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'local');
  await h.boot.run();

  const again = await h.boot.onReconnect();

  assert.equal(again.outcome, 'readonly');
  assert.equal(h.boot.phase, 'readonly');
  assert.equal(h.confirms.length, 1, 'and they are not nagged about it either');
  assert.deepEqual(h.reconciles, []);
  assert.equal(mutations(h.vault), 0);
});

test('the confirmation is mandatory on a cold start even with nothing to upload', async () => {
  const h = makeHarness();
  const id = seededNode(h.tree, 'theirs.md');

  const result = await h.boot.run();

  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].firstSync, true);
  assert.deepEqual([...result.buckets.download], [[id, `${SHARE}/theirs.md`]]);
});

test('a warm start with nothing to upload skips the confirmation', async () => {
  const h = makeHarness();
  warmState(h.port);
  seededNode(h.tree, 'theirs.md');

  const result = await h.boot.run();

  assert.equal(result.coldStart, false);
  assert.deepEqual(h.confirms, [], 'nothing destructive and nothing new to share');
  assert.equal(result.outcome, 'ready');
});

test('a warm start with something to upload still asks', async () => {
  const h = makeHarness();
  warmState(h.port);
  h.vault.seed(`${SHARE}/new note.md`, 'f', 'mine');

  await h.boot.run();

  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].firstSync, false);
  assert.deepEqual(h.confirms[0].upload, [`${SHARE}/new note.md`]);
});

// ================================================================ steps 9-10

test('the phase reaches ready before the bootstrap reconcile, and events replay after it', async () => {
  const order: string[] = [];
  const phases: string[] = [];
  const h = makeHarness();

  h.vault.seed(`${SHARE}/mine.md`, 'f', 'local');
  const boot = new Bootstrap({
    state: h.state, tree: h.tree, vault: h.vault, shareRoot: SHARE, deviceId: DEVICE,
    loadSnapshot: async () => null,
    connectTree: async () => true,
    confirm: async () => ({ proceed: true, shareLocalFiles: true }),
    reconcile: async (cause) => { phases.push(`${cause}:${boot.phase}`); order.push(`reconcile:${cause}`); },
    replayPendingEvents: async () => { order.push('replay'); },
    now: () => NOW,
    sleep: async () => undefined,
    ...DESKTOP_FETCH_LIMITS,
  });

  await boot.run();

  assert.deepEqual(order, ['reconcile:bootstrap', 'replay']);
  assert.deepEqual(phases, ['bootstrap:ready']);
});

test('tombstones stay deferred until the first reconcile has completed', async () => {
  const h = makeHarness();
  seededNode(h.tree, 'theirs.md');

  assert.equal(h.boot.tombstonesEnabled, false, 'before boot');
  await h.boot.run();

  assert.equal(h.tombstonesDuringReconcile, false, 'during the bootstrap reconcile');
  assert.equal(h.boot.tombstonesEnabled, true, 'only afterwards');
});

test('a throwing reconcile does not wedge the boot', async () => {
  const h = makeHarness({
    deps: { reconcile: async () => { throw new Error('disk on fire'); } },
  });
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'local');

  const result = await h.boot.run();

  assert.equal(result.outcome, 'ready');
  assert.equal(h.boot.phase, 'ready');
  assert.equal(h.replays, 1, 'queued user events are still replayed (I9)');
  assert.ok(h.boot.lastFailure instanceof Error);
});

// ================================================================ §4.6 reconnect

test('a read-only client that later syncs runs steps 6-10 without re-asking', async () => {
  let synced = false;
  const h = makeHarness({ deps: { connectTree: async () => synced } });
  const id = seededNode(h.tree, 'theirs.md');

  const first = await h.boot.run();
  assert.equal(first.outcome, 'readonly');

  synced = true;
  const second = await h.boot.onReconnect();

  assert.equal(second.outcome, 'ready');
  assert.equal(h.boot.phase, 'ready');
  assert.deepEqual([...second.buckets.download], [[id, `${SHARE}/theirs.md`]]);
  assert.deepEqual(h.reconciles, ['bootstrap']);
  assert.equal(h.confirms.length, 1, 'the first sync of this workspace still asks once');
});

test('a reconnect while already ready is a no-op', async () => {
  const h = makeHarness();
  await h.boot.run();
  const before = h.reconciles.length;

  const again = await h.boot.onReconnect();

  assert.equal(again.outcome, 'ready');
  assert.equal(h.reconciles.length, before, 'reconnects do not re-bootstrap a ready client');
});

test('a reconnect resumes a reconciler that paused itself after bootstrap', async () => {
  let paused: string | null = null;
  const h = makeHarness({
    deps: {
      syncPaused: () => paused,
      resumeSync: () => { paused = null; },
    },
  });
  await h.boot.run();
  assert.equal(h.boot.phase, 'ready');

  // Mid-session, the reconciler stops on evidence of its own.
  paused = "Local layout does not match ShadowLink's records. Re-run first sync.";

  const again = await h.boot.onReconnect();

  assert.equal(again.outcome, 'ready');
  assert.equal(paused, null, 'a genuine reconnect lifts a self-diagnosed pause');
  assert.deepEqual(h.reconciles, ['bootstrap', 'bootstrap'], 'and re-runs steps 6-10');
});

test('a client whose reconciler is still paused reports read-only, never ready', async () => {
  const reason = 'The shared folder no longer exists. Sync is paused.';
  const h = makeHarness({ deps: { syncPaused: () => reason, resumeSync: () => undefined } });

  const result = await h.boot.run();

  assert.equal(result.outcome, 'readonly', 'one phase cannot mean two things');
  assert.equal(result.reason, reason);
  assert.equal(h.boot.phase, 'readonly');
  assert.equal(h.boot.readOnlyReason, reason);
  assert.deepEqual(h.reconciles, ['bootstrap'], 'the pass still ran and reported for itself');
});

// ================================================================ step 5

test('the founder claim is taken when the workspace is empty', async () => {
  const h = makeHarness();
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'local');

  await h.boot.run();

  assert.deepEqual(h.tree.getMeta()?.claim, { by: DEVICE, at: NOW });
});

test('an already-claimed workspace is not re-claimed, and the loser waits for nodes', async () => {
  const h = makeHarness();
  const boot = new Bootstrap({
    state: h.state, tree: h.tree, vault: h.vault, shareRoot: SHARE, deviceId: DEVICE,
    loadSnapshot: async () => null,
    connectTree: async () => true,
    confirm: async (c) => { h.confirms.push(c); return { proceed: true, shareLocalFiles: true }; },
    reconcile: async () => undefined,
    replayPendingEvents: async () => undefined,
    now: () => NOW,
    // The founder's claim lands while we sleep out the grace window.
    sleep: async () => { h.tree.claimFounder('the-other-device', NOW - 1); },
    founderWaitCapMs: 1_000,
    ...DESKTOP_FETCH_LIMITS,
  });
  h.vault.seed(`${SHARE}/shared note.md`, 'f', 'my copy');

  // The founder's node arrives shortly after we start waiting for it.
  setTimeout(() => { seededNode(h.tree, 'shared note.md'); }, 10);
  const result = await boot.run();

  assert.equal(h.tree.getMeta()?.claim?.by, 'the-other-device', 'the claim was not stolen');
  assert.equal(result.buckets.adopt.size, 1, 'the local file merged into the founder\'s node');
  assert.deepEqual(result.buckets.upload, [], 'and was NOT published a second time');
});

test('the loser waits for the founder\'s LAST node, not its first', async () => {
  // Regression for the structural end-to-end suite's case 75b, where two clients
  // first-join one empty workspace at the same moment and the loser was minting
  // a rival node for every file whose node had not landed yet ("A minted 24
  // nodes for 20 files"). A founder publishes one node per file and each is its
  // own transaction, so they arrive as a BURST spread over several ticks — and a
  // wait that ends on the first of them classifies against a tree that is still
  // being filled in. Adoption merges by fold(relPath), which can only match a
  // node that has already arrived, so waking early is not a slower merge: it is
  // a duplicate.
  const names = ['alpha.md', 'beta.md', 'gamma.md', 'delta.md'];
  const h = makeHarness();
  for (const name of names) h.vault.seed(`${SHARE}/${name}`, 'f', `body of ${name}`);

  const boot = new Bootstrap({
    state: h.state, tree: h.tree, vault: h.vault, shareRoot: SHARE, deviceId: DEVICE,
    loadSnapshot: async () => null,
    connectTree: async () => true,
    confirm: async (c) => { h.confirms.push(c); return { proceed: true, shareLocalFiles: true }; },
    reconcile: async () => undefined,
    replayPendingEvents: async () => undefined,
    now: () => NOW,
    sleep: async () => { h.tree.claimFounder('the-other-device', NOW - 1); },
    founderWaitCapMs: 5_000,
    ...DESKTOP_FETCH_LIMITS,
  });

  // The founder's four nodes, one per tick rather than all in one frame.
  names.forEach((name, i) => { setTimeout(() => { seededNode(h.tree, name); }, 10 + i * 25); });

  const result = await boot.run();

  assert.equal(
    result.buckets.adopt.size, names.length,
    'the loser classified before the founder had finished publishing',
  );
  assert.deepEqual(
    result.buckets.upload, [],
    'it offered to publish files the founder had already claimed — every one a duplicate node',
  );
});

test('a founder wait that times out proceeds anyway', async () => {
  const h = makeHarness({ deps: { founderWaitCapMs: 20 } });
  const boot = new Bootstrap({
    state: h.state, tree: h.tree, vault: h.vault, shareRoot: SHARE, deviceId: DEVICE,
    loadSnapshot: async () => null,
    connectTree: async () => true,
    confirm: async () => ({ proceed: true, shareLocalFiles: true }),
    reconcile: async () => undefined,
    replayPendingEvents: async () => undefined,
    now: () => NOW,
    sleep: async () => { h.tree.claimFounder('the-other-device', NOW - 1); },
    founderWaitCapMs: 20,
    ...DESKTOP_FETCH_LIMITS,
  });
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'local');

  // Raced against a real timer: an UNBOUNDED wait for a founder who never
  // publishes leaves the plugin wedged in `boot` for ever, with every user event
  // piling up in the pending queue and nothing on screen to explain it.
  const running = boot.run();
  const outcome = await Promise.race([
    running.then((r) => r.outcome),
    new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 1_000)),
  ]);
  assert.equal(outcome, 'ready', 'a silent founder never blocks this client for ever');

  const result = await running;
  assert.deepEqual(result.buckets.upload, [`${SHARE}/mine.md`]);
});

// ================================================================ 75: double founder

test('75: two clients with the same 100 files MERGE rather than duplicating', async () => {
  const names: string[] = [];
  for (let i = 0; i < 100; i++) names.push(`note ${String(i).padStart(3, '0')}.md`);

  // --- client A founds the workspace and publishes all 100 files.
  const a = makeHarness();
  for (const name of names) a.vault.seed(`${SHARE}/${name}`, 'f', `body of ${name}`);
  const aResult = await a.boot.run();
  assert.equal(aResult.buckets.upload.length, 100, 'A has 100 files nobody has shared');

  // The wiring's `publishUntracked` mints one node per accepted upload path and
  // the publish queue then marks it seeded. Modelled here so the tree B sees is
  // exactly the tree a real founder would have written.
  for (const path of aResult.buckets.upload) {
    seededNode(a.tree, path.slice(SHARE.length + 1));
  }
  assert.equal(a.tree.size(), 100);

  // --- client B holds the SAME 100 files and joins while partitioned: its tree
  // is empty, so it takes the founder claim too. The partition then heals.
  const b = makeHarness({ deps: { founderWaitCapMs: 20 } });
  for (const name of names) b.vault.seed(`${SHARE}/${name}`, 'f', `body of ${name}`);

  const boot = new Bootstrap({
    state: b.state, tree: b.tree, vault: b.vault, shareRoot: SHARE, deviceId: 'device-2',
    loadSnapshot: async () => null,
    connectTree: async () => true,
    confirm: async (c) => { b.confirms.push(c); return { proceed: true, shareLocalFiles: true }; },
    reconcile: async (cause) => { b.reconciles.push(cause); },
    replayPendingEvents: async () => undefined,
    notice: (msg) => { b.notices.push(msg); },
    now: () => NOW,
    // The partition heals during the founder grace window: A's whole tree lands.
    sleep: async () => { b.tree.applyUpdate(Y.encodeStateAsUpdate(a.tree.doc)); },
    founderWaitCapMs: 20,
    ...DESKTOP_FETCH_LIMITS,
  });

  const bResult = await boot.run();

  // Adoption matches by fold(relPath), so every one of B's local files binds to
  // A's node instead of minting a rival at the same path.
  assert.equal(bResult.buckets.adopt.size, 100, 'all 100 merged');
  assert.deepEqual(bResult.buckets.upload, [], 'B publishes nothing a second time');
  assert.deepEqual(bResult.buckets.pending, []);

  // --- and the merged tree is 100 nodes, not 200, with no collision suffixes.
  a.tree.applyUpdate(Y.encodeStateAsUpdate(b.tree.doc));
  b.tree.applyUpdate(Y.encodeStateAsUpdate(a.tree.doc));
  for (const merged of [a.tree, b.tree]) {
    const derived = deriveTree(merged.entries());
    assert.equal(derived.files.size, 100, 'exactly 100 live file nodes');
    const suffixed = [...derived.files.values()].filter((p) => / \(\d+\)\.md$/.test(p));
    assert.deepEqual(suffixed, [], 'and not one "(2)" suffix');
  }
});

// ================================================================ source guards

test('Bootstrap.ts imports no obsidian and calls nothing irreversible', () => {
  const banned = [`vault.${'delete'}(`, `${'trash'}(file, true)`];
  const source = readFileSync(new URL('./Bootstrap.ts', import.meta.url), 'utf8');
  for (const needle of banned) {
    assert.equal(source.includes(needle), false, `Bootstrap.ts must not contain ${needle}`);
  }
  assert.equal(source.includes("from 'obsidian'"), false, 'no obsidian import');
});

// ------------------------------------- §7.5: the upload bucket the modal promised

/**
 * ⚠ The download side has been split by the memory cap since B25/B30. The UPLOAD
 * side never was, and the consequence is worse than a wrong number.
 *
 * `classify` filtered upload candidates by kind, by `validateRel`, by the declined
 * list and by whether the tree already claims the path — and by no size test at
 * all — while it already had a `stat` on every one of them. So the modal counted
 * a 200 MB screen recording as something that "can be uploaded to this workspace",
 * the user agreed, and the publish queue then hit the device cap and RETRACTED it:
 * the node tombstoned, the binding dropped, the path recorded as oversized, and a
 * notice saying the opposite of what the modal had just said.
 *
 * Device arm only, and `serverCap` is null by construction: `limits()` has exactly
 * one production caller and bootstrap is not it. A first-join modal must not need
 * the network to count local files, and a server ceiling that is not knowable here
 * is never a small one (I2).
 */
test('the upload count splits on the device cap, so the modal cannot promise a tombstone', async () => {
  const h = makeHarness({ deps: { memoryCapBytes: () => 1_000 } });
  h.vault.seed(`${SHARE}/mine.md`, 'f', 'abcde');                       // 5 bytes
  h.vault.seedBinary(`${SHARE}/scan.png`, new Uint8Array(64));
  h.vault.seedBinary(`${SHARE}/clip.mov`, new Uint8Array(5_000));       // over the cap
  h.vault.seedBinary(`${SHARE}/exact.png`, new Uint8Array(1_000));      // exactly at it

  const b = (await h.boot.run()).buckets;

  assert.deepEqual(b.uploadNotes, { count: 1, bytes: 5 });
  assert.deepEqual(
    b.uploadAttachments, { count: 2, bytes: 1_064 },
    'a ceiling is "this much is fine": exactly at the cap is still shareable',
  );
  assert.deepEqual(b.uploadAttachmentsTooLarge, { count: 1, bytes: 5_000 });

  // The union is untouched: it is what the confirmation acts on, and dropping a
  // file between the counts and the decision is its own bug.
  assert.deepEqual(b.upload, [
    `${SHARE}/clip.mov`, `${SHARE}/exact.png`, `${SHARE}/mine.md`, `${SHARE}/scan.png`,
  ]);
  assert.deepEqual(h.confirms[0].uploadAttachmentsTooLarge, { count: 1, bytes: 5_000 });
});

// A share with nothing over the cap says nothing about the cap, exactly as the
// download side does. An empty bucket is not a line of copy.
test('a first sync with nothing over the device cap reports an empty bucket', async () => {
  const h = makeHarness({ deps: { memoryCapBytes: () => 1_000 } });
  h.vault.seedBinary(`${SHARE}/scan.png`, new Uint8Array(64));

  const b = (await h.boot.run()).buckets;

  assert.deepEqual(b.uploadAttachments, { count: 1, bytes: 64 });
  assert.deepEqual(b.uploadAttachmentsTooLarge, { count: 0, bytes: 0 });
});

// I2, on the one read this count depends on. A `stat` that could not look is not
// evidence that the file is huge, and refusing on it would hide a perfectly
// shareable file from the only list the user gets to see.
test('a file whose size could not be read is counted as shareable, not as too large', async () => {
  const h = makeHarness({ deps: { memoryCapBytes: () => 1_000 } });
  h.vault.seedBinary(`${SHARE}/scan.png`, new Uint8Array(64));
  h.vault.failNext('stat', new Error('EIO: the volume is unreadable'));

  const b = (await h.boot.run()).buckets;

  assert.equal(b.uploadAttachments.count + b.uploadAttachmentsTooLarge.count, 1);
  assert.deepEqual(
    b.uploadAttachmentsTooLarge, { count: 0, bytes: 0 },
    '"I could not look" must never be read as "it is over the ceiling"',
  );
});
