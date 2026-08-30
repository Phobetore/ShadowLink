// server/mux.js
// The `_mux` upgrade route (P3 spec §4): ONE WebSocket carrying many rooms.
//
// Why this exists. y-websocket bakes the room into the URL at construction —
// `this.url = serverUrl + '/' + roomname + …` in the installed 1.5.4 — so a
// vault with 2,000 live notes needs 2,000 sockets, which is what makes continuous
// sync of unopened notes unaffordable today. The multiplexing therefore has to be
// built, and this file is the server half of it. It was measured before it was
// written: 2,000 rooms on one socket, cold storm 466 ms / 2.21 MB down with
// 2,000 of 2,000 texts byte-correct, warm reconnect 44 B per room per direction.
//
// What it is NOT. It does not interpret a payload, ever. A frame carries a room
// name and an opaque blob; the blob goes to `DocHub` exactly as it arrived, and
// `DocHub` is not modified by a byte — `server/tools/check-dochub.mjs` pins its
// hash and CI runs it. The server relays rooms and stores snapshots; it does not
// know what a note is.
//
// The security shape, which is the whole point of the file. A mux socket is a
// CAPABILITY AMPLIFIER: one authentication now unlocks many rooms where it used
// to unlock exactly one. So the check that made a room name safe — `DOC_RE`,
// which is what lets a room name be a snapshot filename — moves from upgrade
// time to FRAME time, and it is the same predicate (`isValidDocId`), imported
// rather than rewritten. The workspace is the other half: it is fixed at upgrade
// and a frame cannot name one, so `${workspaceId}/${room}` is the only docName a
// socket can ever reach and a socket authenticated for W cannot touch W'.

import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { isValidDocId } from './upgradeAuth.js';

/** The docId that selects this route. Already matched by the upgrade's `DOC_RE`. */
export const MUX_DOC_ID = '_mux';

/**
 * Spec §8.1. Bounds a hostile fan-out — and note that the mux CHANGES the shape
 * of that exposure rather than only capping it: a hostile key now costs one
 * FRAME per room where it used to cost one SOCKET per room. 8,192 is four times
 * the largest vault the design budgets for (2,000 notes plus `_tree`), so a
 * legitimate client never sees it.
 */
export const MUX_MAX_ROOMS_PER_SOCKET = 8_192;

/**
 * ⚠ THE BOUND. The socket is terminated the first time `ws.bufferedAmount` is
 * observed above this — no grace, no reset, no averaging. This is the number a
 * self-hoster may size a host from, and it is the only one that is true of a mux
 * socket at every instant.
 *
 * The failure it exists for is a client that subscribes to everything and never
 * reads. The per-room route bounded that implicitly — one socket held one room's
 * traffic — and the mux removes that bound; worse, a client can ask for a room's
 * full state again and again with an empty state vector, so the bytes the server
 * queues toward it are not bounded by the workspace's size either.
 *
 * Where 128 MiB comes from, measured rather than chosen. The heaviest LEGITIMATE
 * burst is a cold storm over a link so slow that nothing drains while it runs —
 * a phone on a dying connection asking for a whole vault — and its peak buffer
 * is then the vault's entire state. At the design maximum the spec budgets
 * (2,000 notes at its own measured 6.04 KB of history each) that peak measures
 * 11.7 MiB, and all 2,000 texts are still byte-correct once the link recovers.
 * 128 MiB is 10.9x that, so it clears a vault ten times the design budget, and
 * it holds a socket that has stopped reading to 128 MiB instead of the 1.63 GB
 * such a socket reached in ten seconds without it.
 *
 * Terminate, not close: a graceful close waits for a handshake the peer is by
 * definition not reading, so it would keep the memory it was meant to release.
 */
export const MUX_HARD_BUFFERED_BYTES = 128 * 1024 * 1024;

