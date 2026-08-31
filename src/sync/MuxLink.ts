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
  MUX_CONNECT_TIMEOUT_MS,
  MUX_DIAL_PATIENCE,
  MUX_IDLE_TIMEOUT_MS,
  MUX_RECONNECT_BACKOFF_MS,
  MUX_RECONNECT_JITTER,
  MUX_UNREACHABLE_DIALS,
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
  /**
   * The link has heard nothing for half the idle timeout and wants proof of life.
   *
   * The room's job is to write something the SERVER will answer. It has to be the
   * room's job because the link knows no protocol: a frame is a name and opaque
   * bytes. `MuxRoom` touches its own awareness, which `DocHub` echoes back to the
   * sender — the same heartbeat y-websocket's watchdog is fed by, driven from the
   * link's one timer instead of one interval per room.
   */
  onProbe?(): void;
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
  /** Zero disables the liveness watchdog. Only a test that owns the clock should. */
  idleTimeoutMs?: number;
  /**
   * The FIRST rung of the dial-patience ladder. Zero disables the connect
   * timeout altogether, and that is true again: nothing raises this any more.
   */
  connectTimeoutMs?: number;
  unreachableDials?: number;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Why the client concluded the peer is not a mux server. Reported so the fallback
 * can say something true, and so a test can tell the two apart rather than
 * asserting on "it fell back somehow".
 *
 * ⚠ SILENCE IS NEVER A VERDICT, and there used to be a third member here that
 * was one. `'silent'` fired when a connected socket had been written to and had
 * said nothing for ten seconds. It condemned the route for the whole session and
 * showed the user "your server is older than this plugin" — measured FALSE and
 * reachable on any reconnect: the shipped server behind a proxy that passes the
 * 101 through and holds the server's first frame for 12 s on the second
 * connection only. The link synced over `/_mux` in 11 ms with two frames in, one
 * ordinary RST followed, and 11,299 ms later the route the server had just
 * proved it speaks was condemned for the session.
 *
 * ⚠ AND NEITHER IS A STOPWATCH. The other absence-shaped verdict was reached
 * from dials that ran out of time, and three rounds of arithmetic could not make
 * that fair: a fixed 4 s bound demoted any path slower than 4 s, and a bound
 * widened to twice the legacy probe's own connect still demoted a
 * variable-latency path — measured, a server serving `/_mux` normally behind a
 * proxy drawing 75% of its connections from 5.5–8.5 s and 25% from 1.2–2.2 s
 * reached a permanent false `unreachable` at 14,527 ms. There is no fair
 * threshold, because the dial that draws 8 s and the probe that draws 1.2 s are
 * the same path. A dial that THIS CLIENT ended may no longer condemn anything.
 *
 * A route may be condemned only by POSITIVE evidence — the peer or the path said
 * something that proves this route is not served. Everything else is a retry, and
 * the retry for a socket that is open and saying nothing is the liveness
 * watchdog, which closes it at `MUX_IDLE_TIMEOUT_MS` and lets the ladder dial
 * again. This is the same rule as the invariant the project already lives by,
 * that absence of evidence is never a delete, applied to a transport.
 */
export type MuxUnsupportedReason =
  /** A message arrived that is not a well-formed frame for a room we subscribed. */
  | 'not-a-frame'
  /**
   * The `/_mux` route was REFUSED, repeatedly, while the server itself answers on
   * the per-room route. A 404 at the upgrade, a proxy that only knows the routes
   * it was configured for.
   *
   * ⚠ REFUSED, not merely unanswered, and the difference is the whole of what
   * this round changed. The evidence under this reason is a run of dials the PATH
   * ended — an error or a close on a socket that never opened — which is
   * something the network said about this route. A dial the client abandoned at
   * its own deadline is not evidence and is not counted: a black-holed upgrade
   * and an arbitrarily slow path are the same observation, and one of them is a
   * working server.
   *
   * ⚠ Only the BRIDGE may conclude this one, and only once it has proved the
   * per-room route works — `MuxLink` cannot tell a refused upgrade from a server
   * that is down, because a browser `WebSocket` deliberately reports both as a
   * bare close. `MuxLink` reports the evidence (`onUnreachable`); it never
   * latches this reason by itself, and it stops reporting it entirely once the
   * route has served this link a frame.
   */
  | 'unreachable';

