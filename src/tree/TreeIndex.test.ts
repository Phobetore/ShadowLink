import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTree, DIR_SENTINEL } from './TreeIndex.ts';
import { fold } from './paths.ts';
import { NODE_ID_RE } from './ids.ts';
import type { NodeFields } from './types.ts';

/** A deterministic, well-formed nodeId built from a readable prefix. */
const nid = (prefix: string): string => prefix.padEnd(22, '0');

const file = (d: string, n: string, extra: Partial<NodeFields> = {}): NodeFields =>
  ({ k: 'f', d, n, g: 1, c: 0, ...extra });
const dir = (d: string, n: string, extra: Partial<NodeFields> = {}): NodeFields =>
  ({ k: 'd', d, n, g: 1, c: 0, ...extra });
/** A seeded (publishable, materializable) file. */
const seeded = (d: string, n: string, extra: Partial<NodeFields> = {}): NodeFields =>
  file(d, n, { s: 1, ...extra });

type Entry = [string, NodeFields];

/** Seeded LCG, so a shuffle failure is reproducible. */
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

// -------------------------------------------------------------- purity

// Spec risk R12: this index is recomputed wholesale, never patched. That is
// only safe if the computation is genuinely order-independent.
test('deriveTree is order-independent across 50 shuffles', () => {
  const entries: Entry[] = [
    [nid('a'), seeded('Notes', 'todo.md')],
    [nid('b'), seeded('Notes', 'todo.md')],              // collides with a
    [nid('c'), seeded('Notes', 'TODO.md')],              // collides case-insensitively
    [nid('d'), file('Notes', 'draft.md')],               // unseeded => pending
    [nid('e'), seeded('', '../escape.md')],              // invalid
    [nid('f'), seeded('Notes', 'gone.md', { x: 1, xa: 9 })],       // dead
    [nid('g'), dir('', 'Notes')],
    [nid('h'), dir('', 'Notes')],                        // duplicate dir node
    [nid('i'), dir('', 'Archive', { x: 1 })],            // dead dir
    [nid('j'), seeded('Deep/Nested/Path', 'leaf.md')],
    [nid('k'), seeded('Archive', 'escaped.md', { x: 1, xp: 'Elsewhere' })],
    [nid('l'), dir('Deep', 'Nested')],
    // Two dead nodes at ONE path with different `xa`: deadByFoldRel must pick the
    // most recent one whatever order the entries arrive in.
    [nid('m'), seeded('Notes', 'gone.md', { x: 1, xa: 12, xh: 'hh' })],
    // Dead at the same path AND the same `xa` as `m`: the tie is broken by nodeId.
    [nid('n'), seeded('Notes', 'GONE.md', { x: 1, xa: 12, xh: 'other' })],
  ];

  const reference = deriveTree(entries);
  for (let seed = 1; seed <= 50; seed++) {
    assert.deepEqual(deriveTree(shuffle(entries, seed)), reference, `shuffle seed ${seed}`);
  }
});

// ------------------------------------------------- watcher-facing projections
//
// The vault watcher needs three lookups the reconciler never asked for (spec
// §4.1 "Derived index"). They live on the same derivation on purpose: a parallel
// index would be a second thing to keep in step with the first, and spec risk
// R12 is precisely about two views of the tree drifting apart unnoticed.

test('liveByFoldRel keys every live node on its STORED path, files and dirs alike', () => {
  const seededFile = nid('a');
  const unseededFile = nid('b');
  const folder = nid('c');
  const t = deriveTree([
    [seededFile, seeded('Notes', 'todo.md')],
    [unseededFile, file('Notes', 'draft.md')],
    [folder, dir('', 'Notes')],
  ]);

  assert.equal(t.liveByFoldRel.get(fold('Notes/todo.md')), seededFile);
  // I6 governs MATERIALIZATION, not identity: an unpublished node exists in the
  // tree, so a local create at its path must bind to it rather than fork it.
  assert.equal(t.liveByFoldRel.get(fold('Notes/draft.md')), unseededFile);
  assert.equal(t.liveByFoldRel.get(fold('Notes')), folder);
  assert.equal(t.liveByFoldRel.size, 3);
});

test('liveByFoldRel is keyed on the stored path, never on the collision suffix', () => {
  const low = nid('a');
  const high = nid('b');
  const t = deriveTree([
    [high, seeded('Notes', 'todo.md')],
    [low, seeded('Notes', 'todo.md')],
  ]);

  // Both nodes STORE `Notes/todo.md`; only the derived path carries the suffix.
  assert.equal(t.liveByFoldRel.get(fold('Notes/todo.md')), low, 'lowest nodeId wins');
  assert.equal(t.liveByFoldRel.size, 1);
  assert.ok(!t.liveByFoldRel.has(fold('Notes/todo (2).md')));
  assert.equal(t.derivedPath.get(low), 'Notes/todo.md');
  assert.equal(t.derivedPath.get(high), 'Notes/todo (2).md');
});

