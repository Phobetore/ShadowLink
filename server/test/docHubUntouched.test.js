// server/test/docHubUntouched.test.js
// P3 spec §4 and §9 slice 1: the mux was measured against an UNMODIFIED
// `DocHub`, and the slice ships on that claim. This is where the claim is
// re-checked on every run, on every platform, with no git and no network.
//
// The rest of the enforcement is `server/tools/check-dochub.mjs`, which CI runs
// as a script so it can also ask git directly. What lives here is the half that
// a developer feels immediately: change one byte of DocHub and `npm test` fails,
// with a message that says why rather than as a mysterious relay failure three
// suites later.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDocHubContent, gitBlobSha1, committedBytes,
  DOCHUB_BLOB_SHA1, DOCHUB_PATH,
} from '../tools/check-dochub.mjs';

test('server/DocHub.js is byte-identical to the version P3 slice 1 measured', () => {
  const { ok, actual, expected } = checkDocHubContent();
  assert.equal(
    ok, true,
    `server/DocHub.js hashes to ${actual}, expected ${expected}.\n`
    + 'The P3 mux is additive by construction: it hands duck-typed virtual\n'
    + 'connections to the SHIPPED class. DocHub is not a mux slice\'s to change.',
  );
});

test('the pin is git\'s own blob id, so CI and a developer are asking one question', () => {
  // If this ever disagrees with `git rev-parse HEAD:server/DocHub.js`, the pin
  // and git are measuring different things and the check above means less than
  // it looks like it does. The empty blob is the fixed point that proves the
  // hash function itself is git's, independent of DocHub.
  assert.equal(gitBlobSha1(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(gitBlobSha1(Buffer.from('hello\n', 'utf8')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(gitBlobSha1(committedBytes(DOCHUB_PATH)), DOCHUB_BLOB_SHA1);
});

test('the pin reads DocHub through a line-ending normalization, not raw', () => {
  // The working tree is CRLF on Windows and LF on Linux CI. A hash over the
  // bytes as they sit on disk is two different numbers on the two platforms, so
  // a pin taken that way passes on one and fails on the other — which reads as
  // "DocHub was modified" on a machine where nothing was.
  const normalized = committedBytes(DOCHUB_PATH);
  assert.equal(
    normalized.includes(0x0d), false,
    'the normalized bytes still hold a CR: the pin is platform-dependent',
  );
});
