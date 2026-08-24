// server/test/harness/net.mjs
// A minimal, partitionable y-protocols client over a real WebSocket, plus the
// real-network `DocPort` the structural end-to-end suite hands to the reconciler
// and the publish queue.
//
// This is deliberately NOT y-websocket: the suite needs to cut and restore a
// single client's link on demand (spec §10 Group C's partitions), and it needs a
// `synced` flag that reports a GENUINE sync rather than a timeout (invariant I4).
// Both are two lines here and a fight with a reconnect loop there.

import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;

/**
 * Deliberately a REF'd timer. An unref'd one does not hold the event loop open,
 * so a moment where the only pending work is a `sleep` lets Node exit the whole
 * run silently, mid-suite, with a success code.
 */
export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * The TCP socket under a `ws` client, at whichever stage of the handshake it is.
 *
 * `_socket` is only assigned once the upgrade has been accepted; before that the
 * connection lives on the pending HTTP request.
 */
function socketOf(ws) {
  return ws._socket ?? ws._req?.socket ?? null;
}

/**
 * Close a socket ABORTIVELY — an RST, never a FIN.
 *
 * The side that closes gracefully keeps its ephemeral port in TIME_WAIT for two
 * minutes. One full run of this suite opens ~6,300 sockets (three clients times
 * one content-doc room each, across twenty seeds of test 72) and Windows hands
 * out 16,384 ephemeral ports, so two runs inside one TIME_WAIT window are
 * already enough to exhaust the range. What that looks like is not an error: the
 * next `connect()` simply never completes, `waitSync` reports a timeout,
 * `openHeadless` truthfully answers "not synced", and some test in the second
 * half of the suite fails an assertion about convergence for a reason that has
 * nothing to do with the code under test — a different test each run, which is
 * exactly the flake this suite had.
 *
 * An RST releases the port immediately. Nothing is given up by it: every caller
 * here is either simulating a partition (where losing whatever was in flight is
 * the point) or tearing a client down at the end of a case, and `terminate()` —
 * what this replaces — is an abrupt close already.
 */
function abort(ws) {
  const socket = socketOf(ws);
  if (socket !== null && typeof socket.resetAndDestroy === 'function') {
    try {
      socket.resetAndDestroy();
      return;
    } catch {
      /* not connected yet: fall through to the library's own teardown */
    }
  }
  try {
    ws.terminate();
  } catch {
    /* already gone */
  }
}

/**
 * One document's link to the server.
 *
 * `synced` flips only when the server answers our SyncStep1 with a SyncStep2 —
 * that is the same event `WebsocketProvider` reports, and it is what invariant I4
 * requires callers to branch on. A timeout leaves it false.
 */
export class DocLink {
  constructor(url, doc) {
    this.url = url;
    this.doc = doc;
    this.ws = null;
    this.synced = false;
    /** SyncStep2 frames received. A flush waits for this to advance. */
    this.step2 = 0;
    this.lastError = null;
    /** While true, `connect()` does nothing: the client is partitioned. */
    this.blocked = false;
    this._listeners = new Set();

    this._onUpdate = (update, origin) => {
      if (origin === this) return;                     // came off the wire; do not echo
      this._sendUpdate(update);
    };
    doc.on('update', this._onUpdate);
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.blocked || this.ws !== null) return;
    this.synced = false;
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.on('open', () => { this._sendStep1(ws); });
    ws.on('message', (data) => {
      let frame;
      try {
        frame = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer ?? data);
      } catch {
        return;
      }
      this._onFrame(ws, frame);
    });
    ws.on('error', (err) => { this.lastError = err; this._notify(); });
    ws.on('close', () => {
      if (this.ws === ws) { this.ws = null; this.synced = false; }
      this._notify();
    });
  }

  /** Cut the link. Local updates keep accumulating in the doc and ship on reconnect. */
  disconnect() {
    const ws = this.ws;
    this.ws = null;
    this.synced = false;
    if (ws !== null) abort(ws);
    this._notify();
  }

  destroy() {
    this.disconnect();
    this.doc.off('update', this._onUpdate);
    this._listeners.clear();
  }

  /** Resolves true only on a genuine sync; false on timeout or a refused socket. */
  waitSync(ms) {
    return this._waitFor(() => this.synced, ms).then(() => this.synced);
  }

  /**
   * Await the round trip. A SyncStep1 sent after our updates is answered with a
   * SyncStep2 only once the server has processed everything that preceded it on
   * the same socket, so the reply is a genuine acknowledgement (invariant I17).
   */
  async flush(ms) {
    if (!this.connected) return false;
    const target = this.step2 + 1;
    this._sendStep1(this.ws);
    await this._waitFor(() => this.step2 >= target, ms);
    return this.step2 >= target;
  }

  // ---------------------------------------------------------- internals

  _onFrame(ws, frame) {
    try {
      const dec = decoding.createDecoder(frame);
      if (decoding.readVarUint(dec) !== MESSAGE_SYNC) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      const type = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
      if (encoding.length(enc) > 1 && ws.readyState === WebSocket.OPEN) {
        ws.send(encoding.toUint8Array(enc));
      }
      if (type === syncProtocol.messageYjsSyncStep2) {
        this.step2 += 1;
        this.synced = true;
      }
    } catch (err) {
      this.lastError = err;
    }
    this._notify();
  }

  _sendStep1(ws) {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    ws.send(encoding.toUint8Array(enc));
  }

  _sendUpdate(update) {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  }

  _notify() {
    for (const listener of [...this._listeners]) listener();
  }

  _waitFor(predicate, ms) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._listeners.delete(check);
        resolve();
      };
      const check = () => { if (predicate()) finish(); };
      this._listeners.add(check);
      const timer = setTimeout(finish, ms);
    });
  }
}

