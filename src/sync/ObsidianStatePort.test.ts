// src/sync/ObsidianStatePort.test.ts
//
// The adapter that persists device state (§2.5) and the offline tree snapshot
// (§2.6), against a hand-rolled `DataAdapter`.
//
// This header used to open "both files are written ATOMICALLY — a `.tmp` sibling,
// then a rename over the target". They are not, and saying so is what let the
// fake below model Node's `rename` instead of Obsidian's for three phases. Only
// the FIRST write of each file is atomic, because only there is the destination
// free; every write after it stages a `.tmp` and then overwrites the live file in
// place. `ObsidianStatePort.ts`'s header carries the full reasoning, including
// why the removal call that would change this was weighed and refused.
//
// What is at stake is unchanged: a torn device-state file read back on the next
// start is indistinguishable from a corrupt one, so `DeviceState.load`
// cold-starts, and a cold start rebuilds `materialized`, `owned` and
// `declinedPaths` from nothing — the client believes it owns no node at all until
// the first reconcile finishes. A truncated tree snapshot is worse:
// `Y.applyUpdate` throws on it.
//
// So the assertions here are about the ORDER of the writes, the fallbacks when a
// step fails, and the one answer a missing file must produce: null, never an
// exception, because `DeviceState.load` treats an unreadable file as a cold start
// and a throw from here would abort boot instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import type { DataAdapter } from 'obsidian';

/**
 * `module.register()` and a lazy load, for the same two reasons as the vault
 * adapter's tests: the pinned `@types/node` does not declare `register`, and
 * `target: ES6` forbids top-level await. Neither file is this branch's to change.
 */
const register = (nodeModule as unknown as {
  register: (specifier: string, parentURL: string) => void;
}).register;

type StatePortModule = typeof import('./ObsidianStatePort.ts');

let loaded: Promise<StatePortModule> | null = null;

function statePortModule(): Promise<StatePortModule> {
  if (loaded === null) {
    register('../testing/obsidian-loader.mjs', import.meta.url);
    loaded = import('./ObsidianStatePort.ts');
  }
  return loaded;
}

// ---------------------------------------------------------------- the fake

const DIR = '.obsidian/plugins/shadowlink';

interface Call {
  op: string;
  args: readonly unknown[];
}

/**
 * The five `DataAdapter` methods this port uses, and nothing else.
 *
 * ⚠ `rename` MODELS OBSIDIAN'S, NOT NODE'S — and that is the whole reason this
 * defect shipped. The fake used to replace an existing destination, justified in
 * a comment as "what Node's `fs.rename` does on every platform the plugin runs
 * on". True of Node, and irrelevant: this port never calls Node. It calls
 * `vault.adapter`, and `FileSystemAdapter.prototype.rename` checks the
 * destination itself and throws BEFORE it reaches `fsPromises.rename`:
 *
 *     if (await this._exists(newPath, false)
 *         && (!this.insensitive || path.toLowerCase() !== newPath.toLowerCase()))
 *       throw new Error('Destination file already exists!');
 *
 * So an occupied destination is refused DETERMINISTICALLY, on every platform,
 * and the mobile adapter carries the identical check. It is not a transient
 * Windows `EPERM` and no amount of retrying will clear it. The one carve-out is
 * a rename that changes only case; `x.json.tmp` → `x.json` is never that.
 *
 * A fake that replaced the destination made every overwrite in this suite take
 * the atomic path that production has never once taken.
 */
class FakeAdapter {
  readonly calls: Call[] = [];
  readonly files = new Map<string, string>();
  readonly binaries = new Map<string, Uint8Array>();

  private readonly failures = new Map<string, Error[]>();
  private readonly always = new Map<string, Error>();

  /** Make exactly the next call of `op` throw. Queues, so it can be set twice. */
  failNext(op: string, error: Error): void {
    const queue = this.failures.get(op);
    if (queue) queue.push(error);
    else this.failures.set(op, [error]);
  }

  /** Make EVERY call of `op` throw — a failure no retry budget can outlast. */
  failAlways(op: string, error: Error): void {
    this.always.set(op, error);
  }

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  callsTo(op: string): Call[] {
    return this.calls.filter((c) => c.op === op);
  }

