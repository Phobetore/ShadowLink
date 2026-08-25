// src/ui/format.test.ts
// "3 files" and "3 files (218 MB)" are different questions, and only the second
// one can be answered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { formatBytes, nothingToDownload, syncedStatus } from './format.ts';

test('sizes read the way a person reads them', () => {
  assert.equal(formatBytes(0), '0 KB');
  assert.equal(formatBytes(512), '1 KB');
  assert.equal(formatBytes(1024 * 400), '0.4 MB');
  assert.equal(formatBytes(1024 * 80), '80 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 180), '180 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024 * 3), '3.0 GB');
});

// A number that rounds to zero is still a file the user has, and "0 KB" beside a
// filename reads as "this is empty" rather than "this is small".
test('a small non-zero size never reads as nothing', () => {
  assert.equal(formatBytes(1), '1 KB');
  assert.equal(formatBytes(100), '1 KB');
});

// ---------------------------------------------------------------- §7.3

test('a share with nothing outstanding says plain "synced"', () => {
  assert.deepEqual(syncedStatus('Shared', []), {
    text: 'ShadowLink: synced',
    tooltip: 'Sharing Shared',
  });
});

// ⚠ §7.3, and the reason the wording is in a tested function rather than inline
// in a template string. The tree can agree on every peer that a path holds hash H
// while exactly ONE peer holds the bytes, so an indicator that says "synced" while
// twelve attachments were deliberately not downloaded is not shorthand — it is
// false, and false in the direction that stops the user looking for a file that
// really is not there.
test('a share with undownloaded attachments never says just "synced"', () => {
  const line = syncedStatus('Shared', [
    { bytes: 200 * 1024 * 1024 },
    { bytes: 140 * 1024 * 1024 },
  ]);

  assert.match(line.text, /2 attachment\(s\) available/);
  assert.notEqual(line.text, 'ShadowLink: synced');
  // The count is what makes somebody hover; the byte total is what makes the
  // decision, so it has to be there when they do.
  assert.match(line.tooltip, /2 attachment\(s\) not downloaded \(340 MB\)/);
  assert.match(line.tooltip, /Download attachments/);
});

// ---------------------------------------------------------------- §7.5

const MB = 1024 * 1024;

// ⚠ §7.5 verbatim: "the fetch is refused before any request is made, with a
// diagnostic naming the file, its size and the cap". All three have to land
// somewhere a person can read, and this is the surface they already have.
test('an attachment this device cannot hold never reads as just "synced"', () => {
  const line = syncedStatus('Shared', [], [{ path: 'Shared/report.pdf', bytes: 40 * MB }], [],
    32 * MB);

  assert.notEqual(line.text, 'ShadowLink: synced');
  assert.match(line.tooltip, /report\.pdf/, '§7.5: the file');
  assert.match(line.tooltip, /40 MB/, '§7.5: its size');
  assert.match(line.tooltip, /32 MB/, '§7.5: the cap');
  // The download command tests the cap BEFORE an approval, so it cannot fetch
  // this file however many times it is pressed. Naming it here would be the same
  // broken promise the first-sync modal was making.
  assert.doesNotMatch(line.tooltip, /Download attachments/);
});

// §6.5. The one refusal of the three that nothing done on this device can lift:
// a self-hoster ran the orphan sweeper with a short TTL, or the volume lost a
// file. Offering a Download button for it would be a button that can only fail.
test('an attachment the store no longer holds is reported, and never offered as a download', () => {
  const line = syncedStatus('Shared', [], [], [{ path: 'Shared/old.zip', bytes: 5 * MB }]);

  assert.notEqual(line.text, 'ShadowLink: synced');
  assert.match(line.tooltip, /old\.zip/);
  assert.match(line.tooltip, /5\.0 MB/);
  assert.doesNotMatch(line.tooltip, /Download attachments/);
});

