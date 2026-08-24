// src/sync/banned-calls.test.ts
// The lint guard for invariant I1 and invariant I16 (spec §5.2, §10 "definition
// of done").
//
// Three calls must never appear in shipped source. Not "should not" — must not,
// because each of them is unrecoverable in a way no later pass can undo:
//
//  * The hard vault delete removes the user's file with nothing left behind. P1's
//    entire deletion story (§5.3) is "rescue on ignorance, vault-local trash on
//    proof"; a single hard delete makes that story false for one code path, and
//    nobody finds out until somebody's note is gone.
//  * The same trash call with the system flag set to TRUE routes to the OS recycle
//    bin — which does not exist on mobile at all, so the fallback there is
//    platform-dependent and the file is not restorable from inside Obsidian.
//    §5.2 chose the vault-local trash precisely because Settings → Files →
//    Deleted files can restore it on every platform.
//  * The file manager's rename rewrites backlinks. Obsidian already did that on
//    the machine where the human renamed, and that rewrite travels to every peer
//    as ordinary text edits — so a peer that rewrote as well would insert the same
//    logical edit a second time into one shared `Y.Text` (I16). This is the bug
//    Relay still has open.
//
// The needles are ASSEMBLED FROM FRAGMENTS and never spelled out in prose here
// either. A guard that spelled them would itself contain the strings it exists to
// forbid, and the next person to widen the scan to include test files would find
// the guard reporting itself. Test files are excluded from the scan for the same
// reason and because they are not shipped.
//
// One deliberate asymmetry: the CALL is banned everywhere, while the NAME is
// allowed in exactly one file — `VaultPort.ts`, whose contract is where the rule
// is written down. A guard that forbade the word outright would forbid
// documenting the rule, which is how a ban stops being understood and starts
// being worked around.
//
// The last test here is the other half of the same rule: `obsidian` may only be
// imported by the plugin entry point, the UI, and the three adapters. Everything
// else stays headless, which is what makes Group A and Group B testable at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Files that are compiled into the plugin. Tests are not, and are excluded. */
function shippedSources(): string[] {
  const out: string[] = [join(REPO_ROOT, 'main.ts')];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts')) continue;
      if (name.endsWith('.test.ts')) continue;          // not shipped, and see the header
      out.push(full);
    }
  };
  walk(join(REPO_ROOT, 'src'));
  return out;
}

