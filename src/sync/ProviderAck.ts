// src/sync/ProviderAck.ts
// The one acknowledgement mechanism both flush paths use (spec §6.2, invariant
// I17).
//
// y-websocket exposes no application-level acknowledgement. `synced` latches true
// after the FIRST sync and says nothing whatsoever about an update sent ten
// seconds later, and `bufferedAmount === 0` only means the bytes left this
// process. Both were used as a confirmation at some point in this branch's
// history, and both are wrong in the same expensive way: `s` on a node and
// `contentHash` on this device are claims that the WORKSPACE holds the content,
// and a node whose `s` is set is never offered for publication again by anybody.
// A premature confirmation is therefore permanent content loss, not a retry.
//
// WHAT IS ACTUALLY PROVEN HERE. After the send buffer has drained, a fresh
// SyncStep1 is written onto the same socket that carried the updates. Frames on
// one socket are delivered and processed in order, so the server can only answer
// that SyncStep1 once it has read and applied everything that preceded it — which
// makes the SyncStep2 that comes back a genuine acknowledgement of this handle's
// updates. Anything else — a closed socket, a reconnect mid-flush, no reply
// before the deadline — is FALSE.
//
// Three counters carry the whole argument, and each exists because of a specific
// way of being lied to:
//
//  * `step2` counts acknowledgements seen on the CURRENT socket.
//  * `unanswered` counts SyncStep1 frames still owed a reply, so a stale
//    acknowledgement — the reply to a previous, timed-out flush — advances the
//    count without ever standing in for the round trip the caller asked about.
//    It starts at ONE on every attach, not zero, because y-websocket sends its own
//    SyncStep1 the moment the socket opens: a flush entering that ~1 RTT window
//    with a zero would compute a target the PROVIDER's reply satisfies, and
//    confirm a round trip that never carried the caller's bytes.
//  * `epoch` is bumped on every attach, so a flush that spans a reconnect fails
//    rather than counting the new socket's frames as answers to the old one's
//    question.
//
// ⚠ THE COUNT IS POSITIONAL, AND THAT HAS A FAILURE MODE WITH NO WAY BACK. A
// SyncStep1's reply is identified by being the next SyncStep2 to arrive, which is
// exact while every question is eventually answered. If one question is LOST —
// the frame dropped after it left this process, so no reply is ever produced —
// `unanswered` never comes back down, and every later flush asks for one more
// answer than the socket will ever produce. Measured with a per-room partition:
// one flush lost, then SIX consecutive flushes on a healed, converged, connected
// room returned FALSE, while another room on the SAME socket returned TRUE
// throughout. A merely LATE answer self-heals; a lost one never does.
//
// The counters CANNOT simply be cleared in place to repair it. A reply to a
// question asked before the clear can still arrive, and would then be counted as
// the answer to a flush whose bytes the server had never seen — the one mistake
// this module exists to make impossible. A NEW SOCKET has no such replies in
// flight, which is exactly why `attach()`'s reset is safe and an in-place one is
// not. So a flush that drained its buffer, asked on a live socket and got nothing
// back reports a STALL, and whoever owns the connection answers it by getting a
// new one.
//
// One smaller piece of the same arithmetic, fixed here too: a question that was
// never SENT is not outstanding. The count used to be raised and the send checked
// afterwards, so a flush that could not write at all still inflated every later
// flush's target, permanently. It is now rolled back — and rolled back rather
// than raised late, because a peer can answer inside `send` itself.
//
// This module owns no document and no connection: it follows a provider that
// someone else created and tears down only what it added. `ObsidianDocPort`'s
// pooled rooms and `WorkspaceSession`'s per-note provider both route their flush
// through one instance of it, which is the point — the session's flush used to be
// materially weaker than the port's, on the path users hit most often.
//
// No `obsidian` import, no node builtins.

import type * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

/** y-websocket's outer message tag for a sync frame. */
const MESSAGE_SYNC = 0;

/** How often the send buffer is re-checked while it drains. */
const DRAIN_POLL_MS = 25;

