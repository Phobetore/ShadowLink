// src/sync/RoomRegistry.test.ts
// P3 slice 3. One refcounted `Y.Doc` per room, and the two ports that borrow it.
//
// ⚠ WHAT THE FAKE HAD TO BE ABLE TO SAY, because the last five defects in this
// project hid in what a double could not express (spec §7):
//
//  * WHICH DOCUMENT it was handed, per room, per open. Asserting
//    `leaseA.doc === leaseB.doc` only inspects what the CALLER was given; a
//    registry that built a second document and connected it to the same room name
//    would pass that and lose every byte written through the other one. The fake
//    records the identity of every document it is handed, so "two documents for
//    one room" is a thing the TRANSPORT can report rather than a thing the caller
//    is trusted not to have done.
//  * A CONNECTION THAT NEVER SYNCS, and one that syncs later. A registry whose
//    `synced` latched, or whose sync event did not survive a transport swap, is
//    otherwise indistinguishable from one that works — `waitSync` would simply
//    sit out its deadline and the caller would read the honest `false` it is
//    supposed to read on a genuine failure.
//  * A FLUSH THAT REFUSES. `flush`'s answer sets `s` on a node (I17), and a
//    default-confirming fake is how `ObsidianDocPort.flush` once survived being
//    mutated to `return true` with 354 tests passing.
//  * A CONNECTION DESTROYED UNDER A LIVE LEASE — the transport swap an old server
//    forces. Without a fake that counts opens and destroys per room, "the document
//    survived the swap" and "a second document was built for the swap" look the
//    same from outside.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import type * as awarenessProtocol from 'y-protocols/awareness';

import {
  RegistryDocPort, RegistryProviderPort, RoomRegistry,
  type RoomConnection, type RoomTransport,
} from './RoomRegistry.ts';

// ---------------------------------------------------------------- the fake

class FakeConnection implements RoomConnection {
  synced = false;
  destroyed = false;
  flushes = 0;
  flushConfirms = true;

  private readonly handlers = new Set<(isSynced: boolean) => void>();

  /**
   * Awareness updates this connection WOULD have put on the wire, each stamped
   * with whether the connection was still alive at the time.
   *
   * ⚠ THE STAMP IS THE POINT. Both real transports write awareness from a `doc`-
   * or `Awareness`-level update handler that goes away with the connection, so a
   * removal made after `destroy()` reaches no peer at all — it just mutates a
   * local object on its way to being thrown away. "The cursor left" and "the
   * cursor was deleted locally a moment too late" are indistinguishable without
   * this, and the second one is the shipped defect.
   */
  readonly awarenessOut: Array<
    { added: number[]; updated: number[]; removed: number[]; afterDestroy: boolean }
  > = [];

  private readonly onAwareness = (
    changes: { added: number[]; updated: number[]; removed: number[] },
  ): void => {
    this.awarenessOut.push({
      added: [...changes.added],
      updated: [...changes.updated],
      removed: [...changes.removed],
      afterDestroy: this.destroyed,
    });
  };

  constructor(
    readonly room: string,
    readonly doc: Y.Doc,
    readonly awareness: awarenessProtocol.Awareness,
  ) {
    this.awareness.on('update', this.onAwareness);
  }

  /** Removals of `clientID` this connection carried while it was still live. */
  departuresOf(clientID: number): number {
    return this.awarenessOut
      .filter((u) => !u.afterDestroy && u.removed.includes(clientID)).length;
  }

  /**
   * ARRIVALS of `clientID` — the other direction, and it needs its own counter for
   * the same reason `departuresOf` did. "The local object holds a `user` again"
   * and "a peer was told about it" are different sentences, and the second is the
   * one a reopened note failed: `setLocalStateField` against a null local state
   * mutates nothing, emits nothing, and leaves every assertion about the object
   * itself perfectly true.
   */
  arrivalsOf(clientID: number): number {
    return this.awarenessOut.filter((u) => !u.afterDestroy
      && (u.added.includes(clientID) || u.updated.includes(clientID))).length;
  }

  on(_event: 'sync', handler: (isSynced: boolean) => void): void {
    this.handlers.add(handler);
  }

  off(_event: 'sync', handler: (isSynced: boolean) => void): void {
    this.handlers.delete(handler);
  }

  async flush(ms: number): Promise<boolean> {
    this.flushes += 1;
    this.lastFlushMs = ms;
    return this.flushConfirms;
  }

  lastFlushMs = -1;

  destroy(): void {
    this.destroyed = true;
    this.handlers.clear();
    // The wire goes with the connection, which is why the ordering above matters.
    this.awareness.off('update', this.onAwareness);
  }

  /** A GENUINE handshake. Nothing else may set `synced` (I3/I4). */
  emitSync(): void {
    this.synced = true;
    for (const handler of [...this.handlers]) handler(true);
  }

  /** The link went down: current, then not. */
  emitDrop(): void {
    this.synced = false;
    for (const handler of [...this.handlers]) handler(false);
  }
}