test('derivedPath covers every live node — dirs and unseeded files included — and no dead one', () => {
  const seededFile = nid('a');
  const unseededFile = nid('b');
  const folder = nid('c');
  const deadFile = nid('d');
  const t = deriveTree([
    [seededFile, seeded('Notes', 'todo.md')],
    [unseededFile, file('Notes', 'draft.md')],
    [folder, dir('', 'Notes')],
    [deadFile, seeded('Notes', 'gone.md', { x: 1, xa: 5 })],
  ]);

  assert.equal(t.derivedPath.get(seededFile), 'Notes/todo.md');
  assert.equal(t.derivedPath.get(unseededFile), 'Notes/draft.md');
  assert.equal(t.derivedPath.get(folder), 'Notes');
  assert.ok(!t.derivedPath.has(deadFile), 'a dead node has no derived path');
  assert.equal(t.derivedPath.size, 3);
});

test('deadByFoldRel keeps the most recently deleted node at a path, ties by lowest nodeId', () => {
  const older = nid('a');
  const newer = nid('b');
  const tiedHigh = nid('y');
  const tiedLow = nid('x');
  const t = deriveTree([
    [older, seeded('Notes', 'gone.md', { x: 1, xa: 100, xh: 'old' })],
    [newer, seeded('Notes', 'GONE.md', { x: 1, xa: 200, xh: 'new' })],
    [tiedHigh, seeded('', 'tied.md', { x: 1, xa: 50, xh: 'hi' })],
    [tiedLow, seeded('', 'tied.md', { x: 1, xa: 50, xh: 'lo' })],
  ]);

  assert.deepEqual(t.deadByFoldRel.get(fold('Notes/gone.md')), {
    nodeId: newer, xa: 200, xh: 'new',
  }, 'greatest xa wins, whatever the case of the stored name');
  assert.equal(t.deadByFoldRel.get(fold('tied.md'))?.nodeId, tiedLow, 'ties break on nodeId');
  assert.equal(t.deadByFoldRel.size, 2);
});

test('a live node and a dead node at one path appear in their own map only', () => {
  const live = nid('a');
  const gone = nid('b');
  const t = deriveTree([
    [live, seeded('', 'todo.md')],
    [gone, seeded('', 'todo.md', { x: 1, xa: 5 })],
  ]);

  assert.equal(t.liveByFoldRel.get(fold('todo.md')), live);
  assert.equal(t.deadByFoldRel.get(fold('todo.md'))?.nodeId, gone);
  assert.ok(!t.derivedPath.has(gone));
});

// I10 again, for the new maps: an invalid node is skipped ENTIRELY. A watcher
// that found one would bind a local file to a node that can never materialize.
test('an invalid node appears in none of the watcher-facing maps', () => {
  const badLive = nid('a');
  const badDead = nid('b');
  const t = deriveTree([
    [badLive, seeded('', '../escape.md')],
    [badDead, seeded('', '.hidden.md', { x: 1, xa: 5 })],
  ]);

  assert.deepEqual(t.invalid, [badLive, badDead]);
  assert.equal(t.liveByFoldRel.size, 0);
  assert.equal(t.deadByFoldRel.size, 0);
  assert.equal(t.derivedPath.size, 0);
});

test('a node that escaped a cascade is live in liveByFoldRel and absent from deadByFoldRel', () => {
  const escaped = nid('a');
  const t = deriveTree([[escaped, seeded('Projects', 'note.md', { x: 1, xa: 9, xp: 'Archive' })]]);

  assert.equal(t.liveByFoldRel.get(fold('Projects/note.md')), escaped);
  assert.equal(t.derivedPath.get(escaped), 'Projects/note.md');
  assert.equal(t.deadByFoldRel.size, 0);
});

test('deriveTree does not mutate its input and returns fresh collections', () => {
  const entries: Entry[] = [[nid('a'), seeded('Notes', 'a.md')]];
  const before = JSON.stringify(entries);
  const first = deriveTree(entries);
  first.files.set('injected', 'x');
  const second = deriveTree(entries);
  assert.equal(JSON.stringify(entries), before);
  assert.ok(!second.files.has('injected'));
});

// -------------------------------------------------------------- gates

// Invariant I6: an unpublished node is never materializable, so it must not
// even reserve the path it would eventually want.
test('an unseeded live file is pending only, and reserves no path', () => {
  const id = nid('a');
  const t = deriveTree([[id, file('Notes', 'draft.md')]]);

  assert.deepEqual(t.pending, [id]);
  assert.equal(t.files.size, 0);
  assert.equal(t.wantAtFold.size, 0);
  assert.equal(t.folders.size, 0, 'an unpublishable file implies no folders either');
  assert.equal(t.deadFold.size, 0);
  assert.deepEqual(t.invalid, []);
});

