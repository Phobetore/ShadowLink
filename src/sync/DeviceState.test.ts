// src/sync/DeviceState.test.ts
//
// The discard tests are the important ones. `.obsidian/` is replicated wholesale
// by Obsidian Sync and by every git-based vault sync, so another machine's state
// file routinely lands in this machine's plugin directory. Applying one machine's
// `materialized` path map on another drives mass file relocation, and applying its
// `declinedNodes` silently disables deletes. A cold start is always recoverable
// (spec §4.5); an inherited path map is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceState, deviceStateKey } from './DeviceState.ts';
import type { DeviceStateData, StatePort } from './DeviceState.ts';
import { REMOTE_DELETE_BUDGET, REMOTE_DELETE_WINDOW_MS } from '../tree/constants.ts';

/**
 * The debounce tests use a short injected window and real timers rather than
 * `node:test`'s timer mocks: this repo pins @types/node 16, which predates that
 * API, and every test file here is type-checked.
 */
const DEBOUNCE = 5;
const delay = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

const DEVICE = 'aabbccdd11223344';
const WORKSPACE = 'ws-1';

class MemoryStatePort implements StatePort {
  readonly store = new Map<string, string>();
  writes = 0;
  reads = 0;
  failRead: Error | null = null;

  async read(key: string): Promise<string | null> {
    this.reads++;
    if (this.failRead) throw this.failRead;
    return this.store.get(key) ?? null;
  }

  async write(key: string, data: string): Promise<void> {
    this.writes++;
    this.store.set(key, data);
  }
}

/** A well-formed state file for some other device. */
function foreignFile(over: Partial<DeviceStateData> = {}): string {
  return JSON.stringify({
    v: 1,
    deviceId: 'ffffffffffffffff',
    workspaceId: WORKSPACE,
    materialized: { nodeA: 'Work/Team/a.md', nodeB: 'Work/Team/b.md' },
    owned: { nodeA: true },
    publish: { nodeA: { state: 'pending', attempts: 2, nextAt: 500 } },
    contentHash: { nodeA: { sha256: 'deadbeef', len: 12 } },
    declinedNodes: ['nodeZ'],
    declinedPaths: ['work/team/z.md'],
    deleteBudget: [{ at: 1 }, { at: 2 }],
    staging: { nodeA: { from: 'x', to: 'y', at: 3 } },
    ...over,
  });
}

function assertEmpty(data: DeviceStateData): void {
  assert.deepEqual(data.materialized, {});
  assert.deepEqual(data.owned, {});
  assert.deepEqual(data.publish, {});
  assert.deepEqual(data.contentHash, {});
  assert.deepEqual(data.declinedNodes, []);
  assert.deepEqual(data.declinedPaths, []);
  assert.deepEqual(data.deleteBudget, []);
  assert.deepEqual(data.staging, {});
  assert.deepEqual(data.fetchDeferred, {});
  assert.deepEqual(data.fetchApproved, {});
  assert.deepEqual(data.oversized, {});
}

// ---------------------------------------------------------------- round trip

test('state round-trips through the port', async () => {
  const port = new MemoryStatePort();
  const a = new DeviceState(port, DEVICE, WORKSPACE);
  assert.deepEqual(await a.load(), { coldStart: true }, 'nothing persisted yet');

  a.data.materialized['n1'] = 'Shared/a.md';
  a.data.owned['n1'] = true;
  a.data.publish['n1'] = { state: 'pending', attempts: 1, nextAt: 42 };
  a.data.contentHash['n1'] = { sha256: 'abc', len: 3 };
  a.data.declinedNodes.push('n2');
  a.data.declinedPaths.push('shared/b.md');
  a.data.staging['n3'] = { from: 'Shared/c.md', to: 'Shared/d.md', at: 7 };
  await a.flush();

  const b = new DeviceState(port, DEVICE, WORKSPACE);
  assert.deepEqual(await b.load(), { coldStart: false });
  assert.deepEqual(b.data, a.data);
  assert.notEqual(b.data, a.data, 'the loaded state is a fresh object, not a shared reference');
});

test('the storage key is namespaced by workspace and device', () => {
  assert.equal(deviceStateKey(WORKSPACE, DEVICE), `state-${WORKSPACE}-${DEVICE}.json`);
  const port = new MemoryStatePort();
  assert.equal(new DeviceState(port, DEVICE, WORKSPACE).key, `state-${WORKSPACE}-${DEVICE}.json`);
});

// ---------------------------------------------------------------- discard