/**
 * A transport that remembers every document it was ever handed, per room.
 *
 * `docsSeen` is the assertion that matters: it is the TRANSPORT's view, so a
 * registry that quietly built a second document for a room would be caught here
 * even if every lease it handed out looked self-consistent.
 */
class FakeTransport implements RoomTransport {
  readonly opened: FakeConnection[] = [];
  /**
   * Rooms this transport REFUSES to open, which is not a hypothetical: the
   * shipped `MuxLink.subscribe` throws on a room the link already holds.
   */
  readonly refuses = new Set<string>();
  private readonly docsPerRoom = new Map<string, Set<Y.Doc>>();
  private readonly awarenessPerRoom = new Map<string, Set<unknown>>();

  open(
    room: string,
    doc: Y.Doc,
    awareness: awarenessProtocol.Awareness,
  ): RoomConnection {
    if (this.refuses.has(room)) throw new Error(`${room} is already subscribed on this link`);
    let docs = this.docsPerRoom.get(room);
    if (docs === undefined) {
      docs = new Set<Y.Doc>();
      this.docsPerRoom.set(room, docs);
    }
    docs.add(doc);

    let seen = this.awarenessPerRoom.get(room);
    if (seen === undefined) {
      seen = new Set<unknown>();
      this.awarenessPerRoom.set(room, seen);
    }
    seen.add(awareness);

    const connection = new FakeConnection(room, doc, awareness);
    this.opened.push(connection);
    return connection;
  }

  /** How many DISTINCT documents this transport has ever been handed for `room`. */
  docsSeen(room: string): number {
    return this.docsPerRoom.get(room)?.size ?? 0;
  }

  /** How many DISTINCT `Awareness` objects, same question. */
  awarenessSeen(room: string): number {
    return this.awarenessPerRoom.get(room)?.size ?? 0;
  }

  forRoom(room: string): FakeConnection[] {
    return this.opened.filter((c) => c.room === room);
  }

  live(room: string): FakeConnection | undefined {
    return this.forRoom(room).filter((c) => !c.destroyed).at(-1);
  }
}

const ROOM = 'n_aaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'n_bbbbbbbbbbbbbbbbbbbbbb';

/** What `WorkspaceSession.doOpen` announces, in the shape it announces it. */
const ADA = { name: 'Ada', color: '#ff0000', colorLight: '#ff000033' };
const GRACE = { name: 'Grace', color: '#00ff00', colorLight: '#00ff0033' };

// ================================================================ refcounting

test('the same room asked for twice yields the SAME document', () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);

  const first = registry.acquire(ROOM);
  const second = registry.acquire(ROOM);

  assert.equal(first.doc, second.doc, 'one room, one document');
  assert.equal(transport.docsSeen(ROOM), 1, 'and the transport was handed exactly one');
  assert.equal(transport.forRoom(ROOM).length, 1, 'and asked to open it exactly once');
  assert.equal(registry.refs(ROOM), 2);
  assert.equal(registry.liveDocs(ROOM), 1);

  registry.destroy();
});

test('a write through one borrower is visible to the other, with no relay at all', () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);

  const session = registry.acquire(ROOM);
  const queue = registry.acquire(ROOM);

  session.doc.getText('content').insert(0, 'typed by the editor');
  assert.equal(queue.doc.getText('content').toString(), 'typed by the editor');

  // And the other direction, which is the one that used to be unaskable: the
  // publish queue's seed reaching the document the editor is bound through.
  queue.doc.getText('content').insert(0, 'seeded: ');
  assert.equal(session.doc.getText('content').toString(), 'seeded: typed by the editor');

  registry.destroy();
});

test('the room goes when the LAST borrower lets go, and not before', () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);

  const first = registry.acquire(ROOM);
  const second = registry.acquire(ROOM);
  const connection = transport.live(ROOM)!;

  first.release();
  assert.equal(connection.destroyed, false, 'one handle released is not the room closing');
  assert.equal(registry.refs(ROOM), 1);
  assert.equal(registry.liveDocs(ROOM), 1);

  second.release();
  assert.equal(connection.destroyed, true, 'the last one closes it');
  assert.equal(registry.refs(ROOM), 0);
  assert.equal(registry.liveDocs(ROOM), 0);
  assert.deepEqual(registry.liveRooms(), []);
});

test('releasing twice does not take somebody else\'s reference', () => {
  // Every borrower in this codebase releases in a `finally`, and several of them
  // can reach that `finally` twice. An over-release would tear down a room the
  // editor is bound through.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);

  const first = registry.acquire(ROOM);
  const second = registry.acquire(ROOM);
  const connection = transport.live(ROOM)!;

  first.release();
  first.release();
  first.release();

  assert.equal(registry.refs(ROOM), 1, 'the second borrower still holds it');
  assert.equal(connection.destroyed, false);

  second.release();
  assert.equal(connection.destroyed, true);
});

