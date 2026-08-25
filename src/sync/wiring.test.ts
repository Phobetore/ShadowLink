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
  return balancedFrom(`new ${name}({`, `main.ts no longer constructs ${name}`);
}

function balancedFrom(anchor: string, missing: string): string {
  const start = MAIN.indexOf(anchor);
  assert.notEqual(start, -1, missing);
  let depth = 0;
  for (let i = MAIN.indexOf('{', start); i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth += 1;
    else if (MAIN[i] === '}') {
      depth -= 1;
      if (depth === 0) return MAIN.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in main.ts after "${anchor}"`);
}

/**
 * The body of one method, by brace balance from its signature.
 *
 * Bounded on purpose: "the file mentions this name somewhere" is satisfied by the
 * method's own DEFINITION, so a guard written that way passes whether or not
 * anything ever calls it.
 */
function methodBody(signature: string): string {
  return balancedFrom(signature, `main.ts no longer defines ${signature}`);
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

// §7.3. Three commands, and a markdown post-processor, all of them reachable only
// through Obsidian's own registries. A command that is never registered is a
// feature nobody can find, and the whole point of the deferral policy is that the
// user has a way to say "yes, fetch that one".
test('the three download commands and the embed post-processor are registered', () => {
  for (const id of [
    'download-attachments-in-note', 'download-all-attachments', 'download-attachments',
  ]) {
    assert.ok(
      MAIN.includes(`id: '${id}'`),
      `main.ts must register the "${id}" command; a deferral the user cannot lift is a `
      + 'file they simply do not have.',
    );
  }
  assert.ok(
    /registerMarkdownPostProcessor\(\s*deferredEmbedProcessor\(/.test(MAIN),
    'main.ts must register the deferred-embed post-processor',
  );
});

// §7.3. Every one of those four paths must go through the SAME mechanism —
// approve, persist, then run a pass — because the pass owns every rule about what
// may be written where. A command that fetched bytes itself would be a second
// writer with none of them.
test('downloading an attachment approves it, persists that, and then runs a pass', () => {
  const body = methodBody('async downloadAttachments(ids: readonly string[]): Promise<void> {');

  const approve = body.indexOf('fetchApproved[id] = true');
  const persist = body.indexOf('state.flush()');
  const pass = body.indexOf('reconcile(');
  assert.ok(approve !== -1, 'the approval is what lifts the policy (§7.2)');
  assert.ok(
    persist > approve,
    'the approval is persisted BEFORE the pass: a fetch that fails must not make the '
    + 'user press the button again',
  );
  assert.ok(pass > persist, 'and only then is a pass asked for');
  assert.equal(
    /blobs\.get\(/.test(body), false,
    'a command must never fetch bytes itself — the pass owns every rule about writing them',
  );
});

// §7.5. The check is one line and the string is one paragraph, and without both
// this feature does not work on a default Obsidian install: the vault-global
// "Default location for new attachments" points at the vault root, so the first
// image dragged into a shared note lands outside the share and every peer sees a
// broken embed. Nothing in the sync engine can fix that — the file genuinely is
// not in the shared folder — so being told is the entire remedy.
test('the attachment-folder warning is actually reachable on start (§7.5)', () => {
  assert.ok(
    MAIN.includes('attachmentsLandInsideShare('),
    'main.ts must run the attachment-location check',
  );
  assert.ok(MAIN.includes('warnAttachmentFolder('), 'and show the warning when it fails');
  assert.ok(
    methodBody('async start(): Promise<void> {').includes('this.warnIfAttachmentsLandOutside()'),
    'the check must be CALLED from start(); defining it is not reaching it',
  );
  // Dismissible, and the dismissal has to survive a restart — otherwise it is not
  // a dismissal, it is a delay.
  assert.ok(
    MAIN.includes('attachmentFolderWarningDismissed = true')
    && MAIN.includes('saveSettings()'),
    'dismissing must be persisted',
  );
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
