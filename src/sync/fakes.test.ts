// src/sync/fakes.test.ts
// The fakes are the substrate every Group B reconciler test runs on, so they get
// tested themselves. A fake that is wrong in an interesting way — case-sensitive
// where the real filesystem is not, silently overwriting where vault.create throws,
// hard-dropping what vault.trash retains — does not fail loudly. It makes every
// downstream test pass while the real thing corrupts the user's vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeBlobs, FakeDocs, FakeVault } from './fakes.ts';
import {
  BlobDigestMismatch,
  BlobTooLarge,
  BlobTransport,
  BlobUnavailable,
  type BlobPort,
} from './BlobPort.ts';
import { hashOfBytes } from '../tree/paths.ts';

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

  // The subject here is the call LOG, but the rejection is still pinned: an
  // unmatched one would let this pass on a `create` that refused for some reason
  // other than the occupied path, and the log assertion below would look like
  // proof that the occupancy check ran.
  await assert.rejects(() => v.create('Shared/a.md', ''), /exists/i);
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
  // MATCHED on "not found", which is the whole claim in the name. `listDir` has two
  // rejections and the reconciler's empty-folder sweep reads them differently; an
  // unmatched `rejects` here would be satisfied by the "not a folder" one, or by a
  // TypeError from a signature that no longer takes a path at all.
  await assert.rejects(() => v.listDir('Shared/Nope'), /not found/i);
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

// ---------------------------------------------------------------- bytes (P2 §8.5)

// PNG magic plus a CRLF pair: a byte string no UTF-8 round trip survives, which is
// exactly what makes it a proof that content is stored as BYTES.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);

test('content is one byte-backed store, with text encoded and decoded at the edge', async () => {
  const v = new FakeVault();
  v.seed('Shared/note.md', 'f', 'the body');

  // Text written through `create` reads back as bytes...
  await v.create('Shared/other.md', 'other body');
  assert.deepEqual(await v.readBinary('Shared/other.md'), new TextEncoder().encode('other body'));
  // ...and bytes written through `createBinary` read back as text.
  await v.createBinary('Shared/utf8.md', new TextEncoder().encode('from bytes'));
  assert.equal(await v.read('Shared/utf8.md'), 'from bytes');

  // A parallel string field would let this pass while production threw.
  assert.deepEqual(await v.readBinary('Shared/note.md'), new TextEncoder().encode('the body'));
});

test('binary content survives byte-for-byte, and text views of it are lossy', async () => {
  const v = new FakeVault();
  v.seed('Shared', 'd');
  await v.createBinary('Shared/diagram.png', PNG);

  assert.deepEqual(await v.readBinary('Shared/diagram.png'), PNG);
  assert.deepEqual(v.binarySnapshot()['Shared/diagram.png'], PNG);
  // `snapshot()` keeps returning strings so every existing assertion still reads
  // the same; for a PNG that view is lossy, which is the honest answer.
  assert.notEqual(v.snapshot()['Shared/diagram.png'], undefined);
  assert.notDeepEqual(
    new TextEncoder().encode(v.snapshot()['Shared/diagram.png']),
    PNG,
    'decoding a PNG as UTF-8 is lossy — the bytes are the truth, not the string',
  );

  // seedBinary is the setup counterpart and stays out of the call log.
  const w = new FakeVault();
  w.seedBinary('Shared/photo.heic', PNG);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(await w.readBinary('Shared/photo.heic'), PNG);
});

test('readBinary hands back a copy, so a caller cannot edit the vault through it', async () => {
  const v = new FakeVault();
  v.seedBinary('Shared/diagram.png', PNG);

  const first = await v.readBinary('Shared/diagram.png');
  first[0] = 0x00;
  assert.deepEqual(await v.readBinary('Shared/diagram.png'), PNG, 'the vault is unchanged');
});

test('createBinary refuses an occupied path and a missing parent, like create', async () => {
  const v = new FakeVault();
  v.seed('Shared/diagram.png', 'f', 'incumbent');

  await assert.rejects(() => v.createBinary('shared/DIAGRAM.PNG', PNG), /exists/i);
  assert.equal(await v.read('Shared/diagram.png'), 'incumbent', 'the incumbent is untouched');
  await assert.rejects(() => v.createBinary('Shared/Nested/x.png', PNG), /parent/i);
});

test('readBinary rejects for an absent path and for a directory', async () => {
  const v = new FakeVault();
  v.seed('Shared', 'd');

  await assert.rejects(() => v.readBinary('Shared/nope.png'), /not found/i);
  await assert.rejects(() => v.readBinary('Shared'), /not a file/i);
});

