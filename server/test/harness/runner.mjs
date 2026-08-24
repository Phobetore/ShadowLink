// server/test/harness/runner.mjs
// A three-function test runner. `node --test` is not used here because every
// case needs the same long-lived server process and must be able to tear its
// clients down even when an assertion throws.

import assert from 'node:assert/strict';

const cases = [];
let only = null;

export { assert };

export function test(name, fn) {
  cases.push({ name, fn });
}

/** Restrict the run to the cases whose name contains `pattern` (CLI: --only=…). */
export function setFilter(pattern) {
  only = pattern;
}

export async function run() {
  let failed = 0;
  let passed = 0;
  let skipped = 0;
  for (const { name, fn } of cases) {
    if (only !== null && !name.includes(only)) { skipped += 1; continue; }
    const started = Date.now();
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name} (${Date.now() - started}ms)`);
      console.error(`      ${err?.stack ?? err}`);
    }
  }
  return { failed, passed, skipped };
}