// Invariant I10: an invalid node is SKIPPED, never deleted, and must not leak
// its path into any set the reconciler acts on.
test('an invalid node lands in invalid and appears nowhere else', () => {
  const bad = nid('a');
  const good = nid('b');
  const t = deriveTree([
    // Dead as well as invalid: the validity gate must run first, so this node
    // must not even contribute a tombstoned path.
    [bad, seeded('', '../escape', { x: 1 })],
    [good, seeded('Notes', 'ok.md')],
  ]);

  assert.deepEqual(t.invalid, [bad]);
  assert.deepEqual(t.pending, []);
  assert.ok(!t.files.has(bad));
  assert.deepEqual([...t.files.keys()], [good]);
  assert.equal(t.deadFold.size, 0);
  assert.equal(t.deadFolders.size, 0);
  assert.ok(!t.wantAtFold.has(fold('../escape')));
  assert.ok(!t.folders.has('..'));
});

test('a file with a non-md extension is invalid, and a directory without one is not', () => {
  const t = deriveTree([
    [nid('a'), seeded('', 'image.png')],
    [nid('b'), dir('', 'Attachments')],
  ]);
  assert.deepEqual(t.invalid, [nid('a')]);
  assert.deepEqual([...t.folders], ['Attachments']);
});

// -------------------------------------------------------------- liveness

test('a dead file contributes its fold to deadFold and not to files', () => {
  const id = nid('a');
  const t = deriveTree([[id, seeded('Notes', 'Gone.md', { x: 1, xa: 5, xb: 'Ada' })]]);

  assert.deepEqual([...t.deadFold], [fold('Notes/Gone.md')]);
  assert.equal(t.files.size, 0);
  assert.equal(t.wantAtFold.size, 0);
  assert.equal(t.folders.size, 0);
  assert.deepEqual(t.deadFolders, new Set());
  assert.deepEqual(t.pending, []);
  assert.deepEqual(t.invalid, []);
});

// Spec §2.2: a cascade tombstone only applies while the node is still under the
// folder it was cascaded from. Rename/move beats delete.
test('a file that escaped a folder-delete cascade is live and materialized', () => {
  const escaped = nid('a');
  const stillInside = nid('b');
  const t = deriveTree([
    [escaped, seeded('Projects', 'note.md', { x: 1, xp: 'Archive' })],
    [stillInside, seeded('Archive/sub', 'other.md', { x: 1, xp: 'Archive' })],
  ]);

  assert.equal(t.files.get(escaped), 'Projects/note.md');
  assert.equal(t.wantAtFold.get(fold('Projects/note.md')), escaped);
  assert.ok(!t.files.has(stillInside));
  assert.deepEqual([...t.deadFold], [fold('Archive/sub/other.md')]);
});

// -------------------------------------------------------------- folders

test('ancestors are implied by a file path even with no directory node', () => {
  const id = nid('a');
  const t = deriveTree([[id, seeded('x/y', 'z.md')]]);

  assert.deepEqual(t.folders, new Set(['x', 'x/y']));
  assert.equal(t.wantAtFold.get(fold('x')), DIR_SENTINEL);
  assert.equal(t.wantAtFold.get(fold('x/y')), DIR_SENTINEL);
  assert.equal(t.wantAtFold.get(fold('x/y/z.md')), id);
  assert.equal(t.wantAtFold.size, 3);
});

// Spec §1.4: two live folder nodes at one path ARE one directory. Suffixing
// them is what forked the folder in candidate 3.
test('two live dir nodes at the same path yield one folder and no "(2)" directory', () => {
  const t = deriveTree([
    [nid('a'), dir('', 'Projects')],
    [nid('b'), dir('', 'Projects')],
    [nid('c'), dir('', 'projects')],   // same folder, different case
  ]);

  assert.deepEqual([...t.folders].sort(), ['Projects', 'projects']);
  assert.ok(![...t.folders].some((p) => p.includes('(2)')));
  assert.equal(t.wantAtFold.size, 1, 'all three fold to one occupied path');
  assert.equal(t.wantAtFold.get(fold('Projects')), DIR_SENTINEL);
});

test('a dead directory appears in deadFolders and not in folders', () => {
  const deadDir = nid('a');
  const liveDir = nid('b');
  const t = deriveTree([
    [deadDir, dir('', 'Archive', { x: 1, xa: 7 })],
    [liveDir, dir('', 'Notes')],
  ]);

  assert.deepEqual(t.deadFolders, new Set(['Archive']));
  assert.deepEqual(t.folders, new Set(['Notes']));
  assert.deepEqual([...t.deadFold], [fold('Archive')]);
  assert.deepEqual([...t.wantAtFold], [[fold('Notes'), DIR_SENTINEL]]);
});

