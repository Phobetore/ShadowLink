// src/sync/fakes.test.ts
// The fakes are the substrate every Group B reconciler test runs on, so they get
// tested themselves. A fake that is wrong in an interesting way — case-sensitive
// where the real filesystem is not, silently overwriting where vault.create throws,
// hard-dropping what vault.trash retains — does not fail loudly. It makes every
// downstream test pass while the real thing corrupts the user's vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocs, FakeVault } from './fakes.ts';

// ---------------------------------------------------------------- case folding

// macOS (APFS/HFS+) and Windows (NTFS) are case-insensitive. Obsidian's own
// getAbstractFileByPath is a case-SENSITIVE map lookup, which is exactly the
// mismatch invariant I11 exists to absorb: the index says the path is free,
// the filesystem disagrees, and vault.create truncates the neighbour.
test('case-insensitive vault resolves a case-variant path to the same entry', async () => {
  const v = new FakeVault();
  v.seed('notes/readme.md', 'f', 'original bytes');

  assert.equal(await v.exists('notes/readme.md'), true);
  assert.equal(await v.exists('Notes/README.md'), true, 'a case variant is the same file');
  assert.equal(await v.read('Notes/README.md'), 'original bytes');
});

test('case-insensitive vault treats a case-variant create as a collision', async () => {
  const v = new FakeVault();
  v.seed('notes/readme.md', 'f', 'original bytes');

  await assert.rejects(() => v.create('Notes/README.md', 'new bytes'), /exists/i);
  // The collision must not have damaged the incumbent.
  assert.equal(await v.read('notes/readme.md'), 'original bytes');
  assert.equal(v.list().filter((e) => e.kind === 'f').length, 1);
});

test('case-sensitive vault keeps case-variant paths as two distinct files', async () => {
  const v = new FakeVault({ caseInsensitive: false });
  v.seed('notes/readme.md', 'f', 'original bytes');

  assert.equal(await v.exists('Notes/README.md'), false);
  await v.createFolder('Notes');
  await v.create('Notes/README.md', 'new bytes');

  assert.equal(await v.read('notes/readme.md'), 'original bytes');
  assert.equal(await v.read('Notes/README.md'), 'new bytes');
  assert.equal(v.list().filter((e) => e.kind === 'f').length, 2);
});

// Spec test 25: this refusal is the whole reason a case-only rename has to be
// routed out through ShadowLink Staging/ and back in.
test('case-insensitive vault refuses a case-only rename', async () => {
  const v = new FakeVault();
  v.seed('notes.md', 'f', 'body');

  await assert.rejects(() => v.rename('notes.md', 'Notes.md'), /exists/i);
  assert.equal(await v.read('notes.md'), 'body', 'the source survives a refused rename');

  // ...and the two-step staging round trip does work.
  await v.createFolder('ShadowLink Staging');
  await v.rename('notes.md', 'ShadowLink Staging/tmp.md');
  await v.rename('ShadowLink Staging/tmp.md', 'Notes.md');
  assert.equal(await v.read('Notes.md'), 'body');
  assert.deepEqual(Object.keys(v.snapshot()), ['Notes.md']);
});

// ---------------------------------------------------------------- mutations

test('create on an existing path throws and leaves the incumbent untouched', async () => {
  const v = new FakeVault();
  v.seed('Shared/a.md', 'f', 'keep me');

  await assert.rejects(() => v.create('Shared/a.md', 'clobber'), /exists/i);
  assert.equal(await v.read('Shared/a.md'), 'keep me');
});

test('createFolder on an existing folder throws and does not create parents', async () => {
  const v = new FakeVault();
  v.seed('Shared', 'd');

  await assert.rejects(() => v.createFolder('Shared'), /exists/i);
  // Spec CF-2 / §4.2: ensureDirs walks the segments itself because the vault API
  // does not create intermediates.
  await assert.rejects(() => v.createFolder('Shared/a/b'), /parent/i);
  await v.createFolder('Shared/a');
  await v.createFolder('Shared/a/b');
  assert.equal(await v.exists('Shared/a/b'), true);
});

test('create into a missing folder throws', async () => {
  const v = new FakeVault();
  await assert.rejects(() => v.create('Shared/Notes/a.md', 'x'), /parent/i);
  assert.equal(await v.exists('Shared/Notes/a.md'), false);
});

test('rename onto an occupied path throws and both entries survive', async () => {
  const v = new FakeVault();
  v.seed('Shared/a.md', 'f', 'A');
  v.seed('Shared/b.md', 'f', 'B');

  await assert.rejects(() => v.rename('Shared/a.md', 'Shared/b.md'), /exists/i);
  assert.equal(await v.read('Shared/a.md'), 'A');
  assert.equal(await v.read('Shared/b.md'), 'B');
});

