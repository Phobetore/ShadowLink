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

// `NODE_FIELD_KEYS` is an ALLOWLIST: a field missing from it is never written and
// is stripped on read, so a `b` left out of the list would leave every peer with a
// `'b'` node carrying no bytes reference — silently, with nothing else failing.
// Asserted through a real replica, because a projection can be right locally while
// the CRDT holds nothing.
test('a binary node carries its blob reference through the field allowlist and across a sync', () => {
  const ref = `${'a'.repeat(64)}:2048:-`;
  const a = new TreeDoc();
  const id = a.createNode({ k: 'b', d: 'Notes/img', n: 'diagram.png', s: 1, b: ref }, 5);

  assert.deepEqual(a.get(id), {
    k: 'b', d: 'Notes/img', n: 'diagram.png', s: 1, b: ref, g: 1, c: 5,
  });
  assert.equal((a.doc.getMap('nodes').get(id) as Y.Map<unknown>).get('b'), ref);

  const b = new TreeDoc();
  b.applyUpdate(a.encodeState());
  assert.equal(b.get(id)?.b, ref, 'the reference must reach a peer, not just the local projection');

  // A replace rewrites the same register, and the new value must replicate too.
  const next = `${'b'.repeat(64)}:4096:${'a'.repeat(64)}`;
  a.patchNode(id, { b: next, s: 1 });
  b.applyUpdate(a.encodeState());
  assert.equal(b.get(id)?.b, next);
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

test('initMeta sets v:2 once, never clobbers existing meta, and isFutureSchema flags v:3', () => {
  const td = new TreeDoc();
  assert.equal(td.getMeta(), null);
  assert.equal(td.isFutureSchema(), false);

  td.initMeta();
  assert.deepEqual(td.getMeta(), { v: 2 });
  assert.equal(td.isFutureSchema(), false);

  td.doc.getMap('meta').set('claim', { by: 'device-1', at: 99 });
  td.initMeta();
  assert.deepEqual(td.getMeta(), { v: 2, claim: { by: 'device-1', at: 99 } });

  const future = new TreeDoc();
  future.doc.getMap('meta').set('v', 3);
  future.initMeta();
  assert.equal((future.getMeta() as TreeMeta).v, 3);
  assert.equal(future.isFutureSchema(), true);
});

// Spec §2.5. A P1 client reads `validateRel` as TRUE for an unrecognized kind, so
// it would treat a `'b'` node as valid, derive no path for it, and then sweep an
// attachment-only folder as unclaimed and empty. The version bump is what makes
// such a client report `isFutureSchema()` and go read-only instead.
test('a v:1 tree is not a future schema for this client, and v:2 is what it writes', () => {
  const old = new TreeDoc();
  old.doc.getMap('meta').set('v', 1);
  assert.equal(old.isFutureSchema(), false, 'a P1 tree is still readable');
  assert.equal((old.getMeta() as TreeMeta).v, 1, 'initMeta does not clobber it');
});

test('raiseMeta raises the recorded version and never lowers it', () => {
  const td = new TreeDoc();
  td.doc.getMap('meta').set('v', 1);

  td.raiseMeta(2);
  assert.equal((td.getMeta() as TreeMeta).v, 2);

  // A tree already stamped by a newer client must not be dragged backwards: that
  // would flip every peer out of read-only and let them act on a schema they do
  // not speak.
  const ahead = new TreeDoc();
  ahead.doc.getMap('meta').set('v', 7);
  ahead.raiseMeta(2);
  assert.equal((ahead.getMeta() as TreeMeta).v, 7);
});

test('raiseMeta on an unstamped tree records the version, and re-raising writes nothing', () => {
  const td = new TreeDoc();
  const seen: boolean[] = [];
  td.observe((isLocal) => { seen.push(isLocal); });

  td.raiseMeta(2);
  assert.deepEqual(td.getMeta(), { v: 2 });
  assert.deepEqual(seen, [true]);

  // Idempotent: Bootstrap calls this after every proven sync, and a write per
  // reconnect would be a tree update — and a peer-wide reconcile — for nothing.
  td.raiseMeta(2);
  assert.deepEqual(seen, [true], 'raising to the version already recorded is a no-op');
});

// A client may only stamp a version it can itself read; writing a higher one
// would make it read-only against a document only it has ever written.
test('raiseMeta refuses a version this client does not speak', () => {
  const td = new TreeDoc();
  td.initMeta();
  td.raiseMeta(99);
  assert.deepEqual(td.getMeta(), { v: 2 });
  assert.equal(td.isFutureSchema(), false);
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
  assert.deepEqual(b.getMeta(), { v: 2 });
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

// ── Regressions found in review of this slice ────────────────────────────────

// The public projection filters undefined, so asserting through get() cannot tell
// "key deleted" from "key set to undefined". A stored undefined would replicate as
// a real CRDT key and, once tombstone clearing matters (resurrect), a peer could
// read a node as still-deleted. Assert on the raw Y.Map.
test('patching a field to undefined deletes the CRDT key, not just the projection', () => {
  const a = new TreeDoc();
  const id = a.createNode({ k: 'f', d: 'Archive', n: 'k.md', x: 1, xp: 'Archive' }, 1000);
  a.patchNode(id, { x: undefined, xp: undefined });

  const rawLocal = a.doc.getMap('nodes').get(id) as Y.Map<unknown>;
  assert.equal(rawLocal.has('x'), false, 'x must be deleted locally');
  assert.equal(rawLocal.has('xp'), false, 'xp must be deleted locally');

  // and it must replicate as a deletion, not as a key holding undefined
  const b = new TreeDoc();
  b.applyUpdate(a.encodeState());
  const rawRemote = b.doc.getMap('nodes').get(id) as Y.Map<unknown>;
  assert.equal(rawRemote.has('x'), false, 'x must be absent on the remote replica');
  assert.equal(rawRemote.has('xp'), false, 'xp must be absent on the remote replica');
  assert.equal(isLive(b.get(id)!), true);
});

// I9: handlers always run. One failing consumer must not silence structural sync.
test('a throwing observe subscriber does not starve the others', () => {
  const td = new TreeDoc();
  const errors: unknown[] = [];
  td.onSubscriberError = (e) => errors.push(e);

  const seen: string[] = [];
  td.observe(() => { seen.push('first'); throw new Error('boom'); });
  td.observe(() => { seen.push('second'); });

  td.createNode({ k: 'f', d: '', n: 'a.md' }, 1);
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(errors.length, 1);

  // and a remote update must not have the exception escape into Yjs
  const other = new TreeDoc();
  other.createNode({ k: 'f', d: '', n: 'b.md' }, 2);
  assert.doesNotThrow(() => td.applyUpdate(other.encodeState()));
});