  async exists(path: string): Promise<boolean> {
    this.record('exists', [path]);
    return this.files.has(path) || this.binaries.has(path);
  }

  async read(path: string): Promise<string> {
    this.record('read', [path]);
    const found = this.files.get(path);
    if (found === undefined) throw new Error(`read: ENOENT: ${path}`);
    return found;
  }

  async write(path: string, data: string): Promise<void> {
    this.record('write', [path, data]);
    this.files.set(path, data);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.record('readBinary', [path]);
    const found = this.binaries.get(path);
    if (found === undefined) throw new Error(`readBinary: ENOENT: ${path}`);
    return found.buffer.slice(found.byteOffset, found.byteOffset + found.byteLength) as ArrayBuffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.record('writeBinary', [path, data.byteLength]);
    this.binaries.set(path, new Uint8Array(data.slice(0)));
  }

  async rename(from: string, to: string): Promise<void> {
    this.record('rename', [from, to]);
    // Obsidian's check, verbatim in effect. See the class comment.
    if ((this.files.has(to) || this.binaries.has(to))
      && from.toLowerCase() !== to.toLowerCase()) {
      throw new Error('Destination file already exists!');
    }
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
    } else if (this.binaries.has(from)) {
      this.binaries.set(to, this.binaries.get(from)!);
      this.binaries.delete(from);
    } else {
      throw new Error(`rename: ENOENT: ${from}`);
    }
  }

  async mkdir(path: string): Promise<void> {
    this.record('mkdir', [path]);
    this.files.set(path, '');                 // a directory, as far as `exists` cares
  }

  /**
   * Offered so the port CAN call it, and so a test can prove it does not.
   *
   * Freeing the destination and then renaming into it is the one shape that would
   * turn the in-place overwrite into something a crash cannot tear, and it is the
   * first thing a reader of this file thinks of. `ObsidianStatePort.ts`'s header
   * records why it was weighed and refused; the test below is what makes that
   * decision hold rather than merely being written down.
   */
  async remove(path: string): Promise<void> {
    this.record('remove', [path]);
    this.files.delete(path);
    this.binaries.delete(path);
  }

  private record(op: string, args: readonly unknown[]): void {
    this.calls.push({ op, args });
    const queue = this.failures.get(op);
    if (queue && queue.length > 0) throw queue.shift()!;
    const forever = this.always.get(op);
    if (forever) throw forever;
  }
}