// Invariant I2: `stat` resolving null means "definitely not there". "I could not
// look" has to be a rejection, or the two collapse into one value and an
// unreadable file reads as a deleted one.
test('stat reports kind, size and a monotonic mtime, and null only for a real absence', async () => {
  const v = new FakeVault();
  v.seed('Shared', 'd');
  await v.createBinary('Shared/diagram.png', PNG);

  const first = (await v.stat('Shared/diagram.png'))!;
  assert.equal(first.kind, 'f');
  assert.equal(first.bytes, PNG.length);
  assert.equal((await v.stat('Shared'))!.kind, 'd');
  assert.equal(await v.stat('Shared/missing.png'), null);

  // Every write bumps the mtime, so "size and mtime still agree" is a branch a
  // test can actually miss rather than one that is always true.
  await v.create('Shared/note.md', 'x');
  const note = (await v.stat('Shared/note.md'))!;
  assert.ok(note.mtime > first.mtime, `${note.mtime} must be later than ${first.mtime}`);

  // A rename moves the file; it does not rewrite it.
  await v.rename('Shared/diagram.png', 'Shared/renamed.png');
  assert.equal((await v.stat('Shared/renamed.png'))!.mtime, first.mtime);

  const boom = new Error('EIO');
  v.failNext('stat', boom);
  await assert.rejects(() => v.stat('Shared/renamed.png'), (e) => e === boom);
});

// I1 proven positively for a binary: the bytes are retained, not a lossy string.
test('trashLocal retains an attachment byte-for-byte', async () => {
  const v = new FakeVault();
  v.seedBinary('Shared/diagram.png', PNG);

  await v.trashLocal('Shared/diagram.png');

  assert.equal(await v.exists('Shared/diagram.png'), false);
  const [entry] = v.trashedFor('Shared/diagram.png');
  assert.deepEqual(entry.bytes, PNG);
  assert.equal(entry.kind, 'f');
});

test('the new operations are logged and fault-injectable like every other one', async () => {
  const v = new FakeVault();
  v.seed('Shared', 'd');

  await v.createBinary('Shared/a.png', PNG);
  await v.readBinary('Shared/a.png');
  await v.stat('Shared/a.png');

  assert.deepEqual(v.calls.map((c) => c.op), ['createBinary', 'readBinary', 'stat']);
  assert.equal(v.callsTo('createBinary')[0].args[0], 'Shared/a.png');

  const boom = new Error('EBUSY');
  v.failNext('createBinary', boom);
  await assert.rejects(() => v.createBinary('Shared/b.png', PNG), (e) => e === boom);
  assert.equal(await v.exists('Shared/b.png'), false, 'a failed write leaves nothing behind');
  v.failNext('readBinary', new Error('EIO'));
  await assert.rejects(() => v.readBinary('Shared/a.png'), /EIO/);
});

// ---------------------------------------------------------------- FakeBlobs

test('put stores an object the store itself verified, and has reports it', async () => {
  const blobs = new FakeBlobs();
  const sha = await hashOfBytes(PNG);

  assert.deepEqual(await blobs.has(sha), { present: false });
  assert.equal(await blobs.put(sha, PNG), true);
  assert.deepEqual(await blobs.has(sha), { present: true, bytes: PNG.length });
  assert.deepEqual(blobs.stored(sha), PNG);
  assert.deepEqual(blobs.calls.map((c) => c.op), ['has', 'put', 'has']);
});

// A store that took the caller's word for the hash would let a corrupted upload
// become the canonical copy of the file, on every peer.
test('put refuses bytes that do not hash to the name they are stored under', async () => {
  const blobs = new FakeBlobs();
  const wrong = 'a'.repeat(64);

  assert.equal(await blobs.put(wrong, PNG), false);
  assert.match(String((blobs.lastError as Error).message), /digest mismatch/);
  assert.equal(blobs.objectCount(), 0, 'nothing at all is stored');
  assert.deepEqual(await blobs.has(wrong), { present: false });
});