test('rename of a missing source throws', async () => {
  const v = new FakeVault();
  await assert.rejects(() => v.rename('Shared/nope.md', 'Shared/yes.md'), /not found/i);
});

test('directory rename moves every descendant and leaves nothing at the old prefix', async () => {
  const v = new FakeVault();
  v.seed('Shared/Notes/a.md', 'f', 'A');
  v.seed('Shared/Notes/deep/b.md', 'f', 'B');
  v.seed('Shared/Notes/deep/empty', 'd');
  v.seed('Shared/other.md', 'f', 'O');

  await v.rename('Shared/Notes', 'Shared/Archive');

  assert.deepEqual(v.snapshot(), {
    'Shared/Archive/a.md': 'A',
    'Shared/Archive/deep/b.md': 'B',
    'Shared/other.md': 'O',
  });
  assert.equal(await v.exists('Shared/Archive/deep/empty'), true, 'empty child folders move too');
  assert.equal(await v.exists('Shared/Notes'), false);
  assert.equal(await v.exists('Shared/Notes/a.md'), false);
  // A sibling whose name merely starts with the old name must not be dragged along.
  assert.equal(await v.exists('Shared/other.md'), true);
});

test('a directory rename does not capture a sibling sharing the name prefix', async () => {
  const v = new FakeVault();
  v.seed('Shared/Notes/a.md', 'f', 'A');
  v.seed('Shared/Notes2/b.md', 'f', 'B');

  await v.rename('Shared/Notes', 'Shared/Archive');

  assert.equal(await v.read('Shared/Notes2/b.md'), 'B');
  assert.equal(await v.read('Shared/Archive/a.md'), 'A');
});

// ---------------------------------------------------------------- trash (I1)

// Invariant I1 is "no irreversible destruction, ever". A test can only prove that
// positively if the fake retains what it removed.
test('trashLocal removes from the live set but retains the bytes', async () => {
  const v = new FakeVault();
  v.seed('Shared/gone.md', 'f', 'precious');

  await v.trashLocal('Shared/gone.md');

  assert.equal(await v.exists('Shared/gone.md'), false);
  assert.equal(v.wasTrashed('Shared/gone.md'), true);
  const [entry] = v.trashedFor('Shared/gone.md');
  assert.equal(entry.data, 'precious');
  assert.equal(entry.kind, 'f');
  assert.ok(entry.trashPath.startsWith('.trash/'), 'retained under the vault-local .trash');
  assert.equal(v.trashed.get(entry.trashPath)?.data, 'precious');
});

test('trashing a directory retains every descendant', async () => {
  const v = new FakeVault();
  v.seed('Shared/Notes/a.md', 'f', 'A');
  v.seed('Shared/Notes/deep/b.md', 'f', 'B');

  await v.trashLocal('Shared/Notes');

  assert.deepEqual(v.snapshot(), {});
  assert.equal(v.wasTrashed('Shared/Notes/a.md'), true);
  assert.equal(v.trashedFor('Shared/Notes/deep/b.md')[0].data, 'B');
  assert.deepEqual(
    [...v.trashed.values()].map((e) => e.originalPath).sort(),
    ['Shared/Notes', 'Shared/Notes/a.md', 'Shared/Notes/deep', 'Shared/Notes/deep/b.md'],
    'the folder, the intermediate folder and both files are all retained',
  );
  assert.equal(await v.exists('Shared'), true, 'the parent folder is not swept up');
});

test('trashing the same path twice retains both copies', async () => {
  const v = new FakeVault();
  v.seed('Shared/a.md', 'f', 'first');
  await v.trashLocal('Shared/a.md');
  v.seed('Shared/a.md', 'f', 'second');
  await v.trashLocal('Shared/a.md');

  assert.deepEqual(
    v.trashedFor('Shared/a.md').map((e) => e.data).sort(),
    ['first', 'second'],
    'the .trash destination is uniquified, so nothing is ever overwritten',
  );
});

test('trashLocal on a missing path throws rather than silently succeeding', async () => {
  const v = new FakeVault();
  await assert.rejects(() => v.trashLocal('Shared/nope.md'), /not found/i);
});

// ---------------------------------------------------------------- visibility

// Spec test 39: a tombstoned folder whose only remaining child is `.git` must not
// be swept. That test is only meaningful if list() cannot see the dotfile and
// listDir() can — which is the real split between getAllLoadedFiles() and adapter.list().
test('list hides dot paths that exists and listDir can still see', async () => {
  const v = new FakeVault();
  v.seed('Shared/Notes/a.md', 'f', 'A');
  v.seed('Shared/Notes/.git/config', 'f', 'gitconfig');

  const listed = v.list().map((e) => e.path);
  assert.ok(!listed.some((p) => p.includes('.git')), 'the loaded-file index does not carry dotfiles');
  assert.ok(listed.includes('Shared/Notes/a.md'));

  assert.equal(await v.exists('Shared/Notes/.git/config'), true, 'the adapter sees dotfiles');
  assert.deepEqual(await v.listDir('Shared/Notes'), ['Shared/Notes/.git', 'Shared/Notes/a.md']);
});

