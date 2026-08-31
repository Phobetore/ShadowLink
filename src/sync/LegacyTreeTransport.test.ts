// src/sync/LegacyTreeTransport.test.ts
//
// The removal-scheduled bridge (P3 spec §4 "Compatibility, and its end date").
//
// What is worth testing about a thing scheduled for deletion is exactly the two
// ways it can hurt somebody before it goes:
//
//  * it fires when it should NOT — a flaky reconnect against a perfectly good
//    server tears the whole topology down and tells the user their server is old;
//  * it fires when it should and the plugin does not notice — `Bootstrap` is
//    already inside `connectTree` awaiting a transport that is being replaced
//    under it, so a wait that does not survive the swap reports "the tree never
//    synced", and I3 then refuses to seed anything at all against a server that
//    is working perfectly well and is merely old.
//
// The SHIPPED switcher is what runs here; only the legacy constructor is injected,
// because a `WebsocketProvider` dials a socket in its constructor and this file is
// about the switch rather than about y-websocket. The real old-server proof runs
// against a real pre-P3 server process in the structural suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

import { FakeMux } from './fakes.ts';
import {
  MuxLink, encodeMuxFrame, type MuxSocket, type MuxUnsupportedReason,
} from './MuxLink.ts';
import {
  LEGACY_SERVER_NOTICE, MUX_UNREACHABLE_NOTICE, legacyNoticeFor, openTreeTransport,
  type RouteWitness,
} from './LegacyTreeTransport.ts';
import { TREE_ROOM, type TreeTransport } from './TreeTransport.ts';
import { routeUnserved } from '../ui/format.ts';

/**
 * The sentence, composed the way `main.ts` composes it, at THIS INSTANT.
 *
 * ⚠ THERE IS NOTHING ELSE TO ASK. `link.routeUnserved` used to be a stored
 * answer these tests could read back; every one of them now recomputes it from
 * the bridge's live probe and the link's own counters, which is what the status
 * bar does on every poll. A test that could still read a remembered value would
 * be testing something the plugin no longer has.
 */
function saysUnserved(witness: RouteWitness, link: MuxLink): boolean {
  return routeUnserved({
    serverAnswersElsewhere: witness.serverAnswersElsewhere,
    framesIn: link.stats.framesIn,
    framesOut: link.stats.framesOut,
    condemned: link.unsupportedReason !== null,
  });
}

// ---------------------------------------------------------------- fixtures

const CONFIG = { serverUrl: 'ws://host:1234', serverKey: 'sk', workspaceId: 'ws-1' };

// ⚠ A `sleep` USED TO LIVE HERE, and it went with the mechanism it served: the
// only test that needed real elapsed time was the one asserting the mux dial had
// been widened to what the probe measured. Nothing in this file times anything
// any more, which is the point of the round.

/** Today's topology, without the socket. Only its lifecycle is under test. */
class StubLegacy implements TreeTransport {
  synced = false;
  connected = false;
  connects = 0;
  destroyed = false;
  private readonly handlers = new Set<() => void>();
  private readonly waiters = new Set<(value: boolean) => void>();

  connect(): void { this.connects += 1; }

