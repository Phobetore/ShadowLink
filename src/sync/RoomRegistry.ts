// src/sync/RoomRegistry.ts
// One refcounted `Y.Doc` per room, borrowed by every consumer (P3 spec §1.1
// "RoomRegistry / HotSet", §9 slice 3).
//
// WHAT THIS EXISTS TO REMOVE. Before it, two things opened content documents and
// neither knew about the other: `WorkspaceSession` built a `new Y.Doc()` and its
// own provider for the note in the editor, and `ObsidianDocPort` kept a separate
// pool for the headless publishes. One client could therefore hold TWO `Y.Doc`s
// for one room — the S10 defect class the spec names — and every question about
// their ordering was unaskable, because whichever one wrote, the other could not
// see it. `insertIfEmpty`'s emptiness check is invariant I5's whole mechanism, and
// it is a check on ONE document; asked of two, it answers "empty" twice and the
// note is published concatenated with itself.
//
// So a room's document is not the session's and not the pool's. It is the
// registry's, and both of them BORROW it:
//
//     const lease = registry.acquire('n_abc');   // refs 0 -> 1, doc created
//     const other = registry.acquire('n_abc');   // refs 1 -> 2, SAME doc
//     lease.release();                           // refs 2 -> 1, doc kept
//     other.release();                           // refs 1 -> 0, doc destroyed
//
// Refcount-to-zero closes, which is today's behaviour on both sides: the pool
// already tore a room down with its last handle, and the session already released
// its provider and document when the leaf closed. Nothing here changes WHEN a
// room goes; it changes how many documents there were while it was here.
//
// ⚠ WHY THE DOCUMENT AND THE AWARENESS ARE THE REGISTRY'S AND NOT THE TRANSPORT'S.
// A `MuxRoom` and a `WebsocketProvider` both accept a document and an `Awareness`
// rather than making them, and that is what lets the connection under a live room
// be REPLACED without the borrowers noticing — which is exactly what an old server
// forces (see `switchTransport`). If the transport owned the document, a fallback
// would hand the editor a `Y.Text` from a document nothing is bound to, and the
// `yCollab` binding installed over the old one would address positions in a
// document nobody is writing to any more.
//
// ⚠ AND THE FLUSH TIMEOUT IS THE CALLER'S, DELIBERATELY. The two consumers do not
// agree on it and never did — `ObsidianDocPort` waits 8 s and `WorkspaceSession`
// waits 5 s — so a registry that picked one would silently change what I17's
// guarantee costs on one of the two paths. `RoomConnection.flush` therefore takes
// the number, and the two adapters below keep the two numbers they shipped with.
//
// No `obsidian` import, no node builtins, and no transport: this file names what a
// connection must be able to do and never builds one.

import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';

import { NOTE_SYNC_TIMEOUT_MS } from '../tree/constants.ts';
import type { DocHandle, DocPort } from './DocPort.ts';
import type { ProviderPort, SessionProvider, SessionRoom } from './WorkspaceSession.ts';

/** `ObsidianDocPort`'s shipped flush deadline, kept for the headless path. */
const DOC_FLUSH_TIMEOUT_MS = 8_000;

/** `WorkspaceSession`'s shipped flush deadline, kept for the bound path. */
const SESSION_FLUSH_TIMEOUT_MS = 5_000;

// ============================================================ the transport seam

/**
 * One room's live connection to the workspace, over whatever carries it.
 *
 * Satisfied by `MuxRoom` as it already stands, and by the per-room
 * `WebsocketProvider` the compatibility route uses. The document and the
 * `Awareness` are handed IN: a connection may be built and destroyed several times
 * over one room's life, and neither of those two objects may move when it is.
 */
export interface RoomConnection {
  /** True only after a GENUINE handshake on the current connection (I3/I4). */
  readonly synced: boolean;
  on(event: 'sync', handler: (isSynced: boolean) => void): void;
  off(event: 'sync', handler: (isSynced: boolean) => void): void;
  /**
   * Resolves TRUE only once the server has acknowledged this room's pending
   * updates. `ms` is the CALLER's deadline — see the header for why it is not
   * this file's.
   */
  flush(ms: number): Promise<boolean>;
  /** Release the connection. Never the document, and never the `Awareness`. */
  destroy(): void;
}

/** Builds one connection per room, over one route. */
export interface RoomTransport {
  open(room: string, doc: Y.Doc, awareness: awarenessProtocol.Awareness): RoomConnection;
}

/**
 * A borrowed reference to one room.
 *
 * Every member reads THROUGH the registry's entry rather than capturing the
 * connection, so a lease taken before a `switchTransport` keeps working after it.
 */
