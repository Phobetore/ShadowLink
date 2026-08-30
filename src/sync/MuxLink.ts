// src/sync/MuxLink.ts
// The client half of the P3 mux (spec §1.1, §2): ONE WebSocket per vault,
// carrying many rooms, with ONE backoff loop behind it.
//
// WHY THIS FILE EXISTS AT ALL. y-websocket bakes the room into the URL at
// construction — `this.url = serverUrl + '/' + roomname + …` at the installed
// 1.5.4 — so a vault with 2,000 live rooms needs 2,000 sockets, 2,000 awareness
// objects, 2,000 `process.on('exit')` handlers and 2,000 independent reconnect
// loops. That is what makes continuous sync of unopened notes unaffordable, and
// it is why the spec refused the `WebSocketPolyfill` shim (§Rejected 11): tunnelling
// N providers down one socket keeps all N of everything else. This is one link,
// and rooms are subscriptions on it.
//
// WHAT IT IS NOT. It knows nothing about Yjs. A frame is a room name and an
// opaque payload; `MuxRoom` is what puts the y-websocket protocol inside one.
// Keeping the split means the link can be tested for delivery, partition and
// reconnect without a single document, and the protocol can be tested without a
// socket.
//
// THE FRAME, byte-for-byte the server's: `varString(room) + varUint8Array(payload)`
// where the payload is the standard y-websocket message. `server/mux.js` exports
// the same codec; this is the second implementation of it and the structural
// suite is what keeps the two honest, because a codec that drifts is a codec that
// silently addresses the wrong room.
//
// No `obsidian` import, no node builtins.

import {
  MUX_DETECT_TIMEOUT_MS,
  MUX_RECONNECT_BACKOFF_MS,
  MUX_RECONNECT_JITTER,
} from '../tree/constants.ts';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

/**
 * The docId that selects the mux route, matching `server/mux.js`'s `MUX_DOC_ID`.
 *
 * It is a plain docId on purpose: the pre-P3 upgrade's `DOC_RE` already accepts
 * it, so the route needed no grammar change — which is exactly why an old server
 * accepts this URL instead of refusing it, and why detection cannot be "did the
 * socket open". See `legacyEvidence` below.
 */
export const MUX_DOC_ID = '_mux';

/** `WebSocket.OPEN`, spelled out so this module needs no DOM constant at runtime. */
const WS_OPEN = 1;

// ============================================================ the frame codec

/** Frame = `varString(room) + varUint8Array(payload)`. */
export function encodeMuxFrame(room: string, payload: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, room);
  encoding.writeVarUint8Array(enc, payload);
  return encoding.toUint8Array(enc);
}

export interface MuxFrame {
  readonly room: string;
  readonly payload: Uint8Array;
}

/**
 * The inverse, returning NULL rather than throwing on anything that is not
 * exactly one frame.
 *
 * ⚠ TRAILING BYTES ARE A DECODE FAILURE, and that is not pedantry — it is half
 * the legacy detector. Measured against a server checked out from before the P3
 * work: it accepts the `/_mux` upgrade, serves it as an ordinary room, and sends
 * a raw y-websocket SyncStep1 of `[0x00, 0x00, 0x01, 0x00]`. Read as a frame
 * that is a zero-length room name, a zero-length payload — and two bytes left
 * over. Without this check the client would take a pre-P3 server's first message
 * as a well-formed frame for a room called `""`.
 *
 * `encodeMuxFrame` and `server/mux.js` both write exactly these two fields and
 * nothing after them, so a real frame never has a tail.
 */
export function decodeMuxFrame(bytes: Uint8Array): MuxFrame | null {
  try {
    const dec = decoding.createDecoder(bytes);
    const room = decoding.readVarString(dec);
    const payload = decoding.readVarUint8Array(dec);
    if (dec.pos !== bytes.byteLength) return null;          // see above
    return { room, payload };
  } catch {
    return null;
  }
}

// ============================================================ the socket surface

