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
// A LITERAL NEEDLE IS NOT ENOUGH, which is why the second half of this file
// exists. `vault.delete(` misses `self.v.delete(f)` — the same call through an
// alias — and it never looked at `DataAdapter` at all, though `ObsidianStatePort`
// holds one and the adapter's own removal calls are every bit as unrecoverable as
// the vault's. So removal is guarded twice over:
//
//  * NO destructive call may be written on a receiver that looks like a vault or
//    an adapter, whatever it is named along the way;
//  * EVERY destructive call in shipped source must name a receiver on the
//    allowlist below, which holds nothing but in-memory bookkeeping — Maps, Sets
//    and the `DiskIndex` mirror. Default-deny is the point: a new one has to be
//    justified here, in a file whose whole subject is why these calls are
//    dangerous, rather than merely not resembling anything anybody thought to ban.
//
// The two are backed by a third test that refuses a call this guard cannot
// attribute to a receiver at all, so "write it across two lines" is not a way
// through.
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

test('the adapter-level binary write and removal appear nowhere in shipped source (I1)', () => {
  // WIDENED IN P2-e. Binary writes exist now, so the adapter's own file calls are
  // reachable in a way they were not while every write went through
  // `vault.create`. Each is unrecoverable in the same way the vault's hard delete
  // is:
  //
  //  * the adapter's binary WRITE overwrites whatever is at the path, with no
  //    folded occupancy check and nothing retained. `VaultPort.createBinary`
  //    refuses an occupied path for precisely that reason, and the replace
  //    primitive stages the previous bytes out BEFORE the new ones exist (I1);
  //  * the adapter's REMOVE deletes with nothing left behind — not even the
  //    vault-local `.trash` that Settings → Files → Deleted files restores from
  //    on every platform.
  //
  // The second is also caught by the receiver scan below, which bans these calls
  // on anything adapter-shaped. It is spelled out here as well because a literal
  // needle and a receiver rule fail in different directions, and this pair is now
  // one refactor away from being written by accident.
  //
  // ONE EXEMPTION, and it is about WHAT is written rather than how: the state
  // port writes the plugin's OWN two files, inside the plugin's own data
  // directory, and an atomic overwrite is precisely what they need (§2.5, §2.6).
  // Nothing it can address is the user's content — which the assertions below
  // check rather than assume.
  const banned = [`adapter.${'writeBinary'}(`, `adapter.${'remove'}(`];
  const ownFilesOnly = 'src/sync/ObsidianStatePort.ts';
  for (const file of SOURCES) {
    const source = read(file);
    for (const needle of banned) {
      if (relative(file) === ownFilesOnly && needle === `adapter.${'writeBinary'}(`) continue;
      assert.equal(
        source.includes(needle),
        false,
        `${relative(file)} must not contain ${needle}. Writes go through `
        + 'VaultPort.createBinary, which refuses an occupied path; removal goes '
        + 'through VaultPort.trashLocal, which is the vault-local trash.',
      );
    }
  }

  // The exemption is only sound while that file cannot address anything outside
  // the plugin's data directory: every path it touches is built by `pathFor`,
  // which prefixes `this.dir`, and it has no notion of a shared folder at all.
  const port = read(join(REPO_ROOT, ownFilesOnly));
  assert.ok(port.includes('${this.dir}/${key}'), `${ownFilesOnly}: paths must derive from this.dir`);
  assert.equal(
    port.includes('shareRoot'),
    false,
    `${ownFilesOnly} must have no way to name the shared folder`,
  );
});

test('the adapter-level system trash appears in NO shipped file (I1)', () => {
  // Same ban as above, no longer limited to the one file that happens to hold a
  // `Vault`: `ObsidianStatePort` holds a `DataAdapter`, and the plugin entry point
  // can reach both.
  const needle = `${'trashSystem'}(`;
  for (const file of SOURCES) {
    assert.equal(read(file).includes(needle), false, `${relative(file)} must not call ${needle}`);
  }
});

// ---------------------------------------------------------------- I1, widened

/**
 * A destructive call written as `<receiver>.<op>(`, with the receiver captured as
 * a plain dotted chain.
 *
 * Deliberately whitespace-free: a receiver is only meaningful if it can be
 * attributed, and the test below refuses any occurrence this cannot attribute
 * rather than letting an unusual layout through unexamined.
 */
const DESTRUCTIVE = new RegExp(
  `([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\.(${'delete'}|${'remove'}|${'rmdir'})\\s*\\(`,
  'g',
);

/** The same three calls with no receiver captured — used only to count them. */
const DESTRUCTIVE_BARE = new RegExp(
  `\\.(?:${'delete'}|${'remove'}|${'rmdir'})\\s*\\(`,
  'g',
);

/**
 * Receiver segments that mean "this is the user's vault, or the filesystem under
 * it". None of the three calls above may ever be written on one, under any name:
 * removal goes through `VaultPort.trashLocal` and nowhere else.
 */
