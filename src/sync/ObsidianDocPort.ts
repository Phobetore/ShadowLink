// src/sync/ObsidianDocPort.ts
// `DocPort` (spec §4.0) over `y-websocket`, for content documents that are NOT
// bound to an editor.
//
// One of only three files in `src/sync/` allowed to import `obsidian` — and it
// does not need to, so it does not. It sits here rather than beside the session
// because it is the network half of the same pair, and because `flush` is the
// most dangerous method in the whole port surface.
//
// WHY `flush` IS DANGEROUS. `FakeDocs.flush` defaults to CONFIRMING, so every
// existing test passes whatever this returns. The publish queue advances two
// watermarks on a confirmation — the node's `s` flag and this device's
// `contentHash` — and both are claims that the workspace now holds the content. A
// node whose `s` is set is never offered for publication again by anybody, so a
// premature confirmation is permanent content loss rather than a retry (I17).
// `Promise.resolve(true)` and a bare `await provider.whenSynced` (which a timeout
// also satisfies) are therefore both wrong in a way nothing would catch.
//
// WHAT IS IMPLEMENTED INSTEAD. The same mechanism the structural end-to-end
// harness uses (`server/test/harness/net.mjs`): a real SyncStep1 → SyncStep2 round
// trip. After the socket's send buffer has drained, a fresh SyncStep1 is written
// onto the same connection that carried the update. Frames on one socket are
// delivered and processed in order, so the server can only answer that SyncStep1
// once it has already read and applied everything that preceded it — which makes
// the SyncStep2 that comes back a genuine acknowledgement of this handle's
// updates. Anything else (a closed socket, a reconnect mid-flush, no reply before
// the deadline) returns FALSE. y-websocket's own `synced` flag is not sufficient
// on its own: it latches true after the first sync and says nothing at all about
// an update sent ten seconds later.
//
// `openHeadless` reports `synced` with the same honesty: a timeout is not a sync
// (I3/I4), and a document whose sync could not be proven is handed back empty and
// unsynced so the caller retries instead of seeding into it.
//
// No `obsidian` import.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { NOTE_SYNC_TIMEOUT_MS } from '../tree/constants.ts';
import type { DocHandle, DocPort } from './DocPort.ts';

/** y-websocket's outer message tag for a sync frame. */
const MESSAGE_SYNC = 0;

/** How long a `flush` waits for the round trip before reporting failure. */
const FLUSH_TIMEOUT_MS = 8_000;

/** How often the send buffer is re-checked while it drains. */
const DRAIN_POLL_MS = 25;

/** `WebSocket.OPEN`, spelled out so this module needs no DOM constant at runtime. */
const WS_OPEN = 1;

interface PooledHandle extends DocHandle {
  readonly room: string;
  readonly id: number;
}

export interface ObsidianDocPortConfig {
  /** `ws://host:port`, no trailing slash. */
  serverUrl: string;
  serverKey: string;
  workspaceId: string;
  syncTimeoutMs?: number;
  flushTimeoutMs?: number;
}

/**
 * Decode just far enough to tell whether a frame is a SyncStep2.
 *
 * Read-only: the frame is decoded into a throwaway decoder and nothing is applied
 * from it. y-websocket's own handler decodes the same bytes independently and is
 * the only thing that touches the document.
 */
