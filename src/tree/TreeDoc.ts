// src/tree/TreeDoc.ts
// Typed wrapper over the Yjs tree document (spec §2.2): `meta` plus a
// `nodes` map of nodeId -> nested Y.Map of one-character fields.
//
// The nesting is load-bearing. A plain object value would make the whole node
// one LWW register, so a concurrent rename (`n`) and move (`d`) would lose one
// of the two. Nested Y.Maps give per-KEY LWW, which is what makes the assigned
// hard case converge to what both users intended (spec §1.3).
//
// This module must stay free of `obsidian` imports so the reconciler tests can
// run headless, and free of node builtins so it runs on Obsidian mobile.

import * as Y from 'yjs';
import type { NodeFields, TreeMeta } from './types.ts';
import { newNodeId } from './ids.ts';

/**
 * Transaction origin marking a write made by THIS client.
 *
 * It is an OPTIMIZATION, not the correctness mechanism (invariant I9): observers
 * always run, whatever the origin. A local origin only lets the reconciler skip
 * a pass it knows it already performed.
 */
export const LOCAL_ORIGIN: symbol = Symbol('shadowlink.tree.local');

/** The schema version this client understands. A higher `meta.v` => read-only. */
const SCHEMA_VERSION = 1;

/**
 * Every field the node model defines (spec §2.2). Reads and writes go through
 * this list so an unknown key written by a future schema is never echoed back
 * into a NodeFields object, and never silently dropped from the doc either.
 */
const NODE_FIELD_KEYS = ['k', 'd', 'n', 'g', 'c', 's', 'x', 'xa', 'xb', 'xh', 'xp'] as const;

/**
 * A partial node write. A key present with the value `undefined` DELETES that
 * key rather than storing an undefined — resurrect clears `x`/`xp` this way, and
 * `isLive` tests `x === undefined`.
 */
export interface NodePatch extends Partial<NodeFields> {}

/** Read a node's Y.Map into a plain object, omitting absent fields. */
function readFields(m: Y.Map<unknown>): NodeFields {
  const out: Record<string, unknown> = {};
  for (const key of NODE_FIELD_KEYS) {
    const v = m.get(key);
    if (v !== undefined) out[key] = v;
  }
  return out as unknown as NodeFields;
}

export class TreeDoc {
  readonly doc: Y.Doc;

  private readonly metaMap: Y.Map<unknown>;
  private readonly nodesMap: Y.Map<Y.Map<unknown>>;
  private readonly subscribers = new Set<(isLocal: boolean) => void>();

  /**
   * The transaction most recently reported to subscribers. `meta` and `nodes`
   * are separate observers, so one transaction touching both would otherwise
   * notify twice; a subscriber must see exactly one callback per transaction.
   */
  private lastNotified: Y.Transaction | null = null;

  /**
   * Optional sink for an exception thrown by an `observe` subscriber. Set by the
   * plugin so a failing consumer is surfaced rather than swallowed; left unset in
   * tests that deliberately throw.
   */
  onSubscriberError?: (err: unknown) => void;

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.metaMap = doc.getMap<unknown>('meta');
    this.nodesMap = doc.getMap<Y.Map<unknown>>('nodes');

    // observeDeep, not observe: a patch mutates a NESTED node map, which the
    // shallow observer on `nodes` would never see.
    this.nodesMap.observeDeep((_events, txn) => { this.notify(txn); });
    this.metaMap.observe((_event, txn) => { this.notify(txn); });
  }

  // ------------------------------------------------------------------ meta

  /** Set `{ v: 1 }` if — and only if — no version is recorded yet. */
  initMeta(): void {
    if (this.metaMap.get('v') !== undefined) return;
    this.transactLocal(() => { this.metaMap.set('v', SCHEMA_VERSION); });
  }

  getMeta(): TreeMeta | null {
    if (this.metaMap.size === 0) return null;
    const out: Record<string, unknown> = {};
    for (const key of ['v', 'claim'] as const) {
      const v = this.metaMap.get(key);
      if (v !== undefined) out[key] = v;
    }
    return out as unknown as TreeMeta;
  }

  /** True when the doc was written by a newer schema than this client speaks. */
  isFutureSchema(): boolean {
    const v = this.metaMap.get('v');
    return typeof v === 'number' && v > SCHEMA_VERSION;
  }

  // ----------------------------------------------------------------- nodes

  /** Snapshot every node as a plain object. Order is unspecified; callers sort. */
  entries(): Array<[string, NodeFields]> {
    const out: Array<[string, NodeFields]> = [];
    this.nodesMap.forEach((m, id) => { out.push([id, readFields(m)]); });
    return out;
  }

  get(nodeId: string): NodeFields | null {
    const m = this.nodesMap.get(nodeId);
    return m === undefined ? null : readFields(m);
  }

  size(): number {
    return this.nodesMap.size;
  }

  /**
   * Mint a node. `g` defaults to 1 and `c` to `now`; both are overridable so a
   * bootstrap or resurrect can carry forward the values it already decided on.
   * The whole node is written in one transaction, so observers see one change.
   */
  createNode(
    fields: Omit<NodeFields, 'g' | 'c'> & { g?: number; c?: number },
    now: number,
  ): string {
    const id = newNodeId();
    const source = fields as Record<string, unknown>;
    const initial: Array<[string, unknown]> = [];
    for (const key of NODE_FIELD_KEYS) {
      if (key === 'g' || key === 'c') continue;
      const v = source[key];
      if (v !== undefined) initial.push([key, v]);
    }
    initial.push(['g', fields.g ?? 1], ['c', fields.c ?? now]);

    this.transactLocal(() => {
      // Pre-populated before insertion, so the node is never briefly empty.
      this.nodesMap.set(id, new Y.Map<unknown>(initial));
    });
    return id;
  }

  /**
   * Merge a patch into an existing node, touching only the keys the patch
   * carries. A no-op when the node is absent — a concurrent peer may have
   * removed it, and re-creating it here would resurrect a node by accident.
   */
  patchNode(nodeId: string, patch: NodePatch): void {
    const m = this.nodesMap.get(nodeId);
    if (m === undefined) return;
    this.transactLocal(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) m.delete(key);
        else m.set(key, value);
      }
    });
  }

  /** Run several mutations inside ONE transaction tagged LOCAL_ORIGIN. */
  transactLocal(fn: () => void): void {
    this.doc.transact(fn, LOCAL_ORIGIN);
  }

  // --------------------------------------------------------------- observe

  /**
   * Subscribe to any change of `nodes` or `meta`, local or remote (I9). The
   * callback receives whether the transaction came from this client.
   */
  observe(cb: (isLocal: boolean) => void): () => void {
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }

  private notify(txn: Y.Transaction): void {
    if (this.lastNotified === txn) return;
    this.lastNotified = txn;
    const isLocal = txn.origin === LOCAL_ORIGIN;
    // Copy: a subscriber is allowed to unsubscribe from inside its callback.
    //
    // Each callback is isolated. A throwing subscriber must not starve the ones
    // registered after it, and must not propagate out of the Yjs transaction that
    // is applying a remote update — invariant I9 says handlers always run, so one
    // failing consumer cannot be allowed to silence structural sync for the rest.
    for (const cb of [...this.subscribers]) {
      try {
        cb(isLocal);
      } catch (err) {
        this.onSubscriberError?.(err);
      }
    }
  }

  // ----------------------------------------------------------------- state

  /** Full state as an update, for the local tree snapshot (spec §2.6). */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** Merge an update. Untagged, so observers report it as remote. */
  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }
}
