// src/ui/format.test.ts
// "3 files" and "3 files (218 MB)" are different questions, and only the second
// one can be answered.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatBytes, syncedStatus } from './format.ts';

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