/** `WebSocket.OPEN`, spelled out so this module needs no DOM constant at runtime. */
const WS_OPEN = 1;

/**
 * The socket surface this module uses. Structurally satisfied by a real
 * `WebSocket`, and small enough that a test can supply one without a network.
 */
export interface AckSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  /**
   * FALSE when the bytes did not go.
   *
   * A real `WebSocket.send` returns `void`, so `undefined` has to read as "it
   * went" — but a shared link can refuse a write it never put on the wire, and a
   * question that was never asked must not be counted as outstanding. That is
   * what `MuxRoom`'s `RoomSocketView` returns.
   */
  send(data: Uint8Array): void | boolean;
  addEventListener(type: 'message' | 'close', listener: (event: { data?: unknown }) => void): void;
  removeEventListener(
    type: 'message' | 'close',
    listener: (event: { data?: unknown }) => void,
  ): void;
}

/** The provider surface: satisfied by y-websocket's `WebsocketProvider`. */
export interface AckProvider {
  readonly wsconnected: boolean;
  readonly ws: AckSocket | null;
  on(event: 'status', handler: () => void): void;
  off(event: 'status', handler: () => void): void;
}

/**
 * Decode just far enough to tell whether a frame is a SyncStep2.
 *
 * Read-only: the frame goes into a throwaway decoder and nothing is applied from
 * it. y-websocket's own handler decodes the same bytes independently and remains
 * the only thing that touches the document.
 */
export function isSyncStep2(data: unknown): boolean {
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  } else return false;

  try {
    const dec = decoding.createDecoder(bytes);
    if (decoding.readVarUint(dec) !== MESSAGE_SYNC) return false;
    return decoding.readVarUint(dec) === syncProtocol.messageYjsSyncStep2;
  } catch {
    return false;
  }
}

export class ProviderAck {
  private readonly provider: AckProvider;
  private readonly doc: Y.Doc;
  private readonly onStall: (() => void) | undefined;

  private step2 = 0;
  private unanswered = 0;
  private epoch = 0;
  /** One stall report per socket, so a caller in a retry loop cannot storm. */
  private stallReported = false;

  private socket: AckSocket | null = null;
  private readonly listeners = new Set<() => void>();
  private destroyed = false;

  private readonly onStatus = (): void => { this.attach(); };

  private readonly onMessage = (event: { data?: unknown }): void => {
    if (!isSyncStep2(event.data)) return;
    this.step2 += 1;
    if (this.unanswered > 0) this.unanswered -= 1;
    this.notify();
  };

  private readonly onClose = (): void => { this.notify(); };

  /**
   * `onStall` is called when a flush drained its buffer, asked its question on a
   * live socket and received nothing before the deadline. It means "this
   * connection can no longer prove anything"; the owner's answer is a new socket.
   * Callers on a plain `WebsocketProvider` pass nothing: a real socket cannot
   * lose one message and stay up, so there is nothing there to repair.
   */
  constructor(provider: AckProvider, doc: Y.Doc, onStall?: () => void) {
    this.provider = provider;
    this.doc = doc;
    this.onStall = onStall;
    // Re-attaching on every status transition is what keeps `epoch` honest: a
    // reconnect replaces the socket, and every counter that described the old one
    // is meaningless against the new.
    this.provider.on('status', this.onStatus);
    this.attach();
  }

