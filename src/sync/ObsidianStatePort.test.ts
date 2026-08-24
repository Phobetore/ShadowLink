// src/sync/ObsidianStatePort.test.ts
//
// The adapter that persists device state (§2.5) and the offline tree snapshot
// (§2.6), against a hand-rolled `DataAdapter`.
//
// Both files are written ATOMICALLY — a `.tmp` sibling, then a rename over the
// target — and the reason is not tidiness. A torn device-state file read back on
// the next start is indistinguishable from a corrupt one, so `DeviceState.load`
// cold-starts; a cold start on every launch is a permanent silent degradation, in
// which `materialized`, `owned` and `declinedPaths` are rebuilt from nothing and
// the client believes it owns no node at all until the first reconcile finishes.
// A truncated tree snapshot is worse: `Y.applyUpdate` throws on it.
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
 * `rename` REPLACES an existing destination, as Node's does on every platform the
 * plugin runs on — that replacement is what makes the swap atomic, so a fake that
 * refused it would be testing a filesystem nobody has.
 */
class FakeAdapter {
  readonly calls: Call[] = [];
  readonly files = new Map<string, string>();
  readonly binaries = new Map<string, Uint8Array>();

  private readonly failures = new Map<string, Error[]>();

  /** Make exactly the next call of `op` throw. Queues, so it can be set twice. */
  failNext(op: string, error: Error): void {
    const queue = this.failures.get(op);
    if (queue) queue.push(error);
    else this.failures.set(op, [error]);
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

  private record(op: string, args: readonly unknown[]): void {
    this.calls.push({ op, args });
    const queue = this.failures.get(op);
    if (!queue || queue.length === 0) return;
    throw queue.shift()!;
  }
}

async function makePort(): Promise<{
  adapter: FakeAdapter;
  port: InstanceType<StatePortModule['ObsidianStatePort']>;
}> {
  const { ObsidianStatePort } = await statePortModule();
  const adapter = new FakeAdapter();
  const port = new ObsidianStatePort(adapter as unknown as DataAdapter, `${DIR}/`);
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

test('a second write replaces the first, atomically again', async () => {
  const { adapter, port } = await makePort();
  await port.write('state.json', 'first');
  await port.write('state.json', 'second');

  assert.equal(await port.read('state.json'), 'second');
  assert.equal(adapter.callsTo('rename').length, 2);
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

test('an adapter that refuses the rename still keeps the caller’s data', async () => {
  const { adapter, port } = await makePort();
  adapter.failNext('rename', new Error('EPERM'));

  await port.write('state.json', 'kept anyway');

  assert.equal(adapter.files.get(`${DIR}/state.json`), 'kept anyway', 'written directly instead');
  assert.equal(adapter.files.get(`${DIR}/state.json.tmp`), 'kept anyway',
    'and the complete staged copy is still on disk for the read path');
  assert.equal(await port.read('state.json'), 'kept anyway');
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

test('a snapshot recovers from its .tmp sibling too', async () => {
  const { adapter, port } = await makePort();
  adapter.failNext('rename', new Error('EPERM'));
  await port.writeBinary('tree.bin', new Uint8Array([7, 7]));

  const read = await port.readBinary('tree.bin');
  assert.ok(read !== null);
  assert.deepEqual([...read], [7, 7]);
});
