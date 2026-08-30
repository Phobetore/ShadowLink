// src/sync/ProviderAck.test.ts
//
// The acknowledgement both flush paths now share, exercised without a network.
//
// The real round trip is covered against the real server in
// `ObsidianDocPort.test.ts`; what cannot be provoked there on demand is what this
// file is for — the three ways a flush can be handed a reply that is not an answer
// to its own question:
//
//  * y-websocket's own connect-time SyncStep1 is answered within ~1 RTT of the
//    socket opening. A flush entering that window must not accept THAT reply
//    (test 1);
//  * a reply owed to an earlier, timed-out flush arrives late (test 5);
//  * the socket is replaced mid-flush, and the new connection's frames say
//    nothing about what the old one carried (test 2).
//
// Each of the three would report a publish as confirmed when it was not, and a
// node whose `s` is set is never offered for publication again by anybody (I17).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';

import { ProviderAck, isSyncStep2, type AckProvider, type AckSocket } from './ProviderAck.ts';

// ---------------------------------------------------------------- fixtures

const MESSAGE_SYNC = 0;
const WS_OPEN = 1;

/** A real SyncStep2 frame, encoded exactly as the server encodes one. */
function step2Frame(): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(enc, new Y.Doc());
  return encoding.toUint8Array(enc);
}

/** An UPDATE frame: traffic on the same socket that is not an acknowledgement. */
function updateFrame(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'hello');
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
}