/**
 * What a WebSocket must provide. Structurally satisfied by the browser's
 * `WebSocket`, by Obsidian's, and by `ws` — and small enough that `FakeMux`
 * supplies one with no network at all.
 *
 * Handlers are ASSIGNED rather than added, which is y-websocket's own shape and
 * the reason `ProviderAck` had to document that it sits alongside them: assigning
 * is what makes "this link owns this socket" unambiguous.
 */
export interface MuxSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType?: string;
  send(data: Uint8Array): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export type MuxSocketFactory = (url: string) => MuxSocket;

export type MuxStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * One room's side of the link. Every method is scoped to that room; there is no
 * way to reach another one through a subscription, which is the containment the
 * "delivers each room's frames to that room and no other" rule needs.
 */
export interface MuxSubscription {
  readonly room: string;
  /** Write one y-websocket payload into this room. False if it did not go. */
  send(payload: Uint8Array): boolean;
  /** Stop delivering, and forget this room. Idempotent. */
  unsubscribe(): void;
}

export interface MuxRoomHandler {
  /** The link is up and this room may (re)handshake. Fires on every connect. */
  onOpen?(): void;
  onPayload(payload: Uint8Array): void;
  /** The link went away. Fires once per connection that was open. */
  onClose?(): void;
}

export interface MuxLinkConfig {
  /** `ws://host:port`, with or without a trailing slash. */
  serverUrl: string;
  serverKey: string;
  workspaceId: string;
  /** Defaults to the ambient `WebSocket`. Injected by tests and by `FakeMux`. */
  openSocket?: MuxSocketFactory;
  backoffMs?: readonly number[];
  jitter?: number;
  detectTimeoutMs?: number;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Why the client concluded the peer is not a mux server. Reported so the fallback
 * can say something true, and so a test can tell the two apart rather than
 * asserting on "it fell back somehow".
 */
export type MuxUnsupportedReason =
  /** A message arrived that is not a well-formed frame for a room we subscribed. */
  | 'not-a-frame'
  /** The socket connected, we sent frames, and nothing mux-shaped ever came back. */
  | 'silent';

// ============================================================ MuxLink

export class MuxLink {
  private readonly config: MuxLinkConfig;
  private readonly openSocket: MuxSocketFactory;
  private readonly backoff: readonly number[];
  private readonly jitter: number;
  private readonly detectTimeoutMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly rooms = new Map<string, MuxRoomHandler>();

  /**
   * Every room name ever subscribed on this link, never pruned.
   *
   * ⚠ Not the same set as `rooms`, and the difference is a correctness rule.
   * A frame naming a room we never subscribed is evidence the peer is not a mux
   * server (a pre-P3 server's first message decodes as room `""`). A frame for a
   * room we subscribed and then dropped is an ordinary in-flight straggler and
   * says nothing at all. Testing the live map would turn every unsubscribe into a
   * race that can tear the whole topology down.
   */
  private readonly everSubscribed = new Set<string>();

  private socket: MuxSocket | null = null;
  private status: MuxStatus = 'disconnected';
  private readonly statusHandlers = new Set<(status: MuxStatus) => void>();
  private readonly unsupportedHandlers = new Set<(reason: MuxUnsupportedReason) => void>();

  private attempt = 0;
  private retryHandle: unknown = null;
  private detectHandle: unknown = null;

  private shouldConnect = false;
  private destroyed = false;

  /**
   * Latched TRUE the first time this server answers in the frame protocol.
   *
   * Once a server has proven it speaks the mux, a later silent or malformed
   * socket is a network fault, not an old server — and tearing the whole
   * transport down and rebuilding it as the legacy topology on a flaky reconnect
   * would be a far worse outcome than one slow reconnect.
   */
  private spokeMux = false;

  /** Latched once, so the fallback is armed exactly one time. */
  private unsupported: MuxUnsupportedReason | null = null;

  /** Frames sent on the CURRENT socket. `silent` only means anything above zero. */
  private framesSentOnSocket = 0;

  readonly stats = {
    socketsOpened: 0,
    framesIn: 0,
    framesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    /** Messages that were not a frame for a room this link ever subscribed. */
    droppedInbound: 0,
    /** Sends made while the link was down. */
    droppedOutbound: 0,
    reconnects: 0,
  };

