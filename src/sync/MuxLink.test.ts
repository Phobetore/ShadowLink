// src/sync/MuxLink.test.ts
//
// The link, without a document in sight (P3 spec §1.1, §2, §9 slice 2).
//
// `MuxLink` is deliberately ignorant of Yjs, so everything here is about the four
// promises the spec makes for the transport itself:
//
//   1. the frame is `varString(room) + varUint8Array(payload)` and nothing else;
//   2. a room's frames reach that room's handler and NO OTHER;
//   3. reconnect is ONE backoff loop with jitter, not one per room;
//   4. a server that does not speak the protocol is detected, and the link then
//      stops rather than retrying something that will never work.
//
// The fourth is the one measured against a real process: a server checked out
// from before any P3 work ACCEPTS `/_mux`, answers with a raw y-websocket
// SyncStep1, and then ignores every frame forever. So detection cannot be "the
// socket refused" and cannot be a timeout in the common case; the tests below pin
// both halves of what it actually is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as encoding from 'lib0/encoding';

import { FakeMux } from './fakes.ts';
import {
  MUX_DOC_ID, MuxLink, decodeMuxFrame, encodeMuxFrame,
  type MuxLinkConfig, type MuxSocket, type MuxUnsupportedReason,
} from './MuxLink.ts';
import {
  MUX_RECONNECT_BACKOFF_MS, MUX_RECONNECT_JITTER, TREE_SYNC_TIMEOUT_MS,
} from '../tree/constants.ts';

// ---------------------------------------------------------------- fixtures

const KEY = 'sk_test';
const WORKSPACE = 'ws-1';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/**
 * A link over a `FakeMux`, plus a hand-driven clock so a backoff assertion is
 * about the ladder rather than about how long a test was willing to sleep.
 */
function makeLink(over: Partial<MuxLinkConfig> = {}): {
  link: MuxLink;
  mux: FakeMux;
  timers: Array<{ fn: () => void; ms: number }>;
  fire: () => void;
} {
  const mux = new FakeMux();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    openSocket: mux.openSocket,
    random: () => 0.5,                                   // no jitter unless asked
    // Off by default so `timers` is the BACKOFF ladder and nothing else. The
    // liveness tests below build their own link and turn the one they are about
    // back on.
    idleTimeoutMs: 0,
    connectTimeoutMs: 0,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { delete timers[handle as number]; },
    ...over,
  });
  const fire = (): void => {
    const due = timers.splice(0).filter((t) => t !== undefined);
    for (const timer of due) timer.fn();
  };
  return { link, mux, timers, fire };
}

/** Collect everything delivered to one room. */
function collector(): { payloads: Uint8Array[]; opens: number; closes: number } & {
  onOpen(): void; onPayload(p: Uint8Array): void; onClose(): void;
} {
  const state = {
    payloads: [] as Uint8Array[],
    opens: 0,
    closes: 0,
    onOpen(): void { state.opens += 1; },
    onPayload(p: Uint8Array): void { state.payloads.push(p); },
    onClose(): void { state.closes += 1; },
  };
  return state;
}

// ---------------------------------------------------------------- the codec

test('the frame is the server\'s frame — round trip, and the room is not in the payload', () => {
  const payload = bytes(0, 1, 2, 3, 250);
  const frame = encodeMuxFrame('n_AbCdEf', payload);
  const decoded = decodeMuxFrame(frame);
  assert.notEqual(decoded, null);
  assert.equal(decoded?.room, 'n_AbCdEf');
  assert.deepEqual([...(decoded?.payload ?? [])], [...payload]);
});

test('an empty payload survives the round trip — a room with nothing to say', () => {
  const decoded = decodeMuxFrame(encodeMuxFrame('_tree', new Uint8Array(0)));
  assert.equal(decoded?.room, '_tree');
  assert.equal(decoded?.payload.byteLength, 0);
});

test('a frame with bytes after the payload is REFUSED, which is half the detector', () => {
  // ⚠ These are the measured bytes a pre-P3 server writes on connect: a raw
  // y-websocket SyncStep1 for an empty document. Read as a frame it is a
  // zero-length room name, a zero-length payload — and two bytes left over. A
  // decoder that ignored the tail would hand the link a frame for a room called
  // "" and the legacy detector would have nothing to fire on.
  const legacyFirstMessage = bytes(0x00, 0x00, 0x01, 0x00);
  assert.equal(decodeMuxFrame(legacyFirstMessage), null);

  // And it is the TAIL that is refused, not the shape: the same prefix alone
  // decodes fine.
  assert.notEqual(decodeMuxFrame(bytes(0x00, 0x00)), null);
});

test('a truncated frame decodes to null rather than throwing', () => {
  const frame = encodeMuxFrame('_tree', bytes(1, 2, 3, 4, 5));
  assert.equal(decodeMuxFrame(frame.slice(0, frame.byteLength - 2)), null);
  assert.equal(decodeMuxFrame(new Uint8Array(0)), null);
});

// ---------------------------------------------------------------- the URL

test('the link dials /_mux with the same auth the per-room route takes', () => {
  const { link } = makeLink();
  assert.equal(link.url, `ws://host:1234/${MUX_DOC_ID}?t=${KEY}&w=${WORKSPACE}`);
});

test('a trailing slash on the server url does not become a double slash', () => {
  const { link } = makeLink({ serverUrl: 'ws://host:1234//' });
  assert.equal(link.url, `ws://host:1234/${MUX_DOC_ID}?t=${KEY}&w=${WORKSPACE}`);
});

test('a key or workspace with url-hostile characters is encoded, not interpolated', () => {
  const { link } = makeLink({ serverKey: 'a&b=c', workspaceId: 'w s' });
  assert.equal(link.url, `ws://host:1234/${MUX_DOC_ID}?t=a%26b%3Dc&w=w%20s`);
});

// ---------------------------------------------------------------- delivery

test('one socket carries several rooms, and each frame reaches exactly one handler', () => {
  const { link, mux } = makeLink();
  const tree = collector();
  const noteA = collector();
  const noteB = collector();
  link.subscribe('_tree', tree);
  link.subscribe('n_a', noteA);
  link.subscribe('n_b', noteB);
  link.connect();

  assert.equal(mux.sockets.length, 1, 'three rooms opened more than one socket');
  assert.equal(link.roomCount, 3);

  const socket = mux.sockets[0];
  socket.push('n_a', bytes(9, 9));
  assert.equal(tree.payloads.length, 0, '_tree was delivered a frame addressed to n_a');
  assert.equal(noteB.payloads.length, 0, 'n_b was delivered a frame addressed to n_a');
  assert.deepEqual([...noteA.payloads[0]], [9, 9]);
});

