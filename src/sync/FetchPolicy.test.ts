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

test('a ceiling is inclusive: exactly at the limit still passes', () => {
  assert.equal(fetchVerdict(100, LIMITS, false, 0), 'yes');
  const wide = { ...LIMITS, autofetchMaxBytes: 1_000, sessionBudgetBytes: 1_000 };
  assert.equal(fetchVerdict(1_000, wide, false, 0), 'yes', 'exactly the memory cap');
  assert.equal(fetchVerdict(1_000, wide, false, 0), 'yes', 'and exactly the session budget');
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