/**
 * `DocPort` (spec §4.0) over real WebSockets to the real server.
 *
 * Connections are POOLED per room: a note's content doc is opened by the
 * materializer, by `adopt` and by the publish queue, sometimes several times in
 * one pass, and a socket per call would make the 200-operation convergence test
 * a socket storm rather than a convergence test. `close` therefore releases the
 * caller's claim, not the connection; `destroy()` tears the pool down.
 */
export class WsDocPort {
  constructor({ urlFor, syncTimeoutMs = 2000, flushTimeoutMs = 2000 }) {
    this.urlFor = urlFor;
    this.syncTimeoutMs = syncTimeoutMs;
    this.flushTimeoutMs = flushTimeoutMs;
    /** Set while this client is partitioned: a provider that knows it is down. */
    this.offline = false;
    /** room -> { doc, link }. */
    this.rooms = new Map();
    /** Every room name ever passed to `openHeadless`, in order. */
    this.openLog = [];
  }

  /** Rooms this port has ever opened, deduplicated and sorted. */
  roomsTouched() {
    return [...new Set(this.openLog)].sort();
  }

  rawDoc(room) {
    return this.rooms.get(room)?.doc ?? null;
  }

  async openHeadless(room) {
    this.openLog.push(room);
    if (this.offline) return { text: '', synced: false, handle: { room } };

    let entry = this.rooms.get(room);
    if (entry === undefined) {
      const doc = new Y.Doc();
      const link = new DocLink(this.urlFor(room), doc);
      entry = { doc, link };
      this.rooms.set(room, entry);
      link.connect();
    } else if (!entry.link.connected) {
      entry.link.connect();
    }

    const synced = await entry.link.waitSync(this.syncTimeoutMs);
    if (!synced) {
      // Never hand back a document we could not prove we synced (I4). Drop the
      // connection so the next attempt starts clean rather than inheriting a
      // half-open socket.
      entry.link.destroy();
      this.rooms.delete(room);
      return { text: '', synced: false, handle: { room } };
    }
    return { text: entry.doc.getText('content').toString(), synced: true, handle: { room } };
  }

  async insertIfEmpty(handle, text) {
    const entry = this.rooms.get(handle.room);
    if (entry === undefined) return false;
    const ytext = entry.doc.getText('content');
    if (ytext.length !== 0) return false;               // I5
    ytext.insert(0, text);
    return true;
  }

  async flush(handle) {
    const entry = this.rooms.get(handle.room);
    if (entry === undefined) return false;
    return entry.link.flush(this.flushTimeoutMs);
  }

  close() {
    // Pooled: the connection outlives the handle. `destroy()` closes them.
  }

  goOffline() {
    this.offline = true;
    for (const { link } of this.rooms.values()) {
      link.blocked = true;
      link.disconnect();
    }
  }

  goOnline() {
    this.offline = false;
    for (const { link } of this.rooms.values()) {
      link.blocked = false;
      link.connect();
    }
  }

  async destroy() {
    for (const { link } of this.rooms.values()) link.destroy();
    this.rooms.clear();
  }
}
