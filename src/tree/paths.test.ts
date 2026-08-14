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

import { isLive, isUnderDir, suffixedVaultPath } from './paths.ts';

const node = (o: Partial<NodeFields>): NodeFields =>
  ({ k: 'f', d: '', n: 'a.md', g: 1, c: 0, ...o });

// Spec test A8
test('isLive truth table', () => {
  assert.equal(isLive(node({})), true);                          // never deleted
  assert.equal(isLive(node({ g: 2, x: 1 })), true);              // x < g: resurrected
  assert.equal(isLive(node({ g: 1, x: 1 })), false);             // x === g: dead
  assert.equal(isLive(node({ g: 1, x: 2 })), false);             // x > g: dead
  assert.equal(isLive(node({ g: 2, x: 1, xa: 5 })), true);       // resurrect wins
});

// Spec test A9 — the "child moved out of a deleted folder survives" property.
test('isLive cascade escape by move', () => {
  const stillInside = node({ d: 'Archive/sub', n: 'k.md', g: 1, x: 1, xp: 'Archive' });
  assert.equal(isLive(stillInside), false);
  const movedOut = node({ d: 'Active', n: 'k.md', g: 1, x: 1, xp: 'Archive' });
  assert.equal(isLive(movedOut), true);
});

// Spec test A10 — the same property when the folder is renamed rather than the child moved.
test('isLive cascade escape by folder rename', () => {
  const descendants = ['G', 'G/sub', 'G/sub/deep'].map((d) =>
    node({ d, n: 'k.md', g: 1, x: 1, xp: 'F' }));
  for (const n of descendants) assert.equal(isLive(n), true);
});

test('isUnderDir matches only true descendants', () => {
  assert.equal(isUnderDir('Archive', 'Archive'), true);
  assert.equal(isUnderDir('Archive/sub', 'Archive'), true);
  assert.equal(isUnderDir('ArchiveOld', 'Archive'), false);
  assert.equal(isUnderDir('Active', 'Archive'), false);
});

// Spec test A11
test('suffixedVaultPath is deterministic regardless of insertion order', () => {
  const entries: Array<[string, NodeFields]> = [
    ['ZZZZZZZZZZZZZZZZZZZZZZ', node({ n: 'todo.md' })],
    ['AAAAAAAAAAAAAAAAAAAAAA', node({ n: 'todo.md' })],
    ['MMMMMMMMMMMMMMMMMMMMMM', node({ n: 'todo.md' })],
  ];
  const forward = suffixedVaultPath(entries);
  const backward = suffixedVaultPath([...entries].reverse());
  assert.deepEqual(forward, backward);
  // lowest nodeId keeps the plain name
  assert.equal(forward.get('AAAAAAAAAAAAAAAAAAAAAA'), 'todo.md');
  const others = ['MMMMMMMMMMMMMMMMMMMMMM', 'ZZZZZZZZZZZZZZZZZZZZZZ'].map((id) => forward.get(id));
  assert.deepEqual(others.sort(), ['todo (2).md', 'todo (3).md']);
});

// Spec test A12
test('suffixedVaultPath ignores ctime', () => {
  const base: Array<[string, NodeFields]> = [
    ['AAAAAAAAAAAAAAAAAAAAAA', node({ n: 'todo.md', c: 1 })],
    ['BBBBBBBBBBBBBBBBBBBBBB', node({ n: 'todo.md', c: 2 })],
  ];
  const skewed: Array<[string, NodeFields]> = [
    ['AAAAAAAAAAAAAAAAAAAAAA', node({ n: 'todo.md', c: 999_999 })],
    ['BBBBBBBBBBBBBBBBBBBBBB', node({ n: 'todo.md', c: -5 })],
  ];
  assert.deepEqual(suffixedVaultPath(base), suffixedVaultPath(skewed));
});

// Spec test A13 — duplicate folders deduplicate instead of forking.
test('directories are never suffixed', () => {
  const out = suffixedVaultPath([
    ['AAAAAAAAAAAAAAAAAAAAAA', node({ k: 'd', n: 'Projects' })],
    ['BBBBBBBBBBBBBBBBBBBBBB', node({ k: 'd', n: 'Projects' })],
  ]);
  assert.equal(out.get('AAAAAAAAAAAAAAAAAAAAAA'), 'Projects');
  assert.equal(out.get('BBBBBBBBBBBBBBBBBBBBBB'), 'Projects');
});

