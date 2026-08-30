// server/test/harness/mux.mjs
// The harness for the P3 `_mux` endpoint (spec §4, slice 1).
//
// The rule this file is written to: A FAKE THAT CANNOT EXPRESS A FAILURE HIDES
// IT. Five defects in this project hid in what a test double could not say, so
// the doubles here are built to say the hostile things FIRST and the happy path
// second. Between `FakeSocket` and `MuxClient` a test can express:
//
//   - a frame naming a room that belongs to another workspace;
//   - a frame naming a malformed docId (traversal, a slash, a dot, empty, 301
//     characters, a NUL, a lone surrogate);
//   - a frame that is not a frame at all (truncated varString, empty, noise);
//   - a frame arriving AFTER the socket closed;
//   - a socket that never reads, so every broadcast becomes resident memory;
//   - a room whose `hub.handleConnection` throws;
//   - a room whose `DocHub` close handler throws during the fan-out;
//   - more rooms than `MUX_MAX_ROOMS_PER_SOCKET`.
//
// Two doubles, on purpose. `FakeSocket` is a deterministic `ws` stand-in: it can
// emit a message after a close, which a real socket will not do on demand, and
// its `bufferedAmount` is whatever the test says it is. `MuxClient` is the real
// thing over a real WebSocket to a real `DocHub`, doc-free exactly as the design
// requires — the ledger holds encoded update bytes and answers handshakes with
// `encodeStateVectorFromUpdate` / `diffUpdate` / `mergeUpdates`, never a `Y.Doc`.

import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { DocHub } from '../../DocHub.js';
import { authorizeUpgrade } from '../../upgradeAuth.js';
import { attachMux, encodeMuxFrame, decodeMuxFrame, MUX_DOC_ID } from '../../mux.js';

export { encodeMuxFrame, decodeMuxFrame, MUX_DOC_ID };

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

export const SYNC = { MESSAGE_SYNC, MESSAGE_AWARENESS, SYNC_STEP1, SYNC_STEP2, SYNC_UPDATE };

/** Deliberately a REF'd timer, for the reason `net.mjs` gives at length. */
export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** The state vector of an empty document — what an unknown room handshakes from. */
export const EMPTY_SV = (() => {
  const doc = new Y.Doc();
  const sv = Y.encodeStateVector(doc);
  doc.destroy();
  return sv;
})();

// ============================================================ sync payloads

/** A standard y-websocket sync payload. The mux never looks inside one. */
export function syncPayload(type, body) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  encoding.writeVarUint(enc, type);
  encoding.writeVarUint8Array(enc, body);
  return encoding.toUint8Array(enc);
}

/** An awareness payload, so a test can prove the mux relays what it cannot read. */
export function awarenessPayload(body) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(enc, body);
  return encoding.toUint8Array(enc);
}

/** The full state of a fresh document holding `text` in `content`. */
export function updateFor(text, field = 'content') {
  const doc = new Y.Doc();
  doc.getText(field).insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** The text a stored update blob decodes to. Hydrate, read, destroy. */
export function textOfUpdate(bytes, field = 'content') {
  if (bytes === undefined || bytes === null) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const text = doc.getText(field).toString();
  doc.destroy();
  return text;
}

// ============================================================ FakeSocket

/**
 * A `ws` stand-in with no network under it.
 *
 * Everything `attachMux` touches is here and nothing else: `on`, `send`,
 * `close`, `terminate`, `readyState`, `bufferedAmount`. What it adds over a real
 * socket is the ability to be HOSTILE ON DEMAND — deliver a frame after the
 * close event, report an arbitrary `bufferedAmount`, or throw from `send`.
 */
export class FakeSocket extends EventEmitter {
  constructor({ bufferedAmount = 0 } = {}) {
    super();
    this.readyState = 1;                       // OPEN
    this.bufferedAmount = bufferedAmount;
    /** Every frame the server wrote, decoded. */
    this.sent = [];
    /** Raw bytes, for a test that wants to check the frame codec itself. */
    this.sentRaw = [];
    this.terminated = false;
    this.closed = false;
    /** Set to make `send` throw, which is a socket failure mid-broadcast. */
    this.sendThrows = null;
    /** Grow `bufferedAmount` by this much on every send: a peer that never reads. */
    this.bufferedPerSend = 0;
  }

  send(data) {
    if (this.sendThrows !== null) throw this.sendThrows;
    this.sentRaw.push(Uint8Array.from(data));
    this.bufferedAmount += this.bufferedPerSend;
    try {
      this.sent.push(decodeMuxFrame(data));
    } catch {
      this.sent.push({ room: null, payload: Uint8Array.from(data) });
    }
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = true;
    this.emit('close');
  }

  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.readyState = 3;
    // `ws` emits the close event from the socket's own close, i.e. NOT
    // synchronously inside `terminate()`. Imitating that is what makes the
    // "backpressure cannot re-enter a DocHub broadcast loop" claim testable.
    queueMicrotask(() => this.emit('close'));
  }

  // -------------------------------------------------------- hostile input

  /** Deliver a well-formed frame. */
  deliver(room, payload) {
    this.emit('message', Buffer.from(encodeMuxFrame(room, payload)));
  }

  /** Deliver arbitrary bytes: the frame that is not a frame. */
  deliverRaw(bytes) {
    this.emit('message', Buffer.from(bytes));
  }

  /** Frames this socket wrote for `room`, in order. */
  framesFor(room) {
    return this.sent.filter((f) => f.room === room);
  }

  /** The rooms this socket was ever written to, sorted. */
  roomsWritten() {
    return [...new Set(this.sent.map((f) => f.room))].sort();
  }
}