  constructor(config: MuxLinkConfig) {
    this.config = config;
    const ambient = (globalThis as { WebSocket?: new (url: string) => MuxSocket }).WebSocket;
    this.openSocket = config.openSocket
      ?? ((url: string): MuxSocket => {
        if (ambient === undefined) throw new Error('MuxLink: no WebSocket available');
        return new ambient(url);
      });
    this.backoff = config.backoffMs ?? MUX_RECONNECT_BACKOFF_MS;
    this.jitter = config.jitter ?? MUX_RECONNECT_JITTER;
    this.detectTimeoutMs = config.detectTimeoutMs ?? MUX_DETECT_TIMEOUT_MS;
    this.now = config.now ?? Date.now;
    this.random = config.random ?? Math.random;
    this.setTimer = config.setTimer
      ?? ((fn, ms): unknown => setTimeout(fn, ms));
    this.clearTimer = config.clearTimer
      ?? ((handle): void => { clearTimeout(handle as ReturnType<typeof setTimeout>); });
  }

  /**
   * `${serverUrl}/_mux?t=…&w=…` — the SAME query the per-room route takes, because
   * the socket is authenticated once by the same `authorizeUpgrade` every other
   * socket faces (spec §4). Strictly fewer auth checks than today, same guarantee.
   */
  get url(): string {
    let base = this.config.serverUrl;
    while (base.endsWith('/')) base = base.slice(0, -1);
    const t = encodeURIComponent(this.config.serverKey);
    const w = encodeURIComponent(this.config.workspaceId);
    return `${base}/${MUX_DOC_ID}?t=${t}&w=${w}`;
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WS_OPEN;
  }

  /** The shared socket, for `MuxRoom`'s per-room `AckSocket` view. */
  get rawSocket(): MuxSocket | null {
    return this.connected ? this.socket : null;
  }

  /** NULL while the link is still viable; the reason once it is not. */
  get unsupportedReason(): MuxUnsupportedReason | null {
    return this.unsupported;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  roomNames(): string[] {
    return [...this.rooms.keys()].sort();
  }

  // ---------------------------------------------------------- subscription

  /**
   * Take `room` onto this link.
   *
   * Subscribing does not send anything by itself: the handshake is `MuxRoom`'s,
   * driven by `onOpen`, which fires immediately when the link is already up and
   * on every later connect. That is what makes reconnect a re-handshake of every
   * subscribed room (I24) rather than a special case somebody has to remember.
   */
  subscribe(room: string, handler: MuxRoomHandler): MuxSubscription {
    if (this.rooms.has(room)) {
      throw new Error(`MuxLink: ${room} is already subscribed on this link`);
    }
    this.rooms.set(room, handler);
    this.everSubscribed.add(room);
    let live = true;

    const subscription: MuxSubscription = {
      room,
      send: (payload) => (live ? this.send(room, payload) : false),
      unsubscribe: () => {
        if (!live) return;
        live = false;
        // Only if it is still OURS: a resubscribe of the same name after this
        // one was dropped must not be unsubscribed by the old handle.
        if (this.rooms.get(room) === handler) this.rooms.delete(room);
      },
    };

    if (this.connected) handler.onOpen?.();
    return subscription;
  }

  /** Write one payload into `room`. False when the link is down or the send threw. */
  send(room: string, payload: Uint8Array): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WS_OPEN) {
      this.stats.droppedOutbound += 1;
      return false;
    }
    const frame = encodeMuxFrame(room, payload);
    try {
      socket.send(frame);
    } catch {
      // A send that throws is the socket's problem, not this room's: the close
      // event is what tears the link down and schedules the retry.
      this.stats.droppedOutbound += 1;
      return false;
    }
    this.stats.framesOut += 1;
    this.stats.bytesOut += frame.byteLength;
    this.framesSentOnSocket += 1;
    return true;
  }

  // ---------------------------------------------------------- observers