export interface RoomLease {
  readonly room: string;
  /** The room's ONE document. The registry destroys it; a borrower must not. */
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly synced: boolean;
  on(event: 'sync', handler: (isSynced: boolean) => void): void;
  off(event: 'sync', handler: (isSynced: boolean) => void): void;
  flush(ms: number): Promise<boolean>;
  /** Give the reference back. Idempotent: borrowers release in a `finally`. */
  release(): void;
}

// ============================================================ one room

/**
 * A connection that is not one, for a registry that has been destroyed.
 *
 * `ObsidianDocPort` has always handed back a handle after its own teardown rather
 * than throwing — the caller's `finally` closes it either way — and the answer it
 * gave was "not synced, nothing confirmed". This is that answer, as an object.
 */
const DEAD_CONNECTION: RoomConnection = {
  synced: false,
  on: () => undefined,
  off: () => undefined,
  flush: () => Promise.resolve(false),
  destroy: () => undefined,
};

class RoomEntry {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;

  refs = 0;
  released = false;

  private connection: RoomConnection = DEAD_CONNECTION;

  /**
   * The borrowers' handlers, held HERE rather than on the connection.
   *
   * A swap destroys one connection and builds another; a handler registered on the
   * old one would simply stop being called, and the session's `waitForSync` would
   * then wait out its whole deadline against a room that had synced.
   */
  private readonly syncHandlers = new Set<(isSynced: boolean) => void>();

  private readonly relay = (isSynced: boolean): void => {
    for (const handler of [...this.syncHandlers]) handler(isSynced);
  };

  constructor(readonly room: string) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
  }

  get synced(): boolean {
    return this.connection.synced;
  }

  open(transport: RoomTransport): void {
    this.connection = transport.open(this.room, this.doc, this.awareness);
    this.connection.on('sync', this.relay);
  }

  /** Swap the route under a live room, keeping the document and the awareness. */
  reopen(transport: RoomTransport): void {
    const previous = this.connection;
    previous.off('sync', this.relay);
    // ⚠ DEAD BEFORE THE DIAL, not after it. If `transport.open` throws, the field
    // must not still name a connection this method has already destroyed:
    // `MuxRoom.synced` reads a latched flag and the LINK, neither of which its own
    // `destroy()` clears, so a destroyed room on a live link answers `true` about a
    // subscription it has already given up.
    this.connection = DEAD_CONNECTION;
    try {
      previous.destroy();
    } catch {
      /* teardown is not optional */
    }
    this.open(transport);
  }

  on(handler: (isSynced: boolean) => void): void {
    this.syncHandlers.add(handler);
  }

  off(handler: (isSynced: boolean) => void): void {
    this.syncHandlers.delete(handler);
  }

  flush(ms: number): Promise<boolean> {
    return this.connection.flush(ms);
  }

  /**
   * Say this client is gone from the room, THROUGH the live connection.
   *
   * ⚠ IT HAS TO HAPPEN WHILE THERE IS STILL SOMETHING TO SAY IT ON. The awareness
   * update is written by the connection's own update handler, so a removal made
   * after `connection.destroy()` — which is where `awareness.destroy()` sits, and
   * what `y-protocols` reaches through `doc.on('destroy')` — has no socket to
   * leave on and reaches no peer at all. That is why the ordering in `destroy()`
   * below is load-bearing rather than tidy.
   *
   * Idempotent by construction: `removeAwarenessStates` emits nothing for a client
   * whose state is already gone.
   */
  announceDeparture(): void {
    try {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
    } catch {
      /* an awareness that is already gone has nothing to announce */
    }
  }

  /** The departure, then the connection, the awareness and the document, once. */
  destroy(): void {
    if (this.released) return;
    this.released = true;
    // ⚠ FIRST, and the reason is measured. Without it a peer went on showing this
    // user's cursor in a note they had closed for 29.8 s — the awareness
    // protocol's own staleness sweep — because the only thing that had ever
    // removed it was `DocHub._closeConn` running on a socket's death, and on the
    // mux a note closing does not kill a socket. y-websocket's teardown
    // broadcasts a null state for exactly this reason.
    this.announceDeparture();
    this.connection.off('sync', this.relay);
    this.syncHandlers.clear();
    for (const step of [
      (): void => { this.connection.destroy(); },
      // ⚠ `WebsocketProvider.destroy()` does NOT destroy an `Awareness` it was
      // handed, and `MuxRoom` deliberately does not either when it did not build
      // one. Whoever built it destroys it, and here that is this object.
      //
      // ⚠ AND NO TEST CAN KILL THIS LINE, WHICH IS RECORDED RATHER THAN FIXED.
      // A mutation sweep found it surviving, and it is EQUIVALENT: `y-protocols`
      // registers `doc.on('destroy', () => this.destroy())`, so the step below
      // tears the awareness down anyway. It is kept for the reason the loop it
      // sits in exists — every step is wrapped, so a `doc.destroy()` that THROWS
      // must not take the awareness's 3-second interval with it. "Some later line
      // happens to do it too" is a property of that line rather than a guarantee
      // of this one, which is the call `LegacyTreeTransport` already made for its
      // two survivors.
      (): void => { this.awareness.destroy(); },
      (): void => { this.doc.destroy(); },
    ]) {
      try {
        step();
      } catch {
        /* already gone */
      }
    }
    this.connection = DEAD_CONNECTION;
  }
}

