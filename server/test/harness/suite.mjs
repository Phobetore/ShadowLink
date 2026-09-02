// server/test/harness/suite.mjs
// Spec §10 Group C — headless end-to-end, real server, real Yjs clients.
//
// Every case below boots nothing of its own: one server process serves the whole
// run, and each case gets its own workspace id, which is what isolates its `_tree`
// and `n_*` snapshots from every other case's.
//
// P2's blob transport (spec §11 Group C1-C7, C10) rides the same run, registered
// from `blobs.mjs`: it needs the same real server process on the same real port,
// and C10 needs both halves of it at once — a saturated blob store and a relay
// that still answers.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { test, run, setFilter, assert } from './runner.mjs';
import { startServer } from './server.mjs';
import { Client, settleAll, SHARE_ROOT } from './client.mjs';
import { DocLink, sleep } from './net.mjs';
import { registerBlobCases } from './blobs.mjs';
import { registerMuxTreeCases } from './muxtree.mjs';
import { registerRoomCases } from './rooms.mjs';
import { MuxClient, syncPayload, updateFor, SYNC, EMPTY_SV, until } from './mux.mjs';
import { fold, isLive, relPath } from '../../../src/tree/paths.ts';
import { deriveTree } from '../../../src/tree/TreeIndex.ts';

const PORT = Number(process.env.SL_E2E_PORT ?? 4171);
/** Nothing listens here. Used by test 73's unsynced-provider cases. */
const DEAD_PORT = Number(process.env.SL_E2E_DEAD_PORT ?? 4197);
/** The blob cases that need their own server configuration take these. */
const BLOB_PORT = Number(process.env.SL_E2E_BLOB_PORT ?? 4181);
/** A server from BEFORE the mux existed, for the P3 slice-2 fallback case (80c). */
const LEGACY_PORT = Number(process.env.SL_E2E_LEGACY_PORT ?? 4191);

let server = null;
let workspaceCounter = 0;

const deadServer = {
  url: (room, workspace) => `ws://127.0.0.1:${DEAD_PORT}/${room}?t=sk_dead&w=${workspace}`,
};

// ============================================================ helpers

function scenario(name, fn) {
  test(name, async () => {
    const workspace = `c${++workspaceCounter}`;
    const created = [];
    const make = (clientName, options = {}) => {
      const client = new Client({ name: clientName, server, workspace, ...options });
      created.push(client);
      return client;
    };
    try {
      await fn({ workspace, make });
    } finally {
      for (const client of created) {
        try { await client.dispose(); } catch { /* teardown must never mask a failure */ }
      }
    }
  });
}

/** Every LIVE node whose STORED path is `rel`, sorted by nodeId. */
function nodesAt(client, rel) {
  return client.tree.entries()
    .filter(([, f]) => isLive(f) && fold(relPath(f)) === fold(rel))
    .map(([id]) => id)
    .sort();
}

function liveFileNodes(client) {
  return client.tree.entries().filter(([, f]) => isLive(f) && f.k === 'f');
}

/** Share-relative folder paths the TREE wants, which is the converged structure. */
function desiredFolders(client) {
  return [...deriveTree(client.tree.entries()).folders].sort();
}

/**
 * Assert the two clients converged: identical files with identical bytes, an
 * identical DESIRED folder structure, and an identical folder structure ON DISK.
 *
 * The last of those used to carry an allowance for "an extra directory that
 * holds nothing", because reconcile step 5 swept a folder only when its NODE was
 * dead: a directory emptied by a remote RENAME has a live node that simply moved,
 * so the old path survived as an empty folder on every peer that did not perform
 * the rename. Step 5 now also removes an empty directory the tree does not
 * claim, so there is nothing left to tolerate — the two vaults must look the
 * same, folders included, and this assertion is what keeps them that way.
 */
function assertSameLayout(a, b, label) {
  const la = a.layout();
  const lb = b.layout();
  assert.deepEqual(
    Object.keys(la.files).sort(), Object.keys(lb.files).sort(),
    `${label}: file sets differ (${a.name} vs ${b.name})`,
  );
  for (const path of Object.keys(la.files)) {
    assert.equal(lb.files[path], la.files[path], `${label}: content differs at ${path}`);
  }
  assert.deepEqual(
    desiredFolders(a), desiredFolders(b),
    `${label}: the clients disagree about the desired folder structure`,
  );
  assert.deepEqual(
    la.folders, lb.folders,
    `${label}: on-disk folder sets differ (${a.name} vs ${b.name})`,
  );
}

/** Read a room straight off the server, with a connection no client owns. */
async function readRoom(workspace, room, ms = 3000) {
  const doc = new Y.Doc();
  const link = new DocLink(server.url(room, workspace), doc);
  link.connect();
  const synced = await link.waitSync(ms);
  const text = doc.getText('content').toString();
  link.destroy();
  if (!synced) throw new Error(`readRoom: ${room} never synced`);
  return text;
}

/** Vault mutation calls recorded after index `from`. */
function mutationsSince(client, from) {
  return client.vault.calls.slice(from)
    .filter((c) => ['create', 'createFolder', 'rename', 'trashLocal'].includes(c.op));
}

function tryUpgrade(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const finish = (verdict) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(verdict);
    };
    ws.on('open', () => finish('accepted'));
    ws.on('error', () => finish('rejected'));
    ws.on('unexpected-response', () => finish('rejected'));
    const timer = setTimeout(() => finish('timeout'), 3000);
  });
}

/** mulberry32 — small, seeded, and identical on every platform. */
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const relOf = (vaultPath) => vaultPath.slice(SHARE_ROOT.length + 1);

// ============================================================ 61