const VAULT_SHAPED = new Set(['vault', 'vaults', 'adapter', 'dataadapter', 'v', 'app', 'filemanager']);

/**
 * Every receiver in shipped source that is allowed to be destroyed from, and what
 * it actually is. Nothing here touches a disk:
 *
 *   ctx.disk            DiskIndex — the in-memory mirror of the pass's view
 *   ctx.boundAtFold     Map, ctx.have Map, this.byFold Map, this.store Map,
 *   this.errors Map, this.live Map, this.rooms Map, this.entries Map,
 *   m / derivedPath     Y.Map and a derived Map
 *   this.open, this.liveHandles, this.listeners, this.waiters,
 *   this.subscribers, this.decisionPending, this.selected   Sets
 *   this.objects        FakeBlobs' in-memory content-addressed store
 *   node.classList      a DOMTokenList on a rendered markdown element — the
 *                       post-processor's own output, which exists only in a
 *                       preview pane and has no path, no file and no disk
 */
const IN_MEMORY: Record<string, string[]> = {
  'src/sync/Deletions.ts': ['ctx.disk'],
  'src/sync/DiskIndex.ts': ['this.byFold'],
  'src/sync/ObsidianDocPort.ts': ['this.live', 'this.rooms'],
  'src/sync/ProviderAck.ts': ['this.listeners'],
  'src/sync/PublishQueue.ts': ['this.errors'],
  'src/sync/Reconciler.ts': ['ctx.disk', 'ctx.boundAtFold', 'ctx.have'],
  'src/sync/Tickets.ts': ['this.store'],
  'src/sync/VaultWatcher.ts': ['this.decisionPending'],
  'src/sync/WorkspaceSession.ts': ['this.waiters'],
  'src/sync/fakes.ts': ['this.open', 'this.entries', 'this.byFold', 'this.liveHandles', 'this.objects'],
  'src/tree/TreeDoc.ts': ['m', 'this.subscribers'],
  'src/tree/TreeIndex.ts': ['derivedPath'],
  'src/ui/DeferredEmbeds.ts': ['node.classList'],
  'src/ui/modals.ts': ['this.selected'],
};

test('no destructive call is written on a vault- or adapter-shaped receiver (I1)', () => {
  for (const file of SOURCES) {
    const source = read(file);
    for (const match of source.matchAll(DESTRUCTIVE)) {
      const receiver = match[1];
      const shaped = receiver.split('.').filter((seg) => VAULT_SHAPED.has(seg.toLowerCase()));
      assert.deepEqual(
        shaped,
        [],
        `${relative(file)}: ${match[0]} removes through a vault or adapter. `
        + 'Removal goes through VaultPort.trashLocal, which is the vault-local trash.',
      );
    }
  }
});

test('every destructive call in shipped source is on an in-memory receiver (I1)', () => {
  let checked = 0;
  for (const file of SOURCES) {
    const rel = relative(file);
    const allowed = new Set(IN_MEMORY[rel] ?? []);
    for (const match of read(file).matchAll(DESTRUCTIVE)) {
      checked += 1;
      assert.ok(
        allowed.has(match[1]),
        `${rel}: ${match[0]} is not on the in-memory allowlist. If "${match[1]}" really is `
        + 'a Map, a Set or the DiskIndex, add it to IN_MEMORY with what it is; if it can '
        + 'reach the user\'s files, it must go through VaultPort.trashLocal instead.',
      );
    }
  }
  // A scan that stopped matching would pass every assertion above.
  assert.ok(checked >= 25, `expected the whole plugin's bookkeeping, matched ${checked} calls`);
});

test('a destructive call this guard cannot attribute is refused outright (I1)', () => {
  for (const file of SOURCES) {
    const source = read(file);
    const attributed = [...source.matchAll(DESTRUCTIVE)].length;
    const total = [...source.matchAll(DESTRUCTIVE_BARE)].length;
    assert.equal(
      total,
      attributed,
      `${relative(file)}: a destructive call is written in a shape this guard cannot `
      + 'attribute to a receiver. Put the receiver and the call on one line.',
    );
  }
});

test('the allowlist itself names only files the scan actually reads', () => {
  const scanned = new Set(SOURCES.map(relative));
  for (const rel of Object.keys(IN_MEMORY)) {
    assert.ok(scanned.has(rel), `IN_MEMORY names ${rel}, which the scan does not reach`);
  }
  for (const [rel, receivers] of Object.entries(IN_MEMORY)) {
    for (const receiver of receivers) {
      const shaped = receiver.split('.').filter((seg) => VAULT_SHAPED.has(seg.toLowerCase()));
      assert.deepEqual(shaped, [], `${rel}: "${receiver}" may never be allowlisted`);
    }
  }
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