test('a state file written by a different device is discarded entirely', async () => {
  const port = new MemoryStatePort();
  port.store.set(deviceStateKey(WORKSPACE, DEVICE), foreignFile());

  const s = new DeviceState(port, DEVICE, WORKSPACE);
  assert.deepEqual(await s.load(), { coldStart: true });

  // Not "merged", not "partially trusted" — gone. A 300-entry path map from
  // another machine would otherwise be replayed as 300 renames.
  assertEmpty(s.data);
  assert.equal(s.data.deviceId, DEVICE);
  assert.equal(s.data.workspaceId, WORKSPACE);
});

test('a state file from a different workspace is discarded entirely', async () => {
  const port = new MemoryStatePort();
  port.store.set(
    deviceStateKey(WORKSPACE, DEVICE),
    foreignFile({ deviceId: DEVICE, workspaceId: 'ws-other' }),
  );

  const s = new DeviceState(port, DEVICE, WORKSPACE);
  assert.deepEqual(await s.load(), { coldStart: true });
  assertEmpty(s.data);
});

test('load never writes, so a cold start cannot clobber the file it refused', async () => {
  const port = new MemoryStatePort();
  port.store.set(deviceStateKey(WORKSPACE, DEVICE), foreignFile());

  await new DeviceState(port, DEVICE, WORKSPACE).load();
  assert.equal(port.writes, 0);
  assert.equal(port.store.get(deviceStateKey(WORKSPACE, DEVICE)), foreignFile());
});

// ---------------------------------------------------------------- bad input

test('corrupt JSON cold-starts rather than throwing', async () => {
  const port = new MemoryStatePort();
  port.store.set(deviceStateKey(WORKSPACE, DEVICE), '{"v":1,"deviceId":');

  const s = new DeviceState(port, DEVICE, WORKSPACE);
  assert.deepEqual(await s.load(), { coldStart: true });
  assertEmpty(s.data);
});

test('a missing key cold-starts rather than throwing', async () => {
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE);
  assert.deepEqual(await s.load(), { coldStart: true });
  assertEmpty(s.data);
});

test('a read failure cold-starts rather than throwing', async () => {
  const port = new MemoryStatePort();
  port.failRead = new Error('EIO');
  const s = new DeviceState(port, DEVICE, WORKSPACE);
  assert.deepEqual(await s.load(), { coldStart: true });
  assertEmpty(s.data);
});

test('non-object and future-schema payloads cold-start', async () => {
  const key = deviceStateKey(WORKSPACE, DEVICE);
  for (const payload of [
    'null',
    '42',
    '"a string"',
    '[]',
    JSON.stringify({ deviceId: DEVICE, workspaceId: WORKSPACE }),                 // no v
    JSON.stringify({ v: 2, deviceId: DEVICE, workspaceId: WORKSPACE }),           // future v
  ]) {
    const port = new MemoryStatePort();
    port.store.set(key, payload);
    const s = new DeviceState(port, DEVICE, WORKSPACE);
    assert.deepEqual(await s.load(), { coldStart: true }, `payload ${payload}`);
    assertEmpty(s.data);
  }
});

test('a truncated but own-device file loads with its missing maps defaulted', async () => {
  const port = new MemoryStatePort();
  port.store.set(deviceStateKey(WORKSPACE, DEVICE), JSON.stringify({
    v: 1,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    materialized: { n1: 'Shared/a.md' },
    declinedNodes: 'not an array',
    deleteBudget: [{ at: 5 }, 'junk', { at: 'no' }],
  }));

  const s = new DeviceState(port, DEVICE, WORKSPACE);
  assert.deepEqual(await s.load(), { coldStart: false });
  // The file is plain JSON in a user-visible directory. A hand edit must not
  // leave `undefined` where the reconciler expects a map.
  assert.deepEqual(s.data.materialized, { n1: 'Shared/a.md' });
  assert.deepEqual(s.data.declinedNodes, []);
  assert.deepEqual(s.data.owned, {});
  assert.deepEqual(s.data.deleteBudget, [{ at: 5 }], 'malformed budget entries are dropped');
});

// ---------------------------------------------------------------- persistence

test('schedulePersist debounces and flush writes immediately', async () => {
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE, () => 0, DEBOUNCE);
  await s.load();

  s.data.materialized['n1'] = 'Shared/a.md';
  s.schedulePersist();
  s.schedulePersist();
  assert.equal(port.writes, 0, 'nothing written inside the debounce window');

  await delay(DEBOUNCE * 8);
  assert.equal(port.writes, 1, 'two schedules collapse into one write');
  assert.match(port.store.get(s.key)!, /Shared\/a\.md/);

  await s.flush();
  assert.equal(port.writes, 2, 'flush writes immediately');
});

test('flush cancels a pending debounce instead of writing twice', async () => {
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE, () => 0, DEBOUNCE);
  await s.load();

  s.schedulePersist();
  await s.flush();
  assert.equal(port.writes, 1);

  await delay(DEBOUNCE * 8);
  assert.equal(port.writes, 1, 'the cancelled timer never fires');
});