scenario('61 structural round trip — B materializes the folder and the note, never empty', async ({ make }) => {
  const a = make('A');
  const b = make('B');

  await a.start();
  await a.userCreateFolder('Notes');
  await a.userCreateFile('Notes/hello.md', 'hello from client A');
  await a.settle();

  await b.start();
  const { converged } = await settleAll([a, b]);
  assert.ok(converged, 'clients did not reach quiescence');

  const layout = b.layout();
  assert.ok(layout.folders.includes('Shared/Notes'), 'B did not create the folder');
  assert.equal(layout.files['Shared/Notes/hello.md'], 'hello from client A');

  // I6: the file is written once, with its content. A zero-byte file on the
  // canonical path is worse than no file, because it looks correct.
  const creates = b.vault.callsTo('create');
  for (const call of creates) {
    assert.notEqual(call.args[1], '', `B created an empty file at ${call.args[0]}`);
  }
  const forNote = creates.filter((c) => c.args[0] === 'Shared/Notes/hello.md');
  assert.equal(forNote.length, 1, 'B wrote the note more than once');
  assert.equal(forNote[0].args[1], 'hello from client A');

  assertSameLayout(a, b, '61');
});

// ============================================================ 62

scenario('62 rename preserves the content doc — same room, same Y.Text history', async ({ make }) => {
  const a = make('A');
  const b = make('B');
  const TEXT = 'the body of the note, written once';

  await a.start();
  await a.userCreateFolder('Notes');
  await a.userCreateFile('Notes/original.md', TEXT);
  await a.settle();
  await b.start();
  await settleAll([a, b]);

  const nodeId = a.nodeAt('Notes/original.md');
  assert.ok(nodeId, 'A never minted a node for the note');
  assert.equal(b.layout().files['Shared/Notes/original.md'], TEXT);

  const room = `n_${nodeId}`;
  const stateBefore = Buffer.from(a.contentStateBytes(nodeId));
  const bCallsBefore = b.vault.calls.length;

  await a.userRename('Notes/original.md', 'Notes/renamed.md');
  await settleAll([a, b]);

  // The node — and therefore the room — is untouched by the rename.
  assert.equal(a.nodeAt('Notes/renamed.md'), nodeId, 'the rename forked the node');
  assert.equal(b.nodeAt('Notes/renamed.md'), nodeId, 'B resolved a different node');
  for (const client of [a, b]) {
    const rooms = client.docs.roomsTouched();
    assert.deepEqual(rooms, [room], `${client.name} opened a room other than ${room}: ${rooms}`);
  }

  // The Y.Text history is untouched: a rename is not an edit.
  assert.deepEqual(Buffer.from(a.contentStateBytes(nodeId)), stateBefore, 'the content doc changed');
  assert.equal(a.contentText(nodeId), TEXT);

  // B RENAMED its local file rather than re-downloading it.
  const bMutations = mutationsSince(b, bCallsBefore);
  const renames = bMutations.filter((c) => c.op === 'rename');
  assert.ok(
    renames.some((c) => c.args[0] === 'Shared/Notes/original.md' && c.args[1] === 'Shared/Notes/renamed.md'),
    `B did not rename its local file: ${JSON.stringify(bMutations)}`,
  );
  assert.ok(
    !bMutations.some((c) => c.op === 'create' && c.args[0] === 'Shared/Notes/renamed.md'),
    'B re-created the note instead of renaming it',
  );

  assert.equal(b.layout().files['Shared/Notes/renamed.md'], TEXT);
  assert.equal(b.layout().files['Shared/Notes/original.md'], undefined);
  assertSameLayout(a, b, '62');
});

// ============================================================ 63

scenario('63 move preserves the content doc — same room across folders', async ({ make }) => {
  const a = make('A');
  const b = make('B');
  const TEXT = 'moved, not rewritten';

  await a.start();
  await a.userCreateFolder('One');
  await a.userCreateFolder('Two');
  await a.userCreateFile('One/note.md', TEXT);
  await a.settle();
  await b.start();
  await settleAll([a, b]);

  const nodeId = a.nodeAt('One/note.md');
  const stateBefore = Buffer.from(a.contentStateBytes(nodeId));

  await a.userRename('One/note.md', 'Two/note.md');
  await settleAll([a, b]);

  assert.equal(a.nodeAt('Two/note.md'), nodeId);
  assert.deepEqual(b.docs.roomsTouched(), [`n_${nodeId}`]);
  assert.deepEqual(Buffer.from(a.contentStateBytes(nodeId)), stateBefore);
  assert.equal(b.layout().files['Shared/Two/note.md'], TEXT);
  assert.equal(b.layout().files['Shared/One/note.md'], undefined);
  assertSameLayout(a, b, '63');
});

// ============================================================ 64

scenario('64 the assigned hard case — folder rename vs child rename, partitioned', async ({ make }) => {
  const a = make('A');
  const b = make('B');

  await a.start();
  await a.userCreateFolder('X');
  await a.userCreateFile('X/note.md', 'the note');
  for (let i = 1; i <= 10; i++) await a.userCreateFile(`X/sibling-${i}.md`, `sibling ${i}`);
  await a.settle();

  await b.start();
  await settleAll([a, b]);
  assert.equal(Object.keys(b.layout().files).length, 11, 'B did not materialize all 11 files');

  a.partition();
  b.partition();

  await a.userRename('X', 'Y');                       // A renames the folder
  await a.settle();
  await b.userRename('X/note.md', 'X/renamed.md');    // B renames the child
  await b.settle();

  await a.reconnect();
  await b.reconnect();
  const { converged } = await settleAll([a, b]);
  assert.ok(converged, 'clients did not converge after the partition healed');

  const expected = ['Shared/Y/renamed.md'];
  for (let i = 1; i <= 10; i++) expected.push(`Shared/Y/sibling-${i}.md`);
  expected.sort();

  for (const client of [a, b]) {
    const files = Object.keys(client.layout().files).sort();
    assert.deepEqual(files, expected, `${client.name} did not converge to Y/renamed.md + 10 siblings`);
    assert.equal(client.layout().files['Shared/Y/renamed.md'], 'the note');
    // Nothing may be left behind in the directory the rename emptied — not a
    // stranded file, and since step 5 also removes an empty directory the tree
    // no longer claims, not the directory either.
    assert.deepEqual(
      files.filter((p) => p.startsWith('Shared/X/')), [],
      `${client.name} stranded files under the old folder name`,
    );
    assert.deepEqual(
      client.layout().folders.filter((p) => p === 'Shared/X' || p.startsWith('Shared/X/')), [],
      `${client.name} kept the directory the rename emptied`,
    );
  }
  assert.deepEqual(desiredFolders(a), ['Y'], 'A wants a folder other than Y');
  assert.deepEqual(desiredFolders(b), ['Y'], 'B wants a folder other than Y');
  assertSameLayout(a, b, '64');
});

