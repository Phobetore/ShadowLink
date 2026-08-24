import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { DocHub } from '../DocHub.js';

const MESSAGE_SYNC = 0;

function tempDir() {
  const dir = join(tmpdir(), `sl-dochub-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

class FakeConn extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.sent = [];
  }
  send(data) { this.sent.push(Uint8Array.from(data)); }
  close() { this.readyState = 3; this.emit('close'); }
}

// Build a MESSAGE_SYNC + update frame carrying the full state of `doc`.
function syncUpdateFrame(doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return Buffer.from(encoding.toUint8Array(enc));
}

// Apply every MESSAGE_SYNC frame a conn received into `target`.
function applySyncFrames(conn, target) {
  for (const frame of conn.sent) {
    const dec = decoding.createDecoder(frame);
    if (decoding.readVarUint(dec) === MESSAGE_SYNC) {
      syncProtocol.readSyncMessage(dec, encoding.createEncoder(), target, 'test');
    }
  }
}

test('first message to a new connection is sync step 1', () => {
  const dir = tempDir();
  const hub = new DocHub(dir);
  const a = new FakeConn();
  hub.handleConnection(a, 'ws/doc1');
  assert.ok(a.sent.length >= 1);
  const dec = decoding.createDecoder(a.sent[0]);
  assert.equal(decoding.readVarUint(dec), MESSAGE_SYNC);     // message type
  assert.equal(decoding.readVarUint(dec), 0);                // messageYjsSyncStep1 == 0
  rmSync(dir, { recursive: true });
});

test('an update from one peer converges on the server doc and is broadcast to the other', () => {
  const dir = tempDir();
  const hub = new DocHub(dir);
  const a = new FakeConn();
  const b = new FakeConn();
  hub.handleConnection(a, 'ws/doc1');
  hub.handleConnection(b, 'ws/doc1');

  const clientA = new Y.Doc();
  clientA.getText('content').insert(0, 'hello');
  a.emit('message', syncUpdateFrame(clientA));

  // server doc converged
  assert.equal(hub.getText('ws/doc1', 'content'), 'hello');

  // peer B received an update that reconstructs the text
  const recv = new Y.Doc();
  applySyncFrames(b, recv);
  assert.equal(recv.getText('content').toString(), 'hello');

  rmSync(dir, { recursive: true });
});

test('a malformed binary frame is ignored, never thrown', () => {
  const dir = tempDir();
  const hub = new DocHub(dir);
  const a = new FakeConn();
  hub.handleConnection(a, 'ws/doc1');
  assert.doesNotThrow(() => a.emit('message', Buffer.from([0xff, 0xff, 0xff, 0xff])));
  rmSync(dir, { recursive: true });
});

test('document state persists across hub restarts', async () => {
  const dir = tempDir();
  const hub1 = new DocHub(dir);
  const a = new FakeConn();
  hub1.handleConnection(a, 'ws/doc1');
  const clientA = new Y.Doc();
  clientA.getText('content').insert(0, 'persisted');
  a.emit('message', syncUpdateFrame(clientA));
  a.close();
  await hub1.flush('ws/doc1');

  const hub2 = new DocHub(dir);
  assert.equal(hub2.getText('ws/doc1', 'content'), 'persisted');
  hub2.cancelPending();
  rmSync(dir, { recursive: true });
});

// ============================================================ spec §1.5 — durability

const SNAP = (dir, docName) => join(dir, 'yjs', `${docName}.bin`);

/** Decode a snapshot file into a fresh doc. Throws if the bytes are not a full update. */
function decodeSnapshot(path) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, readFileSync(path));
  return doc;
}

test('the snapshot file is never observed truncated while it is being rewritten', async () => {
  const dir = tempDir();
  // No debounce: every update writes, so the reader races real writes.
  const hub = new DocHub(dir, { persistDebounceMs: 0 });
  const a = new FakeConn();
  hub.handleConnection(a, 'ws/big');

  const path = SNAP(dir, 'ws/big');
  const client = new Y.Doc();
  const chunk = 'x'.repeat(20_000);

  let reads = 0;
  let stop = false;
  // Interleave reads with writes. Every read must either find no file at all or
  // decode cleanly — a half-written snapshot is the failure this test exists for.
  const reader = (async () => {
    while (!stop) {
      if (existsSync(path)) {
        assert.doesNotThrow(() => decodeSnapshot(path), 'snapshot decoded mid-write');
        reads += 1;
      }
      await new Promise((r) => setImmediate(r));
    }
  })();

  for (let i = 0; i < 60; i++) {
    client.getText('content').insert(client.getText('content').length, chunk);
    a.emit('message', syncUpdateFrame(client));
    await new Promise((r) => setImmediate(r));
  }
  await hub.flush('ws/big');
  stop = true;
  await reader;

  assert.ok(reads > 0, 'the reader never observed a snapshot at all');
  assert.equal(decodeSnapshot(path).getText('content').toString().length, 60 * chunk.length);
  assert.ok(!existsSync(`${path}.tmp`), 'a temp file was left behind');

  hub.cancelPending();
  rmSync(dir, { recursive: true });
});

// Spec §10 Group C, test 79.
test('500 updates inside the debounce window produce fewer than 10 writes, and the final snapshot is correct', async () => {
  const dir = tempDir();
  const hub = new DocHub(dir, { persistDebounceMs: 2000 });
  const a = new FakeConn();
  hub.handleConnection(a, 'ws/hot');

  const client = new Y.Doc();
  for (let i = 0; i < 500; i++) {
    client.getText('content').insert(client.getText('content').length, `${i},`);
    a.emit('message', syncUpdateFrame(client));
  }

  // Still inside the window: nothing has been written yet.
  assert.equal(hub.writeCount('ws/hot'), 0);
  assert.ok(!existsSync(SNAP(dir, 'ws/hot')), 'a snapshot was written inside the debounce window');

  await hub.flush('ws/hot');
  assert.ok(hub.writeCount('ws/hot') < 10, `expected < 10 writes, got ${hub.writeCount('ws/hot')}`);

  const expected = Array.from({ length: 500 }, (_, i) => `${i},`).join('');
  assert.equal(decodeSnapshot(SNAP(dir, 'ws/hot')).getText('content').toString(), expected);
  assert.equal(hub.getText('ws/hot', 'content'), expected);

  hub.cancelPending();
  rmSync(dir, { recursive: true });
});

test('the last connection closing flushes immediately, without waiting out the debounce', async () => {
  const dir = tempDir();
  // A debounce far longer than the test: only the close-flush can produce a file.
  const hub = new DocHub(dir, { persistDebounceMs: 60_000 });
  const a = new FakeConn();
  const b = new FakeConn();
  hub.handleConnection(a, 'ws/leave');
  hub.handleConnection(b, 'ws/leave');

  const client = new Y.Doc();
  client.getText('content').insert(0, 'the tail of the session');
  a.emit('message', syncUpdateFrame(client));

  const path = SNAP(dir, 'ws/leave');
  a.close();
  // One peer is still connected: nothing is forced yet.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hub.writeCount('ws/leave'), 0);
  assert.ok(!existsSync(path));

  b.close();
  for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(path), 'the last close did not flush the snapshot');
  assert.equal(decodeSnapshot(path).getText('content').toString(), 'the tail of the session');

  hub.cancelPending();
  rmSync(dir, { recursive: true });
});

test('a temp file left by a crashed write is ignored and cleaned; the previous snapshot still loads', async () => {
  const dir = tempDir();
  const hub1 = new DocHub(dir, { persistDebounceMs: 0 });
  const a = new FakeConn();
  hub1.handleConnection(a, 'ws/crash');
  const client = new Y.Doc();
  client.getText('content').insert(0, 'the last good snapshot');
  a.emit('message', syncUpdateFrame(client));
  await hub1.flush('ws/crash');
  hub1.cancelPending();

  // Simulate a process killed between writeFile and rename.
  const path = SNAP(dir, 'ws/crash');
  writeFileSync(`${path}.tmp`, Buffer.from([0x00, 0x01, 0x02]));   // torn, undecodable

  const hub2 = new DocHub(dir);
  assert.equal(hub2.getText('ws/crash', 'content'), 'the last good snapshot');
  assert.ok(!existsSync(`${path}.tmp`), 'the stale temp file was not cleaned up');

  hub2.cancelPending();
  rmSync(dir, { recursive: true });
});

test('flushAllSync writes every resident doc atomically', async () => {
  const dir = tempDir();
  const hub = new DocHub(dir, { persistDebounceMs: 60_000 });
  for (const name of ['ws/one', 'ws/two']) {
    const conn = new FakeConn();
    hub.handleConnection(conn, name);
    const client = new Y.Doc();
    client.getText('content').insert(0, name);
    conn.emit('message', syncUpdateFrame(client));
  }
  assert.ok(!existsSync(SNAP(dir, 'ws/one')));

  hub.flushAllSync();
  for (const name of ['ws/one', 'ws/two']) {
    assert.equal(decodeSnapshot(SNAP(dir, name)).getText('content').toString(), name);
    assert.ok(!existsSync(`${SNAP(dir, name)}.tmp`));
  }

  hub.cancelPending();
  rmSync(dir, { recursive: true });
});