/**
 * The SUSTAINED ceiling, which is a courtesy and not a bound. A buffer that
 * stays above this for `MUX_BACKPRESSURE_GRACE_MS` without once falling back
 * under is a peer that has stopped reading rather than one that is merely slow,
 * so the socket goes and the memory comes back before it reaches the hard bound.
 *
 * ⚠ Read this tier for exactly what it is. It resets on a single dip under the
 * ceiling, so a peer that reads one byte per grace window never trips it — which
 * is why it CANNOT be the bound, and why the previous version of this file was
 * wrong to let it stand alone. Measured on this 32 MiB / 60 s pair with nothing
 * above it: one authenticated socket re-requesting full state with an empty state
 * vector reached 1.63 GB of buffer and 2.4 GB of RSS in ten seconds, growing at
 * 161.7 MB/s, with `stats.overflowed` still false the whole time — a 32 MiB
 * constant naming a multi-gigabyte reality. The bound above is what makes this
 * tier safe to keep.
 *
 * It is worth keeping because a legitimate cold storm sits at 11.7 MiB, well
 * under it: nothing honest reaches this ceiling, and a peer parked between it
 * and the hard bound is holding memory nobody is using.
 */
export const MUX_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/** How long the buffer must stay over the sustained ceiling before the socket goes. */
export const MUX_BACKPRESSURE_GRACE_MS = 60_000;

// `ws` readyState. CONNECTING 0, OPEN 1, CLOSING 2, CLOSED 3 — the same numbers
// `DocHub._send` branches on, which is what a virtual connection must imitate.
const OPEN = 1;
const CLOSED = 3;

/**
 * Whatever `ws` handed us, as a plain `Uint8Array` starting at offset zero.
 *
 * A Node `Buffer` is a view into a POOLED ArrayBuffer at a non-zero byteOffset,
 * and a decoder built over it must respect that offset. Copying once here means
 * nothing downstream has to.
 */
function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data);
}

/**
 * One room's view of a shared socket: the object `DocHub.handleConnection` is
 * handed in place of a `ws`.
 *
 * `DocHub` uses exactly `on('message'|'close'|'error')`, `send`, `close` and
 * `readyState`, so that is the whole surface. It is duck-typed on purpose —
 * teaching `DocHub` about multiplexing is the one thing this slice may not do.
 */
class VirtualConn {
  constructor(room, sendFrame, onGone, onError) {
    this.room = room;
    this.readyState = OPEN;
    this._sendFrame = sendFrame;
    this._onGone = onGone;
    this._onError = onError;
    this._handlers = { message: [], close: [], error: [] };
  }

  on(event, handler) {
    const list = this._handlers[event];
    if (list !== undefined) list.push(handler);
    return this;
  }

  send(message) {
    if (this.readyState !== OPEN) return;
    this._sendFrame(this.room, message);
  }

  /**
   * `DocHub._closeConn` calls this after it has already removed the connection
   * from its own map, so re-entering through the close handlers below is a
   * no-op there. It must NOT touch the shared socket: the other rooms are still
   * using it.
   */
  close() {
    this.shutdown();
  }

  /** Deliver one payload to this room. One room's throw stays in this room. */
  deliver(payload) {
    if (this.readyState !== OPEN) return;
    for (const handler of [...this._handlers.message]) {
      try {
        handler(payload);
      } catch (err) {
        this._onError(err);
      }
    }
  }

  /**
   * End this room. Fires `DocHub`'s close handler, which is what runs its
   * flush-on-last-peer-left — so a mux socket dropping is, per room, exactly the
   * event a per-room socket dropping used to be.
   */
  shutdown() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this._onGone(this.room);
    for (const handler of [...this._handlers.close]) {
      try {
        handler();
      } catch (err) {
        // One room's teardown may not abort the fan-out for the others.
        this._onError(err);
      }
    }
  }
}

/**
 * Attach the mux protocol to an authenticated socket.
 *
 * @param ws           the upgraded WebSocket. Authenticated ONCE, already.
 * @param hub          the shared, unmodified `DocHub`.
 * @param workspaceId  fixed at upgrade time. A frame can never name another.
 * @returns a handle whose counters say what the socket did and what it refused.
 *          `server/index.js` ignores it; the tests are what read it, and they
 *          read it instead of reading the log, because a drop that is only a
 *          `return` is a drop no test can tell from a message that was relayed.
 */
