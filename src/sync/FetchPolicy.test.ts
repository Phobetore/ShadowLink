// src/sync/FetchPolicy.test.ts
// Spec §7.2, as a truth table.
//
// The predicate is a pure function precisely so `Reconciler.materializeBlob` and
// `Bootstrap.classify` cannot drift apart: the first-sync modal says how many
// attachments will arrive, and the pass then decides for itself. If those two
// answers came from two pieces of arithmetic, the modal would be a guess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { fetchVerdict, publishVerdict, type FetchLimits } from './FetchPolicy.ts';

const LIMITS: FetchLimits = {
  memoryCapBytes: 1_000,
  autofetchMaxBytes: 100,
  sessionBudgetBytes: 500,
};

test('a small attachment inside every ceiling is fetched', () => {
  assert.equal(fetchVerdict(50, LIMITS, false, 0), 'yes');
});

test('the per-file ceiling defers, and the memory cap refuses outright', () => {
  assert.equal(fetchVerdict(101, LIMITS, false, 0), 'needsApproval');
  assert.equal(fetchVerdict(1_001, LIMITS, false, 0), 'tooLarge');
});

// Every comparison in the policy is `>`, so a file exactly at a ceiling is allowed.
// There are THREE of them, and each line below is arranged so the ceiling its
// message names is the only one that byte count can be sitting at: the other two
// are pushed far out of reach. Turn any single `>` into `>=` and exactly one of
// these three flips — which is the property the earlier version of this test
// claimed and did not have, because two of its lines were the same call twice.
test('a ceiling is inclusive: exactly at the limit still passes', () => {
  // The auto-fetch ceiling: 100 is a tenth of the memory cap and a fifth of the
  // budget, so `needsApproval` is the only verdict within reach of these bytes.
  assert.equal(fetchVerdict(100, LIMITS, false, 0), 'yes', 'exactly the auto-fetch ceiling');

  // The memory cap, tested first and here the only ceiling in play at all.
  const atTheCap: FetchLimits = {
    memoryCapBytes: 1_000, autofetchMaxBytes: 1e9, sessionBudgetBytes: 1e9,
  };
  assert.equal(fetchVerdict(1_000, atTheCap, false, 0), 'yes', 'exactly the memory cap');

  // The session budget, filled in one go by a session that has spent nothing —
  // the other half of the boundary the part-spent case below pins.
  const atTheBudget: FetchLimits = {
    memoryCapBytes: 1e9, autofetchMaxBytes: 1e9, sessionBudgetBytes: 500,
  };
  assert.equal(fetchVerdict(500, atTheBudget, false, 0), 'yes', 'exactly the session budget');
});

// The whole reason there are TWO gates. Four thousand files of one megabyte each
// pass every per-file check ever written and still eat a data plan.
test('the session budget refuses a file every per-file check would allow', () => {
  assert.equal(fetchVerdict(50, LIMITS, false, 460), 'sessionBudget');
  assert.equal(fetchVerdict(50, LIMITS, false, 450), 'yes', 'and exactly filling it is allowed');
});

test('approval lifts the per-file ceiling and the session budget', () => {
  assert.equal(fetchVerdict(101, LIMITS, true, 0), 'yes');
  assert.equal(fetchVerdict(50, LIMITS, true, 499), 'yes');
});

// §7.4: the memory cap gates every WHOLE-FILE allocation, and an approval is not
// more memory. A device that says yes to a 200 MB video it cannot hold does not
// download it — it dies holding half of it, which is the one outcome the cap
// exists to make impossible. So the cap is tested BEFORE the approval, which is
// the one place this deviates from §7.2's pseudocode order.
//
// That deviation is defensible only while the cap is a fact about the hardware.
// §7.4 as amended says so — `memoryCapBytes()` = `platformCap`, folded with
// nothing — which is what makes the paragraph above true rather than roughly true.
test('approval does NOT lift the memory cap', () => {
  assert.equal(fetchVerdict(1_001, LIMITS, true, 0), 'tooLarge');
});

test('an unlimited-looking budget still refuses above the cap', () => {
  const wide: FetchLimits = {
    memoryCapBytes: 10, autofetchMaxBytes: 1e9, sessionBudgetBytes: 1e9,
  };
  assert.equal(fetchVerdict(11, wide, false, 0), 'tooLarge');
});

