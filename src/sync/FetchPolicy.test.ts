// src/sync/FetchPolicy.test.ts
// Spec §7.2, as a truth table.
//
// The predicate is a pure function precisely so `Reconciler.materializeBlob` and
// `Bootstrap.classify` cannot drift apart: the first-sync modal says how many
// attachments will arrive, and the pass then decides for itself. If those two
// answers came from two pieces of arithmetic, the modal would be a guess.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchVerdict, type FetchLimits } from './FetchPolicy.ts';

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
test('approval does NOT lift the memory cap', () => {
  assert.equal(fetchVerdict(1_001, LIMITS, true, 0), 'tooLarge');
});

test('an unlimited-looking budget still refuses above the cap', () => {
  const wide: FetchLimits = {
    memoryCapBytes: 10, autofetchMaxBytes: 1e9, sessionBudgetBytes: 1e9,
  };
  assert.equal(fetchVerdict(11, wide, false, 0), 'tooLarge');
});