test('put refuses an object over the limit and reports why', async () => {
  const blobs = new FakeBlobs();
  blobs.setLimits({ maxFileBytes: 4, freeBytes: 10 });
  const sha = await hashOfBytes(PNG);

  assert.equal(await blobs.put(sha, PNG), false);
  assert.match(String((blobs.lastError as Error).message), /too large/);
  assert.equal(blobs.objectCount(), 0);
  assert.deepEqual(await blobs.limits(), { maxFileBytes: 4, freeBytes: 10 });

  // A queued refusal models the rest of the family (507, 422) without inventing
  // status codes the fake does not have.
  blobs.setLimits({ maxFileBytes: 1024 });
  const quota = new Error('507 insufficient storage');
  blobs.refuseNextPut(quota);
  assert.equal(await blobs.put(sha, PNG), false);
  assert.equal(blobs.lastError, quota);
  assert.equal(await blobs.put(sha, PNG), true, 'the refusal was for exactly one call');
});

test('get returns the bytes, and null for every failure there is', async () => {
  const blobs = new FakeBlobs();
  const sha = await blobs.seed(PNG);

  assert.deepEqual(await blobs.get(sha, PNG.length), PNG);
  assert.equal(await blobs.get('b'.repeat(64), PNG.length), null, 'absent object');
  assert.equal(await blobs.get(sha, PNG.length + 1), null, 'length disagrees with the reference');

  const controller = new AbortController();
  controller.abort();
  assert.equal(await blobs.get(sha, PNG.length, controller.signal), null, 'aborted');
});

// ⚠ The whole point of verifying before returning: bad bytes must never reach the
// caller, because the caller's next move is to write them at the user's path.
test('corrupt bytes are caught by digest, not by length, and get returns null', async () => {
  const blobs = new FakeBlobs();
  const sha = await blobs.seed(PNG);
  blobs.corrupt(sha);

  assert.equal(blobs.stored(sha)!.length, PNG.length, 'the damage is invisible to a size check');
  assert.equal(await blobs.get(sha, PNG.length), null);
  assert.match(String((blobs.lastError as Error).message), /digest mismatch/);
  // The store still claims to hold it — which is why `has` is not proof of bytes.
  assert.deepEqual(await blobs.has(sha), { present: true, bytes: PNG.length });
});

test('setAbsent models a blob the server no longer holds', async () => {
  const blobs = new FakeBlobs();
  const sha = await blobs.seed(PNG);

  blobs.setAbsent(sha);

  assert.deepEqual(await blobs.has(sha), { present: false });
  assert.equal(await blobs.get(sha, PNG.length), null);
});

// I2. `has` answering false for a network failure would turn "I could not ask"
// into "the bytes are gone", which at delete time is the difference between a
// rescue and a removal.
test('a transport failure throws from has, put and limits rather than answering', async () => {
  const blobs = new FakeBlobs();
  const sha = await blobs.seed(PNG);
  const down = new Error('ECONNRESET');

  blobs.failNext('has', down);
  await assert.rejects(() => blobs.has(sha), (e) => e === down);

  blobs.failNext('put', down);
  await assert.rejects(() => blobs.put(sha, PNG), (e) => e === down);

  blobs.failNext('limits', down);
  await assert.rejects(() => blobs.limits(), (e) => e === down);

  // ...and exactly one call each was affected.
  assert.deepEqual(await blobs.has(sha), { present: true, bytes: PNG.length });
});

// ⚠ `get` is the one that does NOT join that list, and the difference is the
// whole contract. `ObsidianBlobPort.get` catches everything and answers null —
// its header says so — and the reconciler is written against exactly that: it
// branches on the null and then on `lastError`, never on a catch. A fake that
// threw from `get` would let a test drive a failure shape production cannot
// produce, and pass on a code path the real port never reaches.
test('an injected get failure answers null, the one way the real port can fail', async () => {
  const blobs = new FakeBlobs();
  const sha = await blobs.seed(PNG);
  const down = new BlobTransport('socket hang up');

  blobs.failNext('get', down);
  assert.equal(await blobs.get(sha, PNG.length), null, 'null, never a throw');
  assert.equal(blobs.lastError, down, 'and the reason is what the caller branches on');

  // ...and exactly one call was affected.
  assert.deepEqual(await blobs.get(sha, PNG.length), PNG);
});