/**
 * What a report on `onUnreachable` is made of.
 *
 * Both kinds ask the bridge to go and LOOK — ignorance is a reason to gather
 * evidence, which is what deleting the last absence-verdict took away and what
 * this restores. Only one of them may end in a verdict.
 */
export type MuxRouteEvidence =
  /** Dials the PATH ended without opening: an error, a close, a 404 upgrade. */
  | 'refused'
  /** Dials this client abandoned, or an open socket that never said anything. */
  | 'unanswered';

// ============================================================ MuxLink

export class MuxLink {
  private readonly config: MuxLinkConfig;
  private readonly openSocket: MuxSocketFactory;
  private readonly backoff: readonly number[];
  private readonly jitter: number;
  private readonly idleTimeoutMs: number;
  /** The FIRST rung of the dial-patience ladder. Nothing may raise it. */
  private readonly connectTimeoutMs: number;
  private readonly unreachableDials: number;
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
  private readonly unreachableHandlers = new Set<(evidence: MuxRouteEvidence) => void>();
  private readonly servedHandlers = new Set<() => void>();

  private attempt = 0;
  private retryHandle: unknown = null;
  private idleHandle: unknown = null;
  private connectHandle: unknown = null;

  private shouldConnect = false;
  private destroyed = false;

  /**
   * TRUE once THIS socket has answered in the frame protocol.
   *
   * ⚠ PER SOCKET, not per link, and the difference is a measured one. It used to
   * latch for the life of the link, on the argument that a flaky reconnect must
   * not rebuild the whole topology as the legacy one. That argument is right and
   * this still serves it — a genuine mux server re-proves itself in one round
   * trip on every reconnect — but a link-wide latch cannot tell a flaky reconnect
   * from a DIFFERENT SERVER on the other end. Measured: a current server, then
   * stopped, then a pre-P3 server started on the same port and the same data dir;
   * the ladder reconnected in 180 ms, the client stayed in mux mode, the bridge
   * built for exactly that server sat unused, and nothing ever synced again,
   * silently, until Obsidian was restarted.
   *
   * Judging each socket on its own behaviour separates the two: a reconnect to a
   * server that still speaks mux latches again immediately, and a reconnect to
   * one that does not is detected in the same round trip a first connect is.
   */
  private socketSpokeMux = false;

  /**
   * TRUE once ANY socket on this link has answered in the frame protocol.
   *
   * ⚠ LINK-LIFETIME, and it is the other half of "silence is never a verdict".
   * `socketSpokeMux` is per socket because the peer may be a different process
   * after a reconnect, and that is right for the POSITIVE `not-a-frame` verdict:
   * a rolled-back server says `[0,0,1,0]` on the new socket and is caught in one
   * round trip. But the ABSENCE of an answer says nothing about the peer, so once
   * this route has served this link even once, no later silence and no later run
   * of failed dials may condemn it. Measured: a 4.5 s-delay proxy in front of the
   * shipped server serving `/_mux` normally demoted the session at 14,952 ms,
   * with a sentence blaming a proxy that was forwarding every path.
   */
  private routeEverServed = false;

  /**
   * TRUE once the bridge has proved the server answers on the per-room route
   * while THIS route has never served a frame.
   *
   * ⚠ A FACT, RECORDED — never a verdict, and nothing branches on it except the
   * sentence the user reads. It is the answer to what deleting the last
   * absence-verdict left behind: `/_mux` upgrades, the 101 passes through, every
   * server frame on it is dropped with no FIN and no RST, and the client sits
   * there with sockets open and frames going out. Measured on the parent branch
   * through exactly that proxy: 70 s, 3 sockets, 2 idle closures, 18 frames out,
   * 0 in, no verdict, no notice, no probe ever built, the tree never synced and
   * the status bar reading "ShadowLink could not reach the workspace" — which is
   * true about this device's reach and tells the user nothing they can act on.
   *
   * What IS available without any inference is what this records: the server
   * answers, and this route has never delivered anything. The user gets that
   * sentence and a lever, not a guess about their deployment.
   */
  private serverAnswersElsewhere = false;