  whenSynced(ms: number): Promise<boolean> {
    if (this.synced) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const settle = (value: boolean): void => {
        this.waiters.delete(settle);
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.add(settle);
      const timer = setTimeout(() => settle(this.synced), ms);
      // ⚠ UNREF'd, and it is the bridge that made this matter. `startProbe` now
      // asks its probe `whenSynced(TREE_SYNC_TIMEOUT_MS)`, so every case where the
      // probe never arrives leaves a fifteen-second REF'd timer holding the test
      // process open long after its assertions are done — which is exactly the
      // shape a previous round wrote down as "the suite hangs".
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  onConnected(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  destroy(): void { this.destroyed = true; }

  /** The legacy socket completing its own handshake. */
  arrive(): void {
    this.synced = true;
    this.connected = true;
    for (const settle of [...this.waiters]) settle(true);
    for (const handler of [...this.handlers]) handler();
  }

  /**
   * Its window elapsing with no handshake — the per-room route not answering
   * either, which is what a stopped server looks like from the bridge.
   */
  giveUp(): void {
    for (const settle of [...this.waiters]) settle(false);
  }

  /**
   * The socket under a probe that HAD synced closing: a killed server, a dropped
   * Wi-Fi association, a firewall DROP, a laptop lid.
   *
   * ⚠ THE REAL PROVIDER DOES THIS BY ITSELF, which is the whole reason the
   * sentence is read off it rather than recorded. `y-websocket` clears `synced`
   * in its close handler and again on the reconnecting transition, so the bridge
   * needs no notification, no listener and no retraction: the next render simply
   * computes a different value.
   */
  goDark(): void {
    this.synced = false;
    this.connected = false;
  }

  /**
   * The socket OPEN and the handshake never completing — a deaf per-room route,
   * which is the probe's version of the failure `MUX_IDLE_TIMEOUT_MS` exists for.
   *
   * ⚠ IT FIRES `onConnected`, because that transition is real: this is a socket
   * that opened. What never arrives is the sync, which is the only thing that
   * makes the probe able to answer anything.
   */
  openOnly(): void {
    this.connected = true;
    for (const handler of [...this.handlers]) handler();
  }

  /**
   * Synced, without the `status: connected` transition.
   *
   * ⚠ NOT A CONVENIENCE. `arrive()` fires the bridge's own `onConnected`, which
   * calls `link.connect({ immediate: true })` and can produce a fresh refused dial
   * in the same synchronous turn — so a test using it cannot tell a verdict
   * reached from THAT refusal apart from one reached by the probe's answer alone.
   * This is the probe answering and nothing else happening.
   */
  syncOnly(): void {
    this.synced = true;
    this.connected = true;
    for (const settle of [...this.waiters]) settle(true);
  }
}

interface Harness {
  transport: TreeTransport & RouteWitness;
  mux: FakeMux;
  link: MuxLink;
  legacy: StubLegacy;
  notices: MuxUnsupportedReason[];
  dispose(): void;
}

/**
 * The SHIPPED `openTreeTransport`, over a `FakeMux` that is either a current
 * server or a pre-P3 one. When it is the old one, the verdict comes from
 * `MuxLink`'s real detector reading the real bytes an old server sends.
 */
function harness({ legacy = false } = {}): Harness {
  const mux = new FakeMux(legacy ? { legacy: true } : {});
  const doc = new Y.Doc();
  const link = new MuxLink({
    ...CONFIG,
    openSocket: mux.openSocket,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  const stub = new StubLegacy();
  const notices: MuxUnsupportedReason[] = [];
  const transport = openTreeTransport(
    link, doc, CONFIG, (reason) => notices.push(reason), () => stub,
  );
  return {
    transport,
    mux,
    link,
    legacy: stub,
    notices,
    dispose: () => { transport.destroy(); link.destroy(); doc.destroy(); },
  };
}

/** One microtask: what a deferred socket needs to open and greet. */
const settle = (): Promise<void> => Promise.resolve();

// ---------------------------------------------------------------- the good case

test('the tree starts on the mux and stays there against a server that speaks it', () => {
  const h = harness();
  h.transport.connect();
  assert.equal(h.link.connected, true);
  assert.equal(h.transport.synced, true, 'the tree never synced over the mux');
  assert.equal(h.legacy.connects, 0, 'a good server was given the legacy transport anyway');
  assert.deepEqual(h.notices, [], 'the user was told their server is old when it is not');
  assert.equal(h.mux.sockets.length, 1, 'the tree opened more than one socket');
  h.dispose();
});

test('the tree room really is on the link — one socket, one room, this slice', () => {
  const h = harness();
  h.transport.connect();
  assert.deepEqual(h.link.roomNames(), ['_tree']);
  assert.deepEqual(h.mux.sockets[0].openRooms(), ['_tree']);
  h.dispose();
});

// ---------------------------------------------------------------- the switch

test('an old server switches the tree to today\'s topology, and says so once', async () => {
  const h = harness({ legacy: true });
  h.transport.connect();
  await settle();

  assert.deepEqual(h.notices, ['not-a-frame'], 'the user was never told');
  assert.equal(h.legacy.connects, 1, 'the legacy transport was never connected');
  h.dispose();
});

test('a second hostile message after the switch changes nothing', async () => {
  const h = harness({ legacy: true });
  h.transport.connect();
  await settle();
  h.mux.sockets[0].onmessage?.({ data: Uint8Array.from([0xff, 0xff]) });
  assert.deepEqual(h.notices, ['not-a-frame']);
  assert.equal(h.legacy.connects, 1);
  h.dispose();
});

test('the mux room is released by the switch — nothing keeps two transports alive', async () => {
  const h = harness({ legacy: true });
  h.transport.connect();
  assert.equal(h.link.roomCount, 1, 'the tree room was never subscribed');
  await settle();
  assert.equal(h.link.roomCount, 0, 'the mux room survived the switch to legacy');
  h.dispose();
});

test('a switch that lands BEFORE connect does not dial anything unasked', async () => {
  const h = harness({ legacy: true });
  // The link is dialled by `MuxLink` itself only on `connect()`, so provoke the
  // verdict without the plugin having asked for a connection yet.
  h.link.connect();
  await settle();
  assert.equal(h.legacy.connects, 0, 'a transport nobody asked to connect dialled anyway');

  h.transport.connect();
  assert.equal(h.legacy.connects, 1);
  h.dispose();
});

test('a wait in flight SURVIVES the switch — Bootstrap is already inside connectTree', async () => {
  const h = harness({ legacy: true });
  h.transport.connect();
  // The socket has not opened yet (a legacy fake opens on a later turn), so this
  // wait is genuinely pending when the verdict lands.
  const pending = h.transport.whenSynced(2_000);
  await settle();
  assert.deepEqual(h.notices, ['not-a-frame'], 'the switch did not happen');
  h.legacy.arrive();
  assert.equal(await pending, true, 'a wait that spanned the switch reported a failure');
  h.dispose();
});

test('a wait that spans the switch still honours its own deadline', async () => {
  const h = harness({ legacy: true });
  h.transport.connect();
  const started = Date.now();
  const pending = h.transport.whenSynced(120);
  await settle();
  assert.equal(await pending, false, 'a transport nobody answered reported a sync');
  assert.equal(Date.now() - started < 1_500, true, 'the deadline was restarted by the switch');
  h.dispose();
});

test('the reconnect subscription follows the switch, so onReconnect still fires', async () => {
  const h = harness({ legacy: true });
  let reconnects = 0;
  h.transport.onConnected(() => { reconnects += 1; });
  h.transport.connect();
  await settle();
  const before = reconnects;
  h.legacy.arrive();
  assert.equal(
    reconnects, before + 1,
    'the plugin\'s reconnect handler was left on the transport that was thrown away',
  );
  h.dispose();
});

test('destroy releases whichever transport is active', async () => {
  const h = harness({ legacy: true });
  h.transport.connect();
  await settle();
  h.transport.destroy();
  assert.equal(h.legacy.destroyed, true, 'the legacy transport was leaked');
  h.link.destroy();
});

test('a destroyed transport cannot be switched afterwards', async () => {
  const h = harness({ legacy: true });
  h.transport.connect();
  h.transport.destroy();
  await settle();
  assert.equal(h.legacy.connects, 0, 'a torn-down transport still built a legacy one');
  h.link.destroy();
});

// ---------------------------------------------------------------- the notice

test('the notice says what the user can act on, and never names an endpoint', () => {
  assert.match(LEGACY_SERVER_NOTICE, /older than this plugin/);
  assert.match(LEGACY_SERVER_NOTICE, /until you open them/);
  // "_mux" is not something a self-hoster can act on, and naming it would date
  // the message the moment the route is renamed.
  assert.equal(LEGACY_SERVER_NOTICE.includes('_mux'), false);
});

// ---------------------------------------------------------------- removability

test('the bridge is ONE file, and the permanent transport names nothing legacy', async () => {
  // P3 §Rejected 6: a removal-scheduled bridge, not a second supported mode. The
  // test of that claim is mechanical — nothing permanent may name it, or the
  // deletion becomes an untangling.
  const { readFileSync } = await import('node:fs');
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

  // What matters is what would fail to COMPILE, so the check is on import
  // specifiers rather than on prose: `TreeTransport.ts` deliberately names the
  // bridge in a comment, because that comment is where a future maintainer reads
  // why the interface exists at all.
  const imports = (source: string): string[] => [
    ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);

  for (const permanent of ['./MuxLink.ts', './MuxRoom.ts', './TreeTransport.ts']) {
    const source = read(permanent);
    for (const spec of imports(source)) {
      assert.equal(
        spec.includes('LegacyTreeTransport'), false,
        `${permanent} imports the bridge, so deleting the bridge would not compile`,
      );
      assert.equal(
        spec === 'y-websocket', false,
        `${permanent} imports y-websocket — the mux path must not construct a provider`,
      );
    }
  }

  // The entry point names the bridge module exactly once: the import.
  const main = read('../../main.ts');
  const mentions = main.split('./src/sync/LegacyTreeTransport').length - 1;
  assert.equal(mentions, 1, `main.ts imports the bridge ${mentions} times, expected 1`);
  assert.equal(main.includes('openTreeTransport('), true, 'main.ts no longer uses the factory');
  assert.equal(
    main.includes('new WebsocketProvider('), false,
    'main.ts constructs a provider directly; the tree\'s belongs to the bridge',
  );
});

// ---------------------------------------------------------------- the route that will not open

/**
 * A harness whose ladder can actually be walked, and which hands out a FRESH
 * legacy transport each time the switcher asks for one — because the probe and
 * the transport that eventually wins are two different questions being asked of
 * the same constructor.
 */
function unreachableHarness({ connectTimeoutMs = 0, hang = false } = {}): {
  transport: TreeTransport & RouteWitness;
  mux: FakeMux;
  link: MuxLink;
  made: StubLegacy[];
  notices: MuxUnsupportedReason[];
  fire: () => void;
  dispose(): void;
} {
  const mux = new FakeMux();
  const doc = new Y.Doc();
  const timers: Array<{ fn: () => void } | undefined> = [];
  const link = new MuxLink({
    ...CONFIG,
    // ⚠ `hang` is the OTHER shape a route that produces nothing has, and the two
    // must not be confused: `FakeMux.refuseConnect` throws, which is the path
    // saying no, while this one accepts the connection and never finishes it —
    // a black-holed upgrade, and byte-for-byte what an arbitrarily slow path
    // looks like until it finally opens.
    openSocket: hang
      ? (): MuxSocket => ({
        readyState: 0,
        bufferedAmount: 0,
        send: () => undefined,
        close: () => undefined,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      })
      : mux.openSocket,
    idleTimeoutMs: 0,
    connectTimeoutMs,
    unreachableDials: 2,
    random: () => 0.5,
    setTimer: (fn) => { timers.push({ fn }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  const made: StubLegacy[] = [];
  const notices: MuxUnsupportedReason[] = [];
  const transport = openTreeTransport(
    link, doc, CONFIG, (reason) => notices.push(reason),
    () => { const stub = new StubLegacy(); made.push(stub); return stub; },
  );
  const fire = (): void => {
    const due = timers.splice(0).filter((t) => t !== undefined);
    for (const timer of due) timer.fn();
  };
  return {
    transport, mux, link, made, notices, fire,
    dispose: () => { transport.destroy(); link.destroy(); doc.destroy(); },
  };
}

test('a route that will not OPEN falls back once the per-room route is proved to work', () => {
  // ⚠ MEASURED, and it is why this path exists at all: every other route into the
  // verdict needs a socket that OPENED, so a `/_mux` upgrade refused with a 404
  // reached nothing. Against a real server behind such a proxy:
  // `whenSynced(15000)` false, verdict empty, `unsupportedReason` null, notice
  // never shown, the link dialling for ever — while a plain per-room client on
  // the SAME path synced. Afterwards: verdict and a synced tree at 1,615 ms.
  const h = unreachableHarness();
  // Refused from the first dial, which is what a 404 on `/_mux` is: the route has
  // never served this link, so failed dials are still reportable evidence.
  h.mux.refuseConnect = true;
  h.transport.connect();                         // a first dial fails: not evidence yet
  h.fire();                                      // and a second: evidence, not a verdict

  assert.equal(h.made.length, 1, 'the per-room route was never tried');
  assert.equal(h.link.unsupportedReason, null,
    'failed dials condemned the route before anything had been proved');
  assert.deepEqual(h.notices, [], 'the user was told something before it was known');

  // The per-room route works. That is the other half of the evidence.
  h.made[0]?.arrive();
  h.fire();                                      // and the mux STILL will not open

  assert.equal(h.link.unsupportedReason, 'unreachable');
  assert.deepEqual(h.notices, ['unreachable']);
  assert.equal(h.transport.synced, true, 'the tree did not end up on the route that works');
  assert.equal(h.made.length, 1, 'the probe was thrown away and a second one built');
  assert.equal(h.made[0]?.destroyed, false, 'the transport that won was destroyed');
  h.dispose();
});

test('the adopted probe delivers the connected transition it was already past', () => {
  // ⚠ MEASURED, and it is the only exit from read-only. `main.ts` registers
  // `onConnected` -> `Bootstrap.onReconnect`, which is both the §4.6 reconnect
  // pass and the one thing that clears `_readOnlyReason`. On the `unreachable`
  // path the adopted probe is already connected — that IS the premise of the
  // verdict — so a handler registered after the swap sees nothing at all.
  // Against a real server behind a 404-ing proxy: verdict at 2,002 ms, `synced`
  // true from then on, ZERO fires across 32 s of samples.
  const h = unreachableHarness();
  let fires = 0;
  h.transport.onConnected(() => { fires += 1; });
  h.mux.refuseConnect = true;
  h.transport.connect();
  h.fire();
  assert.equal(fires, 0, 'something fired before there was anything to fire about');

  h.made[0]?.arrive();
  h.fire();
  assert.equal(h.link.unsupportedReason, 'unreachable', 'the verdict never happened');
  assert.equal(fires, 1, 'the swap left the session with no exit from read-only');
  assert.equal(h.transport.connected, true);
  h.dispose();
});

test('a route that already served this link is never demoted, and no probe is built', () => {
  // ⚠ MEASURED, and it is the same rule from the other side. `unreachable` needs
  // failed dials, and an outage, a slept radio or a proxy restart produce exactly
  // those on a route that works. Before this: five seconds of `/_mux`-only
  // trouble on an otherwise-working server demoted the session permanently, 3/3,
  // and a flaky path demoted one that had already synced over the mux at
  // 28,115 ms — where the parent branch rode out ten cuts on the same path.
  const h = unreachableHarness();
  h.transport.connect();
  assert.equal(h.link.everServed, true, 'the mux route never worked in the first place');

  h.mux.refuseConnect = true;
  h.mux.dropSockets();
  for (let i = 0; i < 8; i += 1) h.fire();

  assert.ok(h.link.stats.dialsFailed >= 2, 'no dial actually failed');
  assert.equal(h.made.length, 0, 'a probe was built against a route that had worked');
  assert.equal(h.link.unsupportedReason, null, 'an outage demoted a working route');
  assert.deepEqual(h.notices, []);
  h.dispose();
});

test('a dial NOBODY refused is never a verdict, however many of them there are', () => {
  // ⚠ THE ROUND, IN ONE TEST. Three attempts were made to price this comparison —
  // a fixed 4 s bound, then a bound widened to twice the probe's own connect —
  // and a variable-latency path defeated both, because the mux's draw and the
  // probe's draw are two samples from the same distribution. Measured on the
  // parent branch against the shipped server serving `/_mux` normally, behind a
  // proxy drawing 75% of its connections from 5.5-8.5 s and 25% from 1.2-2.2 s:
  // a PERMANENT false `unreachable` at 14,527 ms, framesIn 0, notice shown.
  //
  // Here every dial simply hangs, which is what a black-holed upgrade and an
  // arbitrarily slow path BOTH look like from inside. No number of them may
  // condemn anything.
  const h = unreachableHarness({ connectTimeoutMs: 40, hang: true });
  h.transport.connect();
  for (let i = 0; i < 6; i += 1) h.fire();

  assert.ok(h.link.stats.dialsAbandoned >= 2, 'no dial actually ran out of time');
  assert.equal(h.link.stats.dialsRefused, 0, 'the hanging dial was read as a refusal');
  // ⚠ AND IT REACHES NOTHING AT ALL — not a verdict, and not a sentence either.
  // The abandoned run used to build a probe and, through it, a permanent
  // user-facing statement about the route with no socket, no frame and no byte
  // behind it. Measured against a HEALTHY server serving `/_mux` correctly behind
  // a proxy forwarding every byte and merely delaying each connection by 13 s: a
  // permanent "nothing is coming back on its multiplexed connection" from
  // 26,177 ms, `dialsRefused` 0, the route carrying the connection perfectly.
  // The cost is named where it lands: a black-holed upgrade now says only the
  // thing that is true of it, which is that this device could not reach the
  // workspace.
  assert.equal(h.made.length, 0,
    'the client\'s own deadline sent the bridge looking for something to say');
  assert.equal(saysUnserved(h.transport, h.link), false,
    'a deadline produced a sentence about the route');
  assert.equal(h.link.unsupportedReason, null, 'a stopwatch condemned the route after all');
  assert.deepEqual(h.notices, [], 'the user was told their server was wrong');
  h.dispose();
});

/**
 * A route that UPGRADES and then says nothing: the socket opens at once and is
 * deaf for ever, the clock is ours, and `refuse` flips the path to ending every
 * dial — which is what a proxy reload, or a server that has stopped, looks like
 * from in here.
 *
 * This is the shape the honest sentence is built for, and since this round it is
 * the ONLY shape that reaches it: a socket that opened and carried frames out is
 * something that happened, where a dial that never opened is only a deadline.
 */
function deafHarness({ hold = false } = {}): {
  transport: TreeTransport & RouteWitness;
  link: MuxLink;
  made: StubLegacy[];
  notices: MuxUnsupportedReason[];
  sockets: MuxSocket[];
  refuse(value: boolean): void;
  run(cycles: number): void;
  dispose(): void;
} {
  const clock = { t: 0 };
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const sockets: MuxSocket[] = [];
  let refusing = false;
  const link = new MuxLink({
    ...CONFIG,
    openSocket: (): MuxSocket => {
      if (refusing) throw new Error('the path ended this dial');
      const socket: MuxSocket = {
        // ⚠ `hold` IS THE BLACK HOLE, and it is a different shape from `refusing`.
        // The TCP connection is accepted and the upgrade is never answered, so the
        // socket sits in CONNECTING until this client's own deadline ends it — no
        // frame goes out, nothing is refused, and nothing the path did is
        // observable. It is the shape a refusal run breaks into, and the one that
        // stranded the probe.
        readyState: hold ? 0 : 1,                  // OPEN at once, and deaf for ever
        bufferedAmount: 0,
        send: () => undefined,
        close: (): void => {
          (socket as { readyState: number }).readyState = 3;
          socket.onclose?.({});
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      sockets.push(socket);
      return socket;
    },
    connectTimeoutMs: hold ? 4_000 : 0,
    idleTimeoutMs: 30_000,
    unreachableDials: 2,
    random: () => 0.5,
    now: () => clock.t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  const made: StubLegacy[] = [];
  const doc = new Y.Doc();
  const notices: MuxUnsupportedReason[] = [];
  const transport = openTreeTransport(
    link, doc, CONFIG, (reason) => notices.push(reason),
    () => { const stub = new StubLegacy(); made.push(stub); return stub; },
  );
  return {
    transport, link, made, notices, sockets,
    refuse: (value: boolean): void => { refusing = value; },
    run: (cycles: number): void => {
      for (let i = 0; i < cycles; i += 1) {
        clock.t += 3_000;
        for (const timer of timers.splice(0).filter((t) => t !== undefined)) timer.fn();
      }
    },
    dispose: (): void => { transport.destroy(); link.destroy(); doc.destroy(); },
  };
}

test('what a route producing nothing gets instead is the truth, and one probe', () => {
  // ⚠ THE HOLE DELETING THE LAST ABSENCE-VERDICT LEFT, filled without inferring
  // anything. Measured on an earlier branch through a proxy that upgrades `/_mux`
  // for real and drops every server frame: 70 s, 3 sockets, 2 idle closures, 18
  // frames out, 0 in, NO PROBE EVER BUILT, no verdict, the tree never synced, and
  // a status bar reading "ShadowLink could not reach the workspace" against a
  // server a control client was syncing with on the per-room route.
  const h = deafHarness();
  h.transport.connect();
  assert.ok(h.link.stats.framesOut > 0, 'the room never asked the route for anything');
  h.run(11);                                     // one full idle cycle of silence
  assert.equal(h.link.stats.idleClosures, 1, 'the deaf socket was never closed');
  assert.equal(h.made.length, 1, 'a deaf route was never even looked into');
  assert.equal(saysUnserved(h.transport, h.link), false,
    'the sentence was said before the probe had answered anything');

  h.made[0]?.syncOnly();                         // the server DOES answer, elsewhere

  // ⚠ AND THE SENTENCE IS TRUE IN THE SAME TURN, with nothing re-entering and
  // nothing recorded. It used to need a second decision taken on the probe's own
  // `whenSynced`, and before that a whole extra liveness cycle — measured at
  // 60,447 ms where the evidence was complete at 30,201 ms.
  assert.equal(saysUnserved(h.transport, h.link), true,
    'the one thing measurement establishes here was never said');
  assert.equal(h.link.unsupportedReason, null, 'a fact was allowed to become a verdict');
  assert.deepEqual(h.notices, []);

  // ⚠ AND THE PROBE IS KEPT, WHICH IS THE OTHER HALF OF THE ROUND. It used to be
  // destroyed the moment it answered, because the answer had been copied onto the
  // link as a record. There is no record: the probe IS the evidence, so throwing
  // it away would throw the sentence away with it.
  assert.equal(h.made[0]?.destroyed, false,
    'the evidence the sentence is computed from was destroyed');
  h.dispose();
});

test('the sentence is not remembered, so it does not have to be re-earned', () => {
  // ⚠ THE PRICE OF THE PREVIOUS ROUND, NO LONGER PAID. Deleting the old
  // `probeAnswered` latch made every report build a FRESH `WebsocketProvider` on
  // the tree doc — one per `MUX_IDLE_TIMEOUT_MS`, for ever, on any dark route —
  // because the answer expired and the next report had to ask again. Nothing
  // expires now: the probe stays up and the sentence is read off it, so a route
  // that is dark for an hour costs one provider rather than 120.
  const h = deafHarness();
  h.transport.connect();
  h.run(11);
  h.made[0]?.syncOnly();
  assert.equal(saysUnserved(h.transport, h.link), true);

  h.run(44);                                     // four more cycles of the same silence
  assert.ok(h.link.stats.idleClosures >= 3, 'the watchdog stopped closing deaf sockets');
  assert.equal(h.made.length, 1,
    `a dark route built ${h.made.length} providers on the tree doc for one question`);
  assert.equal(saysUnserved(h.transport, h.link), true,
    'the sentence lapsed on a route that was still exactly as dark');
  h.dispose();
});

test('the probe does not outlive the transport that owns it', () => {
  // ⚠ THE COST OF MAKING THE PROBE THE EVIDENCE IS THAT IT IS NOW HELD, so the
  // three places that end the question have to be the three places that let it go,
  // and `destroy` is the one no shape of the network reaches. A survivor of the
  // mutation sweep: removing `discardProbe()` from `destroy` left every suite
  // green, and the cost is a live `WebsocketProvider` and its socket outliving a
  // disposed runtime — on a plugin that is disabled, reloaded, or has its share
  // reconfigured, which is the ordinary case rather than an exotic one.
  const h = deafHarness();
  h.transport.connect();
  h.run(11);
  h.made[0]?.syncOnly();
  assert.equal(saysUnserved(h.transport, h.link), true, 'no probe was ever built to leak');

  h.transport.destroy();
  assert.equal(h.made[0]?.destroyed, true,
    'the probe kept its socket open after the transport holding it was disposed');
  assert.equal(h.transport.serverAnswersElsewhere, false,
    'a destroyed transport still claimed to be watching the server answer');
  h.link.destroy();
});

test('a probe that stops answering ends the sentence, with nothing retracting it', () => {
  // ⚠ THE DEFECT THIS ROUND EXISTS TO CLOSE, AND THE SHAPE ALL FIVE PREVIOUS ONES
  // MISSED. Every retraction ever added here needed the link to still be TALKING:
  // a frame needs a socket, a refused dial needs the path to reject, a
  // condemnation needs a verdict, a re-probe needs a report. A path that DROPS —
  // a firewall DROP rule, a drained load balancer, a dead VPN, a killed server
  // behind any of them — does none of those. Measured against real processes on
  // the previous branch: statement at 45,170 ms, path black-holed and RST at
  // 45,188 ms, and at 105,236 ms the bar still read "ShadowLink can reach your
  // server … 11 message(s) have gone out" with `dialsRefused` 0 and the watchdog
  // frozen at one closure, suppressing the one sentence that was true.
  //
  // Here nothing retracts, because nothing is remembered. The probe's socket
  // closes, `synced` goes false — y-websocket does that itself — and the next
  // render computes a different value. No report, no dial and no handler is
  // involved, which is exactly why no shape can be missed.
  const h = deafHarness();
  h.transport.connect();
  h.run(11);
  h.made[0]?.syncOnly();
  assert.equal(saysUnserved(h.transport, h.link), true);
  const refusedBefore = h.link.stats.dialsRefused;
  const closuresBefore = h.link.stats.idleClosures;

  h.made[0]?.goDark();                           // the server, or the path to it, is gone

  assert.equal(saysUnserved(h.transport, h.link), false,
    'the claim outlived the probe it was computed from');
  assert.equal(h.link.stats.dialsRefused, refusedBefore,
    'the sentence needed a refused dial to end, which a dark path never produces');
  assert.equal(h.link.stats.idleClosures, closuresBefore,
    'the sentence needed another liveness cycle, which a closed socket never produces');
  assert.equal(h.link.unsupportedReason, null, 'a value going false became a verdict');
  assert.deepEqual(h.notices, []);

  // And it comes back by itself when the probe does, with nothing re-establishing
  // it: the same three reads, a different answer.
  h.made[0]?.syncOnly();
  assert.equal(saysUnserved(h.transport, h.link), true,
    'a sentence that had stopped being true could never become true again');
  h.dispose();
});

test('a refused dial does not have to end the sentence, and the server dying does', () => {
  // The retraction that used to live in `MuxLink.noteFailedDial` and went with the
  // belief it retracted. It fired fast — 1,855 ms against a real killed process —
  // and it was still only one shape of the several that end a server's life. What
  // covers all of them is that the probe rides the same path: a server that is
  // gone stops answering it, whether the path RSTs, 404s or swallows the packet.
  const h = deafHarness();
  h.transport.connect();
  h.run(11);
  h.made[0]?.syncOnly();
  assert.equal(saysUnserved(h.transport, h.link), true);

  h.refuse(true);                                // the path starts refusing every dial
  h.made[0]?.goDark();                           // and the probe on it stops answering
  h.run(14);

  assert.ok(h.link.stats.dialsRefused >= 1, 'no dial was actually refused');
  assert.equal(saysUnserved(h.transport, h.link), false,
    'the bar went on claiming the server answers after everything said otherwise');
  assert.equal(h.link.unsupportedReason, null,
    'a server that is merely gone was condemned as a blocked route');
  assert.deepEqual(h.notices, []);
  h.dispose();
});

test('a route that went deaf and is THEN refused still reaches the verdict', () => {
  // ⚠ A REGRESSION AGAINST AN EARLIER PARENT, MEASURED WITH ONE PROBE ON BOTH. A
  // proxy that upgrades `/_mux` and swallows every server frame, then reloads into
  // 404-ing it and RSTs the live pairs — which is what a proxy reload does. On the
  // parent the refusal phase reached `unreachable` in 248 ms with the notice and a
  // synced tree; on the branch that latched its probe, 25 s and 368 refused dials
  // later the verdict was still null with `routeRefused` true the whole time.
  // Nothing may become unreachable for a session because of the order two shapes
  // arrived in.
  const h = deafHarness();
  h.transport.connect();
  h.run(11);
  h.made[0]?.syncOnly();
  assert.equal(saysUnserved(h.transport, h.link), true, 'the deaf phase never reported at all');

  h.refuse(true);                                // the proxy is reloaded: 404 and RST
  h.run(14);                                     // the deaf socket closes and the dials fail

  assert.ok(h.link.routeRefused, 'a run of refusals was not recognised as one');
  assert.equal(h.link.unsupportedReason, 'unreachable',
    'the bridge was latched shut by its own earlier answer');
  assert.deepEqual(h.notices, ['unreachable']);
  assert.equal(h.made.length, 1, 'the verdict needed a second provider to reach');
  assert.equal(h.transport.synced, true, 'the tree did not end up on the route that works');
  assert.equal(saysUnserved(h.transport, h.link), false,
    'a session that had already fallen back was told nothing was syncing');
  h.dispose();
});

test('a refusal run that breaks with no socket ever opening still says something', () => {
  // ⚠ THE SECOND BLOCKER, AND IT IS A LIFETIME BUG RATHER THAN A BELIEF. Shape: a
  // proxy that 404s the first `/_mux` upgrades and then BLACK-HOLES every one
  // after — a backend that is down when the client starts and then comes up
  // listening but not yet answering upgrades, or the slow proxy INSTALL.md sends
  // self-hosters to. Two refusals build the probe; the probe answers; the run is
  // then broken by a dial this client abandoned; and `reportRoute`'s only two
  // callers are a refusal run (never again) and a watchdog on an OPEN socket
  // (never again). Nothing could re-enter the decision.
  //
  // Measured against real processes at fully shipped constants, 80 s: no verdict,
  // no sentence of any kind, `dialsRefused` frozen at 2, `dialsAbandoned` 6,
  // `idleClosures` 0, a bar reading "ShadowLink could not reach the workspace" —
  // and a live, SYNCED provider nobody owned, through which the local edit was
  // reaching the server the whole time. The plugin's own socket disproved its own
  // bar.
  //
  // Nothing needs to re-enter any more. The probe's lifetime belongs to the
  // question rather than to the report that asked it, so it is still up; and the
  // sentence is computed rather than recorded, so it is true the moment the probe
  // is — which is what puts the lever in front of a user who is otherwise stuck.
  const h = deafHarness({ hold: true });
  h.transport.connect();

  h.refuse(true);
  h.run(8);                                      // the run of refusals, and the probe
  assert.equal(h.made.length, 1, 'the bridge never went to look');
  assert.equal(h.link.routeRefused, true, 'a run of refusals was not recognised as one');
  h.made[0]?.syncOnly();                         // the server answers on the per-room route

  h.refuse(false);                               // the path stops refusing and starts hanging
  h.run(10);                                     // every dial from here is abandoned

  assert.ok(h.link.stats.dialsAbandoned >= 1, 'no dial was actually abandoned');
  assert.equal(h.link.routeRefused, false, 'the abandoned dial did not break the run');
  assert.equal(h.link.stats.framesOut, 0,
    'a socket carried something, so this is not the shape under test');
  assert.equal(h.link.unsupportedReason, null,
    'a black hole was condemned on refusals gathered before it started');

  // The session is not silent and the provider is not an orphan: it is the
  // evidence, and the sentence it supports names the one lever the user has.
  assert.equal(saysUnserved(h.transport, h.link), true,
    'the session was left with no conclusion of any kind');
  assert.equal(h.made[0]?.destroyed, false, 'the evidence was thrown away');
  assert.equal(h.made.length, 1, 'the stranded probe was joined by a second one');
  h.dispose();
});

test('a socket that OPENS but never speaks does not settle the probe\'s question', () => {
  // ⚠ MEASURED AS A DEFECT, against a real server behind a proxy that upgrades
  // `/_mux` and drops every server frame: the bridge discarded its probe on the
  // mux status going `connected`, the socket opened every 1.6 s, each open
  // destroyed the probe before it could answer, and a fresh `WebsocketProvider`
  // was built in its place for ever while the user was told nothing at all. An
  // open socket settles nothing here; a FRAME does.
  const h = deafHarness();
  h.transport.connect();
  h.run(11);                                     // one full idle cycle of silence

  assert.equal(h.link.stats.idleClosures, 1, 'the deaf socket was never closed');
  assert.equal(h.made.length, 1, 'a deaf route was never even looked into');
  assert.ok(h.sockets.length >= 2, 'the ladder never redialled');
  assert.equal(h.made[0]?.destroyed, false,
    'a socket that merely opened threw the probe away before it could answer');
  h.dispose();
});

test('a REFUSED route still reaches the verdict, and that is the only thing that does', () => {
  // The two shapes side by side, in the same harness: `refuseConnect` throws,
  // which is the path saying no, and that is the last evidence a demotion may
  // rest on. It is also what 80f drives against a real 404-ing proxy.
  const refused = unreachableHarness();
  refused.mux.refuseConnect = true;
  refused.transport.connect();
  refused.fire();
  refused.made[0]?.arrive();
  refused.fire();
  assert.equal(refused.link.routeRefused, true, 'a run of refusals was not recognised as one');
  assert.equal(refused.link.unsupportedReason, 'unreachable');
  assert.deepEqual(refused.notices, ['unreachable']);
  assert.equal(saysUnserved(refused.transport, refused.link), false,
    'a route with a verdict also got the sentence for routes without one');
  refused.dispose();
});

test('a server that is merely DOWN is not demoted — the per-room route fails too', () => {
  // ⚠ The other half, and the reason `MuxLink` reports rather than concludes. A
  // browser `WebSocket` reports a refused upgrade and a dead server as the same
  // bare close, on purpose, so a link that fell back on failed dials alone would
  // demote a whole session every time a server restarted. Measured against a real
  // server stopped for twelve seconds: five failed dials, no verdict, no notice,
  // and the mux back up 6,634 ms after the server returned.
  // Bootstrapped while the server is down, so the mux route has never served this
  // link and its failed dials are still reportable evidence. That is the harder
  // half: once the route HAS served, nothing is reported at all (below).
  const h = unreachableHarness();
  h.mux.refuseConnect = true;
  h.transport.connect();
  h.fire();
  assert.equal(h.made.length, 1, 'the per-room route was never tried');

  // The probe cannot sync either: nothing is listening.
  for (let i = 0; i < 4; i++) h.fire();
  assert.equal(h.link.unsupportedReason, null, 'a server that is down was called incompatible');
  assert.deepEqual(h.notices, []);

  // The server comes back, on both routes.
  h.mux.refuseConnect = false;
  h.fire();
  assert.equal(h.link.connected, true, 'the ladder never brought the link back');
  assert.equal(h.link.unsupportedReason, null);
  assert.equal(h.made[0]?.destroyed, true, 'the probe was left running beside a working mux');
  assert.deepEqual(h.notices, [], 'an ordinary outage told the user their server is wrong');
  h.dispose();
});

test('the refused branch keeps its probe, so the next refusal has something to decide with',
  async () => {
    // ⚠ THE OTHER HALF OF THE CONCURRENCY RULE, and without it the rule costs the
    // verdict rather than sharpening it. The probe's answer alone may not condemn
    // the route, because every refusal behind it was counted before anyone knew
    // the server was up. But letting the probe GO at that point means the next
    // refusal arrives with nothing synced to weigh it against, so the bridge
    // builds another provider, which answers, which is let go again — a provider
    // per refused dial and a verdict that only ever lands by luck.
    //
    // So it waits. It does not wait long: a path refusing this route refuses the
    // next dial too, and a path that stops refusing breaks the run.
    const h = unreachableHarness();
    h.mux.refuseConnect = true;
    h.transport.connect();
    h.fire();                                    // two refusals: a report, and a probe
    assert.equal(h.made.length, 1, 'the per-room route was never tried');

    h.made[0]?.syncOnly();                       // the probe answers, and only that
    await settle();
    await settle();
    assert.equal(h.link.unsupportedReason, null,
      'refusals counted before the server was known to be up were cashed in');
    assert.equal(h.made[0]?.destroyed, false,
      'the probe was let go while the path was still refusing the route');
    assert.equal(h.made.length, 1, 'a provider was built for a refusal already reported');

    h.fire();                                    // one more refusal, probe still synced
    assert.equal(h.link.unsupportedReason, 'unreachable',
      'a refusal reported while the probe was answering did not decide anything');
    assert.deepEqual(h.notices, ['unreachable']);
    assert.equal(h.made.length, 1, 'the verdict needed a second provider on the tree doc');
    h.dispose();
  });

test('refusals gathered while the server was down are not cashed in by its recovery', async () => {
  // ⚠ MEASURED AS A NEW PERMANENT FALSE DEMOTION. A real `server/index.js`,
  // stopped before the client starts and restarted D ms later, then serving
  // `/_mux` normally for the whole run: a false `unreachable` and the
  // proxy-blaming notice on 5 of 12 outage lengths and on 5 of 5 repeats at
  // D = 2,000 ms, where the parent branch produced 0 of 12. The trigger was not a
  // fresh failure — traced at D = 7,000 ms, the notice fired at 9,264 ms while the
  // dial that was about to succeed was still in flight — it was the probe's
  // re-ask cashing in a refusal count gathered entirely while the server was down.
  //
  // A verdict is one sentence about one moment: the server answers AND this path
  // refuses this route. So the refusal has to be reported while the probe is
  // answering, and a probe that has only just finished its own handshake settles
  // nothing about dials that failed before anyone knew the server was up.
  const timers: Array<{ fn: () => void } | undefined> = [];
  const sockets: MuxSocket[] = [];
  let down = true;
  const link = new MuxLink({
    ...CONFIG,
    openSocket: (): MuxSocket => {
      if (down) throw new Error('the server is not listening');
      // Back, and this dial is IN FLIGHT: accepted, not yet open. That is the
      // state the recovering path is actually in when the probe answers.
      const socket: MuxSocket = {
        readyState: 0,
        bufferedAmount: 0,
        send: () => undefined,
        close: () => undefined,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      sockets.push(socket);
      return socket;
    },
    idleTimeoutMs: 0,
    connectTimeoutMs: 0,
    unreachableDials: 2,
    random: () => 0.5,
    setTimer: (fn) => { timers.push({ fn }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  const made: StubLegacy[] = [];
  const doc = new Y.Doc();
  const notices: MuxUnsupportedReason[] = [];
  const transport = openTreeTransport(
    link, doc, CONFIG, (reason) => notices.push(reason),
    () => { const stub = new StubLegacy(); made.push(stub); return stub; },
  );
  const fire = (): void => {
    for (const timer of timers.splice(0).filter((t) => t !== undefined)) timer.fn();
  };

  transport.connect();
  fire();
  assert.equal(link.routeRefused, true, 'the outage did not produce a run of refused dials');
  assert.equal(made.length, 1, 'the bridge never went to look');

  down = false;                                   // the server is back, on both routes
  made[0]?.arrive();                              // and the probe finally says so
  await settle();
  await settle();

  assert.equal(link.unsupportedReason, null,
    'an outage that ended was read as a route the path refuses');
  assert.deepEqual(notices, [], 'the user was told to reconfigure a proxy that is fine');
  assert.ok(sockets.length >= 1, 'the recovery never produced a dial at all');
  // ⚠ AND THE SENTENCE IS TRUE FOR AS LONG AS IT IS TRUE, which here is until
  // the dial in flight lands. The server IS answering the probe and the mux route
  // HAS carried nothing, so saying so is correct; what would be wrong is a verdict,
  // or a record that had to be taken back afterwards. There is no record.
  assert.equal(saysUnserved(transport, link), true,
    'a state that was true of the route at that instant was not said');

  // And the dial that was in flight opens and serves, which ends the question and
  // the sentence together, with nothing retracting either.
  sockets[sockets.length - 1]?.onopen?.();
  assert.equal(link.routeRefused, false, 'an open socket did not clear the run');
  sockets[sockets.length - 1]?.onmessage?.({
    data: encodeMuxFrame(TREE_ROOM, new Uint8Array([0, 0])),
  });
  assert.equal(link.everServed, true, 'the route served and nothing recorded it');
  assert.equal(saysUnserved(transport, link), false,
    'a route that had just delivered a frame still read as delivering nothing');
  assert.equal(made[0]?.destroyed, true, 'the probe was left running beside a working mux');
  assert.equal(link.unsupportedReason, null);
  assert.deepEqual(notices, []);
  transport.destroy(); link.destroy(); doc.destroy();
});

test('the two verdicts get two sentences, and neither says the other one\'s thing', () => {
  // "Update your server" is false for a current server behind a proxy that will
  // not forward the route, and sending somebody to update a server that is
  // already up to date is worse than saying nothing.
  assert.equal(legacyNoticeFor('not-a-frame'), LEGACY_SERVER_NOTICE);
  assert.equal(legacyNoticeFor('unreachable'), MUX_UNREACHABLE_NOTICE);
  assert.notEqual(MUX_UNREACHABLE_NOTICE, LEGACY_SERVER_NOTICE);
  assert.ok(!MUX_UNREACHABLE_NOTICE.includes('older'),
    'the unreachable notice blames the server version for a routing problem');
  for (const notice of [LEGACY_SERVER_NOTICE, MUX_UNREACHABLE_NOTICE]) {
    assert.ok(!notice.includes('_mux'),
      'the notice names an endpoint a self-hoster cannot act on');
  }
  // ⚠ `startSync()` runs once at layout-ready and the link never re-probes, so
  // "update the server" on its own is an instruction that does not work.
  assert.ok(LEGACY_SERVER_NOTICE.includes('restart Obsidian')
    || LEGACY_SERVER_NOTICE.includes('restart Obsidian.'),
    'the notice promises a repair the running session cannot make');
});

// ------------------------------------------------- the probe's own two bounds

/**
 * A harness whose PROBE clock is ours as well as the link's.
 *
 * ⚠ THE BRIDGE'S TIMERS ARE INJECTED ONLY HERE, and that is deliberate rather
 * than lazy: every case above is about what the bridge DECIDES, and giving each
 * of them a probe clock would make each of them also a case about how long a
 * probe had been dialling. The shipped defaults are the link's own constants, so
 * the cases that leave the seam empty get a real `setTimeout` no synchronous test
 * ever reaches â€” exactly what they had before this round.
 */
function boundedHarness({
  connectTimeoutMs = 4_000,
  idleTimeoutMs = 30_000,
}: { connectTimeoutMs?: number; idleTimeoutMs?: number } = {}): {
  transport: TreeTransport & RouteWitness;
  link: MuxLink;
  made: StubLegacy[];
  notices: MuxUnsupportedReason[];
  refuse(value: boolean): void;
  /** Wake the LINK's own machinery: one liveness cycle's worth of its timers. */
  runLink(cycles: number): void;
  /** Advance the shared clock by `ms`, firing the bridge's watch as it polls. */
  advance(ms: number): void;
  dispose(): void;
} {
  const clock = { t: 0 };
  const linkTimers: Array<{ fn: () => void } | undefined> = [];
  // A map rather than an array, because the watch re-arms on every poll and an
  // index reused after a splice would let a stale `clearTimer` cancel a timer
  // that has nothing to do with it.
  const watchTimers = new Map<number, () => void>();
  let nextWatchId = 0;
  let refusing = false;
  const link = new MuxLink({
    ...CONFIG,
    openSocket: (): MuxSocket => {
      if (refusing) throw new Error('the path ended this dial');
      const socket: MuxSocket = {
        readyState: 1,                             // OPEN at once, and deaf for ever
        bufferedAmount: 0,
        send: () => undefined,
        close: (): void => {
          (socket as { readyState: number }).readyState = 3;
          socket.onclose?.({});
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      return socket;
    },
    connectTimeoutMs: 0,
    idleTimeoutMs: 30_000,
    unreachableDials: 2,
    random: () => 0.5,
    now: () => clock.t,
    setTimer: (fn) => { linkTimers.push({ fn }); return linkTimers.length - 1; },
    clearTimer: (handle) => { linkTimers[handle as number] = undefined; },
  });
  const made: StubLegacy[] = [];
  const doc = new Y.Doc();
  const notices: MuxUnsupportedReason[] = [];
  const transport = openTreeTransport(
    link, doc, CONFIG, (reason) => notices.push(reason),
    () => { const stub = new StubLegacy(); made.push(stub); return stub; },
    {
      connectTimeoutMs,
      idleTimeoutMs,
      now: () => clock.t,
      setTimer: (fn) => { nextWatchId += 1; watchTimers.set(nextWatchId, fn); return nextWatchId; },
      clearTimer: (handle) => { watchTimers.delete(handle as number); },
    },
  );
  const firePolls = (): void => {
    const due = [...watchTimers.values()];
    watchTimers.clear();
    for (const fn of due) fn();
  };
  return {
    transport, link, made, notices,
    refuse: (value: boolean): void => { refusing = value; },
    runLink: (cycles: number): void => {
      for (let i = 0; i < cycles; i += 1) {
        clock.t += 3_000;
        for (const timer of linkTimers.splice(0).filter((t) => t !== undefined)) timer.fn();
        firePolls();
      }
    },
    advance: (ms: number): void => {
      // 250 ms is the watch's own poll floor, so this never steps over one.
      for (let elapsed = 0; elapsed < ms; elapsed += 250) {
        clock.t += 250;
        firePolls();
      }
    },
    dispose: (): void => { transport.destroy(); link.destroy(); doc.destroy(); },
  };
}

/** The link reports, the bridge builds a probe, and that probe never opens. */
function wedged(h: ReturnType<typeof boundedHarness>): void {
  h.transport.connect();
  h.runLink(11);
  assert.equal(h.made.length, 1, 'the deaf route was never even looked into');
  assert.equal(h.made[0]?.connected, false, 'the probe opened, so this is not the wedge');
  assert.equal(h.made[0]?.synced, false, 'the probe answered, so this is not the wedge');
}

test('a probe whose dial never completes is REPLACED, not waited on for the session', () => {
  // ⚠ THE DEFECT, AND IT IS THE LINK'S OWN LESSON ARRIVING ON THE OTHER SOCKET. A
  // socket whose TCP handshake completes and whose upgrade is never answered sits
  // in CONNECTING with `ws` non-null for ever: `y-websocket`'s watchdog is guarded
  // by `wsconnected` and its reconnect runs out of `onclose`, so neither can fire.
  //
  // Measured against real processes at shipped constants, through a proxy that
  // upgrades `/_mux` and swallows every frame while completing the TCP handshake
  // on every other path and delivering nothing: the probe was built at 1,725 ms,
  // the per-room route was HEALED in the same millisecond, and across 140 s the
  // proxy saw ONE non-mux connection â€” the wedged one. No sentence, 390 refused
  // `/_mux` dials that could not become a verdict, no notice, and a tree that
  // never synced. The same run on this branch: sentence at 5,757 ms, verdict,
  // notice and a synced tree at 7,492 ms.
  const h = boundedHarness();
  wedged(h);

  h.advance(4_000);
  assert.equal(h.made.length, 2, 'the wedged probe was held for the life of the session');
  assert.equal(h.made[0]?.destroyed, true, 'the replaced probe kept its socket');
  h.dispose();
});

test('the sentence survives a probe that has to be replaced', () => {
  // ⚠ THE REPORTED HARM WAS NEVER THE PROVIDER, it is what goes down with it. The
  // sentence is a live read of "a probe exists and is synced this instant", so a
  // wedged probe makes it permanently false â€” and the sentence is what names the
  // compatibility lever to a self-hoster who has no other way out.
  const h = boundedHarness();
  wedged(h);
  assert.equal(saysUnserved(h.transport, h.link), false, 'a wedged probe said something');

  h.advance(4_000);
  h.made[1]?.syncOnly();                         // the replacement reaches the server
  assert.equal(saysUnserved(h.transport, h.link), true,
    'the sentence did not come back on a probe that could answer');
  assert.equal(h.transport.serverAnswersElsewhere, true);
  h.dispose();
});

test('the automatic fallback survives a probe that has to be replaced', () => {
  // The verdict needs its two halves concurrent: a refusal reported JUST NOW, and
  // a probe synced in the same turn. A wedged probe can never be the second half,
  // so the demotion this bridge exists to make was unreachable for the session â€”
  // measured as 390 refused dials against a null `unsupportedReason`.
  const h = boundedHarness();
  wedged(h);
  h.advance(4_000);
  h.made[1]?.syncOnly();

  h.refuse(true);                                // the path starts 404-ing the route
  h.runLink(14);

  assert.ok(h.link.routeRefused, 'a run of refusals was not recognised as one');
  assert.equal(h.link.unsupportedReason, 'unreachable',
    'the verdict was still unreachable behind a probe that had been replaced');
  assert.deepEqual(h.notices, ['unreachable']);
  assert.equal(h.transport.synced, true, 'the tree did not end up on the route that works');
  h.dispose();
});

test('an expired probe is a RETRY, and may never be a conclusion', () => {
  // ⚠ THE RULE THE WHOLE BRANCH IS BUILT ON, applied to the one object that had no
  // bound. `MUX_DETECT_TIMEOUT_MS` was deleted rather than retuned because a
  // session-long verdict reached from an ABSENCE is false on any path slower than
  // the guess; a probe that ran out of its own deadline witnessed nothing at all,
  // which is the purest absence in the file. So expiry produces a new probe and
  // NOTHING else: no report, no record, no notice, no demotion.
  const h = boundedHarness();
  wedged(h);

  h.advance(60_000);                             // rung after rung, on a dark route
  assert.ok(h.made.length >= 4, `the probe was retried ${h.made.length - 1} times, not at all`);
  assert.equal(h.link.unsupportedReason, null,
    'a probe that ran out of time condemned the route it was supposed to witness');
  assert.deepEqual(h.notices, [], 'an absence of evidence was put in front of the user');
  assert.equal(saysUnserved(h.transport, h.link), false,
    'a probe that has never answered was allowed to say the server answers');
  assert.equal(h.link.stats.dialsRefused, 0, 'the probe\'s own deadline reached the link');
  h.dispose();
});

test('a probe that is OPEN and never speaks is replaced too', () => {
  // The second bound, and it is `MUX_IDLE_TIMEOUT_MS` for `MUX_IDLE_TIMEOUT_MS`'s
  // own reason: a socket can be OPEN and dead, `readyState` never moves, and a
  // probe that opened but never handshaked answers exactly as little as one that
  // never opened at all. The link closes such a socket and dials again; so does
  // this, and for as long as the question is open.
  const h = boundedHarness();
  wedged(h);
  h.advance(4_000);
  h.made[1]?.openOnly();                         // the socket opens; the sync never comes

  h.advance(20_000);
  assert.equal(h.made.length, 2, 'the silence bound fired before the socket had gone quiet');
  h.advance(12_000);
  assert.equal(h.made.length, 3, 'a probe that opened and said nothing was kept for ever');
  assert.equal(h.made[1]?.destroyed, true, 'the deaf probe kept its socket');
  assert.equal(h.link.unsupportedReason, null, 'silence became a verdict again');
  h.dispose();
});

test('a probe that is ANSWERING is bounded by nothing, because it is the evidence', () => {
  // ⚠ THE COST THE PREVIOUS ROUND PAID AND THIS ONE MUST NOT REINTRODUCE. Deleting
  // the `probeAnswered` latch once made every report build a fresh provider on the
  // tree doc â€” one per `MUX_IDLE_TIMEOUT_MS` for ever on a dark route. A bound that
  // also applied to a SYNCED probe would be that cadence back under a new name,
  // and it would take the sentence down with it every time it fired.
  const h = boundedHarness();
  wedged(h);
  h.advance(4_000);
  h.made[1]?.syncOnly();
  assert.equal(saysUnserved(h.transport, h.link), true);

  h.advance(600_000);                            // ten minutes of a route still as dark
  assert.equal(h.made.length, 2,
    `a synced probe was rebuilt ${h.made.length - 1} times for one open question`);
  assert.equal(h.made[1]?.destroyed, false, 'the evidence the sentence rests on was destroyed');
  assert.equal(saysUnserved(h.transport, h.link), true,
    'the sentence lapsed on a route that was still exactly as dark');
  h.dispose();
});

test('the dial ladder is the link\'s: reset by a probe that opens, widened by one that does not',
  () => {
    // ⚠ PATIENCE, NEVER MEASUREMENT â€” `MUX_CONNECT_TIMEOUT_MS`'s own header. The
    // deadline says how long this client will hold one attempt open, it is
    // compared with nothing, and it resets on any socket that opens so that a
    // session which once connected never carries a widened deadline into a later
    // outage. `MUX_DIAL_PATIENCE` is [1, 2, 3]: 4 s, then 8 s, then 12 s.
    const h = boundedHarness();
    wedged(h);

    h.advance(4_000);
    assert.equal(h.made.length, 2, 'the first rung was not 4 s');
    h.advance(4_000);
    assert.equal(h.made.length, 2, 'the second rung was not widened at all');
    h.advance(4_000);
    assert.equal(h.made.length, 3, 'the second rung was not 8 s');

    // A socket that OPENS puts the ladder back on its first rung, even though this
    // one never syncs and is replaced by the other bound.
    // One poll's slack: the phase change is NOTICED at the next poll, and that is
    // where the silence clock starts. The watch reads state rather than being told.
    h.made[2]?.openOnly();
    h.advance(30_250);
    assert.equal(h.made.length, 4, 'the silence bound did not replace the open probe');
    h.advance(4_000);
    assert.equal(h.made.length, 5, 'a probe that opened did not reset the dial ladder');
    h.dispose();
  });

test('the watch does not outlive the probe, and never touches an adopted one', () => {
  // ⚠ A TIMER THAT RE-ARMS ITSELF IS THE ONE THING THAT CAN OUTLIVE EVERYTHING
  // ELSE, which is why `MuxLink.armIdleTick` unrefs and says so. Two ends here: a
  // disposed transport must leave nothing polling, and an ADOPTED probe has
  // stopped being a probe â€” replacing it would destroy the tree's own connection
  // out from under the plugin.
  const h = boundedHarness();
  wedged(h);
  h.advance(4_000);
  h.made[1]?.syncOnly();
  h.refuse(true);
  h.runLink(14);
  assert.equal(h.link.unsupportedReason, 'unreachable', 'the verdict never landed');
  const adopted = h.made[1];
  assert.equal(adopted?.destroyed, false, 'the probe was destroyed rather than adopted');

  h.advance(600_000);
  assert.equal(h.made.length, 2, 'the adopted transport was replaced as though still a probe');
  assert.equal(adopted?.destroyed, false,
    'the watch destroyed the transport the tree was syncing over');

  h.transport.destroy();
  const madeAtDispose = h.made.length;
  h.advance(600_000);
  assert.equal(h.made.length, madeAtDispose,
    'a disposed transport went on building providers on a destroyed doc');
  h.link.destroy();
});