// ------------------------------------------------------------ §3.2: publishing

// The OTHER direction, deliberately in this file and immediately below the one
// above, because the difference between the two signatures IS the design: the
// server's per-file ceiling is a PARAMETER of `publishVerdict` and structurally
// absent from `FetchLimits`. Acceptance governs WRITING and is a policy the
// operator can change at any moment; memory governs BOTH directions and is a
// fact about the hardware. Folding them types the second as the first.

test('publishVerdict: inside both ceilings, the bytes are offered', () => {
  assert.equal(publishVerdict(50, 1_000, 500), 'ok');
});

// A phone must never need the network to learn it cannot hold a file, so the
// device arm is tested first — and the server ceiling is only awaited when the
// call actually reaches it.
test('publishVerdict: the DEVICE arm wins when both ceilings are exceeded', () => {
  assert.deepEqual(publishVerdict(5_000, 1_000, 100), { refused: 'device', cap: 1_000 });
});

// §7.5 promises the user a remedy and the two refusals have different ones —
// "shrink it" against "ask whoever runs the server" — so which ceiling bound it
// travels with the verdict instead of being re-derived by the caller.
test('publishVerdict: the server arm refuses only what the device arm allowed', () => {
  assert.deepEqual(publishVerdict(2_000, 1e9, 1_024), { refused: 'server', cap: 1_024 });
});

// I2, in the one place it cannot be undone by a later pass: an unknown ceiling is
// never a small one. Reading "I could not ask" as "no" tombstones a publishable
// file because the network blinked.
test('publishVerdict: a null server ceiling never returns a server refusal', () => {
  assert.equal(publishVerdict(1e9, 2e9, null), 'ok');
  assert.equal(publishVerdict(0, 0, null), 'ok');
});

// `>` at both ceilings, matching `fetchVerdict`'s "this much is fine" above.
test('publishVerdict: both ceilings are inclusive', () => {
  assert.equal(publishVerdict(1_000, 1_000, 1e9), 'ok', 'exactly the device cap');
  assert.equal(publishVerdict(1_024, 1e9, 1_024), 'ok', 'exactly the server cap');
  assert.deepEqual(publishVerdict(1_001, 1_000, 1e9), { refused: 'device', cap: 1_000 });
  assert.deepEqual(publishVerdict(1_025, 1e9, 1_024), { refused: 'server', cap: 1_024 });
});

// ---------------------------------------------------------------- §7.4's shape

/**
 * The cap rule as a SHAPE rather than a sentence, because a sentence is what went
 * wrong here: §7.4 wrote `memoryCapBytes() = min(platformCap, maxFileBytes)`,
 * which types an acceptance policy as a memory fact.
 *
 * A fourth field on `FetchLimits` is the only way that formula could reach this
 * module, and the consequence would not be cosmetic: `MAX_FILE_SIZE_MB` floors at
 * 1 in `server/config.js`, BELOW the 10 MB desktop / 2 MB mobile auto-fetch
 * ceiling. A folded server value therefore turns every attachment in that gap
 * from the recorded, remediable `needsApproval` into the unrecorded, unfixable
 * `tooLarge` — and the cap is tested before an approval is consulted, so nothing
 * the user presses can lift it.
 *
 * Read off the source rather than off a literal, because the test runner strips
 * types without checking them: a literal would still satisfy a widened interface.
 */
test('FetchLimits carries three device numbers and no server value (§7.4)', () => {
  const src = readFileSync(fileURLToPath(new URL('./FetchPolicy.ts', import.meta.url)), 'utf8');
  const start = src.indexOf('export interface FetchLimits {');
  assert.notEqual(start, -1, 'FetchPolicy.ts no longer declares FetchLimits');
  const block = src.slice(start, src.indexOf('\n}', start));
  const fields = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]).sort();
  assert.deepEqual(
    fields,
    ['autofetchMaxBytes', 'memoryCapBytes', 'sessionBudgetBytes'],
    'A server ceiling reaching the fetch policy would refuse a DOWNLOAD of bytes '
    + 'that GET /blob/<ws>/<sha> serves with no size check at all, and would turn '
    + 'needsApproval into tooLarge for everything between the two numbers.',
  );
});
