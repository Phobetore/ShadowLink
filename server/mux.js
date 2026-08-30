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

/**
 * Snapshot writes the close fan-out may have in flight AT ONCE, across the whole
 * process.
 *
 * Dropping a mux socket closes every room on it, and `DocHub`'s existing
 * flush-on-last-peer-left turns each of those into a snapshot write. Issued all
 * at once that is one open file descriptor per room, and file descriptors are a
 * hard, PROCESS-wide limit: measured at the shipped room cap, a single socket
 * dropping 8,192 rooms put 8,192 writes in flight, hit EMFILE, and left 8,189 of
 * 8,192 snapshots on disk — the tail of three rooms lost, reported only into a
 * `DocHub.lastPersistError` map nothing in `server/` ever read. Twenty sockets
 * dropping 500 rooms each lost 1,811 of 10,000.
 *
 * So the budget is shared by every socket in the process rather than held per
 * socket: twenty bounded fan-outs of 64 would still be 1,280 descriptors, past
 * the 1,024 a stock Linux `ulimit -n` allows.
 *
 * 64 is far under every such limit and costs nothing in wall clock — the work is
 * serialized by `DocHub._persistChain` per room and by libuv's thread pool
 * across rooms long before 64 is reached. Measured at the cap, the bounded
 * fan-out is FASTER than the unbounded one it replaces: 4.35 s against 5.06 s
 * for 8,192 rooms, and 3.43 s against 5.29 s for 10,000 over twenty sockets.
 */
export const MUX_CLOSE_FANOUT_CONCURRENCY = 64;

// `ws` readyState. CONNECTING 0, OPEN 1, CLOSING 2, CLOSED 3 — the same numbers
// `DocHub._send` branches on, which is what a virtual connection must imitate.
const OPEN = 1;
const CLOSED = 3;

/**
 * The counting semaphore the close fan-out draws its write budget from.
 *
 * `acquire()` returns `null` when a slot was free and took it SYNCHRONOUSLY, and
 * a promise otherwise. That distinction is the point: while the budget is not
 * exhausted a fan-out runs to completion in one turn, exactly as it did before it
 * was bounded, so dropping a socket carrying a handful of rooms is still a
 * synchronous event and every test that asserts on it directly still can. Only a
 * fan-out large enough to matter is staged.
 *
 * Exported as a factory so a test can hold one gate with a small limit and pin
 * the mechanism deterministically, and so two sockets can be handed the SAME gate
 * to show the budget really is shared rather than one budget each.
 */
export function createFanoutGate(limit = MUX_CLOSE_FANOUT_CONCURRENCY) {
  let inFlight = 0;
  let peakInFlight = 0;
  const waiting = [];
  return {
    get limit() { return limit; },
    get inFlight() { return inFlight; },
    /** The most slots ever held at once. Diagnostic, and what a test asserts on. */
    get peakInFlight() { return peakInFlight; },
    acquire() {
      if (inFlight < limit) {
        inFlight += 1;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
        return null;
      }
      return new Promise((resolve) => { waiting.push(resolve); });
    },
    release() {
      // Hand a freed slot straight to the next waiter rather than releasing it
      // and letting the waiter re-take it: the count must never dip, or a burst
      // of releases would let more than `limit` writers through together.
      const next = waiting.shift();
      if (next !== undefined) { next(); return; }
      inFlight -= 1;
    },
  };
}