test('a debounced write failure is captured rather than thrown into the event loop', async () => {
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE, () => 0, DEBOUNCE);
  await s.load();

  port.write = async () => { throw new Error('ENOSPC'); };
  s.schedulePersist();
  await delay(DEBOUNCE * 8);

  // Invariant I15: persistence runs in a finally and must never take down a pass.
  assert.match(String((s.lastPersistError as Error)?.message), /ENOSPC/);
});

// A converged share reconciles on every remote change, and every pass rebuilds
// the same maps out of the same evidence. `flush` would serialize the whole state
// object and write it again each time — on a share with a thousand attachments,
// megabytes every couple of seconds, on a phone, for a file that did not move.
test('flushIfChanged writes once and then skips a state that has not moved', async () => {
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE, () => 0, DEBOUNCE);
  await s.load();

  s.data.materialized['n1'] = 'Shared/a.md';
  assert.equal(await s.flushIfChanged(), true, 'the first write canonicalizes the file');
  assert.equal(port.writes, 1);

  assert.equal(await s.flushIfChanged(), false, 'nothing moved, so nothing is written');
  assert.equal(await s.flushIfChanged(), false);
  assert.equal(port.writes, 1);

  s.data.materialized['n2'] = 'Shared/b.md';
  assert.equal(await s.flushIfChanged(), true);
  assert.equal(port.writes, 2);
  assert.match(port.store.get(s.key)!, /Shared\/b\.md/);
});

// I2, applied to persistence: a write that THREW did not reach the disk, so the
// next call must not skip it on the strength of having tried.
test('flushIfChanged retries after a write that failed', async () => {
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE, () => 0, DEBOUNCE);
  await s.load();
  s.data.materialized['n1'] = 'Shared/a.md';

  const original = port.write.bind(port);
  port.write = async () => { throw new Error('ENOSPC'); };
  await assert.rejects(() => s.flushIfChanged(), /ENOSPC/);

  port.write = original;
  assert.equal(await s.flushIfChanged(), true, 'the same bytes are still owed to the disk');
  assert.match(port.store.get(s.key)!, /Shared\/a\.md/);
});

// A debounce armed by a change that has since been undone would only rewrite the
// bytes already on disk.
test('flushIfChanged cancels a pending debounce it has nothing to add to', async () => {
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE, () => 0, DEBOUNCE);
  await s.load();

  s.data.owned['n1'] = true;
  await s.flush();
  assert.equal(port.writes, 1);

  s.schedulePersist();
  assert.equal(await s.flushIfChanged(), false);
  await delay(DEBOUNCE * 8);
  assert.equal(port.writes, 1, 'the cancelled timer never fires');
});

test('a failed write does not wedge later writes', async () => {
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE);
  await s.load();

  const original = port.write.bind(port);
  port.write = async () => { throw new Error('ENOSPC'); };
  await assert.rejects(() => s.flush(), /ENOSPC/);

  port.write = original;
  s.data.materialized['n1'] = 'Shared/a.md';
  await s.flush();
  assert.match(port.store.get(s.key)!, /Shared\/a\.md/);
});

// ---------------------------------------------------------------- delete rate window

test('the delete budget is exhausted at the cap and recovers after the window', async () => {
  let t = 1_000_000;
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE, () => t);
  await s.load();

  assert.equal(s.deleteBudgetExhausted(), false);
  for (let i = 0; i < REMOTE_DELETE_BUDGET - 1; i++) s.recordDeletion();
  assert.equal(s.deletionsInWindow(), REMOTE_DELETE_BUDGET - 1);
  assert.equal(s.deleteBudgetExhausted(), false, 'one under the cap is still allowed');

  s.recordDeletion();
  assert.equal(s.deletionsInWindow(), REMOTE_DELETE_BUDGET);
  assert.equal(s.deleteBudgetExhausted(), true);

  // The budget is persisted precisely so a restart cannot reset it — both
  // obsidian-livesync mass-deletion incidents would have been contained by this.
  await s.flush();
  const restarted = new DeviceState(port, DEVICE, WORKSPACE, () => t);
  assert.deepEqual(await restarted.load(), { coldStart: false });
  assert.equal(restarted.deleteBudgetExhausted(), true, 'the budget survives a restart');

  t += REMOTE_DELETE_WINDOW_MS;
  assert.equal(restarted.deletionsInWindow(), 0, 'the window has rolled past every entry');
  assert.equal(restarted.deleteBudgetExhausted(), false);
  assert.deepEqual(restarted.data.deleteBudget, [], 'stale entries are pruned, not accumulated');
});

