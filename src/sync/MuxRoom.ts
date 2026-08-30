// src/sync/MuxRoom.ts
// One room's y-websocket protocol, riding one subscription on a `MuxLink`
// (P3 spec §1.1, §2 "Per-room handshake").
//
// WHAT THIS IS. A faithful port of `y-websocket`'s message handling — the same
// four message tags, the same handshake on connect, the same "reply only if the
// encoder grew" rule — with the socket replaced by a room subscription. The
// payload inside a frame is therefore BYTE-IDENTICAL to what a `WebsocketProvider`
// would have written on its own socket, which is what lets the server relay it
// through an unmodified `DocHub`, and what lets a mux client and a legacy
// per-room client share one document (structural case 79b).
//
// WHAT IS DELIBERATELY ABSENT, and each absence is the point of the mux:
//
//  * no reconnect loop — the link has ONE, for the whole vault;
//  * no `process.on('exit')` handler — y-websocket registers one PER PROVIDER,
//    which at 2,000 rooms is 2,000 exit handlers. Spec §Rejected 11 refused the
//    `WebSocketPolyfill` shim over exactly this class of per-room residue;
//  * no BroadcastChannel — `disableBc: true` is what every shipped provider
//    already passes;
//  * no 30-second "no message received" watchdog that closes the socket. One
//    quiet room may not drop a socket that 1,999 other rooms are using. Liveness
//    is the link's business and only the link's.
//
// THE ACKNOWLEDGEMENT, which is the part with teeth. `ProviderAck`'s guarantee is
// "frames on one socket are delivered and processed in order, so a SyncStep1
// written after our updates can only be answered once the server has applied
// them". On the mux that stops being an argument about one document and becomes
// literally true across every room on the socket, because there IS one socket.
// `RoomSocketView` is what lets the shipped, unmodified `ProviderAck` sit on a
// room; I17 says a premature confirmation is permanent content loss rather than
// a retry, so this had to be a re-hosting and not a re-implementation.
//
// No `obsidian` import, no node builtins.

import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as authProtocol from 'y-protocols/auth';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import type { MuxLink, MuxSubscription } from './MuxLink.ts';
import { ProviderAck, type AckSocket } from './ProviderAck.ts';

/** y-websocket's outer message tags, at the installed 1.5.4. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;

const WS_CLOSED = 3;

/** How long a `flush` waits for the round trip, matching `ObsidianDocPort`'s. */
const FLUSH_TIMEOUT_MS = 8_000;

type SyncHandler = (isSynced: boolean) => void;
type StatusHandler = (event: { status: string }) => void;

export interface MuxRoomOptions {
  /** Supply one to share an awareness instance; otherwise the room makes its own. */
  awareness?: awarenessProtocol.Awareness;
  flushTimeoutMs?: number;
}

export class MuxRoom {
  readonly room: string;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;

  private readonly link: MuxLink;
  private readonly subscription: MuxSubscription;
  private readonly ownsAwareness: boolean;
  private readonly flushTimeoutMs: number;

  private readonly syncHandlers = new Set<SyncHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  /** `ProviderAck`'s own status subscription, which takes no argument. */
  private readonly ackStatusHandlers = new Set<() => void>();

  private _synced = false;
  private destroyed = false;

  /**
   * The per-room socket view handed to `ProviderAck`, rebuilt on every connect.
   *
   * ⚠ Rebuilt, never reused. `ProviderAck.attach` compares object identity to
   * decide whether the socket changed, and bumps its `epoch` when it did — and
   * `epoch` is the counter that makes a flush spanning a reconnect FAIL instead
   * of counting the new socket's frames as answers to the old one's question. A
   * view that survived a reconnect would silently disable that.
   */
  private view: RoomSocketView | null = null;

