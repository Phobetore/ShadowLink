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
// I6 — AN EMPTY DOCUMENT IS NOT CONTENT. A flush of an empty doc round-trips
// perfectly and confirms nothing, and `s` is the whole definition of "published"
// for a note, so setting it there makes every peer materialize a 0-BYTE FILE on
// the canonical path — which looks correct, gets deleted by hand, and the hand
// deletion is a tombstone that propagates. Obsidian's "New note" is a 0-byte file,
// so this is the ordinary state of every note until its author types. Refusing to
// publish it is not refusing to have it: the node stays, peers list it as pending,
// and the entry stays queued for the drain after its first byte lands.
//
// P2 adds a second arm, `publishBlobOne` (spec §3.2), which publishes an
// ATTACHMENT's bytes into the content-addressed store instead of a note's text
// into a content doc. The same three invariants govern it, in a different shape:
//
//  * I17 becomes "upload, then re-ASK". `put` resolving true is the client's own
//    account of a round trip; only a fresh `has()` is the store's. `s` and `b` are
//    written together, in ONE transaction, and only after that second answer.
//  * The bytes must have SETTLED first. Two `stat`s separated by
//    ATTACHMENT_SETTLE_MS must agree on size AND mtime, because Obsidian fires
//    `create` when a file appears rather than when it is complete.
//  * A file that can NEVER be published — over the device's memory cap or the
//    server's — is RETRACTED rather than left pending for ever on every peer. The
//    node is tombstoned, the path is recorded in `oversized`, the user is told
//    once, and the file is left exactly where they put it: not moved, not deleted,
//    and unbound, so no later deletion pass can mistake it for a file a tombstone
//    is entitled to remove. That is the FIRST publish. A size refusal on a node
//    that is already published refuses the BYTES instead and leaves the node
//    alone: peers hold that file, and a tombstone on it is a remote delete of the
//    last good version, not a refusal to share a new one.
//
// Failure policy: an entry is never silently dropped. Every failure charges one
// step of the backoff ladder, the entry stays `pending`, and the whole ladder
// lives in device state, so a laptop that sleeps mid-queue resumes where it
// stopped instead of restarting or forgetting. An entry that has run off the end
// of the ladder is surfaced through `stalled()` and still retried.
//
// No `obsidian` import, no node builtins.

import {
  ATTACHMENT_SETTLE_MS,
  BLOB_PUBLISH_CONCURRENCY,
  PUBLISH_BACKOFF_MS,
  PUBLISH_CONCURRENCY,
} from '../tree/constants.ts';
import {
  fold, formatBlobRef, hashOf, hashOfBytes, isLive, parseBlobRef,
} from '../tree/paths.ts';
import type { TreeDoc } from '../tree/TreeDoc.ts';
import type { NodeFields } from '../tree/types.ts';
import { BlobQuotaExceeded, BlobTooLarge, type BlobPort } from './BlobPort.ts';
import type { DeviceState, PublishEntry } from './DeviceState.ts';
import type { DocHandle, DocPort } from './DocPort.ts';
import { publishVerdict } from './FetchPolicy.ts';
import { RetryLater } from './Reconciler.ts';
import type { VaultPort } from './VaultPort.ts';

// ============================================================ public surface

/**
 * Why a pending entry is not work.
 *
 * Three refusals, worded differently to the user because they call for different
 * things: `'empty'` ends when the author types, `'empty-attachment'` when
 * something writes bytes into the file, `'not-text'` when somebody renames it.
 * None of them ends by waiting, which is why none of them is "waiting to upload".
 *
 * `'empty-attachment'` is I6 on the attachment arm, said rather than inferred.
 * It used to be no refusal at all: a 0-byte attachment was rejected incidentally
 * by the settle check reading `st.bytes === 0` as "the writer has not finished",
 * so the rule held by accident, the diagnostic said something untrue, and the
 * entry charged the ladder and stayed counted for ever.
 */
export type ParkReason = 'empty' | 'empty-attachment' | 'not-text';

export interface PublishQueueDeps {
  docs: DocPort;
  vault: VaultPort;
  /** The attachment store (spec §8.3). Attachments are the only user of it here. */
  blobs: BlobPort;
  state: DeviceState;
  /** Written only to set `s` on a node whose content is confirmed published. */
  tree: TreeDoc;
  /** The nodeId currently bound in an editor, or null (I7). Read per item. */
  openNodeId: () => string | null;
  now?: () => number;
  concurrency?: number;
  /** Attachment publishes get their own, smaller pool (spec §8.4). */
  blobConcurrency?: number;
  backoff?: number[];
  /** This device's display name, written to a retracted node's `xb`. Display only. */
  displayName?: string;
  /** Told once when a file is too large to share (§3.2). */
  notice?: (msg: string) => void;
  /**
   * The largest attachment this device will hold in memory (§7.4). Injected as a
   * plain number so the engine never has to ask Obsidian what platform it is on.
   */
  memoryCapBytes: () => number;
  /** Injected only by tests, which need the settle window to be deterministic. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class PublishQueue {
  private readonly deps: PublishQueueDeps;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly blobConcurrency: number;
  private readonly backoff: number[];
  private readonly settleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** In flight, so a re-entrant `drain()` joins the running one (spec §6.2). */
  private draining: Promise<void> | null = null;

  /** Last error per still-pending id. Diagnostics only; never drives control flow. */
  private readonly errors = new Map<string, unknown>();

  /**
   * Nodes whose file turned out not to be text (§3.6), so the Notice is shown
   * once rather than on every drain. The refusal itself is recomputed every time:
   * this set only governs how loud it is.
   */
  private readonly seedRefused = new Set<string>();

