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
import { LEGACY_SERVER_NOTICE, openTreeTransport } from './LegacyTreeTransport.ts';
import type { TreeTransport } from './TreeTransport.ts';

// ---------------------------------------------------------------- fixtures

const CONFIG = { serverUrl: 'ws://host:1234', serverKey: 'sk', workspaceId: 'ws-1' };

/** Today's topology, without the socket. Only its lifecycle is under test. */
class StubLegacy implements TreeTransport {
  synced = false;
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
    detectTimeoutMs: 0,
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