// ============================================================ RoomRegistry

/**
 * The one owner of a room's document.
 *
 * ⚠ THE POINT IS WHAT CANNOT BE WRITTEN, not what is. `acquire` takes a room NAME
 * and nothing else: there is no parameter through which a caller could supply a
 * second document for a room, and no consumer constructs one. That is what
 * `RoomRegistry.test.ts` and `one-doc-per-room.test.ts` hold — the second by
 * scanning shipped source, because "no caller does this today" is a fact about
 * today and "no caller CAN" is a property.
 */
export class RoomRegistry {
  private readonly entries = new Map<string, RoomEntry>();

  /** How many documents this registry has ever built for a room. A leak detector. */
  private readonly built = new Map<string, number>();

  private transport: RoomTransport;
  private destroyed = false;
  private reopens = 0;
  private reopenFailures = 0;

  constructor(transport: RoomTransport) {
    this.transport = transport;
  }

  /**
   * Borrow `room`. The same name always yields the same document while any lease
   * is outstanding.
   */
  acquire(room: string): RoomLease {
    // A registry that has been torn down still hands back a lease, because
    // `ObsidianDocPort` always has and its callers close in a `finally`. What it
    // hands back is an honest one: a document nothing is connected to, which
    // never syncs and confirms nothing.
    if (this.destroyed) {
      const orphan = new RoomEntry(room);
      return leaseOf(orphan, () => { orphan.destroy(); });
    }

    let entry = this.entries.get(room);
    if (entry === undefined) {
      entry = new RoomEntry(room);
      this.entries.set(room, entry);
      this.built.set(room, (this.built.get(room) ?? 0) + 1);
      // ⚠ A DIAL THAT THROWS MUST NOT LEAVE THE ROOM IN THE MAP. `MuxLink.subscribe`
      // throws on a room this link already holds, and a half-built entry left
      // behind would be reused by every later `acquire` — a room permanently
      // connected to nothing, reporting `synced === false` for the rest of the
      // session with no way back. It also holds an `Awareness`, whose 3-second
      // interval keeps the process alive; that is how a mutation of this very line
      // hung `node --test` rather than failing it.
      try {
        entry.open(this.transport);
      } catch (err) {
        this.entries.delete(room);
        entry.destroy();
        throw err;
      }
    }
    const held = entry;
    held.refs += 1;
    return leaseOf(held, () => { this.releaseEntry(room, held); });
  }

  /**
   * Move every live room onto another route, keeping every document.
   *
   * ⚠ THIS IS THE SECOND SWITCH THE SPEC ASKED FOR BEFORE THIS SLICE FOUND IT
   * (§4, "the bridge covers `_tree` and nothing else"). From here the vault's one
   * socket carries the note rooms too, and a link the server does not speak makes
   * `connect()` a permanent no-op for ALL of them — so without this, a client
   * talking to a pre-P3 server would keep its tree through the bridge and lose
   * note sync entirely, which is the largest behaviour change this slice could
   * possibly make.
   *
   * The re-handshake that follows is I24's, unchanged: the new connection asks
   * from the state vector of the document it was handed, and nothing is marked
   * synced on a handshake that has not completed.
   */
  switchTransport(next: RoomTransport): void {
    if (this.destroyed) return;
    if (next === this.transport) return;
    this.transport = next;
    for (const entry of this.entries.values()) {
      // Per-room containment, `server/mux.js`'s rule applied on this side: one
      // room that cannot be reopened may not strand the rooms after it in the
      // map. What it leaves behind is the honest answer rather than a stale
      // connection — `synced` false and `flush` false, which is the direction
      // I3/I4 and I17 require — and the next pass finds it that way.
      try {
        entry.reopen(next);
      } catch {
        this.reopenFailures += 1;
      }
      this.reopens += 1;
    }
  }

  // ---------------------------------------------------------- census