// ============================================================ 65

scenario('65 mutual move — no cycle, no loss, a fixpoint within 3 passes', async ({ make }) => {
  const a = make('A');
  const b = make('B');

  await a.start();
  await a.userCreateFolder('X');
  await a.userCreateFolder('Y');
  await a.userCreateFile('X/inside-x.md', 'x body');
  await a.userCreateFile('Y/inside-y.md', 'y body');
  await a.settle();
  await b.start();
  await settleAll([a, b]);
  assert.equal(Object.keys(b.layout().files).length, 2);

  a.partition();
  b.partition();
  await a.userRename('X', 'Y/X');       // A moves X into Y
  await a.settle();
  await b.userRename('Y', 'X/Y');       // B moves Y into X
  await b.settle();

  await a.reconnect();
  await b.reconnect();
  const { converged, maxWork } = await settleAll([a, b]);
  assert.ok(converged, 'clients did not converge after the mutual move');

  // Every file survives, and the two vaults are identical.
  for (const client of [a, b]) {
    const files = Object.keys(client.layout().files).sort();
    assert.equal(files.length, 2, `${client.name} lost a file: ${files}`);
    assert.ok(files.some((p) => p.endsWith('/inside-x.md')), `${client.name} lost inside-x.md`);
    assert.ok(files.some((p) => p.endsWith('/inside-y.md')), `${client.name} lost inside-y.md`);
    assert.equal(client.recovered().length, 0, `${client.name} rescued a file it should not have`);
  }
  assertSameLayout(a, b, '65');

  // "terminates within 3 passes": no single settle needed more than three
  // reconcile passes that actually did work, and a fresh settle does nothing.
  assert.ok(maxWork <= 3, `a settle needed ${maxWork} working passes`);
  assert.equal(await a.settle(), 0, 'A is still mutating at a fixpoint');
  assert.equal(await b.settle(), 0, 'B is still mutating at a fixpoint');
});

// ============================================================ 66

scenario('66 concurrent same-name file create — one suffix, neither doc empty', async ({ make, workspace }) => {
  const a = make('A');
  const b = make('B');

  await a.start();
  await a.userCreateFolder('Notes');
  await a.userCreateFile('Notes/seed.md', 'seed');
  await a.settle();
  await b.start();
  await settleAll([a, b]);

  a.partition();
  b.partition();
  await a.userCreateFile('Notes/Untitled.md', 'written by A');
  await a.settle();
  await b.userCreateFile('Notes/Untitled.md', 'written by B');
  await b.settle();

  await a.reconnect();
  await b.reconnect();
  const { converged } = await settleAll([a, b]);
  assert.ok(converged, 'clients did not converge');

  const ids = nodesAt(a, 'Notes/Untitled.md');
  assert.equal(ids.length, 2, `expected two colliding nodes, got ${ids.length}`);
  assert.deepEqual(nodesAt(b, 'Notes/Untitled.md'), ids, 'the clients disagree about the node set');

  // The LOWEST nodeId keeps the plain name, on both clients (spec §4.4).
  const [plain, suffixed] = ids;
  for (const client of [a, b]) {
    assert.equal(client.pathOf(plain), 'Notes/Untitled.md', `${client.name} moved the plain name`);
    assert.equal(client.pathOf(suffixed), 'Notes/Untitled (2).md', `${client.name} suffixed differently`);
  }

  // Neither content doc was seeded twice: read them straight off the server.
  const plainText = await readRoom(workspace, `n_${plain}`);
  const suffixedText = await readRoom(workspace, `n_${suffixed}`);
  for (const [room, text] of [[plain, plainText], [suffixed, suffixedText]]) {
    assert.ok(
      text === 'written by A' || text === 'written by B',
      `n_${room} holds ${JSON.stringify(text)} — empty or concatenated`,
    );
  }
  assert.notEqual(plainText, suffixedText, 'both nodes hold the same body');

  for (const client of [a, b]) {
    const files = client.layout().files;
    assert.equal(Object.keys(files).sort().join(), [
      'Shared/Notes/Untitled (2).md', 'Shared/Notes/Untitled.md', 'Shared/Notes/seed.md',
    ].sort().join(), `${client.name} has the wrong file set: ${Object.keys(files)}`);
    // Neither copy is empty, and neither is the two seeds concatenated.
    for (const path of ['Shared/Notes/Untitled.md', 'Shared/Notes/Untitled (2).md']) {
      const text = files[path];
      assert.ok(text === 'written by A' || text === 'written by B', `${path} holds ${JSON.stringify(text)}`);
    }
    assert.notEqual(
      files['Shared/Notes/Untitled.md'], files['Shared/Notes/Untitled (2).md'],
      `${client.name} materialized the same body twice`,
    );
  }
  assertSameLayout(a, b, '66');
});

// ============================================================ 67

scenario('67 concurrent same-name folder create — one folder, both notes, no fork', async ({ make }) => {
  const a = make('A');
  const b = make('B');

  await a.start();
  await a.userCreateFile('base.md', 'base');
  await a.settle();
  await b.start();
  await settleAll([a, b]);

  a.partition();
  b.partition();
  await a.userCreateFolder('Projects');
  await a.userCreateFile('Projects/from-a.md', 'a note');
  await a.settle();
  await b.userCreateFolder('Projects');
  await b.userCreateFile('Projects/from-b.md', 'b note');
  await b.settle();

  await a.reconnect();
  await b.reconnect();
  const { converged } = await settleAll([a, b]);
  assert.ok(converged, 'clients did not converge');

  // Two live dir nodes at one path ARE one directory (spec §1.4).
  assert.equal(nodesAt(a, 'Projects').length, 2, 'expected two folder nodes in the tree');
  for (const client of [a, b]) {
    const { files, folders } = client.layout();
    assert.deepEqual(
      folders, ['Shared/Projects'],
      `${client.name} forked the folder: ${folders}`,
    );
    assert.equal(files['Shared/Projects/from-a.md'], 'a note');
    assert.equal(files['Shared/Projects/from-b.md'], 'b note');
    assert.ok(
      !Object.keys(files).some((p) => p.includes('Projects (2)')),
      `${client.name} produced a Projects (2)`,
    );
  }
  assertSameLayout(a, b, '67');
});