test('listDir returns direct children only, and throws for a path that is absent or a file', async () => {
  const v = new FakeVault();
  v.seed('Shared/Notes/deep/b.md', 'f', 'B');
  v.seed('Shared/Notes/a.md', 'f', 'A');

  assert.deepEqual(await v.listDir('Shared/Notes'), ['Shared/Notes/a.md', 'Shared/Notes/deep']);
  // Invariant I2: absence of evidence is never a delete. An empty array for a
  // directory that is not there would read to the folder sweep as "safe to remove".
  await assert.rejects(() => v.listDir('Shared/Missing'), /not found/i);
  await assert.rejects(() => v.listDir('Shared/Notes/a.md'), /not a folder/i);
});

test('listDir on the vault root lists top-level entries', async () => {
  const v = new FakeVault();
  v.seed('Shared/a.md', 'f', 'A');
  v.seed('.obsidian/plugins', 'd');

  assert.deepEqual(await v.listDir(''), ['.obsidian', 'Shared']);
});

test('isOpenInLeaf reflects setOpen and folds the path', () => {
  const v = new FakeVault();
  v.seed('Shared/a.md', 'f', 'A');

  assert.equal(v.isOpenInLeaf('Shared/a.md'), false);
  v.setOpen('Shared/a.md', true);
  assert.equal(v.isOpenInLeaf('shared/A.MD'), true);
  v.setOpen('Shared/a.md', false);
  assert.equal(v.isOpenInLeaf('Shared/a.md'), false);
});

// ---------------------------------------------------------------- fault injection

test('failNext makes exactly the next call of that op throw', async () => {
  const v = new FakeVault();
  v.seed('Shared/a.md', 'f', 'A');
  const boom = new Error('EBUSY');

  v.failNext('rename', boom);
  await assert.rejects(() => v.rename('Shared/a.md', 'Shared/b.md'), (e) => e === boom);
  assert.equal(await v.exists('Shared/a.md'), true, 'a failed rename does not move anything');

  await v.rename('Shared/a.md', 'Shared/b.md');
  assert.equal(await v.read('Shared/b.md'), 'A');
});

test('failNext queues one failure per call and does not leak to other ops', async () => {
  const v = new FakeVault();
  v.seed('Shared/a.md', 'f', 'A');
  v.failNext('create', new Error('first'));
  v.failNext('create', new Error('second'));

  await assert.rejects(() => v.create('Shared/b.md', 'B'), /first/);
  await assert.rejects(() => v.create('Shared/c.md', 'C'), /second/);
  await v.create('Shared/d.md', 'D');
  assert.equal(await v.read('Shared/d.md'), 'D');
  assert.equal(await v.read('Shared/a.md'), 'A', 'the create failures did not touch other ops');
});

// ---------------------------------------------------------------- call log

// Group B asserts things like "create was never called with ''". End-state
// assertions cannot see a transient empty stub that was written and then fixed.
test('the calls log records operations in order with their arguments', async () => {
  const v = new FakeVault();
  v.seed('Shared', 'd');

  await v.create('Shared/a.md', 'A');
  await v.rename('Shared/a.md', 'Shared/b.md');
  v.isOpenInLeaf('Shared/b.md');
  await v.trashLocal('Shared/b.md');

  assert.deepEqual(v.calls, [
    { op: 'create', args: ['Shared/a.md', 'A'] },
    { op: 'rename', args: ['Shared/a.md', 'Shared/b.md'] },
    { op: 'isOpenInLeaf', args: ['Shared/b.md'] },
    { op: 'trashLocal', args: ['Shared/b.md'] },
  ]);
  assert.deepEqual(v.callsTo('create'), [{ op: 'create', args: ['Shared/a.md', 'A'] }]);
  assert.equal(v.calls.some((c) => c.op === 'create' && c.args[1] === ''), false);
});

test('a throwing call is still recorded, and seed writes nothing to the log', async () => {
  const v = new FakeVault();
  v.seed('Shared/a.md', 'f', 'A');
  assert.deepEqual(v.calls, [], 'seed is test setup, not a port call');

  await assert.rejects(() => v.create('Shared/a.md', ''));
  assert.deepEqual(v.calls, [{ op: 'create', args: ['Shared/a.md', ''] }]);

  v.resetCalls();
  assert.deepEqual(v.calls, []);
});

