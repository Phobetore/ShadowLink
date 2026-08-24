// src/sync/PublishQueue.ts
// Content publication (spec §6.2): the step that puts a local note's first bytes
// into its content document and then marks the node published.
//
// This is the only writer of a content doc's initial state outside an editing
// session, and getting it wrong is not recoverable by a later pass, so three
// invariants shape everything below.
//
// I5 — ONLY THE CREATOR PUBLISHES. Two devices seeding one content doc do not
// conflict: their inserts are disjoint Yjs items, so the merge keeps BOTH and
// every peer's note ends up holding the note twice. `owned[id]` is therefore
// checked when the entry is queued AND again when it is drained, and a doc that
// already holds text is left exactly as it is.
//
// I4 — NEVER SEED A DOC YOU HAVE NOT PROVEN SYNCED. `openHeadless` reports
// whether a genuine provider sync happened; a timeout reports an EMPTY document
// that is not empty on the server, and seeding into that produces the same
// doubling on reconnect. An unsynced doc is a retry, never a publish.
//
// I17 — CONFIRM, THEN ADVANCE. `s` and `contentHash` both assert "the workspace
// holds this content now". They are written only after `flush` has confirmed the
// round trip, because a node whose `s` is set is never offered for publication
// again by anybody — a premature `s` is permanent content loss, not a retry.
//
// Failure policy: an entry is never silently dropped. Every failure charges one
// step of the backoff ladder, the entry stays `pending`, and the whole ladder
// lives in device state, so a laptop that sleeps mid-queue resumes where it
// stopped instead of restarting or forgetting. An entry that has run off the end
// of the ladder is surfaced through `stalled()` and still retried.
//
// No `obsidian` import, no node builtins.

import { PUBLISH_BACKOFF_MS, PUBLISH_CONCURRENCY } from '../tree/constants.ts';
import { hashOf } from '../tree/paths.ts';
import type { TreeDoc } from '../tree/TreeDoc.ts';
import type { DeviceState } from './DeviceState.ts';
import type { DocHandle, DocPort } from './DocPort.ts';
import { RetryLater } from './Reconciler.ts';
import type { VaultPort } from './VaultPort.ts';

// ============================================================ public surface

export interface PublishQueueDeps {
  docs: DocPort;
  vault: VaultPort;
  state: DeviceState;
  /** Written only to set `s` on a node whose content is confirmed published. */
  tree: TreeDoc;
  /** The nodeId currently bound in an editor, or null (I7). Read per item. */
  openNodeId: () => string | null;
  now?: () => number;
  concurrency?: number;
  backoff?: number[];
}

export class PublishQueue {
  private readonly deps: PublishQueueDeps;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly backoff: number[];

  /** In flight, so a re-entrant `drain()` joins the running one (spec §6.2). */
  private draining: Promise<void> | null = null;

  /** Last error per still-pending id. Diagnostics only; never drives control flow. */
  private readonly errors = new Map<string, unknown>();

  constructor(deps: PublishQueueDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
    this.concurrency = Math.max(1, deps.concurrency ?? PUBLISH_CONCURRENCY);
    // Copied, so a caller's array cannot be mutated underneath a running drain.
    const ladder = deps.backoff ?? PUBLISH_BACKOFF_MS;
    this.backoff = ladder.length > 0 ? [...ladder] : [0];
  }

  /**
   * Queue a node for publication.
   *
   * A node this device does not own is refused HERE rather than accepted and
   * dropped later (I5): no entry means nothing to explain away, and nothing for a
   * later restart to find and act on. An entry that already exists is left
   * untouched — re-queueing must not reset a backoff, or a caller that enqueues
   * on every reconcile pass defeats the ladder entirely.
   */
  enqueue(nodeId: string): void {
    const data = this.deps.state.data;
    if (data.owned[nodeId] !== true) return;
    if (data.publish[nodeId] !== undefined) return;
    data.publish[nodeId] = { state: 'pending', attempts: 0, nextAt: 0 };
    this.deps.state.schedulePersist();
  }

  /** Entries still owed work, whether or not they are due yet. */
  pendingCount(): number {
    let n = 0;
    for (const entry of Object.values(this.deps.state.data.publish)) {
      if (entry.state === 'pending') n += 1;
    }
    return n;
  }

  /**
   * Pending ids that have exhausted the ladder and are now retrying at its last
   * rung — spec §6.2's "a permanently failing publish appears in diagnostics".
   * They are still retried; this only makes them visible.
   */
  stalled(): string[] {
    const out: string[] = [];
    for (const [id, entry] of Object.entries(this.deps.state.data.publish)) {
      if (entry.state === 'pending' && entry.attempts >= this.backoff.length) out.push(id);
    }
    return out.sort(compare);
  }

  /** The most recent error recorded for `nodeId`, for a diagnostics panel. */
  lastError(nodeId: string): unknown {
    return this.errors.get(nodeId);
  }