// ============================================================ 68

scenario('68 delete vs move-out — keep.md survives on both, neither rescued nor trashed', async ({ make }) => {
  const a = make('A');
  const b = make('B');

  await a.start();
  await a.userCreateFolder('Archive');
  await a.userCreateFolder('Active');
  await a.userCreateFile('Archive/keep.md', 'the one that must survive');
  for (let i = 1; i <= 29; i++) await a.userCreateFile(`Archive/note-${i}.md`, `archived ${i}`);
  await a.settle();
  await b.start();
  await settleAll([a, b], { rounds: 30 });
  assert.equal(Object.keys(b.layout().files).length, 30, 'B did not materialize the archive');

  a.partition();
  b.partition();
  await a.userDelete('Archive');                             // 30 notes + the folder
  await a.settle();
  await b.userRename('Archive/keep.md', 'Active/keep.md');   // moved OUT of the cascade
  await b.settle();

  await a.reconnect();
  await b.reconnect();
  const { converged } = await settleAll([a, b], { rounds: 30 });
  assert.ok(converged, 'clients did not converge after the partition healed');

  for (const client of [a, b]) {
    const files = client.layout().files;
    assert.equal(
      files['Shared/Active/keep.md'], 'the one that must survive',
      `${client.name} lost keep.md (has ${Object.keys(files)})`,
    );
    assert.ok(
      !client.vault.wasTrashed('Shared/Archive/keep.md') && !client.vault.wasTrashed('Shared/Active/keep.md'),
      `${client.name} trashed keep.md`,
    );
    assert.ok(
      !client.recovered().some((p) => p.includes('keep')),
      `${client.name} rescued keep.md: ${client.recovered()}`,
    );
    // The other 29 really are gone.
    assert.ok(
      !Object.keys(files).some((p) => p.includes('note-')),
      `${client.name} kept archived notes: ${Object.keys(files)}`,
    );
  }
  assertSameLayout(a, b, '68');
});

// ============================================================ 70

scenario('70 offline delete converges once — exactly five removals, then none', async ({ make }) => {
  const a = make('A');
  const b = make('B');

  await a.start();
  for (let i = 1; i <= 5; i++) await a.userCreateFile(`doomed-${i}.md`, `doomed ${i}`);
  await a.userCreateFile('survivor.md', 'still here');
  await a.settle();
  await b.start();
  await settleAll([a, b]);
  assert.equal(Object.keys(b.layout().files).length, 6);

  b.partition();
  for (let i = 1; i <= 5; i++) await a.userDelete(`doomed-${i}.md`);
  await a.settle();
  await settleAll([a]);

  const before = b.vault.calls.length;
  await b.reconnect();
  await settleAll([a, b]);

  const removals = mutationsSince(b, before).filter(
    (c) => c.op === 'trashLocal' || (c.op === 'rename' && String(c.args[1]).startsWith('ShadowLink Recovered/')),
  );
  assert.equal(removals.length, 5, `expected 5 removals, got ${removals.length}: ${JSON.stringify(removals)}`);
  assert.equal(Object.keys(b.layout().files).length, 1);
  assert.equal(b.layout().files['Shared/survivor.md'], 'still here');

  // Nothing was removed twice.
  for (let i = 1; i <= 5; i++) {
    assert.equal(
      b.vault.trashedFor(`Shared/doomed-${i}.md`).length, 1,
      `doomed-${i}.md was trashed more than once`,
    );
  }

  // A second reconnect applies nothing at all.
  const after = b.vault.calls.length;
  b.partition();
  await b.reconnect();
  await settleAll([a, b]);
  assert.deepEqual(
    mutationsSince(b, after), [],
    'the second reconnect mutated the vault again',
  );
  assertSameLayout(a, b, '70');
});

// ============================================================ 71

scenario('71 no echo loop — B emits zero LOCAL-origin tree transactions', async ({ make }) => {
  const a = make('A');
  const b = make('B');

  await a.start();
  await a.userCreateFile('anchor.md', 'anchor');
  await a.settle();
  await b.start();
  await settleAll([a, b]);

  const baseline = b.localTxns;
  assert.equal(baseline, 0, `B wrote to the tree during its own bootstrap (${baseline} transactions)`);

  // 50 structural operations on A.
  let ops = 0;
  for (let i = 1; i <= 12; i++) { await a.userCreateFile(`note-${i}.md`, `body ${i}`); ops++; }
  for (let i = 1; i <= 6; i++) { await a.userCreateFolder(`folder-${i}`); ops++; }
  for (let i = 1; i <= 12; i++) { await a.userRename(`note-${i}.md`, `renamed-${i}.md`); ops++; }
  for (let i = 1; i <= 12; i++) {
    await a.userRename(`renamed-${i}.md`, `folder-${(i % 6) + 1}/renamed-${i}.md`);
    ops++;
  }
  for (let i = 1; i <= 8; i++) { await a.userCreateFile(`extra-${i}.md`, `extra ${i}`); ops++; }
  assert.equal(ops, 50);

  await a.settle();
  const { converged } = await settleAll([a, b], { rounds: 30 });
  assert.ok(converged, 'clients did not converge after 50 operations');

  assert.equal(
    b.localTxns, baseline,
    `B emitted ${b.localTxns - baseline} LOCAL-origin tree transactions (an echo loop)`,
  );
  assert.equal(b.tree.size(), a.tree.size(), 'node counts differ');
  assert.equal(b.liveNodeIds().length, a.liveNodeIds().length, 'live node counts differ');
  assert.deepEqual(b.liveNodeIds(), a.liveNodeIds());
  assert.deepEqual(b.eventErrors, [], 'B threw inside a vault handler');
  assertSameLayout(a, b, '71');
});

// ============================================================ 72

const SEEDS = Number(process.env.SL_E2E_SEEDS ?? 20);
const OPS = Number(process.env.SL_E2E_OPS ?? 200);