// ⚠ Nothing exercises this today: the publish settle check refuses a 0-byte file
// upstream, so no caller ever offers one. That is precisely the condition under
// which a fake drifts from the port it stands in for — the divergence is real,
// and nothing trips over it to say so. `ObsidianBlobPort.put` turns a zero-length
// object away before any request, because `bytes a-b/total` has no spelling for
// one and the routes therefore cannot express it.
test('put refuses a zero-length object, exactly as the real port does', async () => {
  const blobs = new FakeBlobs();
  const empty = new Uint8Array(0);
  const sha = await hashOfBytes(empty);

  assert.equal(await blobs.put(sha, empty), false);
  assert.ok(blobs.lastError instanceof BlobDigestMismatch, `got ${String(blobs.lastError)}`);
  assert.equal(blobs.objectCount(), 0, 'nothing at all is stored');

  // A queued refusal does not get in ahead of it: the object never reaches a
  // server, so no server answer can be the thing that turned it away.
  const quota = new Error('507 insufficient storage');
  blobs.refuseNextPut(quota);
  assert.equal(await blobs.put(sha, empty), false);
  assert.ok(blobs.lastError instanceof BlobDigestMismatch, 'the zero-length refusal, not the 507');
  assert.equal(await blobs.put(await hashOfBytes(PNG), PNG), false, 'the 507 is still queued');
  assert.equal(blobs.lastError, quota);
});

// The typed errors are the port's contract rather than decoration: `Reconciler`
// reads `lastError instanceof BlobUnavailable` to tell "the store does not hold
// these bytes" from "the network did not answer", and reports only the first to
// the user. A fake that answered plain Errors would make that check — and every
// future sibling of it — untestable through the fakes.
test('every refusal carries the type the real port would carry', async () => {
  const blobs = new FakeBlobs();
  const sha = await hashOfBytes(PNG);

  blobs.setLimits({ maxFileBytes: 4 });
  assert.equal(await blobs.put(sha, PNG), false);
  assert.ok(blobs.lastError instanceof BlobTooLarge, `got ${String(blobs.lastError)}`);

  blobs.setLimits({ maxFileBytes: 1024 });
  assert.equal(await blobs.put('a'.repeat(64), PNG), false);
  assert.ok(blobs.lastError instanceof BlobDigestMismatch, `got ${String(blobs.lastError)}`);

  assert.equal(await blobs.get('b'.repeat(64), PNG.length), null);
  assert.ok(blobs.lastError instanceof BlobUnavailable, `got ${String(blobs.lastError)}`);

  assert.equal(await blobs.put(sha, PNG), true);
  assert.equal(await blobs.get(sha, PNG.length + 1), null);
  assert.ok(blobs.lastError instanceof BlobDigestMismatch, `got ${String(blobs.lastError)}`);

  const controller = new AbortController();
  controller.abort();
  assert.equal(await blobs.get(sha, PNG.length, controller.signal), null);
  assert.ok(blobs.lastError instanceof BlobTransport, `got ${String(blobs.lastError)}`);
});

test('the same bytes stored twice are one object', async () => {
  const blobs = new FakeBlobs();
  const sha = await hashOfBytes(PNG);

  assert.equal(await blobs.put(sha, PNG), true);
  assert.equal(await blobs.put(sha, PNG.slice()), true);

  assert.equal(blobs.objectCount(), 1, 'content addressing dedups by construction');
});

// A fake that has drifted from the port it stands in for is worse than no fake:
// the engine is written against `BlobPort`, and every Group B test proves the
// engine against THIS. If the two ever disagree about a method's name or its
// arity, the suite goes on passing while the real port is never exercised.
test('FakeBlobs and ObsidianBlobPort present the same surface', async () => {
  const { ObsidianBlobPort } = await import('./ObsidianBlobPort.ts');
  const fake = new FakeBlobs();
  const real = new ObsidianBlobPort({
    serverUrl: 'ws://127.0.0.1:9', serverKey: 'sk_x', workspaceId: 'w',
  });

  for (const method of ['has', 'put', 'get', 'limits'] as const) {
    assert.equal(typeof fake[method], 'function', `FakeBlobs.${method}`);
    assert.equal(typeof real[method], 'function', `ObsidianBlobPort.${method}`);
    assert.equal(
      fake[method].length, real[method].length,
      `${method}() takes a different number of arguments on the fake than on the real port`,
    );
  }
  assert.equal('lastError' in fake, true);
  assert.equal('lastError' in real, true);
});

// `implements BlobPort` on both classes is a compile-time claim; this is the
// runtime half, because the engine is handed one or the other through the same
// binding and a shape that only type-checks is not enough.
test('a BlobPort binding accepts either implementation', async () => {
  const { ObsidianBlobPort } = await import('./ObsidianBlobPort.ts');
  const ports: BlobPort[] = [
    new FakeBlobs(),
    new ObsidianBlobPort({ serverUrl: 'ws://127.0.0.1:9', serverKey: 'sk_x', workspaceId: 'w' }),
  ];
  assert.equal(ports.length, 2);
});
