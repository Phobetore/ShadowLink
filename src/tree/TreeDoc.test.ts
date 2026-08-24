import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { LOCAL_ORIGIN, TreeDoc } from './TreeDoc.ts';
import { NODE_ID_RE } from './ids.ts';
import { isLive, relPath } from './paths.ts';
import type { TreeMeta } from './types.ts';

// ---------------------------------------------------------------- nodes

test('createNode returns a 22-char id and the node round-trips with g=1 and the supplied c', () => {
  const td = new TreeDoc();
  const id = td.createNode({ k: 'f', d: 'Notes', n: 'weekly.md', s: 1 }, 1_700_000_000_000);

  assert.match(id, NODE_ID_RE);
  assert.equal(td.size(), 1);
  assert.deepEqual(td.get(id), {
    k: 'f', d: 'Notes', n: 'weekly.md', s: 1, g: 1, c: 1_700_000_000_000,
  });
  assert.deepEqual(td.entries(), [[id, td.get(id)]]);
  assert.equal(td.get('nosuchnode'), null);
});

test('createNode writes every field in ONE transaction', () => {
  const td = new TreeDoc();
  let fires = 0;
  td.observe(() => { fires += 1; });
  td.createNode({ k: 'f', d: '', n: 'a.md', s: 1 }, 7);
  assert.equal(fires, 1);
});

test('patchNode changes only the patched keys and no-ops on an absent node', () => {
  const td = new TreeDoc();
  const id = td.createNode({ k: 'f', d: 'Projects', n: 'note.md', s: 1 }, 42);

  td.patchNode(id, { n: 'renamed.md' });
  assert.deepEqual(td.get(id), {
    k: 'f', d: 'Projects', n: 'renamed.md', s: 1, g: 1, c: 42,
  });

  td.patchNode('Zz'.repeat(11), { n: 'ghost.md' });
  assert.equal(td.size(), 1);
});

test('patching a field to undefined deletes the key, so a cleared x reads as live', () => {
  const td = new TreeDoc();
  const id = td.createNode({ k: 'f', d: 'Archive', n: 'a.md', s: 1 }, 0);

  td.patchNode(id, { x: 1, xa: 5, xb: 'Ada', xp: 'Archive' });
  assert.equal(isLive(td.get(id)!), false);

  td.patchNode(id, { x: undefined, xp: undefined });
  const f = td.get(id)!;
  assert.ok(!('x' in f), 'x must be absent, not undefined');
  assert.ok(!('xp' in f), 'xp must be absent, not undefined');
  assert.equal(f.xa, 5);
  assert.equal(f.xb, 'Ada');
  assert.equal(isLive(f), true);
});

test('transactLocal groups several mutations into one local transaction', () => {
  const td = new TreeDoc();
  const id = td.createNode({ k: 'f', d: '', n: 'a.md' }, 0);
  const seen: boolean[] = [];
  td.observe((isLocal) => { seen.push(isLocal); });

  td.transactLocal(() => {
    td.patchNode(id, { d: 'Notes' });
    td.patchNode(id, { s: 1 });
    td.createNode({ k: 'd', d: '', n: 'Notes' }, 0);
  });

  assert.deepEqual(seen, [true]);
  assert.equal(td.size(), 2);
});

// ---------------------------------------------------------------- observe

test('observe fires for local writes and for applied remote updates (I9)', () => {
  const a = new TreeDoc();
  const seen: boolean[] = [];
  a.observe((isLocal) => { seen.push(isLocal); });

  const id = a.createNode({ k: 'f', d: '', n: 'a.md', s: 1 }, 0);
  a.patchNode(id, { n: 'b.md' });
  assert.deepEqual(seen, [true, true]);

  const b = new TreeDoc();
  b.createNode({ k: 'f', d: '', n: 'remote.md', s: 1 }, 0);
  a.applyUpdate(b.encodeState());

  assert.deepEqual(seen, [true, true, false]);
  assert.equal(a.size(), 2);
});