// The three refusals are three different user-actionable states (§7.2, §7.4,
// §6.5) and exactly one of them has a remedy on this device. Collapsing them into
// one count would send the user to a command that cannot help for two of them.
test('the three refusals are counted apart, and only the fetchable one names the command', () => {
  const line = syncedStatus(
    'Shared',
    [{ bytes: 8 * MB }],
    [{ path: 'Shared/clip.mov', bytes: 400 * MB }],
    [{ path: 'Shared/old.zip', bytes: 5 * MB }],
    32 * MB,
  );

  assert.match(line.text, /1 attachment\(s\) available/);
  assert.match(line.tooltip, /1 attachment\(s\) not downloaded \(8\.0 MB\)/);
  assert.match(line.tooltip, /clip\.mov/);
  assert.match(line.tooltip, /old\.zip/);
  // One remedy, named once, against the one bucket it works for.
  assert.equal(line.tooltip.match(/Download attachments/g)?.length, 1);
});

// A long list is a tooltip nobody can read. It still has to be honest about how
// much it is not showing.
test('a long oversized list is sampled, and says how much it left out', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ path: `Shared/v${i}.mov`, bytes: 400 * MB }));
  const line = syncedStatus('Shared', [], many, [], 32 * MB);

  assert.match(line.text, /9/);
  assert.match(line.tooltip, /v0\.mov/);
  assert.match(line.tooltip, /more/, 'the ones it did not list are still accounted for');
});

// ------------------------------------------- §7.3, the download commands' answer

test('a command with nothing outstanding at all may say "already downloaded"', () => {
  assert.match(nothingToDownload('Shared', 'this workspace', [], []), /already downloaded/);
  assert.match(nothingToDownload('Shared', 'this note', [], []), /this note/);
});

// ⚠ The other half of the §7.3 wording rule. The download command tests the
// memory cap BEFORE it consults an approval, so an oversized attachment is one it
// can never fetch — and answering "every attachment here is already downloaded"
// is the same false statement the status bar was just stopped from making, said
// by the very command the first-sync modal sends the user to.
test('a command that cannot fetch an oversized attachment never calls it downloaded', () => {
  const line = nothingToDownload('Shared', 'this note',
    [{ path: 'Shared/clip.mov', bytes: 400 * MB }], [], 32 * MB);

  assert.doesNotMatch(line, /already downloaded/);
  assert.match(line, /this note/);
  assert.match(line, /clip\.mov/, '§7.5: the file');
  assert.match(line, /400 MB/, '§7.5: its size');
  assert.match(line, /32 MB/, '§7.5: the cap');
});

test('a command that cannot fetch a missing blob says so instead of claiming success', () => {
  const line = nothingToDownload('Shared', 'this workspace', [],
    [{ path: 'Shared/old.zip', bytes: 5 * MB }]);

  assert.doesNotMatch(line, /already downloaded/);
  assert.match(line, /old\.zip/);
});

// ------------------------------------------------- the wiring these strings need

// ⚠ Both functions above are only honest if their CALLER hands them everything,
// and the caller is `main.ts` — which imports `obsidian` and so cannot be loaded
// here. Both take their extra buckets as optional parameters, so forgetting one is
// not a type error and not a test failure: it is a status bar that says "synced"
// beside a file that is not on the disk, which is the defect this whole section
// exists to have ended.
const MAIN = readFileSync(fileURLToPath(new URL('../../main.ts', import.meta.url)), 'utf8');

test('the status bar is handed all three buckets, not just the fetchable one', () => {
  const start = MAIN.indexOf('syncedStatus(');
  assert.notEqual(start, -1, 'main.ts no longer calls syncedStatus');
  const args = MAIN.slice(start, MAIN.indexOf(');', start));

  assert.match(args, /deferredAttachments/);
  assert.match(args, /tooLargeAttachments/, '§7.5 would otherwise reach no surface at all');
  assert.match(args, /unavailableAttachments/, '§6.5 likewise');
  assert.match(args, /blobMemoryCap\(\)/, '§7.5 names the cap, so the cap has to be passed');
});

test('no download command claims an attachment is downloaded on its own authority', () => {
  assert.equal(
    MAIN.includes("'ShadowLink: every attachment"), false,
    'that claim belongs to nothingToDownload, which can see the buckets a command cannot',
  );
  assert.match(MAIN, /nothingToDownload\(/, 'and main.ts has to actually call it');
});
