import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
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

test('document state persists across hub restarts', () => {
  const dir = tempDir();
  const hub1 = new DocHub(dir);
  const a = new FakeConn();
  hub1.handleConnection(a, 'ws/doc1');
  const clientA = new Y.Doc();
  clientA.getText('content').insert(0, 'persisted');
  a.emit('message', syncUpdateFrame(clientA));
  a.close();

  const hub2 = new DocHub(dir);
  assert.equal(hub2.getText('ws/doc1', 'content'), 'persisted');
  rmSync(dir, { recursive: true });
});