// ---------------------------------------------------------------- FakeDocs

test('insertIfEmpty seeds an empty doc and refuses a populated one', async () => {
  const docs = new FakeDocs();

  const empty = await docs.openHeadless('n_a');
  assert.equal(empty.text, '');
  assert.equal(await docs.insertIfEmpty(empty.handle, 'hello'), true);
  assert.equal(docs.text('n_a'), 'hello');

  // Invariant I5: exactly one client ever writes initial content. A second seed
  // would concatenate two copies into every peer's note.
  const again = await docs.openHeadless('n_a');
  assert.equal(again.text, 'hello');
  assert.equal(await docs.insertIfEmpty(again.handle, 'goodbye'), false);
  assert.equal(docs.text('n_a'), 'hello', 'a refused insert leaves the content untouched');
});

test('openHeadless on an unsynced room reports synced false and still returns a usable handle', async () => {
  const docs = new FakeDocs();
  docs.setText('n_a', 'remote content');
  docs.setSynced('n_a', false);

  const opened = await docs.openHeadless('n_a');
  assert.equal(opened.synced, false);
  assert.equal(opened.handle.room, 'n_a');
  // Invariant I4 is the CALLER's obligation to branch on `synced`. The fake must
  // not quietly enforce it, or a caller that ignores the flag would pass its tests.
  docs.close(opened.handle);
  assert.equal(docs.openCount('n_a'), 0);
});

test('FakeDocs tracks open handles so a test can prove they are released', async () => {
  const docs = new FakeDocs();
  const a = await docs.openHeadless('n_a');
  const b = await docs.openHeadless('n_a');

  assert.equal(docs.openCount('n_a'), 2);
  assert.equal(docs.totalOpens('n_a'), 2);
  assert.equal(docs.allClosed(), false);

  docs.close(a.handle);
  docs.close(a.handle);   // idempotent: callers close in a finally block
  assert.equal(docs.openCount('n_a'), 1);

  docs.close(b.handle);
  assert.equal(docs.openCount('n_a'), 0);
  assert.equal(docs.allClosed(), true);
});

test('insertIfEmpty on a closed handle throws', async () => {
  const docs = new FakeDocs();
  const opened = await docs.openHeadless('n_a');
  docs.close(opened.handle);

  await assert.rejects(() => docs.insertIfEmpty(opened.handle, 'x'), /closed/i);
  assert.equal(docs.text('n_a'), '');
});

test('FakeDocs.failNext fails exactly one openHeadless', async () => {
  const docs = new FakeDocs();
  docs.failNext('openHeadless', new Error('provider down'));

  await assert.rejects(() => docs.openHeadless('n_a'), /provider down/);
  const opened = await docs.openHeadless('n_a');
  assert.equal(opened.synced, true);
  assert.deepEqual(docs.calls.map((c) => c.op), ['openHeadless', 'openHeadless']);
});

// ── Regressions found in review of this slice ────────────────────────────────

// listDir must enumerate from the RESOLVED literal path. Half-resolving (existence
// case-insensitively, children by the caller's casing) answers "exists and empty"
// for a case variant — the invariant I2 trap. The reconciler's empty-folder sweep
// walks tree-cased paths while the disk holds literal case, so this would trash a
// folder that still holds files.
test('listDir enumerates children for a case-variant request', async () => {
  const v = new FakeVault();
  v.seed('Shared/Archive', 'd');
  v.seed('Shared/Archive/keep.md', 'f', 'content');
  v.seed('Shared/Archive/.git/config', 'f', '[core]');

  const exact = await v.listDir('Shared/Archive');
  const variant = await v.listDir('Shared/archive');
  assert.deepEqual(variant, exact);
  assert.ok(variant.length > 0, 'a case variant must not read as an empty folder');
  assert.ok(variant.some((p) => p.endsWith('keep.md')));
});

test('listDir still throws for a genuinely missing folder', async () => {
  const v = new FakeVault();
  v.seed('Shared/Archive', 'd');
  await assert.rejects(() => v.listDir('Shared/Nope'));
});

// Real vault.rename refuses to move a folder inside itself.
test('rename refuses to move a folder into its own subtree', async () => {
  const v = new FakeVault();
  v.seed('Notes/a.md', 'f', 'x');
  await assert.rejects(() => v.rename('Notes', 'Notes/sub'), /into itself/);
  await assert.rejects(() => v.rename('Notes', 'notes/sub'), /into itself/);
  // the vault is untouched by the refusal
  assert.equal(await v.exists('Notes/a.md'), true);
  // a move to a genuine sibling still works
  await v.createFolder('Other');
  await v.rename('Notes', 'Other/Notes');
  assert.equal(await v.exists('Other/Notes/a.md'), true);
});