  onStatus(handler: (status: MuxStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => { this.statusHandlers.delete(handler); };
  }

  /**
   * The server does not speak the mux. Fires AT MOST ONCE per link, and the link
   * is dead by the time it does: the socket is closed, the backoff loop is
   * stopped, and every room has been told the link is gone.
   *
   * A handler registered after the verdict is called immediately, because
   * "the fallback was wired a tick late" must not mean "the fallback never ran".
   */
  onUnsupported(handler: (reason: MuxUnsupportedReason) => void): () => void {
    if (this.unsupported !== null) {
      handler(this.unsupported);
      return () => undefined;
    }
    this.unsupportedHandlers.add(handler);
    return () => { this.unsupportedHandlers.delete(handler); };
  }

  // ---------------------------------------------------------- lifecycle

  connect(): void {
    if (this.destroyed || this.unsupported !== null) return;
    this.shouldConnect = true;
    if (this.socket !== null || this.retryHandle !== null) return;
    this.open();
  }

  /** Stop connecting and drop the socket. `connect()` revives it. */
  disconnect(): void {
    this.shouldConnect = false;
    this.cancelRetry();
    this.dropSocket();
  }

  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.rooms.clear();
    this.statusHandlers.clear();
    this.unsupportedHandlers.clear();
  }

  // ---------------------------------------------------------- internals

