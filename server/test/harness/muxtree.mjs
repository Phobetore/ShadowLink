// server/test/harness/muxtree.mjs
// P3 slice 2, Group C — the SHIPPED client mux against REAL server processes.
//
// `MuxLink.test.ts` and `MuxRoom.test.ts` drive the same classes against
// `FakeMux`, which is faithful enough to be worth having and is still a fake.
// What only a real process can settle is here:
//
//  * the frame codec agrees with `server/mux.js`'s. Both files write
//    `varString(room) + varUint8Array(payload)` and neither imports the other —
//    a drift would leave every unit test green and address the wrong room;
//  * `ProviderAck` really is re-hosted. Its guarantee is that DocHub processes
//    one socket's frames in order, and DocHub is what has to be doing that;
//  * the fallback fires against a server that GENUINELY has no endpoint. That is
//    `legacy-server.mjs`, which is `server/index.js` from before any of this
//    work, run as its own process on its own port. A flag would prove nothing:
//    the whole finding is that an old server ACCEPTS the socket.
//
// The socket count is measured rather than asserted from the design, because the
// slice's stated goal is "one fewer socket" and the honest answer at slice 2 is
// more interesting than that. See case 80d.

import * as Y from 'yjs';
import net from 'node:net';
import { WebSocket } from 'ws';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, assert } from './runner.mjs';
import { startServer } from './server.mjs';
import { DocLink, sleep } from './net.mjs';
import { MuxLink } from '../../../src/sync/MuxLink.ts';
import { MuxRoom } from '../../../src/sync/MuxRoom.ts';
import {
  MUX_UNREACHABLE_NOTICE, legacyNoticeFor, openTreeTransport,
} from '../../../src/sync/LegacyTreeTransport.ts';
import { TreeDoc } from '../../../src/tree/TreeDoc.ts';
import { TREE_SYNC_TIMEOUT_MS } from '../../../src/tree/constants.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LEGACY_ENTRY = join(HERE, 'legacy-server.mjs');