/** The process-wide budget. Every socket that does not name its own uses this one. */
const SHARED_FANOUT_GATE = createFanoutGate();

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

  /**
   * A send into a room that has already ended is dropped, the way a real `ws`
   * refuses one after its close.
   *
   * ⚠ Not reachable through today's `DocHub`, and pinned by a test regardless.
   * `DocHub._send` checks `readyState` itself, and `_closeConn` removes a
   * connection from `state.conns` BEFORE calling `conn.close()`, so the hub never
   * holds a closed conn to write to. That is the hub's internals doing this
   * file's containment for it — which is why `check-dochub.mjs` pinning that file
   * turns out to be load-bearing for isolation, not only for the relay. The
   * property is asserted against a hub that does write after a close, in
   * "a send into a room that has already closed never reaches the wire".
   */
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

  /**
   * Deliver one payload to this room. One room's throw stays in this room.
   *
   * ⚠ Both guards below are reachable, and each dies to a mutation without the
   * test written for it:
   *
   * - The readyState check. Backpressure can drop the socket from INSIDE the
   *   first send of a room that is still being opened; on a transport whose close
   *   is synchronous the fan-out then closes and flushes that room before
   *   `onMessage` gets back here. Delivering then writes into a room `DocHub` has
   *   already flushed and forgotten — "a room the fan-out already closed is not
   *   delivered into, even mid-open".
   * - The per-handler try/catch. `DocHub` wraps its own message handler
   *   (DocHub.js:112-118), so nothing it registers can throw out of here today.
   *   A handler that does throw must take neither the socket, nor the handlers
   *   after it, nor the other rooms with it — "a message handler that throws
   *   stays in its room, and the next handler still runs".
   */
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
   *
   * ⚠ The idempotence guard is reached on EVERY room of EVERY fan-out:
   * `DocHub._closeConn` calls `conn.close()` from inside the very close handler
   * this loop is running, which re-enters here. A real `ws` fires its close event
   * once, so a virtual one must too — without the guard every registered close
   * handler runs twice, and only `_closeConn`'s own idempotence hides that.
   * Pinned by "a virtual connection fires its close handlers exactly once".
   *
   * `_onGone` is likewise load-bearing rather than bookkeeping: it is the only
   * thing that removes this room from the socket's map, including during the
   * close fan-out, which no longer clears the map behind it.
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
  // The process-wide snapshot-write budget the close fan-out draws on. Injectable
  // so a test can pin the bound at a small number, and so two sockets can be
  // handed the same gate to show the budget is not per socket.
  fanoutGate = SHARED_FANOUT_GATE,
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
    /**
     * Rooms whose close-fan-out snapshot never reached the disk. This is the
     * count `DocHub.lastPersistError` was collecting and nothing was reading —
     * a room here is a room whose tail was lost.
     */
    snapshotsFailed: 0,
    /** The write error behind the last one of those. */
    lastSnapshotError: null,
    /**
     * The most of the SHARED write budget ever occupied while this socket's
     * fan-out was running — its own rooms and every other socket's together,
     * because that is the number the file-descriptor limit answers to.
     */
    peakFanoutInFlight: 0,
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
   * When the snapshot write that closing `room` triggered has landed.
   *
   * `DocHub._closeConn` fires it as `void this.flush(docName)` — no handle comes
   * back — so the only signal that the write finished is the per-docName promise
   * chain the hub keeps. Reading that field is the price of the rule that
   * `DocHub.js` may not be modified: the alternative is calling `hub.flush()` a
   * second time, which writes the same bytes twice. The chain never rejects
   * (`_enqueueWrite` attaches its own catch), and a hub that keeps no chain — a
   * test double — simply does not pace us.
   */
  const roomWriteSettled = (room) => {
    const chain = hub._persistChain;
    if (!(chain instanceof Map)) return Promise.resolve();
    return chain.get(`${workspaceId}/${room}`) ?? Promise.resolve();
  };

  /** The hub's own last write error for a room, if it keeps one. */
  const writeErrorFor = (room) => {
    const errors = hub.lastPersistError;
    return errors instanceof Map ? errors.get(`${workspaceId}/${room}`) : undefined;
  };

  /**
   * Close fan-out. Every room fires its own close, so `DocHub`'s existing
   * flush-on-last-peer-left runs per room, untouched.
   *
   * ⚠ Why this is staged rather than a plain loop, which a measurement forced.
   * One socket per vault means the flush fires for the whole share at once, and a
   * plain loop put one snapshot write in flight PER ROOM: at the shipped room cap
   * that is 8,192 open file descriptors, which hit EMFILE and left 8,189 of 8,192
   * snapshots on disk — the tail of those rooms lost, and reported only into a map
   * nothing read. Twenty sockets dropping 500 rooms each lost 1,811 of 10,000.
   *
   * So the rooms are closed against a budget, and the budget is shared by every
   * socket in the process because file descriptors are. While it is not exhausted
   * `acquire()` returns synchronously and this runs to completion in one turn, so
   * a socket carrying a handful of rooms drops exactly as it did before.
   *
   * `rooms` is not cleared at the end: every `VirtualConn` removes itself through
   * `_onGone` before its close handlers run, so clearing the map afterwards only
   * hid a break in that path from the tests that assert `roomCount === 0` here.
   */
  const drain = async () => {
    const pending = [...rooms.values()];
    const settling = [];
    for (const vconn of pending) {
      const slot = fanoutGate.acquire();
      if (slot !== null) await slot;
      if (fanoutGate.inFlight > stats.peakFanoutInFlight) {
        stats.peakFanoutInFlight = fanoutGate.inFlight;
      }
      const errorBefore = writeErrorFor(vconn.room);
      // `shutdown` contains its own errors — every close handler is individually
      // caught and `_onGone` is a map delete — so one room cannot abort the rest,
      // and there is no catch here pretending to guard something that cannot fire.
      vconn.shutdown();
      settling.push(roomWriteSettled(vconn.room).then(() => {
        const errorAfter = writeErrorFor(vconn.room);
        if (errorAfter !== undefined && errorAfter !== errorBefore) {
          stats.snapshotsFailed += 1;
          stats.lastSnapshotError = errorAfter;
        }
        fanoutGate.release();
      }));
    }
    await Promise.all(settling);
    if (stats.snapshotsFailed > 0) {
      // Content loss, said out loud. Before this line the hub recorded it into
      // `lastPersistError` and nothing in `server/` ever read that map.
      console.error(
        `[mux] ${stats.snapshotsFailed} of ${pending.length} snapshots failed to write`
        + ` when a socket for workspace ${workspaceId} closed`,
        stats.lastSnapshotError,
      );
    }
  };

  /**
   * Every room on this socket is closed and its snapshot has been written, or has
   * failed and been counted. Replaced by the one fan-out this socket ever runs.
   */
  let drained = Promise.resolve();

  const shutdown = () => {
    if (closed) return drained;
    closed = true;
    // A throw would otherwise surface as an unhandled rejection: `drain` awaits,
    // so its caller is the event loop rather than `ws.emit('close')`.
    drained = drain().catch(record);
    return drained;
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
    /** Resolves once the close fan-out has finished. Never rejects. */
    get drained() { return drained; },
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