test('a room that was cut goes quiet while the others keep flowing — per-room partition', () => {
  // The capability the spec demands of `FakeMux` by name, asserted on the fake
  // itself before anything is built on top of it: five fakes in this repo have
  // hidden a defect by not being able to say the failure.
  const { link, mux } = makeLink();
  const cut = collector();
  const live = collector();
  link.subscribe('n_cut', cut);
  link.subscribe('n_live', live);
  link.connect();
  const socket = mux.sockets[0];

  mux.cut('n_cut');
  socket.push('n_cut', bytes(1));
  socket.push('n_live', bytes(2));
  assert.equal(cut.payloads.length, 0, 'the cut room still received a frame');
  assert.equal(live.payloads.length, 1, 'cutting one room silenced another');
  assert.equal(link.connected, true, 'cutting a room took the socket down');

  mux.heal('n_cut');
  socket.push('n_cut', bytes(3));
  assert.deepEqual([...cut.payloads[0]], [3], 'healing did not restore the room');
});

test('a cut room stops SENDING too, so a partition is not one-directional', () => {
  const { link, mux } = makeLink();
  link.subscribe('n_cut', collector());
  link.connect();
  mux.cut('n_cut');

  assert.equal(link.send('n_cut', bytes(7)), true, 'the link should still write the frame');
  const socket = mux.sockets[0];
  assert.equal(socket.sent.length, 1, 'the frame never reached the wire at all');
  // It reached the wire and the SERVER dropped it: the room was never opened.
  assert.equal(socket.hasRoom('n_cut'), false, 'a cut room was opened on the server');
});

test('an unsubscribed room stops being delivered to, and a later frame is harmless', () => {
  const { link, mux } = makeLink();
  const room = collector();
  const subscription = link.subscribe('n_a', room);
  link.connect();
  const socket = mux.sockets[0];

  subscription.unsubscribe();
  assert.equal(link.roomCount, 0);
  socket.push('n_a', bytes(1));
  assert.equal(room.payloads.length, 0, 'an unsubscribed room was still delivered to');
  // ⚠ And it did NOT read as an old server. A straggler for a room we dropped is
  // an ordinary in-flight frame; treating it as evidence would make every
  // unsubscribe a race that can tear the whole topology down.
  assert.equal(link.unsupportedReason, null);
});

test('sending on an unsubscribed handle is refused, and does not resurrect the room', () => {
  const { link, mux } = makeLink();
  const subscription = link.subscribe('n_a', collector());
  link.connect();
  subscription.unsubscribe();
  assert.equal(subscription.send(bytes(1)), false);
  assert.equal(mux.sockets[0].sent.length, 0);
});

test('subscribing the same room twice on one link is a programming error, not a silent overwrite', () => {
  const { link } = makeLink();
  link.subscribe('n_a', collector());
  assert.throws(() => link.subscribe('n_a', collector()), /already subscribed/);
});

test('a room subscribed onto an already-open link handshakes at once, not on the next connect', () => {
  const { link } = makeLink();
  link.connect();
  const late = collector();
  link.subscribe('n_late', late);
  assert.equal(late.opens, 1, 'a room joining a live link was never told to handshake');
});

test('a handler that throws does not take the socket or the other rooms with it', () => {
  const { link, mux } = makeLink();
  const good = collector();
  link.subscribe('n_bad', {
    onPayload: () => { throw new Error('boom'); },
  });
  link.subscribe('n_good', good);
  link.connect();
  const socket = mux.sockets[0];

  socket.push('n_bad', bytes(1));
  socket.push('n_good', bytes(2));
  assert.equal(link.connected, true, 'one room\'s throw dropped the shared socket');
  assert.equal(good.payloads.length, 1, 'one room\'s throw silenced another');
});

// ---------------------------------------------------------------- reconnect

test('reconnect is ONE ladder for the link, walked once however many rooms are on it', () => {
  const { link, mux, timers } = makeLink();
  for (let i = 0; i < 5; i++) link.subscribe(`n_${i}`, collector());
  link.connect();

  mux.dropSockets();
  assert.equal(timers.filter((t) => t !== undefined).length, 1,
    'five rooms armed more than one retry');
  assert.equal(timers[0].ms, MUX_RECONNECT_BACKOFF_MS[0]);
});

test('the ladder climbs on each failed attempt and resets when a socket opens', () => {
  const { link, mux, timers, fire } = makeLink();
  link.subscribe('_tree', collector());
  link.connect();

  // Every attempt from here fails to dial at all, which is what makes the rungs
  // observable: a dial that SUCCEEDS resets the ladder, so a fake that always
  // connects would report rung one forever and pin nothing.
  mux.refuseConnect = true;
  mux.dropSockets();

  const rungs: number[] = [];
  for (let i = 0; i < 6; i++) {
    const armed = timers.filter((t) => t !== undefined);
    rungs.push(armed[armed.length - 1].ms);
    fire();
  }
  const top = MUX_RECONNECT_BACKOFF_MS[MUX_RECONNECT_BACKOFF_MS.length - 1];
  assert.deepEqual(rungs, [...MUX_RECONNECT_BACKOFF_MS, top, top],
    'the ladder did not climb, or did not saturate at the top rung');
  // ⚠ And the top rung is a number a person waits out. It used to be 60 s, which
  // is four times `TREE_SYNC_TIMEOUT_MS`: an ordinary outage ending inside that
  // window put the plugin into read-only against a server that was up. Measured
  // before the change: 52,703 ms to resync a 30-second outage, where a
  // `WebsocketProvider` on the same server took 649 ms.
  assert.ok(top + top * MUX_RECONNECT_JITTER < TREE_SYNC_TIMEOUT_MS,
    `the worst-case rung ${top}ms +jitter outlasts the tree's own deadline`);

  // A socket that opened resets it: the next failure is back on rung one.
  mux.refuseConnect = false;
  fire();
  assert.equal(link.connected, true, 'the link never came back');
  mux.dropSockets();
  const armed = timers.filter((t) => t !== undefined);
  assert.equal(armed[armed.length - 1].ms, MUX_RECONNECT_BACKOFF_MS[0]);
});

