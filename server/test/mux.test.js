// server/test/mux.test.js
// The `_mux` endpoint (P3 spec §4, slice 1).
//
// Four groups, in the order the risk actually runs:
//   A. framing and the route          — what a well-behaved client gets
//   B. the security core              — per-FRAME validation and the workspace
//   C. resource bounds                — the cap, backpressure, fan-out, containment
//   D. the prototype's four phases    — seed / cold storm / warm reconnect / live delta
//   E. the mixed fleet                — a mux client and a legacy client on one room
//
// Group B is the reason this file is long. A mux socket is a capability
// amplifier: one authentication unlocks many rooms, so the check that used to
// run once per connection has to run once per frame, and it has to be the SAME
// check. "The same check" is not asserted by reading the two call sites; it is
// asserted by running a table of hostile names through both of them and
// requiring the two verdicts to agree, name by name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as Y from 'yjs';
import {
  attachMux, encodeMuxFrame, decodeMuxFrame, MUX_DOC_ID,
  MUX_MAX_ROOMS_PER_SOCKET, MUX_MAX_BUFFERED_BYTES, MUX_BACKPRESSURE_GRACE_MS,
} from '../mux.js';
import { authorizeUpgrade, isValidDocId } from '../upgradeAuth.js';
import {
  FakeSocket, FlakyHub, MuxClient, RoomClient, startMuxHub,
  syncPayload, awarenessPayload, updateFor, textOfUpdate,
  SYNC, EMPTY_SV, sleep, until,
} from './harness/mux.mjs';

/**
 * How many rooms the four phases use. The measured prototype ran 2,000; the
 * suite runs a smaller number so `npm test` stays a unit suite, and the same
 * file reproduces the full 2,000-room measurement with
 * `SL_MUX_ROOMS=2000 node --test server/test/mux.test.js`.
 */
const ROOMS = Number(process.env.SL_MUX_ROOMS ?? 250);
const NODE_ID = 'AbCdEfGhIjKlMnOpQrStUv';          // 22 chars, a real nodeId shape
const roomName = (i) => `n_${String(i).padStart(6, '0')}`;
const noteText = (i) => `# Note ${i}\n\n${'lorem ipsum dolor sit amet '.repeat(40)}\n`;

// ============================================================ A. framing

