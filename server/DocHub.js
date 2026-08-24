// server/DocHub.js
// One Y.Doc + Awareness per document name. Relays the standard Yjs sync and
// awareness protocols over binary WebSocket frames and persists a snapshot.
// This is the canonical y-websocket server logic, kept small and testable.

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { join, dirname } from 'node:path';
import {
  mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync,
} from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/**
 * Trailing window for the snapshot debounce (spec §1.5). The tree doc is hot and
 * grows monotonically, so a full-state serialization on every update would block
 * the relay for every other room.
 */
const PERSIST_DEBOUNCE_MS = 2000;

export class DocHub {
  constructor(dataDir, options = {}) {
    this.baseDir = join(dataDir, 'yjs');
    mkdirSync(this.baseDir, { recursive: true });
    // docName → { doc: Y.Doc, awareness, conns: Map<conn, Set<number>> }
    this.docs = new Map();

    this.persistDebounceMs = options.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;
    // docName → { timer, doc }. A timer that is already armed is NOT restarted by
    // a later update: a classic reset-on-every-event debounce never fires at all
    // under a continuous stream, which is exactly the traffic shape the tree doc
    // has during a folder rename. Arming once and firing at the end of the window
    // bounds the wait to persistDebounceMs no matter how busy the room is.
    this._persistTimers = new Map();
    // docName → Promise. Writes for one docName are serialized so two encoders
    // can never race the same `<p>.tmp`.
    this._persistChain = new Map();
    // docName → number of snapshot writes actually issued. Diagnostic only.
    this._persistCounts = new Map();
    /** Last write error per docName, for diagnostics. Never thrown at a caller. */
    this.lastPersistError = new Map();
  }

  _snapshotPath(docName) {
    // docName === `${workspaceId}/${docId}`; both are charset-validated upstream.
    return join(this.baseDir, `${docName}.bin`);
  }

  _getDocState(docName) {
    const existing = this.docs.get(docName);
    if (existing) return existing;

    const doc = new Y.Doc();
    const snap = this._snapshotPath(docName);
    // A `.tmp` left behind is a write that never reached its rename — by
    // construction an incomplete snapshot, and never the file to load. Remove it
    // so a crashed write cannot accumulate, and load the last COMPLETE snapshot.
    try {
      rmSync(`${snap}.tmp`, { force: true });
    } catch {
      /* a tmp we cannot remove is still never read; carry on */
    }
    if (existsSync(snap)) Y.applyUpdate(doc, readFileSync(snap));

    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    // Awareness installs a setInterval to expire stale states. In a long-lived
    // server the WebSocket server keeps the event loop alive; in a bare process
    // (tests) this timer is the only handle left and would block exit. unref it
    // so it never holds the loop open on its own — protocol behavior unchanged.
    awareness._checkInterval?.unref?.();

    const state = { doc, awareness, conns: new Map() };

    doc.on('update', (update) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      state.conns.forEach((_ids, conn) => this._send(state, conn, msg));
      this._persist(docName, doc);
    });

    awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      const ids = state.conns.get(origin);
      if (ids) {
        added.forEach((id) => ids.add(id));
        removed.forEach((id) => ids.delete(id));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      const msg = encoding.toUint8Array(enc);
      state.conns.forEach((_ids, conn) => this._send(state, conn, msg));
    });

    this.docs.set(docName, state);
    return state;
  }

  handleConnection(conn, docName) {
    const state = this._getDocState(docName);
    state.conns.set(conn, new Set());

    conn.on('message', (data) => {
      try {
        this._onMessage(state, conn, new Uint8Array(data));
      } catch {
        /* malformed frame — ignore, never crash the process */
      }
    });
    conn.on('close', () => this._closeConn(docName, state, conn));
    conn.on('error', () => this._closeConn(docName, state, conn));

    // Server → client: SyncStep1.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, state.doc);
    this._send(state, conn, encoding.toUint8Array(enc));

    // Server → client: existing awareness states, if any.
    const states = state.awareness.getStates();
    if (states.size > 0) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        aenc,
        awarenessProtocol.encodeAwarenessUpdate(state.awareness, Array.from(states.keys())),
      );
      this._send(state, conn, encoding.toUint8Array(aenc));
    }
  }

  _onMessage(state, conn, data) {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, enc, state.doc, conn);
      if (encoding.length(enc) > 1) this._send(state, conn, encoding.toUint8Array(enc));
    } else if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(state.awareness, decoding.readVarUint8Array(decoder), conn);
    }
  }

  _send(state, conn, message) {
    // ws readyState: CONNECTING 0, OPEN 1, CLOSING 2, CLOSED 3.
    if (conn.readyState !== undefined && conn.readyState !== 0 && conn.readyState !== 1) return;
    try {
      conn.send(message);
    } catch {
      this._closeConn(null, state, conn);
    }
  }

  _closeConn(docName, state, conn) {
    const ids = state.conns.get(conn);
    if (!ids) return;
    state.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(state.awareness, Array.from(ids), null);
    try {
      conn.close();
    } catch {
      /* already closed */
    }
    if (docName && state.conns.size === 0) {
      // The last peer left: nothing will arrive to trigger the debounced write,
      // so flush now rather than leaving the tail of the session unwritten.
      void this.flush(docName);
      // P0: doc stays resident. Flush-then-destroy on last leave is P3/P4.
    }
  }

  // ------------------------------------------------------------- persistence

  /** Schedule a snapshot write for `docName` (spec §1.5: 2 s trailing debounce). */
  _persist(docName, doc) {
    if (this._persistTimers.has(docName)) return;          // already armed
    const timer = setTimeout(() => {
      this._persistTimers.delete(docName);
      void this._enqueueWrite(docName, doc);
    }, this.persistDebounceMs);
    // A pending snapshot timer must never be the only reason the process stays
    // alive — the same reasoning as the awareness interval above. The WebSocket
    // server keeps the loop open in production; `flush`/`flushAllSync` cover the
    // shutdown path.
    timer.unref?.();
    this._persistTimers.set(docName, { timer, doc });
  }

  /**
   * Cancel any pending debounce for `docName` and write now. Resolves once the
   * write (and every write queued before it) has landed. Never rejects.
   */
  async flush(docName) {
    const pending = this._persistTimers.get(docName);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this._persistTimers.delete(docName);
    }
    const state = this.docs.get(docName);
    if (state === undefined) {
      await (this._persistChain.get(docName) ?? Promise.resolve());
      return;
    }
    await this._enqueueWrite(docName, state.doc);
  }

  /** Flush every resident doc. Awaits them all; never rejects. */
  async flushAll() {
    await Promise.all([...this.docs.keys()].map((docName) => this.flush(docName)));
  }

  /**
   * Synchronous last-resort flush, for a process that is on its way out and
   * cannot await anything. Still atomic: temp file, then rename.
   */
  flushAllSync() {
    for (const [docName, state] of this.docs) {
      const pending = this._persistTimers.get(docName);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this._persistTimers.delete(docName);
      }
      try {
        const p = this._snapshotPath(docName);
        const tmp = `${p}.tmp`;
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(tmp, Buffer.from(Y.encodeStateAsUpdate(state.doc)));
        renameSync(tmp, p);
        this._persistCounts.set(docName, this.writeCount(docName) + 1);
      } catch (err) {
        this.lastPersistError.set(docName, err);
      }
    }
  }

  /** Snapshot writes issued for `docName` so far. Test/diagnostic helper. */
  writeCount(docName) {
    return this._persistCounts.get(docName) ?? 0;
  }

  /** Drop every armed timer without writing. For tests and for teardown. */
  cancelPending() {
    for (const { timer } of this._persistTimers.values()) clearTimeout(timer);
    this._persistTimers.clear();
  }

  /**
   * Serialize writes per docName. A rejected predecessor must not poison the
   * chain, or one ENOSPC would disable persistence for that room for the rest of
   * the process's life.
   */
  _enqueueWrite(docName, doc) {
    const previous = this._persistChain.get(docName) ?? Promise.resolve();
    const next = previous.then(
      () => this._writeSnapshot(docName, doc),
      () => this._writeSnapshot(docName, doc),
    ).catch((err) => {
      this.lastPersistError.set(docName, err);
    });
    this._persistChain.set(docName, next);
    return next;
  }

  /**
   * Atomic snapshot write (spec §1.5). `writeFileSync(p, ...)` truncates `p`
   * first, so a kill or a full disk mid-write leaves a SHORT file; the next
   * `Y.applyUpdate` then throws and the tree doc reads as empty, which every
   * client interprets as "this workspace was never initialized". Writing a temp
   * file and renaming it over the snapshot means a reader only ever sees a
   * complete file — the old one or the new one.
   *
   * The state is encoded HERE rather than at schedule time, so a debounced write
   * always persists the newest state rather than the state at the first update
   * of the window.
   */
  async _writeSnapshot(docName, doc) {
    const p = this._snapshotPath(docName);
    const tmp = `${p}.tmp`;
    await mkdir(dirname(p), { recursive: true });
    await writeFile(tmp, Buffer.from(Y.encodeStateAsUpdate(doc)));
    await rename(tmp, p);
    this._persistCounts.set(docName, this.writeCount(docName) + 1);
  }

  // Test/diagnostic helper.
  getText(docName, field = 'content') {
    return this._getDocState(docName).doc.getText(field).toString();
  }
}