test('the ladder is jittered, both directions, around the rung', () => {
  const roll = [0, 1, 0.5];
  let i = 0;
  const { link, mux, timers, fire } = makeLink({ random: () => roll[i++ % roll.length] });
  link.subscribe('_tree', collector());
  link.connect();
  mux.refuseConnect = true;
  mux.dropSockets();

  const delays: number[] = [];
  for (let n = 0; n < 3; n++) {
    const armed = timers.filter((t) => t !== undefined);
    delays.push(armed[armed.length - 1].ms);
    fire();
  }
  // rung 1 at -25%, rung 2 at +25%, rung 3 at the centre.
  const [r1, r2, r3] = MUX_RECONNECT_BACKOFF_MS;
  assert.deepEqual(delays, [
    Math.round(r1 * (1 - MUX_RECONNECT_JITTER)),
    Math.round(r2 * (1 + MUX_RECONNECT_JITTER)),
    r3,
  ]);
});

test('every subscribed room re-handshakes on reconnect, and only once per connect (I24)', () => {
  const { link, mux, fire } = makeLink();
  const a = collector();
  const b = collector();
  link.subscribe('n_a', a);
  link.subscribe('n_b', b);
  link.connect();
  assert.deepEqual([a.opens, b.opens], [1, 1]);

  mux.dropSockets();
  assert.deepEqual([a.closes, b.closes], [1, 1], 'a room was not told the link went away');
  fire();
  assert.deepEqual([a.opens, b.opens], [2, 2], 'a room did not re-handshake after reconnect');
  assert.equal(mux.sockets.length, 2, 'reconnect opened more than one socket');
});

test('a factory that refuses to dial is one failed attempt, not a spin', () => {
  const { link, mux, timers } = makeLink();
  mux.refuseConnect = true;
  link.subscribe('_tree', collector());
  link.connect();
  assert.equal(mux.sockets.length, 0);
  assert.equal(timers.filter((t) => t !== undefined).length, 1, 'a refused dial armed no retry');
});

test('connect() while the ladder is waiting does not jump the queue', () => {
  // ⚠ Not hypothetical: `Bootstrap.connectTree` calls `connect()` on every
  // attempt, and `onReconnect` reaches it too. If each call dialled immediately,
  // a client whose server is down would hammer it once per bootstrap attempt and
  // the ladder would be decoration. Found by a mutation probe — the guard
  // survived deletion until this existed.
  const { link, mux, timers } = makeLink();
  link.subscribe('_tree', collector());
  link.connect();
  mux.dropSockets();
  assert.equal(timers.filter((t) => t !== undefined).length, 1, 'no retry was armed');
  const dialled = mux.sockets.length;

  link.connect();
  link.connect();
  assert.equal(mux.sockets.length, dialled, 'connect() dialled while the ladder was waiting');
  assert.equal(
    timers.filter((t) => t !== undefined).length, 1,
    'connect() armed a second rung beside the one already waiting',
  );
});

test('disconnect stops the ladder, and connect starts it again', () => {
  const { link, mux, timers } = makeLink();
  link.subscribe('_tree', collector());
  link.connect();
  link.disconnect();
  assert.equal(link.connected, false);
  assert.equal(timers.filter((t) => t !== undefined).length, 0, 'a deliberate disconnect retried');

  link.connect();
  assert.equal(mux.sockets.length, 2);
  assert.equal(link.connected, true);
});

// ---------------------------------------------------------------- legacy detection

/** A link over an old-server fake. Deferred open, so the greeting has somewhere to land. */
function makeLegacyLink(): {
  link: MuxLink; mux: FakeMux; reasons: MuxUnsupportedReason[];
  timers: Array<{ fn: () => void; ms: number }>;
} {
  const mux = new FakeMux({ legacy: true });
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    openSocket: mux.openSocket,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { delete timers[handle as number]; },
  });
  const reasons: MuxUnsupportedReason[] = [];
  link.onUnsupported((reason) => reasons.push(reason));
  return { link, mux, reasons, timers };
}

test('a pre-P3 server is detected from its FIRST message, in one round trip', async () => {
  const { link, reasons } = makeLegacyLink();
  link.subscribe('_tree', collector());
  link.connect();
  await Promise.resolve();

  assert.deepEqual(reasons, ['not-a-frame'],
    'the raw SyncStep1 a pre-P3 server sends on connect was not recognised');
  assert.equal(link.connected, false, 'the link stayed on a server that cannot serve it');
  assert.equal(link.unsupportedReason, 'not-a-frame');
});

test('the old server ACCEPTED the socket — detection cannot be "the dial failed"', async () => {
  const { link, mux } = makeLegacyLink();
  link.subscribe('_tree', collector());
  link.connect();
  // The socket really did open, and this is the measured shape: `_mux` matches a
  // pre-P3 server's own `DOC_RE`, so the upgrade is authorised and the socket is
  // served as an ordinary room called `_mux`.
  assert.equal(mux.sockets.length, 1);
  await Promise.resolve();
  assert.equal(link.unsupportedReason, 'not-a-frame');
});

test('a detected legacy server stops the ladder: there is nothing to retry into', async () => {
  const { link, mux, timers } = makeLegacyLink();
  link.subscribe('_tree', collector());
  link.connect();
  await Promise.resolve();

  assert.equal(timers.filter((t) => t !== undefined).length, 0,
    'the link kept retrying a server that will never answer');
  link.connect();
  assert.equal(mux.sockets.length, 1, 'connect() re-dialled a server already known to be old');
});

