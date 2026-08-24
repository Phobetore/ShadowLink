import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  relPath, splitRel, fold, validateRel, assertInsideShare, hashOf,
  parseBlobRef, formatBlobRef, hashOfBytes, nodeKindOf, isPublished, extOf, safeInFilename,
} from './paths.ts';
import type { NodeFields, NodeKind } from './types.ts';

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

// ── P2 §2.2: blob references, byte hashing, kinds and the published predicate ──

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

// Spec test A1
test('parseBlobRef and formatBlobRef round-trip', () => {
  assert.equal(formatBlobRef(HASH_A, 2048, null), `${HASH_A}:2048:-`);
  assert.equal(formatBlobRef(HASH_A, 0, HASH_B), `${HASH_A}:0:${HASH_B}`);

  assert.deepEqual(parseBlobRef(`${HASH_A}:2048:-`), {
    sha256: HASH_A, bytes: 2048, parent: null,
  });
  assert.deepEqual(parseBlobRef(`${HASH_A}:17:${HASH_B}`), {
    sha256: HASH_A, bytes: 17, parent: HASH_B,
  });
  for (const ref of [formatBlobRef(HASH_A, 5, null), formatBlobRef(HASH_A, 5, HASH_B)]) {
    const parsed = parseBlobRef(ref)!;
    assert.equal(formatBlobRef(parsed.sha256, parsed.bytes, parsed.parent), ref);
  }
});

// Spec test A1, the refusals. The reference is the only record of WHICH bytes
// belong at a path, so a malformed one must never half-parse into a hash the
// fetcher would then go looking for.
test('parseBlobRef rejects every malformed reference', () => {
  for (const bad of [
    undefined,
    '',
    ' ',
    HASH_A,                                   // no size, no parent
    `${HASH_A}:2048`,                         // missing parent
    `${'a'.repeat(63)}:1:-`,                  // hash too short
    `${'a'.repeat(65)}:1:-`,                  // hash too long
    `${'A'.repeat(64)}:1:-`,                  // uppercase hex
    `${'g'.repeat(64)}:1:-`,                  // not hex at all
    `${HASH_A}::-`,                           // missing size
    `${HASH_A}:x:-`,                          // non-numeric size
    `${HASH_A}:-1:-`,                         // negative size
    `${HASH_A}:1.5:-`,                        // fractional size
    `${HASH_A}:1234567890123:-`,              // size over 12 digits
    `${HASH_A}:1:${'a'.repeat(63)}`,          // parent is not 64 hex
    `${HASH_A}:1:${'A'.repeat(64)}`,          // uppercase parent
    `${HASH_A}:1:`,                           // empty parent
    `${HASH_A}:1:-:extra`,                    // an extra field
    ` ${HASH_A}:1:-`,                         // leading space
    `${HASH_A}:1:-\n`,                        // trailing newline
  ]) {
    assert.equal(parseBlobRef(bad as string | undefined), null, `accepted ${String(bad)}`);
  }
  // A formatter is not a validator: garbage in must still fail to parse, so a
  // bad reference can never round-trip and look canonical.
  assert.equal(parseBlobRef(formatBlobRef('nope', 1, null)), null);
});