async function randomOp(client, rnd, counter) {
  const layout = client.layout();
  const files = Object.keys(layout.files);
  const folders = layout.folders.filter((f) => f !== SHARE_ROOT);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const roll = rnd();

  try {
    if (roll < 0.34 || files.length === 0) {
      const dir = folders.length > 0 && rnd() < 0.5 ? relOf(pick(folders)) : '';
      const name = `n${counter}.md`;
      await client.userCreateFile(dir === '' ? name : `${dir}/${name}`, `body ${counter} by ${client.name}`);
    } else if (roll < 0.46) {
      const dir = folders.length > 0 && rnd() < 0.4 ? relOf(pick(folders)) : '';
      const name = `d${counter}`;
      await client.userCreateFolder(dir === '' ? name : `${dir}/${name}`);
    } else if (roll < 0.68) {
      const from = relOf(pick(files));
      const slash = from.lastIndexOf('/');
      const dir = slash === -1 ? '' : from.slice(0, slash);
      await client.userRename(from, dir === '' ? `r${counter}.md` : `${dir}/r${counter}.md`);
    } else if (roll < 0.84) {
      const from = relOf(pick(files));
      const base = from.slice(from.lastIndexOf('/') + 1);
      const dir = folders.length > 0 && rnd() < 0.75 ? relOf(pick(folders)) : '';
      const to = dir === '' ? base : `${dir}/${base}`;
      if (fold(to) !== fold(from)) await client.userRename(from, to);
    } else if (roll < 0.93 && folders.length > 0) {
      const from = relOf(pick(folders));
      if (!from.includes('/')) await client.userRename(from, `d${counter}`);
    } else {
      await client.userDelete(relOf(pick(files)));
    }
  } catch {
    // A user action the filesystem refuses (occupied name, vanished source) is
    // simply an action that did not happen. That is exactly what Obsidian does.
  }
}

for (let seed = 1; seed <= SEEDS; seed++) {
  scenario(`72 three clients, ${OPS} random operations, two partitions (seed ${seed})`, async ({ make }) => {
    const clients = [make('A'), make('B'), make('C')];
    const rnd = makeRandom(seed * 7919 + 13);

    await clients[0].start();
    await clients[0].userCreateFile('anchor.md', 'anchor');
    await clients[0].settle();
    await clients[1].start();
    await clients[2].start();
    await settleAll(clients);

    const partitioned = new Set();
    for (let i = 1; i <= OPS; i++) {
      // Two partitions, each covering a stretch of the run.
      if (i === Math.floor(OPS * 0.3)) { clients[1].partition(); partitioned.add(clients[1]); }
      if (i === Math.floor(OPS * 0.5)) {
        await clients[1].reconnect(); partitioned.delete(clients[1]);
      }
      if (i === Math.floor(OPS * 0.65)) { clients[2].partition(); partitioned.add(clients[2]); }
      if (i === Math.floor(OPS * 0.85)) {
        await clients[2].reconnect(); partitioned.delete(clients[2]);
      }

      const actor = clients[Math.floor(rnd() * clients.length)];
      await randomOp(actor, rnd, i);

      // Shuffled delivery: whose turn it is to converge is itself random.
      if (i % 4 === 0) {
        const order = [...clients].sort(() => rnd() - 0.5);
        for (const client of order) await client.settle(4);
        await sleep(10);
      }
    }

    for (const client of partitioned) await client.reconnect();
    const { converged } = await settleAll(clients, { rounds: 60, waitMs: 40 });
    assert.ok(converged, `seed ${seed}: clients never reached quiescence`);

    // Guard against the scenario degenerating into nothing: a converging test
    // that converged because nothing happened proves nothing.
    const files = Object.keys(clients[0].layout().files);
    const live = clients[0].liveNodeIds();
    assert.ok(files.length >= 10, `seed ${seed}: only ${files.length} files survived`);
    assert.ok(live.length >= 15, `seed ${seed}: only ${live.length} live nodes`);
    assert.ok(clients[0].tree.size() >= 40, `seed ${seed}: only ${clients[0].tree.size()} nodes minted`);

    assertSameLayout(clients[0], clients[1], `72/seed ${seed}`);
    assertSameLayout(clients[0], clients[2], `72/seed ${seed}`);
    for (const client of clients) {
      assert.deepEqual(client.eventErrors, [], `${client.name} threw inside a vault handler`);
      assert.deepEqual(
        client.liveNodeIds(), clients[0].liveNodeIds(),
        `seed ${seed}: ${client.name} disagrees about the live node set`,
      );
    }
  });
}

// ============================================================ 73

scenario('73a an unsynced tree provider seeds nothing and writes nothing', async ({ make }) => {
  const dead = make('D', {
    server: deadServer, treeSyncTimeoutMs: 700, docSyncTimeoutMs: 300,
  });
  dead.vault.seed('Shared/note.md', 'f', 'a local note nobody has shared yet');

  const result = await dead.start();

  assert.equal(result.outcome, 'readonly', 'a client that never synced did not go read-only');
  assert.equal(dead.bootstrap.phase, 'readonly');
  assert.equal(dead.tree.size(), 0, 'it wrote nodes into a tree it never synced');
  assert.equal(dead.localTxns, 0, 'it wrote to the tree at all');
  assert.deepEqual(dead.mutationCalls(), [], 'it mutated the vault');
  assert.equal(dead.layout().files['Shared/note.md'], 'a local note nobody has shared yet');
});

scenario('73b an unsynced content provider writes no stub, and the doc holds one copy', async ({ make, workspace }) => {
  const TEXT = 'exactly one copy of this text';
  const a = make('A');
  await a.start();
  await a.userCreateFile('note.md', TEXT);
  await a.settle();
  const nodeId = a.nodeAt('note.md');
  assert.ok(nodeId);

  // B's CONTENT provider points at a port nothing is listening on. Its tree
  // syncs, so it learns the node exists and wants it on disk — and must still
  // write absolutely nothing (I4/I6).
  const b = make('B', { docSyncTimeoutMs: 300 });
  b.docs.urlFor = (room) => deadServer.url(room, workspace);

  await b.start();
  await b.settle();

  assert.deepEqual(
    b.mutationCalls(), [],
    `B mutated the vault from a content doc it never synced: ${JSON.stringify(b.mutationCalls())}`,
  );
  assert.equal(b.layout().files['Shared/note.md'], undefined, 'B created a stub');
  assert.equal(b.recovered().length, 0);
  assert.equal(b.localTxns, 0, 'B wrote to the tree');
  assert.ok(b.docs.roomsTouched().includes(`n_${nodeId}`), 'B never even tried the content doc');

  // The content provider comes up.
  b.docs.urlFor = (room) => server.url(room, workspace);
  const { converged } = await settleAll([a, b]);
  assert.ok(converged);

  assert.equal(b.layout().files['Shared/note.md'], TEXT, 'B never materialized the note');
  const creates = b.vault.callsTo('create').filter((c) => c.args[0] === 'Shared/note.md');
  assert.equal(creates.length, 1, 'B wrote the note more than once');
  assert.equal(creates[0].args[1], TEXT, 'B wrote a stub first');

  // Authoritative: read the room off the server with a connection nobody owns.
  assert.equal(await readRoom(workspace, `n_${nodeId}`), TEXT, 'the content doc was doubled');
  assertSameLayout(a, b, '73b');
});