  /**
   * How many live documents exist for `room`. Zero or one, at every instant, on
   * every path — which is the whole claim this class makes.
   */
  liveDocs(room: string): number {
    return this.entries.has(room) ? 1 : 0;
  }

  /** Outstanding leases on `room`. */
  refs(room: string): number {
    return this.entries.get(room)?.refs ?? 0;
  }

  /** Every room currently held, sorted. */
  liveRooms(): string[] {
    return [...this.entries.keys()].sort();
  }

  /**
   * How many documents this registry has EVER built for `room`.
   *
   * One while a lease is continuously held, however many borrowers come and go;
   * it rises only when a room went to zero and was asked for again, which is
   * today's behaviour on both sides.
   */
  docsBuilt(room: string): number {
    return this.built.get(room) ?? 0;
  }

  /** How many connections `switchTransport` has replaced, in total. */
  get connectionsReplaced(): number {
    return this.reopens;
  }

  /** How many of those could not be reopened. A room left honestly unsynced. */
  get connectionsNotReplaced(): number {
    return this.reopenFailures;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Tear every room down, whatever is still holding one. The plugin's `onunload`. */
  destroy(): void {
    this.destroyed = true;
    for (const entry of this.entries.values()) entry.destroy();
    this.entries.clear();
  }

  private releaseEntry(room: string, entry: RoomEntry): void {
    entry.refs -= 1;
    if (entry.refs > 0) return;
    // Only if it is still OURS: a `destroy()` in between has already cleared the
    // map, and a room re-acquired since would be a different entry.
    if (this.entries.get(room) === entry) this.entries.delete(room);
    entry.destroy();
  }
}

/**
 * One borrowed reference, reading THROUGH the entry.
 *
 * Nothing here captures the connection: `switchTransport` replaces it under a
 * live lease and every member has to follow. `release` is one-shot per lease, so
 * a borrower closing twice — which every `finally` in this codebase does — cannot
 * take a reference somebody else is holding.
 */
function leaseOf(entry: RoomEntry, giveBack: () => void): RoomLease {
  let live = true;
  return {
    room: entry.room,
    doc: entry.doc,
    awareness: entry.awareness,
    get synced(): boolean { return live && entry.synced; },
    on: (_event, handler) => { entry.on(handler); },
    off: (_event, handler) => { entry.off(handler); },
    flush: (ms) => (live ? entry.flush(ms) : Promise.resolve(false)),
    release: () => {
      if (!live) return;
      live = false;
      giveBack();
    },
  };
}

// ============================================================ the two consumers

interface RegistryHandle extends DocHandle {
  readonly room: string;
  readonly id: number;
}

/**
 * `DocPort` over the registry — the publish queue's and the reconciler's half.
 *
 * Every promise `ObsidianDocPort` made is kept here, because it is the same
 * promise: a handle is returned whether or not the room synced, the text is
 * WITHHELD when it did not (an unsynced document reads as empty when it is not,
 * and seeding into that is what doubles a note on reconnect — I4), `close` is
 * idempotent and cannot over-release, and `flush` is a real acknowledgement.
 */
export class RegistryDocPort implements DocPort {
  private readonly live = new Map<number, RoomLease>();
  private nextHandleId = 1;
  private closed = false;

  private readonly syncTimeoutMs: number;
  private readonly flushTimeoutMs: number;

  constructor(
    private readonly registry: RoomRegistry,
    options: { syncTimeoutMs?: number; flushTimeoutMs?: number } = {},
  ) {
    this.syncTimeoutMs = options.syncTimeoutMs ?? NOTE_SYNC_TIMEOUT_MS;
    this.flushTimeoutMs = options.flushTimeoutMs ?? DOC_FLUSH_TIMEOUT_MS;
  }

  async openHeadless(
    room: string,
  ): Promise<{ text: string; synced: boolean; handle: DocHandle }> {
    const handle: RegistryHandle = { room, id: this.nextHandleId++ };
    if (this.closed) return { text: '', synced: false, handle };

    const lease = this.registry.acquire(room);
    this.live.set(handle.id, lease);

    const synced = await waitSync(lease, this.syncTimeoutMs);
    // The handle is returned either way: branching on `synced` is the CALLER's
    // obligation (I4), and withholding it would only hide a caller that does not.
    if (!synced) return { text: '', synced: false, handle };
    return { text: lease.doc.getText('content').toString(), synced: true, handle };
  }

  async insertIfEmpty(handle: DocHandle, text: string): Promise<boolean> {
    const lease = this.leaseOf(handle);
    if (lease === null) return false;
    const content = lease.doc.getText('content');
    if (content.length !== 0) return false;                  // I5
    content.insert(0, text);
    return true;
  }

