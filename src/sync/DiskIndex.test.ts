// src/sync/DiskIndex.test.ts
//
// DiskIndex is the fold-safe substrate every reconciler occupancy check goes
// through (invariant I11). These tests are adversarial about exactly the traps
// its header comment calls out: a case-variant neighbour a naive lookup misses,
// a share filter a naive prefix check gets wrong (`SharedNotes` vs `Shared`),
// and folder mutations that must carry descendants without capturing a sibling
// that merely shares a prefix (`Notes` vs `Notes2`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiskIndex } from './DiskIndex.ts';
import { FakeVault } from './fakes.ts';

function buildFrom(seed: (v: FakeVault) => void, shareRoot = 'Shared'): DiskIndex {
  const v = new FakeVault();
  seed(v);
  return DiskIndex.build(v, shareRoot);
}

// ---------------------------------------------------------------- build / share filter

test('build finds a case-variant path and literal() returns the real on-disk casing', () => {
  const idx = buildFrom((v) => {
    v.seed('Shared/Notes/readme.md', 'f', 'hi');
  });

  assert.equal(idx.hasFold('shared/notes/README.MD'), true);
  assert.equal(idx.literal('shared/notes/README.MD'), 'Shared/Notes/readme.md');
  assert.equal(idx.kindOf('shared/notes/README.MD'), 'f');
});

test('entries outside the share are excluded, including the SharedNotes/Shared prefix trap', () => {
  const idx = buildFrom((v) => {
    v.seed('Shared/a.md', 'f');
    v.seed('SharedNotes/x.md', 'f');   // prefix trap: NOT inside `Shared`
    v.seed('Other/b.md', 'f');
  });

  assert.equal(idx.hasFold('Shared/a.md'), true);
  assert.equal(idx.hasFold('SharedNotes/x.md'), false);
  assert.equal(idx.hasFold('Other/b.md'), false);
  assert.equal(idx.size(), 2, 'only Shared (the folder) and Shared/a.md are in-share');
});

test('the share root folder itself is included, not just its contents', () => {
  const idx = buildFrom((v) => {
    v.seed('Shared/a.md', 'f');
  });
  assert.equal(idx.hasFold('Shared'), true);
  assert.equal(idx.kindOf('shared'), 'd');
});

test('a dot path is invisible to the index because FakeVault.list() hides it', () => {
  const idx = buildFrom((v) => {
    v.seed('Shared/.git/config', 'f', 'x');
    v.seed('Shared/visible.md', 'f');
  });

  // list() -- and therefore build() -- never sees dot paths (VaultPort's own doc
  // comment: "list() ... Never sees dot paths"). The reconciler's folder sweep
  // (step 5, spec test 39) has to reach past this index and call vault.listDir()
  // directly to see a surviving `.git`; DiskIndex by construction cannot see it.
  assert.equal(idx.hasFold('Shared/.git/config'), false);
  assert.equal(idx.hasFold('Shared/.git'), false);
  assert.equal(idx.hasFold('Shared/visible.md'), true);
});

test('accessors return undefined for a path that is not in the index', () => {
  const idx = buildFrom((v) => { v.seed('Shared/a.md', 'f'); });

  assert.equal(idx.literal('Shared/nope.md'), undefined);
  assert.equal(idx.kindOf('Shared/nope.md'), undefined);
  assert.equal(idx.hasFold('Shared/nope.md'), false);
});

// ---------------------------------------------------------------- filesUnderShare

test('filesUnderShare returns files only, never folders, as literal paths', () => {
  const idx = buildFrom((v) => {
    v.seed('Shared/Notes/a.md', 'f');
    v.seed('Shared/Notes/deep', 'd');
    v.seed('Shared/Notes/deep/b.md', 'f');
  });

  assert.deepEqual(idx.filesUnderShare(), ['Shared/Notes/a.md', 'Shared/Notes/deep/b.md']);
});

// ---------------------------------------------------------------- add/move/remove bookkeeping

test('add records a fresh literal entry and keeps size/hasFold/kindOf/literal consistent', () => {
  const idx = buildFrom((v) => { v.seed('Shared/a.md', 'f'); });
  assert.equal(idx.size(), 2);

  idx.add('Shared/Notes', 'd');
  idx.add('Shared/Notes/b.md', 'f');

  assert.equal(idx.size(), 4);
  assert.equal(idx.hasFold('shared/notes'), true);
  assert.equal(idx.literal('shared/notes/B.MD'), 'Shared/Notes/b.md');
  assert.equal(idx.kindOf('shared/notes'), 'd');
  assert.deepEqual(idx.filesUnderShare(), ['Shared/Notes/b.md', 'Shared/a.md']);
});