test('the window is a sliding one, not a fixed bucket', async () => {
  let t = 0;
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE, () => t);
  await s.load();

  for (let i = 0; i < REMOTE_DELETE_BUDGET; i++) {
    s.recordDeletion();
    t += 1;
  }
  assert.equal(s.deleteBudgetExhausted(), true);

  // Roll forward far enough to expire all but the last two entries.
  t = REMOTE_DELETE_WINDOW_MS + REMOTE_DELETE_BUDGET - 3;
  assert.equal(s.deletionsInWindow(), 2);
  assert.equal(s.deleteBudgetExhausted(), false);
});

test('recordDeletion and the window accept an explicit timestamp', async () => {
  const port = new MemoryStatePort();
  const s = new DeviceState(port, DEVICE, WORKSPACE, () => 0);
  await s.load();

  s.recordDeletion(5_000);
  s.recordDeletion(6_000);
  assert.equal(s.deletionsInWindow(6_000), 2);
  assert.equal(s.deletionsInWindow(6_000 + REMOTE_DELETE_WINDOW_MS), 0);
});

// ---------------------------------------------------------------- P2 §8.4 fields

// Spec test A12. A persisted map that `normalize` does not know about is silently
// discarded on every reload — which for `contentHash.mtime` means re-hashing the
// whole share on every restart, and for `oversized` means re-showing every Notice
// the user already dismissed.
test('the attachment maps round-trip through the port', async () => {
  const sha = 'a'.repeat(64);
  const port = new MemoryStatePort();
  const a = new DeviceState(port, DEVICE, WORKSPACE);
  await a.load();

  a.data.contentHash['n1'] = { sha256: sha, len: 12, mtime: 1_700_000_000_000 };
  a.data.publish['n1'] = { state: 'pending', attempts: 1, nextAt: 42, intent: sha };
  a.data.fetchDeferred['n2'] = { sha256: sha, bytes: 4096 };
  a.data.fetchApproved['n2'] = true;
  a.data.oversized['shared/huge.mov'] = { bytes: 900, cap: 100, why: 'server' };
  await a.flush();

  const b = new DeviceState(port, DEVICE, WORKSPACE);
  assert.deepEqual(await b.load(), { coldStart: false });
  assert.deepEqual(b.data, a.data);
  assert.deepEqual(b.data.contentHash['n1'], { sha256: sha, len: 12, mtime: 1_700_000_000_000 });
  assert.equal(b.data.publish['n1'].intent, sha);
  assert.deepEqual(b.data.fetchDeferred['n2'], { sha256: sha, bytes: 4096 });
  assert.deepEqual(b.data.oversized['shared/huge.mov'], { bytes: 900, cap: 100, why: 'server' });
});

test('malformed attachment entries are dropped field by field', async () => {
  const sha = 'a'.repeat(64);
  const port = new MemoryStatePort();
  port.store.set(deviceStateKey(WORKSPACE, DEVICE), JSON.stringify({
    v: 1,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    contentHash: {
      good: { sha256: sha, len: 1, mtime: 5 },
      noMtime: { sha256: sha, len: 1 },
      badMtime: { sha256: sha, len: 1, mtime: 'yesterday' },
    },
    publish: {
      good: { state: 'pending', attempts: 0, nextAt: 0, intent: sha },
      badIntent: { state: 'pending', attempts: 0, nextAt: 0, intent: 7 },
    },
    fetchDeferred: {
      good: { sha256: sha, bytes: 10 },
      shortSha: { sha256: 'abc', bytes: 10 },
      upperSha: { sha256: 'A'.repeat(64), bytes: 10 },
      badBytes: { sha256: sha, bytes: 'lots' },
      notAnObject: 'nope',
    },
    fetchApproved: { good: true, notTrue: 'yes' },
    oversized: {
      good: { bytes: 9, cap: 1, why: 'device' },
      bogusWhy: { bytes: 9, cap: 1, why: 'because' },
      badNumbers: { bytes: '9', cap: 1, why: 'server' },
    },
  }));

  const s = new DeviceState(port, DEVICE, WORKSPACE);
  assert.deepEqual(await s.load(), { coldStart: false });

  assert.deepEqual(Object.keys(s.data.fetchDeferred), ['good'], 'a bad sha or size is dropped');
  assert.deepEqual(Object.keys(s.data.fetchApproved), ['good']);
  assert.deepEqual(Object.keys(s.data.oversized), ['good']);
  // A bad mtime costs the mtime, not the recorded hash: the entry still answers
  // "what did this device last confirm", it just cannot use the cheap cache branch.
  assert.deepEqual(s.data.contentHash.badMtime, { sha256: sha, len: 1 });
  assert.deepEqual(s.data.contentHash.good, { sha256: sha, len: 1, mtime: 5 });
  assert.equal('mtime' in s.data.contentHash.noMtime, false);
  assert.equal(s.data.publish.good.intent, sha);
  assert.equal('intent' in s.data.publish.badIntent, false, 'a bad intent costs the intent only');
});
