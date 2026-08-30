// src/sync/LegacyTreeTransport.ts
//
// ███  REMOVAL-SCHEDULED BRIDGE — DELETE THIS FILE ONE MINOR VERSION AFTER   ███
// ███  P3 SLICE 8 SHIPS. It is not a second supported transport.            ███
//
// P3 spec §4 "Compatibility, and its end date", and §Rejected 6, which refused
// persistent's permanent compat mode by name: "Two transports, two open paths,
// two freshness semantics and every future bug filed against whichever one the
// reporter is on. The legacy path is kept as a removal-scheduled fallback for
// exactly one minor version, named in the spec, then deleted."
//
// ── HOW TO REMOVE IT, so that this is a deletion and not an untangling ──────
//   1. delete this file;
//   2. in `main.ts`, replace the one `openTreeTransport(...)` call with
//      `new MuxTreeTransport(this.mux, this.tree.doc)` and drop this import;
//   3. delete the `legacyServerNotice` call beside it.
// Nothing else in the plugin names a legacy transport, a fallback, or a mode.
// `MuxLink`, `MuxRoom` and `MuxTreeTransport` contain no branch for either.
//
// ── WHY DETECTION IS NOT "DID THE SOCKET OPEN" ─────────────────────────────
// Measured, not assumed. A server checked out from before any P3 work ACCEPTS
// `ws://…/_mux?t=…&w=…`: `_mux` matches its `DOC_RE`, `authorizeUpgrade` is
// satisfied, and `DocHub` serves the socket as an ordinary room literally named
// `_mux`. It then writes a raw y-websocket SyncStep1 — `[0x00, 0x00, 0x01, 0x00]`
// — and ignores every mux frame it is sent, forever, with the socket open.
//
// So the client's evidence is that first message: read as a frame it is a
// zero-length room name, a zero-length payload, and TWO BYTES LEFT OVER, for a
// room this client never subscribed. `MuxLink.decodeMuxFrame` refuses a trailing
// tail and `MuxLink` refuses an unknown room, and either one settles it inside
// one round trip. The ten-second timeout in `MuxLink` is only for a peer that
// says nothing at all.
//
// No `obsidian` import: the notice is a STRING this module owns, and `main.ts`
// puts it in front of the user. That keeps the whole bridge headless and
// therefore deletable in one piece.

import type * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import type { MuxLink, MuxUnsupportedReason } from './MuxLink.ts';
import { MuxTreeTransport, TREE_ROOM, type TreeTransport } from './TreeTransport.ts';

/**
 * What the user is told, once, when their server is older than their plugin.
 *
 * It names the consequence rather than the mechanism, because "your server has
 * no /_mux endpoint" is not something a self-hoster can act on, and it does not
 * promise a repair this build can make. §13 of "What this gives up": the
 * fallback is today's behaviour with an honest banner.
 */
export const LEGACY_SERVER_NOTICE =
  'ShadowLink: your server is older than this plugin, so it is running in the '
  + 'previous sync mode. Everything still syncs, but notes you have not opened '
  + 'will stay out of date until you open them. Updating the server fixes it.';

export interface LegacyTreeConfig {
  serverUrl: string;
  serverKey: string;
  workspaceId: string;
  room?: string;
}

/**
 * `_tree` over today's exact topology: one `WebsocketProvider` on its own socket,
 * with the same three options `main.ts` has always passed.
 *
 * Byte-for-byte the connection the plugin made before slice 2, deliberately: a
 * fallback that behaved slightly differently would be a third thing to support.
 */
export class LegacyTreeTransport implements TreeTransport {
  private readonly provider: WebsocketProvider;

  constructor(config: LegacyTreeConfig, doc: Y.Doc) {
    this.provider = new WebsocketProvider(config.serverUrl, config.room ?? TREE_ROOM, doc, {
      connect: true,
      params: { t: config.serverKey, w: config.workspaceId },
      disableBc: true,
    });
  }

  get synced(): boolean {
    return this.provider.synced;
  }

  connect(): void {
    try {
      this.provider.connect();
    } catch {
      /* already connecting; `whenSynced` is what decides */
    }
  }