function isSyncStep2(data: unknown): boolean {
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

// ============================================================ one pooled room

/**
 * One room's connection, plus the acknowledgement bookkeeping `flush` needs.
 *
 * Connections are POOLED per room: a note's content doc is opened by the
 * materializer, by `adopt` and by the publish queue, sometimes more than once in
 * a single reconcile pass, and a socket per call would turn one pass into a
 * socket storm. `close` releases a claim; the connection goes when the last one
 * does.
 */
class Room {
  readonly doc: Y.Doc;
  readonly provider: WebsocketProvider;

  /** Outstanding handles. The connection is torn down when this reaches zero. */
  refs = 0;

  /**
   * SyncStep2 frames observed on the CURRENT socket, and our own SyncStep1 frames
   * still waiting for one.
   *
   * `unanswered` is what stops a reply to a PREVIOUS, timed-out flush from
   * satisfying the next one: each flush's target is set past every reply still
   * owed, so a stale acknowledgement advances the count without ever standing in
   * for the round trip the caller actually asked about.
   */
  private step2 = 0;
  private unanswered = 0;

  /** Bumped on every (re)attach. A flush that spans a reconnect fails, never lies. */
  private epoch = 0;

  private socket: WebSocket | null = null;
  private readonly listeners = new Set<() => void>();
  private destroyed = false;

  private readonly onMessage = (event: MessageEvent): void => {
    if (!isSyncStep2(event.data)) return;
    this.step2 += 1;
    if (this.unanswered > 0) this.unanswered -= 1;
    this.notify();
  };

  private readonly onSocketClose = (): void => {
    this.notify();
  };

  constructor(room: string, config: ObsidianDocPortConfig) {
    this.doc = new Y.Doc();
    this.provider = new WebsocketProvider(config.serverUrl, room, this.doc, {
      connect: true,
      params: { t: config.serverKey, w: config.workspaceId },
      disableBc: true,
    });
    // Re-attaching on every status transition is what keeps `epoch` honest: a
    // reconnect replaces the socket, and every counter that described the old one
    // is meaningless against the new.
    this.provider.on('status', () => { this.attach(); });
    this.attach();
  }

  get text(): string {
    return this.doc.getText('content').toString();
  }

  /** Resolves TRUE only on a genuine provider `sync` event. A timeout is not a sync. */
  waitSync(ms: number): Promise<boolean> {
    if (this.provider.synced) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.provider.off('sync', onSync);
        resolve(value);
      };
      const onSync = (isSynced: boolean): void => { if (isSynced) finish(true); };
      this.provider.on('sync', onSync);
      const timer = setTimeout(() => finish(this.provider.synced), ms);
    });
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
    const target = this.step2 + this.unanswered + 1;
    this.unanswered += 1;
    if (!this.sendStep1(socket)) return false;

    await this.waitFor(
      () => this.epoch !== epoch || this.step2 >= target || !this.provider.wsconnected,
      Math.max(0, deadline - Date.now()),
    );

    // Every clause is a way of being unsure, and I17 says an unconfirmed flush is
    // a retry rather than a completion.
    return this.epoch === epoch && this.step2 >= target && this.provider.wsconnected;
  }

  destroy(): void {
    this.destroyed = true;
    this.detach();
    this.listeners.clear();
    try {
      this.provider.destroy();
    } catch {
      /* already gone */
    }
    try {
      this.doc.destroy();
    } catch {
      /* already gone */
    }
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
    this.unanswered = 0;
    next.addEventListener('message', this.onMessage);
    next.addEventListener('close', this.onSocketClose);
    this.notify();
  }

  private detach(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    try {
      socket.removeEventListener('message', this.onMessage);
      socket.removeEventListener('close', this.onSocketClose);
    } catch {
      /* the socket is already gone; nothing left to unbind */
    }
  }

  private sendStep1(socket: WebSocket): boolean {
    if (socket.readyState !== WS_OPEN) return false;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    try {
      socket.send(encoding.toUint8Array(enc));
    } catch {
      return false;
    }
    return true;
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

// ============================================================ ObsidianDocPort

export class ObsidianDocPort implements DocPort {
  private readonly config: ObsidianDocPortConfig;
  private readonly syncTimeoutMs: number;
  private readonly flushTimeoutMs: number;

  private readonly rooms = new Map<string, Room>();
  /** Live handle ids -> room, so `close` is idempotent and cannot over-release. */
  private readonly live = new Map<number, string>();
  private nextHandleId = 1;
  private destroyed = false;

  constructor(config: ObsidianDocPortConfig) {
    this.config = config;
    this.syncTimeoutMs = config.syncTimeoutMs ?? NOTE_SYNC_TIMEOUT_MS;
    this.flushTimeoutMs = config.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;
  }

  async openHeadless(
    room: string,
  ): Promise<{ text: string; synced: boolean; handle: DocHandle }> {
    const handle: PooledHandle = { room, id: this.nextHandleId++ };
    if (this.destroyed) return { text: '', synced: false, handle };

    let entry = this.rooms.get(room);
    if (entry === undefined) {
      entry = new Room(room, this.config);
      this.rooms.set(room, entry);
    }
    entry.refs += 1;
    this.live.set(handle.id, room);

    const synced = await entry.waitSync(this.syncTimeoutMs);
    // A handle is returned either way: branching on `synced` is the CALLER's
    // obligation (I4), and withholding it would only hide a caller that does not.
    // The text is withheld, though — an unsynced document reads as empty when it
    // is not, and seeding into that is what doubles a note on reconnect.
    if (!synced) return { text: '', synced: false, handle };
    return { text: entry.text, synced: true, handle };
  }

  async insertIfEmpty(handle: DocHandle, text: string): Promise<boolean> {
    const entry = this.roomOf(handle);
    if (entry === null) return false;
    const ytext = entry.doc.getText('content');
    if (ytext.length !== 0) return false;             // I5
    ytext.insert(0, text);
    return true;
  }

  async flush(handle: DocHandle): Promise<boolean> {
    const entry = this.roomOf(handle);
    if (entry === null) return false;
    return entry.flush(this.flushTimeoutMs);
  }

  close(handle: DocHandle): void {
    const h = handle as PooledHandle;
    if (typeof h.id !== 'number') return;
    const room = this.live.get(h.id);
    if (room === undefined) return;                   // already released
    this.live.delete(h.id);
    const entry = this.rooms.get(room);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.rooms.delete(room);
    entry.destroy();
  }

  /** Tear every pooled connection down. Called from the plugin's `onunload`. */
  destroy(): void {
    this.destroyed = true;
    for (const entry of this.rooms.values()) entry.destroy();
    this.rooms.clear();
    this.live.clear();
  }

  private roomOf(handle: DocHandle): Room | null {
    const h = handle as PooledHandle;
    if (typeof h.id !== 'number') return null;
    if (!this.live.has(h.id)) return null;            // a released handle has nothing to await
    return this.rooms.get(h.room) ?? null;
  }
}