  /** When the current socket last received ANYTHING. Zero while it is down. */
  private lastInboundAt = 0;

  /**
   * Dials in a row the PATH ended without opening. Reset by any open, and by any
   * dial this client abandoned.
   *
   * ⚠ Separate from `abandonedDials` because only this one may reach a verdict.
   */
  private refusedDials = 0;

  /**
   * Dials in a row this client ended at its own deadline. Reset by any open.
   *
   * ⚠ IT DRIVES THE LADDER AND NOTHING ELSE. It picks the next rung of
   * `MUX_DIAL_PATIENCE` and it is published as `stats.dialsAbandoned`, which is a
   * current state anyone may read. It reaches no handler, no report and no
   * sentence: an expired deadline may make this client wait longer and try again,
   * and may be looked at, but it may not leave a conclusion about the route
   * behind it.
   */
  private abandonedDials = 0;

  /** When the dial in flight was started, so `immediate` knows what it has had. */
  private dialStartedAt = 0;

  /** Which room `onProbe` goes to next, so one dead room cannot mask a live link. */
  private probeCursor = 0;

  /** Whether the CURRENT socket ever reached OPEN. Read once, on its close. */
  private socketOpened = false;

  /** Latched once, so the fallback is armed exactly one time. */
  private unsupported: MuxUnsupportedReason | null = null;

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
    /** Dials that never produced an open socket, of either kind. */
    dialsFailed: 0,
    /** …of which the PATH ended: an error, a close, a refused upgrade. */
    dialsRefused: 0,
    /** …and of which this client abandoned at its own deadline. */
    dialsAbandoned: 0,
    /** Sockets closed by the liveness watchdog: OPEN, and dead. */
    idleClosures: 0,
    /** Sockets dropped because something on top of the link asked for a fresh one. */
    recycles: 0,
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
    this.idleTimeoutMs = config.idleTimeoutMs ?? MUX_IDLE_TIMEOUT_MS;
    this.connectTimeoutMs = config.connectTimeoutMs ?? MUX_CONNECT_TIMEOUT_MS;
    this.unreachableDials = config.unreachableDials ?? MUX_UNREACHABLE_DIALS;
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

  /** TRUE once this route has answered this link in the framing, ever. */
  get everServed(): boolean {
    return this.routeEverServed;
  }

  /**
   * TRUE while enough dials IN A ROW have been ended by the path, on a route that
   * has never served. The one thing the bridge may turn into a verdict.
   *
   * ⚠ IN A ROW MEANS IN A ROW. The run is broken by a socket that opens and by a
   * dial this client abandoned, so what this reports is a contiguous stretch of
   * the path saying no — not a tally of refusals with the client's own deadlines
   * interleaved through it.
   */
  get routeRefused(): boolean {
    return !this.routeEverServed && this.refusedDials >= this.unreachableDials;
  }

  /**
   * TRUE while the server is known to answer elsewhere and this route has still
   * delivered nothing. What the status bar says out loud; never a verdict.
   *
   * It clears itself the moment a frame arrives, because `routeEverServed` is
   * what it is asserted against — nothing here latches on its own.
   */
  get routeUnserved(): boolean {
    return this.serverAnswersElsewhere && !this.routeEverServed;
  }