  /** Resolves TRUE only on a genuine provider `sync` event. A timeout is not a sync (I3). */
  whenSynced(ms: number): Promise<boolean> {
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

  onConnected(handler: () => void): () => void {
    const listener = (event: { status?: string }): void => {
      if (event?.status === 'connected') handler();
    };
    this.provider.on('status', listener);
    return () => { this.provider.off('status', listener); };
  }

  destroy(): void {
    try {
      this.provider.destroy();
    } catch {
      /* already gone */
    }
  }
}

/**
 * The tree's transport, whichever the server turns out to support.
 *
 * Starts on the mux and switches ONCE, and only ever in that direction: a server
 * that has proven it speaks the protocol is never demoted, because a flaky
 * reconnect must not be able to tear the whole topology down (`MuxLink.spokeMux`
 * is what latches that).
 *
 * `onLegacy` fires at most once, after the switch, so the caller can say the one
 * true sentence to the user.
 */
export function openTreeTransport(
  link: MuxLink,
  doc: Y.Doc,
  config: LegacyTreeConfig,
  onLegacy?: (reason: MuxUnsupportedReason) => void,
  // The one seam, and it exists because constructing the real thing DIALS: a
  // `WebsocketProvider` opens a socket in its constructor, so a test about the
  // SWITCH would otherwise have to be a test about y-websocket. The structural
  // suite drives the real one against a real old server; this lets the unit tests
  // drive the shipped switcher rather than a copy of it.
  makeLegacy: (config: LegacyTreeConfig, doc: Y.Doc) => TreeTransport
  = (c, d) => new LegacyTreeTransport(c, d),
): TreeTransport {
  return new FallbackTreeTransport(link, doc, config, onLegacy, makeLegacy);
}

class FallbackTreeTransport implements TreeTransport {
  private active: TreeTransport;
  private legacy = false;
  private destroyed = false;
  private wantsConnect = false;

  /** Handlers the plugin registered, re-registered on the transport that wins. */
  private readonly connectedHandlers = new Set<() => void>();
  private releaseConnected: () => void;

  /** Woken when the transport is swapped, so an in-flight `whenSynced` re-asks. */
  private readonly swapWaiters = new Set<() => void>();

  constructor(
    link: MuxLink,
    private readonly doc: Y.Doc,
    private readonly config: LegacyTreeConfig,
    private readonly onLegacy: ((reason: MuxUnsupportedReason) => void) | undefined,
    private readonly makeLegacy: (config: LegacyTreeConfig, doc: Y.Doc) => TreeTransport,
  ) {
    this.active = new MuxTreeTransport(link, doc, config.room ?? TREE_ROOM);
    this.releaseConnected = this.active.onConnected(() => { this.fireConnected(); });
    link.onUnsupported((reason) => { this.fallBack(reason); });
  }

  get synced(): boolean {
    return this.active.synced;
  }

  connect(): void {
    this.wantsConnect = true;
    this.active.connect();
  }

  /**
   * Survives the switch. A bootstrap that started waiting on the mux while the
   * server was still being classified must not report "the tree never synced" —
   * the legacy transport that replaced it is answering the same question, and
   * whatever is left of the deadline belongs to it.
   */
  async whenSynced(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const transport = this.active;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return transport.synced;
      let wake = (): void => undefined;
      const swapped = new Promise<'swapped'>((resolve) => {
        wake = (): void => { resolve('swapped'); };
        this.swapWaiters.add(wake);
      });
      const result = await Promise.race([transport.whenSynced(remaining), swapped]);
      this.swapWaiters.delete(wake);
      if (result !== 'swapped') return result;
      if (this.destroyed) return false;
    }
  }

  onConnected(handler: () => void): () => void {
    this.connectedHandlers.add(handler);
    return () => { this.connectedHandlers.delete(handler); };
  }

  destroy(): void {
    this.destroyed = true;
    this.releaseConnected();
    this.active.destroy();
    this.connectedHandlers.clear();
    this.wakeSwapWaiters();
  }

  private fallBack(reason: MuxUnsupportedReason): void {
    if (this.legacy || this.destroyed) return;
    this.legacy = true;
    this.releaseConnected();
    this.active.destroy();
    this.active = this.makeLegacy(this.config, this.doc);
    this.releaseConnected = this.active.onConnected(() => { this.fireConnected(); });
    if (this.wantsConnect) this.active.connect();
    this.wakeSwapWaiters();
    this.onLegacy?.(reason);
  }

  private fireConnected(): void {
    for (const handler of [...this.connectedHandlers]) {
      try {
        handler();
      } catch (err) {
        console.error('[ShadowLink] a tree reconnect handler threw', err);
      }
    }
  }

  private wakeSwapWaiters(): void {
    for (const wake of [...this.swapWaiters]) wake();
  }
}
