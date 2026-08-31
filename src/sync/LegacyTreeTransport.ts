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
// ── HOW TO REMOVE IT ────────────────────────────────────────────────────────
//   1. delete this file and its test;
//   2. in `main.ts`, replace the one `openTreeTransport(...)` call with
//      `new MuxTreeTransport(this.mux, this.tree.doc)` and drop this import;
//   3. delete the `new Notice(...)` line beside it, and the two exported notice
//      strings it names.
//
// ⚠ AND THEN THERE IS AN UNTANGLING, WHICH THIS HEADER USED TO DENY. It said
// "`MuxLink`, `MuxRoom` and `MuxTreeTransport` contain no branch for either",
// and that stopped being true when the link grew a verdict surface for this
// bridge to consult. What is left in `MuxLink` after the three steps above,
// serving nothing else: `MuxUnsupportedReason` and `unsupported` /
// `unsupportedHandlers` / `onUnsupported` / `markUnsupported`;
// `MuxRouteEvidence`, `unreachableHandlers` / `onUnreachable` / `reportRoute` and
// the `cause` half of `noteFailedDial` with `refusedDials`, `routeRefused`,
// `unreachableDials` and `routeEverServed`; `servedHandlers` / `onServed`;
// `noteLegacyEvidence` and its `external` option; `socketSpokeMux`;
// `MUX_UNREACHABLE_DIALS` in
// `src/tree/constants.ts`; the legacy assertions in `MuxLink.test.ts`; the
// structural cases 80c / 80f / 80g and `server/test/harness/legacy-server.mjs`
// with `startServer`'s `entry` option. Call it a file deletion plus a few
// hundred lines of unpicking, and say so here rather than let the next person
// find out. `everSubscribed` and the frame decoder stay: they are the link's.
//
// ⚠ TWO THINGS DO NOT GO WITH IT, and they are named here so nobody deletes them
// with the bridge. `noteRouteUnserved` / `routeUnserved` describe a state of the
// MUX — the server answers, this route delivers nothing — and the status bar
// reads them whether or not a fallback exists; and the compatibility setting in
// `src/types.ts` is what a self-hoster reaches for when it holds. Both outlive
// this file, and after it goes the setting simply stops having a transport to
// select and should be removed on its own, deliberately.
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
// one round trip.
//
// ⚠ AND THERE IS NO TIMEOUT BESIDE IT ANY MORE. A ten-second window used to
// condemn a peer that had said nothing at all — a session-long verdict reached
// from an ABSENCE, measured false and reachable on any reconnect. Silence is
// never a verdict; a peer that accepts `/_mux` and does not answer is closed by
// the liveness watchdog and dialled again, for as long as the link is wanted.
//
// ── AND WHY "THE SOCKET NEVER OPENED" IS NOT NOTHING ───────────────────────
// Both of the above need a socket that OPENED. A `/_mux` upgrade that is REFUSED
// reaches neither, and before the probe below existed it reached nothing at all:
// measured against a real server behind a proxy that answers 404 on `/_mux` and
// serves every other route, `whenSynced(15000)` was false, the verdict was empty,
// the notice never appeared, and the link dialled for ever — while a plain
// per-room client on the SAME path synced. That is the canonical reverse-proxy
// misconfiguration, and INSTALL.md tells self-hosters to put a proxy in front
// without giving them a config.
//
// `MuxLink` cannot conclude it alone. A browser `WebSocket` reports a refused
// upgrade and a server that is simply DOWN as the same bare close, on purpose, so
// a link that fell back on failed dials would demote a whole session every time a
// server restarted. What tells them apart is the per-room route, and this file is
// the only place that has one. So `MuxLink` reports evidence (`onUnreachable`)
// and this bridge decides, by bringing the legacy route up as a PROBE.
//
// ── AND WHAT THE VERDICT IS ALLOWED TO REST ON ─────────────────────────────
// ⚠ A REFUSAL, NEVER A DEADLINE, and three rounds were spent learning that the
// difference is not a tuning problem. The dial was bounded and the probe was not,
// so any path slower than the bound demoted by construction; bounding both and
// widening the dial to twice the probe's own connect fixed the constant-latency
// case and left the VARIABLE one, where the mux's draw and the probe's draw are
// two samples from the same distribution. Measured on the parent branch, real
// server serving `/_mux` normally behind a proxy drawing 75% of connections from
// 5.5–8.5 s and 25% from 1.2–2.2 s: a permanent false `unreachable` at 14,527 ms,
// framesIn 0, telling the user to reconfigure a proxy that was forwarding every
// path. There is no fair threshold. So the stopwatch is gone: a dial the PATH
// ended — an error, a close, a 404 — is something the network said and may still
// condemn the route; a dial this client abandoned may not.
//
// ── AND WHAT REPLACES IT WHERE NOTHING WAS SAID ────────────────────────────
// A black-holed upgrade and an arbitrarily slow path are one observation, so
// neither gets a verdict. What they get instead is the truth and a lever. The
// probe still runs — ignorance is a reason to LOOK — and when it syncs on a route
// this one has never served, the bridge records that fact on the link
// (`noteRouteUnserved`) and drops the probe. Nothing is concluded about the
// server's version, its age or the cause; the status bar says the server answers
// and this route delivers nothing, and names the compatibility setting a
// self-hoster whose deployment does not carry `/_mux` can turn on. Measured on
// the parent branch through a proxy that upgrades `/_mux` for real and drops every
// server frame: 70 s, 3 sockets, 2 idle closures, 18 frames out, 0 in, no probe
// ever built, no verdict, and "ShadowLink could not reach the workspace" in front
// of a user whose server a control client was syncing with.
//
// The link also stops reporting the evidence entirely once `/_mux` has served it
// a frame. A route that has worked is never condemned by a later absence.
// No `obsidian` import: the notice is a STRING this module owns, and `main.ts`
// puts it in front of the user. That keeps the whole bridge headless and
// therefore deletable in one piece.