test('the unsubscribe returned by observe stops further callbacks', () => {
  const td = new TreeDoc();
  let fires = 0;
  const off = td.observe(() => { fires += 1; });

  const id = td.createNode({ k: 'f', d: '', n: 'a.md' }, 0);
  assert.equal(fires, 1);

  off();
  td.patchNode(id, { n: 'b.md' });
  td.createNode({ k: 'd', d: '', n: 'Notes' }, 0);
  assert.equal(fires, 1);
});

// ---------------------------------------------------------------- convergence

// The assigned hard case in miniature (spec §1.3): rename and move are disjoint
// Y.Map keys, so both land and neither client loses the other's intent.
test('per-key LWW: A renames while B moves the same node offline, and both changes survive', () => {
  const a = new TreeDoc();
  const id = a.createNode({ k: 'f', d: 'Projects', n: 'note.md', s: 1 }, 0);

  const b = new TreeDoc();
  b.applyUpdate(a.encodeState());
  assert.deepEqual(b.get(id), a.get(id));

  // Offline, concurrent.
  a.patchNode(id, { n: 'renamed.md' });
  b.patchNode(id, { d: 'Archive' });

  const fromA = a.encodeState();
  const fromB = b.encodeState();
  a.applyUpdate(fromB);
  b.applyUpdate(fromA);

  assert.deepEqual(a.get(id), b.get(id));
  assert.equal(relPath(a.get(id)!), 'Archive/renamed.md');
});

// ---------------------------------------------------------------- meta

test('initMeta sets v:1 once, never clobbers existing meta, and isFutureSchema flags v:2', () => {
  const td = new TreeDoc();
  assert.equal(td.getMeta(), null);
  assert.equal(td.isFutureSchema(), false);

  td.initMeta();
  assert.deepEqual(td.getMeta(), { v: 1 });
  assert.equal(td.isFutureSchema(), false);

  td.doc.getMap('meta').set('claim', { by: 'device-1', at: 99 });
  td.initMeta();
  assert.deepEqual(td.getMeta(), { v: 1, claim: { by: 'device-1', at: 99 } });

  const future = new TreeDoc();
  future.doc.getMap('meta').set('v', 2);
  future.initMeta();
  assert.equal((future.getMeta() as TreeMeta).v, 2);
  assert.equal(future.isFutureSchema(), true);
});

test('a meta change fires observe', () => {
  const td = new TreeDoc();
  const seen: boolean[] = [];
  td.observe((isLocal) => { seen.push(isLocal); });
  td.initMeta();
  assert.deepEqual(seen, [true]);
});

// ---------------------------------------------------------------- state

test('encodeState / applyUpdate round-trip a populated tree into a fresh TreeDoc', () => {
  const a = new TreeDoc();
  a.initMeta();
  const ids: string[] = [];
  a.transactLocal(() => {
    ids.push(a.createNode({ k: 'd', d: '', n: 'Notes' }, 1));
    ids.push(a.createNode({ k: 'f', d: 'Notes', n: 'a.md', s: 1 }, 2));
    ids.push(a.createNode({ k: 'f', d: 'Notes', n: 'b.md', s: 1, x: 1, xa: 3, xb: 'Ada' }, 3));
  });

  const b = new TreeDoc();
  b.applyUpdate(a.encodeState());

  assert.equal(b.size(), 3);
  assert.deepEqual(b.getMeta(), { v: 1 });
  for (const id of ids) assert.deepEqual(b.get(id), a.get(id));
  assert.deepEqual(
    b.entries().sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    a.entries().sort((x, y) => (x[0] < y[0] ? -1 : 1)),
  );
});

test('TreeDoc adopts an existing Y.Doc and tags its own writes with LOCAL_ORIGIN', () => {
  const doc = new Y.Doc();
  const td = new TreeDoc(doc);
  assert.equal(td.doc, doc);

  const origins: unknown[] = [];
  doc.on('afterTransaction', (txn: Y.Transaction) => { origins.push(txn.origin); });
  td.createNode({ k: 'f', d: '', n: 'a.md' }, 0);

  assert.deepEqual(origins, [LOCAL_ORIGIN]);
});