test('a peer that took our frames and said nothing is RETRIED, never condemned', () => {
  // ⚠ THE RULE, in the one place it used to be broken hardest. A ten-second
  // timer used to turn this exact state into `'silent'` — a session-long verdict
  // reached from the absence of an answer, which then told the user their server
  // was older than their plugin. Measured false against the shipped server behind
  // a proxy holding its first frame; the route had already answered twice.
  //
  // What silence is worth is a retry, and the retry is the liveness watchdog: at
  // the idle timeout the socket is closed and the ladder dials again, for as long
  // as the link is wanted.
  const clock = { t: 0 };
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const reasons: MuxUnsupportedReason[] = [];
  const opened: MuxSocket[] = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    openSocket: () => {
      // A socket that says nothing but whose close is a real close: the
      // watchdog's own synthesised close is pinned by its own test below.
      const socket = { ...silentSocket() };
      socket.close = (): void => { socket.readyState = 3; socket.onclose?.({}); };
      opened.push(socket);
      return socket;
    },
    connectTimeoutMs: 0,
    idleTimeoutMs: 30_000,
    random: () => 0.5,
    now: () => clock.t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  link.onUnsupported((reason) => reasons.push(reason));
  // The room writes on handshake, exactly as `MuxRoom` does.
  link.subscribe('_tree', {
    onOpen: () => { link.send('_tree', bytes(0, 0)); },
    onPayload: () => undefined,
  });
  link.connect();
  assert.equal(link.stats.socketsOpened, 1);

  // A full idle timeout of nothing at all, polled the way the watchdog polls.
  for (let i = 0; i < 11; i += 1) {
    clock.t += 3_000;
    for (const timer of timers.splice(0).filter((t) => t !== undefined)) timer.fn();
  }

  assert.deepEqual(reasons, [], 'silence condemned the route');
  assert.equal(link.unsupportedReason, null, 'a peer that said nothing was demoted');
  assert.equal(link.stats.idleClosures, 1, 'the silent socket was never closed');
  assert.equal(link.stats.socketsOpened, 2, 'the link did not dial again after the close');
});

test('a socket closed for saying nothing REPORTS it — retrying in silence is not enough', () => {
  // ⚠ THE HOLE THE PREVIOUS ROUND LEFT. Deleting the ten-second verdict deleted
  // the evidence-gathering with it, and the route it left behind produced
  // nothing at all: measured on the parent branch through a proxy that upgrades
  // `/_mux` for real and drops every server frame, 70 s gave 3 sockets, 2 idle
  // closures, 18 frames out, 0 in, dialsFailed 0, no probe ever built and no
  // sentence a user could act on. A closure here is not evidence about the peer —
  // but it IS a reason to go and ask whether the server answers anywhere else,
  // which is the question only the bridge can put.
  const clock = { t: 0 };
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const seen: string[] = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    openSocket: () => {
      const socket = { ...silentSocket() };
      socket.close = (): void => { socket.readyState = 3; socket.onclose?.({}); };
      return socket;
    },
    connectTimeoutMs: 0,
    idleTimeoutMs: 30_000,
    random: () => 0.5,
    now: () => clock.t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  link.onUnreachable((evidence) => seen.push(evidence));
  link.subscribe('_tree', {
    onOpen: () => { link.send('_tree', bytes(0, 0)); },
    onPayload: () => undefined,
  });
  link.connect();
  for (let i = 0; i < 11; i += 1) {
    clock.t += 3_000;
    for (const timer of timers.splice(0).filter((t) => t !== undefined)) timer.fn();
  }

  assert.equal(link.stats.idleClosures, 1, 'the deaf socket was never closed');
  assert.deepEqual(seen, ['unanswered'],
    `a deaf socket on a route that never served reported ${JSON.stringify(seen)}`);
  // ⚠ AND IT IS STILL NOT A VERDICT, which is the half the last round got right.
  assert.equal(link.unsupportedReason, null, 'a silence condemned the route');
  assert.equal(link.routeRefused, false, 'a silence was counted as a refusal');
});

test('a deaf socket on a route that HAS served says nothing at all', () => {
  // The gate is the same one the dial reports have: a route that has worked is
  // never reported, because an outage, a slept radio and a proxy restart all look
  // exactly like this and the only honest answer to them is the ladder.
  const clock = { t: 0 };
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const seen: string[] = [];
  const sockets: MuxSocket[] = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    openSocket: () => {
      const socket = { ...silentSocket() };
      socket.close = (): void => { socket.readyState = 3; socket.onclose?.({}); };
      sockets.push(socket);
      return socket;
    },
    connectTimeoutMs: 0,
    idleTimeoutMs: 30_000,
    random: () => 0.5,
    now: () => clock.t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  link.onUnreachable((evidence) => seen.push(evidence));
  link.subscribe('_tree', {
    onOpen: () => { link.send('_tree', bytes(0, 0)); },
    onPayload: () => undefined,
  });
  link.connect();
  sockets[0]?.onmessage?.({ data: encodeMuxFrame('_tree', bytes(0, 0)) });
  assert.equal(link.everServed, true, 'the route never answered in the first place');

  for (let i = 0; i < 11; i += 1) {
    clock.t += 3_000;
    for (const timer of timers.splice(0).filter((t) => t !== undefined)) timer.fn();
  }
  assert.ok(link.stats.idleClosures >= 1, 'the dead socket was never closed');
  assert.deepEqual(seen, [], 'a route that had served this link was reported');
});

test('noteRouteUnserved is a fact that a single frame retracts', () => {
  // It is deliberately not a latch. The bridge records what it proved; the moment
  // the route delivers anything, the sentence built on it stops being true and
  // stops being said, with nothing to clear and nobody to clear it.
  const { link, mux } = makeLink();
  link.subscribe('_tree', collector());
  link.connect();
  assert.equal(link.routeUnserved, false);

  link.noteRouteUnserved();
  assert.equal(link.routeUnserved, true, 'the bridge could not record what it proved');

  mux.sockets[0]?.push('_tree', bytes(0, 0));
  assert.equal(link.everServed, true);
  assert.equal(link.routeUnserved, false, 'a route that answered still read as delivering nothing');
});

test('noteRouteUnserved cannot be recorded against a route that has already served', () => {
  const { link, mux } = makeLink();
  link.subscribe('_tree', collector());
  link.connect();
  mux.sockets[0]?.push('_tree', bytes(0, 0));

  link.noteRouteUnserved();
  assert.equal(link.routeUnserved, false, 'a proven route was described as delivering nothing');
});

test('a link that asked NOTHING is not owed an answer either — no timer condemns it', () => {
  const clock = { t: 0 };
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const reasons: MuxUnsupportedReason[] = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    openSocket: () => silentSocket(),
    connectTimeoutMs: 0,
    idleTimeoutMs: 30_000,
    random: () => 0.5,
    now: () => clock.t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  link.onUnsupported((reason) => reasons.push(reason));
  link.connect();                                    // no rooms: nothing was asked

  for (let i = 0; i < 11; i += 1) {
    clock.t += 3_000;
    for (const timer of timers.splice(0).filter((t) => t !== undefined)) timer.fn();
  }
  assert.deepEqual(reasons, [], 'a link that asked nothing declared the server old');
  assert.equal(link.unsupportedReason, null);
});