test('a room re-acquired after it went to zero is a NEW document', () => {
  // Which is today's behaviour on both consumers, and is deliberately kept: a
  // room with no borrowers holds nothing this device is entitled to reason about
  // until slice 4's ledger exists.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);

  const first = registry.acquire(ROOM);
  const before = first.doc;
  first.release();

  const second = registry.acquire(ROOM);
  assert.notEqual(second.doc, before, 'nothing was resurrected');
  assert.equal(registry.docsBuilt(ROOM), 2, 'two lives, one at a time');
  assert.equal(registry.liveDocs(ROOM), 1, 'and never two at once');

  registry.destroy();
});

test('two rooms are two documents, and neither can see the other', () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);

  const a = registry.acquire(ROOM);
  const b = registry.acquire(OTHER);
  assert.notEqual(a.doc, b.doc);

  a.doc.getText('content').insert(0, 'mine');
  assert.equal(b.doc.getText('content').toString(), '');

  registry.destroy();
});

// ================================================================ sync + flush

test('a lease reports a GENUINE handshake and never a timeout', async () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const lease = registry.acquire(ROOM);

  assert.equal(lease.synced, false, 'a fresh room has not handshaked');

  const seen: boolean[] = [];
  lease.on('sync', (isSynced) => { seen.push(isSynced); });
  transport.live(ROOM)!.emitSync();

  assert.equal(lease.synced, true);
  assert.deepEqual(seen, [true]);

  transport.live(ROOM)!.emitDrop();
  assert.equal(lease.synced, false, 'and it stops being current when the link does');
  assert.deepEqual(seen, [true, false]);

  registry.destroy();
});

test('a released lease is not current and confirms nothing', async () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const keep = registry.acquire(ROOM);
  const lease = registry.acquire(ROOM);
  transport.live(ROOM)!.emitSync();

  assert.equal(lease.synced, true);
  lease.release();

  assert.equal(lease.synced, false, 'a reference given back says nothing about the room');
  assert.equal(await lease.flush(10), false, 'and cannot confirm a write (I17)');
  assert.equal(keep.synced, true, 'while the borrower that still holds it can');

  registry.destroy();
});

test('the flush deadline is the CALLER\'s, so the two consumers keep their own', async () => {
  // `ObsidianDocPort` shipped 8 s and `WorkspaceSession` shipped 5 s. A registry
  // that picked one would silently change what I17's guarantee costs on one of
  // the two paths, which is a behaviour change wearing a refactor's clothes.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const docs = new RegistryDocPort(registry);
  const providers = new RegistryProviderPort(registry);

  const opened = await docs.openHeadless(ROOM);
  const connection = transport.live(ROOM)!;
  connection.emitSync();
  await docs.flush(opened.handle);
  assert.equal(connection.lastFlushMs, 8_000, 'the headless path still waits 8 s');

  const { provider } = providers.connect(ROOM);
  await provider.flush();
  assert.equal(connection.lastFlushMs, 5_000, 'and the bound path still waits 5 s');

  docs.close(opened.handle);
  provider.destroy();
  registry.destroy();
});

// ================================================================ the switch

test('switching transports keeps the document, the awareness and the borrowers', () => {
  // The fallback an old server forces. Everything the editor is holding — the
  // `Y.Text` it bound and the `Awareness` it handed `yCollab` — has to survive,
  // or the binding addresses a document nobody is writing to any more.
  const mux = new FakeTransport();
  const legacy = new FakeTransport();
  const registry = new RoomRegistry(mux);

  const lease = registry.acquire(ROOM);
  const doc = lease.doc;
  const awareness = lease.awareness;
  doc.getText('content').insert(0, 'written over the mux');
  const before = mux.live(ROOM)!;
  before.emitSync();

  const seen: boolean[] = [];
  lease.on('sync', (isSynced) => { seen.push(isSynced); });

  registry.switchTransport(legacy);

  assert.equal(before.destroyed, true, 'the mux room was released');
  assert.equal(lease.doc, doc, 'and the document did not move');
  assert.equal(lease.awareness, awareness, 'nor did the awareness');
  assert.equal(doc.getText('content').toString(), 'written over the mux',
    'nor did a byte of what it held');
  assert.equal(legacy.docsSeen(ROOM), 1, 'the new route was handed that same document');
  assert.equal(legacy.awarenessSeen(ROOM), 1);
  assert.equal(registry.liveDocs(ROOM), 1, 'and there is still exactly one');
  assert.equal(registry.connectionsReplaced, 1);

  // I24: a room is not current until the NEW connection has handshaked, and the
  // handler registered before the swap is the one that has to hear about it.
  assert.equal(lease.synced, false, 'a swap is not a handshake');
  legacy.live(ROOM)!.emitSync();
  assert.equal(lease.synced, true);
  assert.deepEqual(seen, [true], 'the pre-swap subscriber was carried across');

  registry.destroy();
});

