// src/sync/wiring.test.ts
// The plugin entry point is not testable headlessly — it imports `obsidian` — so
// the one thing that can go wrong there and nowhere else is checked by reading it.
//
// What can go wrong is always the same shape: an OPTIONAL dependency that is not
// passed. Every collaborator below takes its ports and its platform numbers as
// optional constructor arguments, because that is what makes the engine testable
// against fakes with no Obsidian in sight. The cost of that choice is that
// forgetting one is not a type error and not a test failure — it is a silently
// different default, in production only, on a code path nobody exercises until a
// user's attachment is involved:
//
//  * `Deletions` without `blobs` cannot ask the store whether an attachment's
//    bytes still exist, so §5.1's `proven` check answers "I could not ask" for
//    every attachment and every remote tombstone RESCUES — filling
//    `ShadowLink Recovered/` with 200 MB files instead of deleting anything. Safe,
//    and completely wrong.
//  * `Reconciler` without the fetch-policy numbers falls back to the DESKTOP
//    constants, so a phone downloads with a 10 MB per-file ceiling and a 512 MB
//    session budget — the two numbers §7.2 lowered specifically for phones.
//  * `Bootstrap` without them splits its download counts on a different rule from
//    the one the pass applies, and the first-sync modal becomes a guess.
//
// These are deliberately assertions about ARGUMENTS BEING PASSED, not about what
// they evaluate to: the values themselves are covered by the engine's own tests,
// and a guard that re-asserted them here would just be a second copy of the
// spec's constants table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAIN = readFileSync(fileURLToPath(new URL('../../main.ts', import.meta.url)), 'utf8');

/**
 * The `{ … }` literal handed to `new <name>(`, by brace balance.
 *
 * Balance rather than a regex, because every one of these blocks contains nested
 * objects, arrow functions and braces inside template strings; a lazy match would
 * stop at the first `}` and quietly assert against a fragment.
 */
function constructorArgs(name: string): string {
  const start = MAIN.indexOf(`new ${name}({`);
  assert.notEqual(start, -1, `main.ts no longer constructs ${name}`);
  let depth = 0;
  for (let i = MAIN.indexOf('{', start); i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth += 1;
    else if (MAIN[i] === '}') {
      depth -= 1;
      if (depth === 0) return MAIN.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in main.ts's ${name} construction`);
}

function assertPasses(name: string, keys: string[]): void {
  const args = constructorArgs(name);
  for (const key of keys) {
    assert.ok(
      new RegExp(`(^|[\\s,{])${key}\\s*:`, 'm').test(args),
      `main.ts must pass "${key}" to ${name}; without it the engine falls back to a `
      + 'default that is wrong in production and invisible in tests.',
    );
  }
}

test('the deletion pass is given the attachment store (§5.1)', () => {
  // Without it `isProvenBlob` can never reach a verdict, and every remote
  // tombstone for an attachment rescues instead of deleting.
  assertPasses('Deletions', ['blobs', 'memoryCapBytes']);
});

test('the reconciler is given both fetch-policy gates and both platform budgets (§7.2)', () => {
  assertPasses('Reconciler', [
    'blobs', 'memoryCapBytes', 'rehashBudgetBytes', 'autofetchMaxBytes', 'sessionBudgetBytes',
  ]);
});

test('bootstrap classifies against the same three numbers the pass will apply (§7.5)', () => {
  assertPasses('Bootstrap', [
    'memoryCapBytes', 'autofetchMaxBytes', 'sessionBudgetBytes', 'sessionSpentBytes',
  ]);
});

test('the publish queue and the watcher are given the memory cap (§7.4)', () => {
  assertPasses('PublishQueue', ['blobs', 'memoryCapBytes']);
  assertPasses('VaultWatcher', ['memoryCapBytes']);
});

// §7.4: platform detection lives in `main.ts` and reaches the engine as plain
// numbers. A helper that stopped branching would hand a phone the desktop
// ceilings without a single test noticing.
test('every platform number is chosen by a mobile test, in main.ts', () => {
  for (const helper of [
    'blobMemoryCap', 'blobRehashBudget', 'blobAutofetchMax', 'blobSessionBudget',
  ]) {
    const start = MAIN.indexOf(`function ${helper}()`);
    assert.notEqual(start, -1, `main.ts no longer defines ${helper}`);
    const body = MAIN.slice(start, MAIN.indexOf('\n}', start));
    assert.ok(
      body.includes('Platform.isMobile'),
      `${helper} must choose on Platform.isMobile — a phone silently given the `
      + 'desktop number is the failure §7.4 exists to prevent.',
    );
  }
});
