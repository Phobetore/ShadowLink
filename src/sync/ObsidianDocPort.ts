// src/sync/ObsidianDocPort.ts
// The per-room `y-websocket` route — one socket per room, exactly as the plugin
// shipped before P3 — expressed as a `RoomTransport`, plus the `DocPort` façade
// that has always sat on top of it.
//
// ⚠ FROM SLICE 3 THIS IS THE COMPATIBILITY IMPLEMENTATION AND NOTHING ELSE
// (P3 spec §9 slice 3: "`ObsidianDocPort` survives only as the compat
// implementation"). The route every current server takes is `MuxRoomTransport` —
// one socket for the whole vault. This file is what a client falls back to when
// the server does not speak `/_mux`, and what the compatibility lever selects; it
// goes when `LegacyTreeTransport` goes.
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
// trip, which lives in `ProviderAck.ts` because `MuxRoom` needs exactly the same
// guarantee. Anything short of that acknowledgement (a closed socket, a reconnect
// mid-flush, no reply before the deadline) returns FALSE. y-websocket's own
// `synced` flag is not sufficient on its own: it latches true after the first sync
// and says nothing at all about an update sent ten seconds later.
//
// `openHeadless` reports `synced` with the same honesty: a timeout is not a sync
// (I3/I4), and a document whose sync could not be proven is handed back empty and
// unsynced so the caller retries instead of seeding into it.
//
// ⚠ AND THE POOLING IS NOW `RoomRegistry`'s, WHICH IS NOT A TIDY-UP. The pool used
// to own its rooms' `Y.Doc`s, and the editing session owned a different one for the
// same room — two documents, one room, and `insertIfEmpty`'s emptiness check
// (invariant I5's mechanism) asked of each of them separately. The refcounting
// below is byte-for-byte what this file did — a claim per handle, the connection
// released with the last one — it simply happens one level down, where the session
// is borrowing from the same map. Everything this file's own tests assert about
// pooling is therefore now an assertion about the registry, made over real sockets
// against the real server process.
//
// No `obsidian` import.

import type * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';

import type { DocHandle, DocPort } from './DocPort.ts';
import { ProviderAck } from './ProviderAck.ts';
import {
  RegistryDocPort, RoomRegistry, type RoomConnection, type RoomTransport,
} from './RoomRegistry.ts';

export interface ObsidianDocPortConfig {
  /** `ws://host:port`, no trailing slash. */
  serverUrl: string;
  serverKey: string;
  workspaceId: string;
  syncTimeoutMs?: number;
  flushTimeoutMs?: number;
}

// ============================================================ the legacy route

/**
 * One room, one socket — the topology the plugin shipped with.
 *
 * The document and the `Awareness` are handed IN by `RoomRegistry`, which is what
 * lets the registry swap a live room between this route and the mux without the
 * editor's binding or the awareness field noticing. `WebsocketProvider` accepts
 * both, so this is the shipped provider with nothing added.
 */
class LegacyRoomConnection implements RoomConnection {
  private readonly provider: WebsocketProvider;

  /** The round trip, shared verbatim with `MuxRoom` (I17). */
  private readonly ack: ProviderAck;

  private destroyed = false;

  constructor(
    room: string,
    doc: Y.Doc,
    awareness: awarenessProtocol.Awareness,
    config: ObsidianDocPortConfig,
  ) {
    this.provider = new WebsocketProvider(config.serverUrl, room, doc, {
      connect: true,
      params: { t: config.serverKey, w: config.workspaceId },
      disableBc: true,
      awareness,
    });
    this.ack = new ProviderAck(this.provider, doc);
  }

  get synced(): boolean {
    return this.provider.synced;
  }

  on(event: 'sync', handler: (isSynced: boolean) => void): void {
    this.provider.on(event, handler);
  }

  off(event: 'sync', handler: (isSynced: boolean) => void): void {
    this.provider.off(event, handler);
  }

  /** Spec §6.2's "await the update round-trip", and invariant I17's whole basis. */
  async flush(ms: number): Promise<boolean> {
    if (this.destroyed) return false;
    return this.ack.flush(ms);
  }

  /**
   * The provider and its acknowledgement, and nothing else.
   *
   * ⚠ NOT THE DOCUMENT AND NOT THE AWARENESS. Both are the registry's, and both
   * outlive this object whenever a room is moved between routes. y-websocket's own
   * `destroy()` never touches an `Awareness` it was handed, which is exactly the
   * behaviour this relies on.
   */
  destroy(): void {
    this.destroyed = true;
    this.ack.destroy();
    try {
      this.provider.destroy();
    } catch {
      /* already gone */
    }
  }
}

/**
 * `RoomTransport` over one `WebsocketProvider` per room.
 *
 * The compatibility route. Constructed by `main.ts` when the user has thrown the
 * compatibility lever, and swapped in by `RoomRegistry.switchTransport` when the
 * bridge concludes the server does not speak the multiplexed one — which is the
 * only thing that stops an old server losing note sync entirely once the note
 * rooms are on `MuxLink`.
 */
export class LegacyRoomTransport implements RoomTransport {
  constructor(private readonly config: ObsidianDocPortConfig) {}

  open(
    room: string,
    doc: Y.Doc,
    awareness: awarenessProtocol.Awareness,
  ): RoomConnection {
    return new LegacyRoomConnection(room, doc, awareness, this.config);
  }
}

// ============================================================ ObsidianDocPort

/**
 * `DocPort` over the legacy route, with its own private registry.
 *
 * Private because this class is a self-contained compatibility object: `main.ts`
 * reaches the same connection through the shared registry, so that the session and
 * the queue borrow ONE document. Here the registry serves one consumer, which is
 * the degenerate case of the same rule and is what makes this file's real-socket
 * tests a proof about the registry rather than about a copy of it.
 */
export class ObsidianDocPort implements DocPort {
  private readonly registry: RoomRegistry;
  private readonly port: RegistryDocPort;

  constructor(config: ObsidianDocPortConfig) {
    this.registry = new RoomRegistry(new LegacyRoomTransport(config));
    this.port = new RegistryDocPort(this.registry, {
      syncTimeoutMs: config.syncTimeoutMs,
      flushTimeoutMs: config.flushTimeoutMs,
    });
  }

  openHeadless(room: string): Promise<{ text: string; synced: boolean; handle: DocHandle }> {
    return this.port.openHeadless(room);
  }

  insertIfEmpty(handle: DocHandle, text: string): Promise<boolean> {
    return this.port.insertIfEmpty(handle, text);
  }

  flush(handle: DocHandle): Promise<boolean> {
    return this.port.flush(handle);
  }

  close(handle: DocHandle): void {
    this.port.close(handle);
  }

  /** Tear every pooled connection down. Called from the plugin's `onunload`. */
  destroy(): void {
    this.port.destroy();
    this.registry.destroy();
  }
}