// ============================================================ 75

scenario('75 double founder merges rather than duplicating', async ({ make }) => {
  const COUNT = 100;
  const a = make('A');
  const b = make('B');
  for (let i = 1; i <= COUNT; i++) {
    const rel = `Shared/local-${String(i).padStart(3, '0')}.md`;
    a.vault.seed(rel, 'f', `shared body ${i}`);
    b.vault.seed(rel, 'f', `shared body ${i}`);
  }

  // B first-joins while it cannot reach the workspace at all. Invariant I3: a
  // client that never synced must not read an empty tree as "nothing has ever
  // been shared" and publish its whole vault.
  b.partition();
  const bFirst = await b.start();
  assert.equal(bFirst.outcome, 'readonly');
  assert.equal(b.tree.size(), 0, 'B published into a tree it never synced');
  assert.deepEqual(b.mutationCalls(), [], 'B mutated its vault while read-only');

  await a.start();
  await settleAll([a], { rounds: 40 });
  assert.equal(a.liveNodeIds().length, COUNT, `A published ${a.liveNodeIds().length} nodes, expected ${COUNT}`);

  await b.reconnect();
  const { converged } = await settleAll([a, b], { rounds: 60 });
  assert.ok(converged, 'clients did not converge');

  assert.equal(b.confirmations.length, 1, 'B was asked more than once');
  assert.equal(b.confirmations[0].upload.length, 0, 'B offered to re-upload files the tree already had');
  assert.equal(b.confirmations[0].adopt.size, COUNT, 'B did not adopt all 100 files by path');

  for (const client of [a, b]) {
    assert.equal(
      client.liveNodeIds().length, COUNT,
      `${client.name} sees ${client.liveNodeIds().length} live nodes, expected ${COUNT}`,
    );
    assert.equal(liveFileNodes(client).length, COUNT);
    const suffixed = Object.keys(client.layout().files).filter((p) => / \(\d+\)\.md$/.test(p));
    assert.deepEqual(suffixed, [], `${client.name} produced collision suffixes: ${suffixed}`);
    assert.equal(Object.keys(client.layout().files).length, COUNT);
  }
  assertSameLayout(a, b, '75');
});

scenario('75b two clients first-joining the SAME empty workspace at once still merge', async ({ make }) => {
  // The variant the founder claim (§4.5 step 5) exists for: both clients
  // genuinely sync an empty tree and bootstrap concurrently. Real timings —
  // FOUNDER_GRACE_MS then FOUNDER_SETTLE_MS — because the claim is the only
  // thing narrowing the window in which both could publish.
  const COUNT = 20;
  const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const a = make('A', { sleepFn: realSleep });
  const b = make('B', { sleepFn: realSleep });
  for (let i = 1; i <= COUNT; i++) {
    const path = `Shared/local-${String(i).padStart(3, '0')}.md`;
    a.vault.seed(path, 'f', `shared body ${i}`);
    b.vault.seed(path, 'f', `shared body ${i}`);
  }

  await Promise.all([a.start(), b.start()]);
  const { converged } = await settleAll([a, b], { rounds: 60 });
  assert.ok(converged, 'clients did not converge');

  for (const client of [a, b]) {
    assert.equal(
      client.tree.size(), COUNT,
      `${client.name} minted ${client.tree.size()} nodes for ${COUNT} files`,
    );
    assert.equal(client.liveNodeIds().length, COUNT);
    const suffixed = Object.keys(client.layout().files).filter((p) => / \(\d+\)\.md$/.test(p));
    assert.deepEqual(suffixed, [], `${client.name} produced collision suffixes: ${suffixed}`);
  }
  assertSameLayout(a, b, '75b');
});

// ============================================================ 76

scenario('76 bootstrap with divergent local copies — stashed, never concatenated', async ({ make, workspace }) => {
  const SHARED = 'the body A published';
  const LOCAL = 'the body B had before it ever joined';

  const a = make('A');
  await a.start();
  await a.userCreateFile('todo.md', SHARED);
  await a.settle();
  const nodeId = a.nodeAt('todo.md');
  assert.ok(nodeId);

  const b = make('B');
  b.vault.seed('Shared/todo.md', 'f', LOCAL);
  await b.start();
  const { converged } = await settleAll([a, b]);
  assert.ok(converged);

  assert.equal(b.layout().files['Shared/todo.md'], SHARED, 'the shared copy did not win on disk');
  const recovered = b.recovered();
  assert.equal(recovered.length, 1, `expected one stashed copy, got ${recovered}`);
  assert.equal(b.wholeVault()[recovered[0]], LOCAL, 'the stashed copy is not B\'s original bytes');

  // The content doc holds exactly A's copy — the local one was never inserted.
  assert.equal(await readRoom(workspace, `n_${nodeId}`), SHARED, 'the content doc was concatenated');
  assert.equal(b.vault.wasTrashed('Shared/todo.md'), false, 'B trashed its own copy');
  assertSameLayout(a, b, '76');
});

// ============================================================ 78