  private readonly ack: ProviderAck;
  private readonly unwatchStatus: () => void;

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;                     // came off the wire; do not echo
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    this.write(encoding.toUint8Array(enc));
  };

  private readonly onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
  ): void => {
    const changed = changes.added.concat(changes.updated).concat(changes.removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
    );
    this.write(encoding.toUint8Array(enc));
  };

  constructor(link: MuxLink, room: string, doc: Y.Doc, options: MuxRoomOptions = {}) {
    this.link = link;
    this.room = room;
    this.doc = doc;
    this.ownsAwareness = options.awareness === undefined;
    this.awareness = options.awareness ?? new awarenessProtocol.Awareness(doc);
    this.flushTimeoutMs = options.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;

    // ⚠ `subscribe` fires `onOpen` SYNCHRONOUSLY when the link is already up,
    // which is the right contract — a room that joined a live link must
    // handshake at once, not on the next reconnect — but it lands inside the
    // assignment to `this.subscription`, before that field, `this.ack` and the
    // document listeners exist. So the first one is deferred to the end of this
    // constructor rather than dropped.
    let constructed = false;
    let deferredOpen = false;
    this.subscription = link.subscribe(room, {
      onOpen: () => {
        if (constructed) this.onLinkOpen();
        else deferredOpen = true;
      },
      onPayload: (payload) => { this.onPayload(payload); },
      onClose: () => { this.onLinkClose(); },
    });
    constructed = true;

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);

    // Read through closures rather than through `this` inside the literal: an
    // object literal's own getters would bind `this` to the literal.
    const currentView = (): AckSocket | null => this.view;
    const ackStatus = this.ackStatusHandlers;
    this.ack = new ProviderAck(
      {
        get wsconnected(): boolean { return link.connected; },
        get ws(): AckSocket | null { return currentView(); },
        on: (_event, handler) => { ackStatus.add(handler); },
        off: (_event, handler) => { ackStatus.delete(handler); },
      },
      doc,
    );

    this.unwatchStatus = link.onStatus((status) => {
      this.emitStatus(status === 'connected' ? 'connected' : 'disconnected');
    });

    if (deferredOpen) this.onLinkOpen();
  }

  // ---------------------------------------------------------- provider surface

  /**
   * A completed handshake on a link that is STILL UP.
   *
   * ⚠ The conjunction closes a window a real socket opens and `WebsocketProvider`
   * leaves open: `terminate()` moves `readyState` to CLOSED at once, while the
   * close EVENT that clears the flag arrives on a later turn. In between, a
   * provider answers `synced === true` about a connection that is already gone.
   * Found by the structural reconnect case, which read the link as down and the
   * room as synced in the same tick.
   *
   * It can only ever make this answer more conservative, which is the direction
   * I3/I4 require: a room whose link is down is not current, whatever its last
   * handshake said.
   */
  get synced(): boolean {
    return this._synced && this.link.connected;
  }

  /** `AckProvider.wsconnected`. */
  get wsconnected(): boolean {
    return this.link.connected;
  }

  /** `AckProvider.ws` — the per-room view, or null while the link is down. */
  get ws(): AckSocket | null {
    return this.view;
  }

  on(event: 'sync' | 'synced', handler: SyncHandler): void;
  on(event: 'status', handler: StatusHandler): void;
  on(event: string, handler: SyncHandler | StatusHandler): void {
    if (event === 'status') this.statusHandlers.add(handler as StatusHandler);
    else this.syncHandlers.add(handler as SyncHandler);
  }

  off(event: 'sync' | 'synced', handler: SyncHandler): void;
  off(event: 'status', handler: StatusHandler): void;
  off(event: string, handler: SyncHandler | StatusHandler): void {
    if (event === 'status') this.statusHandlers.delete(handler as StatusHandler);
    else this.syncHandlers.delete(handler as SyncHandler);
  }

  /**
   * Resolves TRUE only on a GENUINE sync event. A timeout is not a sync (I3/I4).
   * The same shape `main.ts` and `ObsidianDocPort` already use.
   */
  whenSynced(ms: number): Promise<boolean> {
    if (this.synced) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('sync', onSync);
        resolve(value);
      };
      const onSync = (isSynced: boolean): void => { if (isSynced) finish(true); };
      this.on('sync', onSync);
      const timer = setTimeout(() => finish(this.synced), ms);
    });
  }

  /**
   * Spec §6.2's "await the update round-trip", invariant I17's whole basis, and
   * the reason this file re-hosts `ProviderAck` rather than re-implementing it.
   */
  flush(ms: number = this.flushTimeoutMs): Promise<boolean> {
    if (this.destroyed) return Promise.resolve(false);
    return this.ack.flush(ms);
  }

  /** Ask the LINK to connect. A room has no socket of its own to revive. */
  connect(): void {
    this.link.connect();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ack.destroy();
    this.unwatchStatus();
    this.subscription.unsubscribe();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    if (this.ownsAwareness) {
      try {
        this.awareness.destroy();
      } catch {
        /* already gone */
      }
    }
    const view = this.view;
    this.view = null;
    view?.shut();
    this.syncHandlers.clear();
    this.statusHandlers.clear();
    this.ackStatusHandlers.clear();
  }

  // ---------------------------------------------------------- the protocol

  /**
   * The handshake, byte-for-byte y-websocket's `onopen`: SyncStep1 first, then
   * this client's own awareness state if it has one.
   *
   * Fired on EVERY connect, which is I24: reconnect re-handshakes every
   * subscribed room from the state vector of the bytes it holds, and nothing is
   * marked synced on a handshake that did not complete.
   */
  private onLinkOpen(): void {
    if (this.destroyed) return;
    const previous = this.view;
    this.view = new RoomSocketView(this.link, this.subscription);
    previous?.shut();
    this.setSynced(false);
    this.notifyAckStatus();

    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.write(encoding.toUint8Array(enc));

    if (this.awareness.getLocalState() !== null) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        aenc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
      );
      this.write(encoding.toUint8Array(aenc));
    }
  }

  private onLinkClose(): void {
    if (this.destroyed) return;
    this.setSynced(false);
    const view = this.view;
    this.view = null;
    // Everyone except this client left, as far as this room can tell — the same
    // sweep y-websocket makes on its socket's close.
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID),
      this,
    );
    view?.shut();
    this.notifyAckStatus();
  }

  /**
   * y-websocket's `readMessage`, verbatim in behaviour: build a reply encoder,
   * dispatch on the tag, and write the reply back only if the handler put
   * something into it beyond the tag itself.
   */
  private onPayload(payload: Uint8Array): void {
    if (this.destroyed) return;
    const reply = encoding.createEncoder();
    let wrote = false;
    try {
      const dec = decoding.createDecoder(payload);
      const messageType = decoding.readVarUint(dec);
      if (messageType === MESSAGE_SYNC) {
        encoding.writeVarUint(reply, MESSAGE_SYNC);
        const kind = syncProtocol.readSyncMessage(dec, reply, this.doc, this);
        wrote = true;
        // `synced` flips on a SyncStep2 and only on a SyncStep2 — the server's
        // answer to OUR step 1. That is the event `WebsocketProvider` reports,
        // and it is what I4 requires callers to branch on.
        if (kind === syncProtocol.messageYjsSyncStep2 && !this._synced) this.setSynced(true);
      } else if (messageType === MESSAGE_QUERY_AWARENESS) {
        encoding.writeVarUint(reply, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          reply,
          awarenessProtocol.encodeAwarenessUpdate(
            this.awareness,
            [...this.awareness.getStates().keys()],
          ),
        );
        wrote = true;
      } else if (messageType === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(dec),
          this,
        );
      } else if (messageType === MESSAGE_AUTH) {
        authProtocol.readAuthMessage(dec, this.doc, (_doc, reason) => {
          console.warn(`[ShadowLink] permission denied for room ${this.room}: ${reason}`);
        });
      }
    } catch {
      // A payload that does not decode is dropped, never guessed at, and never
      // fatal: the link is carrying other rooms.
      return;
    }
    if (wrote && encoding.length(reply) > 1) this.write(encoding.toUint8Array(reply));

    // ⚠ AFTER the document has been updated, matching the order a real socket
    // gives: y-websocket assigns `ws.onmessage` at connect and `ProviderAck` adds
    // its listener afterwards, so the ack counts a SyncStep2 that has already
    // been applied. A count that ran first would confirm a flush one tick before
    // the bytes it is confirming had landed.
    this.view?.deliver(payload);
  }

  private write(payload: Uint8Array): void {
    this.subscription.send(payload);
  }

  private setSynced(next: boolean): void {
    if (this._synced === next) return;
    this._synced = next;
    for (const handler of [...this.syncHandlers]) {
      try {
        handler(next);
      } catch {
        /* an observer may not break the room */
      }
    }
  }

  private emitStatus(status: string): void {
    for (const handler of [...this.statusHandlers]) {
      try {
        handler({ status });
      } catch {
        /* an observer may not break the room */
      }
    }
  }

  /** Tell `ProviderAck` to re-read `provider.ws`, which is how it re-epochs. */
  private notifyAckStatus(): void {
    for (const handler of [...this.ackStatusHandlers]) {
      try {
        handler();
      } catch {
        /* the ack contains its own failures */
      }
    }
  }
}

