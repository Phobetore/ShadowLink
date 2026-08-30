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
import { WebSocket } from 'ws';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, assert } from './runner.mjs';
import { startServer } from './server.mjs';
import { DocLink, sleep } from './net.mjs';
import { MuxLink } from '../../../src/sync/MuxLink.ts';
import { MuxRoom } from '../../../src/sync/MuxRoom.ts';
import { openTreeTransport } from '../../../src/sync/LegacyTreeTransport.ts';
import { TreeDoc } from '../../../src/tree/TreeDoc.ts';

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

export function registerMuxTreeCases(getServer, legacyPort) {
  let legacy = null;

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