/** Poll `predicate` until it holds or `ms` elapses. */
async function until(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

/**
 * A `MuxLink` over real `ws` sockets, counting every one it opens.
 *
 * The count is the point of the slice, so it is taken at the factory — the one
 * place a socket can come into existence — rather than inferred from the server.
 */
function realLink(server, workspace, opts = {}) {
  const opened = [];
  const link = new MuxLink({
    serverUrl: `ws://127.0.0.1:${server.port}`,
    serverKey: server.serverKey,
    workspaceId: workspace,
    openSocket: (url) => {
      const socket = new WebSocket(url);
      opened.push(socket);
      return socket;
    },
    ...opts,
  });
  return { link, opened, socketCount: () => opened.length };
}

/**
 * A TCP proxy in front of the real server that REFUSES the `/_mux` upgrade —
 * 404 at the HTTP layer — and forwards every other path untouched.
 *
 * ⚠ The point is that this is not a flag and not a fake: it is the shipped server
 * with one route unreachable, which is precisely what a reverse proxy configured
 * for the routes somebody knew about produces. `mode: 'blackhole'` is the other
 * half of the same misconfiguration: the TCP connection is accepted and the
 * upgrade is never answered at all.
 */
function hostileProxy({ listen, target, mode }) {
  const held = [];
  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    client.once('data', (first) => {
      const head = first.toString('latin1').split('\r\n')[0] ?? '';
      if (head.includes(' /_mux')) {
        if (mode === 'blackhole') { held.push(client); return; }
        client.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        client.end();
        return;
      }
      const up = net.connect(target, '127.0.0.1', () => { up.write(first); });
      up.on('error', () => undefined);
      client.pipe(up);
      up.pipe(client);
      const bye = () => {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      };
      client.on('close', bye);
      up.on('close', bye);
    });
  });
  return {
    start: () => new Promise((resolve) => server.listen(listen, '127.0.0.1', resolve)),
    async stop() {
      for (const client of held) { try { client.destroy(); } catch { /* gone */ } }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A TCP proxy that can STOP FORWARDING without closing anything — no FIN, no RST.
 *
 * ⚠ This is the only honest way to make a socket that is OPEN and dead, and it is
 * what a dropped NAT flow, a slept laptop and a wifi handover all do. Calling a
 * close method instead would test the close path, which was never the broken one.
 * While frozen it does not propagate a close either: on a frozen path, nothing
 * moves in either direction, including the news that something died.
 */
function freezableProxy({ listen, target }) {
  const state = { frozen: false, pairs: [] };
  const server = net.createServer((client) => {
    const up = net.connect(target, '127.0.0.1');
    state.pairs.push({ client, up });
    client.on('error', () => undefined);
    up.on('error', () => undefined);
    client.on('data', (b) => { if (!state.frozen) up.write(b); });
    up.on('data', (b) => { if (!state.frozen) client.write(b); });
    const bye = () => {
      if (state.frozen) return;
      try { client.destroy(); } catch { /* gone */ }
      try { up.destroy(); } catch { /* gone */ }
    };
    client.on('close', bye);
    up.on('close', bye);
  });
  return {
    async start() {
      await new Promise((resolve) => server.listen(listen, '127.0.0.1', resolve));
      return `ws://127.0.0.1:${listen}`;
    },
    freeze() { state.frozen = true; },
    thaw() { state.frozen = false; },
    async stop() {
      state.frozen = false;
      for (const { client, up } of state.pairs) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function registerMuxTreeCases(getServer, legacyPort) {
  let legacy = null;
  // Derived rather than plumbed: one env var already names this block, and three
  // more would be three more things to keep in step with the CI invocation.
  const refusePort = legacyPort + 1;
  const swapPort = legacyPort + 2;
  const freezePort = legacyPort + 3;

  test('80a the shipped MuxLink carries _tree over the real server, and converges', async () => {
    const server = getServer();
    const workspace = 'muxtree80a';
    const ann = new Y.Doc();
    const bob = new Y.Doc();
    const a = realLink(server, workspace);
    const b = realLink(server, workspace);
    const annRoom = new MuxRoom(a.link, '_tree', ann);
    const bobRoom = new MuxRoom(b.link, '_tree', bob);
    try {
      a.link.connect();
      b.link.connect();
      assert.equal(await annRoom.whenSynced(5_000), true, 'the mux tree never synced');
      assert.equal(await bobRoom.whenSynced(5_000), true, 'the second client never synced');

      ann.getMap('nodes').set('n1', { k: 'f', p: 'a.md' });
      assert.equal(
        await until(() => bob.getMap('nodes').get('n1')?.p === 'a.md', 5_000), true,
        'the tree edit never crossed the mux',
      );

      // Back the other way, and read off the server with a connection neither
      // client owns — the shipped per-room route, onto the same document.
      bob.getMap('nodes').set('n2', { k: 'd', p: 'folder' });
      assert.equal(
        await until(() => ann.getMap('nodes').get('n2')?.p === 'folder', 5_000), true,
        'the reply never came back',
      );

      const observer = new Y.Doc();
      const link = new DocLink(server.url('_tree', workspace), observer);
      link.connect();
      assert.equal(await link.waitSync(5_000), true, 'the observer never synced');
      assert.equal(observer.getMap('nodes').get('n1')?.p, 'a.md',
        'the server does not hold what the mux client wrote');
      assert.equal(observer.getMap('nodes').get('n2')?.p, 'folder');
      link.destroy();
      observer.destroy();
    } finally {
      annRoom.destroy(); bobRoom.destroy();
      a.link.destroy(); b.link.destroy();
      ann.destroy(); bob.destroy();
    }
  });

  test('80b a flush over the mux is confirmed by DocHub, not by the socket draining', async () => {
    // I17's whole basis, re-hosted. `ProviderAck` writes a SyncStep1 behind the
    // updates it wants acknowledged; only a server that processed them in order
    // can answer it. This is the case that says DocHub really does.
    const server = getServer();
    const workspace = 'muxtree80b';
    const doc = new Y.Doc();
    const { link } = realLink(server, workspace);
    const room = new MuxRoom(link, 'n_AbCdEfGhIjKlMnOpQrStUv', doc);
    try {
      link.connect();
      assert.equal(await room.whenSynced(5_000), true);
      doc.getText('content').insert(0, 'confirmed over one socket');
      assert.equal(await room.flush(5_000), true, 'a real round trip was not confirmed');

      // The confirmation is only worth anything if the bytes are really there.
      const observer = new Y.Doc();
      const check = new DocLink(server.url('n_AbCdEfGhIjKlMnOpQrStUv', workspace), observer);
      check.connect();
      assert.equal(await check.waitSync(5_000), true);
      assert.equal(observer.getText('content').toString(), 'confirmed over one socket',
        'flush confirmed content the server does not hold');
      check.destroy();
      observer.destroy();
    } finally {
      room.destroy(); link.destroy(); doc.destroy();
    }
  });

  test('80c a client whose server predates the mux falls back and still syncs the tree', async () => {
    // ⚠ Against a REAL pre-P3 server process. The finding this case exists for is
    // that such a server ACCEPTS `/_mux` and serves it as an ordinary room, so
    // nothing about the connection succeeding tells the client anything.
    const workspace = 'muxtree80c';
    const tree = new TreeDoc();
    const { link, socketCount } = realLink(legacy, workspace);
    const notices = [];
    const transport = openTreeTransport(
      link,
      tree.doc,
      {
        serverUrl: `ws://127.0.0.1:${legacy.port}`,
        serverKey: legacy.serverKey,
        workspaceId: workspace,
      },
      (reason) => notices.push(reason),
    );
    const peer = new Y.Doc();
    const peerLink = new DocLink(legacy.url('_tree', workspace), peer);
    try {
      transport.connect();

      // The verdict, from the old server's own first message.
      assert.equal(await until(() => notices.length > 0, 8_000), true,
        'a server with no /_mux route was never detected');
      assert.deepEqual(notices, ['not-a-frame'],
        `expected the first-message verdict, got ${JSON.stringify(notices)}`);
      assert.equal(link.unsupportedReason, 'not-a-frame');
      assert.equal(link.connected, false, 'the mux link stayed up on a server that cannot serve it');

      // And the tree works anyway, on today's exact topology.
      assert.equal(await transport.whenSynced(8_000), true,
        'the fallback never synced the tree');
      tree.doc.getMap('nodes').set('n1', { k: 'f', p: 'legacy.md' });

      peerLink.connect();
      assert.equal(await peerLink.waitSync(5_000), true);
      assert.equal(
        await until(() => peer.getMap('nodes').get('n1')?.p === 'legacy.md', 5_000), true,
        'the fallback client never reached the old server',
      );

      // Exactly one mux socket was ever dialled, and it is closed. The fallback
      // does not sit there retrying a route that will never exist.
      assert.equal(socketCount(), 1, `the link kept dialling: ${socketCount()} sockets`);
      await sleep(300);
      assert.equal(socketCount(), 1, 'the link re-dialled a server already known to be old');
    } finally {
      transport.destroy();
      link.destroy();
      peerLink.destroy();
      peer.destroy();
      tree.doc.destroy();
    }
  });

  test('80d one socket carries _tree AND a note room — the count the slice is about', async () => {
    // ⚠ MEASURED, and the number is not the one slice 2's one-line definition of
    // done implies. Slice 2 moves exactly ONE room, so a vault at rest goes from
    // one tree socket to one mux socket: the count is unchanged, and spec §"What
    // this gives up" 2 says so — "one socket only from slice 3 onward".
    //
    // What IS true today, and is what the transport had to deliver, is that the
    // second room costs no second socket. Two rooms over today's topology is two
    // WebSocketProviders and two sockets; here it is two rooms and one socket,
    // with both converging.
    const server = getServer();
    const workspace = 'muxtree80d';
    const tree = new Y.Doc();
    const note = new Y.Doc();
    const { link, socketCount } = realLink(server, workspace);
    const treeRoom = new MuxRoom(link, '_tree', tree);
    const noteRoom = new MuxRoom(link, 'n_AbCdEfGhIjKlMnOpQrStUv', note);
    try {
      link.connect();
      assert.equal(await treeRoom.whenSynced(5_000), true);
      assert.equal(await noteRoom.whenSynced(5_000), true);
      assert.equal(socketCount(), 1, `two rooms opened ${socketCount()} sockets`);
      assert.equal(link.roomCount, 2);

      tree.getMap('nodes').set('n1', { k: 'f', p: 'both.md' });
      note.getText('content').insert(0, 'and the note too');
      assert.equal(await treeRoom.flush(5_000), true);
      assert.equal(await noteRoom.flush(5_000), true);

      for (const [room, read, expected] of [
        ['_tree', (d) => d.getMap('nodes').get('n1')?.p, 'both.md'],
        ['n_AbCdEfGhIjKlMnOpQrStUv', (d) => d.getText('content').toString(), 'and the note too'],
      ]) {
        const observer = new Y.Doc();
        const check = new DocLink(server.url(room, workspace), observer);
        check.connect();
        assert.equal(await check.waitSync(5_000), true, `${room} observer never synced`);
        assert.equal(read(observer), expected, `${room} did not reach the server`);
        check.destroy();
        observer.destroy();
      }
      assert.equal(socketCount(), 1, 'the link opened a second socket while running');
    } finally {
      treeRoom.destroy(); noteRoom.destroy();
      link.destroy(); tree.destroy(); note.destroy();
    }
  });

  test('80e reconnect re-handshakes every room on the one socket, and nothing is lost', async () => {
    const server = getServer();
    const workspace = 'muxtree80e';
    const tree = new Y.Doc();
    const note = new Y.Doc();
    const { link, opened, socketCount } = realLink(server, workspace, {
      backoffMs: [20],
      jitter: 0,
    });
    const treeRoom = new MuxRoom(link, '_tree', tree);
    const noteRoom = new MuxRoom(link, 'n_ZyXwVuTsRqPoNmLkJiHgFe', note);
    try {
      link.connect();
      assert.equal(await treeRoom.whenSynced(5_000), true);
      assert.equal(await noteRoom.whenSynced(5_000), true);

      // The socket dies under both rooms at once, which is the event the mux
      // makes shared: one drop is every room's drop.
      opened[0].terminate();
      // ⚠ Both rooms, from ONE drop. `terminate()` moves `readyState` to CLOSED
      // in this tick while the close EVENT lands on a later one, so the room's
      // `synced` is the conjunction of a completed handshake and a live link —
      // this case is what found that window.
      assert.equal(
        await until(() => !treeRoom.synced && !noteRoom.synced, 3_000), true,
        'a dead socket left a room claiming to be synced',
      );
      assert.equal(link.connected, false, 'the link never noticed');

      // Edits made while it was down go up as real Yjs deltas on reconnect.
      tree.getMap('nodes').set('n1', { k: 'f', p: 'offline.md' });
      note.getText('content').insert(0, 'written while offline');

      assert.equal(await until(() => link.connected, 8_000), true, 'the ladder never reconnected');
      assert.equal(await treeRoom.whenSynced(5_000), true, 'the tree never re-synced');
      assert.equal(await noteRoom.whenSynced(5_000), true, 'the note never re-synced');
      assert.equal(await treeRoom.flush(5_000), true);
      assert.equal(await noteRoom.flush(5_000), true);
      assert.equal(socketCount(), 2, `one reconnect dialled ${socketCount()} sockets in total`);

      const observer = new Y.Doc();
      const check = new DocLink(server.url('n_ZyXwVuTsRqPoNmLkJiHgFe', workspace), observer);
      check.connect();
      assert.equal(await check.waitSync(5_000), true);
      assert.equal(observer.getText('content').toString(), 'written while offline',
        'the offline edit never reached the server after reconnect');
      check.destroy();
      observer.destroy();
    } finally {
      treeRoom.destroy(); noteRoom.destroy();
      link.destroy(); tree.destroy(); note.destroy();
    }
  });


  test('80f a server whose /_mux upgrade is REFUSED still gets a verdict, and the tree', async () => {
    // ⚠ Against a REAL server behind a proxy that answers 404 on `/_mux` and
    // forwards every other path — the canonical reverse-proxy misconfiguration,
    // and INSTALL.md tells self-hosters to put a proxy in front without giving
    // them a config. The finding this case exists for is that NOTHING used to
    // happen: every route into the legacy verdict needs a socket that OPENED, and
    // a refused upgrade never produces one. Measured before the fix:
    // `whenSynced(15000)` false, verdict empty, notice never shown, the link
    // dialling for ever — while a plain per-room client on the SAME path synced.
    const server = getServer();
    const workspace = 'muxtree80f';
    const proxy = hostileProxy({ listen: refusePort, target: server.port, mode: 'refuse' });
    await proxy.start();
    const url = `ws://127.0.0.1:${refusePort}`;
    const tree = new TreeDoc();
    const opened = [];
    const link = new MuxLink({
      serverUrl: url,
      serverKey: server.serverKey,
      workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); opened.push(s); return s; },
    });
    const notices = [];
    const transport = openTreeTransport(
      link, tree.doc,
      { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
      (reason) => notices.push(reason),
    );
    const peer = new Y.Doc();
    const peerLink = new DocLink(server.url('_tree', workspace), peer);
    try {
      const started = Date.now();
      transport.connect();

      assert.equal(await transport.whenSynced(TREE_SYNC_TIMEOUT_MS), true,
        'a blocked /_mux route left the tree unsynced against a server that works');
      const took = Date.now() - started;
      assert.ok(took < TREE_SYNC_TIMEOUT_MS,
        `the fallback took ${took}ms, past the tree's own ${TREE_SYNC_TIMEOUT_MS}ms deadline`);

      assert.deepEqual(notices, ['unreachable'],
        `expected the route verdict, got ${JSON.stringify(notices)}`);
      assert.equal(link.unsupportedReason, 'unreachable');
      // ⚠ And the sentence must not be the OTHER one: this server is current.
      assert.equal(legacyNoticeFor('unreachable'), MUX_UNREACHABLE_NOTICE);

      tree.doc.getMap('nodes').set('n1', { k: 'f', p: 'blocked-route.md' });
      peerLink.connect();
      assert.equal(await peerLink.waitSync(5_000), true, 'the observer never synced');
      assert.equal(
        await until(() => peer.getMap('nodes').get('n1')?.p === 'blocked-route.md', 5_000), true,
        'the fallback never reached the server through the route that does work',
      );

      const dialled = opened.length;
      await sleep(300);
      assert.equal(opened.length, dialled, 'the link kept dialling a route already refused');
    } finally {
      transport.destroy(); link.destroy();
      peerLink.destroy(); peer.destroy(); tree.doc.destroy();
      await proxy.stop();
    }
  });

  test('80g a server rolled back to a pre-P3 build is demoted, and the tree keeps syncing', async () => {
    // ⚠ Against two REAL processes on the same port and the same data dir. The
    // latch that made this a silent permanent stall was link-wide: measured, the
    // ladder reconnected in 180 ms, `unsupportedReason` stayed null, no notice
    // fired, `whenSynced(15000)` was false and the post-swap edit never reached
    // the server — until Obsidian was restarted. The latch is per SOCKET now, so
    // the replacement is examined on what IT says.
    const workspace = 'muxtree80g';
    let current = await startServer({ port: swapPort });
    const dir = current.dir;
    const key = current.serverKey;
    const url = `ws://127.0.0.1:${swapPort}`;
    const tree = new TreeDoc();
    const link = new MuxLink({
      serverUrl: url, serverKey: key, workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
      backoffMs: [50], jitter: 0,
    });
    const notices = [];
    const transport = openTreeTransport(
      link, tree.doc, { serverUrl: url, serverKey: key, workspaceId: workspace },
      (reason) => notices.push(reason),
    );
    let rolled = null;
    const peer = new Y.Doc();
    let peerLink = null;
    try {
      transport.connect();
      assert.equal(await transport.whenSynced(8_000), true, 'the tree never synced on the mux');
      assert.equal(link.unsupportedReason, null);

      await current.stop();
      rolled = await startServer({ port: swapPort, dir, entry: LEGACY_ENTRY });
      assert.equal(rolled.serverKey, key, 'the rolled-back server has a different key');

      assert.equal(await until(() => link.unsupportedReason !== null, 15_000), true,
        'the replacement server was never examined');
      assert.deepEqual(notices, ['not-a-frame'],
        `expected the first-message verdict, got ${JSON.stringify(notices)}`);

      assert.equal(await transport.whenSynced(TREE_SYNC_TIMEOUT_MS), true,
        'the tree never synced against the server it was rolled back to');
      tree.doc.getMap('nodes').set('n1', { k: 'f', p: 'after-rollback.md' });

      peerLink = new DocLink(rolled.url('_tree', workspace), peer);
      peerLink.connect();
      assert.equal(await peerLink.waitSync(5_000), true);
      assert.equal(
        await until(() => peer.getMap('nodes').get('n1')?.p === 'after-rollback.md', 5_000), true,
        'the edit never reached the rolled-back server',
      );
    } finally {
      transport.destroy(); link.destroy();
      peerLink?.destroy(); peer.destroy(); tree.doc.destroy();
      if (rolled !== null) { await rolled.stop(); rolled.cleanup(); }
      else { await current.stop(); current.cleanup(); }
    }
  });

  test('80h a socket that is OPEN and dead is noticed, and the ladder brings the room back', async () => {
    // ⚠ THE PATH IS REALLY FROZEN: a TCP proxy that stops forwarding in both
    // directions with no FIN and no RST, which is what a dropped NAT flow, a
    // slept laptop and a wifi handover all look like. `readyState` never moves,
    // so nothing that reads it can tell. Measured before the watchdog existed:
    // `connected` and `synced` both true for the whole 78 s the probe watched,
    // while a `WebsocketProvider` on the identical frozen path dropped its socket
    // at 30,266 ms.
    //
    // The TIMEOUT here is short so the suite stays fast; the shipped 30 s is
    // pinned by the unit test, and what only a real socket can settle is that a
    // frozen path really does look alive until something asks.
    const server = getServer();
    const workspace = 'muxtree80h';
    const proxy = freezableProxy({ listen: freezePort, target: server.port });
    const url = await proxy.start();
    const doc = new Y.Doc();
    const opened = [];
    const link = new MuxLink({
      serverUrl: url,
      serverKey: server.serverKey,
      workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); opened.push(s); return s; },
      idleTimeoutMs: 1_500,
      backoffMs: [50],
      jitter: 0,
    });
    const room = new MuxRoom(link, '_tree', doc);
    try {
      link.connect();
      assert.equal(await room.whenSynced(5_000), true, 'the room never synced');

      proxy.freeze();
      doc.getMap('nodes').set('n1', { k: 'f', p: 'written-into-the-void.md' });
      // The socket is still OPEN by every measure the platform offers.
      assert.equal(link.rawSocket?.readyState, 1, 'the frozen socket reported itself closed');

      assert.equal(await until(() => !room.synced, 6_000), true,
        'a room on a dead-but-open socket went on reporting itself synced');
      assert.equal(link.stats.idleClosures >= 1, true, 'nothing closed the dead socket');

      proxy.thaw();
      assert.equal(await until(() => link.connected && room.synced, 10_000), true,
        'the ladder never brought the room back once the path recovered');
      assert.equal(await room.flush(5_000), true, 'the recovered room could not confirm a flush');

      const observer = new Y.Doc();
      const check = new DocLink(server.url('_tree', workspace), observer);
      check.connect();
      assert.equal(await check.waitSync(5_000), true);
      assert.equal(observer.getMap('nodes').get('n1')?.p, 'written-into-the-void.md',
        'the edit made while the path was frozen never went up');
      check.destroy();
      observer.destroy();
    } finally {
      room.destroy(); link.destroy(); doc.destroy();
      await proxy.stop();
    }
  });

  return {
    async start() {
      legacy = await startServer({ port: legacyPort, entry: LEGACY_ENTRY });
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