test('the switch moves EVERY live room, and nothing that has been released', () => {
  const mux = new FakeTransport();
  const legacy = new FakeTransport();
  const registry = new RoomRegistry(mux);

  registry.acquire(ROOM);
  const gone = registry.acquire(OTHER);
  gone.release();

  registry.switchTransport(legacy);

  assert.deepEqual(registry.liveRooms(), [ROOM]);
  assert.equal(legacy.forRoom(ROOM).length, 1);
  assert.equal(legacy.forRoom(OTHER).length, 0, 'a room nobody holds is not revived');
  assert.equal(registry.connectionsReplaced, 1);

  registry.destroy();
});

test('a room acquired AFTER the switch opens on the new transport', () => {
  const mux = new FakeTransport();
  const legacy = new FakeTransport();
  const registry = new RoomRegistry(mux);

  registry.switchTransport(legacy);
  registry.acquire(ROOM);

  assert.equal(mux.forRoom(ROOM).length, 0, 'the condemned route is never dialled again');
  assert.equal(legacy.forRoom(ROOM).length, 1);

  registry.destroy();
});

test('switching to the transport already in use changes nothing', () => {
  const mux = new FakeTransport();
  const registry = new RoomRegistry(mux);
  registry.acquire(ROOM);

  registry.switchTransport(mux);

  assert.equal(mux.forRoom(ROOM).length, 1, 'no room was torn down and rebuilt for nothing');
  assert.equal(registry.connectionsReplaced, 0);

  registry.destroy();
});

// ================================================================ a dial that throws

test('a room whose transport refuses to open leaves nothing behind', () => {
  // ⚠ NOT HYPOTHETICAL, AND THE FAILURE IS PERMANENT. `MuxLink.subscribe` throws
  // on a room this link already holds. A half-built entry left in the map would be
  // reused by every later `acquire` — a room connected to nothing, reporting
  // `synced === false` for the rest of the session, with no way back — and it
  // holds an `Awareness` whose 3-second interval keeps the process alive.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  transport.refuses.add(ROOM);

  assert.throws(() => registry.acquire(ROOM), /already subscribed/);
  assert.equal(registry.liveDocs(ROOM), 0, 'a room that never opened is not a live room');
  assert.equal(registry.refs(ROOM), 0);
  assert.deepEqual(registry.liveRooms(), []);

  // And the room recovers the moment the transport will take it, rather than
  // being stuck on whatever the failed attempt left in the map.
  transport.refuses.delete(ROOM);
  const lease = registry.acquire(ROOM);
  assert.equal(registry.liveDocs(ROOM), 1);
  assert.equal(transport.forRoom(ROOM).length, 1);
  lease.release();

  registry.destroy();
});

test('one room that cannot be reopened does not strand the rooms after it', () => {
  // Per-room containment on the switch, `server/mux.js`'s rule applied on this
  // side. What the failed room is left holding is the honest answer — not current,
  // confirms nothing — which is the direction I3/I4 and I17 require.
  const mux = new FakeTransport();
  const legacy = new FakeTransport();
  const registry = new RoomRegistry(mux);

  const bad = registry.acquire(ROOM);
  const good = registry.acquire(OTHER);
  mux.live(ROOM)!.emitSync();
  mux.live(OTHER)!.emitSync();
  legacy.refuses.add(ROOM);

  registry.switchTransport(legacy);

  assert.equal(registry.connectionsReplaced, 2, 'both rooms were attempted');
  assert.equal(registry.connectionsNotReplaced, 1);
  assert.equal(bad.synced, false, 'a room with no connection is not current');
  assert.equal(legacy.forRoom(OTHER).length, 1, 'the room after it was still moved');
  legacy.live(OTHER)!.emitSync();
  assert.equal(good.synced, true);

  registry.destroy();
});

// ================================================================ teardown

test('destroy tears every room down, whoever is still holding one', () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  registry.acquire(ROOM);
  registry.acquire(OTHER);
  const rooms = [transport.live(ROOM)!, transport.live(OTHER)!];

  registry.destroy();

  assert.deepEqual(rooms.map((r) => r.destroyed), [true, true]);
  assert.deepEqual(registry.liveRooms(), []);
  assert.equal(registry.isDestroyed, true);
});

test('a lease taken after destroy is honest rather than absent', async () => {
  // `ObsidianDocPort` has always handed back a handle after its own teardown,
  // because callers close in a `finally` and would otherwise have nothing to
  // close. What it must never do is claim the room is current.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  registry.destroy();

  const lease = registry.acquire(ROOM);
  assert.equal(lease.synced, false);
  assert.equal(await lease.flush(10), false);
  assert.equal(transport.forRoom(ROOM).length, 0, 'and nothing was dialled');
  assert.equal(registry.liveDocs(ROOM), 0, 'and it is not in the map');
  lease.release();
});

test('destroy releases the awareness the registry built', () => {
  // `WebsocketProvider.destroy()` does not destroy an `Awareness` it was handed
  // and `MuxRoom` deliberately does not either, so if the registry did not, every
  // room would leave a 3-second interval and a `Y.Doc` destroy observer behind.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const lease = registry.acquire(ROOM);
  const awareness = lease.awareness;
  assert.notEqual(awareness.getLocalState(), null);

  registry.destroy();

  assert.equal(awareness.getLocalState(), null, 'the awareness was destroyed');
});