class FakeSocket implements AckSocket {
  readyState = WS_OPEN;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];

  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  addEventListener(type: 'message' | 'close', listener: (event: { data?: unknown }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(
    type: 'message' | 'close',
    listener: (event: { data?: unknown }) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Deliver one frame, as the browser would. */
  deliver(frame: Uint8Array): void {
    for (const listener of [...(this.listeners.get('message') ?? [])]) {
      listener({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
    }
  }

  /** SyncStep1 frames this ack wrote onto the wire. */
  get step1Count(): number {
    return this.sent.length;
  }
}

class FakeProvider implements AckProvider {
  wsconnected = true;
  ws: FakeSocket | null;

  private readonly handlers = new Set<() => void>();

  constructor(socket: FakeSocket) {
    this.ws = socket;
  }

  on(_event: 'status', handler: () => void): void {
    this.handlers.add(handler);
  }

  off(_event: 'status', handler: () => void): void {
    this.handlers.delete(handler);
  }

  /** A reconnect: a brand-new socket, announced the way y-websocket announces one. */
  reconnect(socket: FakeSocket | null): void {
    this.ws = socket;
    this.wsconnected = socket !== null;
    for (const handler of [...this.handlers]) handler();
  }
}

function tick(ms = 0): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** Attach a settled-flag to a promise so "has not resolved yet" is assertable. */
function watch(promise: Promise<boolean>): { done: boolean; value: boolean | null } {
  const state: { done: boolean; value: boolean | null } = { done: false, value: null };
  void promise.then((value) => { state.done = true; state.value = value; });
  return state;
}

// ---------------------------------------------------------------- 1

test('the reply to the provider’s own SyncStep1 does not confirm a flush', async () => {
  const socket = new FakeSocket();
  const provider = new FakeProvider(socket);
  const ack = new ProviderAck(provider, new Y.Doc());

  const flush = ack.flush(1_000);
  const state = watch(flush);
  await tick();

  assert.equal(socket.step1Count, 1, 'the flush asked its own question');

  // y-websocket sent a SyncStep1 when this socket opened; this is the server
  // answering THAT one, roughly one round trip into the connection.
  socket.deliver(step2Frame());
  await tick();
  assert.equal(state.done, false, 'that reply belongs to the provider, not to the flush');

  socket.deliver(step2Frame());
  assert.equal(await flush, true, 'the flush’s own answer confirms it');
  ack.destroy();
});

// ---------------------------------------------------------------- 2

test('a flush that spans a reconnect fails rather than lying', async () => {
  const first = new FakeSocket();
  const provider = new FakeProvider(first);
  const ack = new ProviderAck(provider, new Y.Doc());

  const flush = ack.flush(1_000);
  await tick();

  const second = new FakeSocket();
  provider.reconnect(second);
  // Everything the new connection says is about the new connection.
  second.deliver(step2Frame());
  second.deliver(step2Frame());
  second.deliver(step2Frame());

  assert.equal(await flush, false, 'the old socket’s question was never answered');
  ack.destroy();
});

// ---------------------------------------------------------------- 3

test('nothing is asked until the send buffer has drained', async () => {
  const socket = new FakeSocket();
  socket.bufferedAmount = 512;
  const provider = new FakeProvider(socket);
  const ack = new ProviderAck(provider, new Y.Doc());

  const flush = ack.flush(2_000);
  const state = watch(flush);
  await tick(60);

  assert.equal(socket.step1Count, 0, 'a SyncStep1 queued behind the bytes proves nothing');
  assert.equal(state.done, false);

  socket.bufferedAmount = 0;
  await tick(60);
  assert.equal(socket.step1Count, 1, 'asked once the bytes were gone');

  socket.deliver(step2Frame());
  socket.deliver(step2Frame());
  assert.equal(await flush, true);
  ack.destroy();
});

// ---------------------------------------------------------------- 4

test('a disconnected provider, a closed socket and a destroyed ack all flush false', async () => {
  const socket = new FakeSocket();
  const provider = new FakeProvider(socket);
  const ack = new ProviderAck(provider, new Y.Doc());

  provider.wsconnected = false;
  assert.equal(await ack.flush(200), false, 'not connected');

  provider.wsconnected = true;
  socket.readyState = 3;                                   // CLOSED
  assert.equal(await ack.flush(200), false, 'the socket cannot carry the question');

  socket.readyState = WS_OPEN;
  ack.destroy();
  assert.equal(await ack.flush(200), false, 'destroyed');

  const gone = new FakeProvider(socket);
  gone.ws = null;
  const orphan = new ProviderAck(gone, new Y.Doc());
  assert.equal(await orphan.flush(200), false, 'no socket at all');
  orphan.destroy();
});

// ---------------------------------------------------------------- 5

test('a late reply to a timed-out flush cannot answer the next one', async () => {
  const socket = new FakeSocket();
  const provider = new FakeProvider(socket);
  const ack = new ProviderAck(provider, new Y.Doc());

  assert.equal(await ack.flush(30), false, 'nothing came back in time');

  // Both owed replies land after the deadline: the provider's, and the one the
  // timed-out flush asked for.
  socket.deliver(step2Frame());
  socket.deliver(step2Frame());

  const second = ack.flush(1_000);
  const state = watch(second);
  await tick();
  assert.equal(state.done, false, 'the backlog is not an answer to a new question');

  socket.deliver(step2Frame());
  assert.equal(await second, true);
  ack.destroy();
});

// ---------------------------------------------------------------- 6

test('ordinary update traffic is never mistaken for an acknowledgement', async () => {
  const socket = new FakeSocket();
  const provider = new FakeProvider(socket);
  const ack = new ProviderAck(provider, new Y.Doc());

  const flush = ack.flush(120);
  const state = watch(flush);
  await tick();

  socket.deliver(updateFrame());
  socket.deliver(updateFrame());
  socket.deliver(updateFrame());
  await tick();
  assert.equal(state.done, false, 'updates are not answers');

  assert.equal(await flush, false, 'and the flush times out honestly');
  ack.destroy();
});

// ---------------------------------------------------------------- 7

test('isSyncStep2 reads only what it is given', () => {
  assert.equal(isSyncStep2(step2Frame()), true);
  assert.equal(isSyncStep2(updateFrame()), false);
  assert.equal(isSyncStep2('not a frame'), false);
  assert.equal(isSyncStep2(null), false);
  assert.equal(isSyncStep2(new Uint8Array([255, 255, 255])), false);
});

// ---------------------------------------------------------------- the count itself

/** A socket that refuses to write, the way a shared link refuses a dropped frame. */
class RefusingSocket extends FakeSocket {
  refusing = false;

  override send(data: Uint8Array): boolean {
    if (this.refusing) return false;
    super.send(data);
    return true;
  }
}

test('a question that could not be SENT is not counted as outstanding', async () => {
  // ⚠ A real `WebSocket.send` returns nothing, but a link that shares a socket
  // can refuse a frame it never wrote. Counting that refusal as a question raises
  // every later flush's target by one, for ever — which is the same permanent
  // stall as a lost answer, arrived at without the network being involved at all.
  const socket = new RefusingSocket();
  const provider = new FakeProvider(socket);
  const doc = new Y.Doc();
  const ack = new ProviderAck(provider, doc);
  try {
    socket.deliver(step2Frame());                       // the handshake's own reply

    socket.refusing = true;
    assert.equal(await ack.flush(50), false, 'a question that never went out was confirmed');

    socket.refusing = false;
    const flushing = ack.flush(1_000);
    await Promise.resolve();
    socket.deliver(step2Frame());
    assert.equal(await flushing, true,
      'a refused send left the count permanently short of its own target');
  } finally {
    ack.destroy();
    doc.destroy();
  }
});

test('an answer delivered INSIDE send is still counted against its own question', async () => {
  // ⚠ A trap this file fell into once and this test holds shut. A peer can reply
  // synchronously — every in-memory relay does, and so does anything that loops
  // the write straight back — so the question has to be counted BEFORE the write,
  // not after it. Counted after, the synchronous reply decrements a zero and the
  // question stays outstanding for ever: exactly the ratchet being fixed.
  const socket = new (class extends FakeSocket {
    override send(data: Uint8Array): void {
      super.send(data);
      this.deliver(step2Frame());                       // answered inside the write
    }
  })();
  const provider = new FakeProvider(socket);
  const doc = new Y.Doc();
  const ack = new ProviderAck(provider, doc);
  try {
    socket.deliver(step2Frame());                       // the handshake's own reply
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push(await ack.flush(200));
    assert.deepEqual(results, [true, true, true, true],
      'a synchronously answered flush inflated the count for every flush after it');
  } finally {
    ack.destroy();
    doc.destroy();
  }
});

// ---------------------------------------------------------------- the stall

test('a flush that asked on a LIVE socket and got nothing reports a stall, once', async () => {
  // The count is positional, so a question whose frame is dropped after it leaves
  // this process can never be retired: `unanswered` stays up and every later
  // flush asks for one more answer than the socket will ever produce. Measured
  // over a per-room partition: six consecutive flushes on a healed, converged,
  // connected room all returned false. The counters cannot be cleared in place —
  // a late reply would then confirm a flush whose bytes the server never saw — so
  // the ack says so and the owner gets a new socket.
  const socket = new FakeSocket();
  const provider = new FakeProvider(socket);
  const doc = new Y.Doc();
  let stalls = 0;
  const ack = new ProviderAck(provider, doc, () => { stalls += 1; });
  try {
    socket.deliver(step2Frame());
    assert.equal(await ack.flush(60), false);
    assert.equal(stalls, 1, 'a silent live socket was never reported');

    assert.equal(await ack.flush(60), false);
    assert.equal(stalls, 1, 'the stall repeated on the same socket');

    // A fresh socket is the repair, and it re-arms the report.
    provider.reconnect(new FakeSocket());
    assert.equal(await ack.flush(60), false);
    assert.equal(stalls, 2, 'the new socket did not re-arm the report');
  } finally {
    ack.destroy();
    doc.destroy();
  }
});

test('a stall the owner DECLINED does not consume the one report', async () => {
  // ⚠ MEASURED, and it is what left the [false × N] ratchet half-fixed. The gate
  // is one report per socket, and its argument — a server dropping frames for
  // many rooms must not become a reconnect loop — is about reconnects that
  // HAPPEN. `MuxRoom` declines for a room that was never synced; the report was
  // burned anyway, so a room whose frames were lost before its first answer could
  // never ask for the repair again. Driving the real link over a frame gate: cut
  // before the handshake, healed, converged, connected, synced, a neighbour on
  // the same socket flushing true — and twelve flushes returning false with zero
  // recycles.
  const socket = new FakeSocket();
  const provider = new FakeProvider(socket);
  const doc = new Y.Doc();
  let offers = 0;
  let willAct = false;
  const ack = new ProviderAck(provider, doc, () => { offers += 1; return willAct; });
  try {
    socket.deliver(step2Frame());
    assert.equal(await ack.flush(60), false);
    assert.equal(offers, 1, 'a silent live socket was never reported');

    assert.equal(await ack.flush(60), false);
    assert.equal(offers, 2, 'a declined report consumed the one the socket had');

    // The owner can now act, on the SAME socket, and that is what spends it.
    willAct = true;
    assert.equal(await ack.flush(60), false);
    assert.equal(offers, 3);
    assert.equal(await ack.flush(60), false);
    assert.equal(offers, 3, 'a report the owner ACTED on did not consume the one-shot');
  } finally {
    ack.destroy();
    doc.destroy();
  }
});

test('a stall report that THREW did not happen, so it did not spend the report', async () => {
  const socket = new FakeSocket();
  const provider = new FakeProvider(socket);
  const doc = new Y.Doc();
  let offers = 0;
  const ack = new ProviderAck(provider, doc, () => {
    offers += 1;
    throw new Error('the owner could not repair it');
  });
  try {
    socket.deliver(step2Frame());
    assert.equal(await ack.flush(60), false);
    assert.equal(await ack.flush(60), false);
    assert.equal(offers, 2, 'a repair that threw was counted as a repair that happened');
  } finally {
    ack.destroy();
    doc.destroy();
  }
});

test('an owner that returns NOTHING is an owner that acted — the old two-arg shape', async () => {
  const socket = new FakeSocket();
  const provider = new FakeProvider(socket);
  const doc = new Y.Doc();
  let offers = 0;
  const ack = new ProviderAck(provider, doc, () => { offers += 1; });
  try {
    socket.deliver(step2Frame());
    assert.equal(await ack.flush(60), false);
    assert.equal(await ack.flush(60), false);
    assert.equal(offers, 1, 'an owner with no opinion was asked twice on one socket');
  } finally {
    ack.destroy();
    doc.destroy();
  }
});

test('a flush that failed because the CONNECTION went away is not a stall', async () => {
  // Nothing is wrong with the accounting when the socket is simply gone: the next
  // attach resets it. Reporting here would turn every ordinary disconnect into a
  // reconnect request.
  const socket = new FakeSocket();
  const provider = new FakeProvider(socket);
  const doc = new Y.Doc();
  let stalls = 0;
  const ack = new ProviderAck(provider, doc, () => { stalls += 1; });
  try {
    socket.deliver(step2Frame());
    const flushing = ack.flush(500);
    await Promise.resolve();
    provider.reconnect(null);
    assert.equal(await flushing, false);
    assert.equal(stalls, 0, 'a dropped connection was reported as an accounting stall');
  } finally {
    ack.destroy();
    doc.destroy();
  }
});