export function attachMux(ws, {
  hub,
  workspaceId,
  maxRooms = MUX_MAX_ROOMS_PER_SOCKET,
  hardBufferedBytes = MUX_HARD_BUFFERED_BYTES,
  maxBufferedBytes = MUX_MAX_BUFFERED_BYTES,
  backpressureGraceMs = MUX_BACKPRESSURE_GRACE_MS,
  // Injectable so a test can express "over the ceiling, then drained in time"
  // and "over the ceiling and stayed there" as two different things rather than
  // as one flaky one.
  now = Date.now,
} = {}) {
  /** room → VirtualConn, created lazily on the first frame that names it. */
  const rooms = new Map();
  const stats = {
    framesIn: 0,
    framesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    roomsOpened: 0,
    /** Every reason a frame did not reach a room. Each one is a refusal. */
    dropped: {
      malformed: 0,      // the frame did not decode
      badRoom: 0,        // the room name failed the SAME check the URL faces
      capped: 0,         // MUX_MAX_ROOMS_PER_SOCKET
      afterClose: 0,     // the socket is gone; nothing may resurrect a room
      roomFailed: 0,     // hub.handleConnection threw for this room
    },
    /**
     * The highest `ws.bufferedAmount` this socket ever reached. This is the
     * measurement `MUX_MAX_BUFFERED_BYTES` is set from: without it the ceiling
     * is a number somebody liked the look of.
     */
    peakBufferedBytes: 0,
    /** When the buffer first went over the SUSTAINED ceiling, or null. */
    overCeilingSince: null,
    /** True once backpressure terminated the socket. */
    overflowed: false,
    /** Which rule fired: 'hard' (the bound) or 'sustained' (the grace). */
    overflowReason: null,
    /** Last contained error, for diagnostics. Never thrown at a caller. */
    lastError: null,
  };

  let closed = false;

  const record = (err) => { stats.lastError = err; };

  const sendFrame = (room, payload) => {
    if (closed || ws.readyState !== OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarString(enc, room);
    encoding.writeVarUint8Array(enc, payload);
    const frame = encoding.toUint8Array(enc);
    try {
      ws.send(frame);
    } catch (err) {
      // A send that throws is this socket's problem, not this room's: swallow it
      // here and let the socket's own close event run the fan-out.
      record(err);
      return;
    }
    stats.framesOut += 1;
    stats.bytesOut += frame.byteLength;

    // A peer that has stopped reading turns every broadcast into resident
    // memory. `bufferedAmount` is the only honest measure of that, and it is a
    // property read, not a syscall.
    //
    // Checked HERE rather than on a timer, because the buffer only grows when we
    // write: a peer that has stopped reading while the server has also stopped
    // sending is not growing and is not the failure this guards.
    const buffered = ws.bufferedAmount ?? 0;
    if (buffered > stats.peakBufferedBytes) stats.peakBufferedBytes = buffered;
    if (stats.overflowed) return;

    // ⚠ THE BOUND, first and without conditions. No grace, no reset, no state:
    // whatever else is true of this socket, it is holding no more than this.
    if (hardBufferedBytes > 0 && buffered > hardBufferedBytes) {
      terminate('hard');
      return;
    }

    // Under the bound, a SUSTAINED stall is still memory nobody is using, so
    // reclaim it. This tier is deliberately forgiving — one dip under the ceiling
    // resets the clock — because a slow link is not an attack. That forgiveness
    // is exactly why it is a courtesy and never the bound.
    if (maxBufferedBytes <= 0) return;
    if (buffered <= maxBufferedBytes) {
      stats.overCeilingSince = null;              // it drained: not our problem
      return;
    }
    const at = now();
    if (stats.overCeilingSince === null) { stats.overCeilingSince = at; return; }
    if (at - stats.overCeilingSince < backpressureGraceMs) return;
    terminate('sustained');
  };

  /**
   * Drop the socket for exceeding a buffer rule. Terminate rather than close: a
   * graceful close waits for a handshake the peer is by definition not reading.
   *
   * Asynchronous by construction in `ws` (the close event follows the socket's),
   * so this cannot re-enter a DocHub broadcast loop mid-iteration.
   */
  const terminate = (reason) => {
    stats.overflowed = true;
    stats.overflowReason = reason;
    try {
      if (typeof ws.terminate === 'function') ws.terminate();
      else ws.close();
    } catch (err) {
      record(err);
    }
  };

  const forget = (room) => { rooms.delete(room); };

  const onMessage = (data) => {
    // A frame that arrives after the socket is gone may not resurrect a room:
    // its `DocHub` connections have already been closed and flushed.
    if (closed) { stats.dropped.afterClose += 1; return; }

    stats.framesIn += 1;
    let room;
    let payload;
    try {
      const bytes = toBytes(data);
      stats.bytesIn += bytes.byteLength;
      const dec = decoding.createDecoder(bytes);
      room = decoding.readVarString(dec);
      payload = decoding.readVarUint8Array(dec);
    } catch {
      // Truncated, mis-framed, or not a mux frame at all. Dropped, never guessed
      // at — and never fatal to the socket, which is carrying other rooms.
      stats.dropped.malformed += 1;
      return;
    }

    // ⚠ THE per-frame check. Same predicate as the URL faces at upgrade, because
    // the mux moved this question from once-per-connection to once-per-frame.
    // A name that fails is DROPPED, not sanitized: a sanitizer turns a hostile
    // name into some other room's name, which is a worse outcome than silence.
    if (!isValidDocId(room)) { stats.dropped.badRoom += 1; return; }

    let vconn = rooms.get(room);
    if (vconn === undefined) {
      if (rooms.size >= maxRooms) { stats.dropped.capped += 1; return; }
      vconn = new VirtualConn(room, sendFrame, forget, record);
      rooms.set(room, vconn);
      try {
        // The workspace comes from the UPGRADE, never from the frame. This one
        // template literal is the workspace boundary.
        hub.handleConnection(vconn, `${workspaceId}/${room}`);
        stats.roomsOpened += 1;
      } catch (err) {
        // A room that cannot be opened — an unreadable snapshot, a full disk —
        // is one room's failure. `shutdown` unwinds whatever `handleConnection`
        // managed to register before it threw, and the socket carries on.
        record(err);
        stats.dropped.roomFailed += 1;
        vconn.shutdown();
        return;
      }
    }
    vconn.deliver(payload);
  };

  /**
   * Close fan-out. Every room fires its own close, so `DocHub`'s existing
   * flush-on-last-peer-left runs per room, untouched. One socket per vault means
   * that fires for the whole share at once — measured, `flushAll` of 2,000
   * snapshots is 742 ms, serialized per docName by DocHub's own `_persistChain`.
   */
  const shutdown = () => {
    if (closed) return;
    closed = true;
    for (const vconn of [...rooms.values()]) {
      try {
        vconn.shutdown();
      } catch (err) {
        record(err);
      }
    }
    rooms.clear();
  };

  ws.on('message', onMessage);
  ws.on('close', shutdown);
  ws.on('error', shutdown);

  return {
    workspaceId,
    stats,
    /** Rooms currently live on this socket. */
    get roomCount() { return rooms.size; },
    roomNames() { return [...rooms.keys()].sort(); },
    /** Test/diagnostic: the docName a given room resolves to on this socket. */
    docNameFor(room) { return `${workspaceId}/${room}`; },
    shutdown,
  };
}

/**
 * The frame codec, exported so a client (and every test) speaks exactly what the
 * server reads rather than a second, hand-rolled copy of it.
 * Frame = `varString(room) + varUint8Array(payload)`.
 */
export function encodeMuxFrame(room, payload) {
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, room);
  encoding.writeVarUint8Array(enc, payload);
  return encoding.toUint8Array(enc);
}

/** The inverse. Throws on a frame that does not decode; callers drop those. */
export function decodeMuxFrame(bytes) {
  const dec = decoding.createDecoder(toBytes(bytes));
  const room = decoding.readVarString(dec);
  const payload = decoding.readVarUint8Array(dec);
  return { room, payload };
}