/**
 * A `DocHub` stand-in that can FAIL — the one thing the real hub will not do on
 * demand, and the thing "error containment" is a claim about.
 *
 * `failOn` names rooms whose `handleConnection` throws; `failCloseOn` names rooms
 * whose close handler throws during the fan-out.
 */
export class FlakyHub {
  constructor({ failOn = [], failCloseOn = [] } = {}) {
    this.failOn = new Set(failOn);
    this.failCloseOn = new Set(failCloseOn);
    /** docName → { conn, closed } for every connection it accepted. */
    this.connections = new Map();
    this.docNames = [];
  }

  handleConnection(conn, docName) {
    this.docNames.push(docName);
    const room = docName.slice(docName.indexOf('/') + 1);
    if (this.failOn.has(room)) throw new Error(`hub refuses ${docName}`);
    const entry = { conn, docName, closed: false, received: [] };
    conn.on('message', (payload) => { entry.received.push(payload); });
    conn.on('close', () => {
      entry.closed = true;
      if (this.failCloseOn.has(room)) throw new Error(`close handler threw for ${docName}`);
    });
    this.connections.set(docName, entry);
    // The real hub's first act is a SyncStep1, so imitate having one.
    conn.send(syncPayload(SYNC_STEP1, EMPTY_SV));
  }

  /** Broadcast into one room, the way a peer's update would. */
  push(docName, payload) {
    this.connections.get(docName)?.conn.send(payload);
  }
}

// ============================================================ real server

/**
 * An in-process server that routes exactly as `server/index.js` does: the REAL
 * `authorizeUpgrade`, the REAL `attachMux`, the REAL `DocHub`, and the legacy
 * per-room route beside it so a test can prove the two reach the same document.
 *
 * Port 0: the OS picks. Nothing here can collide with a developer's own server,
 * and its data directory is its own temp directory, removed on `stop()`.
 */