test('a route that has served this link is never reported unreachable again', () => {
  // ⚠ MEASURED, and the second half of the same rule. `unreachable` is the
  // bridge's verdict, but the EVIDENCE for it is a run of dials that produced no
  // socket — which is exactly what an outage, a slept radio or a proxy restart
  // produces on a route that works. Before this clause, five seconds of
  // `/_mux`-only trouble demoted a session permanently, 3/3, and a flaky path
  // demoted one that had already synced over the mux.
  const { link, mux, fire } = makeLink({ unreachableDials: 2 });
  let reports = 0;
  link.onUnreachable(() => { reports += 1; });
  link.subscribe('_tree', collector());
  link.connect();

  // The route answers once. That is the positive fact no later silence undoes.
  mux.sockets[0].push('_tree', bytes(0, 0));
  assert.equal(link.everServed, true, 'a good frame did not record the route as served');

  mux.refuseConnect = true;
  mux.dropSockets();
  for (let i = 0; i < 6; i += 1) fire();               // the ladder's own retries
  assert.ok(link.stats.dialsFailed >= 2, 'the probe did not actually fail any dials');
  assert.equal(reports, 0, 'a route that had served this link was reported unreachable');
  assert.equal(link.unsupportedReason, null);
});

test('a route that has NEVER served is still reported, which is what 80f needs', () => {
  const { link, mux, fire } = makeLink({ unreachableDials: 2 });
  let reports = 0;
  link.onUnreachable(() => { reports += 1; });
  link.subscribe('_tree', collector());
  mux.refuseConnect = true;
  link.connect();
  for (let i = 0; i < 3; i += 1) fire();
  assert.equal(link.everServed, false);
  assert.ok(reports > 0, 'a route that never answered was never reported');
});