test('a switch does not rebuild the awareness, however many times it happens', () => {
  const first = new FakeTransport();
  const second = new FakeTransport();
  const third = new FakeTransport();
  const registry = new RoomRegistry(first);
  const lease = registry.acquire(ROOM);

  registry.switchTransport(second);
  registry.switchTransport(third);

  assert.equal(second.awarenessSeen(ROOM), 1);
  assert.equal(third.awarenessSeen(ROOM), 1);
  assert.equal(third.live(ROOM)!.awareness, lease.awareness);

  registry.destroy();
});

// ================================================================ RegistryDocPort

test('openHeadless hands back the text only when the room genuinely synced', async () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 20 });

  // A room that never handshakes: the text is WITHHELD, because an unsynced
  // document reads as empty when it is not, and seeding into that doubles a note
  // on reconnect (I4).
  const pending = docs.openHeadless(ROOM);
  transport.live(ROOM)!.doc.getText('content').insert(0, 'content the client cannot prove');
  const blind = await pending;
  assert.equal(blind.synced, false, 'a timeout is not a sync');
  assert.equal(blind.text, '', 'and an unproven document is handed back empty');
  assert.notEqual(blind.handle, undefined, 'but a handle is still returned');
  docs.close(blind.handle);

  const second = docs.openHeadless(OTHER);
  const connection = transport.live(OTHER)!;
  connection.doc.getText('content').insert(0, 'what the server holds');
  connection.emitSync();
  const opened = await second;
  assert.equal(opened.synced, true);
  assert.equal(opened.text, 'what the server holds');
  docs.close(opened.handle);

  registry.destroy();
});

test('insertIfEmpty is I5\'s guard on the ONE document, so a second seed refuses', async () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 20 });
  const providers = new RegistryProviderPort(registry);

  // The two consumers, at once, on one room — the state that used to be two
  // documents. The session writes first; the queue's seed must then REFUSE,
  // which it could not do when it was looking at a document of its own.
  const { doc, provider } = providers.connect(ROOM);
  transport.live(ROOM)!.emitSync();
  doc.getText('content').insert(0, 'the editor got there first');

  const opened = await docs.openHeadless(ROOM);
  assert.equal(opened.synced, true, 'the same connection, already synced');
  assert.equal(await docs.insertIfEmpty(opened.handle, 'and the queue seeds it again'), false,
    'I5: the document is not empty, and there is only one document to ask');
  assert.equal(doc.getText('content').toString(), 'the editor got there first',
    'nothing was concatenated');

  docs.close(opened.handle);
  provider.destroy();
  registry.destroy();
});

test('rooms are pooled per name and released with the last handle', async () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 20 });

  const first = await openSynced(docs, transport, ROOM);
  const second = await docs.openHeadless(ROOM);
  assert.equal(transport.forRoom(ROOM).length, 1, 'one connection for two handles');

  docs.close(first.handle);
  assert.equal(await docs.flush(second.handle), true, 'the connection outlived one handle');
  docs.close(second.handle);
  assert.equal(await docs.flush(second.handle), false, 'and is gone with the last');
  assert.equal(transport.live(ROOM), undefined);

  registry.destroy();
});

test('close is idempotent and cannot over-release', async () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 20 });

  const first = await openSynced(docs, transport, ROOM);
  const second = await docs.openHeadless(ROOM);

  docs.close(first.handle);
  docs.close(first.handle);
  docs.close(first.handle);

  assert.equal(registry.refs(ROOM), 1, 'the other handle still holds the room');
  assert.equal(await docs.flush(second.handle), true);
  docs.close(second.handle);
  assert.equal(registry.refs(ROOM), 0);

  registry.destroy();
});

test('a flush that is refused is reported as refused (I17)', async () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 20 });

  const opened = await openSynced(docs, transport, ROOM);
  transport.live(ROOM)!.flushConfirms = false;
  assert.equal(await docs.flush(opened.handle), false,
    'an unconfirmed flush is a retry, never a completion');

  docs.close(opened.handle);
  registry.destroy();
});

test('the port gives its own handles back and leaves the registry standing', async () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 20 });
  const providers = new RegistryProviderPort(registry);

  const { provider } = providers.connect(ROOM);
  const opened = await docs.openHeadless(ROOM);
  const connection = transport.live(ROOM)!;

  docs.destroy();

  assert.equal(connection.destroyed, false,
    'the session is still holding the room, so the room is still here');
  assert.equal(registry.refs(ROOM), 1);
  assert.equal(await docs.flush(opened.handle), false, 'but this port is done');
  const after = await docs.openHeadless(ROOM);
  assert.equal(after.synced, false, 'and it opens nothing further');

  provider.destroy();
  assert.equal(connection.destroyed, true);
  registry.destroy();
});