/** A transient Windows rename failure: a scanner or backup agent holding a handle. */
function transient(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** The rename budget is exercised in several tests; nothing here should ever sleep. */
const NO_BACKOFF = { renameDelayMs: 0 } as const;

async function makePort(options: { renameDelayMs?: number; renameAttempts?: number } = NO_BACKOFF)
: Promise<{
  adapter: FakeAdapter;
  port: InstanceType<StatePortModule['ObsidianStatePort']>;
}> {
  const { ObsidianStatePort } = await statePortModule();
  const adapter = new FakeAdapter();
  const port = new ObsidianStatePort(adapter as unknown as DataAdapter, `${DIR}/`, options);
  // The directory exists in every test but the one that says otherwise.
  adapter.files.set(DIR, '');
  return { adapter, port };
}

// ---------------------------------------------------------------- reads

test('a key that was never written reads as null, and never throws', async () => {
  const { port } = await makePort();
  assert.equal(await port.read('state-ws-dev.json'), null);
  const { treeSnapshotKey } = await statePortModule();
  assert.equal(await port.readBinary(treeSnapshotKey('ws')), null);
});

// ---------------------------------------------------------------- the id

// Same rule as `deviceStateKey`, and here for the same reason: this name is built
// out of a string a human typed, and it is joined onto the plugin's own directory
// with `normalizePath`, which tidies slashes and does not resolve `..`. The
// settings tab checks the id as well, but only for ids typed since it started to.
test('an unusable workspace id never becomes a snapshot filename', async () => {
  const { treeSnapshotKey } = await statePortModule();

  assert.equal(treeSnapshotKey('ws-1'), 'tree-ws-1.bin');
  for (const bad of ['../../../elsewhere', '..', 'a/b', 'a\\b', '', 'x'.repeat(65)]) {
    assert.throws(() => treeSnapshotKey(bad), /workspace id/i,
      `${JSON.stringify(bad)} is refused`);
  }
});

// The boundary itself, independent of who derived the key. Both keys this port is
// handed are built from a charset-checked id, so nothing here should ever fire —
// that is the point of it. A boundary that holds only while its callers are
// correct is not a boundary, and this is the exact line where a name becomes a
// path.
test('a key that is not a plain filename is refused rather than joined onto the directory',
  async () => {
    const { adapter, port } = await makePort();
    adapter.calls.length = 0;

    for (const bad of ['../evil.json', 'a/b.json', 'a\\b.json', '..', '.', '']) {
      await assert.rejects(() => port.read(bad), /plain filename/, JSON.stringify(bad));
      await assert.rejects(() => port.write(bad, 'x'), /plain filename/, JSON.stringify(bad));
      await assert.rejects(() => port.readBinary(bad), /plain filename/, JSON.stringify(bad));
      await assert.rejects(() => port.writeBinary(bad, new Uint8Array([1])), /plain filename/,
        JSON.stringify(bad));
    }

    assert.deepEqual(adapter.calls, [], 'and none of it reached the adapter');
  });

test('an unreadable file is the caller’s problem, not a silent null', async () => {
  const { adapter, port } = await makePort();
  adapter.files.set(`${DIR}/state.json`, '{}');
  adapter.failNext('read', new Error('EACCES'));
  await assert.rejects(() => port.read('state.json'), /EACCES/);
});

// ---------------------------------------------------------------- writes

test('a write stages a .tmp sibling and renames it over the target', async () => {
  const { adapter, port } = await makePort();

  await port.write('state.json', '{"v":1}');

  assert.deepEqual(adapter.ops(), ['exists', 'write', 'rename'],
    'staged, then linked into place — never written over the live file');
  assert.deepEqual(adapter.callsTo('write')[0].args, [`${DIR}/state.json.tmp`, '{"v":1}']);
  assert.deepEqual(adapter.callsTo('rename')[0].args, [`${DIR}/state.json.tmp`, `${DIR}/state.json`]);
  assert.equal(adapter.files.get(`${DIR}/state.json`), '{"v":1}');
  assert.equal(adapter.files.has(`${DIR}/state.json.tmp`), false, 'the staged copy is consumed');
  assert.equal(await port.read('state.json'), '{"v":1}');
});

// RENAMED, and the old name was the bug. It read "a second write replaces the
// first, ATOMICALLY AGAIN" and passed only because the fake replaced an occupied
// destination. Obsidian's adapter refuses one, so the second write has never once
// been atomic on any machine — which is why both live vaults hold a `state-….json`
// whose mtime is 1 ms AFTER its own `.tmp`.
test('a second write cannot be atomic — Obsidian’s adapter offers no atomic overwrite', async () => {
  const { adapter, port } = await makePort();

  await port.write('state.json', 'first');
  assert.equal(adapter.files.has(`${DIR}/state.json.tmp`), false,
    'the FIRST write links the staged copy into place: an unoccupied destination is the '
    + 'one case the adapter can serve, and there it is genuinely atomic');

  adapter.calls.length = 0;
  await port.write('state.json', 'second');

  assert.equal(await port.read('state.json'), 'second');
  assert.deepEqual(
    adapter.callsTo('write').map((c) => c.args[0]),
    [`${DIR}/state.json.tmp`, `${DIR}/state.json`],
    'the staged copy is refreshed FIRST and the live file overwritten in place second — '
    + 'the order that keeps the fallback newer than the file it backs up',
  );
  assert.equal(adapter.files.get(`${DIR}/state.json.tmp`), 'second',
    'so the copy the read path falls back to is never a stale revision');
});

// THE DECISION, pinned here rather than only argued in a comment.
//
// The port could free the destination and rename into it, and `banned-calls`'
// existing exemption for this file — it writes the plugin's own two files inside
// the plugin's own directory and can name nothing of the user's — covers the
// removal call word for word. It was refused: remove-then-rename is not atomic
// either, it only trades a torn target for an absent one, and buying it costs a
// hole in three separate I1 guards, one of which asserts that an adapter-shaped
// receiver "may never be allowlisted".
//
// So the overwrite is IN PLACE, on purpose, and this is the exact call sequence
// that decision produces. A future reader who reaches for a removal to make the
// write safe will change this list, which is where they will find out.
test('the overwrite recycles no name: the port never removes the file it replaces', async () => {
  const { adapter, port } = await makePort();
  await port.write('state.json', 'first');

  adapter.calls.length = 0;
  await port.write('state.json', 'second');

  assert.deepEqual(
    adapter.ops(),
    ['exists', 'write', 'rename', 'exists', 'write'],
    'stage the copy, attempt the link, learn the destination is occupied, overwrite in place',
  );
  assert.equal(adapter.callsTo('remove').length, 0, 'and nothing is ever removed to make room');
  assert.equal(await port.read('state.json'), 'second');
});

// One attempt, then the documented in-place path. The refusal is a destination
// check inside the adapter, not a filesystem race: retrying it burns the budget
// that the transient failures below actually need.
test('an occupied destination is refused once, not retried', async () => {
  const { adapter, port } = await makePort();
  await port.write('state.json', 'first');

  adapter.calls.length = 0;
  await port.write('state.json', 'second');

  assert.equal(adapter.callsTo('rename').length, 1);
});

test('the plugin directory is created once, and only when it is missing', async () => {
  const { ObsidianStatePort } = await statePortModule();
  const adapter = new FakeAdapter();
  const port = new ObsidianStatePort(adapter as unknown as DataAdapter, DIR);

  await port.write('state.json', 'x');
  assert.deepEqual(adapter.callsTo('mkdir')[0].args, [DIR], 'created on the first write');

  adapter.calls.length = 0;
  await port.write('state.json', 'y');
  assert.deepEqual(adapter.callsTo('mkdir'), [], 'and not again');
});

test('a concurrent mkdir failure is not fatal — the write is what decides', async () => {
  const { ObsidianStatePort } = await statePortModule();
  const adapter = new FakeAdapter();
  const port = new ObsidianStatePort(adapter as unknown as DataAdapter, DIR);
  adapter.failNext('mkdir', new Error('EEXIST'));

  await port.write('state.json', 'x');
  assert.equal(await port.read('state.json'), 'x');
});

// ---------------------------------------------------------------- recovery

test('a target absent but staged is read from the .tmp copy that survived', async () => {
  const { adapter, port } = await makePort();
  // The process died between the write and the rename: a complete file that was
  // never linked into place.
  adapter.files.set(`${DIR}/state.json.tmp`, '{"v":1,"recovered":true}');

  assert.equal(await port.read('state.json'), '{"v":1,"recovered":true}');
});

test('an existing target always wins over a stale .tmp sibling', async () => {
  const { adapter, port } = await makePort();
  adapter.files.set(`${DIR}/state.json`, 'the live one');
  adapter.files.set(`${DIR}/state.json.tmp`, 'a leftover');

  assert.equal(await port.read('state.json'), 'the live one');
});

// ---------------------------------------------------------------- the rename

// REPLACES 'an adapter that refuses the rename still keeps the caller’s data',
// which asserted that a failed rename silently becomes a direct write of the LIVE
// file and called that success. It was wrong twice over. It treated "the bytes
// reached some file" as the property worth having, when the property this port
// exists for is that the live file is never the half-written one; and by swallowing
// EVERY rename error it turned a one-off transient failure — the exact `EPERM` a
// Windows scanner produces on a file it has open — into a permanent, silent
// downgrade for that write. The two tests below split those apart: a transient
// failure is a retry, an unclearable one is an exception.
test('a transient rename failure is retried, not downgraded to an in-place write', async () => {
  const { adapter, port } = await makePort();
  adapter.failNext('rename', transient('EBUSY'));

  await port.write('state.json', '{"v":1}');

  assert.equal(adapter.callsTo('rename').length, 2, 'the rename was attempted again');
  assert.deepEqual(adapter.callsTo('write').map((c) => c.args[0]), [`${DIR}/state.json.tmp`],
    'and the live file was never written directly — the whole point of staging');
  assert.equal(adapter.files.get(`${DIR}/state.json`), '{"v":1}');
  assert.equal(adapter.files.has(`${DIR}/state.json.tmp`), false, 'the staged copy is consumed');
});

test('a rename that never succeeds throws — it does not quietly write the live file', async () => {
  const { adapter, port } = await makePort();
  adapter.failAlways('rename', transient('EBUSY'));

  await assert.rejects(() => port.write('state.json', '{"v":1}'), /EBUSY/,
    'a state file that did not reach its path must be the caller’s problem: DeviceState '
    + 'only records `lastWritten` once the port RETURNS, so a throw is what makes it retry');

  assert.equal(adapter.files.has(`${DIR}/state.json`), false, 'the live file was never touched');
  assert.equal(adapter.files.get(`${DIR}/state.json.tmp`), '{"v":1}',
    'and the complete staged copy is on disk');
  assert.equal(await port.read('state.json'), '{"v":1}', 'which is exactly what the read path finds');
});

test('the rename budget is finite — a permanently stuck destination does not hang', async () => {
  const { adapter, port } = await makePort({ renameAttempts: 3, renameDelayMs: 0 });
  adapter.failAlways('rename', transient('EPERM'));

  await assert.rejects(() => port.write('state.json', 'x'), /EPERM/);
  assert.equal(adapter.callsTo('rename').length, 3, 'attempted exactly the budget, then gave up');
});

// ---------------------------------------------------------------- §2.6 binary

test('the tree snapshot round-trips through the same atomic dance', async () => {
  const { adapter, port } = await makePort();
  const { treeSnapshotKey } = await statePortModule();
  const key = treeSnapshotKey('workspace-1');
  assert.equal(key, 'tree-workspace-1.bin');

  const update = new Uint8Array([0, 1, 2, 250, 251, 255]);
  await port.writeBinary(key, update);

  assert.deepEqual(adapter.ops(), ['exists', 'writeBinary', 'rename']);
  assert.deepEqual(adapter.callsTo('writeBinary')[0].args, [`${DIR}/${key}.tmp`, 6]);

  const read = await port.readBinary(key);
  assert.ok(read !== null);
  assert.deepEqual([...read], [0, 1, 2, 250, 251, 255]);
});

test('a snapshot written from a view of a larger buffer keeps only its own bytes', async () => {
  const { port } = await makePort();
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
  const view = backing.subarray(2, 5);

  await port.writeBinary('tree.bin', view);
  const read = await port.readBinary('tree.bin');

  assert.ok(read !== null);
  assert.deepEqual([...read], [1, 2, 3], 'the neighbours in the buffer are not part of the update');
});

// Was: force a failed rename and read back whatever the fallback happened to
// leave. That tested the fallback, not the recovery. The case it MEANT to cover
// is the crash between the staged write and the rename, so stage that state
// directly — a complete snapshot that was never linked into place.
test('a snapshot recovers from its .tmp sibling too', async () => {
  const { adapter, port } = await makePort();
  adapter.binaries.set(`${DIR}/tree.bin.tmp`, new Uint8Array([7, 7]));

  const read = await port.readBinary('tree.bin');
  assert.ok(read !== null);
  assert.deepEqual([...read], [7, 7]);
});

// The binary arm has the same one atomic case and the same overwrite limitation
// as the text arm, and `tree-<workspaceId>.bin` is the file where a torn write
// hurts most: `Y.applyUpdate` throws on a truncated update, and §2.6's whole
// purpose is being able to re-merge full tree history into a server whose
// snapshot was lost.
test('a second snapshot refreshes the staged copy before overwriting the live one', async () => {
  const { adapter, port } = await makePort();

  await port.writeBinary('tree.bin', new Uint8Array([1]));
  assert.equal(adapter.binaries.has(`${DIR}/tree.bin.tmp`), false, 'the first is atomic');

  adapter.calls.length = 0;
  await port.writeBinary('tree.bin', new Uint8Array([2, 2]));

  assert.deepEqual(adapter.callsTo('writeBinary').map((c) => c.args[0]),
    [`${DIR}/tree.bin.tmp`, `${DIR}/tree.bin`], 'staged first, live file second');
  assert.deepEqual([...adapter.binaries.get(`${DIR}/tree.bin.tmp`)!], [2, 2],
    'the fallback copy tracks the newest snapshot, never an older one');
});