  /**
   * Nodes the last drain REFUSED for a reason only the user's file can change.
   *
   * Refusing is not failing, so the entry stays `pending` and no rung of the
   * ladder is charged — and that has to stay true, because nothing else will
   * ever re-offer a note: `VaultWatcher.onModify` returns early for one, so the
   * 30-second retry cadence IS how an empty note publishes itself after the
   * first keystroke. Take the entry away and the note is never published again.
   *
   * But an entry in that state is not WORK. Nothing is uploading, nothing is
   * queued to upload, and nothing will change until the user types into the note
   * or renames the file. `pendingCount()` is what the status bar turns into
   * "ShadowLink: syncing… / N file(s) waiting to upload", and it never falls
   * back to `syncedStatus()` while that number is above zero — so counting these
   * pinned the bar on "syncing…" for the lifetime of the vault over one
   * permanently empty note, and publish entries are never pruned, so a note
   * created and deleted before its first character pinned it with nothing left
   * to look at.
   *
   * IN MEMORY, and re-decided by every drain rather than persisted. It is a
   * conclusion about a file, and a conclusion about a file goes stale the moment
   * the file changes; the only honest place to reach it is where the file is
   * read. The status bar therefore reports what the last pass found, which is
   * exactly what every other number on it reports.
   *
   * The line this must not cross: a note DEFERRED because the user has it open
   * (I7) is "not now", not "not ever" — closing the tab is all it takes, and the
   * file is full of the user's words meanwhile. That one stays counted.
   */
  private readonly parkedNodes = new Map<string, ParkReason>();

  /**
   * What the file looked like when it was parked, so `repark` can tell whether
   * it has moved without running a whole pass.
   */
  private readonly parkedStat = new Map<string, { bytes: number; mtime?: number }>();

  /**
   * Pending entries NOTHING can lift, and why — the third state, and its absence
   * is what left four of these counted for the lifetime of the vault.
   *
   * `parkedNodes` says "the user's file can lift this", and `repark` is how the
   * drain reaches one again. There was no way to say "nothing can lift this", so
   * a dead node, an entry for a node this device does not own and an attachment
   * deleted before it published all fell down paths that RETURN — correctly,
   * because none of them is a failure and none should charge a rung — and were
   * left `pending`, counted by `pendingCount()`, and offered to the user as
   * "N file(s) waiting to upload" for ever. Worse, since no rung was charged,
   * `stalled()` was empty and `lastError` was undefined, so they were invisible
   * in diagnostics too.
   *
   * IN MEMORY and re-decided by every drain, exactly like the park and for the
   * same reason: it is a conclusion about the tree and the state file, and a
   * conclusion goes stale the moment either moves. `repark` re-asks it too, so
   * an entry does not have to wait for some other note to create work before the
   * periodic tick can notice that ownership has arrived.
   *
   * NOT the status bar's business, and that is deliberate. `parked()` reaches the
   * tooltip because there is something the user can do; there is nothing to say
   * about a note that no longer exists beyond not claiming to be uploading it.
   */
  private readonly blockedNodes = new Map<string, string>();

  /**
   * The server's per-file ceiling, once this session has managed to ask for it.
   *
   * Cached rather than re-fetched per item, and NOT cached as a failure: `limits()`
   * throws on transport, and an unknown ceiling must never be treated as a small
   * one — that would retract a perfectly publishable file because the network
   * blinked. Until it is known the device cap is the only cap applied, and an
   * over-limit upload comes back as a 413 refusal, which is a backoff.
   */
  private serverMaxBytes: number | null = null;