export async function startMuxHub({
  serverKey = 'sk_harness',
  maxRooms,
  maxBufferedBytes,
  persistDebounceMs = 50,
  dir = null,
} = {}) {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'sl-mux-'));
  const hub = new DocHub(dataDir, { persistDebounceMs });
  const httpServer = createServer((_req, res) => { res.writeHead(404).end(); });
  const wss = new WebSocketServer({ noServer: true });
  /** Every mux handle this server created, newest last. */
  const muxes = [];
  /** Upgrades the shipped auth refused, as `{ url, code }`. */
  const refused = [];

  httpServer.on('upgrade', (req, socket, head) => {
    const result = authorizeUpgrade(req.url, (key) => key === serverKey);
    if (!result.ok) {
      refused.push({ url: req.url, code: result.code });
      socket.write(`HTTP/1.1 ${result.code} Unauthorized\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (result.docId === MUX_DOC_ID) {
        muxes.push(attachMux(ws, {
          hub, workspaceId: result.workspaceId, maxRooms, maxBufferedBytes,
        }));
        return;
      }
      hub.handleConnection(ws, result.docName);
    });
  });

  await new Promise((res) => { httpServer.listen(0, '127.0.0.1', res); });
  const { port } = httpServer.address();

  return {
    port,
    dir: dataDir,
    hub,
    serverKey,
    muxes,
    refused,
    /** The mux handle for the socket that connected last. */
    lastMux() { return muxes[muxes.length - 1] ?? null; },
    muxUrl(workspace, key = serverKey) {
      return `ws://127.0.0.1:${port}/${MUX_DOC_ID}?t=${key}&w=${workspace}`;
    },
    roomUrl(room, workspace, key = serverKey) {
      return `ws://127.0.0.1:${port}/${room}?t=${key}&w=${workspace}`;
    },
    async stop() {
      hub.cancelPending();
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* already gone */ }
      }
      wss.close();
      await new Promise((res) => { httpServer.close(res); });
      await sleep(20);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ============================================================ MuxClient

/**
 * The doc-free mux client the design is built on (spec §1.1 `RoomLedger`).
 *
 * Per room it holds ONE thing: the encoded update bytes. A SyncStep1 is answered
 * from `Y.encodeStateVectorFromUpdate`, a SyncStep2 from `Y.diffUpdate`, and an
 * inbound update is folded in with `Y.mergeUpdates`. No `Y.Doc` is instantiated
 * for a room nobody is looking at — `textOf` hydrates one on demand purely so a
 * test can read the room, which is exactly the "hydrate, read, destroy" the
 * design budgets at 0.262 ms.
 *
 * It is also the hostile client: `sendFrame` will send ANY room string, and
 * `stopReading` pauses the underlying socket so the server's send buffer grows.
 */
export class MuxClient {
  constructor(url, { name = 'mux' } = {}) {
    this.url = url;
    this.name = name;
    this.ws = null;
    /** room → Uint8Array of encoded updates. The whole ledger. */
    this.ledger = new Map();
    /** room → resolve, armed by `expect`, fired by the server's SyncStep2. */
    this._pending = new Map();
    /** Awareness payloads seen per room, so a cold-room drop is observable. */
    this.awareness = [];
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.framesIn = 0;
    this.framesOut = 0;
    /** Rooms the server answered a Step1 for. */
    this.synced = new Set();
    this.lastError = null;
    this.closeInfo = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 });
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.on('open', () => resolve(ws));
      ws.on('error', (err) => { this.lastError = err; reject(err); });
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: String(reason ?? '') };
      });
      ws.on('message', (data) => this._onFrame(new Uint8Array(data)));
    });
  }

  /** Connect, but resolve to the failure instead of throwing on a refusal. */
  async tryConnect() {
    try {
      await this.connect();
      return 'accepted';
    } catch {
      return 'rejected';
    }
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ------------------------------------------------------------- hostile

  /** Send a frame for ANY room string, valid or not. */
  sendFrame(room, payload) {
    const frame = encodeMuxFrame(room, payload);
    this.bytesOut += frame.byteLength;
    this.framesOut += 1;
    this.ws.send(frame);
  }

  /** Send bytes that are not a frame. */
  sendRaw(bytes) {
    this.bytesOut += bytes.byteLength ?? bytes.length;
    this.framesOut += 1;
    this.ws.send(Buffer.from(bytes));
  }

  /**
   * Stop draining the socket. The kernel receive buffer fills, then the TCP
   * window closes, and from there every byte the server writes sits in its own
   * `bufferedAmount` — which is the resource a mux socket can be made to consume
   * and a per-room socket could not.
   */
  stopReading() {
    this.ws?._socket?.pause();
  }

  resumeReading() {
    this.ws?._socket?.resume();
  }

  // ------------------------------------------------------------- protocol

  /** Subscribe: SyncStep1 carrying the state vector of the bytes we hold. */
  subscribe(room) {
    const blob = this.ledger.get(room);
    const sv = blob === undefined ? EMPTY_SV : Y.encodeStateVectorFromUpdate(blob);
    this.sendFrame(room, syncPayload(SYNC_STEP1, sv));
  }

  /** Push local state up as a plain update. */
  pushUpdate(room, update) {
    this.merge(room, update);
    this.sendFrame(room, syncPayload(SYNC_UPDATE, update));
  }

  merge(room, update) {
    const current = this.ledger.get(room);
    this.ledger.set(room, current === undefined ? update : Y.mergeUpdates([current, update]));
  }

  textOf(room, field = 'content') {
    return textOfUpdate(this.ledger.get(room), field);
  }

  /**
   * Arm a wait for the server's SyncStep2 on each room, BEFORE subscribing.
   * Armed first on purpose: a Step2 that lands between subscribe and await is a
   * lost wakeup, and that is exactly the flake a storm test would show as a
   * timeout in a random room.
   */
  expect(rooms) {
    return Promise.all(rooms.map((room) => new Promise((resolve) => {
      if (this.synced.has(room)) { resolve(); return; }
      this._pending.set(room, resolve);
    })));
  }

  /** Subscribe to every room and resolve when every one has answered. */
  async syncAll(rooms) {
    const waits = this.expect(rooms);
    for (const room of rooms) this.subscribe(room);
    await waits;
  }

  resetCounters() {
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.framesIn = 0;
    this.framesOut = 0;
    this.synced.clear();
    this._pending.clear();
  }

  close() {
    try { this.ws?.close(); } catch { /* already gone */ }
  }

  /** Abortive close, so a run does not park ephemeral ports in TIME_WAIT. */
  abort() {
    const socket = this.ws?._socket;
    if (socket?.resetAndDestroy) {
      try { socket.resetAndDestroy(); return; } catch { /* fall through */ }
    }
    try { this.ws?.terminate(); } catch { /* already gone */ }
  }

  _onFrame(bytes) {
    this.bytesIn += bytes.byteLength;
    this.framesIn += 1;
    let room;
    let payload;
    try {
      ({ room, payload } = decodeMuxFrame(bytes));
    } catch (err) {
      this.lastError = err;
      return;
    }
    const dec = decoding.createDecoder(payload);
    const messageType = decoding.readVarUint(dec);
    if (messageType === MESSAGE_AWARENESS) {
      // A cold room drops awareness at ~zero cost (spec §2). Recorded, not applied.
      this.awareness.push(room);
      return;
    }
    if (messageType !== MESSAGE_SYNC) return;
    const syncType = decoding.readVarUint(dec);
    if (syncType === SYNC_STEP1) {
      // Answer from stored bytes. No Y.Doc.
      const theirSv = decoding.readVarUint8Array(dec);
      const blob = this.ledger.get(room);
      const diff = blob === undefined
        ? Y.encodeStateAsUpdate(new Y.Doc(), theirSv)
        : Y.diffUpdate(blob, theirSv);
      this.sendFrame(room, syncPayload(SYNC_STEP2, diff));
      return;
    }
    if (syncType === SYNC_STEP2 || syncType === SYNC_UPDATE) {
      const update = decoding.readVarUint8Array(dec);
      if (update.byteLength > 1) this.merge(room, update);
      if (syncType === SYNC_STEP2) {
        this.synced.add(room);
        const resolve = this._pending.get(room);
        if (resolve !== undefined) { this._pending.delete(room); resolve(); }
      }
    }
  }
}

