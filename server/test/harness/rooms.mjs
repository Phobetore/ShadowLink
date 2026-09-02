// server/test/harness/rooms.mjs
// P3 slice 3, against real processes: `RoomRegistry` driving BOTH consumers over
// one socket, and the fallback that keeps an old server's notes syncing.
//
// ⚠ WHY THESE ARE STRUCTURAL AND NOT UNIT CASES. Two of the three claims here are
// about things a double cannot have:
//
//  * THE SOCKET COUNT. It is the point of the slice, so it is taken at the socket
//    FACTORY — the one place a socket can come into existence — with real `ws`
//    sockets against the real `server/index.js`. `FakeMux` counts its own sockets
//    honestly, but "one socket" against a real accept path, a real HTTP upgrade
//    and a real `DocHub` is a different sentence.
//  * THE OLD SERVER. Slice 2 measured that a pre-P3 server ACCEPTS
//    `ws://…/_mux?t=…&w=…` and serves it as an ordinary room named `_mux`, so a
//    flag proves nothing at all here. From slice 3 the link carries the note rooms
//    as well, and a link that server condemns makes `connect()` a permanent no-op
//    for every one of them — so "an old server does not lose note sync" has to be
//    asked of that server's own bytes.
//
// The third is the S10 fix end to end: one document, two consumers, and a peer
// reading what they wrote through a connection neither of them owns.

import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, assert } from './runner.mjs';
import { startServer } from './server.mjs';
import { DocLink, sleep } from './net.mjs';
import { MuxLink, decodeMuxFrame } from '../../../src/sync/MuxLink.ts';
import { MuxRoomTransport } from '../../../src/sync/MuxRoomTransport.ts';
import { LegacyRoomTransport } from '../../../src/sync/ObsidianDocPort.ts';
import {
  RegistryDocPort, RegistryProviderPort, RoomRegistry,
} from '../../../src/sync/RoomRegistry.ts';
import { openTreeTransport } from '../../../src/sync/LegacyTreeTransport.ts';
import { TreeDoc } from '../../../src/tree/TreeDoc.ts';

// The same override `muxtree.mjs` makes and for the same measured reason: Node's
// global (undici) `WebSocket` never fires `close` on a refused connection, so the
// per-room fallback would be a one-shot under it. Obsidian is Chromium, which
// behaves as `ws` does.
global.WebSocket = WebSocket;

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGACY_ENTRY = join(HERE, 'legacy-server.mjs');

const ROOM = 'n_AbCdEfGhIjKlMnOpQrStUv';
/** A second room, so a case can keep the vault socket alive after the note goes. */
const KEEP = 'n_KeepTheVaultSocketAliv';

async function until(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

/**
 * A `MuxLink` over real `ws` sockets, counting every one it opens — and every
 * frame that arrives on one, by room.
 *
 * ⚠ THE PER-ROOM COUNT IS TAKEN AT THE SOCKET, not from `link.stats`. What 81g
 * measures is frames for a room this client has LEFT, and the link's own counters
 * cannot express that: `framesIn` is every room together, and `droppedInbound`
 * deliberately excludes a straggler for a room we once subscribed, which is
 * exactly what those frames are. Reading the wire is the only honest instrument,
 * and reading it is what turned "silently dropped" into a number.
 */
function realLink(server, workspace, opts = {}) {
  const opened = [];
  const perRoom = new Map();
  const link = new MuxLink({
    serverUrl: `ws://127.0.0.1:${server.port}`,
    serverKey: server.serverKey,
    workspaceId: workspace,
    openSocket: (url) => {
      const socket = new WebSocket(url);
      opened.push(socket);
      socket.addEventListener('message', (event) => {
        const data = event.data;
        let bytes = null;
        if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) {
          bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        if (bytes === null) return;
        const frame = decodeMuxFrame(bytes);
        if (frame === null) return;
        perRoom.set(frame.room, (perRoom.get(frame.room) ?? 0) + 1);
      });
      return socket;
    },
    ...opts,
  });
  return {
    link,
    opened,
    socketCount: () => opened.length,
    framesFor: (room) => perRoom.get(room) ?? 0,
  };
}

/** What `main.ts` builds, in the same order and with the same one switch. */
function runtime(server, workspace, opts = {}) {
  const config = {
    serverUrl: `ws://127.0.0.1:${server.port}`,
    serverKey: server.serverKey,
    workspaceId: workspace,
  };
  const { link, socketCount, framesFor } = realLink(server, workspace, opts);
  const registry = new RoomRegistry(new MuxRoomTransport(link));
  // ⚠ THE SECOND SWITCH, wired exactly as `main.ts` wires it. Without it a server
  // that cannot serve `/_mux` keeps its tree through the bridge and loses every
  // note room, because a condemned link's `connect()` is a permanent no-op.
  const switched = [];
  link.onUnsupported((reason) => {
    switched.push(reason);
    registry.switchTransport(new LegacyRoomTransport(config));
  });
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 8_000 });
  const providers = new RegistryProviderPort(registry);
  return {
    config,
    link,
    registry,
    docs,
    providers,
    switched,
    socketCount,
    framesFor,
    destroy() {
      docs.destroy();
      registry.destroy();
      link.destroy();
    },
  };
}