test('a frame creates one virtual connection, lazily, scoped to the upgrade workspace', () => {
  const ws = new FakeSocket();
  const hub = new FlakyHub();
  const mux = attachMux(ws, { hub, workspaceId: 'w1' });

  assert.equal(mux.roomCount, 0, 'a socket with no frames opened a room');
  assert.deepEqual(hub.docNames, [], 'the hub was touched before any frame arrived');

  ws.deliver('_tree', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  assert.deepEqual(hub.docNames, ['w1/_tree']);
  assert.equal(mux.roomCount, 1);

  // A second frame for the same room reuses the connection.
  ws.deliver('_tree', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  assert.deepEqual(hub.docNames, ['w1/_tree'], 'the room was opened twice');
  assert.equal(mux.stats.roomsOpened, 1);

  // A different room is a different connection and a different document.
  ws.deliver(`n_${NODE_ID}`, syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  assert.deepEqual(hub.docNames, ['w1/_tree', `w1/n_${NODE_ID}`]);
  assert.equal(mux.roomCount, 2);
  assert.deepEqual(mux.roomNames(), [`n_${NODE_ID}`, '_tree'].sort());
});

test('the payload crosses the mux byte-identical, in both directions, and is never parsed', () => {
  const ws = new FakeSocket();
  const hub = new FlakyHub();
  attachMux(ws, { hub, workspaceId: 'w1' });

  // Three payload shapes: a sync message, an awareness message, and bytes that
  // are neither. The server is doc-agnostic — it must relay all three the same.
  const sync = syncPayload(SYNC.SYNC_UPDATE, updateFor('hello'));
  const aware = awarenessPayload(Uint8Array.from([9, 8, 7, 6]));
  const nonsense = Uint8Array.from([0xff, 0x00, 0x42, 0xff, 0xff, 0xff, 0xff]);

  for (const payload of [sync, aware, nonsense]) ws.deliver('r1', payload);

  const received = hub.connections.get('w1/r1').received;
  assert.equal(received.length, 3, 'the mux did not deliver every payload');
  assert.deepEqual(Uint8Array.from(received[0]), sync);
  assert.deepEqual(Uint8Array.from(received[1]), aware, 'awareness was interpreted');
  assert.deepEqual(Uint8Array.from(received[2]), nonsense, 'an opaque payload was filtered');

  // Server → client: the room prefix is added, the payload is untouched.
  const out = Uint8Array.from([1, 2, 3, 250, 251, 252]);
  hub.push('w1/r1', out);
  const frames = ws.framesFor('r1');
  assert.deepEqual(frames[frames.length - 1].payload, out);
  // ...and the frame really is `varString(room) + varUint8Array(payload)`.
  assert.deepEqual(
    ws.sentRaw[ws.sentRaw.length - 1], encodeMuxFrame('r1', out),
    'the wire frame is not the documented shape',
  );
});

test('the frame codec round-trips a room at the charset and length limits', () => {
  const maxRoom = 'a'.repeat(300);
  const payload = Uint8Array.from({ length: 1024 }, (_, i) => i & 0xff);
  const { room, payload: back } = decodeMuxFrame(encodeMuxFrame(maxRoom, payload));
  assert.equal(room, maxRoom);
  assert.deepEqual(back, payload);
  assert.equal(isValidDocId(maxRoom), true, '300 characters is inside DOC_RE');
  assert.equal(isValidDocId('a'.repeat(301)), false, '301 characters is outside DOC_RE');
});

// ============================================================ B. security core

/**
 * The names a hostile client would try. Each one either escapes the snapshot
 * directory, escapes the workspace, or is simply not a name — and each one must
 * be refused by BOTH the upgrade route and the mux, identically.
 */
const HOSTILE_ROOMS = [
  '',                                  // no name at all
  '..',                                // the parent directory
  '../../etc/passwd',                  // traversal
  '..%2f..%2fetc',                     // traversal, pre-encoded
  'w2/n_secret',                       // a room in ANOTHER workspace, smuggled
  '/absolute',
  'C:\\Windows\\system32',
  'a.b',                               // a dot is a filename extension
  'a b',                               // a space
  'a\u0000b',                          // NUL
  'a\nb',
  'ünïcode',
  '\ud83d\ude00',                      // an emoji (a surrogate pair)
  '\ud800',                            // a LONE surrogate
  'a'.repeat(301),                     // one past DOC_RE's length
  '.',
  '_mux/../_tree',
];

const LEGITIMATE_ROOMS = ['_tree', `n_${NODE_ID}`, MUX_DOC_ID, 'a', 'a'.repeat(300), 'A-b_C9'];

test('per-frame validation refuses every hostile room name, and opens every legitimate one', () => {
  const ws = new FakeSocket();
  const hub = new FlakyHub();
  const mux = attachMux(ws, { hub, workspaceId: 'w1' });

  for (const room of HOSTILE_ROOMS) ws.deliver(room, syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  assert.deepEqual(hub.docNames, [], `a hostile room reached the hub: ${hub.docNames}`);
  assert.equal(mux.roomCount, 0);
  assert.equal(
    mux.stats.dropped.badRoom, HOSTILE_ROOMS.length,
    'a hostile name was dropped for some other reason, or not dropped at all',
  );

  for (const room of LEGITIMATE_ROOMS) ws.deliver(room, syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  assert.deepEqual(
    hub.docNames.sort(), LEGITIMATE_ROOMS.map((r) => `w1/${r}`).sort(),
    'a legitimate room was refused',
  );
});

test('the per-frame check IS the upgrade check — same verdict, name by name', () => {
  const validKey = (k) => k === 'sk_good';

  // ⚠ Found by running this, not by reading it: the WHATWG URL parser DELETES
  // tab, CR and LF from its input before `authorizeUpgrade` sees a path at all.
  // So a URL cannot express every name a frame can, and the two routes cannot be
  // compared on the raw string alone — the upgrade route is comparing the
  // predicate against a name the transport already rewrote.
  const stripped = authorizeUpgrade('/a\nb?t=sk_good&w=w1', validKey);
  assert.equal(stripped.ok, true);
  assert.equal(stripped.docId, 'ab', 'the URL parser stopped stripping control characters');

  // The property that actually matters, stated over both routes: NEITHER can
  // produce a docName the shared predicate would refuse, and the mux — which
  // has no normalizing transport in front of it — applies that predicate
  // exactly, so it is never the looser of the two.
  for (const room of [...HOSTILE_ROOMS, ...LEGITIMATE_ROOMS]) {
    const ws = new FakeSocket();
    const hub = new FlakyHub();
    attachMux(ws, { hub, workspaceId: 'w1' });
    ws.deliver(room, syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
    const muxAccepted = hub.docNames.length === 1;

    assert.equal(
      muxAccepted, isValidDocId(room),
      `the mux does not apply the shared predicate to ${JSON.stringify(room)}`,
    );

    let result;
    try {
      result = authorizeUpgrade(`/${room}?t=sk_good&w=w1`, validKey);
    } catch {
      result = { ok: false };                   // an unconstructible URL is a refusal
    }
    if (result.ok) {
      assert.equal(
        isValidDocId(result.docId), true,
        `the upgrade route accepted an unsafe docId for ${JSON.stringify(room)}`,
      );
      // Where the transport passed the name through untouched, the two routes
      // must agree on it name for name.
      if (result.docId === room) {
        assert.equal(
          muxAccepted, true,
          `the upgrade accepts ${JSON.stringify(room)} verbatim and the mux does not`,
        );
      }
    }
  }
});

test('a frame cannot name a workspace: the docName is always the upgrade\'s', () => {
  const ws = new FakeSocket();
  const hub = new FlakyHub();
  const mux = attachMux(ws, { hub, workspaceId: 'victim' });

  // The direct attempt: a slash-bearing room. Refused by charset.
  ws.deliver('attacker/n_secret', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  // The indirect attempt: a room name that IS another workspace's room name.
  // It is accepted — as a room in THIS workspace, which is the whole point.
  ws.deliver('n_secret', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));

  assert.deepEqual(hub.docNames, ['victim/n_secret']);
  assert.equal(mux.docNameFor('n_secret'), 'victim/n_secret');
  assert.ok(
    !hub.docNames.some((n) => n.startsWith('attacker/')),
    'a frame reached another workspace',
  );
});

test('two mux sockets in different workspaces share a room NAME and no bytes', async () => {
  const server = await startMuxHub();
  const room = `n_${NODE_ID}`;
  const a = new MuxClient(server.muxUrl('wsA'));
  const b = new MuxClient(server.muxUrl('wsB'));
  try {
    await a.connect();
    await b.connect();
    await a.syncAll([room]);
    await b.syncAll([room]);

    a.pushUpdate(room, updateFor('workspace A only'));
    await sleep(150);

    assert.equal(a.textOf(room), 'workspace A only');
    assert.equal(b.textOf(room), '', 'the update crossed a workspace boundary');
    assert.equal(server.hub.getText('wsA/' + room), 'workspace A only');
    assert.equal(server.hub.getText('wsB/' + room), '');
  } finally {
    a.abort();
    b.abort();
    await server.stop();
  }
});

test('a malformed frame is dropped, and the rooms already on the socket keep working', () => {
  const ws = new FakeSocket();
  const hub = new FlakyHub();
  const mux = attachMux(ws, { hub, workspaceId: 'w1' });

  ws.deliver('r1', syncPayload(SYNC.SYNC_UPDATE, updateFor('before')));

  // Empty; a varString length that runs off the end; a varString with no
  // varUint8Array after it; and a length prefix that promises more than it has.
  ws.deliverRaw(Uint8Array.from([]));
  ws.deliverRaw(Uint8Array.from([0x7f]));
  ws.deliverRaw(Uint8Array.from([0x02, 0x72, 0x31]));
  ws.deliverRaw(Uint8Array.from([0x02, 0x72, 0x31, 0x40, 0x01]));

  assert.equal(mux.stats.dropped.malformed, 4, 'a malformed frame was not counted as one');
  assert.equal(mux.roomCount, 1, 'a malformed frame opened a room');

  // The socket is still carrying r1.
  ws.deliver('r1', syncPayload(SYNC.SYNC_UPDATE, updateFor('after')));
  assert.equal(hub.connections.get('w1/r1').received.length, 2);
});

test('a frame arriving after the socket closed resurrects nothing', () => {
  const ws = new FakeSocket();
  const hub = new FlakyHub();
  const mux = attachMux(ws, { hub, workspaceId: 'w1' });

  ws.deliver('r1', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  assert.equal(mux.roomCount, 1);

  ws.close();
  assert.equal(mux.roomCount, 0, 'the close fan-out left a room behind');
  assert.equal(hub.connections.get('w1/r1').closed, true);
  const deliveredBeforeClose = hub.connections.get('w1/r1').received.length;

  // The late frame — for the room that just closed, and for a new one.
  ws.deliver('r1', syncPayload(SYNC.SYNC_UPDATE, updateFor('too late')));
  ws.deliver('r2', syncPayload(SYNC.SYNC_UPDATE, updateFor('too late')));
  assert.equal(mux.roomCount, 0, 'a frame after close opened a room');
  assert.deepEqual(hub.docNames, ['w1/r1'], 'a frame after close reached the hub');
  assert.equal(mux.stats.dropped.afterClose, 2);
  assert.equal(
    hub.connections.get('w1/r1').received.length, deliveredBeforeClose,
    'a room that had already been closed and flushed was written to afterwards',
  );
});

test('a mux upgrade with a wrong key never reaches a frame', async () => {
  const server = await startMuxHub();
  try {
    const bad = new MuxClient(server.muxUrl('w1', 'sk_wrong'));
    assert.equal(await bad.tryConnect(), 'rejected');
    assert.equal(server.refused.length, 1);
    assert.equal(server.refused[0].code, 401);
    assert.equal(server.muxes.length, 0, 'a mux was attached to an unauthenticated socket');

    const good = new MuxClient(server.muxUrl('w1'));
    assert.equal(await good.tryConnect(), 'accepted');
    good.abort();
  } finally {
    await server.stop();
  }
});

// ============================================================ C. resource bounds

test('MUX_MAX_ROOMS_PER_SOCKET caps new rooms and leaves the open ones alone', () => {
  const ws = new FakeSocket();
  const hub = new FlakyHub();
  const mux = attachMux(ws, { hub, workspaceId: 'w1', maxRooms: 4 });

  for (let i = 0; i < 10; i++) ws.deliver(`r${i}`, syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));

  assert.equal(mux.roomCount, 4, 'the cap did not hold');
  assert.equal(hub.docNames.length, 4);
  assert.equal(mux.stats.dropped.capped, 6);

  // A frame for a room already on the socket is unaffected by the cap.
  ws.deliver('r0', syncPayload(SYNC.SYNC_UPDATE, updateFor('still flowing')));
  assert.equal(hub.connections.get('w1/r0').received.length, 2);
  // And the socket is still open: a cap is a refusal, not a disconnect.
  assert.equal(ws.readyState, 1);
  assert.equal(ws.terminated, false);

  assert.equal(MUX_MAX_ROOMS_PER_SOCKET, 8_192, 'the shipped cap moved (spec §8.1)');
});

test('a socket that never reads is terminated once it has stayed over the ceiling', async () => {
  const ws = new FakeSocket();
  const hub = new FlakyHub();
  let clock = 1_000;
  // 1 KiB of buffer per send, a 4 KiB ceiling, a 10 s grace: the shipped policy
  // with small numbers and a clock the test owns.
  const mux = attachMux(ws, {
    hub, workspaceId: 'w1', maxBufferedBytes: 4096, backpressureGraceMs: 10_000, now: () => clock,
  });
  ws.bufferedPerSend = 1024;

  ws.deliver('r1', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));   // hub's Step1: 1 KiB
  for (let i = 0; i < 4; i++) hub.push('w1/r1', updateFor(`push ${i}`));

  // Over the ceiling — but only just now, so nothing happens yet. This is the
  // difference between "busy" and "gone", and it is the whole reason the policy
  // is a duration: a legitimate 2,000-room cold storm peaks at ~2 MB of buffer
  // and drains in under half a second.
  assert.equal(ws.bufferedAmount > 4096, true, 'the fixture never crossed the ceiling');
  assert.equal(mux.stats.overflowed, false, 'terminated on the first byte over the ceiling');
  assert.notEqual(mux.stats.overCeilingSince, null, 'the clock never started');

  clock += 9_000;
  hub.push('w1/r1', updateFor('still inside the grace'));
  assert.equal(mux.stats.overflowed, false, 'terminated inside the grace window');

  clock += 2_000;
  hub.push('w1/r1', updateFor('the one that crosses'));
  assert.equal(mux.stats.overflowed, true, 'backpressure never fired');
  assert.equal(ws.terminated, true, 'the socket was closed gracefully, which buffers more');

  // ⚠ The close must NOT be synchronous: it happens inside a DocHub broadcast
  // loop, and a synchronous fan-out would mutate `state.conns` mid-iteration.
  assert.equal(mux.roomCount, 1, 'the fan-out ran synchronously inside the broadcast');
  await sleep(0);
  assert.equal(mux.roomCount, 0, 'the fan-out never ran');
  assert.equal(hub.connections.get('w1/r1').closed, true);

  assert.equal(MUX_MAX_BUFFERED_BYTES, 32 * 1024 * 1024, 'the shipped ceiling moved');
  assert.equal(MUX_BACKPRESSURE_GRACE_MS, 60_000, 'the shipped grace moved');
});

test('a peer that goes over the ceiling and then DRAINS is never terminated', () => {
  // The case a pure size ceiling cannot tell from the hostile one, and the
  // reason the shipped policy is a duration: a big legitimate burst.
  const ws = new FakeSocket();
  const hub = new FlakyHub();
  let clock = 1_000;
  const mux = attachMux(ws, {
    hub, workspaceId: 'w1', maxBufferedBytes: 4096, backpressureGraceMs: 10_000, now: () => clock,
  });

  ws.deliver('r1', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  for (let burst = 0; burst < 5; burst++) {
    ws.bufferedAmount = 32_768;                       // a burst lands, far over
    hub.push('w1/r1', updateFor('burst'));
    clock += 30_000;                                  // three graces' worth of time
    ws.bufferedAmount = 0;                            // ...and the peer drained it
    hub.push('w1/r1', updateFor('drained'));
  }

  assert.equal(mux.stats.overflowed, false, 'a draining peer was terminated');
  assert.equal(ws.terminated, false);
  assert.equal(mux.stats.overCeilingSince, null, 'the over-ceiling clock never reset');
  assert.equal(mux.stats.peakBufferedBytes, 32_768, 'the peak was not recorded');
});

test('backpressure fires on a REAL socket whose peer stopped reading', async () => {
  // 256 KiB and a 100 ms grace, so the test pushes megabytes rather than tens of
  // them and does not sit for a minute. Everything else is the shipped path:
  // a real `ws.bufferedAmount`, a real paused TCP socket, a real DocHub.
  const server = await startMuxHub({ maxBufferedBytes: 256 * 1024, backpressureGraceMs: 100 });
  const client = new MuxClient(server.muxUrl('w1'));
  try {
    await client.connect();
    await client.syncAll(['r1']);
    const mux = server.lastMux();

    client.stopReading();
    // A second peer that keeps typing into the room the silent one subscribed to.
    const writer = new MuxClient(server.muxUrl('w1'));
    await writer.connect();
    await writer.syncAll(['r1']);

    const doc = new Y.Doc();
    for (let i = 0; i < 400 && !mux.stats.overflowed; i++) {
      const sv = Y.encodeStateVector(doc);
      doc.getText('content').insert(0, 'x'.repeat(4096));
      writer.sendFrame('r1', syncPayload(SYNC.SYNC_UPDATE, Y.encodeStateAsUpdate(doc, sv)));
      await sleep(2);
    }
    doc.destroy();

    assert.equal(await until(() => mux.stats.overflowed, 3000), true, 'a silent peer was buffered without bound');
    assert.equal(await until(() => mux.roomCount === 0, 3000), true, 'the terminated socket never fanned out');

    // The room itself is untouched: the writer is still on it.
    assert.ok(server.hub.getText('w1/r1').length > 0, 'the room lost its content');
    writer.abort();
  } finally {
    client.abort();
    await server.stop();
  }
});

test('close fan-out fires every room, and DocHub flushes every one of them', async () => {
  const server = await startMuxHub({ persistDebounceMs: 60_000 });   // only a flush can write
  const rooms = Array.from({ length: 12 }, (_, i) => roomName(i));
  const client = new MuxClient(server.muxUrl('wf'));
  try {
    await client.connect();
    await client.syncAll(rooms);
    for (const [i, room] of rooms.entries()) client.pushUpdate(room, updateFor(`body ${i}`));
    await sleep(200);

    const mux = server.lastMux();
    assert.equal(mux.roomCount, rooms.length);
    const snapshotDir = join(server.dir, 'yjs', 'wf');
    assert.equal(existsSync(join(snapshotDir, `${rooms[0]}.bin`)), false, 'the debounce already wrote');

    client.abort();

    assert.equal(await until(() => server.lastMux().roomCount === 0, 3000), true, 'the fan-out never ran');
    // DocHub's flush-on-last-peer-left is async; it runs per room, untouched.
    const allWritten = await until(
      () => rooms.every((r) => existsSync(join(snapshotDir, `${r}.bin`))),
      5000,
    );
    assert.equal(allWritten, true, 'a room was not flushed when the socket dropped');

    for (const [i, room] of rooms.entries()) {
      assert.equal(server.hub.writeCount(`wf/${room}`) >= 1, true, `${room} was never written`);
      assert.equal(server.hub.getText(`wf/${room}`), `body ${i}`);
    }
  } finally {
    await server.stop();
  }
});

test('one room that refuses to open takes neither the socket nor the other rooms with it', () => {
  const ws = new FakeSocket();
  const hub = new FlakyHub({ failOn: ['poison'] });
  const mux = attachMux(ws, { hub, workspaceId: 'w1' });

  ws.deliver('before', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  ws.deliver('poison', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  ws.deliver('after', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));

  assert.equal(mux.stats.dropped.roomFailed, 1);
  assert.match(String(mux.stats.lastError?.message), /hub refuses w1\/poison/);
  assert.deepEqual(mux.roomNames(), ['after', 'before'], 'the failed room was left registered');
  assert.equal(ws.readyState, 1, 'one room\'s failure closed the socket');
  assert.equal(mux.stats.roomsOpened, 2);

  // Both healthy rooms still carry traffic.
  ws.deliver('before', syncPayload(SYNC.SYNC_UPDATE, updateFor('a')));
  ws.deliver('after', syncPayload(SYNC.SYNC_UPDATE, updateFor('b')));
  assert.equal(hub.connections.get('w1/before').received.length, 2);
  assert.equal(hub.connections.get('w1/after').received.length, 2);
});

test('one room that throws during the close fan-out does not strand the rest', () => {
  const ws = new FakeSocket();
  const hub = new FlakyHub({ failCloseOn: ['r1'] });
  const mux = attachMux(ws, { hub, workspaceId: 'w1' });

  for (const room of ['r0', 'r1', 'r2']) ws.deliver(room, syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
  assert.equal(mux.roomCount, 3);

  ws.close();

  assert.equal(mux.roomCount, 0);
  for (const room of ['r0', 'r1', 'r2']) {
    assert.equal(hub.connections.get(`w1/${room}`).closed, true, `${room} never saw its close`);
  }
  assert.match(String(mux.stats.lastError?.message), /close handler threw for w1\/r1/);
});

test('a corrupt snapshot fails one room on a REAL hub and the socket carries on', async () => {
  const server = await startMuxHub();
  try {
    // A truncated snapshot is what `Y.applyUpdate` throws on — the failure
    // DocHub's own comments describe, arriving through the mux's lazy open.
    const snapshot = join(server.dir, 'yjs', 'wc', 'n_corrupt.bin');
    mkdirSync(dirname(snapshot), { recursive: true });
    writeFileSync(snapshot, Buffer.from([0x01, 0x02, 0x03, 0xff, 0xfe]));

    const client = new MuxClient(server.muxUrl('wc'));
    await client.connect();
    await client.syncAll(['n_healthy']);
    client.sendFrame('n_corrupt', syncPayload(SYNC.SYNC_STEP1, EMPTY_SV));
    await sleep(150);

    const mux = server.lastMux();
    assert.equal(mux.stats.dropped.roomFailed, 1, 'the corrupt room did not fail, or failed silently');
    assert.deepEqual(mux.roomNames(), ['n_healthy']);
    assert.equal(client.connected, true, 'one bad room dropped the whole socket');

    // The healthy room still works, on the same socket, afterwards.
    client.pushUpdate('n_healthy', updateFor('unaffected'));
    assert.equal(await until(() => server.hub.getText('wc/n_healthy') === 'unaffected', 2000), true);
    client.abort();
  } finally {
    await server.stop();
  }
});

// ============================================================ D. the four phases

test(`the four phases: seed, cold storm, warm reconnect and a live delta over ${ROOMS} rooms on ONE socket`, async () => {
  const server = await startMuxHub({ persistDebounceMs: 60_000 });
  const rooms = Array.from({ length: ROOMS }, (_, i) => roomName(i));
  const url = server.muxUrl('phases');
  let seeder = null;
  let cold = null;
  let peer = null;

  try {
    // ---- phase 1: SEED. One socket, every room's initial update.
    seeder = new MuxClient(url, { name: 'seed' });
    await seeder.connect();
    const seedStart = performance.now();
    for (const [i, room] of rooms.entries()) seeder.ledger.set(room, updateFor(noteText(i)));
    await seeder.syncAll(rooms);
    for (const room of rooms) {
      seeder.sendFrame(room, syncPayload(SYNC.SYNC_UPDATE, seeder.ledger.get(room)));
    }
    const seeded = await until(
      () => rooms.every((r) => server.hub.docs.has(`phases/${r}`)
        && server.hub.getText(`phases/${r}`).length > 0),
      20_000,
    );
    const seedMs = performance.now() - seedStart;
    assert.equal(seeded, true, 'the seed never landed on every room');
    assert.equal(server.lastMux().roomCount, ROOMS, 'one socket did not carry every room');
    console.log(
      `      [seed]  ${ROOMS} rooms on ONE socket in ${seedMs.toFixed(0)} ms, `
      + `up ${(seeder.bytesOut / 1024 / 1024).toFixed(2)} MB`,
    );
    seeder.abort();
    seeder = null;
    await sleep(100);

    // ---- phase 2: COLD STORM. A client holding nothing, one socket, all rooms.
    cold = new MuxClient(url, { name: 'cold' });
    await cold.connect();
    const coldMux = server.lastMux();
    const coldStart = performance.now();
    await cold.syncAll(rooms);
    const coldMs = performance.now() - coldStart;

    let correct = 0;
    for (const [i, room] of rooms.entries()) if (cold.textOf(room) === noteText(i)) correct += 1;
    console.log(
      `      [cold]  ${ROOMS} rooms in ${coldMs.toFixed(0)} ms; `
      + `down ${(cold.bytesIn / 1024 / 1024).toFixed(2)} MB, up ${(cold.bytesOut / 1024 / 1024).toFixed(2)} MB; `
      + `texts byte-correct ${correct}/${ROOMS}`,
    );
    assert.equal(correct, ROOMS, `${ROOMS - correct} rooms decoded to the wrong text`);

    // ⚠ This is where `MUX_MAX_BUFFERED_BYTES` comes from. The cold storm is the
    // heaviest legitimate transfer the design budgets — every room's full state,
    // at once, on one socket — so its peak send buffer is the number the ceiling
    // has to clear. Measuring it here is what stops that constant from being a
    // number somebody liked the look of.
    const peak = coldMux.stats.peakBufferedBytes;
    console.log(
      `      [cold]  peak send buffer ${(peak / 1024).toFixed(1)} KB, `
      + `${(MUX_MAX_BUFFERED_BYTES / Math.max(peak, 1)).toFixed(1)}x under the `
      + `${MUX_MAX_BUFFERED_BYTES / 1024 / 1024} MiB ceiling, drained in ${coldMs.toFixed(0)} ms `
      + `against a ${MUX_BACKPRESSURE_GRACE_MS / 1000} s grace`,
    );
    assert.equal(coldMux.stats.overflowed, false, 'a legitimate cold storm tripped backpressure');
    // The ceiling alone is NOT what makes this safe — at 2,000 rooms the peak is
    // megabytes, and a history-heavy vault projects higher still. What makes it
    // safe is that the burst DRAINS: the grace never starts, or starts and is
    // reset long before it expires.
    assert.equal(
      coldMs < MUX_BACKPRESSURE_GRACE_MS, true,
      `the storm took ${coldMs.toFixed(0)} ms, which is not comfortably inside the `
      + `${MUX_BACKPRESSURE_GRACE_MS} ms grace`,
    );

    // The ledger is doc-free by construction, and it agrees with the doc-based
    // answer on every one of the three less-travelled APIs it now leans on.
    for (const room of [rooms[0], rooms[Math.floor(ROOMS / 2)], rooms[ROOMS - 1]]) {
      const blob = cold.ledger.get(room);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, blob);
      assert.deepEqual(
        Y.encodeStateVectorFromUpdate(blob), Y.encodeStateVector(doc),
        `${room}: the doc-free state vector disagrees with the hydrated one`,
      );
      assert.equal(
        textOfUpdate(Y.mergeUpdates([blob, blob])), textOfUpdate(blob),
        `${room}: merging a room's bytes with themselves changed the text`,
      );
      assert.equal(
        Y.diffUpdate(blob, Y.encodeStateVector(doc)).byteLength <= 2, true,
        `${room}: diffUpdate against our own state vector was not empty`,
      );
      doc.destroy();
    }

    // ---- phase 3: WARM RECONNECT. Same client, already holding the bytes.
    cold.close();
    await sleep(200);
    cold.resetCounters();
    await cold.connect();
    const warmStart = performance.now();
    await cold.syncAll(rooms);
    await sleep(100);
    const warmMs = performance.now() - warmStart;
    console.log(
      `      [warm]  ${ROOMS} rooms re-handshake in ${warmMs.toFixed(0)} ms; `
      + `down ${(cold.bytesIn / 1024).toFixed(1)} KB, up ${(cold.bytesOut / 1024).toFixed(1)} KB `
      + `(${(cold.bytesIn / ROOMS).toFixed(0)} B/room down, ${(cold.bytesOut / ROOMS).toFixed(0)} B/room up)`,
    );
    // The claim the whole design rests on: a warm reconnect is a handshake, not
    // a re-download. 200 B/room/direction is generous against the measured 44.
    assert.equal(
      cold.bytesIn / ROOMS < 200, true,
      `a warm reconnect cost ${(cold.bytesIn / ROOMS).toFixed(0)} B/room down — that is a re-download`,
    );
    assert.equal(cold.bytesOut / ROOMS < 200, true, 'a warm reconnect re-uploaded');
    for (const [i, room] of rooms.entries()) {
      assert.equal(cold.textOf(room), noteText(i), `${room} changed across the reconnect`);
    }

    // ---- phase 4: LIVE DELTA into an idle room nobody ever hydrated.
    const target = rooms[Math.floor(ROOMS / 2)];
    peer = new MuxClient(url, { name: 'peer' });
    await peer.connect();
    await peer.syncAll([target]);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, peer.ledger.get(target));
    const sv = Y.encodeStateVector(doc);
    doc.getText('content').insert(0, 'PEER-EDIT ');
    const delta = Y.encodeStateAsUpdate(doc, sv);
    doc.destroy();
    peer.pushUpdate(target, delta);

    const arrived = await until(() => cold.textOf(target).startsWith('PEER-EDIT '), 3000);
    console.log(`      [live]  a delta reached an idle, never-hydrated room: ${arrived}`);
    assert.equal(arrived, true, 'a live delta did not reach the idle room');
    // Only that room moved.
    for (const [i, room] of rooms.entries()) {
      if (room === target) continue;
      assert.equal(cold.textOf(room), noteText(i), `${room} moved when ${target} did`);
    }
  } finally {
    seeder?.abort();
    cold?.abort();
    peer?.abort();
    await server.stop();
  }
});

// ============================================================ E. mixed fleet

test('a mux client and a legacy per-room client converge on ONE room', async () => {
  // Spec §"Assumptions" item 10: this claim was inferred, not measured end to
  // end, and slice 1 was told to add exactly this test.
  const server = await startMuxHub();
  const room = `n_${NODE_ID}`;
  const mux = new MuxClient(server.muxUrl('mixed'));
  const legacy = new RoomClient(server.roomUrl(room, 'mixed'));
  try {
    await mux.connect();
    await legacy.connect();
    await mux.syncAll([room]);
    assert.equal(await legacy.waitFor(() => legacy.synced, 3000), true, 'the legacy client never synced');

    // Legacy writes; the mux client sees it, doc-free.
    legacy.insert('from the legacy socket');
    assert.equal(
      await until(() => mux.textOf(room) === 'from the legacy socket', 3000), true,
      `the mux client never saw the legacy edit (has ${JSON.stringify(mux.textOf(room))})`,
    );

    // The mux writes; the legacy client sees it.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, mux.ledger.get(room));
    const sv = Y.encodeStateVector(doc);
    doc.getText('content').insert(doc.getText('content').length, ' + from the mux');
    const delta = Y.encodeStateAsUpdate(doc, sv);
    doc.destroy();
    mux.pushUpdate(room, delta);

    const expected = 'from the legacy socket + from the mux';
    assert.equal(
      await legacy.waitFor(() => legacy.text === expected, 3000), true,
      `the legacy client never saw the mux edit (has ${JSON.stringify(legacy.text)})`,
    );
    assert.equal(mux.textOf(room), expected);
    assert.equal(server.hub.getText(`mixed/${room}`), expected);
  } finally {
    mux.abort();
    legacy.destroy();
    await server.stop();
  }
});

test('the legacy per-room route is untouched: `_mux` is only special at the upgrade', async () => {
  const server = await startMuxHub();
  try {
    // A client that has not been upgraded is served exactly as before...
    const legacy = new RoomClient(server.roomUrl('_tree', 'w1'));
    await legacy.connect();
    assert.equal(await legacy.waitFor(() => legacy.synced, 3000), true);
    legacy.insert('a legacy tree');
    assert.equal(await until(() => server.hub.getText('w1/_tree') === 'a legacy tree', 2000), true);
    assert.equal(server.muxes.length, 0, 'a per-room socket was handed to the mux');
    legacy.destroy();

    // ...and `_mux` on the PER-ROOM route is a room name, not a protocol switch,
    // only because the route branches on it. It is the docId that selects.
    assert.equal(isValidDocId(MUX_DOC_ID), true, '`_mux` stopped matching DOC_RE');
    assert.equal(
      authorizeUpgrade(`/${MUX_DOC_ID}?t=sk_harness&w=w1`, (k) => k === 'sk_harness').docName,
      `w1/${MUX_DOC_ID}`,
      'the upgrade route stopped producing a docName for `_mux` — the route is not additive',
    );
  } finally {
    await server.stop();
  }
});