/**
 * One room's view of the shared socket — the object `ProviderAck` is handed in
 * place of a `WebSocket`.
 *
 * ⚠ `bufferedAmount` is the WHOLE LINK's, deliberately. A flush waits for the
 * send buffer to drain before it asks its question, and on a shared socket that
 * means waiting for every room's bytes rather than only this room's. That is
 * conservative in the safe direction — it can make a flush slower, never earlier
 * — and I17's failure mode is a confirmation that arrives too early. There is no
 * per-room buffer to read, and inventing one would be a number that means nothing.
 */
class RoomSocketView implements AckSocket {
  private readonly messageListeners = new Set<(event: { data?: unknown }) => void>();
  private readonly closeListeners = new Set<(event: { data?: unknown }) => void>();
  private closed = false;

  constructor(
    private readonly link: MuxLink,
    private readonly subscription: MuxSubscription,
  ) {}

  get readyState(): number {
    if (this.closed) return WS_CLOSED;
    return this.link.rawSocket?.readyState ?? WS_CLOSED;
  }

  get bufferedAmount(): number {
    return this.link.rawSocket?.bufferedAmount ?? 0;
  }

  /**
   * ⚠ Writes to the ROOM, not to the socket. `ProviderAck.sendStep1` calls this
   * with a bare y-websocket message; framing it here is what makes that SyncStep1
   * a question about this room, asked behind this room's updates on the one
   * ordered socket. Without the framing it would reach the server as a message
   * naming no room at all, and be dropped — a flush that could never confirm.
   */
  send(data: Uint8Array): void {
    this.subscription.send(data);
  }

  addEventListener(
    type: 'message' | 'close',
    listener: (event: { data?: unknown }) => void,
  ): void {
    if (type === 'close') this.closeListeners.add(listener);
    else this.messageListeners.add(listener);
  }

  removeEventListener(
    type: 'message' | 'close',
    listener: (event: { data?: unknown }) => void,
  ): void {
    // Written with the receiver spelled out on each branch, not as a ternary
    // picking the Set: `banned-calls.test.ts` refuses a destructive call it
    // cannot attribute to a named receiver, and that refusal is the whole reason
    // "write it across two lines" is not a way past the I1 guard.
    if (type === 'close') this.closeListeners.delete(listener);
    else this.messageListeners.delete(listener);
  }

  /** Every payload that arrived for this room, in arrival order. */
  deliver(payload: Uint8Array): void {
    if (this.closed) return;
    for (const listener of [...this.messageListeners]) {
      try {
        listener({ data: payload });
      } catch {
        /* one observer may not break the others */
      }
    }
  }

  /** The link went away, or the room did. Fires the close listeners exactly once. */
  shut(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) {
      try {
        listener({});
      } catch {
        /* teardown is not optional */
      }
    }
  }
}