test('the dial deadline is a PATIENCE ladder, and it resets on any socket that opens', () => {
  // ⚠ NOT A MEASUREMENT OF ANYTHING, which is the whole difference from what this
  // replaces. The deadline used to be raised from what the bridge's legacy probe
  // cost, so one slow start left it widened — up to a minute — for the life of the
  // link, and a later black hole parked a dial for that whole minute on a path
  // that had been fast the entire time between. Here nothing is timed: each dial
  // that ran out of time makes the next one longer, exactly as the backoff ladder
  // makes the next wait longer, and one open socket puts it back.
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const made: Array<MuxSocket & { fire: (event: 'open' | 'close') => void }> = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    idleTimeoutMs: 0,
    connectTimeoutMs: 4_000,
    random: () => 0.5,
    openSocket: () => {
      const socket = { ...silentSocket(), readyState: 0 };
      const handle = Object.assign(socket, {
        fire: (event: 'open' | 'close'): void => {
          if (event === 'open') { socket.readyState = 1; socket.onopen?.({}); }
          else { socket.readyState = 3; socket.onclose?.({}); }
        },
      });
      made.push(handle);
      return handle;
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  const drain = (): number[] => {
    const due = timers.splice(0).filter((t) => t !== undefined);
    for (const timer of due) timer.fn();
    return due.map((t) => t.ms);
  };

  link.subscribe('_tree', { onPayload: () => undefined });
  link.connect();
  assert.equal(link.dialTimeoutMs, 4_000, 'the first dial did not get the first rung');
  drain();                                             // the deadline elapses
  assert.equal(link.dialTimeoutMs, 8_000, 'the second dial was no more patient than the first');
  drain();                                             // the retry rung fires
  drain();                                             // and the second deadline elapses
  assert.equal(link.dialTimeoutMs, 12_000);
  drain();                                             // rung, third dial
  drain();                                             // third deadline elapses
  assert.equal(link.dialTimeoutMs, 12_000, 'the ladder has no top rung');

  // One socket that opens, and the patience is spent — a session that connected
  // never carries a widened deadline into a later outage.
  drain();                                             // rung, fourth dial
  const socket = made[made.length - 1];
  assert.equal(made.length, 4, 'the ladder stopped dialling');
  socket?.fire('open');
  assert.equal(link.dialTimeoutMs, 4_000, 'an open socket did not reset the ladder');
});

test('a dial the CLIENT abandoned is never reported as a refusal', () => {
  // ⚠ THE RULE THIS ROUND EXISTS FOR. A black-holed upgrade and an arbitrarily
  // slow path produce the same observation — our own deadline elapsing — and one
  // of them is a working server. Measured on the parent branch: a path drawing
  // 75% of its connections from 5.5-8.5 s and 25% from 1.2-2.2 s reached a
  // permanent false `unreachable` at 14,527 ms against a server serving `/_mux`
  // normally, with framesIn 0 and a notice blaming a proxy that was forwarding
  // every path.
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    openSocket: () => hangingSocket(),
    idleTimeoutMs: 0,
    connectTimeoutMs: 4_000,
    unreachableDials: 2,
    random: () => 0.5,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  const seen: string[] = [];
  link.onUnreachable((evidence) => seen.push(evidence));
  link.subscribe('_tree', { onPayload: () => undefined });
  link.connect();
  for (let i = 0; i < 8; i += 1) {
    for (const timer of timers.splice(0).filter((t) => t !== undefined)) timer.fn();
  }

  assert.ok(link.stats.dialsAbandoned >= 2, 'no dial actually ran out of time');
  assert.equal(link.stats.dialsRefused, 0, 'a deadline was counted as a refusal');
  assert.equal(link.routeRefused, false, 'a run of deadlines became something a verdict may rest on');
  assert.ok(seen.length > 0, 'a route producing nothing was never reported at all');
  assert.deepEqual([...new Set(seen)], ['unanswered'],
    `the evidence named a refusal that never happened: ${JSON.stringify(seen)}`);
  assert.equal(link.unsupportedReason, null);
});

test('connect({ immediate }) jumps a dial that has already had the first rung', () => {
  // ⚠ MEASURED AS INERT. `open()` assigns `this.socket` before the socket opens
  // and `connect()` returns early while one exists, so a dial parked on a widened
  // deadline swallowed every immediate request behind it: on the previous round,
  // an eight-second black hole left a client read-only for 48,037 ms of which
  // 40,063 ms were after the path had fully recovered.
  const clock = { t: 0 };
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  let dials = 0;
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    openSocket: () => { dials += 1; return hangingSocket(); },
    idleTimeoutMs: 0,
    connectTimeoutMs: 4_000,
    random: () => 0.5,
    now: () => clock.t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  link.subscribe('_tree', { onPayload: () => undefined });
  link.connect();
  assert.equal(dials, 1);

  // ⚠ THE FIRST RUNG IS LEFT ALONE. A dial that has not had the ordinary
  // allowance may simply be on a slow path, and replacing it with an identical
  // one is the bias the patience ladder exists to remove.
  clock.t += 3_000;
  link.connect({ immediate: true });
  assert.equal(dials, 1, 'an immediate connect killed a dial still inside its first rung');

  clock.t += 1_500;
  link.connect({ immediate: true });
  assert.equal(dials, 2, 'an immediate connect waited out a dial that had had its allowance');
  // And it is not counted as evidence: nothing failed, somebody just asked.
  assert.equal(link.stats.dialsFailed, 0, 'a superseded dial was counted as a failure');
  assert.equal(link.dialTimeoutMs, 4_000, 'a superseded dial widened the patience ladder');
});

test('a socket that HAS answered is not demoted by a later bad frame on it', () => {
  const { link, mux } = makeLink();
  const reasons: MuxUnsupportedReason[] = [];
  link.onUnsupported((reason) => reasons.push(reason));
  link.subscribe('_tree', collector());
  link.connect();

  // One good frame is the proof, and it is proof about THIS socket.
  mux.sockets[0].push('_tree', bytes(0, 0));
  assert.equal(link.unsupportedReason, null);

  mux.sockets[0].onmessage?.({ data: bytes(0xff, 0xff, 0xff) });
  assert.deepEqual(reasons, [], 'a peer that answered was demoted by one bad frame');
  assert.equal(link.unsupportedReason, null);
  assert.equal(link.connected, true, 'a stray bad message dropped a healthy socket');
});

test('the latch is PER SOCKET: a server replaced underneath a reconnect is judged again', () => {
  // ⚠ MEASURED, and the reason the latch moved. Against real processes: a current
  // server, then stopped, then a pre-P3 server started on the SAME port and the
  // SAME data dir. With a link-wide latch the ladder reconnected in 180 ms, the
  // client stayed in mux mode, `unsupportedReason` stayed null, no notice fired,
  // `whenSynced(15000)` was false and the post-swap edit never reached the
  // server — silently, until Obsidian was restarted. A latch cannot tell a flaky
  // reconnect from a different process on the other end; judging each socket on
  // what IT says can.
  const { link, mux, fire } = makeLink();
  const reasons: MuxUnsupportedReason[] = [];
  link.onUnsupported((reason) => reasons.push(reason));
  link.subscribe('_tree', collector());
  link.connect();

  mux.sockets[0].push('_tree', bytes(0, 0));
  assert.equal(link.unsupportedReason, null, 'a peer that framed correctly was condemned');

  // The server goes away and something that does NOT speak the protocol comes
  // back on the same address.
  mux.dropSockets();
  fire();
  assert.equal(link.connected, true, 'the ladder never reconnected');
  mux.sockets[1].onmessage?.({ data: bytes(0xff, 0xff, 0xff) });

  assert.deepEqual(reasons, ['not-a-frame'], 'the replacement server was never examined');
  assert.equal(link.connected, false, 'the link stayed on a peer that cannot serve it');
});

test('a fallback registered after the verdict still runs — a tick late is not never', async () => {
  const { link } = makeLegacyLink();
  link.subscribe('_tree', collector());
  link.connect();
  await Promise.resolve();
  assert.equal(link.unsupportedReason, 'not-a-frame');

  const late: MuxUnsupportedReason[] = [];
  link.onUnsupported((reason) => late.push(reason));
  assert.deepEqual(late, ['not-a-frame']);
});

test('the verdict fires at most once, however many bad messages follow', async () => {
  const { link, mux, reasons } = makeLegacyLink();
  link.subscribe('_tree', collector());
  link.connect();
  await Promise.resolve();
  mux.sockets[0].onmessage?.({ data: bytes(0xff) });
  mux.sockets[0].onmessage?.({ data: bytes(0xff) });
  assert.equal(reasons.length, 1);
});


// ---------------------------------------------------------------- transport hygiene

test('a socket handed over already open is still opened — no handshake is lost', () => {
  // `FakeMux`'s default mode. The `readyState === OPEN` branch in `open()` is
  // what covers a transport that never fires `onopen`, and without it a link
  // would sit connected and silent forever.
  const { link } = makeLink();
  const room = collector();
  link.subscribe('_tree', room);
  link.connect();
  assert.equal(room.opens, 1);
});

test('a socket that opens on a later turn fires the same handshake', async () => {
  const mux = new FakeMux({ openMode: 'deferred' });
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    openSocket: mux.openSocket,
  });
  const room = collector();
  link.subscribe('_tree', room);
  link.connect();
  assert.equal(room.opens, 0, 'the room handshook before the socket was open');
  await Promise.resolve();
  assert.equal(room.opens, 1, 'the room never handshook when onopen fired');
});

test('a send while the link is down is refused and counted, never queued silently', () => {
  const { link } = makeLink();
  link.subscribe('_tree', collector());
  assert.equal(link.send('_tree', bytes(1)), false);
  assert.equal(link.stats.droppedOutbound, 1);
});

test('destroy releases the rooms and the socket, and a later frame reaches nothing', () => {
  const { link, mux } = makeLink();
  const room = collector();
  link.subscribe('_tree', room);
  link.connect();
  const socket = mux.sockets[0];
  link.destroy();

  assert.equal(link.roomCount, 0);
  assert.equal(socket.readyState, 3, 'destroy left the socket open');
  socket.onmessage?.({ data: encodeMuxFrame('_tree', bytes(1)) });
  assert.equal(room.payloads.length, 0, 'a destroyed link still delivered');
});

/** A transport that accepts everything and answers nothing. */
/** A dial that is accepted at TCP and whose upgrade is never answered. */
function hangingSocket(): MuxSocket {
  return { ...silentSocket(), readyState: 0 };
}

function silentSocket(): MuxSocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    binaryType: '',
    send: () => undefined,
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