// ================================================================ RegistryProviderPort

test('the session is handed the room\'s document and the room\'s awareness', () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);

  const { doc, provider } = providers.connect(ROOM);
  const connection = transport.live(ROOM)!;

  assert.equal(doc, connection.doc, 'the document the transport is connected to');
  assert.equal(provider.awareness, connection.awareness);
  assert.equal(transport.docsSeen(ROOM), 1);

  provider.destroy();
  registry.destroy();
});

test('the session\'s destroy releases a reference, it does not close a shared room', async () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 20 });

  const { provider } = providers.connect(ROOM);
  const opened = await openSynced(docs, transport, ROOM);
  const connection = transport.live(ROOM)!;

  provider.destroy();
  assert.equal(connection.destroyed, false, 'the queue is still publishing through it');
  assert.equal(await docs.flush(opened.handle), true);

  docs.close(opened.handle);
  assert.equal(connection.destroyed, true, 'and it goes with the last of them');

  registry.destroy();
});

test('the session\'s destroy is idempotent', () => {
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);

  const a = providers.connect(ROOM);
  const b = providers.connect(ROOM);

  a.provider.destroy();
  a.provider.destroy();
  assert.equal(registry.refs(ROOM), 1);

  b.provider.destroy();
  assert.equal(registry.refs(ROOM), 0);

  registry.destroy();
});

// ================================================================ the departure

test('the departing cursor goes out through the LIVE connection, before the room does', () => {
  // ⚠ THE ORDERING IS THE FIX. `RoomEntry.destroy` tears the connection down and
  // then the `Awareness`, and `y-protocols` also destroys an `Awareness` from
  // `doc.on('destroy')` — so every removal that happened by either of those routes
  // happened with no connection left to carry it. Measured before this line: a
  // peer went on showing the departed user's cursor for 29,842 ms, against 0-1 ms
  // on the per-room route, waiting out the awareness protocol's staleness sweep.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);

  const { doc, provider } = providers.connect(ROOM);
  const connection = transport.live(ROOM)!;
  provider.announcePresence(ADA);
  assert.equal(connection.awareness.getStates().size, 1);

  provider.destroy();

  assert.equal(connection.departuresOf(doc.clientID), 1,
    'the departure never reached the wire while there was a wire to reach');
  assert.equal(connection.awareness.getStates().has(doc.clientID), false);
  assert.equal(connection.destroyed, true, 'the room should have gone with the last lease');

  registry.destroy();
});

test('the room itself says goodbye, whoever was holding it and however it is let go', () => {
  // ⚠ THE ENTRY'S OWN ANNOUNCEMENT, asked WITHOUT the session's port, because the
  // session's release announces first and would hide this one entirely. Two ways
  // a room reaches zero with a cursor still on it, and `main.ts` takes the second
  // on every unload: `dispose()` runs `session.destroy()`, then `docs.destroy()`,
  // then `rooms.destroy()` — and `mux.destroy()` only after those, precisely so a
  // room still has a socket while it is being torn down. A lease that was leaked
  // rather than released reaches zero the same way.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);

  const released = registry.acquire(ROOM);
  const releasedConnection = transport.live(ROOM)!;
  released.announcePresence(ADA);
  released.release();                       // and NOT `withdrawPresence` first
  assert.equal(releasedConnection.departuresOf(released.doc.clientID), 1,
    'the last release tore the room down without telling the room\'s peers');

  const abandoned = registry.acquire(OTHER);
  const abandonedConnection = transport.live(OTHER)!;
  abandoned.announcePresence(GRACE);
  registry.destroy();                                   // the plugin unloading
  assert.equal(abandonedConnection.departuresOf(abandoned.doc.clientID), 1,
    'a room held at unload left its cursor on every peer for the sweep to find');
});

test('the cursor goes even when the ROOM stays, which is the half no leave frame reaches', () => {
  // ⚠ THE CASE THAT IS NOT ABOUT THE MUX AT ALL. The `Awareness` is the
  // REGISTRY's, shared by both consumers, so the session's `user` state outlives
  // the leaf closing whenever the publish queue is still holding the same room —
  // and the room staying open is exactly the situation in which nothing else will
  // ever remove it. Measured on BOTH routes before this: a peer held the cursor
  // for the whole 45 s a rig was willing to watch, and would have held it for
  // ever, because `y-protocols` renews a live local state every 15 s so the peer's
  // 30 s sweep never fires. On master the session owned its own provider and its
  // own socket, and closing the leaf closed it.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 20 });

  const { doc, provider } = providers.connect(ROOM);
  const held = docs.openHeadless(ROOM);
  const connection = transport.live(ROOM)!;
  provider.announcePresence(ADA);

  provider.destroy();

  assert.equal(connection.destroyed, false, 'the queue is still publishing through it');
  assert.equal(connection.departuresOf(doc.clientID), 1,
    'the leaf closed and the cursor stayed in a room the user has left');
  assert.equal(connection.awareness.getStates().size, 0);

  void held.then((opened) => { docs.close(opened.handle); });
  registry.destroy();
});