import type * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import { TREE_SYNC_TIMEOUT_MS } from '../tree/constants.ts';
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
  + 'will stay out of date until you open them. Update the server, then restart '
  + 'Obsidian.';

/**
 * The OTHER true sentence, for a server that is current but whose multiplexed
 * route cannot be opened — a proxy that only forwards the routes it was told
 * about, most often.
 *
 * ⚠ It must not say the server is old, because it is not, and the user would go
 * and update a server that is already up to date. The two reasons get two
 * strings for exactly that reason: the fallback is only honest if the sentence
 * beside it is.
 */
export const MUX_UNREACHABLE_NOTICE =
  'ShadowLink: your server is reachable but its multiplexed connection is not, '
  + 'so sync is running in the previous mode. Everything still syncs, but notes '
  + 'you have not opened will stay out of date until you open them. A proxy in '
  + 'front of the server usually needs to forward every path, not just the ones '
  + 'it was configured for.';

/** The sentence to put in front of the user for a given verdict. */
export function legacyNoticeFor(reason: MuxUnsupportedReason): string {
  return reason === 'unreachable' ? MUX_UNREACHABLE_NOTICE : LEGACY_SERVER_NOTICE;
}

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

  get connected(): boolean {
    return this.provider.wsconnected;
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
 * Starts on the mux and switches ONCE, and only ever in that direction. What is
 * NOT permanent any more is the mux link's own judgement: it latches "this peer
 * speaks the protocol" per SOCKET, so a server replaced underneath a reconnect is
 * judged on what the new socket says rather than on what the old one said.
 *
 * `onLegacy` fires at most once, after the switch, with the reason — and the
 * reason is what picks the sentence, because "your server is old" and "your
 * server's multiplexed route is blocked" are different problems with different
 * fixes.
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

  /**
   * The legacy route, brought up to answer ONE question: is the server reachable
   * at all? Null until a dial has failed often enough to make that worth asking.
   */
  private probe: TreeTransport | null = null;
  private releaseProbe: (() => void) | null = null;

  /**
   * The probe has answered the only question it was asked, and the answer was
   * "the server is reachable, and this route still is not". Latched so a route
   * that stays dark does not build a fresh `WebsocketProvider` every thirty
   * seconds for the life of the session.
   *
   * It is never cleared, and it does not need to be: `MuxLink` stops reporting
   * the moment the route serves a frame, so nothing asks again.
   */
  private probeAnswered = false;

  private readonly releaseUnreachable: () => void;
  private readonly releaseServed: () => void;

  /** Handlers the plugin registered, re-registered on the transport that wins. */
  private readonly connectedHandlers = new Set<() => void>();
  private releaseConnected: () => void;

  /** Woken when the transport is swapped, so an in-flight `whenSynced` re-asks. */
  private readonly swapWaiters = new Set<() => void>();

  constructor(
    private readonly link: MuxLink,
    private readonly doc: Y.Doc,
    private readonly config: LegacyTreeConfig,
    private readonly onLegacy: ((reason: MuxUnsupportedReason) => void) | undefined,
    private readonly makeLegacy: (config: LegacyTreeConfig, doc: Y.Doc) => TreeTransport,
  ) {
    this.active = new MuxTreeTransport(link, doc, config.room ?? TREE_ROOM);
    this.releaseConnected = this.active.onConnected(() => { this.fireConnected(); });
    link.onUnsupported((reason) => { this.fallBack(reason); });
    this.releaseUnreachable = link.onUnreachable(() => { this.onUnreachable(); });
    // ⚠ A FRAME settles the question the probe was asking — not a socket that
    // merely opened. This used to key off the mux status going `connected`, and
    // against a real proxy that upgrades `/_mux` and then drops every server
    // frame that meant each redial destroyed the probe before it could answer:
    // measured, a fresh `WebsocketProvider` built every 1.6 s, for ever, while
    // the user was told nothing at all.
    this.releaseServed = link.onServed(() => { this.discardProbe(); });
  }

  get synced(): boolean {
    return this.active.synced;
  }

  get connected(): boolean {
    return this.active.connected;
  }

  connect(options: { immediate?: boolean } = {}): void {
    this.wantsConnect = true;
    this.active.connect(options);
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
    this.releaseUnreachable();
    this.releaseServed();
    this.discardProbe();
    this.releaseConnected();
    this.active.destroy();
    this.connectedHandlers.clear();
    this.wakeSwapWaiters();
  }

  /**
   * The mux route has produced nothing, and `MuxLink` says what that looked like.
   *
   * The FIRST report only starts the probe, whatever its evidence: on its own a
   * report says nothing, because a server that is down produces exactly the same
   * one. What the probe answers is the single question `MuxLink` cannot put — does
   * this server answer AT ALL, on the route that has always worked?
   *
   * ⚠ AND THE ANSWER FORKS ON WHAT ENDED THE DIALS, not on how long they took.
   * `link.routeRefused` is true only when the PATH ended them — a 404 at the
   * upgrade, an RST, a refused connection — which is the network saying this route
   * is not served, and is the last thing left that may condemn it. Everything
   * else is a dial this client abandoned or a socket that opened and never spoke,
   * and both of those are indistinguishable from a path that is merely slow.
   * Measured: at twice the probe's own connect as the bound, a variable-latency
   * path still reached a permanent false `unreachable` at 14,527 ms against a
   * server serving `/_mux` normally. There is no fair threshold, so there is no
   * threshold.
   *
   * The other branch is not silence. It records the fact on the link so the
   * status bar can state it, and drops the probe: one transport, one socket, and
   * a user who is told what is true rather than guessed at.
   */
  private onUnreachable(): void {
    if (this.legacy || this.destroyed) return;
    if (this.probe === null) {
      this.startProbe();
      return;
    }
    if (!this.probe.synced) return;
    if (this.link.routeRefused) {
      this.link.markUnsupported('unreachable');
      return;
    }
    this.link.noteRouteUnserved();
    this.probeAnswered = true;
    this.discardProbe();
  }

  private startProbe(): void {
    if (this.probeAnswered) return;
    const probe = this.makeLegacy(this.config, this.doc);
    this.probe = probe;
    this.releaseProbe = probe.onConnected(() => {
      if (this.destroyed || this.legacy) return;
      // The server is reachable. Give the mux route an immediate attempt rather
      // than letting it sit out a backoff rung and lose by default.
      this.link.connect({ immediate: true });
    });
    probe.connect();
    // ⚠ AND ASK AGAIN THE MOMENT THE PROBE CAN ANSWER. The report that built it
    // arrived before it had connected, so the decision has to be retaken — and
    // waiting for the NEXT report costs a whole liveness cycle on a route that is
    // deaf rather than closed. Measured against a real server behind a proxy that
    // upgrades `/_mux` and drops every frame: the statement reached the status bar
    // at 60,447 ms, two watchdog closures in, where the evidence was complete at
    // 30,201 ms. `TREE_SYNC_TIMEOUT_MS` bounds the wait because it is already what
    // everything else in the plugin gives this route; a probe that times out
    // simply leaves the next failed dial to ask, exactly as before.
    void probe.whenSynced(TREE_SYNC_TIMEOUT_MS)
      .then((ok) => { if (ok) this.onUnreachable(); })
      .catch(() => undefined);
  }

  private discardProbe(): void {
    const probe = this.probe;
    this.probe = null;
    this.releaseProbe?.();
    this.releaseProbe = null;
    if (probe === null || probe === this.active) return;
    try {
      probe.destroy();
    } catch {
      /* already gone */
    }
  }

  private fallBack(reason: MuxUnsupportedReason): void {
    if (this.legacy || this.destroyed) return;
    this.legacy = true;
    this.releaseUnreachable();
    this.releaseServed();
    this.releaseConnected();
    // ⚠ ADOPT the probe rather than build a second provider. Two of them on one
    // `Y.Doc` is not a correctness problem — Yjs converges — but it is two
    // sockets, two handshakes and two things to tear down for one job.
    const adopted = this.probe;
    this.probe = null;
    this.releaseProbe?.();
    this.releaseProbe = null;
    this.active.destroy();
    this.active = adopted ?? this.makeLegacy(this.config, this.doc);
    this.releaseConnected = this.active.onConnected(() => { this.fireConnected(); });
    if (this.wantsConnect) this.active.connect();
    this.wakeSwapWaiters();
    this.onLegacy?.(reason);
    // ⚠ THE TRANSITION THE ADOPTED PROBE ALREADY MADE, DELIVERED BY HAND.
    // `onConnected` fires on a transition INTO connected, and on the `unreachable`
    // path the adopted probe is by construction already connected — that is the
    // premise of the verdict. So the handler registered two lines up would never
    // see anything, and `Bootstrap.onReconnect` is BOTH the §4.6 reconnect pass
    // and the only exit from read-only. Measured: verdict at 2,002 ms, `synced`
    // true from then on, zero fires across 32 s; a client that had gone read-only
    // before the swap stayed there against a server that was answering.
    //
    // Every path into read-only needs an exit, and the exit has to be reachable
    // from the state the path actually produces.
    if (this.active.connected) this.fireConnected();
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