/**
 * The same two consumers over the COMPATIBILITY route — one `WebsocketProvider`
 * per room, which is the topology master shipped and the control every
 * measurement here is read against.
 */
function compatRuntime(config) {
  const registry = new RoomRegistry(new LegacyRoomTransport(config));
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 8_000 });
  const providers = new RegistryProviderPort(registry);
  return {
    config,
    link: null,
    registry,
    docs,
    providers,
    socketCount: () => -1,
    destroy() {
      docs.destroy();
      registry.destroy();
    },
  };
}

/** Read a room off the server through a connection nothing under test owns. */
async function textOnServer(server, room, workspace) {
  const observer = new Y.Doc();
  const check = new DocLink(server.url(room, workspace), observer);
  check.connect();
  const synced = await check.waitSync(5_000);
  const text = observer.getText('content').toString();
  check.destroy();
  observer.destroy();
  return { synced, text };
}

export function registerRoomCases(getServer, basePort) {
  let legacy = null;

  test('81a the session and the queue share one document, one room and one socket', async () => {
    // ⚠ THIS IS THE COUNT THE SLICE IS ABOUT. Case 80d measured that a second
    // ROOM costs no second socket; this measures that a second CONSUMER costs no
    // second anything. On the shipped topology before slice 3 the same two calls
    // were a `WebsocketProvider` for the session and a pooled one for the queue —
    // two sockets, two handshakes, and two `Y.Doc`s for one room, which is the
    // S10 state.
    const server = getServer();
    const workspace = 'rooms81a';
    const rt = runtime(server, workspace);
    try {
      rt.link.connect();

      // The editing session's half.
      const bound = rt.providers.connect(ROOM);
      // The headless publish path's half, on the same room.
      const opened = await rt.docs.openHeadless(ROOM);

      assert.equal(opened.synced, true, 'the room never handshaked over the mux');
      const third = rt.registry.acquire(ROOM);
      assert.equal(bound.doc, third.doc, 'two documents for one room');
      third.release();
      assert.equal(rt.registry.liveDocs(ROOM), 1);
      assert.equal(rt.registry.docsBuilt(ROOM), 1, 'a second document was built');
      assert.equal(rt.link.roomCount, 1, `one room became ${rt.link.roomCount}`);
      assert.equal(rt.socketCount(), 1, `two consumers opened ${rt.socketCount()} sockets`);

      // The queue seeds from the file; the editor's document is the one that
      // gains the bytes, because there is only one.
      assert.equal(await rt.docs.insertIfEmpty(opened.handle, 'seeded from the file'), true);
      assert.equal(bound.doc.getText('content').toString(), 'seeded from the file',
        'the seed did not reach the document the editor is bound through');
      assert.equal(await rt.docs.flush(opened.handle), true, 'the server never acknowledged it');

      // And I5's guard, asked of the one document that exists.
      assert.equal(await rt.docs.insertIfEmpty(opened.handle, 'again'), false);

      const read = await textOnServer(server, ROOM, workspace);
      assert.equal(read.synced, true, 'the observer never synced');
      assert.equal(read.text, 'seeded from the file',
        'the server does not hold what the two consumers wrote');
      assert.equal(rt.socketCount(), 1, 'the link opened a second socket while running');

      rt.docs.close(opened.handle);
      bound.provider.destroy();
    } finally {
      rt.destroy();
    }
  });

  test('81b the room goes when the LAST consumer lets go, against the real server', async () => {
    // Refcount-to-zero closes, which is what both consumers already did — and the
    // half that could not be asked before is what happens when the OTHER one is
    // still holding it. Asked here of a real socket and a real `DocHub`.
    const server = getServer();
    const workspace = 'rooms81b';
    const rt = runtime(server, workspace);
    try {
      rt.link.connect();
      const bound = rt.providers.connect(ROOM);
      const opened = await rt.docs.openHeadless(ROOM);
      assert.equal(opened.synced, true);
      bound.doc.getText('content').insert(0, 'typed into the editor');
      assert.equal(await rt.docs.flush(opened.handle), true);

      // The leaf closes. The room must NOT go: the queue is still publishing.
      bound.provider.destroy();
      assert.equal(rt.registry.liveDocs(ROOM), 1, 'the room went while the queue held it');
      assert.equal(rt.link.roomCount, 1, 'and its subscription with it');
      assert.equal(await rt.docs.flush(opened.handle), true,
        'the surviving consumer could no longer confirm a write (I17)');

      // Now the last one.
      rt.docs.close(opened.handle);
      assert.equal(rt.registry.liveDocs(ROOM), 0);
      assert.equal(rt.link.roomCount, 0, 'the subscription outlived every borrower');
      assert.equal(rt.socketCount(), 1, 'and the socket is still the one socket');

      const read = await textOnServer(server, ROOM, workspace);
      assert.equal(read.text, 'typed into the editor',
        'the bytes did not survive the room being released');
    } finally {
      rt.destroy();
    }
  });

  test('81c a server that predates the mux keeps its NOTE sync, not only its tree', async () => {
    // ⚠ THE ONE THE SPEC ASKED FOR BEFORE THIS SLICE FOUND IT (§4: "either
    // `RoomRegistry` grows a second switch or an old server loses note sync
    // entirely"). Against a REAL pre-P3 server process, because such a server
    // ACCEPTS the `/_mux` upgrade and serves it as an ordinary room — so the
    // failure this case exists for is silent, and a flag would prove nothing.
    //
    // Without the switch: the bridge moves `_tree` to the per-room route, the
    // link is condemned, and every note room sits on a link whose `connect()` is
    // a permanent no-op. The document survives, the socket never comes back, and
    // nothing the user types is ever published.
    const workspace = 'rooms81c';
    const rt = runtime(legacy, workspace);
    const tree = new TreeDoc();
    const treeLink = openTreeTransport(rt.link, tree.doc, rt.config, () => undefined);
    try {
      // A room taken BEFORE the verdict, which is the ordinary case: the plugin
      // opens a note while the link is still being judged.
      const bound = rt.providers.connect(ROOM);
      const doc = bound.doc;
      doc.getText('content').insert(0, 'typed before the verdict');

      treeLink.connect();

      assert.equal(await until(() => rt.switched.length > 0, 10_000), true,
        'the link was never condemned by a server that cannot serve it');
      assert.deepEqual(rt.switched, ['not-a-frame'],
        `expected the first-message verdict, got ${JSON.stringify(rt.switched)}`);
      assert.equal(rt.link.connected, false);
      assert.equal(rt.registry.connectionsReplaced, 1, 'the live room was not moved');

      // The document did not move, and neither did a byte of it.
      assert.equal(bound.doc, doc, 'the fallback handed the editor a different document');
      assert.equal(doc.getText('content').toString(), 'typed before the verdict');
      assert.equal(rt.registry.docsBuilt(ROOM), 1, 'the fallback built a second document');

      // And the note reaches the old server, on that server's own topology.
      const opened = await rt.docs.openHeadless(ROOM);
      assert.equal(opened.synced, true, 'the note room never synced on the fallback route');
      doc.getText('content').insert(doc.getText('content').length, ', and after it');
      assert.equal(await rt.docs.flush(opened.handle), true,
        'the old server never acknowledged the note');

      const read = await textOnServer(legacy, ROOM, workspace);
      assert.equal(read.synced, true);
      assert.equal(read.text, 'typed before the verdict, and after it',
        'the note never reached a server the tree was reaching perfectly well');

      // The tree is fine too, which is what slice 2 already promised.
      assert.equal(await treeLink.whenSynced(8_000), true, 'the fallback never synced the tree');

      rt.docs.close(opened.handle);
      bound.provider.destroy();
    } finally {
      treeLink.destroy();
      rt.destroy();
      tree.doc.destroy();
    }
  });

  test('81d a room acquired AFTER the verdict opens on the route that works', async () => {
    // The other order, and it is not the same code path: the first case exercises
    // `switchTransport` moving a live room, this one exercises the registry having
    // taken the new transport as its default.
    const workspace = 'rooms81d';
    const rt = runtime(legacy, workspace);
    const tree = new TreeDoc();
    const treeLink = openTreeTransport(rt.link, tree.doc, rt.config, () => undefined);
    try {
      treeLink.connect();
      assert.equal(await until(() => rt.switched.length > 0, 10_000), true,
        'the link was never condemned');

      const opened = await rt.docs.openHeadless(ROOM);
      assert.equal(opened.synced, true, 'a room opened after the verdict never synced');
      assert.equal(await rt.docs.insertIfEmpty(opened.handle, 'published on the old route'), true);
      assert.equal(await rt.docs.flush(opened.handle), true);

      const read = await textOnServer(legacy, ROOM, workspace);
      assert.equal(read.text, 'published on the old route');
      rt.docs.close(opened.handle);
    } finally {
      treeLink.destroy();
      rt.destroy();
      tree.doc.destroy();
    }
  });

  test('81e the cursor set through a lease reaches a peer on EITHER route', async () => {
    // ⚠ THE AWARENESS HAS TO BE THE REGISTRY'S ON BOTH ROUTES, and a transport that
    // builds its own looks perfectly healthy from inside: `lease.awareness` exists,
    // `setLocalStateField` succeeds, and the object it wrote into is one nothing
    // sends. The failure is every remote cursor disappearing, with no error
    // anywhere — and on the compatibility route it would appear only after a
    // fallback, on somebody else's deployment.
    //
    // Found by a mutation sweep: the mux half was pinned by a unit case and the
    // LEGACY half was not, and the mutant that lets `WebsocketProvider` build its
    // own `Awareness` survived every suite. So it is asked the way a user would
    // notice it — a second client, on the same room, on the same server.
    const server = getServer();
    const workspace = 'rooms81e';
    const config = {
      serverUrl: `ws://127.0.0.1:${server.port}`,
      serverKey: server.serverKey,
      workspaceId: workspace,
    };
    const registry = new RoomRegistry(new LegacyRoomTransport(config));
    const providers = new RegistryProviderPort(registry);
    const peerDoc = new Y.Doc();
    const peer = new WebsocketProvider(config.serverUrl, ROOM, peerDoc, {
      connect: true,
      params: { t: config.serverKey, w: config.workspaceId },
      disableBc: true,
    });
    try {
      const { provider } = providers.connect(ROOM);
      assert.equal(await until(() => peer.synced, 8_000), true, 'the peer never synced');

      provider.awareness.setLocalStateField('user', { name: 'Ada', color: '#f00' });

      const seen = async () => [...peer.awareness.getStates().values()]
        .some((s) => s?.user?.name === 'Ada');
      assert.equal(await until(seen, 8_000), true,
        'the cursor never left the room the registry opened — the transport is '
        + 'broadcasting an Awareness the session never wrote into');

      provider.destroy();
    } finally {
      registry.destroy();
      peer.destroy();
      peer.awareness.destroy();
      peerDoc.destroy();
    }
  });

  test('81f a departed cursor leaves a peer AT ONCE, on either route and whoever else holds the room', async () => {
    // ⚠ THE DEPARTURE SIDE OF 81e, and it is measured rather than asserted,
    // because the failure it exists for is not "the cursor never goes" but "the
    // cursor goes thirty seconds later" — which every green suite and two of
    // three review lenses walked straight past.
    //
    // What it was, on the shipped branch, against this same server:
    //
    //   route          leaf closed          leaf closed, queue still holding
    //   master seam        0-1 ms                       0-1 ms
    //   compat            0-1 ms            NEVER (>45 s, and unbounded)
    //   mux            29,842 / 29,860 ms   NEVER (>45 s, and unbounded)
    //
    // Two different causes with one symptom. The 29.8 s is the awareness
    // protocol's own staleness sweep, reached because nothing ever told the
    // server this client had left the room — `unsubscribe()` deleted a
    // client-side map entry and wrote nothing. The NEVER is worse and is not
    // about the mux at all: the `Awareness` is the REGISTRY's now, shared by
    // both consumers, so the session's state outlives the leaf whenever the
    // publish queue is still holding the same room — and `y-protocols` renews a
    // live local state every 15 s, so the peer's 30 s sweep never fires either.
    // On master the session owned its own provider and its own socket, and
    // closing the leaf closed it.
    const server = getServer();
    for (const route of ['mux', 'compat']) {
      for (const holding of [false, true]) {
        const workspace = `rooms81f${route}${holding ? 'h' : ''}`;
        const config = {
          serverUrl: `ws://127.0.0.1:${server.port}`,
          serverKey: server.serverKey,
          workspaceId: workspace,
        };
        const rt = route === 'mux'
          ? runtime(server, workspace)
          : compatRuntime(config);
        const peerDoc = new Y.Doc();
        const peer = new WebsocketProvider(config.serverUrl, ROOM, peerDoc, {
          connect: true,
          params: { t: config.serverKey, w: config.workspaceId },
          disableBc: true,
        });
        const where = `${route}${holding ? ' with the queue still holding it' : ''}`;
        try {
          if (rt.link !== null) rt.link.connect();
          const bound = rt.providers.connect(ROOM);
          assert.equal(await until(() => bound.provider.synced, 8_000), true,
            `${where}: the session never synced`);
          assert.equal(await until(() => peer.synced, 8_000), true,
            `${where}: the peer never synced`);

          // The publish queue borrowing the same room, which is the case a leave
          // frame cannot reach: the room does not go, so nothing closes it.
          const held = holding ? await rt.docs.openHeadless(ROOM) : null;

          bound.provider.awareness.setLocalStateField('user', { name: 'Ada', color: '#f00' });
          const holdsAda = () => [...peer.awareness.getStates().values()]
            .some((s) => s?.user?.name === 'Ada');
          assert.equal(await until(holdsAda, 8_000), true,
            `${where}: the cursor never reached the peer`);

          const at = Date.now();
          bound.provider.destroy();                            // the leaf closes
          const gone = await until(() => !holdsAda(), 8_000);
          const took = Date.now() - at;
          assert.equal(gone, true,
            `${where}: a peer is still showing the cursor of a user who left the note `
            + `${took} ms ago — before the leave and the departure announcement this `
            + 'was 29.8 s when the room went, and unbounded when it did not');
          // Generous against a loopback measurement of 0-1 ms: what is being
          // pinned is the difference between one round trip and half a minute.
          assert.equal(took < 2_000, true, `${where}: the departure took ${took} ms`);

          if (held !== null) rt.docs.close(held.handle);
        } finally {
          rt.destroy();
          peer.destroy();
          peer.awareness.destroy();
          peerDoc.destroy();
        }
      }
    }
  });

  test('81g a room this client has left stops arriving on its socket', async () => {
    // ⚠ THE FAN-OUT LEAK, against a real `DocHub`. With no leave on the wire the
    // server kept this client registered in every room it had ever opened for the
    // life of the vault socket: measured here before the verb existed, 20 frames
    // for a departed room after 20 peer edits, dropped client-side and counted
    // NOWHERE — `droppedInbound` stayed 0, because a straggler for a room we once
    // subscribed is deliberately not evidence of anything. It grows with every
    // note a session opens, and it defeats `DocHub`'s flush-on-last-peer-left.
    const server = getServer();
    const workspace = 'rooms81g';
    const rt = runtime(server, workspace);
    const peerDoc = new Y.Doc();
    const peer = new WebsocketProvider(`ws://127.0.0.1:${server.port}`, ROOM, peerDoc, {
      connect: true,
      params: { t: server.serverKey, w: workspace },
      disableBc: true,
    });
    try {
      rt.link.connect();
      // The tree's room, so the vault socket lives on: the leak's precondition is
      // a socket that outlives the note.
      const tree = rt.providers.connect(KEEP);
      const bound = rt.providers.connect(ROOM);
      assert.equal(await until(() => bound.provider.synced, 8_000), true);
      assert.equal(await until(() => peer.synced, 8_000), true, 'the peer never synced');

      bound.provider.destroy();
      assert.equal(rt.registry.liveDocs(ROOM), 0);
      assert.equal(rt.link.stats.leavesSent, 1, 'nothing went on the wire');

      await sleep(300);
      const mark = rt.framesFor(ROOM);
      const droppedBefore = rt.link.stats.droppedInbound;
      for (let i = 0; i < 20; i++) {
        const text = peerDoc.getText('content');
        text.insert(text.length, `edit ${i}\n`);
        await sleep(25);
      }
      await sleep(600);

      const arrived = rt.framesFor(ROOM) - mark;
      assert.equal(arrived, 0,
        `${arrived} frames arrived for a room this client left — the server still `
        + 'has it registered on the vault socket');
      assert.equal(rt.link.stats.droppedInbound - droppedBefore, 0,
        'frames for a departed room are being counted as evidence about the peer');

      // The room that is still held is unaffected, and so is the socket.
      tree.doc.getText('content').insert(0, 'the tree moved');
      assert.equal(await rt.docs.flush((await rt.docs.openHeadless(KEEP)).handle), true,
        'leaving one room broke the vault socket for the rooms that stayed');
      assert.equal(rt.socketCount(), 1, 'a leave cost a second socket');
      tree.provider.destroy();
    } finally {
      rt.destroy();
      peer.destroy();
      peer.awareness.destroy();
      peerDoc.destroy();
    }
  });

  return {
    async start() {
      legacy = await startServer({ port: basePort, entry: LEGACY_ENTRY });
      return legacy;
    },
    async stop() {
      if (legacy === null) return;
      await legacy.stop();
      legacy.cleanup();
      legacy = null;
    },
  };
}