  /** Spec §6.2's "await the update round-trip", and invariant I17's whole basis. */
  async flush(ms: number): Promise<boolean> {
    if (this.destroyed) return false;
    this.attach();
    const socket = this.socket;
    if (socket === null || !this.provider.wsconnected) return false;

    const deadline = Date.now() + ms;
    const epoch = this.epoch;

    // 1. The bytes must leave this process first. Until the buffer has drained
    //    there is nothing for the server to have acknowledged, and a SyncStep1
    //    queued behind them would only prove that the queue exists.
    while (socket.bufferedAmount > 0) {
      if (Date.now() >= deadline) return false;
      await sleep(DRAIN_POLL_MS);
      if (this.epoch !== epoch || !this.provider.wsconnected) return false;
    }

    // 2. Ask a question the server can only answer after it has processed
    //    everything we sent before it.
    //
    // ⚠ The count is raised BEFORE the send and ROLLED BACK if the send did not
    //    happen — not raised afterwards, which is a trap this file fell into once
    //    and a test now holds shut. A peer can answer SYNCHRONOUSLY, inside
    //    `send` itself; raising the count after the send then lets that answer
    //    decrement a zero and leaves the question outstanding for ever, which is
    //    the very ratchet being fixed here, reintroduced from the other side.
    const target = this.step2 + this.unanswered + 1;
    this.unanswered += 1;
    if (!this.sendStep1(socket)) {
      // A question that never left this process is not outstanding, and counting
      // it as though it were raised every later flush's target by one, for ever.
      this.unanswered = Math.max(0, this.unanswered - 1);
      return false;
    }

    await this.waitFor(
      () => this.epoch !== epoch || this.step2 >= target || !this.provider.wsconnected,
      Math.max(0, deadline - Date.now()),
    );

    // Every clause is a way of being unsure, and I17 says an unconfirmed flush is
    // a retry rather than a completion.
    const confirmed = this.epoch === epoch && this.step2 >= target && this.provider.wsconnected;
    if (!confirmed) this.noteStallIfSilent(epoch, target);
    return confirmed;
  }

  /** Release the socket and the status subscription. The provider is not ours to destroy. */
  destroy(): void {
    this.destroyed = true;
    try {
      this.provider.off('status', this.onStatus);
    } catch {
      /* the provider is already gone */
    }
    this.detach();
    this.listeners.clear();
  }

  // ---------------------------------------------------------- internals

  /**
   * Follow the provider onto its current socket.
   *
   * y-websocket assigns `ws.onmessage` rather than registering a listener, so an
   * added listener sits alongside its handler instead of replacing it.
   */
  private attach(): void {
    if (this.destroyed) return;
    const next = this.provider.ws;
    if (next === this.socket) return;
    this.detach();
    if (next === null) return;
    this.socket = next;
    this.epoch += 1;
    this.step2 = 0;
    this.stallReported = false;
    // ONE, not zero: y-websocket writes its own SyncStep1 as soon as this socket
    // opens, and the server's reply to it must not be allowed to answer a flush's
    // question. See the header.
    this.unanswered = 1;
    next.addEventListener('message', this.onMessage);
    next.addEventListener('close', this.onClose);
    this.notify();
  }

  private detach(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    try {
      socket.removeEventListener('message', this.onMessage);
      socket.removeEventListener('close', this.onClose);
    } catch {
      /* the socket is already gone; nothing left to unbind */
    }
  }

  private sendStep1(socket: AckSocket): boolean {
    if (socket.readyState !== WS_OPEN) return false;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    try {
      // A real `WebSocket.send` returns undefined; a link that shares the socket
      // returns false for a frame it refused. Only the explicit false is a
      // failure — `undefined` is what "it went" looks like.
      return socket.send(encoding.toUint8Array(enc)) !== false;
    } catch {
      return false;
    }
  }

  /**
   * The flush asked its question on a socket that stayed up, drained its buffer
   * first, and got nothing back. Whatever the cause — a frame the relay dropped,
   * a peer that stopped reading — this socket can no longer prove anything, and
   * the count it carries can never come back down on its own.
   *
   * Reported once per socket. The owner's repair is a new socket; there is no
   * safe repair that keeps this one.
   */
  private noteStallIfSilent(epoch: number, target: number): void {
    if (this.onStall === undefined || this.stallReported) return;
    if (this.epoch !== epoch || !this.provider.wsconnected) return;
    if (this.step2 >= target) return;
    this.stallReported = true;
    try {
      this.onStall();
    } catch {
      /* the owner's repair is not this module's to police */
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private waitFor(predicate: () => boolean, ms: number): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve();
      };
      const check = (): void => { if (predicate()) finish(); };
      this.listeners.add(check);
      const timer = setTimeout(finish, ms);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}