  private open(): void {
    if (this.destroyed || !this.shouldConnect || this.socket !== null) return;
    this.setStatus('connecting');
    this.framesSentOnSocket = 0;

    let socket: MuxSocket;
    try {
      socket = this.openSocket(this.url);
    } catch {
      // A factory that refuses outright is an unsuccessful attempt like any
      // other; the ladder is what keeps it from becoming a spin.
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    this.stats.socketsOpened += 1;
    try {
      socket.binaryType = 'arraybuffer';
    } catch {
      /* a fake, or a transport with no such knob */
    }

    socket.onopen = (): void => { this.onOpen(socket); };
    socket.onmessage = (event): void => { this.onMessage(socket, event); };
    socket.onclose = (): void => { this.onClose(socket); };
    socket.onerror = (): void => {
      // `ws` and the browser both follow an error with a close, so there is
      // nothing to do here that `onClose` does not already do — and doing it
      // twice is what turns one failed attempt into two rungs of backoff.
    };

    // A socket handed over already open (a fake, or a reused transport) never
    // fires `onopen`, and a link that waited for it would never handshake.
    if (socket.readyState === WS_OPEN) this.onOpen(socket);
  }

  private onOpen(socket: MuxSocket): void {
    if (socket !== this.socket) return;
    this.attempt = 0;
    this.armDetect();
    // Every subscribed room re-handshakes, in subscription order. I24: the room
    // asks from the state vector of the bytes it holds, and nothing is marked
    // synced on a handshake that did not complete.
    for (const handler of [...this.rooms.values()]) {
      try {
        handler.onOpen?.();
      } catch {
        /* one room's handshake may not abort the others' */
      }
    }
    // ⚠ AFTER the handshakes, and the order is load-bearing twice over. A room
    // builds its fresh `ProviderAck` socket view inside `onOpen`, and the ack
    // re-reads that view from the status transition — announcing first would
    // point it at the view of the socket that just died. And `main.ts` runs
    // `onReconnect` from this transition, which should find the tree already
    // asking rather than about to.
    this.setStatus('connected');
  }

  private onMessage(socket: MuxSocket, event: { data?: unknown }): void {
    if (socket !== this.socket) return;
    const bytes = toBytes(event.data);
    if (bytes === null) return;
    this.stats.framesIn += 1;
    this.stats.bytesIn += bytes.byteLength;

    const frame = decodeMuxFrame(bytes);
    if (frame === null || !this.everSubscribed.has(frame.room)) {
      this.stats.droppedInbound += 1;
      // ⚠ THE DETECTOR, and it is a positive test rather than a timeout. A
      // pre-P3 server accepts this upgrade and immediately writes a raw
      // y-websocket SyncStep1, which is not a frame for anything we asked for.
      // Measured against a server checked out from before the P3 work: it opens,
      // sends `[0,0,1,0]`, and then ignores every frame we send, forever.
      this.noteLegacyEvidence('not-a-frame');
      return;
    }

    // The peer answered in the protocol. From here a silent or malformed socket
    // is a network fault, never an old server.
    this.spokeMux = true;
    this.cancelDetect();

    const handler = this.rooms.get(frame.room);
    if (handler === undefined) return;      // unsubscribed while in flight
    try {
      handler.onPayload(frame.payload);
    } catch {
      // One room's handler may not take the link down with it. The server half
      // makes the same promise per virtual connection, for the same reason.
    }
  }

  private onClose(socket: MuxSocket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.cancelDetect();
    // Rooms first, status second — the mirror of `onOpen`, so an observer that
    // reads a room from the status transition sees a room that already knows.
    for (const handler of [...this.rooms.values()]) {
      try {
        handler.onClose?.();
      } catch {
        /* teardown is not optional */
      }
    }
    this.setStatus('disconnected');
    if (this.unsupported !== null || !this.shouldConnect) return;
    this.stats.reconnects += 1;
    this.scheduleRetry();
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.cancelDetect();
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
    for (const handler of [...this.rooms.values()]) {
      try {
        handler.onClose?.();
      } catch {
        /* teardown is not optional */
      }
    }
    this.setStatus('disconnected');
  }

  /**
   * ONE ladder for the whole link (spec §2), jittered.
   *
   * The rung is chosen by how many attempts have failed since the last open, and
   * the jitter is what stops a share's worth of devices coming back from a
   * network outage in lockstep on every rung.
   */
  private scheduleRetry(): void {
    if (this.destroyed || !this.shouldConnect || this.retryHandle !== null) return;
    const rung = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 1_000;
    this.attempt += 1;
    const spread = rung * this.jitter;
    const delay = Math.max(0, Math.round(rung + (this.random() * 2 - 1) * spread));
    this.retryHandle = this.setTimer(() => {
      this.retryHandle = null;
      this.open();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryHandle === null) return;
    this.clearTimer(this.retryHandle);
    this.retryHandle = null;
  }

  /**
   * The backstop half of detection: a peer that accepted the socket, took our
   * frames and said nothing at all. The positive test above is what catches a
   * pre-P3 server in one round trip; this catches a peer that is not even that.
   */
  private armDetect(): void {
    this.cancelDetect();
    if (this.spokeMux || this.detectTimeoutMs <= 0) return;
    this.detectHandle = this.setTimer(() => {
      this.detectHandle = null;
      // Only a socket we actually WROTE to can be called silent. A link with no
      // rooms yet has asked nothing and is owed no answer.
      if (this.spokeMux || !this.connected || this.framesSentOnSocket === 0) return;
      this.noteLegacyEvidence('silent');
    }, this.detectTimeoutMs);
  }

  private cancelDetect(): void {
    if (this.detectHandle === null) return;
    this.clearTimer(this.detectHandle);
    this.detectHandle = null;
  }

  private noteLegacyEvidence(reason: MuxUnsupportedReason): void {
    if (this.spokeMux || this.unsupported !== null || this.destroyed) return;
    this.unsupported = reason;
    this.shouldConnect = false;
    this.cancelRetry();
    this.dropSocket();
    const handlers = [...this.unsupportedHandlers];
    this.unsupportedHandlers.clear();
    for (const handler of handlers) {
      try {
        handler(reason);
      } catch {
        /* a fallback that throws must not leave the others unrun */
      }
    }
  }

  private setStatus(next: MuxStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const handler of [...this.statusHandlers]) {
      try {
        handler(next);
      } catch {
        /* an observer may not break the link */
      }
    }
  }
}

/**
 * Whatever the transport handed us, as a `Uint8Array` — or NULL for anything that
 * is not binary at all.
 *
 * A Node `Buffer` is a view into a POOLED ArrayBuffer at a non-zero byteOffset,
 * so the offset and length have to be respected. `server/mux.js` copies for the
 * same reason and says so.
 */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}
