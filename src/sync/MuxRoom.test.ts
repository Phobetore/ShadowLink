// src/sync/MuxRoom.test.ts
//
// The y-websocket protocol inside a mux frame (P3 spec §2, §9 slice 2).
//
// Two claims are worth more than the rest, and both are about NOT weakening
// something that already works:
//
//  * the payload is BYTE-IDENTICAL to what a `WebsocketProvider` writes. If it
//    drifts, the server relays it happily — `DocHub` does not read a payload —
//    and the damage shows up as a mixed fleet that silently fails to converge.
//    So the handshake is compared against a hand-built y-websocket message here,
//    and against the real server in the structural suite.
//
//  * `ProviderAck` is RE-HOSTED, not re-implemented. Its own header calls a
//    premature confirmation permanent content loss rather than a retry (I17), and
//    its whole argument is "frames on one socket are processed in order". On the
//    mux that sentence becomes literally true across rooms, so the tests below ask
//    for the same three lies it was built to refuse: a reply owed to the
//    connect-time handshake, a socket that went away mid-flush, and a room that is
//    not being answered at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';

import { FakeMux, type FakeMuxSocket } from './fakes.ts';
import { MuxLink } from './MuxLink.ts';
import { MuxRoom } from './MuxRoom.ts';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// ---------------------------------------------------------------- fixtures

interface Peer {
  link: MuxLink;
  room: MuxRoom;
  doc: Y.Doc;
  text(): string;
  /** Run the link's OWN pending backoff timer, which is how it really comes back. */
  reconnect(): void;
  destroy(): void;
}

/**
 * A link with a hand-driven clock, so nothing here waits on wall time and the
 * reconnect a test triggers is the link's real ladder rather than a shortcut.
 */
function makeLink(mux: FakeMux): { link: MuxLink; fire: () => void } {
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const made = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: 'sk',
    workspaceId: 'ws-1',
    openSocket: mux.openSocket,
    detectTimeoutMs: 0,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (handle) => { timers[(handle as number) - 1] = undefined; },
  });
  const fire = (): void => {
    const due = timers.splice(0).filter((t) => t !== undefined);
    for (const timer of due) timer.fn();
  };
  return { link: made, fire };
}

/** One client: its own link (its own socket) onto the shared `FakeMux`. */
function peer(mux: FakeMux, room = '_tree'): Peer {
  const doc = new Y.Doc();
  const { link: made, fire } = makeLink(mux);
  const muxRoom = new MuxRoom(made, room, doc);
  made.connect();
  return {
    link: made,
    room: muxRoom,
    doc,
    text: () => doc.getText('content').toString(),
    reconnect: fire,
    destroy: () => { muxRoom.destroy(); made.destroy(); doc.destroy(); },
  };
}

function socketOf(peerUnder: Peer, mux: FakeMux): FakeMuxSocket {
  const url = peerUnder.link.url;
  const mine = mux.sockets.filter((s) => s.url === url && s.readyState === 1);
  return mine[mine.length - 1];
}

// ---------------------------------------------------------------- the wire