test('the HEADLESS port announces nothing, so a publish cannot wipe a live cursor', async () => {
  // The other side of the same coin, and the reason the announcement is on the
  // session's port rather than on `release`. The publish path never sets a local
  // state, so a removal from there would do nothing whatever — except on the one
  // occasion it would do harm: a queue handle closing while a session is bound to
  // the same room right now, which is the ordinary case every time a note is open
  // and its drain lands.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 20 });

  const { doc, provider } = providers.connect(ROOM);
  const opened = await openSynced(docs, transport, ROOM);
  const connection = transport.live(ROOM)!;
  provider.announcePresence(ADA);

  docs.close(opened.handle);

  assert.equal(connection.departuresOf(doc.clientID), 0,
    'the publish queue letting go removed the bound session\'s cursor');
  assert.equal(connection.awareness.getStates().size, 1, 'the live cursor was wiped');

  provider.destroy();
  registry.destroy();
});

test('announcing a departure twice says it once, and a room nobody wrote a cursor into still says it', () => {
  // Every borrower in this codebase releases in a `finally` and several reach it
  // twice, so the announcement has to be as idempotent as the release it precedes.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);
  try {
    const a = providers.connect(ROOM);
    const b = providers.connect(ROOM);
    const connection = transport.live(ROOM)!;
    a.provider.announcePresence(ADA);

    a.provider.destroy();
    a.provider.destroy();
    assert.equal(connection.departuresOf(a.doc.clientID), 1, 'the departure was announced twice');
    b.provider.destroy();
  } finally {
    registry.destroy();
  }

  // ⚠ AND IT IS ANNOUNCED EVEN WHEN NOBODY SET A CURSOR, which is not an
  // over-reach: `y-protocols`' `Awareness` constructor calls `setLocalState({})`,
  // so a room ALWAYS holds an entry for its own client from the moment it exists.
  // A peer's `states` map holds that entry too, and without the removal it would
  // hold it for the full 30 s staleness sweep. y-websocket's own teardown
  // broadcasts the null state unconditionally for the same reason.
  const quiet = new FakeTransport();
  const quietRegistry = new RoomRegistry(quiet);
  const quietProviders = new RegistryProviderPort(quietRegistry);
  try {
    const silent = quietProviders.connect(OTHER);
    const quietConnection = quiet.live(OTHER)!;
    assert.equal(quietConnection.awareness.getStates().size, 1,
      'a fresh Awareness stopped holding its own empty state');
    silent.provider.destroy();
    assert.equal(quietConnection.departuresOf(silent.doc.clientID), 1,
      'a room with no cursor in it left its own entry behind on every peer');
  } finally {
    quietRegistry.destroy();
  }
});

test('a switchTransport does NOT announce a departure — the user has not left', () => {
  // ⚠ The one place the announcement must not fire. `reopen` destroys one
  // connection and builds another under a LIVE lease, which is what an old server
  // forces; a departure there would tell every peer the user closed a note they
  // are still looking at, and the re-handshake would put the cursor back a moment
  // later. The removal belongs to `RoomEntry.destroy` and to the session's own
  // release, and to nothing else.
  const first = new FakeTransport();
  const second = new FakeTransport();
  const registry = new RoomRegistry(first);
  const providers = new RegistryProviderPort(registry);

  const { doc, provider } = providers.connect(ROOM);
  provider.announcePresence(ADA);
  const before = first.live(ROOM)!;

  registry.switchTransport(second);

  assert.equal(before.departuresOf(doc.clientID), 0,
    'the fallback told every peer the user had left the note they are editing');
  assert.equal(before.awareness.getStates().size, 1, 'the switch dropped the local cursor');
  assert.equal(second.live(ROOM)!.awareness, before.awareness,
    'the new route is broadcasting a different Awareness');

  provider.destroy();
  registry.destroy();
});

// ================================================================ the arrival

