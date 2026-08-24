// src/sync/Tickets.ts
// Single-shot, TTL-bounded echo suppression (spec §4.1/§4.3).
//
// When the reconciler mutates the vault, Obsidian fires the corresponding vault
// event. Without a ticket the watcher would read that event as a user action and
// write it straight back into the tree. A ticket is an expectation armed just
// before the mutation and consumed by the echo.
//
// The design is constrained almost entirely by invariant I9: tickets are an
// OPTIMIZATION, never the correctness mechanism. Handlers never mute, and they
// are idempotent with or without a ticket. Two consequences follow, and both are
// enforced here rather than left to callers:
//
//  - SINGLE-SHOT. One `arm` swallows exactly one echo. A ticket that could absorb
//    a second event would silently eat a real user action that happened to touch
//    the same path — the exact failure mode a global `applyingRemote` flag has.
//  - TTL-BOUNDED. A mutation whose echo never arrives (the OS coalesced it, the
//    app was closed, the write failed) must not leave a trap armed indefinitely.
//
// Matching is on `fold(path)`, because the echo comes back from a filesystem that
// may have normalized the case or the unicode form of what we wrote.
//
// No `obsidian` import, no node builtins.

import { fold } from '../tree/paths.ts';
import { TICKET_TTL_MS } from '../tree/constants.ts';

export type TicketOp = 'create' | 'rename' | 'delete';

/**
 * Key separator. NUL, because validateRel rejects control characters in a name,
 * so no real path can forge the key of a different (op, from, to) triple.
 */
const SEP = '\u0000';

export class Tickets {
  private readonly now: () => number;
  private readonly ttlMs: number;

  /**
   * key -> armedAt timestamps, oldest first. An array rather than a single value:
   * arming the same expectation twice must permit exactly two claims, because the
   * reconciler legitimately performs the same mutation twice in one pass (stage
   * out, stage in).
   */
  private readonly store = new Map<string, number[]>();

  constructor(now: () => number = () => Date.now(), ttlMs: number = TICKET_TTL_MS) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  arm(op: 'create' | 'delete', path: string): void;
  arm(op: 'rename', from: string, to: string): void;
  arm(op: TicketOp, a: string, b?: string): void {
    const key = this.keyOf(op, a, b);
    const bucket = this.store.get(key);
    if (bucket) bucket.push(this.now());
    else this.store.set(key, [this.now()]);
  }

  /**
   * Consume one matching, unexpired ticket. Returns false if none is armed.
   *
   * A non-matching claim consumes nothing: a ticket must never be spent by an
   * event it was not armed for.
   */
  claim(op: 'create' | 'delete', path: string): boolean;
  claim(op: 'rename', from: string, to: string): boolean;
  claim(op: TicketOp, a: string, b?: string): boolean {
    const key = this.keyOf(op, a, b);
    const bucket = this.store.get(key);
    if (bucket === undefined) return false;

    // Opportunistically discard the expired head entries we walk over. Consuming
    // oldest-first means a stale ticket is spent (and dropped) before a fresh one
    // rather than being banked behind it.
    const cutoff = this.now() - this.ttlMs;
    let i = 0;
    while (i < bucket.length && bucket[i] <= cutoff) i++;

    if (i >= bucket.length) {
      this.store.delete(key);
      return false;
    }
    bucket.splice(0, i + 1);            // drop the expired prefix AND the claimed ticket
    if (bucket.length === 0) this.store.delete(key);
    return true;
  }

  /** Drop every expired ticket. Called opportunistically; claims prune their own key. */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, bucket] of this.store) {
      const kept = bucket.filter((at) => at > cutoff);
      if (kept.length === 0) this.store.delete(key);
      else this.store.set(key, kept);
    }
  }

  /** Drop every armed ticket. Runs in the reconciler's `finally`, so a crashed pass leaves no traps. */
  clearArmed(): void {
    this.store.clear();
  }

  /** Tickets currently held, expired-but-unswept ones included. */
  size(): number {
    let total = 0;
    for (const bucket of this.store.values()) total += bucket.length;
    return total;
  }

  private keyOf(op: TicketOp, a: string, b?: string): string {
    return `${op}${SEP}${fold(a)}${SEP}${b === undefined ? '' : fold(b)}`;
  }
}