scenario('78 the server accepts _tree and n_<22 chars> and rejects a docId with a slash', async ({ workspace }) => {
  assert.equal(await tryUpgrade(server.url('_tree', workspace)), 'accepted', '_tree was rejected');

  const nodeId = 'AbCdEfGhIjKlMnOpQrStUv';                 // 22 chars of [A-Za-z0-9]
  assert.equal(nodeId.length, 22);
  assert.equal(await tryUpgrade(server.url(`n_${nodeId}`, workspace)), 'accepted', 'n_<nodeId> was rejected');

  assert.equal(
    await tryUpgrade(server.url(`n_${nodeId}/content`, workspace)), 'rejected',
    'a docId containing a slash was accepted',
  );
  assert.equal(
    await tryUpgrade(`ws://127.0.0.1:${PORT}/_tree?t=sk_wrong&w=${workspace}`), 'rejected',
    'a wrong SERVER_KEY was accepted',
  );
});

// ============================================================ 79 (P3 slice 1)

// Everything else about the mux is unit-tested in `server/test/mux.test.js`
// against an in-process server. What only THIS suite can say is that the SHIPPED
// `server/index.js` routes it — that the six lines of wiring in the real process
// are the ones under test, not a faithful-looking copy of them in a harness.

scenario('79a the shipped server routes _mux, and a hostile frame reaches no other room', async ({ workspace }) => {
  const other = `${workspace}x`;
  const rooms = ['_tree', 'n_AbCdEfGhIjKlMnOpQrStUv', 'n_ZyXwVuTsRqPoNmLkJiHgFe'];
  const mux = new MuxClient(server.url('_mux', workspace));

  // ⚠ These are the names that MATTER, and the reason is the filesystem rather
  // than the relay. A docName is `${workspaceId}/${room}` and DocHub turns it
  // straight into `<data>/yjs/<docName>.bin`, so a room name carrying `../` does
  // not reach another room in memory — it reaches another room's FILE, which the
  // next restart loads. That is a cross-workspace write with a delay on it, and
  // it is exactly what the per-frame charset check exists to refuse.
  const escapes = [
    { room: `../${other}/n_secret`, at: join(other, 'n_secret.bin') },
    { room: '../escaped', at: 'escaped.bin' },
  ];
  const alsoBad = ['', 'a.b', 'a b', 'a'.repeat(301), `${other}/n_secret`];

  try {
    await mux.connect();
    await mux.syncAll(rooms);

    // Hostile frames interleaved with legitimate ones, on the SAME socket. Each
    // is refused per frame, and none of them may take the socket down.
    for (const { room } of escapes) {
      mux.sendFrame(room, syncPayload(SYNC.SYNC_UPDATE, updateFor('written where it should not be')));
    }
    for (const room of alsoBad) mux.sendFrame(room, syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
    mux.sendRaw(Uint8Array.from([0x7f, 0x7f, 0x7f]));            // not a frame at all

    for (const [i, room] of rooms.entries()) mux.pushUpdate(room, updateFor(`mux body ${i}`));

    // Every legitimate room really is on the server, in THIS workspace, with
    // these bytes — read back over a connection the mux client does not own.
    for (const [i, room] of rooms.entries()) {
      assert.equal(
        await readRoom(workspace, room), `mux body ${i}`,
        `${room} did not reach the server over the mux`,
      );
    }
    assert.equal(mux.connected, true, 'a hostile frame closed the socket');

    // Drop the socket. DocHub flushes a room when its last peer leaves, so once
    // the legitimate snapshots are on disk, every room this socket ever opened
    // has had its chance to write — and the escapes must have written NOTHING.
    mux.close();
    const flushed = await until(
      () => rooms.every((r) => existsSync(join(server.snapshotDir, workspace, `${r}.bin`))),
      6000,
    );
    assert.ok(flushed, 'the mux socket dropping did not flush the rooms it carried');

    for (const { room, at } of escapes) {
      assert.equal(
        existsSync(join(server.snapshotDir, at)), false,
        `a frame naming ${JSON.stringify(room)} wrote ${at} — it escaped its workspace`,
      );
    }
  } finally {
    mux.abort();
  }
});

scenario('79b a mux client and a legacy per-room client converge on one room', async ({ workspace }) => {
  // Spec §"Assumptions only a real vault can confirm", item 10: the mixed-fleet
  // claim was inferred rather than measured end to end, and slice 1 was told to
  // add exactly this. Two connection SHAPES onto one `Y.Doc`, over the shipped
  // process, with a room name a real node would have.
  const room = 'n_AbCdEfGhIjKlMnOpQrStUv';
  const doc = new Y.Doc();
  const legacy = new DocLink(server.url(room, workspace), doc);
  const mux = new MuxClient(server.url('_mux', workspace));

  try {
    legacy.connect();
    assert.equal(await legacy.waitSync(4000), true, 'the legacy client never synced');
    await mux.connect();
    await mux.syncAll([room]);

    doc.getText('content').insert(0, 'written on a per-room socket');
    assert.equal(
      await until(() => mux.textOf(room) === 'written on a per-room socket', 4000), true,
      `the mux client never saw the legacy edit (has ${JSON.stringify(mux.textOf(room))})`,
    );

    // Back the other way, doc-free: the mux client computes the delta from the
    // bytes it holds, never from a resident document for that room.
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, mux.ledger.get(room));
    const sv = Y.encodeStateVector(scratch);
    scratch.getText('content').insert(scratch.getText('content').length, ' + and on a mux one');
    const delta = Y.encodeStateAsUpdate(scratch, sv);
    scratch.destroy();
    mux.pushUpdate(room, delta);

    const expected = 'written on a per-room socket + and on a mux one';
    assert.equal(
      await until(() => doc.getText('content').toString() === expected, 4000), true,
      `the legacy client never saw the mux edit (has ${JSON.stringify(doc.getText('content').toString())})`,
    );
    assert.equal(await readRoom(workspace, room), expected, 'the server holds neither version');
  } finally {
    mux.abort();
    legacy.destroy();
    doc.destroy();
  }
});

// ============================================================ main

// ============================================================ C8