test('the handshake payload is byte-identical to what y-websocket writes', () => {
  const mux = new FakeMux();
  const client = peer(mux);
  try {
    const socket = socketOf(client, mux);
    const first = socket.sent[0];
    assert.equal(first.room, '_tree', 'the first frame was not addressed to the room');

    // Hand-built the way `y-websocket`'s `onopen` builds it, from a document in
    // the same state the room's was in when it handshook.
    const expected = encoding.createEncoder();
    encoding.writeVarUint(expected, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(expected, new Y.Doc());
    assert.deepEqual([...first.payload], [...encoding.toUint8Array(expected)]);
  } finally {
    client.destroy();
  }
});

test('the local awareness state is broadcast on connect, as the provider does', () => {
  const mux = new FakeMux();
  const client = peer(mux);
  try {
    const socket = socketOf(client, mux);
    // y-protocols' `Awareness` sets a local state of `{}` in its constructor, so
    // `getLocalState() !== null` and y-websocket writes this second frame. The
    // room must too, or a mux client is invisible to everybody else's cursors.
    const awareness = socket.sent.filter((f) => f.payload[0] === MESSAGE_AWARENESS);
    assert.equal(awareness.length, 1, 'no awareness frame followed the handshake');
    assert.equal(awareness[0].room, '_tree');
  } finally {
    client.destroy();
  }
});

test('a room only syncs on a genuine SyncStep2 — never on the link being up (I3/I4)', () => {
  const mux = new FakeMux();
  // Cut the room BEFORE anybody connects: the socket comes up, the handshake goes
  // nowhere, and the room must stay unsynced.
  mux.cut('_tree');
  const client = peer(mux);
  try {
    assert.equal(client.link.connected, true, 'the link should be up');
    assert.equal(client.room.synced, false, 'a live link was mistaken for a synced room');
  } finally {
    client.destroy();
  }
});

test('two clients converge through frames on two sockets and one server room', () => {
  const mux = new FakeMux();
  const ann = peer(mux);
  const bob = peer(mux);
  try {
    assert.equal(ann.room.synced, true, 'Ann never synced');
    assert.equal(bob.room.synced, true, 'Bob never synced');

    ann.doc.getText('content').insert(0, 'written over the mux');
    assert.equal(mux.text('_tree'), 'written over the mux', 'the server never saw it');
    assert.equal(bob.text(), 'written over the mux', 'the peer never saw it');

    bob.doc.getText('content').insert(bob.text().length, ' + and back');
    assert.equal(ann.text(), 'written over the mux + and back');
  } finally {
    ann.destroy();
    bob.destroy();
  }
});

test('a client joining a room with history downloads it on the handshake', () => {
  const mux = new FakeMux();
  mux.seed('_tree', 'already in the workspace');
  const client = peer(mux);
  try {
    assert.equal(client.room.synced, true);
    assert.equal(client.text(), 'already in the workspace');
  } finally {
    client.destroy();
  }
});

test('a peer answering our Step1 from a DIVERGENT state merges, it does not double', () => {
  // The failure I4 exists for, expressible per room: the client has local history
  // the server has never seen, and the server has history the client has not.
  const mux = new FakeMux();
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'local only');
  mux.seed('_tree', 'server only');

  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: 'sk',
    workspaceId: 'ws-1',
    openSocket: mux.openSocket,
    detectTimeoutMs: 0,
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  const room = new MuxRoom(link, '_tree', doc);
  try {
    link.connect();
    const text = doc.getText('content').toString();
    assert.equal(text.includes('local only'), true, 'the local half was lost');
    assert.equal(text.includes('server only'), true, 'the remote half was lost');
    assert.equal(text.length, 'local onlyserver only'.length, `doubled: ${text}`);
    assert.equal(mux.text('_tree'), text, 'the server and the client disagree');
  } finally {
    room.destroy();
    link.destroy();
    doc.destroy();
  }
});

test('a frame for another room never reaches this room\'s document', () => {
  const mux = new FakeMux();
  const tree = peer(mux, '_tree');
  const note = peer(mux, 'n_a');
  try {
    note.doc.getText('content').insert(0, 'note content');
    assert.equal(tree.text(), '', 'a note\'s bytes landed in the tree document');
    assert.equal(mux.text('_tree'), '');
    assert.equal(mux.text('n_a'), 'note content');
  } finally {
    tree.destroy();
    note.destroy();
  }
});

// ---------------------------------------------------------------- partition