  /**
   * How long the dial in flight — or the next one — has to produce an OPEN
   * socket. A rung of the patience ladder, never a measurement of anything.
   */
  get dialTimeoutMs(): number {
    if (this.connectTimeoutMs <= 0) return 0;
    const rungs = MUX_DIAL_PATIENCE;
    const rung = rungs[Math.min(this.abandonedDials, rungs.length - 1)] ?? 1;
    return this.connectTimeoutMs * rung;
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

  /**
   * This route has produced nothing, and here is what that looked like. Fires
   * repeatedly, never latches, and NEVER stops the ladder.
   *
   * It is evidence, not a verdict: a refused `/_mux` upgrade and a server that is
   * simply down are the same bare close through a browser `WebSocket`. Only
   * something that can also try the per-room route — the bridge — can tell them
   * apart, which is why this reports rather than concludes.
   *
   * ⚠ TWO SHAPES REACH IT, AND BOTH ARE SOMETHING THAT HAPPENED. A run of dials
   * the path REFUSED, which carries `'refused'` and is the only one that may end
   * in a verdict; and a socket that OPENED, was written to and was closed by the
   * liveness watchdog having said nothing, on a route that has never served,
   * which carries `'unanswered'` and may only ever be described.
   *
   * ⚠ A THIRD USED TO, AND IT WAS A BACK DOOR. A run of dials this client
   * abandoned at its own deadline reported here too, and through the bridge it
   * reached a permanent user-facing sentence about the route with no socket, no
   * frame and no byte behind it. See `noteFailedDial` for what that measured
   * against a healthy server behind 13 s of latency. Nothing an expired deadline
   * touches reports here any more.
   */
  onUnreachable(handler: (evidence: MuxRouteEvidence) => void): () => void {
    this.unreachableHandlers.add(handler);
    return () => { this.unreachableHandlers.delete(handler); };
  }

  /**
   * This route DELIVERED something. Fires at most once per link, immediately for
   * a handler registered after the fact.
   *
   * ⚠ THE SETTLING EVENT IS A FRAME, NOT AN OPEN SOCKET, and that distinction
   * cost a real defect. The bridge used to throw its probe away the moment the
   * mux status went `connected`, on the argument that an open socket settles the
   * question the probe was asking. It does not: a route can upgrade and then
   * carry nothing, which is the exact shape the probe exists to describe.
   * Measured against a real server behind a proxy that upgrades `/_mux` and drops
   * every frame — the socket opened every 1.6 s, each open destroyed the probe
   * before it could answer, and a fresh `WebsocketProvider` was built in its
   * place for ever while the user was told nothing.
   */
  onServed(handler: () => void): () => void {
    if (this.routeEverServed) {
      handler();
      return () => undefined;
    }
    this.servedHandlers.add(handler);
    return () => { this.servedHandlers.delete(handler); };
  }

  // ---------------------------------------------------------- lifecycle

  /**
   * Ask the link to be up.
   *
   * `immediate` cancels whatever rung is waiting and dials NOW, and it exists
   * because the ladder was protecting the wrong thing. The rung stops the RETRY
   * LOOP from hammering a server that is down; it has no business making a
   * person wait. Measured before it existed: a 30-second outage cost the mux
   * 52,703 ms to resync where a `WebsocketProvider` on the same server took
   * 649 ms, which is past `TREE_SYNC_TIMEOUT_MS` and therefore a read-only
   * banner against a server that is up.
   *
   * `Bootstrap.connectTree` is the caller that passes it: somebody is waiting.
   * The loop itself never does.
   *
   * ⚠ IT ALSO JUMPS A DIAL THAT HAS ALREADY HAD THE FIRST RUNG, and without that
   * clause it was inert exactly when it mattered. `open()` assigns `this.socket`
   * before the socket opens and this method returns early while one exists, so a
   * dial parked on a widened deadline swallowed every immediate request behind
   * it: measured on the previous round, where the deadline could reach a minute,
   * an eight-second black hole left a client read-only for 48,037 ms of which
   * 40,063 ms were after the path had fully recovered.
   *
   * The FIRST rung is left alone on purpose. A dial that has not yet had the
   * ordinary allowance may simply be on a slow path, and killing it to start an
   * identical one is the bias the patience ladder exists to remove.
   */
  connect(options: { immediate?: boolean } = {}): void {
    if (this.destroyed || this.unsupported !== null) return;
    this.shouldConnect = true;
    if (this.socket !== null) {
      if (options.immediate !== true || this.socketOpened) return;
      if (this.connectTimeoutMs <= 0) return;
      if (this.now() - this.dialStartedAt < this.connectTimeoutMs) return;
      this.dropSocket();
      this.attempt = 0;
      this.open();
      return;
    }
    if (this.retryHandle !== null) {
      if (options.immediate !== true) return;
      this.cancelRetry();
      this.attempt = 0;
    }
    this.open();
  }

  /**
   * Throw this socket away and dial a fresh one.
   *
   * The one caller is a room whose acknowledgement accounting has become
   * unusable on a live socket (see `ProviderAck`). A new socket is the only reset
   * that is provably clean — no reply to a question asked on the old one can
   * arrive on it — so "start again" is spelled as a reconnect rather than as a
   * counter being cleared underneath frames that are still in flight.
   */
  recycle(): void {
    if (this.destroyed || this.socket === null) return;
    this.stats.recycles += 1;
    this.closeCurrentSocket();
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
    this.unreachableHandlers.clear();
    this.servedHandlers.clear();
  }

  /**
   * Conclude, from OUTSIDE, that this link's route is not served.
   *
   * The bridge calls this once it has proved the per-room route works while
   * `/_mux` will not open. It runs the same teardown the two first-message
   * verdicts do, so there is one way the link dies and one way the fallback is
   * armed.
   */
  markUnsupported(reason: MuxUnsupportedReason): void {
    this.noteLegacyEvidence(reason, { external: true });
  }

  /**
   * Record, from OUTSIDE, that the server answers on the per-room route while
   * this one has delivered nothing.
   *
   * ⚠ THE OTHER THING THE BRIDGE MAY SAY, and it is deliberately not a verdict.
   * The link keeps its ladder, keeps dialling and keeps its rooms; all that
   * changes is that `routeUnserved` becomes readable, and the status bar can
   * stop saying "could not reach the workspace" — which is not what is
   * happening — and say what is: the server answers, nothing comes back here.
   *
   * The bridge calls it in exactly the case it may not conclude from: dials this
   * client abandoned, or a socket that opened and never spoke. Neither is
   * evidence about the route, and neither may condemn it.
   */
  noteRouteUnserved(): void {
    if (this.destroyed || this.routeEverServed) return;
    this.serverAnswersElsewhere = true;
  }

  // ---------------------------------------------------------- internals

  private open(): void {
    if (this.destroyed || !this.shouldConnect || this.socket !== null) return;
    this.setStatus('connecting');
    this.socketSpokeMux = false;

    let socket: MuxSocket;
    try {
      socket = this.openSocket(this.url);
    } catch {
      // A factory that refuses outright is an unsuccessful attempt like any
      // other — and it is a REFUSAL, not a deadline: something said no, at once.
      // The ladder is what keeps it from becoming a spin.
      this.noteFailedDial('refused');
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    this.dialStartedAt = this.now();
    this.stats.socketsOpened += 1;
    this.armConnectTimeout(socket);
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
    // ⚠ BOTH COUNTS, and the second is what keeps the patience ladder from
    // outliving the trouble that raised it. A session that connects once is back
    // at the first rung, so a slow start never becomes a widened deadline carried
    // into a later outage — which is exactly the defect a permanent raise had.
    this.refusedDials = 0;
    this.abandonedDials = 0;
    this.socketOpened = true;
    this.cancelConnectTimeout();
    this.lastInboundAt = this.now();
    this.armIdleWatch();
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
    // ⚠ BEFORE the decode, and deliberately: liveness is a question about the
    // PATH, not about the protocol. Bytes arriving prove the socket is not one of
    // the dead-but-open ones, whatever they turn out to say.
    this.lastInboundAt = this.now();
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
      //
      // The two clauses above are BELT AND BRACES, and that is measured rather
      // than hoped: mutating out either one on its own leaves structural case 80c
      // green — `[0,0,1,0]` has a two-byte tail AND names a room nothing
      // subscribed — while mutating out both makes it fail. With both gone there
      // is NO fallback at all any more: the ten-second backstop that used to
      // catch it was a verdict reached from silence, and it has been removed.
      // These two clauses are now the whole of what may condemn a peer.
      this.noteLegacyEvidence('not-a-frame');
      return;
    }

    // THIS SOCKET's peer answered in the framing. From here a malformed message
    // on THIS socket is a network fault, never an old server — and the next
    // socket has to prove it again, because the peer on the other end of it may
    // be a different process entirely.
    this.socketSpokeMux = true;
    // The route's own record, which no reconnect resets: see `routeEverServed`.
    const first = !this.routeEverServed;
    this.routeEverServed = true;
    if (first) {
      const handlers = [...this.servedHandlers];
      this.servedHandlers.clear();
      for (const handler of handlers) {
        try {
          handler();
        } catch {
          /* an observer may not break the link */
        }
      }
    }

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
    const hadOpened = this.socketOpened;
    this.socket = null;
    this.socketOpened = false;
    this.lastInboundAt = 0;
    this.cancelIdleWatch();
    this.cancelConnectTimeout();
    // A close on a socket that never reached OPEN is a failed DIAL, not a dropped
    // connection — and it is the ONLY shape a refused `/_mux` upgrade has, which
    // is why nothing downstream could see one before this counter existed.
    //
    // ⚠ AND IT IS THE PATH THAT ENDED IT, which is the half that may still reach
    // a verdict. Getting here at all means an error or a close arrived: a 404 at
    // the upgrade, an RST, a refused connection. The client's own deadline never
    // lands here — `armConnectTimeout` unhooks this handler through `dropSocket`
    // before it closes, precisely so the two cannot be confused.
    if (!hadOpened) this.noteFailedDial('refused');
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
    this.socketOpened = false;
    this.lastInboundAt = 0;
    this.cancelIdleWatch();
    this.cancelConnectTimeout();
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    // ⚠ A NO-OP, never null, and the connect timeout is what made this reachable.
    // `ws` emits a bare `error` when `close()` lands on a socket that is still
    // CONNECTING, and an `error` with no handler is an unhandled event that takes
    // the process down. Closing a still-connecting socket is exactly what a
    // connect timeout does, so the handler has to outlive the close.
    socket.onerror = (): void => undefined;
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
    // ⚠ No "a retry is already armed" clause here, and its absence is deliberate.
    // `connect()` owns that invariant — it refuses to dial while a rung is
    // waiting, which is what stops `Bootstrap.connectTree` from hammering a server
    // that is down. A second clause here was unreachable: this is called from
    // `onClose`, which is guarded on socket identity and fires once per socket,
    // and from a failed dial, which never produced a socket to close. A mutation
    // probe deleted it with the whole suite green, so it went the way slice 1's
    // fifth unkillable guard went.
    if (this.destroyed || !this.shouldConnect) return;
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

  // ---------------------------------------------------------- liveness

  /**
   * THE WATCHDOG y-websocket has and `MuxRoom` gave away.
   *
   * A socket can be OPEN and dead: bytes stop moving with no FIN and no RST, and
   * `readyState` never moves, so `connected`, `synced` and every caller that
   * branches on them go on saying the vault is fine. `MuxRoom`'s header removed
   * the 30-second check on the argument that "liveness is the link's business and
   * only the link's" — correct, and this is that business.
   *
   * Two thresholds, both y-websocket's: at HALF the timeout the link asks a room
   * to say something the server will answer, and at the full timeout it closes
   * the socket. The ladder does the rest, which is why this is the whole fix.
   *
   * ⚠ IT IS ALSO THE WHOLE ANSWER TO A PEER THAT SAYS NOTHING. There used to be a
   * second, faster timer beside this one that turned ten seconds of silence into
   * a session-long verdict against the route. Silence is not evidence about a
   * peer, so the response to it is what it is here: close the socket and dial
   * again, for as long as the link is wanted. A peer that accepts `/_mux` and
   * never answers is therefore retried rather than condemned, and the bridge's
   * `unreachable` — which needs the path to have REFUSED the route — is the only
   * thing that may end the session's mux.
   *
   * ⚠ AND IT NOW SAYS SO OUT LOUD. Retrying for ever in silence is what left the
   * user with nothing to act on, so a closure here on a route that has never
   * served, after frames have gone out, reports through `onUnreachable` — which
   * gathers evidence rather than concluding from its absence.
   */
  private armIdleWatch(): void {
    this.cancelIdleWatch();
    if (this.idleTimeoutMs <= 0) return;
    const poll = Math.max(250, Math.round(this.idleTimeoutMs / 10));
    const tick = (): void => {
      this.idleHandle = null;
      if (this.destroyed || !this.connected) return;
      const quiet = this.now() - this.lastInboundAt;
      if (quiet >= this.idleTimeoutMs) {
        this.stats.idleClosures += 1;
        const wroteAndHeardNothing = this.stats.framesOut > 0 && this.stats.framesIn === 0;
        this.closeCurrentSocket();
        // ⚠ REPORTED, NEVER CONCLUDED, and this is the shape the previous round
        // left with nothing at all. A socket that opened, carried frames out and
        // was closed for hearing nothing, on a route that has never served, is
        // not evidence about the peer — but it IS a reason to go and ask whether
        // the server answers anywhere else, which is the question only the bridge
        // can put. Measured on the parent branch through a proxy that upgrades
        // `/_mux` for real and drops every server frame: 70 s, 18 frames out, 0
        // in, no probe ever built, and a status bar saying "could not reach the
        // workspace" against a server a control client synced with.
        if (wroteAndHeardNothing) this.reportRoute('unanswered');
        return;
      }
      if (quiet >= this.idleTimeoutMs / 2) this.probeOneRoom();
      this.idleHandle = this.armIdleTick(tick, poll);
    };
    this.idleHandle = this.armIdleTick(tick, poll);
  }

  /**
   * ⚠ UNREF'd where the runtime offers it, duck-typed rather than imported.
   *
   * This is the one timer that re-arms itself for as long as the link is up, so
   * it is the one timer that can be the last handle in a process and keep it
   * alive for ever. `DocHub` unrefs y-protocols' awareness interval for exactly
   * this reason and says so. Obsidian's event loop is held open by Obsidian; a
   * test run's is not, and a watchdog that hangs the suite would be removed
   * again within the week.
   */
  private armIdleTick(fn: () => void, ms: number): unknown {
    const handle = this.setTimer(fn, ms);
    (handle as { unref?: () => void } | null)?.unref?.();
    return handle;
  }

  private cancelIdleWatch(): void {
    if (this.idleHandle === null) return;
    this.clearTimer(this.idleHandle);
    this.idleHandle = null;
  }

  /**
   * Ask ONE room to provoke an answer, rotating.
   *
   * One echo is all the proof a socket needs, so this is one frame rather than
   * one per room — and rotating means a single room that the server has stopped
   * serving cannot keep the link looking dead, nor keep it looking alive.
   */
  private probeOneRoom(): void {
    const handlers = [...this.rooms.values()];
    if (handlers.length === 0) return;
    this.probeCursor = (this.probeCursor + 1) % handlers.length;
    try {
      handlers[this.probeCursor]?.onProbe?.();
    } catch {
      /* a room that cannot say hello is not the link's problem */
    }
  }

  /** Close the live socket and let `onClose` schedule the retry. */
  private closeCurrentSocket(): void {
    const socket = this.socket;
    if (socket === null) return;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
    // A transport whose `close()` fires no event would otherwise park the link
    // for ever, which is the failure this whole section exists to end.
    if (this.socket === socket && socket.readyState !== WS_OPEN) this.onClose(socket);
  }

  /**
   * A dial that never opens the socket, whatever the shape.
   *
   * `MuxLink.open()` assigns `this.socket` before the socket opens and `connect()`
   * refuses to dial while one exists, so a dial that HANGS parked the link for
   * ever with no timer armed. Measured against a black-holed upgrade: one dial,
   * zero timers, still one dial forty-five seconds later.
   */
  private armConnectTimeout(socket: MuxSocket): void {
    this.cancelConnectTimeout();
    const deadline = this.dialTimeoutMs;
    if (deadline <= 0) return;
    this.connectHandle = this.setTimer(() => {
      this.connectHandle = null;
      if (this.destroyed || this.socket !== socket || this.socketOpened) return;
      // ⚠ THIS CLIENT gave up; the path said nothing. `dropSocket` unhooks
      // `onclose` first, so this is the only place an abandoned dial is counted
      // and it can never be mistaken for one the path refused.
      this.dropSocket();
      this.noteFailedDial('unanswered');
      this.scheduleRetry();
    }, deadline);
  }

  private cancelConnectTimeout(): void {
    if (this.connectHandle === null) return;
    this.clearTimer(this.connectHandle);
    this.connectHandle = null;
  }

  /**
   * A dial produced no socket. `cause` is WHO ended it, and that is the whole of
   * what separates a report the bridge may conclude from one it may only
   * describe.
   *
   * ⚠ AN ABANDONED DIAL REACHES NOTHING AT ALL FROM HERE, and that deletion is
   * this round's. It used to count towards the same threshold and call
   * `reportRoute('unanswered')`, which is a permanent user-facing statement about
   * the route reached with no socket, no frame and no byte — only this client's
   * own expired deadlines. That is the mechanism the previous round was created to
   * remove, taking a back door one level down. Measured against a HEALTHY shipped
   * server serving `/_mux` correctly, behind a transparent proxy forwarding every
   * byte of every route and merely delaying each connection by 13 s: the bar
   * latched permanently at 26,177 ms to "nothing is coming back on its multiplexed
   * connection", with `dialsRefused` 0, `dialsAbandoned` 5 and a route that was
   * carrying the connection perfectly well. The deadline elapsing is a reason to
   * dial again — nothing more.
   *
   * ⚠ AND IT BREAKS THE REFUSAL RUN, because `routeRefused` says "in a row" and
   * has to mean it. A dial this client ended is not the path saying no, so it
   * interrupts the evidence exactly as a successful open does. The ladder's own
   * count is deliberately NOT reset by a refusal in return: patience is about how
   * long to hold a dial open, and shrinking it back while dials are still failing
   * is what makes a 404 behind nine seconds of latency alternate for ever between
   * a deadline and an answer without ever gathering two answers in a row.
   */
  private noteFailedDial(cause: MuxRouteEvidence): void {
    this.stats.dialsFailed += 1;
    if (cause === 'refused') {
      this.stats.dialsRefused += 1;
      this.refusedDials += 1;
      if (this.refusedDials >= this.unreachableDials) this.reportRoute('refused');
      return;
    }
    this.stats.dialsAbandoned += 1;
    this.abandonedDials += 1;
    this.refusedDials = 0;
  }

  /**
   * Tell whoever is listening what this route has produced. Never a verdict.
   *
   * ⚠ A ROUTE THAT HAS SERVED THIS LINK IS NEVER REPORTED. Failed dials and
   * silences on such a route are an outage, a slept radio or a proxy restart, and
   * the only honest response to those is the ladder. Measured before this clause:
   * five seconds of `/_mux`-only trouble on an otherwise-working server demoted
   * the session permanently, 3/3, and a flaky path demoted one that had already
   * synced over the mux at 28,115 ms.
   */
  private reportRoute(evidence: MuxRouteEvidence): void {
    if (this.routeEverServed) return;
    for (const handler of [...this.unreachableHandlers]) {
      try {
        handler(evidence);
      } catch {
        /* an observer may not break the link */
      }
    }
  }

  private noteLegacyEvidence(
    reason: MuxUnsupportedReason,
    options: { external?: boolean } = {},
  ): void {
    // `socketSpokeMux` gates the FIRST-MESSAGE verdict, because a socket that has
    // answered in the framing is not an old server. It does not gate a verdict
    // reached from outside: the bridge concludes `unreachable` from sockets that
    // never opened at all, and there is nothing for this socket to have said.
    if (options.external !== true && this.socketSpokeMux) return;
    if (this.unsupported !== null || this.destroyed) return;
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
