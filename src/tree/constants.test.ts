// src/tree/constants.test.ts
// Relationships BETWEEN the tuning constants, which no single value can express.
//
// Most of `constants.ts` is a number with a paragraph justifying it, and a
// paragraph is the right place for "why 10 MB". What a paragraph cannot do is
// survive somebody re-tuning a NEIGHBOUR: several of these values are only safe
// relative to each other, the ordering between them is load-bearing, and nothing
// anywhere fails when it is inverted. The pass still runs, the suite still
// passes, and the damage shows up as a file that never arrives.
//
// So the orderings are asserted here, in terms of the behaviour they buy rather
// than as arithmetic for its own sake.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOFETCH_MAX_BYTES,
  AUTOFETCH_MAX_BYTES_MOBILE,
  AUTOFETCH_SESSION_BUDGET,
  AUTOFETCH_SESSION_BUDGET_MOBILE,
  BLOB_MAX_BYTES,
  BLOB_MAX_BYTES_MOBILE,
} from './constants.ts';
import { fetchVerdict, type FetchLimits } from '../sync/FetchPolicy.ts';

const DESKTOP: FetchLimits = {
  memoryCapBytes: BLOB_MAX_BYTES,
  autofetchMaxBytes: AUTOFETCH_MAX_BYTES,
  sessionBudgetBytes: AUTOFETCH_SESSION_BUDGET,
};

const MOBILE: FetchLimits = {
  memoryCapBytes: BLOB_MAX_BYTES_MOBILE,
  autofetchMaxBytes: AUTOFETCH_MAX_BYTES_MOBILE,
  sessionBudgetBytes: AUTOFETCH_SESSION_BUDGET_MOBILE,
};

const PLATFORMS: Array<[string, FetchLimits]> = [['desktop', DESKTOP], ['mobile', MOBILE]];

// ⚠ THE LIVELOCK THIS ORDERING KEEPS UNREACHABLE.
//
// `fetchVerdict` consults the per-file ceiling before the session budget, and the
// two refusals are recorded very differently (§7.2): `needsApproval` is PERSISTED
// as `fetchDeferred`, and `sessionBudget` is deliberately written nowhere at all,
// because it is a statement about this afternoon rather than about the file.
//
// That asymmetry is only sound while the per-file ceiling is the tighter of the
// two. Raise `AUTOFETCH_MAX_BYTES` above `AUTOFETCH_SESSION_BUDGET` — or lower the
// budget under the ceiling, which is the same mistake from the other side — and a
// band opens between them where a single file is larger than the WHOLE session
// allowance while still under the per-file ceiling. Such a file is refused
// `sessionBudget` on a session that has fetched nothing, and it is refused that
// way again on the next pass, and on the first pass of every session after that,
// because the budget resets to zero and the file alone still does not fit. It
// converges never, and §7.2 forbids that branch from writing a record, so nothing
// on disk remembers it exists between one launch and the next.
//
// A file over the per-file ceiling has the same "never arrives on its own"
// property and is a supported state rather than a bug, precisely because it IS
// recorded — which is what lets a download button know the attachment exists, and
// how big it is, with no pass running.
test('the per-file ceiling is at or under the session budget, on both platforms', () => {
  assert.ok(
    AUTOFETCH_MAX_BYTES <= AUTOFETCH_SESSION_BUDGET,
    `desktop: the auto-fetch ceiling (${AUTOFETCH_MAX_BYTES}) must not exceed the session `
    + `budget (${AUTOFETCH_SESSION_BUDGET})`,
  );
  assert.ok(
    AUTOFETCH_MAX_BYTES_MOBILE <= AUTOFETCH_SESSION_BUDGET_MOBILE,
    `mobile: the auto-fetch ceiling (${AUTOFETCH_MAX_BYTES_MOBILE}) must not exceed the `
    + `session budget (${AUTOFETCH_SESSION_BUDGET_MOBILE})`,
  );
});

// The same property stated as behaviour, so it survives a re-tune that edits the
// numbers above without reading them: on a session that has spent nothing, the
// budget must be unreachable. Every byte count it could otherwise refuse has
// already been turned away by a ceiling that leaves a record behind.
test('a fresh session can never reach the session-budget refusal', () => {
  for (const [name, limits] of PLATFORMS) {
    // The smallest file the budget alone could refuse on an unspent session.
    const justOverBudget = limits.sessionBudgetBytes + 1;
    assert.notEqual(
      fetchVerdict(justOverBudget, limits, false, 0),
      'sessionBudget',
      `${name}: ${justOverBudget} bytes is refused by the budget before any ceiling records it`,
    );

    // …and the first file over the per-file ceiling still lands on the recorded
    // refusal rather than the unrecorded one.
    assert.equal(
      fetchVerdict(limits.autofetchMaxBytes + 1, limits, false, 0),
      'needsApproval',
      `${name}: the first file over the auto-fetch ceiling must be the persisted refusal`,
    );
  }
});

// ⚠ The other latent re-tune, and the one that fails silently in the opposite
// direction. `constants.ts` says the auto-fetch ceiling sits "deliberately far
// below the memory cap" because the two answer different questions — "would the
// user expect this to arrive on its own" against "could this device hold it at
// all". Raise it past the cap and the sentence stays in the file while the
// ceiling becomes dead code: `fetchVerdict` tests the cap first, so every file
// that would have been offered as a download is refused `tooLarge` instead — the
// one bucket with no remedy on this device, because an approval is not more
// memory.
test('the per-file ceiling stays under the memory cap, on both platforms', () => {
  for (const [name, limits] of PLATFORMS) {
    assert.ok(
      limits.autofetchMaxBytes <= limits.memoryCapBytes,
      `${name}: the auto-fetch ceiling (${limits.autofetchMaxBytes}) must not exceed the `
      + `memory cap (${limits.memoryCapBytes})`,
    );
    assert.equal(
      fetchVerdict(limits.autofetchMaxBytes, limits, false, 0),
      'yes',
      `${name}: a file exactly at the auto-fetch ceiling must still be fetchable`,
    );
  }
});

// Mobile is the tighter device in every direction. A re-tune that inverted one of
// these would not break a rule so much as quietly describe a phone with more
// headroom than a desktop, which is how the mobile ceilings stop being read as
// the constraint they are.
test('every mobile ceiling is at or under its desktop counterpart', () => {
  assert.ok(BLOB_MAX_BYTES_MOBILE <= BLOB_MAX_BYTES, 'memory cap');
  assert.ok(AUTOFETCH_MAX_BYTES_MOBILE <= AUTOFETCH_MAX_BYTES, 'auto-fetch ceiling');
  assert.ok(AUTOFETCH_SESSION_BUDGET_MOBILE <= AUTOFETCH_SESSION_BUDGET, 'session budget');
});
