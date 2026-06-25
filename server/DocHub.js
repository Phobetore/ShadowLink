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
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export class DocHub {
  constructor(dataDir) {
    this.baseDir = join(dataDir, 'yjs');
    mkdirSync(this.baseDir, { recursive: true });
    // docName → { doc: Y.Doc, awareness, conns: Map<conn, Set<number>> }
    this.docs = new Map();
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
      this._persist(docName, state.doc);
      // P0: doc stays resident. Flush-then-destroy on last leave is P3/P4.
    }
  }

  _persist(docName, doc) {
    const p = this._snapshotPath(docName);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Y.encodeStateAsUpdate(doc));
  }

  // Test/diagnostic helper.
  getText(docName, field = 'content') {
    return this._getDocState(docName).doc.getText(field).toString();
  }
}