test('the codec agrees with lib0 written by hand — the wire is not our own dialect', () => {
  // A second, independent encoding of the same frame. If `encodeMuxFrame` ever
  // grew a header or a version byte, the server would still decode it (it uses
  // its own copy) and every test above would pass; this is what would not.
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, 'n_x');
  encoding.writeVarUint8Array(enc, bytes(4, 5, 6));
  assert.deepEqual([...encodeMuxFrame('n_x', bytes(4, 5, 6))], [...encoding.toUint8Array(enc)]);
});

// ---------------------------------------------------------------- liveness

/**
 * A socket whose readyState never leaves OPEN however dead the path is, plus a
 * hand-driven clock.
 *
 * ⚠ This is the shape the whole section is about, and it is not hypothetical: a
 * dropped NAT flow, a slept laptop and a wifi handover all stop the bytes without
 * a FIN or an RST, and `readyState` has no way to say so. Measured through a TCP
 * proxy that stops forwarding in both directions: a `WebsocketProvider` on the
 * frozen path dropped its socket at 30,266 ms; a link with no watchdog reported
 * `connected` and `synced` for the whole 78 s the probe watched.
 */
function livenessLink(over: Partial<MuxLinkConfig> = {}): {
  link: MuxLink;
  timers: Array<{ fn: () => void; ms: number } | undefined>;
  sockets: Array<MuxSocket & { closes: number }>;
  tick: (ms: number) => void;
} {
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const clock = { t: 1_000_000 };
  const sockets: Array<MuxSocket & { closes: number }> = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    connectTimeoutMs: 0,
    random: () => 0.5,
    now: () => clock.t,
    openSocket: () => {
      const socket = { ...silentSocket(), closes: 0 };
      socket.close = (): void => {
        socket.closes += 1;
        socket.readyState = 3;
        socket.onclose?.({});
      };
      sockets.push(socket);
      return socket;
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
    ...over,
  });
  /** Advance the clock and run whatever is due, once. */
  const tick = (ms: number): void => {
    clock.t += ms;
    const due = timers.splice(0).filter((t) => t !== undefined);
    for (const timer of due) timer?.fn();
  };
  return { link, timers, sockets, tick };
}

test('a socket that is OPEN and dead is closed, and the ladder brings the link back', () => {
  const { link, sockets, tick } = livenessLink({ idleTimeoutMs: 30_000 });
  link.subscribe('_tree', { onPayload: () => undefined });
  link.connect();
  assert.equal(link.connected, true);

  // Nothing arrives, ever. Ten polls of three seconds each is the timeout.
  for (let i = 0; i < 10; i++) tick(3_000);

  assert.equal(sockets[0]?.closes, 1, 'a dead-but-open socket was never closed');
  assert.equal(link.stats.idleClosures, 1);
  assert.equal(link.connected, false, 'the link still called a dead socket connected');

  tick(1_000);                                   // the retry rung
  assert.equal(sockets.length, 2, 'the ladder never redialled after the watchdog fired');
  assert.equal(link.connected, true);
});

test('bytes arriving reset the watchdog — a busy link is never closed', () => {
  const { link, sockets, tick } = livenessLink({ idleTimeoutMs: 30_000 });
  link.subscribe('_tree', { onPayload: () => undefined });
  link.connect();

  // A frame every twelve seconds, which is FASTER than the heartbeat a real idle
  // link already gets: measured against the real server, an idle mux link
  // received an awareness echo every 15.03 s, six times in 95 s.
  for (let i = 0; i < 12; i++) {
    tick(3_000);
    if (i % 4 === 3) sockets[0]?.onmessage?.({ data: encodeMuxFrame('_tree', bytes(1)) });
  }
  assert.equal(sockets[0]?.closes, 0, 'a link receiving frames was closed as dead');
  assert.equal(link.connected, true);
});

test('at half the idle timeout the link asks ONE room to provoke an answer', () => {
  const { link, tick } = livenessLink({ idleTimeoutMs: 30_000 });
  const probes: string[] = [];
  for (const room of ['n_a', 'n_b']) {
    link.subscribe(room, { onPayload: () => undefined, onProbe: () => probes.push(room) });
  }
  link.connect();

  // Below half: nothing is owed.
  for (let i = 0; i < 4; i++) tick(3_000);
  assert.deepEqual(probes, [], 'the link nagged a peer that had not gone quiet');

  // Past half: ONE room per poll, rotating, so a single room the server has
  // stopped serving can neither mask a live link nor condemn one.
  tick(3_000);
  tick(3_000);
  assert.deepEqual(probes, ['n_b', 'n_a'], 'the probe did not rotate across rooms');
});