/** Repo-relative, POSIX separators, so an assertion message reads the same anywhere. */
function relative(file: string): string {
  return file.slice(REPO_ROOT.length).replace(/\\/g, '/');
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

const SOURCES = shippedSources();

// ---------------------------------------------------------------- I1

test('the hard vault delete appears nowhere in shipped source (I1)', () => {
  const needle = `vault.${'delete'}(`;
  for (const file of SOURCES) {
    assert.equal(
      read(file).includes(needle),
      false,
      `${relative(file)} must not contain ${needle}`,
    );
  }
});

test('the system-trash flag is never passed to the trash call (I1)', () => {
  // The literal spelled out by the spec, plus a pattern that also catches it
  // written with any other receiver or argument name.
  const literal = `${'trash'}(file, ${'true'})`;
  const pattern = new RegExp(
    `\\.${'trash'}\\s*\\(\\s*[^,()]+,\\s*${'true'}\\s*\\)`,
  );

  for (const file of SOURCES) {
    const source = read(file);
    assert.equal(
      source.includes(literal),
      false,
      `${relative(file)} must not contain ${literal}`,
    );
    const hit = pattern.exec(source);
    assert.equal(
      hit,
      null,
      `${relative(file)} passes the system-trash flag: ${hit?.[0] ?? ''}`,
    );
  }
});

test('every trash call in shipped source resolves its flag to false (I1)', () => {
  // The stronger form of the test above: the flag may be a named constant, so
  // follow the name to its declaration rather than trusting that it is not the
  // word this file refuses to spell.
  const call = new RegExp(`\\.${'trash'}\\s*\\(\\s*[^,()]+,\\s*([A-Za-z_$][\\w$]*)\\s*\\)`, 'g');
  let checked = 0;

  for (const file of SOURCES) {
    const source = read(file);
    for (const match of source.matchAll(call)) {
      const flag = match[1];
      checked += 1;
      if (flag === 'false') continue;
      assert.ok(
        new RegExp(`const\\s+${flag}\\s*(?::\\s*boolean\\s*)?=\\s*false\\b`).test(source),
        `${relative(file)}: the trash flag "${flag}" is not a constant false`,
      );
    }
  }

  // If this ever drops to zero, removal has stopped going through the vault-local
  // trash and the tests above have quietly become vacuous.
  assert.equal(checked, 1, 'exactly one trash call, in ObsidianVaultPort');
});

test('removal is spelled trashLocal, and the adapter provides it', () => {
  const port = read(join(REPO_ROOT, 'src/sync/ObsidianVaultPort.ts'));
  assert.ok(port.includes('async trashLocal('), 'the adapter implements trashLocal');
  assert.equal(
    port.includes(`${'trashSystem'}(`),
    false,
    'the adapter-level system trash is banned too',
  );
});

// ---------------------------------------------------------------- I16

test('the backlink-rewriting rename is never CALLED in shipped source (I16)', () => {
  const call = `.${'renameFile'}(`;
  for (const file of SOURCES) {
    assert.equal(
      read(file).includes(call),
      false,
      `${relative(file)} must not call ${call}`,
    );
  }
});

test('the backlink-rewriting rename is NAMED only where it is forbidden', () => {
  // `VaultPort.ts` is the contract that bans it, so it is the one place the name
  // may appear — in prose, explaining why. Anywhere else, a mention is either a
  // call or a step towards one.
  const needle = `${'fileManager'}.${'renameFile'}`;
  const documented = 'src/sync/VaultPort.ts';

  for (const file of SOURCES) {
    const rel = relative(file);
    if (rel === documented) continue;
    assert.equal(read(file).includes(needle), false, `${rel} must not mention ${needle}`);
  }
  assert.ok(
    read(join(REPO_ROOT, documented)).includes(needle),
    `${documented} is expected to still document the ban`,
  );
});

test('the vault adapter renames through vault.rename (I16)', () => {
  const port = read(join(REPO_ROOT, 'src/sync/ObsidianVaultPort.ts'));
  assert.ok(port.includes('this.vault.rename('), 'renames go through vault.rename');
});

// ---------------------------------------------------------------- headlessness

test('only the entry point, the UI and the three adapters import obsidian', () => {
  const allowed = new Set([
    'main.ts',
    'src/sync/ObsidianVaultPort.ts',
    'src/sync/ObsidianDocPort.ts',
    'src/sync/ObsidianStatePort.ts',
  ]);

  for (const file of SOURCES) {
    const rel = relative(file);
    if (allowed.has(rel) || rel.startsWith('src/ui/')) continue;
    const source = read(file);
    assert.equal(
      source.includes("from 'obsidian'"),
      false,
      `${rel} must stay headless — no obsidian import`,
    );
  }
});

test('the scan actually reaches the modules it is guarding', () => {
  const scanned = new Set(SOURCES.map(relative));
  for (const expected of [
    'main.ts',
    'src/sync/ObsidianVaultPort.ts',
    'src/sync/ObsidianDocPort.ts',
    'src/sync/ObsidianStatePort.ts',
    'src/sync/Deletions.ts',
    'src/sync/Reconciler.ts',
    'src/sync/WorkspaceSession.ts',
    'src/ui/modals.ts',
  ]) {
    assert.ok(scanned.has(expected), `the guard must scan ${expected}`);
  }
  // A scan that silently stopped finding files would pass every test above.
  assert.ok(SOURCES.length >= 20, `expected the whole plugin, scanned ${SOURCES.length} files`);
});