test('move on a folder relocates every descendant and does not capture a Notes2 sibling', () => {
  const idx = buildFrom((v) => {
    v.seed('Shared/Notes/a.md', 'f', 'A');
    v.seed('Shared/Notes/deep/b.md', 'f', 'B');
    v.seed('Shared/Notes2/c.md', 'f', 'C');
  });
  const before = idx.size();

  idx.move('Shared/Notes', 'Shared/Archive');

  assert.equal(idx.size(), before, 'a move renames entries, it never adds or drops any');
  assert.equal(idx.hasFold('Shared/Notes'), false);
  assert.equal(idx.hasFold('Shared/Notes/a.md'), false);
  assert.equal(idx.literal('Shared/Archive'), 'Shared/Archive');
  assert.equal(idx.literal('shared/archive/a.md'), 'Shared/Archive/a.md');
  assert.equal(idx.literal('shared/archive/deep/b.md'), 'Shared/Archive/deep/b.md');

  // The sibling that merely shares a prefix must survive completely untouched.
  assert.equal(idx.hasFold('Shared/Notes2'), true);
  assert.equal(idx.literal('shared/notes2/c.md'), 'Shared/Notes2/c.md');
});

test('move on a single file relocates just that file', () => {
  const idx = buildFrom((v) => { v.seed('Shared/a.md', 'f'); });
  const before = idx.size();

  idx.move('Shared/a.md', 'Shared/b.md');

  assert.equal(idx.size(), before);
  assert.equal(idx.hasFold('Shared/a.md'), false);
  assert.equal(idx.literal('Shared/b.md'), 'Shared/b.md');
  assert.equal(idx.kindOf('Shared/b.md'), 'f');
});

test('move is a no-op when the source is not present', () => {
  const idx = buildFrom((v) => { v.seed('Shared/a.md', 'f'); });
  const before = idx.size();

  idx.move('Shared/missing.md', 'Shared/elsewhere.md');

  assert.equal(idx.size(), before);
  assert.equal(idx.hasFold('Shared/elsewhere.md'), false);
});

test('remove on a folder drops its descendants and nothing else', () => {
  const idx = buildFrom((v) => {
    v.seed('Shared/Notes/a.md', 'f');
    v.seed('Shared/Notes/deep/b.md', 'f');
    v.seed('Shared/Notes2/c.md', 'f');
  });

  idx.remove('Shared/Notes');

  assert.equal(idx.hasFold('Shared/Notes'), false);
  assert.equal(idx.hasFold('Shared/Notes/a.md'), false);
  assert.equal(idx.hasFold('Shared/Notes/deep'), false);
  assert.equal(idx.hasFold('Shared/Notes/deep/b.md'), false);

  // The sibling that merely shares a prefix must survive.
  assert.equal(idx.hasFold('Shared/Notes2'), true);
  assert.equal(idx.hasFold('Shared/Notes2/c.md'), true);

  // What remains: Shared, Shared/Notes2, Shared/Notes2/c.md.
  assert.equal(idx.size(), 3);
});

test('remove on a file drops only that entry', () => {
  const idx = buildFrom((v) => { v.seed('Shared/a.md', 'f'); v.seed('Shared/b.md', 'f'); });
  const before = idx.size();

  idx.remove('Shared/a.md');

  assert.equal(idx.hasFold('Shared/a.md'), false);
  assert.equal(idx.hasFold('Shared/b.md'), true);
  assert.equal(idx.size(), before - 1);
});

test('remove is a no-op when the path is not present', () => {
  const idx = buildFrom((v) => { v.seed('Shared/a.md', 'f'); });
  const before = idx.size();

  idx.remove('Shared/missing.md');

  assert.equal(idx.size(), before);
});

// ---------------------------------------------------------------- realistic layout, end to end

test('build reflects a realistic layout: nested files, a dot path, and out-of-share content', () => {
  const idx = buildFrom((v) => {
    v.seed('Shared/Notes/readme.md', 'f', 'hello');
    v.seed('Shared/Notes/deep/nested.md', 'f', 'x');
    v.seed('Shared/other.md', 'f', 'y');
    v.seed('Shared/.git/config', 'f', 'ignored');   // dot path: invisible to list()
    v.seed('Elsewhere/outside.md', 'f');            // outside the share entirely
  });

  assert.deepEqual(idx.filesUnderShare(), [
    'Shared/Notes/deep/nested.md',
    'Shared/Notes/readme.md',
    'Shared/other.md',
  ]);
  // Shared, Shared/Notes, Shared/Notes/deep (folders) + the 3 files above = 6.
  // Neither `.git` entry nor anything under `Elsewhere` counts.
  assert.equal(idx.size(), 6);
});