test('ONE room can be cut while another on the SAME socket keeps working', () => {
  // The sentence the whole fake exists to be able to say, and the shape every
  // later slice's failure lives in: a live link is not evidence about a room.
  const mux = new FakeMux();
  const doc = new Y.Doc();
  const other = new Y.Doc();
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: 'sk',
    workspaceId: 'ws-1',
    openSocket: mux.openSocket,
    detectTimeoutMs: 0,
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  const cut = new MuxRoom(link, 'n_cut', doc);
  const live = new MuxRoom(link, 'n_live', other);
  try {
    mux.cut('n_cut');
    link.connect();

    assert.equal(link.connected, true, 'the shared socket went down');
    assert.equal(cut.synced, false, 'the cut room reported a sync it never got');
    assert.equal(live.synced, true, 'cutting one room stopped another on the same socket');

    // The live room still round-trips while the other is dark.
    other.getText('content').insert(0, 'still flowing');
    assert.equal(mux.text('n_live'), 'still flowing');
    doc.getText('content').insert(0, 'goes nowhere');
    assert.equal(mux.text('n_cut'), '', 'a cut room still reached the server');

    // Healing and re-handshaking delivers what was missed.
    mux.heal('n_cut');
    link.disconnect();
    link.connect();
    assert.equal(cut.synced, true, 'the healed room never re-synced');
    assert.equal(mux.text('n_cut'), 'goes nowhere', 'the offline edit never went up');
  } finally {
    cut.destroy();
    live.destroy();
    link.destroy();
    doc.destroy();
    other.destroy();
  }
});

test('a held room delivers late, out of order with the room that kept flowing', () => {
  const mux = new FakeMux();
  const ann = peer(mux, 'n_x');
  const bob = peer(mux, 'n_x');
  try {
    mux.hold('n_x');
    ann.doc.getText('content').insert(0, 'parked');
    assert.equal(mux.parkedCount('n_x') > 0, true, 'nothing was parked');
    assert.equal(bob.text(), '', 'a held frame was delivered anyway');

    mux.release('n_x');
    assert.equal(bob.text(), 'parked', 'releasing did not deliver what was parked');
  } finally {
    ann.destroy();
    bob.destroy();
  }
});

test('a duplicated frame is idempotent — the room does not double its text', () => {
  const mux = new FakeMux();
  const ann = peer(mux, 'n_x');
  const bob = peer(mux, 'n_x');
  try {
    mux.duplicate('n_x');
    ann.doc.getText('content').insert(0, 'once');
    assert.equal(bob.text(), 'once', `a duplicated update was applied twice: ${bob.text()}`);
  } finally {
    ann.destroy();
    bob.destroy();
  }
});

// ---------------------------------------------------------------- reconnect

test('the link dropping unsyncs the room, and reconnect re-handshakes it (I24)', () => {
  const mux = new FakeMux();
  const client = peer(mux);
  try {
    assert.equal(client.room.synced, true);
    mux.dropSockets();
    assert.equal(client.room.synced, false, 'a dead link left the room claiming to be synced');
    assert.equal(client.link.connected, false);

    client.reconnect();
    assert.equal(client.link.connected, true, 'the ladder never brought the link back');
    assert.equal(client.room.synced, true, 'the room never re-synced');
  } finally {
    client.destroy();
  }
});

test('an edit made while the link was down goes up on reconnect, as a real Yjs merge', () => {
  const mux = new FakeMux();
  const ann = peer(mux);
  const bob = peer(mux);
  try {
    ann.doc.getText('content').insert(0, 'before');
    assert.equal(bob.text(), 'before');

    mux.dropSockets();
    ann.doc.getText('content').insert(ann.text().length, ' + offline');
    assert.equal(mux.text('_tree'), 'before', 'an offline edit reached the server');

    ann.reconnect();
    bob.reconnect();
    assert.equal(mux.text('_tree'), 'before + offline');
    assert.equal(bob.text(), 'before + offline', 'the peer never caught up');
  } finally {
    ann.destroy();
    bob.destroy();
  }
});