test('a note REOPENED onto a room somebody else kept alive announces itself again', () => {
  // ⚠ THE BLOCKER THIS CASE EXISTS FOR, and no lens that walked the invariants saw
  // it: closing a note nulls the shared local state, and the reopen used to
  // re-establish the cursor with `setLocalStateField` — which `y-protocols` makes a
  // NO-OP when the state is null (`if (state !== null)`). So when the publish queue
  // still held the room, the reopening user was invisible to every peer for the
  // life of the entry, editing normally, with nothing to recover them: the 15 s
  // renewal re-sends only a state that is not null, and only teardown cleared it.
  // Measured against real processes at the time: the peer never saw the cursor
  // again on either route, against 16 ms on master's own seam.
  //
  // Closing a note SCHEDULES its publish, so a quick reopen lands squarely in the
  // window where the queue holds the room. Slice 4's subscribe-all makes it the
  // ordinary case rather than a race.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 20 });

  const held = docs.openHeadless(ROOM);                  // the queue takes the room
  const first = providers.connect(ROOM);
  const connection = transport.live(ROOM)!;
  first.provider.announcePresence(ADA);
  first.provider.destroy();
  assert.equal(connection.destroyed, false, 'the queue was meant to keep the room');
  assert.equal(connection.awareness.getLocalState(), null,
    'the departure left something for the next mount to mutate');

  const arrivals = connection.arrivalsOf(first.doc.clientID);
  const again = providers.connect(ROOM);                  // the same note, reopened
  assert.equal(again.doc, first.doc, 'a second document for one room');
  again.provider.announcePresence(ADA);

  assert.equal(connection.arrivalsOf(again.doc.clientID) - arrivals, 1,
    'the reopening user announced nothing — every peer still has them gone');
  assert.deepEqual(connection.awareness.getStates().get(again.doc.clientID), { user: ADA });

  again.provider.destroy();
  void held.then((opened) => { docs.close(opened.handle); });
  registry.destroy();
});

test('the mount announces the state WHOLE, so nothing of the last binding survives it', () => {
  // `y-codemirror.next` writes a `cursor` field into this same shared state, and it
  // addresses positions in the editor that was open at the time. A mount that
  // merged into what was there would hand every peer a caret pointing into a
  // document this session is no longer bound to.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);

  const { doc, provider } = providers.connect(ROOM);
  const connection = transport.live(ROOM)!;
  provider.announcePresence(ADA);
  // The binding's half, written the way `yCollab` writes it — onto a state the
  // session has just announced, which is the one thing the field setter is for.
  provider.awareness.setLocalStateField('cursor', { anchor: 41, head: 41 });
  assert.deepEqual(connection.awareness.getLocalState(),
    { user: ADA, cursor: { anchor: 41, head: 41 } },
    'the binding could not write a caret onto an announced state');

  provider.announcePresence(GRACE);                      // a second mount, same room

  assert.deepEqual(connection.awareness.getStates().get(doc.clientID), { user: GRACE },
    'the new mount inherited the old binding\'s caret');

  provider.destroy();
  registry.destroy();
});

test('a borrower that announced nothing cannot take another\'s presence away', () => {
  // ⚠ THE RULE IN ITS SECOND DIRECTION, and it is what makes the headless path
  // structurally harmless rather than harmless by inspection. The publish queue and
  // the reconciler hold ordinary leases; if a release could null the shared local
  // state, the drain that lands under an open note — the ordinary case, every time
  // — would wipe the cursor of the session it is publishing for.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);

  const { doc, provider } = providers.connect(ROOM);
  const other = registry.acquire(ROOM);
  const connection = transport.live(ROOM)!;
  provider.announcePresence(ADA);

  // Asked at the seam a borrower actually has, not through a private field: the
  // lease's own `withdrawPresence` is refused because this lease announced nothing.
  other.withdrawPresence();
  other.release();

  assert.equal(connection.departuresOf(doc.clientID), 0,
    'a borrower removed a cursor it never wrote');
  assert.deepEqual(connection.awareness.getStates().get(doc.clientID), { user: ADA });

  provider.destroy();
  assert.equal(connection.departuresOf(doc.clientID), 1,
    'and the holder that DID announce could no longer withdraw');
  registry.destroy();
});

test('a stale provider\'s teardown cannot unsay what a newer one announced', () => {
  // The same guard from the other side. `WorkspaceSession.doOpen` releases its
  // lease in a `finally` on every path it does not keep, and a superseded open can
  // reach that `finally` at any time; what it must never do is null the presence
  // the open that superseded it has already announced.
  const transport = new FakeTransport();
  const registry = new RoomRegistry(transport);
  const providers = new RegistryProviderPort(registry);

  const stale = providers.connect(ROOM);
  const connection = transport.live(ROOM)!;
  stale.provider.announcePresence(ADA);

  const winner = providers.connect(ROOM);
  winner.provider.announcePresence(GRACE);               // the newer mount takes over
  stale.provider.destroy();                              // the superseded `finally`

  assert.equal(connection.departuresOf(winner.doc.clientID), 0,
    'a superseded open took the live session\'s cursor down with it');
  assert.deepEqual(connection.awareness.getStates().get(winner.doc.clientID), { user: GRACE });

  // Nor may it ARRIVE. A reference already given back speaks for nothing at all,
  // in either direction — the entry it was taken on may since have been re-let.
  stale.provider.announcePresence(ADA);
  assert.deepEqual(connection.awareness.getStates().get(winner.doc.clientID), { user: GRACE },
    'a provider that had already let go announced itself over the live session');

  winner.provider.destroy();
  registry.destroy();
});

// ---------------------------------------------------------------- helpers

async function openSynced(
  docs: RegistryDocPort,
  transport: FakeTransport,
  room: string,
): Promise<{ text: string; synced: boolean; handle: { room: string } }> {
  const pending = docs.openHeadless(room);
  transport.live(room)!.emitSync();
  return pending;
}