// ============================================================ legacy client

/**
 * One room over the LEGACY per-room route, with a real `Y.Doc`, so the mixed
 * fleet claim can be tested rather than inferred: spec §10's own assumption list
 * says that claim "is inferred, not measured end to end" and that slice 1 should
 * add exactly this.
 */
export class RoomClient {
  constructor(url) {
    this.url = url;
    this.doc = new Y.Doc();
    this.ws = null;
    this.synced = false;
    this._listeners = new Set();
    this._onUpdate = (update, origin) => {
      if (origin === this) return;
      this._send(syncPayload(SYNC_UPDATE, update));
    };
    this.doc.on('update', this._onUpdate);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.on('open', () => {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        encoding.writeVarUint(enc, SYNC_STEP1);
        encoding.writeVarUint8Array(enc, Y.encodeStateVector(this.doc));
        ws.send(encoding.toUint8Array(enc));
        resolve(ws);
      });
      ws.on('error', reject);
      ws.on('message', (data) => this._onMessage(new Uint8Array(data)));
    });
  }

  get text() { return this.doc.getText('content').toString(); }

  insert(text) { this.doc.getText('content').insert(this.doc.getText('content').length, text); }

  _send(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(Buffer.from(payload));
  }

  _onMessage(bytes) {
    const dec = decoding.createDecoder(bytes);
    if (decoding.readVarUint(dec) !== MESSAGE_SYNC) return;
    const syncType = decoding.readVarUint(dec);
    const body = decoding.readVarUint8Array(dec);
    if (syncType === SYNC_STEP1) {
      this._send(syncPayload(SYNC_STEP2, Y.encodeStateAsUpdate(this.doc, body)));
    } else if (syncType === SYNC_STEP2 || syncType === SYNC_UPDATE) {
      if (body.byteLength > 1) Y.applyUpdate(this.doc, body, this);
      if (syncType === SYNC_STEP2) this.synced = true;
    }
    for (const listener of [...this._listeners]) listener();
  }

  /** Wait until `predicate()` holds, or `ms` elapses. Resolves either way. */
  waitFor(predicate, ms = 3000) {
    if (predicate()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._listeners.delete(check);
        resolve(predicate());
      };
      const check = () => { if (predicate()) finish(); };
      this._listeners.add(check);
      const timer = setTimeout(finish, ms);
    });
  }

  destroy() {
    this.doc.off('update', this._onUpdate);
    const socket = this.ws?._socket;
    if (socket?.resetAndDestroy) {
      try { socket.resetAndDestroy(); } catch { /* fall through */ }
    } else {
      try { this.ws?.terminate(); } catch { /* already gone */ }
    }
    this.doc.destroy();
  }
}

/** Poll `predicate` until it holds or `ms` elapses. Returns whether it held. */
export async function until(predicate, ms = 3000, step = 10) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
}