// The empty-folder sweep skips a dead folder a live node still claims.
test('a dead dir whose path a live file still needs stays claimed in wantAtFold', () => {
  const deadDir = nid('a');
  const t = deriveTree([
    [deadDir, dir('', 'Archive', { x: 1 })],
    [nid('b'), seeded('Archive', 'kept.md', { x: 1, xp: 'Elsewhere' })],
  ]);

  assert.deepEqual(t.deadFolders, new Set(['Archive']));
  assert.equal(t.wantAtFold.get(fold('Archive')), DIR_SENTINEL);
  assert.ok(t.deadFold.has(fold('Archive')));
});

// -------------------------------------------------------------- collisions

test('colliding live seeded files are suffixed by nodeId order, both reserved', () => {
  const low = nid('a');
  const high = nid('b');
  const t = deriveTree([
    [high, seeded('Notes', 'todo.md')],
    [low, seeded('Notes', 'todo.md')],
  ]);

  assert.equal(t.files.get(low), 'Notes/todo.md');
  assert.equal(t.files.get(high), 'Notes/todo (2).md');
  assert.equal(t.wantAtFold.get(fold('Notes/todo.md')), low);
  assert.equal(t.wantAtFold.get(fold('Notes/todo (2).md')), high);
  assert.deepEqual(t.folders, new Set(['Notes']));
});

// An unseeded sibling still holds its slot in the suffix assignment, so the
// path a materialized file sits at does not churn when the sibling publishes.
test('an unseeded colliding file holds its slot without reserving a path', () => {
  const unseededLow = nid('a');
  const seededHigh = nid('b');
  const t = deriveTree([
    [unseededLow, file('Notes', 'todo.md')],
    [seededHigh, seeded('Notes', 'todo.md')],
  ]);

  assert.deepEqual(t.pending, [unseededLow]);
  assert.equal(t.files.get(seededHigh), 'Notes/todo (2).md');
  assert.equal(t.wantAtFold.size, 2, 'the suffixed file plus its Notes folder');
  assert.ok(!t.wantAtFold.has(fold('Notes/todo.md')));
});

// -------------------------------------------------------------- shape

test('paths are share-relative and diagnostics arrays are sorted nodeId lists', () => {
  const t = deriveTree([
    [nid('c'), file('', 'p2.md')],
    [nid('a'), file('', 'p1.md')],
    [nid('z'), seeded('', 'bad/name.md')],
    [nid('b'), seeded('', '.hidden.md')],
  ]);

  assert.deepEqual(t.pending, [nid('a'), nid('c')]);
  assert.deepEqual(t.invalid, [nid('b'), nid('z')]);
  for (const id of [...t.pending, ...t.invalid]) assert.match(id, NODE_ID_RE);
  for (const p of t.files.values()) assert.ok(!p.startsWith('/'), `not share-relative: ${p}`);
});

test('an empty snapshot derives an empty desired state', () => {
  const t = deriveTree([]);
  assert.equal(t.files.size, 0);
  assert.equal(t.folders.size, 0);
  assert.equal(t.wantAtFold.size, 0);
  assert.equal(t.deadFold.size, 0);
  assert.equal(t.deadFolders.size, 0);
  assert.deepEqual(t.pending, []);
  assert.deepEqual(t.invalid, []);
  assert.equal(t.liveByFoldRel.size, 0);
  assert.equal(t.deadByFoldRel.size, 0);
  assert.equal(t.derivedPath.size, 0);
});

test('DIR_SENTINEL can never be mistaken for a nodeId', () => {
  assert.ok(!NODE_ID_RE.test(DIR_SENTINEL));
});

// ── Regression found in review of this slice ─────────────────────────────────

// A folder must outrank a file at the same folded path in wantAtFold. With an
// explicit dir node suffixedVaultPath already separates them, so the ranking is
// only reachable through an IMPLIED ancestor folder — which is why a mutation of
// that line survived the original suite.
test('an implied ancestor folder claims wantAtFold over a colliding file', () => {
  const out = deriveTree([
    [nid('file'), { k: 'f', d: '', n: 'Notes.md', g: 1, c: 0, s: 1 }],
    [nid('child'), { k: 'f', d: 'Notes.md', n: 'child.md', g: 1, c: 0, s: 1 }],
  ]);
  // the child implies the ancestor folder 'Notes.md'
  assert.ok(out.folders.has('Notes.md'));
  // and the folder, not the file, owns that folded path
  assert.equal(out.wantAtFold.get(fold('Notes.md')), DIR_SENTINEL);
  // documented consequence (carry-forward CF-4): files still records the file there,
  // so the reconciler — not the index — must resolve the file-vs-implied-folder clash
  assert.equal(out.files.get(nid('file')), 'Notes.md');
});