test('remote awareness states are dropped when the link goes, and the local one is kept', () => {
  const mux = new FakeMux();
  const ann = peer(mux);
  const bob = peer(mux);
  try {
    ann.room.awareness.setLocalStateField('user', { name: 'Ann' });
    assert.equal(bob.room.awareness.getStates().size >= 2, true,
      'the peer never learned about the other client');

    mux.dropSockets();
    const states = [...bob.room.awareness.getStates().keys()];
    assert.deepEqual(states, [bob.doc.clientID],
      'a dead link left another client\'s cursor on screen forever');
  } finally {
    ann.destroy();
    bob.destroy();
  }
});

// ---------------------------------------------------------------- the acknowledgement

test('flush confirms only on a round trip the server actually answered', async () => {
  const mux = new FakeMux();
  const client = peer(mux);
  try {
    client.doc.getText('content').insert(0, 'bytes to confirm');
    assert.equal(await client.room.flush(1_000), true, 'a real round trip was not confirmed');
    assert.equal(mux.text('_tree'), 'bytes to confirm');
  } finally {
    client.destroy();
  }
});

test('flush is FALSE when the room is not being answered, even with the link up', async () => {
  // I17's whole point: a confirmation is a claim the WORKSPACE holds the content,
  // and a node whose `s` is set is never offered for publication again. A live
  // socket carrying 1,999 healthy rooms says nothing about this one.
  const mux = new FakeMux();
  const client = peer(mux);
  try {
    mux.cut('_tree');
    client.doc.getText('content').insert(0, 'never arrived');
    assert.equal(client.link.connected, true, 'the link should still be up');
    assert.equal(await client.room.flush(120), false,
      'an unanswered room reported a confirmed flush');
  } finally {
    client.destroy();
  }
});

test('flush is FALSE when the link is down', async () => {
  const mux = new FakeMux();
  const client = peer(mux);
  try {
    mux.dropSockets();
    assert.equal(await client.room.flush(120), false);
  } finally {
    client.destroy();
  }
});

test('a flush that spans a reconnect FAILS — the new socket answers a different question', async () => {
  const mux = new FakeMux();
  const client = peer(mux);
  try {
    mux.hold('_tree');
    const pending = client.room.flush(2_000);
    // The socket is replaced under the flush. `ProviderAck`'s epoch is what makes
    // this false rather than letting the new connection's frames count.
    mux.dropSockets();
    client.reconnect();
    mux.release('_tree');
    assert.equal(await pending, false, 'a flush was answered by a socket it never wrote to');
  } finally {
    client.destroy();
  }
});

test('a destroyed room flushes false and stops writing', async () => {
  const mux = new FakeMux();
  const client = peer(mux);
  const socket = socketOf(client, mux);
  const before = socket.sent.length;
  client.room.destroy();
  assert.equal(await client.room.flush(50), false);
  client.doc.getText('content').insert(0, 'after destroy');
  assert.equal(socket.sent.length, before, 'a destroyed room still wrote to the wire');
  client.link.destroy();
  client.doc.destroy();
});

test('destroy releases the subscription, so the link can carry that room again', () => {
  const mux = new FakeMux();
  const client = peer(mux);
  try {
    client.room.destroy();
    assert.equal(client.link.roomCount, 0, 'the room stayed subscribed after destroy');
    const doc = new Y.Doc();
    const again = new MuxRoom(client.link, '_tree', doc);
    assert.equal(again.synced, true, 'a re-subscribed room never handshook');
    again.destroy();
    doc.destroy();
  } finally {
    client.link.destroy();
    client.doc.destroy();
  }
});

test('a shared awareness instance is not destroyed by the room that borrowed it', () => {
  const mux = new FakeMux();
  const doc = new Y.Doc();
  const shared = new awarenessProtocol.Awareness(doc);
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: 'sk',
    workspaceId: 'ws-1',
    openSocket: mux.openSocket,
    detectTimeoutMs: 0,
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  const room = new MuxRoom(link, 'n_a', doc, { awareness: shared });
  link.connect();
  room.destroy();
  assert.equal(shared.getLocalState() !== null, true,
    'the room destroyed an awareness instance it did not own');
  shared.destroy();
  link.destroy();
  doc.destroy();
});
