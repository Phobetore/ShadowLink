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
// trip, which now lives in `ProviderAck.ts` because `WorkspaceSession`'s provider
// needs exactly the same guarantee and had a materially weaker one. Anything
// short of that acknowledgement (a closed socket, a reconnect mid-flush, no reply
// before the deadline) returns FALSE. y-websocket's own `synced` flag is not
// sufficient on its own: it latches true after the first sync and says nothing at
// all about an update sent ten seconds later.
//
// `openHeadless` reports `synced` with the same honesty: a timeout is not a sync
// (I3/I4), and a document whose sync could not be proven is handed back empty and
// unsynced so the caller retries instead of seeding into it.
//
// No `obsidian` import.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import { NOTE_SYNC_TIMEOUT_MS } from '../tree/constants.ts';
import type { DocHandle, DocPort } from './DocPort.ts';
import { ProviderAck } from './ProviderAck.ts';

/** How long a `flush` waits for the round trip before reporting failure. */
const FLUSH_TIMEOUT_MS = 8_000;

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

  /** The round trip, shared verbatim with the editing session's provider. */
  private readonly ack: ProviderAck;

  private destroyed = false;

  constructor(room: string, config: ObsidianDocPortConfig) {
    this.doc = new Y.Doc();
    this.provider = new WebsocketProvider(config.serverUrl, room, this.doc, {
      connect: true,
      params: { t: config.serverKey, w: config.workspaceId },
      disableBc: true,
    });
    this.ack = new ProviderAck(this.provider, this.doc);
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
    return this.ack.flush(ms);
  }

  destroy(): void {
    this.destroyed = true;
    this.ack.destroy();
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