  /**
   * Publish everything that is pending and due. Called by the reconciler's step 7.
   *
   * Single-flight: a call arriving while a drain is running joins it instead of
   * starting a second pass over the same entries, which would open every room
   * twice and race two seeds of one document against each other.
   */
  drain(): Promise<void> {
    if (this.draining === null) this.draining = this.runAndClear();
    return this.draining;
  }

  // ============================================================ internals

  private async runAndClear(): Promise<void> {
    try {
      await this.runDrain();
    } finally {
      this.draining = null;
    }
  }

  private async runDrain(): Promise<void> {
    const data = this.deps.state.data;
    const at = this.now();
    const due: string[] = [];
    for (const id of Object.keys(data.publish).sort(compare)) {
      const entry = data.publish[id];
      if (entry.state === 'pending' && entry.nextAt <= at) due.push(id);
    }

    // A fixed pool rather than a chunked batch: one slow room must not hold four
    // slots idle while it finishes.
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= due.length) return;
        await this.publishOne(due[i]);
      }
    };
    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < Math.min(this.concurrency, due.length); i++) workers.push(worker());
    await Promise.all(workers);

    // The ladder is only useful if it survives a restart, so it is written out at
    // the end of every drain rather than left to the debounce.
    try {
      await this.deps.state.flush();
    } catch (err) {
      this.deps.state.lastPersistError = err;
    }
  }

  /** Spec §6.2's `publishOne`. Never throws: a failure is a backoff, not an abort. */
  private async publishOne(id: string): Promise<void> {
    const state = this.deps.state;
    const data = state.data;
    const entry = data.publish[id];
    if (entry === undefined || entry.state !== 'pending') return;

    // I5. Re-checked here and not only in `enqueue`, because this entry may have
    // been read back from a state file written before ownership was resolved.
    // Left exactly as it is: refusing is not failing, so it costs no backoff step,
    // and `pendingCount()` keeps reporting it rather than dropping it.
    if (data.owned[id] !== true) return;

    // I7. The editing session seeds a note it has open, and a second writer under
    // a live yCollab binding is exactly the whole-document overwrite that
    // invariant exists to prevent. Deferring is not a failure either — charging a
    // backoff step here would park the publish for minutes after the user simply
    // closed the tab — so nothing at all is touched, not even the disk.
    if (this.deps.openNodeId() === id) return;

    const path = data.materialized[id];
    if (path === undefined || path === '') {
      // The reconciler has not bound this node to a file yet (or the binding was
      // dropped because the file went missing). Genuinely "not now": kept, behind
      // a backoff so it cannot hot-loop once per pass for ever.
      this.fail(id, new RetryLater(`no local file is bound to ${id}`));
      return;
    }

    let handle: DocHandle | null = null;
    try {
      const text = normLF(await this.deps.vault.read(path));
      const opened = await this.deps.docs.openHeadless(`n_${id}`);
      handle = opened.handle;

      if (!opened.synced) throw new RetryLater(`content doc n_${id} did not sync`);

      const remote = normLF(opened.text);
      if (remote.length === 0 && text.length > 0) {
        const inserted = await this.deps.docs.insertIfEmpty(handle, text);
        if (!inserted) {
          // The doc gained content between the open and the insert. We no longer
          // know what it holds, and guessing would record a contentHash for text
          // that is not there. Retry: the next attempt reads the real remote.
          throw new RetryLater(`content doc n_${id} was seeded concurrently`);
        }
      }

      // I17: the round trip, before either watermark.
      if (!(await this.deps.docs.flush(handle))) {
        throw new RetryLater(`content doc n_${id} was not confirmed`);
      }

      this.deps.tree.patchNode(id, { s: 1 });
      // Whatever is actually in the document is what this device has confirmed —
      // the local text when we seeded it, the remote text when a peer had already
      // published. Never the local copy in the second case.
      const published = remote.length === 0 ? text : remote;
      data.contentHash[id] = { sha256: await hashOf(published), len: published.length };
      data.publish[id] = { state: 'done', attempts: 0, nextAt: 0 };
      this.errors.delete(id);
    } catch (err) {
      this.fail(id, err);
    } finally {
      if (handle !== null) this.deps.docs.close(handle);
    }
  }

  /** Charge one rung of the ladder, capped at the last one. The entry stays pending. */
  private fail(id: string, err: unknown): void {
    const data = this.deps.state.data;
    const entry = data.publish[id];
    if (entry === undefined) return;
    const attempts = entry.attempts + 1;
    const step = this.backoff[Math.min(attempts, this.backoff.length) - 1];
    data.publish[id] = { state: 'pending', attempts, nextAt: this.now() + step };
    this.errors.set(id, err);
  }
}

// ============================================================ helpers

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** I18: compare and hash on normalized line endings; never write the result to disk. */
function normLF(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