test('a dial that HANGS is a failed attempt, not a link parked forever', () => {
  // ⚠ `open()` assigns `this.socket` before the socket opens and `connect()`
  // refuses to dial while one exists, so a TCP connection accepted with the HTTP
  // upgrade never answered used to park the link with no timer armed at all.
  // Measured against a black-holed upgrade: one dial, zero timers, still one dial
  // forty-five seconds later.
  const connecting: MuxSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    idleTimeoutMs: 0,
    connectTimeoutMs: 4_000,
    random: () => 0.5,
    openSocket: () => {
      const socket = { ...silentSocket(), readyState: 0 };     // CONNECTING, forever
      connecting.push(socket);
      return socket;
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  /** Take everything armed since the last call, and run it. */
  const drain = (): Array<{ fn: () => void; ms: number }> => {
    const due = timers.splice(0).filter((t) => t !== undefined);
    for (const timer of due) timer.fn();
    return due;
  };

  link.subscribe('_tree', { onPayload: () => undefined });
  link.connect();
  assert.equal(connecting.length, 1);

  const armed = timers.filter((t) => t !== undefined);
  assert.equal(armed.length, 1, 'a dial in flight armed no connect timeout');
  assert.equal(armed[0]?.ms, 4_000);
  drain();

  assert.equal(link.stats.dialsFailed, 1, 'a hung dial was not counted as a failure');
  const retry = timers.filter((t) => t !== undefined);
  assert.equal(retry.length, 1, 'a hung dial armed no retry');
  assert.equal(retry[0]?.ms, MUX_RECONNECT_BACKOFF_MS[0]);
  drain();
  assert.equal(connecting.length, 2, 'the ladder never redialled past a hung dial');
});

test('connect({ immediate }) jumps a waiting rung; a plain connect() still does not', () => {
  // The rung protects the RETRY LOOP from hammering a server that is down. It is
  // not a reason to make a person wait: measured against a real 30-second outage,
  // resync took 52,703 ms before this existed and 5 ms after, on the path
  // `Bootstrap.connectTree` takes.
  const { link, mux, timers } = makeLink();
  link.subscribe('_tree', collector());
  link.connect();
  mux.dropSockets();
  const dialled = mux.sockets.length;
  assert.equal(timers.filter((t) => t !== undefined).length, 1);

  link.connect();
  assert.equal(mux.sockets.length, dialled, 'a plain connect() jumped the queue');

  link.connect({ immediate: true });
  assert.equal(mux.sockets.length, dialled + 1, 'an immediate connect() waited out the rung');
  assert.equal(link.connected, true);
  assert.equal(timers.filter((t) => t !== undefined).length, 0,
    'the rung was left armed beside a socket that is already up');
});

test('recycle() throws the socket away and the ladder dials a fresh one', () => {
  const { link, mux, timers, fire } = makeLink();
  link.subscribe('_tree', collector());
  link.connect();
  const first = mux.sockets.length;

  link.recycle();
  assert.equal(link.stats.recycles, 1);
  assert.equal(link.connected, false, 'recycle left the old socket in place');
  assert.equal(timers.filter((t) => t !== undefined).length, 1, 'recycle armed no retry');
  fire();
  assert.equal(mux.sockets.length, first + 1, 'recycle never produced a new socket');
  assert.equal(link.connected, true);
});

// ---------------------------------------------------------------- unreachable

test('dials that never OPEN are reported, and an open socket clears the count', () => {
  // ⚠ The evidence no other route into the verdict can carry: `onClose` and the
  // detect timer both need a socket that OPENED, so a refused or black-holed
  // `/_mux` upgrade reached nothing at all. Measured against a real server behind
  // a proxy answering 404 on `/_mux`: `whenSynced(15000)` false, verdict empty,
  // notice never shown, and the link dialling for ever — while a plain per-room
  // client on the same path synced.
  const { link, mux, fire } = makeLink({ unreachableDials: 2 });
  let reports = 0;
  link.onUnreachable(() => { reports += 1; });
  link.subscribe('_tree', collector());
  mux.refuseConnect = true;
  link.connect();

  assert.equal(reports, 0, 'one failed dial is not evidence of anything');
  fire();
  assert.equal(reports, 1, 'two failed dials in a row were not reported');
  fire();
  assert.equal(reports, 2, 'the report stopped repeating while the dials kept failing');

  // ⚠ And it is NOT a verdict. A server that is merely down fails dials in
  // exactly this shape, so the link keeps its ladder and stays usable.
  assert.equal(link.unsupportedReason, null, 'failed dials condemned the server on their own');
  mux.refuseConnect = false;
  fire();
  assert.equal(link.connected, true);
  const settled = reports;
  mux.dropSockets();
  fire();
  assert.equal(reports, settled, 'an open socket did not clear the consecutive count');
});

test('markUnsupported is the one way in from outside, and it tears the link down', () => {
  const { link, mux } = makeLink();
  const reasons: MuxUnsupportedReason[] = [];
  link.onUnsupported((reason) => reasons.push(reason));
  link.subscribe('_tree', collector());
  link.connect();
  // The peer HAS framed correctly; an external verdict is about the ROUTE, not
  // about what this socket said, so the per-socket latch must not veto it.
  mux.sockets[0]?.push('_tree', bytes(0, 0));

  link.markUnsupported('unreachable');
  assert.deepEqual(reasons, ['unreachable']);
  assert.equal(link.unsupportedReason, 'unreachable');
  assert.equal(link.connected, false, 'the link stayed up after an external verdict');
  link.connect();
  assert.equal(mux.sockets.length, 1, 'connect() re-dialled a route already known to be dead');
});

test('a close on a socket that never OPENED is a failed dial; one that opened is not', () => {
  // ⚠ This is the exact shape a refused `/_mux` upgrade has, and the only one:
  // the TCP connection is made, the HTTP upgrade is answered with a 404, and the
  // socket closes without ever reaching OPEN. A counter that read every close as
  // a failed dial would report an ordinary dropped connection as an unreachable
  // route; one that read none of them would never see a refused upgrade at all,
  // which is where this started.
  const made: Array<MuxSocket & { fire: (event: 'open' | 'close') => void }> = [];
  const timers: Array<{ fn: () => void; ms: number } | undefined> = [];
  const link = new MuxLink({
    serverUrl: 'ws://host:1234',
    serverKey: KEY,
    workspaceId: WORKSPACE,
    idleTimeoutMs: 0,
    connectTimeoutMs: 0,
    unreachableDials: 2,
    random: () => 0.5,
    openSocket: () => {
      const socket = { ...silentSocket(), readyState: 0 };
      const handle = Object.assign(socket, {
        fire: (event: 'open' | 'close'): void => {
          if (event === 'open') { socket.readyState = 1; socket.onopen?.({}); }
          else { socket.readyState = 3; socket.onclose?.({}); }
        },
      });
      made.push(handle);
      return handle;
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (handle) => { timers[handle as number] = undefined; },
  });
  let reports = 0;
  link.onUnreachable(() => { reports += 1; });
  const drain = (): void => {
    const due = timers.splice(0).filter((t) => t !== undefined);
    for (const timer of due) timer.fn();
  };

  link.subscribe('_tree', { onPayload: () => undefined });
  link.connect();

  // A socket that OPENED and then dropped is an ordinary disconnection.
  made[0]?.fire('open');
  made[0]?.fire('close');
  assert.equal(link.stats.dialsFailed, 0, 'a dropped connection was counted as a failed dial');
  drain();

  // Two that never opened at all: that is a route, not a connection.
  made[1]?.fire('close');
  assert.equal(link.stats.dialsFailed, 1);
  assert.equal(reports, 0, 'one refused upgrade was treated as evidence on its own');
  drain();
  made[2]?.fire('close');
  assert.equal(link.stats.dialsFailed, 2);
  assert.equal(reports, 1, 'a route that will not open was never reported');

  // And an open clears the count, so an outage cannot accumulate into a verdict.
  drain();
  made[3]?.fire('open');
  drain();
  made[3]?.fire('close');
  assert.equal(link.stats.dialsFailed, 2, 'a dropped connection was counted after all');
  drain();
  made[4]?.fire('close');
  assert.equal(reports, 1, 'the consecutive count survived a socket that opened');
});
