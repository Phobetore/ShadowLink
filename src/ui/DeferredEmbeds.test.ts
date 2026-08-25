// src/ui/DeferredEmbeds.test.ts
// Spec §7.3 — matching an unresolved embed to the attachment nobody downloaded.
//
// The matching is the part that can be wrong, and wrong in a way the user would
// never diagnose: a deferred attachment has NOTHING on disk, so Obsidian's own
// resolver has already failed by the time this runs and there is no `TFile` to
// compare against. All that is left is a link string and a set of paths the tree
// says should exist — and matching the wrong one would put a "Download — 180 MB"
// button under the wrong image.
//
// The DOM half of the post-processor is deliberately not tested here: it is three
// calls against a real `HTMLElement`, and spec §11's GUI list already carries it
// ("the download button rendering in place of a broken embed"). What is testable
// without Obsidian is the decision, and that is what this file holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DeferredAttachment } from '../sync/Reconciler.ts';
import { matchDeferred } from './DeferredEmbeds.ts';

function entry(path: string, bytes = 1_000): DeferredAttachment {
  return { id: `id-${path}`, path, sha256: 'a'.repeat(64), bytes };
}

const NOTE = 'Shared/notes/weekly.md';

test('a bare name matches the only attachment that carries it', () => {
  const entries = [entry('Shared/img/diagram.png')];
  assert.equal(matchDeferred('diagram.png', NOTE, entries)?.path, 'Shared/img/diagram.png');
});

test('a path-shaped link matches by its tail', () => {
  const entries = [entry('Shared/img/diagram.png')];
  assert.equal(matchDeferred('img/diagram.png', NOTE, entries)?.path, 'Shared/img/diagram.png');
  assert.equal(
    matchDeferred('Shared/img/diagram.png', NOTE, entries)?.path, 'Shared/img/diagram.png',
  );
});

test('an alias, a subpath and percent-encoding are stripped before matching', () => {
  const entries = [entry('Shared/img/my diagram.png')];
  assert.equal(matchDeferred('my diagram.png|300', NOTE, entries)?.path, 'Shared/img/my diagram.png');
  assert.equal(matchDeferred('my%20diagram.png', NOTE, entries)?.path, 'Shared/img/my diagram.png');
  assert.equal(matchDeferred('my diagram.png#frag', NOTE, entries)?.path, 'Shared/img/my diagram.png');
});

// Obsidian's own link resolution is case-insensitive, and so is every other path
// comparison in this codebase (`fold`). A matcher that was not would silently
// stop offering the button for half the vaults on Windows and macOS.
test('matching folds case, exactly as every other path comparison here does', () => {
  const entries = [entry('Shared/img/Diagram.PNG')];
  assert.equal(matchDeferred('diagram.png', NOTE, entries)?.path, 'Shared/img/Diagram.PNG');
});

// ⚠ The refusal that matters. Two attachments with the same basename in different
// folders is the ordinary state of a vault, and guessing between them puts a
// button for one file underneath an embed of another.
test('an ambiguous bare name matches nothing at all', () => {
  const entries = [entry('Shared/a/photo.png'), entry('Shared/b/photo.png')];
  assert.equal(matchDeferred('photo.png', NOTE, entries), null);
});

// …unless one of them is in the note's own folder, which is exactly how Obsidian
// resolves it too.
test('a name in the note\'s own folder outranks one elsewhere', () => {
  const entries = [entry('Shared/notes/photo.png'), entry('Shared/b/photo.png')];
  assert.equal(matchDeferred('photo.png', NOTE, entries)?.path, 'Shared/notes/photo.png');
});

test('a link that names nothing deferred matches nothing', () => {
  const entries = [entry('Shared/img/diagram.png')];
  assert.equal(matchDeferred('other.png', NOTE, entries), null);
  assert.equal(matchDeferred('', NOTE, entries), null);
  assert.equal(matchDeferred('   ', NOTE, entries), null);
});

// An embed of a NOTE is not an attachment, and a note that has not arrived is a
// different state entirely (`pending`, and P1's business). Nothing here may offer
// to download it.
test('a markdown embed is never matched to an attachment', () => {
  const entries = [entry('Shared/img/diagram.png')];
  assert.equal(matchDeferred('Shared/notes/other.md', NOTE, entries), null);
});

// A tail match has to be a whole segment. `agram.png` matching `diagram.png`
// would put a button under an embed of a file that has nothing to do with it.
test('a tail match is on whole path segments, never on a substring', () => {
  const entries = [entry('Shared/img/diagram.png')];
  assert.equal(matchDeferred('agram.png', NOTE, entries), null);
  assert.equal(matchDeferred('g/diagram.png', NOTE, entries), null);
});
