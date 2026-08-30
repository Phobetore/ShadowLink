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
import { MuxLink, type MuxUnsupportedReason } from './MuxLink.ts';
import {
  LEGACY_SERVER_NOTICE, MUX_UNREACHABLE_NOTICE, legacyNoticeFor, openTreeTransport,
} from './LegacyTreeTransport.ts';
import type { TreeTransport } from './TreeTransport.ts';

// ---------------------------------------------------------------- fixtures

const CONFIG = { serverUrl: 'ws://host:1234', serverKey: 'sk', workspaceId: 'ws-1' };

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

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
function unreachableHarness({ connectTimeoutMs = 0 } = {}): {
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
    openSocket: mux.openSocket,
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

test('the mux dial is widened to what the probe proved the path costs', async () => {
  // ⚠ THE RIGGED COMPARISON, in unit form. A dial is bounded; the probe is a
  // `WebsocketProvider` with no connect deadline at all, so on any path slower
  // than the bound the mux can never open and the probe always eventually can —
  // "the mux route is unreachable" is then a statement about the bound. Measured
  // against the shipped server behind a proxy delaying every connection on every
  // route by 4.5 s: `unreachable` at 14,952 ms with a sentence blaming a proxy
  // that was forwarding every path. The parent branch connected at 5,041 ms.
  //
  // So the probe is timed on the route that works, and the mux is given at least
  // that long before anything is concluded.
  const h = unreachableHarness({ connectTimeoutMs: 30 });
  h.mux.refuseConnect = true;
  h.transport.connect();
  h.fire();                                      // two failed dials: the probe starts
  assert.equal(h.made.length, 1, 'the per-room route was never tried');

  await sleep(120);                              // this path costs more than 30 ms
  h.mux.refuseConnect = false;                   // and the mux route is fine, given time
  h.made[0]?.arrive();

  assert.ok(h.link.dialTimeoutMs >= 120,
    'the dial kept a deadline the path was already known to beat');
  assert.equal(h.link.connected, true, 'the fair re-dial never happened');
  assert.equal(h.link.unsupportedReason, null, 'a slow path demoted a working route');
  assert.deepEqual(h.notices, []);
  h.dispose();
});

test('a probe that is synced but never connected settles nothing', () => {
  // The cost of this path is what makes the comparison fair, and it is only known
  // once the probe reports a connect. Without it there is nothing to be fair to.
  const h = unreachableHarness();
  h.mux.refuseConnect = true;
  h.transport.connect();
  h.fire();
  assert.equal(h.made.length, 1);

  const probe = h.made[0];
  if (probe !== undefined) probe.synced = true;  // synced, with no connect reported
  h.fire();
  assert.equal(h.link.unsupportedReason, null,
    'the route was condemned by a comparison with nothing on the other side');
  h.dispose();
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