// Spec test A2 ⚠ — `hashOf` normalizes CRLF because it hashes TEXT (I18).
// Applying that rule to bytes changes the identity of a file: two different PNGs
// could hash alike, and a file's own hash would not match what the store holds.
test('hashOfBytes hashes RAW bytes and never normalizes line endings', async () => {
  const crlf = await hashOfBytes(Uint8Array.from([0x0d, 0x0a]));
  const lf = await hashOfBytes(Uint8Array.from([0x0a]));
  assert.notEqual(crlf, lf, 'CRLF and LF are different bytes and must hash differently');

  // The same statement against the text hasher, which deliberately folds them.
  assert.equal(await hashOf('a\r\nb'), await hashOf('a\nb'));
  assert.notEqual(await hashOfBytes(bytesOf('a\r\nb')), await hashOfBytes(bytesOf('a\nb')));
  // ...and for content with no CRLF in it the two agree, so this is a difference
  // of rule rather than of algorithm.
  assert.equal(await hashOfBytes(bytesOf('a\nb')), await hashOf('a\nb'));

  // Two PNG-shaped byte strings differing only in a CRLF-looking pair.
  const png = (tail: number[]): Uint8Array =>
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]);
  assert.notEqual(await hashOfBytes(png([0x0d, 0x0a])), await hashOfBytes(png([0x0a])));

  // A real SHA-256, lowercase hex, of the empty input.
  assert.equal(
    await hashOfBytes(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

// A Uint8Array carries its own offset and length. Hashing the whole underlying
// buffer instead of the view is how a chunked read silently hashes padding.
test('hashOfBytes honours a subarray view rather than its backing buffer', async () => {
  const backing = Uint8Array.from([9, 9, 1, 2, 3, 9, 9]);
  const view = backing.subarray(2, 5);
  assert.equal(await hashOfBytes(view), await hashOfBytes(Uint8Array.from([1, 2, 3])));
  assert.notEqual(await hashOfBytes(view), await hashOfBytes(backing));
});

// Spec test A5
test('nodeKindOf is the one place a path becomes a tree kind', () => {
  assert.equal(nodeKindOf('Notes', 'd'), 'd');
  assert.equal(nodeKindOf('Notes/image.png', 'd'), 'd', 'a folder is a folder whatever it is called');

  assert.equal(nodeKindOf('Notes/todo.md', 'f'), 'f');
  assert.equal(nodeKindOf('Notes/Todo.MD', 'f'), 'f');
  assert.equal(nodeKindOf('a.b.md', 'f'), 'f');

  for (const rel of [
    'Notes/diagram.png', 'Scan 2026-08-24.pdf', 'board.canvas', 'photo.HEIC',
    'noext', 'archive.tar.gz', 'Notes/clip.webm',
  ]) {
    assert.equal(nodeKindOf(rel, 'f'), 'b', rel);
  }
});

// Spec test A7
test('isPublished needs `s` for a note and `s` plus a parseable reference for an attachment', () => {
  const base = { d: '', n: 'x', g: 1, c: 0 };
  assert.equal(isPublished({ ...base, k: 'f', n: 'a.md' } as NodeFields), false);
  assert.equal(isPublished({ ...base, k: 'f', n: 'a.md', s: 1 } as NodeFields), true);
  // A directory has no content to publish; the predicate is only ever asked about
  // one alongside an explicit kind test, and it answers on `s` like a note.
  assert.equal(isPublished({ ...base, k: 'd', n: 'Notes' } as NodeFields), false);

  const ref = `${HASH_A}:10:-`;
  assert.equal(isPublished({ ...base, k: 'b', n: 'a.png', s: 1, b: ref } as NodeFields), true);
  assert.equal(isPublished({ ...base, k: 'b', n: 'a.png', b: ref } as NodeFields), false, 'no s');
  assert.equal(isPublished({ ...base, k: 'b', n: 'a.png', s: 1 } as NodeFields), false, 'no b');
  assert.equal(
    isPublished({ ...base, k: 'b', n: 'a.png', s: 1, b: 'garbage' } as NodeFields),
    false,
    'a malformed reference is not a published attachment',
  );
});

// The rule that decides a node's kind lived in three private copies; it is one
// function now, and these are the cases each copy had to agree on.
test('extOf returns the last extension, and nothing for a dotfile or a bare name', () => {
  assert.equal(extOf('a/b.png'), '.png');
  assert.equal(extOf('b.png'), '.png');
  assert.equal(extOf('archive.tar.gz'), '.gz');
  assert.equal(extOf('noext'), '');
  assert.equal(extOf('a/noext'), '');
  assert.equal(extOf('.hidden'), '', 'a leading dot is not an extension');
  assert.equal(extOf('2024.Q1/README'), '', 'a dotted directory is not the file extension');
  assert.equal(extOf('Notes/.DS_Store'), '');
  assert.equal(extOf(''), '');
});

test('safeInFilename strips what a path segment may not hold and always yields a name', () => {
  assert.equal(safeInFilename('Ada'), 'Ada');
  assert.equal(safeInFilename('a/b\\c:d'), 'a b c d');
  // A display name is remote-controlled and about to become part of a filename.
  const ctl = String.fromCharCode(0) + String.fromCharCode(0x1f) + String.fromCharCode(0x7f);
  assert.equal(safeInFilename(`Ada${ctl}`), 'Ada');
  assert.equal(safeInFilename(`A${String.fromCharCode(0x1f)}B`), 'A B');
  assert.equal(safeInFilename('   '), 'a collaborator');
  assert.equal(safeInFilename(''), 'a collaborator');
  assert.ok(safeInFilename('N'.repeat(200)).length <= 40);
});

// ── P2 §2.3: validateRel's binary arm ────────────────────────────────────────

// Spec test A3
test("validateRel accepts the extensions real vaults actually hold for 'b'", () => {
  for (const n of [
    'diagram.png', 'Scan 2026-08-24.pdf', 'board.canvas', 'sketch.excalidraw',
    'arch.drawio', 'clip.webm', 'data.base', 'photo.HEIC', 'take.MP4',
    'Ünïcødé photo.jpeg', 'a.b.png',
  ]) {
    assert.equal(validateRel('Attachments', n, 'b'), true, n);
    assert.equal(validateRel('', n, 'b'), true, n);
  }
});

// Spec test A3, the refusals. REFUSED_EXTS is a denylist rather than an allowlist
// because real vaults hold .canvas/.excalidraw/.drawio/.heic/.base; it exists
// because a hostile peer could otherwise drop an executable into a folder the user
// browses in Explorer or Finder, which Obsidian will not run but the OS will.
test("validateRel refuses the names an attachment may not have", () => {
  const refused = [
    '.exe', '.dll', '.so', '.dylib', '.msi', '.bat', '.cmd', '.com',
    '.scr', '.ps1', '.vbs', '.jar', '.app', '.lnk',
  ];
  for (const ext of refused) {
    assert.equal(validateRel('', `payload${ext}`, 'b'), false, ext);
    assert.equal(validateRel('', `payload${ext.toUpperCase()}`, 'b'), false, ext);
  }

  assert.equal(validateRel('', 'noext', 'b'), false, 'extensionless');
  assert.equal(validateRel('', `x.${'y'.repeat(16)}`, 'b'), false, 'extension over 16 chars');
  assert.equal(validateRel('', `x.${'y'.repeat(14)}`, 'b'), true, 'a 15-char extension is fine');
  assert.equal(validateRel('', '.DS_Store', 'b'), false, 'leading-dot name');
  assert.equal(validateRel('', '.hidden.png', 'b'), false, 'leading-dot name');
  assert.equal(validateRel('.obsidian', 'x.png', 'b'), false, 'leading-dot segment');
  assert.equal(validateRel('', 'a/b.png', 'b'), false, 'separator');
  assert.equal(validateRel('', 'a\\b.png', 'b'), false, 'separator');
  assert.equal(validateRel('', 'a\x01.png', 'b'), false, 'control character');
  assert.equal(validateRel('', 'a<b>.png', 'b'), false, 'illegal glyph');
  assert.equal(validateRel('', 'trailing.png ', 'b'), false, 'trailing space');
  assert.equal(validateRel('', 'trailing.', 'b'), false, 'trailing dot');
  assert.equal(validateRel('', 'CON.png', 'b'), false, 'Windows device stem');
  assert.equal(validateRel('x'.repeat(500), 'y.png', 'b'), false, 'over MAX_REL_PATH_LEN');
  assert.equal(validateRel('..', 'x.png', 'b'), false, 'traversal');
});

// Spec test A4 ⚠ — the exclusivity the whole 'f'/'b' split rests on, in BOTH
// directions and case-folded. A path claimable by two kinds would let one node
// materialize over another's file with neither derivation noticing.
test('no path is claimable by both kinds, in any casing', () => {
  for (const n of ['Notes.md', 'Notes.MD', 'Notes.Md']) {
    assert.equal(validateRel('', n, 'f'), true, `${n} is a note`);
    assert.equal(validateRel('', n, 'b'), false, `${n} must never be an attachment`);
  }
  for (const n of ['photo.HEIC', 'photo.heic', 'diagram.PNG']) {
    assert.equal(validateRel('', n, 'b'), true, `${n} is an attachment`);
    assert.equal(validateRel('', n, 'f'), false, `${n} must never be a note`);
  }
});

// Spec §2.5. P1 returned TRUE for a kind it did not recognize, so a stray old
// client would treat a 'b' node as valid, derive no path for it, and then sweep an
// attachment-only folder as unclaimed and empty.
test('validateRel refuses a kind it does not recognize', () => {
  for (const kind of ['x', '', 'B', 'file', undefined, null, 1]) {
    assert.equal(validateRel('', 'a.md', kind as unknown as NodeKind), false, String(kind));
    assert.equal(validateRel('', 'a.png', kind as unknown as NodeKind), false, String(kind));
  }
});