// Spec test A14
test('a folder beats a file at the same path', () => {
  const out = suffixedVaultPath([
    ['AAAAAAAAAAAAAAAAAAAAAA', node({ k: 'f', n: 'Notes.md' })],
    ['BBBBBBBBBBBBBBBBBBBBBB', node({ k: 'd', n: 'Notes.md' })],
  ]);
  assert.equal(out.get('BBBBBBBBBBBBBBBBBBBBBB'), 'Notes.md');
  assert.equal(out.get('AAAAAAAAAAAAAAAAAAAAAA'), 'Notes (2).md');
});

test('dead nodes are excluded from the assignment', () => {
  const out = suffixedVaultPath([
    ['AAAAAAAAAAAAAAAAAAAAAA', node({ n: 'todo.md', g: 1, x: 1 })],
    ['BBBBBBBBBBBBBBBBBBBBBB', node({ n: 'todo.md' })],
  ]);
  assert.equal(out.has('AAAAAAAAAAAAAAAAAAAAAA'), false);
  assert.equal(out.get('BBBBBBBBBBBBBBBBBBBBBB'), 'todo.md');
});

// ── Hardening regressions (found in review of this slice) ────────────────────

// Spec §7: any segment starting with '.' is out of scope. Without this, a peer could
// materialize files under a dot-directory that Obsidian's explorer never shows.
test('validateRel rejects leading-dot segments', () => {
  assert.equal(validateRel('.obsidian', 'notes.md', 'f'), false);
  assert.equal(validateRel('.git', 'x.md', 'f'), false);
  assert.equal(validateRel('a/.trash', 'x.md', 'f'), false);
  assert.equal(validateRel('', '.hidden.md', 'f'), false);
  assert.equal(validateRel('', '.md', 'f'), false);
  assert.equal(validateRel('', '.DS_Store', 'f'), false);
  assert.equal(validateRel('', '.obsidian', 'd'), false);
  // a dot INSIDE a segment is ordinary and must still pass
  assert.equal(validateRel('2024.Q1', 'ok.md', 'f'), true);
});

test('validateRel rejects DEL and other control characters', () => {
  assert.equal(validateRel('', 'a\x7fb.md', 'f'), false);
  assert.equal(validateRel('a\x7fb', 'x.md', 'f'), false);
});

// withSuffix must split off the directory first: suffixing the whole relative path
// would mangle a dotted DIRECTORY name and place the file in a different folder.
test('collision suffixing never mangles the directory component', () => {
  const out = suffixedVaultPath([
    ['AAAAAAAAAAAAAAAAAAAAAA', { k: 'f', d: '2024.Q1', n: 'README', g: 1, c: 0 }],
    ['BBBBBBBBBBBBBBBBBBBBBB', { k: 'f', d: '2024.Q1', n: 'README', g: 1, c: 0 }],
  ]);
  assert.equal(out.get('AAAAAAAAAAAAAAAAAAAAAA'), '2024.Q1/README');
  assert.equal(out.get('BBBBBBBBBBBBBBBBBBBBBB'), '2024.Q1/README (2)');
  // the dotted folder must be untouched on both
  for (const p of out.values()) assert.ok(p.startsWith('2024.Q1/'), `mangled dir: ${p}`);
});

test('collision suffixing keeps the extension last for normal notes', () => {
  const out = suffixedVaultPath([
    ['AAAAAAAAAAAAAAAAAAAAAA', node({ d: 'x.y', n: 'todo.md' })],
    ['BBBBBBBBBBBBBBBBBBBBBB', node({ d: 'x.y', n: 'todo.md' })],
  ]);
  assert.equal(out.get('BBBBBBBBBBBBBBBBBBBBBB'), 'x.y/todo (2).md');
});

test('assertInsideShare rejects empty path segments', () => {
  assert.equal(assertInsideShare('Shared', 'Shared//a.md'), false);
  assert.equal(assertInsideShare('Shared', 'Shared/'), false);
  assert.equal(assertInsideShare('Shared', 'Shared/a.md'), true);
});

test('isLive treats an empty cascade root as covering everything', () => {
  assert.equal(isLive(node({ d: 'Anywhere', g: 1, x: 1, xp: '' })), false);
  assert.equal(isLive(node({ d: 'Anywhere', g: 1, x: 1, xp: 'Archive' })), true);
});