  async flush(handle: DocHandle): Promise<boolean> {
    const lease = this.leaseOf(handle);
    if (lease === null) return false;
    return lease.flush(this.flushTimeoutMs);
  }

  close(handle: DocHandle): void {
    const h = handle as RegistryHandle;
    if (typeof h.id !== 'number') return;
    const lease = this.live.get(h.id);
    if (lease === undefined) return;                         // already released
    this.live.delete(h.id);
    lease.release();
  }

  /** Give every handle this port is holding back. The registry outlives it. */
  destroy(): void {
    this.closed = true;
    for (const lease of this.live.values()) lease.release();
    this.live.clear();
  }

  private leaseOf(handle: DocHandle): RoomLease | null {
    const h = handle as RegistryHandle;
    if (typeof h.id !== 'number') return null;
    return this.live.get(h.id) ?? null;    // a released handle has nothing to await
  }
}

/**
 * `ProviderPort` over the registry — the editing session's half.
 *
 * The session used to build the document as well as the connection; it now
 * borrows both. What it keeps is the whole of its behaviour: the room is still
 * `n_<nodeId>`, `synced` is still a genuine handshake and never a timeout, and
 * `destroy()` still means "this session is done with the room" — it simply gives a
 * reference back rather than tearing a socket down, because the queue may be
 * holding the same room.
 */
export class RegistryProviderPort implements ProviderPort {
  private readonly flushTimeoutMs: number;

  constructor(
    private readonly registry: RoomRegistry,
    options: { flushTimeoutMs?: number } = {},
  ) {
    this.flushTimeoutMs = options.flushTimeoutMs ?? SESSION_FLUSH_TIMEOUT_MS;
  }

  connect(room: string): SessionRoom {
    const lease = this.registry.acquire(room);
    return { doc: lease.doc, provider: new LeaseProvider(lease, this.flushTimeoutMs) };
  }
}

class LeaseProvider implements SessionProvider {
  constructor(
    private readonly lease: RoomLease,
    private readonly flushTimeoutMs: number,
  ) {}

  get synced(): boolean {
    return this.lease.synced;
  }

  get awareness(): awarenessProtocol.Awareness {
    return this.lease.awareness;
  }

  on(event: 'sync', handler: (isSynced: boolean) => void): void {
    this.lease.on(event, handler);
  }

  off(event: 'sync', handler: (isSynced: boolean) => void): void {
    this.lease.off(event, handler);
  }

  flush(): Promise<boolean> {
    return this.lease.flush(this.flushTimeoutMs);
  }

  /**
   * This session is done with the room — and the room may well not be done.
   *
   * ⚠ THE CURSOR GOES EVEN WHEN THE ROOM STAYS, which is the half a leave frame
   * cannot reach. The `Awareness` is the REGISTRY's now, shared by both consumers,
   * so it outlives the leaf closing whenever the publish queue is still holding
   * the same room — and the session's `user` state on it outlives the leaf with
   * it. Measured against a real server, on BOTH routes: with the queue holding the
   * room, a peer went on showing the departed user's cursor for the whole 45 s a
   * rig was willing to watch, and it would have gone on for ever, because
   * `y-protocols` renews a live local state every 15 s and so the peer's 30 s
   * staleness sweep never fires. On master this could not happen — the session had
   * its own private provider and its own socket, and closing the leaf closed it.
   *
   * Announced BEFORE the reference goes back: after it, the room may already be
   * torn down and there is no connection left to say it on.
   *
   * Only the SESSION's port does this. `RegistryDocPort.close` deliberately does
   * not: the headless path never sets a local state, so a removal from there would
   * do nothing at all except on the one occasion it would do harm — wiping the
   * cursor of a session that is bound to the same room right now.
   */
  destroy(): void {
    try {
      awarenessProtocol.removeAwarenessStates(
        this.lease.awareness,
        [this.lease.doc.clientID],
        'local',
      );
    } catch {
      /* an awareness that is already gone has nothing to announce */
    }
    this.lease.release();
  }
}

/**
 * Resolves TRUE only on a GENUINE sync event. A timeout is not a sync (I3/I4).
 *
 * The same shape `ObsidianDocPort.waitSync` had, moved rather than rewritten.
 */
function waitSync(lease: RoomLease, ms: number): Promise<boolean> {
  if (lease.synced) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lease.off('sync', onSync);
      resolve(value);
    };
    const onSync = (isSynced: boolean): void => { if (isSynced) finish(true); };
    lease.on('sync', onSync);
    const timer = setTimeout(() => finish(lease.synced), ms);
  });
}