  constructor(deps: PublishQueueDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
    this.concurrency = Math.max(1, deps.concurrency ?? PUBLISH_CONCURRENCY);
    this.blobConcurrency = Math.max(1, deps.blobConcurrency ?? BLOB_PUBLISH_CONCURRENCY);
    // Copied, so a caller's array cannot be mutated underneath a running drain.
    const ladder = deps.backoff ?? PUBLISH_BACKOFF_MS;
    this.backoff = ladder.length > 0 ? [...ladder] : [0];
    this.settleMs = deps.settleMs ?? ATTACHMENT_SETTLE_MS;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => { setTimeout(r, ms); }));
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

  /**
   * Repeatable admission (spec §3.2). Markdown publication is one-shot, so
   * `enqueue` refuses a node that already has an entry; an attachment's bytes can
   * change, so the same node has to be admissible again — but only for content it
   * has not already been queued for.
   *
   * `intent` is the sha256 of the bytes this entry is meant to publish. A matching
   * intent is a genuine no-op, whether the entry is pending or done, so a caller
   * that requeues on every reconcile pass cannot defeat the backoff ladder or
   * re-publish what is already published. Anything else — new bytes, or an entry
   * from the markdown path carrying no intent at all — restarts the ladder,
   * because it is new work.
   *
   * There is no ownership test here on purpose: the first publish of a node stays
   * creator-only and a replace does not (I5a), so that decision belongs where the
   * node's state can be read, not at the door.
   */
  requeue(nodeId: string, intent: string): void {
    const data = this.deps.state.data;
    const entry = data.publish[nodeId];
    // Both states are covered deliberately: pending means the ladder is already
    // running for these bytes, done means they are already published.
    if (entry !== undefined && entry.intent === intent) return;
    data.publish[nodeId] = { state: 'pending', attempts: 0, nextAt: 0, intent };
    // New bytes. Whatever the last drain refused was about the old ones, so the
    // entry counts as work again from this moment rather than from the drain
    // that re-examines it — this path HAS an event behind it (`onModify` for an
    // attachment), which is exactly what a note does not have.
    this.unpark(nodeId);
    this.deps.state.schedulePersist();
  }

  /**
   * Entries still owed work by THIS DEVICE, whether or not they are due yet.
   *
   * The status bar's number, and therefore a promise: every one of these is a
   * file that is going to be uploaded without the user doing anything. A parked
   * entry is not one — see `parkedNodes` — so it is excluded here and reported
   * by `parked()` instead.
   */
  pendingCount(): number {
    let n = 0;
    for (const [id, entry] of Object.entries(this.deps.state.data.publish)) {
      if (entry.state !== 'pending') continue;
      if (this.parkedNodes.has(id) || this.blockedNodes.has(id)) continue;
      n += 1;
    }
    return n;
  }

  /**
   * Pending ids the last drain found nothing could ever lift, with the reason.
   *
   * Diagnostics, not the status bar: unlike a parked entry there is no sentence
   * to put in front of the user, because there is nothing for them to do. The
   * point is that these stop being counted WITHOUT becoming invisible — they
   * carry a `lastError` too, which the paths that produce them did not set,
   * because none of them is a failure.
   */
  blocked(): Array<{ id: string; reason: string }> {
    const out: Array<{ id: string; reason: string }> = [];
    for (const [id, reason] of this.blockedNodes) {
      if (this.deps.state.data.publish[id]?.state === 'pending') out.push({ id, reason });
    }
    return out.sort((a, b) => compare(a.id, b.id));
  }

  /**
   * Pending ids the last drain refused over the state of the file itself — an
   * empty note (I6), or a `.md` node whose bytes are not text (§3.6).
   *
   * They are still retried; this is what keeps them from being invisible now
   * that they are out of `pendingCount()`. THE REASON TRAVELS WITH THEM because
   * the status bar words the two cases differently, and it has to: "it will be
   * shared as soon as you type in it" and "rename it to share it" are different
   * instructions to the user, and neither is "waiting to upload".
   */
  parked(): Array<{ id: string; reason: ParkReason }> {
    const out: Array<{ id: string; reason: ParkReason }> = [];
    for (const [id, reason] of this.parkedNodes) {
      if (this.deps.state.data.publish[id]?.state === 'pending') out.push({ id, reason });
    }
    return out.sort((a, b) => compare(a.id, b.id));
  }

  /**
   * Ask, cheaply, whether any parked entry's file has moved — and unpark it if
   * so. Returns whether anything was unparked.
   *
   * THIS IS THE OTHER HALF OF THE PARK, and leaving it out is what turned a
   * status-bar fix into permanent content loss. Nothing else in the plugin ever
   * re-offers a note: `VaultWatcher.onModify` returns early for one by design
   * (I7), so `main.ts`'s interval is the ONLY periodic drain there is, and that
   * interval asks `pendingCount() > 0`. Take parked entries out of that number
   * without giving the interval a second question and the drain can never reach
   * them again — an empty note publishes on the first keystroke and then never.
   *
   * A `stat` per parked entry, typically zero of them, rather than a full pass:
   * an idle vault holding one permanently empty note would otherwise pay a tree
   * derivation and a stat per attachment every 30 seconds for the life of the
   * vault. A `stat` that cannot answer LEAVES THE ENTRY PARKED (I2): "I could
   * not look" must never become "assume it changed", or an unhappy filesystem
   * becomes a drain that publishes nothing and re-parks on a 30-second cadence.
   */
  async repark(): Promise<boolean> {
    let woke = false;
    // The blocked half first, and it needs no `stat` at all: every reason an
    // entry is blocked is a fact about the tree or the state file, both of which
    // are in memory. Asking here rather than only inside a drain is what keeps a
    // vault where EVERY entry is blocked from needing some unrelated note to
    // create work before the tick can notice that ownership has arrived.
    for (const id of [...this.blockedNodes.keys()]) {
      if (this.deps.state.data.publish[id]?.state !== 'pending') {
        this.blockedNodes.delete(id);
        continue;
      }
      if (this.blockOf(id) !== null) continue;
      this.blockedNodes.delete(id);
      woke = true;
    }
    for (const [id, reason] of [...this.parkedNodes]) {
      if (this.deps.state.data.publish[id]?.state !== 'pending') {
        this.unpark(id);
        continue;
      }
      const path = this.deps.state.data.materialized[id];
      if (path === undefined || path === '') {
        // NOTHING TO `stat`, WHICH IS NOT THE SAME AS NOTHING TO SAY.
        //
        // Skipping outright is what left the status bar telling the user, for
        // the rest of the session, to type into a note they had deleted:
        // Obsidian's "New note" is parked `empty` (correctly), the user changes
        // their mind, and `VaultWatcher.writeTombstones` tombstones the node and
        // unbinds it inside a LOCAL tree transaction — which the tree observer
        // deliberately does not follow with a reconcile. From there `drainTick`
        // finds `pendingCount()` 0, falls to `repark()`, and `repark` skipped the
        // entry for want of a path: no drain is ever scheduled again, so
        // `publishOne` never runs, so `blockOf` never sees the tombstone, and the
        // park stayed — with "1 note is empty and has not been shared yet — it
        // will be shared as soon as you type" pointing at a file that does not
        // exist. Measured over 48 ticks: zero drains, and it accumulates one line
        // per untitled note the user ever thought better of.
        //
        // The question that needs no path is the one to ask here. `blockOf`
        // reads only the tree and the state file, both in memory, and answers
        // for exactly the states nothing can lift; `block()` unparks, so the
        // entry leaves the tooltip and takes `lastError` with it instead of
        // vanishing from diagnostics as well. An entry whose node is still live
        // stays parked, which is right: there the file may yet come back.
        const why = this.blockOf(id);
        if (why !== null) this.block(id, why);
        continue;
      }
      let st: Awaited<ReturnType<VaultPort['stat']>>;
      try {
        st = await this.deps.vault.stat(path);
      } catch {
        continue;                                        // I2: asked, not answered
      }
      if (st === null) continue;
      const was = this.parkedStat.get(id);
      // An empty note or attachment needs a byte in it; a file that is not text
      // needs to have been rewritten, and only its size and mtime can say so
      // from out here.
      const moved = reason === 'not-text'
        ? was === undefined || st.bytes !== was.bytes || st.mtime !== was.mtime
        : st.bytes > 0;
      if (!moved) continue;
      this.unpark(id);
      woke = true;
    }
    return woke;
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
   * Close an entry on behalf of the ONE writer of `s` that is not this queue:
   * the editing session, which owns a node it holds open (I7).
   *
   * `publishOne` DEFERS on such a node rather than failing, because a deferral
   * is "not now" and closing the tab is all it takes — so the entry stays
   * pending and stays counted. When the session publishes the note itself, that
   * stops being true, and nothing else can tell: the queue is forbidden from
   * touching a live document, so it would keep deferring, keep asking the
   * reconciler for a pass every 30 seconds, and keep the status bar on "1 file
   * waiting to upload", for as long as the note stays open.
   */
  markPublished(nodeId: string): void {
    if (this.deps.state.data.publish[nodeId] === undefined) return;
    this.markDone(nodeId);
    this.errors.delete(nodeId);
    this.deps.state.schedulePersist();
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
    const notes: string[] = [];
    const attachments: string[] = [];
    for (const id of Object.keys(data.publish).sort(compare)) {
      const entry = data.publish[id];
      if (entry.state !== 'pending' || entry.nextAt > at) continue;
      // Two lanes, sized separately (§8.4): a 200 MB video occupying every slot
      // would park the publication of every note behind it for the whole upload,
      // and the two kinds of work do not even contend for the same resource.
      if (this.deps.tree.get(id)?.k === 'b') attachments.push(id);
      else notes.push(id);
    }

    // A fixed pool rather than a chunked batch: one slow room must not hold four
    // slots idle while it finishes.
    const lane = (due: string[], width: number): Array<Promise<void>> => {
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
      for (let i = 0; i < Math.min(width, due.length); i++) workers.push(worker());
      return workers;
    };
    await Promise.all([
      ...lane(notes, this.concurrency),
      ...lane(attachments, this.blobConcurrency),
    ]);

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

    // The kind decides which arm runs, and it is read from the TREE rather than
    // from the path: `k` is written once at creation and never mutated, so it is
    // the only answer that cannot drift from what every peer sees. An attachment
    // must never reach the markdown arm below — `vault.read` would decode a PNG
    // to lossy UTF-8 and seed the mojibake into a `Y.Text` that is never
    // re-offered (§3.6).
    const fields = this.deps.tree.get(id);
    if (fields !== null && fields.k === 'b') {
      await this.publishBlobOne(id, fields);
      return;
    }

    // I7. The editing session seeds a note it has open, and a second writer under
    // a live yCollab binding is exactly the whole-document overwrite that
    // invariant exists to prevent. Deferring is not a failure either — charging a
    // backoff step here would park the publish for minutes after the user simply
    // closed the tab — so nothing at all is touched, not even the disk.
    //
    // Before the block below, because a deferral is "not now" and outranks every
    // conclusion drawn from a tree the session is actively writing into.
    if (this.deps.openNodeId() === id) return;

    // NOTHING CAN LIFT THIS — a node that is gone or dead, or one this device
    // has no business publishing (I5, re-checked here and not only in `enqueue`
    // because this entry may have been read back from a state file written
    // before ownership was resolved). Each of these already RETURNED, correctly:
    // none is a failure and none should charge a rung. What none of them did was
    // stop being counted.
    const why = this.blockOf(id, fields);
    if (why !== null) { this.block(id, why); return; }
    this.unblock(id);

    const path = data.materialized[id];
    if (path === undefined || path === '') {
      // The reconciler has not bound this node to a file yet (or the binding was
      // dropped because the file went missing).
      //
      // THE PARK IS LEFT EXACTLY WHERE IT IS, and the order of these two
      // statements is the whole of it. Unparking first meant an entry whose
      // file had gone — a note created and deleted before its first character,
      // which is the case this park's own comment names — was unparked, failed,
      // left pending and counted for ever, and no later `repark()` could reach
      // it because `repark` skips an entry with no bound path (correctly: there
      // is nothing to `stat`). The two halves this round built contradicted each
      // other and the drain won, on a code path every reconcile pass runs.
      this.fail(id, new RetryLater(`no local file is bound to ${id}`));
      return;
    }

    // Past every deferral AND past the path, so this attempt is genuinely going
    // to look at the file. Whatever the last drain concluded about it stops
    // being current here, and is re-established below only if this attempt
    // reaches the same refusal.
    this.unpark(id);

    let handle: DocHandle | null = null;
    try {
      const raw = await this.deps.vault.read(path);
      if (!(await this.roundTrips(id, path, raw))) return;
      const text = toLF(raw);
      const opened = await this.deps.docs.openHeadless(`n_${id}`);
      handle = opened.handle;

      if (!opened.synced) throw new RetryLater(`content doc n_${id} did not sync`);

      const remote = toLF(opened.text);
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

      // What the WORKSPACE is confirmed to hold: the local text where we seeded
      // it, the remote text where a peer had already published. Never the local
      // copy in the second case — the doc was not ours to overwrite (I5).
      const published = remote.length === 0 ? text : remote;

      // I6, and the same refusal the attachment arm already makes for a zero-byte
      // file. A confirmed flush of an EMPTY document confirms nothing: `s` is the
      // whole definition of "published" for a note, so setting it here tells every
      // peer to materialize content that does not exist, and `Reconciler` obliges
      // by writing a 0-byte file on the canonical path — the thing its own comment
      // calls worse than no file, because it looks correct and gets deleted by
      // hand. That hand deletion is a tombstone, and it propagates to everybody,
      // the author included.
      //
      // Obsidian's "New note" IS a 0-byte file, so an empty note is the ordinary
      // state of every note for as long as it takes its author to start typing.
      // This refuses to PUBLISH one, not to have one: the node stays in the tree
      // under its own name, peers list it as pending, and the entry left `pending`
      // here publishes it on the next drain after its first byte lands. Refusing
      // is not failing, so no rung of the ladder is charged and nothing is said to
      // the user about a note they are still writing.
      //
      // PARKED as it is kept, because those two facts are both needed and they
      // pull opposite ways. The entry has to stay, or the note is never offered
      // again; the STATUS BAR must not read it as an upload in progress, or one
      // permanently empty note reports "1 file waiting to upload" for the
      // lifetime of the vault and the bar never says "synced" again. There is no
      // upload owed here: there is nothing to upload.
      if (published.length === 0) {
        await this.park(id, 'empty', path);
        return;
      }

      this.deps.tree.patchNode(id, { s: 1 });

      // I17, second half: a base names bytes that are simultaneously in the
      // WORKSPACE and on THIS DISK, and it is recorded only when both are true.
      // When the document already held a peer's text, `published` is the
      // workspace's copy and `text` is this disk's; if they differ there are no
      // such bytes, and both available answers are lies with different victims.
      // The remote's hash names a file this disk does not hold, so every reader of
      // the base reasons about content that is not there. The local's hash is
      // worse: `Deletions.isProvenNote` compares the base with the disk, finds
      // they agree, and lets a remote tombstone TRASH unpublished local work that
      // no peer can give back.
      //
      // So nothing is recorded, and any stale base is dropped rather than left to
      // speak for bytes it no longer describes. Every reader defaults to rescue on
      // ignorance, which is the answer that keeps the user's file; the divergence
      // itself is the reconciler's to resolve, not the publisher's.
      if (published === text) {
        data.contentHash[id] = { sha256: await hashOf(published), len: published.length };
      } else {
        delete data.contentHash[id];
      }
      data.publish[id] = { state: 'done', attempts: 0, nextAt: 0 };
      this.errors.delete(id);
    } catch (err) {
      this.fail(id, err);
    } finally {
      if (handle !== null) this.deps.docs.close(handle);
    }
  }

  /**
   * §3.6. Did the text we just read actually come from this file, or is it what a
   * UTF-8 decoder made of bytes that are not text?
   *
   * `vault.read` decodes as UTF-8 and every invalid byte becomes U+FFFD, so a
   * `'f'` node over a PNG yields mojibake that is a perfectly ordinary string —
   * and seeding THAT into a `Y.Text` is irreversible, because `s` is never
   * re-offered and no later pass may touch a seeded doc. The check is one `stat`:
   * re-encode what was read and compare its length with the file's real size.
   *
   * It is reachable today rather than hypothetical: `publishUntracked` offers any
   * file named `.md` regardless of what is in it, and a kind-crossing rename
   * (§3.6) mints an `'f'` node over the bytes of a `.png` on purpose.
   *
   * REFUSING IS NOT FAILING — no rung of the backoff ladder is charged, because a
   * file that is not text will not become text by waiting; the entry stays
   * pending, the reason reaches diagnostics, and the user is told exactly once.
   * It is PARKED for the same reason an empty note is: waiting is not what fixes
   * this, a rename by hand is, so there is no upload in progress for the status
   * bar to report and no honest way to count one.
   *
   * A `stat` that cannot answer is a retry (I2): "I could not look" must not
   * become "seed it anyway".
   */
  private async roundTrips(id: string, path: string, raw: string): Promise<boolean> {
    const st = await this.deps.vault.stat(path);
    if (st === null) throw new RetryLater(`${path} is not on disk`);
    const encoded = new TextEncoder().encode(raw).length;
    // The BOM allowance: a UTF-8 decoder strips a leading byte-order mark, so a
    // perfectly good note that carries one re-encodes exactly three bytes short.
    // A lossy decode fails the check in the other direction — U+FFFD is three
    // bytes for every invalid one — so this cannot let mojibake through.
    if (encoded === st.bytes || encoded + BOM_BYTES === st.bytes) return true;

    this.parkedNodes.set(id, 'not-text');
    this.parkedStat.set(id, { bytes: st.bytes, mtime: st.mtime });
    this.errors.set(id, new Error(
      `${path} is ${st.bytes} bytes on disk but decodes to ${encoded}: not UTF-8 text`,
    ));
    if (!this.seedRefused.has(id)) {
      this.seedRefused.add(id);
      this.deps.notice?.(
        `"${baseOf(path)}" is not a text file, so it is not being shared as a note. `
        + 'Rename it back to its original extension to share it as an attachment.',
      );
    }
    return false;
  }

  // ============================================================ attachments (§3.2)

  /**
   * Publish an attachment's bytes. Never throws: like the markdown arm, a failure
   * charges one rung of the ladder and the entry stays pending.
   *
   * The order below is the whole point, and every step is a refusal to guess:
   * settle before reading, size before allocating, hash what was actually read,
   * ask the store whether it already has it, upload, ASK AGAIN, and only then
   * write `s` and `b` together.
   */
  private async publishBlobOne(id: string, f: NodeFields): Promise<void> {
    const data = this.deps.state.data;

    // I13 and I5a, both of them now SAYING SO rather than returning silently.
    // A dead node is never published — the user deleted it, or an earlier attempt
    // retracted it — and the first publish of a live one is creator-only, for the
    // reason I5 exists at all. Neither is a failure, so no rung is charged; what
    // neither may do is leave the entry counted as an upload in progress for the
    // lifetime of the vault, which is what an attachment deleted before it
    // published did.
    const why = this.blockOf(id, f);
    if (why !== null) { this.block(id, why); return; }
    this.unblock(id);

    const path = data.materialized[id];
    if (path === undefined || path === '') {
      this.fail(id, new RetryLater(`no local file is bound to ${id}`));
      return;
    }
    // I7. Deferring is not failing: charging a rung here would park the publish
    // for minutes after the user simply closed the tab.
    if (this.deps.vault.isOpenInLeaf(path)) return;

    try {
      // THE SETTLE CHECK. Obsidian fires `create` when a file APPEARS, so the
      // first `stat` may describe a file that is still being written. Two stats
      // that agree on size AND mtime are the cheapest available evidence that the
      // writer has finished; publishing between them would put a truncated —
      // and, because the store verifies what it is given, permanently
      // authoritative — object in front of every peer.
      const first = await this.deps.vault.stat(path);
      if (first === null) {                                  // I2: gone, not a delete
        this.fail(id, new RetryLater(`${path} is not on disk`));
        return;
      }
      await this.sleep(this.settleMs);
      const st = await this.deps.vault.stat(path);
      if (st === null || st.bytes !== first.bytes || st.mtime !== first.mtime) {
        this.fail(id, new RetryLater(`${path} is still being written`));
        return;
      }

      // I6 ON THIS ARM, SAID RATHER THAN INFERRED, and it is the first of the
      // three writers of `s` to say it in its own words. A settled 0-byte file
      // is not a file mid-write: two stats agreeing on size AND mtime is the
      // evidence the writer has finished, and what it finished writing is
      // nothing. There is no object to put in the store and nothing for `b` to
      // name, so publishing one would announce content that does not exist —
      // the attachment half of the 0-byte decoy the note arm refuses.
      //
      // It used to fall through the comparison above, which called it "still
      // being written" for ever: the rule held by accident, the diagnostic was
      // untrue, and the entry charged a rung of the ladder and stayed counted.
      // PARKED, for exactly the reason a note is: waiting is not what fixes
      // this, bytes arriving in the file are, and `repark` sees that with one
      // `stat`.
      if (st.bytes === 0) {
        this.errors.set(id, new Error(`${path} is empty, so there is nothing to share`));
        await this.park(id, 'empty-attachment', path);
        return;
      }

      // Size is decided HERE, where the bytes have settled, and never at create
      // time. Both caps are checked before `readBinary`, so a file too big to
      // hold in memory is never held in memory (§7.4).
      //
      // Asked TWICE, of the same pure function, so the ceiling is only fetched
      // once the device arm has passed: `publishVerdict` tests the device first
      // precisely so a phone never needs the network to learn it cannot hold a
      // file, and an `await` in the argument list would throw that away. A null
      // ceiling skips the server arm, so the first call is exactly the device arm.
      const deviceCap = this.deps.memoryCapBytes();
      let verdict = publishVerdict(st.bytes, deviceCap, null);
      if (verdict === 'ok') verdict = publishVerdict(st.bytes, deviceCap, await this.serverCap());
      if (verdict !== 'ok') {
        this.retract(id, f, path, st.bytes, verdict.cap, verdict.refused);
        return;
      }

      const bytes = await this.deps.vault.readBinary(path);
      if (bytes.length !== st.bytes) {
        // The file changed between the second `stat` and the read. Whatever is on
        // disk now has not settled after all.
        this.fail(id, new RetryLater(`${path} changed while it was being read`));
        return;
      }
      const sha256 = await hashOfBytes(bytes);

      // I8. The tree already names these exact bytes: there is nothing to publish,
      // and re-uploading would be a second upload of an object the store holds.
      const ref = parseBlobRef(f.b);
      if (f.s === 1 && ref !== null && ref.sha256 === sha256) {
        this.recordBlob(id, sha256, st.bytes, st.mtime);
        this.markDone(id, sha256);
        return;
      }

      // `has` THROWS on transport failure and never answers false for "I could not
      // ask", so a false here means the store genuinely does not hold these bytes.
      if (!(await this.deps.blobs.has(sha256)).present) {
        if (!(await this.deps.blobs.put(sha256, bytes))) {
          // A REFUSAL (413 / 507 / 422), not a transport failure — those throw and
          // land in the catch below. The reason is the user's to see.
          //
          // §9's endpoint table, `BlobPort.limits` and `ObsidianBlobPort` all
          // promise the ceiling is "re-fetched after a 413/507", and it never was.
          // Without this, a self-hoster who LOWERS `MAX_FILE_SIZE_MB` mid-session
          // leaves every over-limit attachment in an unbounded silent loop: the
          // remembered ceiling still says the old number so nothing retracts, the
          // whole file is re-read, re-hashed and re-offered on every rung, and the
          // user is told nothing — §7.5's Notice lives on the retract path this
          // never reaches. Only the 413 changes a decision; the 507 is invalidated
          // too so the documented contract is true rather than half-true, at the
          // cost of one extra GET per rung of a publish that is failing anyway.
          const err = this.deps.blobs.lastError;
          if (err instanceof BlobTooLarge || err instanceof BlobQuotaExceeded) {
            this.serverMaxBytes = null;
          }
          this.fail(id, this.deps.blobs.lastError);
          return;
        }
      }
      // I17. `put` resolving true is this client's account of a round trip; only a
      // fresh `has` is the STORE's. Advancing `s` on the first is how a node ends
      // up published against bytes nobody can fetch — permanently, because `s` is
      // never re-offered.
      if (!(await this.deps.blobs.has(sha256)).present) {
        this.fail(id, new RetryLater(`the store did not confirm ${sha256}`));
        return;
      }

      // I6 again, at the writer, and the two statements are not redundant. The
      // one above is where the refusal is CHEAP — before a read, a hash and a
      // dedup probe. This one is where `s` is actually set, and it is here so
      // that the rule cannot be lost by somebody relaxing a comparison several
      // screens away. `s` is the whole definition of "published" and it is never
      // re-offered by anybody, so a wrong one is permanent.
      if (bytes.length === 0) {
        this.errors.set(id, new Error(`${path} is empty, so there is nothing to share`));
        await this.park(id, 'empty-attachment', path);
        return;
      }

      // `s` and `b` in ONE transaction. Split across two, a peer observing the
      // tree between them sees a published node whose reference is absent (or,
      // worse, still names the previous version) and materializes the wrong bytes.
      const parent = f.s === 1 && ref !== null ? ref.sha256 : null;
      const b = formatBlobRef(sha256, bytes.length, parent);
      this.deps.tree.transactLocal(() => { this.deps.tree.patchNode(id, { s: 1, b }); });
      this.recordBlob(id, sha256, bytes.length, st.mtime);
      this.markDone(id, sha256);
      this.errors.delete(id);
    } catch (err) {
      // Transport, an unreadable file, a `stat` that could not look: all of them
      // are "not now", and not one of them touches the tree or the disk (I2).
      this.fail(id, err);
    }
  }

  /**
   * Spec §3.2's `retract`. A file that can never be published must not sit in
   * every peer's Pending list for ever, so the node is tombstoned — and the file
   * is left EXACTLY where the user put it.
   *
   * §3.2's entire safety argument for that tombstone is "the node was never
   * published, so no peer materialized it and `collectDeletable` skips it", and
   * the argument is sound only for a FIRST publish. `publishBlobOne` is reachable
   * with `f.s === 1` by design — I5a admits any peer holding the node
   * materialized, and §3.5's rule 2 requeues a replace on every pass — so the
   * published case is split off above, where refusing the node would be a remote
   * delete of the last good version rather than a refusal of the new bytes.
   *
   * Below this branch the node is unpublished, and there the tombstone is safe.
   * Nothing is moved and nothing is removed. The local binding is dropped for the
   * same reason in reverse — THIS device would otherwise hold a dead node bound to
   * a real file, which is precisely the shape the deletion pass reads as "rescue
   * it into ShadowLink Recovered/". The user would find their 200 MB video moved
   * out of the share, its path permanently declined, for the crime of being too
   * large.
   *
   * `oversized` is keyed by folded path and is consulted by `onCreate` and by
   * reconciler step 6, where it self-heals: a later `stat` showing the file has
   * shrunk drops the record and the path is offered again as a fresh node.
   */
  private retract(
    id: string,
    f: NodeFields,
    path: string,
    bytes: number,
    cap: number,
    why: 'server' | 'device',
  ): void {
    if (f.s === 1) {
      this.refuseReplace(id, path, bytes, cap, why);
      return;
    }
    const data = this.deps.state.data;
    this.deps.tree.transactLocal(() => {
      this.deps.tree.patchNode(id, { x: f.g, xa: this.now(), xb: this.deps.displayName });
    });
    data.oversized[fold(path)] = { bytes, cap, why };
    delete data.materialized[id];
    this.markDone(id);
    this.errors.delete(id);
    this.deps.state.schedulePersist();
    this.deps.notice?.(
      `"${baseOf(path)}" is ${mb(bytes)} MB — over the ${mb(cap)} MB limit `
      + `${why === 'server' ? 'this server accepts' : 'this device can handle'}. `
      + 'It is not being shared.',
    );
  }

  /**
   * A size refusal on a node that is ALREADY PUBLISHED (§3.2, the replace case).
   *
   * The new bytes are refused; the node is not. Every peer has this file
   * materialized, its bytes still hash to the reference the tree names, and the
   * store still holds them — so a tombstone here is proven content on the far
   * side and their copy is TRASHED, under a notice naming a user who deleted
   * nothing. It is worse than a real delete, because `retract` writes no `xh` and
   * `canResurrect` can never bring the node back.
   *
   * So: the tree is not touched at all, and the last good version stays shared.
   *
   * Three things this deliberately does NOT do, each of which would be a bug:
   *
   *  * It does not write `oversized`. That record is keyed by folded PATH and
   *    self-heals in reconciler step 6 — which skips any path a LIVE node claims
   *    before it ever asks for a size. A record written here would never be swept,
   *    and if the node were properly deleted later it would stop `onCreate` from
   *    ever re-adopting the file (I13's path-poisoning, which `oversized` is kept
   *    separate from `declinedPaths` precisely to avoid).
   *  * It does not unbind. The node is live and the file at that path is the same
   *    file every peer holds; dropping the binding would hide it from step 2.5 and
   *    strand the tree naming bytes no device is watching any more.
   *  * It does not touch `contentHash`. The base still names what is
   *    simultaneously in the tree and on some disk (I17) — the oversized bytes on
   *    this disk are unpublished local work, exactly like rule 4's fork loser.
   *
   * The entry is CLOSED carrying the intent it refused. §3.5 requeues on every
   * pass, and `requeue` is a no-op for a matching intent, so the refusal costs one
   * Notice rather than one per pass. The intent must be read before `markDone`,
   * which replaces the entry.
   */
  private refuseReplace(
    id: string,
    path: string,
    bytes: number,
    cap: number,
    why: 'server' | 'device',
  ): void {
    const data = this.deps.state.data;
    const intent = data.publish[id]?.intent;
    this.markDone(id, intent);
    // §7.5's "permanent diagnostics entry". Refusing is not failing, so no rung of
    // the ladder is charged and the entry does not stay pending.
    this.errors.set(id, new Error(
      `${path} is ${bytes} bytes, over the ${why} limit of ${cap}: the new version is not shared`,
    ));
    this.deps.state.schedulePersist();
    this.deps.notice?.(
      `"${baseOf(path)}" is ${mb(bytes)} MB — over the ${mb(cap)} MB limit `
      + `${why === 'server' ? 'this server accepts' : 'this device can handle'}. `
      + 'Your change is not being shared; the previous version still is.',
    );
  }


  /**
   * The server's per-file ceiling, or null while it is unknown.
   *
   * `limits()` throws on transport, and the failure is deliberately swallowed
   * rather than charged: an unknown ceiling must never be read as a small one.
   * Treating "I could not ask" as a refusal would RETRACT — tombstone — a
   * perfectly publishable file because the network blinked, which is I2 in the
   * one place where it is not recoverable by a later pass. Publishing simply
   * proceeds; if the object really is over the ceiling, the server answers 413 and
   * `put` refuses, which is a backoff.
   *
   * Asked once and remembered, because this is the only value in the publish path
   * that moves and a round trip per attachment would be absurd — but the memory is
   * DROPPED on a 413 or a 507 (§9), where the remembered number has just been
   * proven wrong or the store's shape has just changed. A memo with no
   * invalidation is what turned a lowered `MAX_FILE_SIZE_MB` into a silent
   * infinite re-upload.
   */
  private async serverCap(): Promise<number | null> {
    if (this.serverMaxBytes !== null) return this.serverMaxBytes;
    try {
      const limits = await this.deps.blobs.limits();
      if (typeof limits.maxFileBytes === 'number' && limits.maxFileBytes > 0) {
        this.serverMaxBytes = limits.maxFileBytes;
      }
    } catch {
      return null;                                     // asked, not answered
    }
    return this.serverMaxBytes;
  }

  /**
   * Record a refusal only the user's file can lift, together with what that file
   * looked like — which is what `repark` compares against, and the whole reason
   * it can answer with one `stat` instead of a pass.
   */
  private async park(id: string, reason: ParkReason, path: string): Promise<void> {
    this.parkedNodes.set(id, reason);
    try {
      const st = await this.deps.vault.stat(path);
      if (st === null) this.parkedStat.delete(id);
      else this.parkedStat.set(id, { bytes: st.bytes, mtime: st.mtime });
    } catch {
      this.parkedStat.delete(id);                        // I2: asked, not answered
    }
  }

  private unpark(id: string): void {
    this.parkedNodes.delete(id);
    this.parkedStat.delete(id);
  }

  /**
   * Why nothing can ever lift this entry, or null when something can.
   *
   * PURE, and it reads only the tree and the state file — no `stat`, no network
   * — which is what lets `repark` re-ask it for every blocked entry without
   * paying for a pass. The reasons are the ones the two publish arms already
   * returned on; naming them in one place is what makes "the queue owes nothing
   * here" a state rather than three separate silent returns.
   */
  private blockOf(id: string, fields?: NodeFields | null): string | null {
    const f = fields === undefined ? this.deps.tree.get(id) : fields;
    if (f === null) return `${id} is no longer in the tree`;
    // I13. Dead, and no drain, rename or keystroke brings a tombstoned node back.
    if (!isLive(f)) return `${id} has been deleted`;
    // I5 / I5a. A note is creator-only outright; an attachment's FIRST publish is,
    // and a replace is not (§4.4), so a published blob is never blocked here.
    const creatorOnly = f.k !== 'b' || f.s !== 1;
    if (creatorOnly && this.deps.state.data.owned[id] !== true) {
      return `${id} is not this device's to publish`;
    }
    return null;
  }

  /**
   * Stop counting an entry, and say why where a diagnostics panel can read it.
   *
   * The entry stays `pending` and no rung is charged, exactly as the silent
   * returns left it, so nothing is thrown away: the drain still reaches it and
   * `repark` re-asks the question. The two things that change are that the
   * status bar stops promising an upload, and that `lastError` stops being
   * `undefined` for a state the user could otherwise not see at all.
   */
  private block(id: string, reason: string): void {
    this.blockedNodes.set(id, reason);
    this.errors.set(id, new Error(reason));
    // A blocked entry is not refused over the state of the FILE, so it must not
    // also claim a park — the two say different things to the status bar and only
    // one of them has a sentence for the user.
    this.unpark(id);
  }

  private unblock(id: string): void {
    this.blockedNodes.delete(id);
  }

  /** I17: the base — what this device confirmed is simultaneously on disk and in the tree. */
  private recordBlob(id: string, sha256: string, len: number, mtime?: number): void {
    this.deps.state.data.contentHash[id] = mtime === undefined
      ? { sha256, len }
      : { sha256, len, mtime };
  }

  /** Close an entry. The intent travels with it, so a requeue for the same bytes is a no-op. */
  private markDone(id: string, intent?: string): void {
    const entry: { state: 'done'; attempts: number; nextAt: number; intent?: string } = {
      state: 'done', attempts: 0, nextAt: 0,
    };
    if (intent !== undefined) entry.intent = intent;
    this.deps.state.data.publish[id] = entry;
    // Nothing owed, nothing refused, nothing blocked. Both accessors already
    // filter on the entry's state, so this is hygiene rather than correctness —
    // but a map that only ever grows is how the next reader is misled.
    this.unpark(id);
    this.unblock(id);
  }

  /**
   * Charge one rung of the ladder, capped at the last one. The entry stays pending.
   *
   * The INTENT survives the failure. Without it, a failed attempt erases what the
   * entry was queued to publish, and the next `requeue` for the very same bytes
   * reads as new work and resets `attempts` to zero — so a caller that requeues
   * every pass (which is exactly what §3.5 does) would defeat the ladder entirely.
   */
  private fail(id: string, err: unknown): void {
    const data = this.deps.state.data;
    const entry = data.publish[id];
    if (entry === undefined) return;
    const attempts = entry.attempts + 1;
    const step = this.backoff[Math.min(attempts, this.backoff.length) - 1];
    const next: PublishEntry = { state: 'pending', attempts, nextAt: this.now() + step };
    if (entry.intent !== undefined) next.intent = entry.intent;
    data.publish[id] = next;
    this.errors.set(id, err);
  }
}

// ============================================================ helpers

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Bytes as megabytes, for a Notice a human reads. One decimal, never rounded to 0. */
function mb(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

/** A UTF-8 byte-order mark, which a decoder strips and an encoder does not put back. */
const BOM_BYTES = 3;

/**
 * I18. Normalize on the way IN: the normalized form is the only form that exists
 * inside ShadowLink, and it is what gets written into a content document.
 *
 * `\r\n?` and not `\r\n`. This is one of exactly two writers that put a file's
 * bytes into a content `Y.Text`, so it is one of the two places the guarantee
 * "a content document contains no `\r`, ever" is made. A half-normalizer seeded
 * a classic-Mac file's lone `\r` straight into the document — and CodeMirror
 * normalizes a lone `\r` too, so that note could never afterwards be bound into
 * an editor: no configuration makes the two sides equal, and every launch
 * refused the mount and filed another recovery copy.
 */
function toLF(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