/** Deterministic pseudo-binary content: a PNG signature and then noise. */
function attachmentBytes(length, seed) {
  const out = new Uint8Array(length);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 8; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function shaOf(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

// ⚠ C8, and the whole reason the P2 design was chosen: two REAL engines, one
// REAL server, and an attachment that both of them replace while they cannot see
// each other. `b` is one LWW register, so the workspace converges on one of the
// two versions — and the other one must still be there, as a file, on every peer.
scenario('C8 two engines replace one attachment while partitioned and nobody loses bytes', async ({ make }) => {
  const ann = make('Ann');
  const bob = make('Bob');
  const original = attachmentBytes(120_000, 1);
  const annVersion = attachmentBytes(130_000, 2);
  const bobVersion = attachmentBytes(145_000, 3);

  await ann.start();
  await ann.userCreateBinary('img/diagram.png', original);
  await ann.settle();
  await bob.start();
  assert.ok((await settleAll([ann, bob])).converged, 'clients did not reach quiescence');

  // The one-way half first: B holds the same bytes, through the store, byte for byte.
  assert.equal(bob.binaryAt('img/diagram.png'), hex(original), 'Bob did not materialize it');
  const nodeId = ann.nodeAt('img/diagram.png');
  assert.ok(nodeId, 'no node was minted for the attachment');

  // Both go offline and save a new version of the same file.
  ann.partition();
  bob.partition();
  await ann.userReplaceBinary('img/diagram.png', annVersion);
  await ann.settle();
  await bob.userReplaceBinary('img/diagram.png', bobVersion);
  await bob.settle();

  // Each published its own bytes: a content-addressed store has no concept of
  // overwriting, so neither upload destroyed the other.
  const annRef = ann.tree.get(nodeId).b;
  const bobRef = bob.tree.get(nodeId).b;
  assert.notEqual(annRef, bobRef, 'the two peers published the same reference');

  // The partition heals. From here on, no bytes may be uploaded for the fork:
  // the store already holds them.
  ann.blobPatches.length = 0;
  bob.blobPatches.length = 0;
  await ann.reconnect();
  await bob.reconnect();
  assert.ok((await settleAll([ann, bob], { rounds: 30 })).converged, 'the peers never settled');

  const winner = ann.tree.get(nodeId).b;
  assert.equal(winner, bob.tree.get(nodeId).b, 'the peers disagree about the winning reference');
  const winnerHex = winner.startsWith(shaOf(annVersion)) ? hex(annVersion) : hex(bobVersion);
  const loserHex = winnerHex === hex(annVersion) ? hex(bobVersion) : hex(annVersion);

  // Two files, on BOTH peers, with identical names and identical bytes.
  const annFiles = ann.binaryLayout();
  const bobFiles = bob.binaryLayout();
  assert.deepEqual(
    Object.keys(annFiles).sort(), Object.keys(bobFiles).sort(),
    'the two peers hold different files',
  );
  assert.deepEqual(annFiles, bobFiles, 'the two peers hold different BYTES under the same names');
  assert.equal(Object.keys(annFiles).length, 2, `expected two files, got ${Object.keys(annFiles)}`);
  assert.equal(annFiles['Shared/img/diagram.png'], winnerHex, 'the winner is at the canonical path');
  const forkPath = Object.keys(annFiles).find((p) => p !== 'Shared/img/diagram.png');
  assert.ok(forkPath.includes('conflicted copy'), `the second file is not a conflicted copy: ${forkPath}`);
  assert.equal(annFiles[forkPath], loserHex, 'the conflicted copy does not hold the losing bytes');

  // Identical tree state, ids included: the fork is a real node both peers see.
  assert.equal(ann.treeState(), bob.treeState(), 'the peers disagree about the tree');

  // ⚠ ZERO BYTES UPLOADED after the merge. Publishing the conflicted copy is a
  // HEAD hit plus a tree write, because the bytes are already in the store.
  assert.deepEqual(
    [...ann.blobPatches, ...bob.blobPatches], [],
    'the conflicted copy was re-uploaded instead of being recognised by hash',
  );

  // And it is stable: another round changes nothing on either side.
  const before = { ann: ann.binaryLayout(), bob: bob.binaryLayout(), tree: ann.treeState() };
  await settleAll([ann, bob]);
  assert.deepEqual(ann.binaryLayout(), before.ann, 'Ann kept working after convergence');
  assert.deepEqual(bob.binaryLayout(), before.bob, 'Bob kept working after convergence');
  assert.equal(ann.treeState(), before.tree, 'the tree kept changing after convergence');
});

async function main() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--only=')) setFilter(arg.slice('--only='.length));
  }

  // Registered here rather than at module scope so the cases close over the
  // server this run actually started, and so `--only=` filters them like the rest.
  registerBlobCases(() => server, BLOB_PORT);
  // P3 slice 2. Its own process, because one of its cases needs a server from
  // BEFORE the mux route existed and a flag would prove nothing.
  const muxTree = registerMuxTreeCases(() => server, LEGACY_PORT);
  // P3 slice 3. Its own pre-P3 process too, for the same reason: an old server
  // ACCEPTS the mux upgrade, so "an old server keeps its note sync" can only be
  // asked of that server's own bytes.
  const rooms = registerRoomCases(() => server, LEGACY_PORT + 40);

  console.log('ShadowLink — structural end-to-end (P1 spec §10 Group C, P2 spec §11 Group C)\n');
  let summary = { failed: 1, passed: 0, skipped: 0 };
  try {
    server = await startServer({ port: PORT });
    await muxTree.start();
    await rooms.start();
    summary = await run();
  } catch (err) {
    console.error(`✗ STRUCTURAL E2E FAILED to start: ${err?.stack ?? err}`);
  } finally {
    await muxTree.stop();
    await rooms.stop();
    if (server !== null) {
      await server.stop();
      server.cleanup();
    }
  }

  const { failed, passed, skipped } = summary;
  console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
  if (failed > 0) console.error('\n✗ STRUCTURAL E2E FAILED');
  else console.log('\n✓ STRUCTURAL E2E PASSED');
  // Pooled sockets can keep the loop alive a moment longer.
  await sleep(100);
  return failed > 0 ? 1 : 0;
}

// Deliberately NOT `await main()`. A top-level await that is still pending when
// `process.exit` runs makes Node rewrite a clean exit code into 13, so the whole
// run is scheduled off a callback and the module itself evaluates to completion.
main().then(
  (code) => process.exit(code),
  (err) => { console.error(`✗ STRUCTURAL E2E CRASHED: ${err?.stack ?? err}`); process.exit(1); },
);
