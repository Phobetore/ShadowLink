import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relPath, splitRel, fold, validateRel, assertInsideShare, hashOf } from './paths.ts';
import type { NodeFields } from './types.ts';

const file = (d: string, n: string): NodeFields => ({ k: 'f', d, n, g: 1, c: 0 });

// Spec test A1
test('relPath joins dir and name, and splitRel round-trips it', () => {
  assert.equal(relPath(file('', 'a.md')), 'a.md');
  assert.equal(relPath(file('x/y', 'a.md')), 'x/y/a.md');
  assert.deepEqual(splitRel('a.md'), { d: '', n: 'a.md' });
  assert.deepEqual(splitRel('x/y/a.md'), { d: 'x/y', n: 'a.md' });
  for (const p of ['a.md', 'x/a.md', 'x/y/z/a.md']) {
    const { d, n } = splitRel(p);
    assert.equal(relPath(file(d, n)), p);
  }
});

// Spec test A2 — regression for the mistyped character class that would have
// made ordinary names with spaces and hyphens unsyncable.
test('validateRel accepts real-world names', () => {
  assert.equal(validateRel('Project Notes', 'meeting-2026.md', 'f'), true);
  assert.equal(validateRel('', '2024.Q1 review.md', 'f'), true);
  assert.equal(validateRel('a/b/c', 'Ünïcødé note.md', 'f'), true);
  assert.equal(validateRel('', 'Archive', 'd'), true);
  assert.equal(validateRel('Archive', 'sub folder', 'd'), true);
});

// Spec test A3
test('validateRel rejects traversal', () => {
  assert.equal(validateRel('../../.obsidian/plugins/shadowlink', 'data.json', 'f'), false);
  assert.equal(validateRel('..', 'x.md', 'f'), false);
  assert.equal(validateRel('', '..', 'd'), false);
  assert.equal(validateRel('a/../../b', 'x.md', 'f'), false);
});

// Spec test A4
test('validateRel rejects separators and control chars in name', () => {
  assert.equal(validateRel('', '../../Personal', 'f'), false);
  assert.equal(validateRel('', 'a\\b.md', 'f'), false);
  assert.equal(validateRel('', 'a/b.md', 'f'), false);
  assert.equal(validateRel('', 'a\x01.md', 'f'), false);
  assert.equal(validateRel('', 'a\0b.md', 'f'), false);
});

// Spec test A5
test('validateRel rejects dot segments, reserved names, trailing dot/space, over-length', () => {
  assert.equal(validateRel('', '.', 'd'), false);
  assert.equal(validateRel('', '', 'd'), false);
  assert.equal(validateRel('a/./b', 'x.md', 'f'), false);
  assert.equal(validateRel('', 'CON.md', 'f'), false);
  assert.equal(validateRel('', 'aux.md', 'f'), false);
  assert.equal(validateRel('', 'trailing .md', 'f'), true);   // space before ext is fine
  assert.equal(validateRel('', 'trailing.md ', 'f'), false);  // trailing space is not
  assert.equal(validateRel('', 'trailing.', 'd'), false);
  assert.equal(validateRel('x'.repeat(500), 'y.md', 'f'), false);
});

// Spec test A6
test('validateRel requires .md for files and is permissive for folders', () => {
  assert.equal(validateRel('', 'note.md', 'f'), true);
  assert.equal(validateRel('', 'image.png', 'f'), false);
  assert.equal(validateRel('', 'noext', 'f'), false);
  assert.equal(validateRel('', 'folder.png', 'd'), true);
});

// Spec test A7
test('assertInsideShare rejects anything normalizing outside the share', () => {
  assert.equal(assertInsideShare('Shared', 'Shared/a.md'), true);
  assert.equal(assertInsideShare('Shared', 'Shared'), true);
  assert.equal(assertInsideShare('Shared', 'Shared/x/y.md'), true);
  assert.equal(assertInsideShare('Shared', 'SharedNotes/a.md'), false);
  assert.equal(assertInsideShare('Shared', 'Other/a.md'), false);
  assert.equal(assertInsideShare('Shared', 'Shared/../Other/a.md'), false);
  assert.equal(assertInsideShare('Shared', '../a.md'), false);
  assert.equal(assertInsideShare('Shared', 'ShadowLink Recovered/a.md'), false);
  // the rescue-destination variant allows the reserved folders
  assert.equal(assertInsideShare('Shared', 'ShadowLink Recovered/a.md', true), true);
  assert.equal(assertInsideShare('Shared', 'ShadowLink Staging/a.md', true), true);
  assert.equal(assertInsideShare('Shared', 'Elsewhere/a.md', true), false);
});

// Spec test A15
test('fold is case- and unicode-normalizing, and stable under repetition', () => {
  assert.equal(fold('Notes/README.md'), fold('notes/readme.md'));
  // NFD input ('e' + combining acute) folds to the same key as NFC ('é').
  const nfd = 'e' + String.fromCharCode(0x301) + 'te.md';
  const nfc = String.fromCharCode(0xe9) + 'te.md';
  assert.equal(fold(nfd), fold(nfc));
  const once = fold('Ünïcødé/Nôte.md');
  assert.equal(fold(once), once);
});

// Spec test A16
test('hashOf normalizes line endings', async () => {
  assert.equal(await hashOf('a\r\nb\r\n'), await hashOf('a\nb\n'));
  assert.notEqual(await hashOf('a\nb\n'), await hashOf('a\nb'));
});
