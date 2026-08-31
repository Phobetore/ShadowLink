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
import { MuxLink, type MuxSocket, type MuxUnsupportedReason } from './MuxLink.ts';
import {
  LEGACY_SERVER_NOTICE, MUX_UNREACHABLE_NOTICE, legacyNoticeFor, openTreeTransport,
} from './LegacyTreeTransport.ts';
import type { TreeTransport } from './TreeTransport.ts';

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
}

interface Harness {
  transport: TreeTransport;
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
  transport: TreeTransport;
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
  assert.equal(h.link.routeUnserved, false, 'a deadline produced a sentence about the route');
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
function deafHarness(): {
  transport: TreeTransport;
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
      sockets.push(socket);
      return socket;
    },
    connectTimeoutMs: 0,
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
  // anything. Measured on the parent branch through a proxy that upgrades `/_mux`
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
  assert.equal(h.link.routeUnserved, false, 'the fact was recorded before it was known');

  h.made[0]?.arrive();                           // the server DOES answer, elsewhere
  h.run(11);

  assert.equal(h.link.routeUnserved, true,
    'the one thing measurement establishes here was never recorded');
  assert.equal(h.link.unsupportedReason, null, 'a fact was allowed to become a verdict');
  assert.deepEqual(h.notices, []);
  // ONE probe at a time, and it is gone: the question it was built to answer has
  // been answered, and a second permanent socket is the topology this slice
  // removes.
  assert.equal(h.made[0]?.destroyed, true, 'the probe was left running for ever');
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
  assert.equal(refused.link.routeUnserved, false,
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
