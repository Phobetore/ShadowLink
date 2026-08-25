// src/sync/Reconciler.ts
// Tree change -> vault mutation (spec §4.3), plus `ensureDirs` (§4.2) and the
// staging journal.
//
// This is the module that creates, moves and writes the user's real notes, so
// two structural rules govern everything below.
//
// FIRST: it does not apply deltas. Every pass recomputes the desired state from
// the WHOLE tree (`deriveTree`), observes the disk (`DiskIndex`), and converges
// the difference. Incremental patch application is the bug class this design
// exists to eliminate (spec risk R12): collision suffixes and cascade escapes are
// functions of the whole live set, so a per-event patch drifts from a rebuild and
// nothing ever notices. Group B tests 41 and 42 lock that property down.
//
// SECOND: nothing here may turn an error, an absence or an ambiguity into a
// deletion. A missing file, an unresolvable node, an unreadable folder and a
// content doc that would not sync are all no-ops (I2). Every per-item filesystem
// call runs inside `guarded`, so one EPERM, one antivirus lock or one over-long
// path is contained to that item and the pass carries on (I15).
//
// Deletions (step 4) and publication (steps 6-7) are injected collaborators with
// no-op defaults; this slice computes the inputs they need and hands them over.
//
// No `obsidian` import, no node builtins.

import {
  AUTOFETCH_MAX_BYTES, AUTOFETCH_SESSION_BUDGET, BLOB_MAX_BYTES, RECOVERED_DIR,
  REHASH_BUDGET_BYTES, STAGING_DIR,
} from '../tree/constants.ts';
import { DIR_SENTINEL, deriveTree } from '../tree/TreeIndex.ts';
import type { NodeFields } from '../tree/types.ts';
import {
  assertInsideShare, extOf, fallbackForkName, fold, forkName, hashOf, hashOfBytes, isLive,
  nodeKindOf, relPath, replaceVerdict, splitRel, validateRel, type BlobRef,
} from '../tree/paths.ts';
import { BlobUnavailable, type BlobPort } from './BlobPort.ts';
import type { DeviceState } from './DeviceState.ts';
import { fetchVerdict, type FetchLimits } from './FetchPolicy.ts';
import { DiskIndex } from './DiskIndex.ts';
import type { DocPort } from './DocPort.ts';
import type { Tickets } from './Tickets.ts';
import type { Kind, VaultPort } from './VaultPort.ts';

// ============================================================ public surface

export type ReconcileCause = 'remote' | 'sync' | 'bootstrap' | 'retry';

/** One contained per-item failure. Retryable ones carry a `RetryLater`. */
export interface ReconcileFailure {
  key: string;
  err: unknown;
}

export interface ReconcileDiagnostics {
  /** Node ids whose content was never published — never materialized (I6). */
  pending: string[];
  /** Node ids rejected by `validateRel` — skipped entirely, never deleted (I10). */
  invalid: string[];
  /** Literal paths held by a file a dead node used to own. Reported, never touched. */
  deletedButPresent: string[];
  /**
   * Attachment nodes this device will not hold in memory (§7.4). Not a failure:
   * the node stays live, valid, published and simply unmaterialized HERE, which
   * is the correct state — the alternative is a phone that dies on every pass.
   */
  tooLarge: string[];
  /**
   * The subset of `tooLarge` refused on the way IN — a fetch the cap turned down
   * before the request was made (§7.5).
   *
   * A FOURTH channel rather than a reading of the third, because `tooLarge` has
   * three writers and only this one means "the bytes are not on this disk".
   * `hashWithBudget` and `adoptBlob` fire for a file that IS there and complete,
   * where only this device's question about it is unanswered — so describing
   * `tooLarge` wholesale to the user would report a downloaded attachment as
   * missing, which is precisely why `rehashDeferred` was split out below.
   *
   * As with `deferred`, the usual case is that nothing is at the path at all, and
   * the narrower one is a REPLACEMENT that was held back with an older version
   * still in place. Both are "this version is not here", and neither has a remedy
   * on this device: the cap is tested before an approval is even consulted, so a
   * download button offered for one of these could only fail.
   */
  fetchTooLarge: string[];
  /**
   * Attachment nodes the fetch policy has not cleared yet (§7.2).
   *
   * Usually there is NOTHING on disk for them — no file, no placeholder, no stub,
   * no sidecar (§7.3). The narrower case is a node whose REPLACEMENT was held
   * back, where an older version is still at the path. Both are "this version has
   * not been downloaded", and both take the same remedy.
   */
  deferred: string[];
  /**
   * Attachment nodes whose bytes the store no longer holds (§6.5).
   *
   * A THIRD channel, and foldable into neither of the two above. `deferred` is a
   * decision this device took and can take back; `tooLarge` is a fact about this
   * device that a bigger one does not share; this is a fact about the WORKSPACE —
   * a self-hoster ran the orphan sweeper with a short TTL, or the volume lost a
   * file — and it is the only one of the three that nothing done on this device
   * can resolve.
   *
   * It is deliberately not a `failure` either. A failure means "ask again", and
   * asking again for bytes the store has definitely answered 404 for is a retry
   * loop with no end. The consequence stays bounded exactly as §6.5 promises: I2
   * makes the fetch a no-op, nothing is written and nothing is deleted — and
   * "bounded" is only worth something if the user is told, which is this.
   */
  unavailable: string[];
  /**
   * Attachment nodes whose local bytes this pass ran out of re-hash budget for
   * (§3.5). A separate channel from `deferred` on purpose: the file IS on disk
   * and complete, and only this device's question about it is unanswered, so
   * folding the two together would report a downloaded attachment as missing.
   */
  rehashDeferred: string[];
}

/**
 * One attachment this device decided not to fetch, with everything the UI needs
 * to talk about it — and to offer to fetch it (§7.3).
 *
 * `path` is where the node WANTS to live, which is the only handle an unresolved
 * embed can be matched against: there is deliberately nothing on disk to look at.
 */
export interface DeferredAttachment {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface ReconcileResult {
  /** False when the pass refused: read-only, share missing, or a mount mismatch. */
  ran: boolean;
  refusedReason?: string;
  failures: ReconcileFailure[];
  diagnostics: ReconcileDiagnostics;
}

/**
 * Everything step 4 (P1b-2b) needs, computed by the pass that calls it.
 *
 * It is handed the pass's own live structures on purpose: a deletion must be
 * decided against the same disk view the rest of the pass mutated, and anything
 * it removes must land in `removedThisPass` so step 6 cannot republish it in the
 * same pass that deleted it (I13).
 */
export interface DeletionContext {
  cause: ReconcileCause;
  /** Valid nodes that are currently dead: nodeId -> fields (`xa`/`xb`/`xh` included). */
  deadNodes: Map<string, NodeFields>;
  /**
   * fold(vaultPath) of every dead node's PLAIN path. CF-1: a dead node has no
   * derived path, so a file that materialized at a collision suffix is NOT in
   * here — use `deadNodes` + `state.materialized` for that (as step 6 does).
   */
  deadFold: Set<string>;
  /** fold(vaultPath) -> nodeId, or DIR_SENTINEL for a folder. Live nodes only (I12). */
  wantAtFold: Map<string, string>;
  /** nodeId -> the literal path it currently occupies on disk. */
  have: Map<string, string>;
  /**
   * nodeId -> the parsed `b` of every LIVE, VALID, PUBLISHED `'b'` node, from the
   * same derivation as `desired`.
   *
   * Membership here IS the kind test for the whole pass. Deriving it once means
   * `materialize` and `adopt` cannot disagree about what a node is — and the way
   * they could disagree is not academic: `adopt` reading an attachment as a note
   * decodes a PNG to lossy UTF-8, decides it differs from the shared copy, and
   * exiles the user's real file (§3.4).
   *
   * Step 4 is handed it for the same reason (§5.2): a deletion must be decided
   * against the pass's own derivation. It reads a DEAD node's own reference from
   * `f.b`, because a dead node is absent from here by construction — so a node
   * that appears in both is the two halves of one derivation contradicting each
   * other, and an ambiguity is never a deletion (I2).
   */
  blobRefs: Map<string, BlobRef>;
  disk: DiskIndex;
  failures: ReconcileFailure[];
  /** fold(path) of everything this pass removed. Feeds step 6's exclusion list. */
  removedThisPass: Set<string>;
  vault: VaultPort;
  /** The attachment store (§8.3). Step 4 asks it whether bytes are still retrievable. */
  blobs: BlobPort;
  docs: DocPort;
  state: DeviceState;
  tickets: Tickets;
  shareRoot: string;
  notice: (msg: string) => void;
  now: () => number;
  /** Per-item error containment (I15). Never let a filesystem call escape unguarded. */
  guarded: (key: string, fn: () => Promise<void>) => Promise<void>;
  /** Forget a node's disk binding. A local bookkeeping change, never a tree write. */
  unbind: (id: string) => void;
}

export interface ReconcilerDeps {
  vault: VaultPort;
  docs: DocPort;
  /** The attachment store (spec §8.3). Only `'b'` nodes ever reach it. */
  blobs: BlobPort;
  state: DeviceState;
  tickets: Tickets;
  shareRoot: string;
  /** Snapshot of the tree, injected so the reconciler never owns the Y.Doc. */
  entries: () => Array<[string, NodeFields]>;
  /**
   * Node ids the user has not yet answered the "stop sharing this?" dialog for
   * (spec §5.5), read fresh on every pass. `VaultWatcher.pendingDecision` is the
   * implementation; the default is an empty set.
   *
   * A node in here is treated EXACTLY like an invalid node: reported, and
   * otherwise not created, moved, materialized or deleted. Without it, a pass
   * firing while the modal is open re-materializes the very file the user just
   * dragged out of the shared folder, putting it back where they took it from.
   */
  pendingDecision?: () => ReadonlySet<string>;
  /** Step 4. Default: a no-op. Filled in by P1b-2b. */
  applyDeletions?: (ctx: DeletionContext) => Promise<void>;
  /** Steps 6-7. Default: a no-op. Filled in by P1b-2c / P1c. */
  publishUntracked?: (paths: string[]) => Promise<void>;
  notice?: (msg: string) => void;
  now?: () => number;
  /**
   * The largest attachment this device will hold in memory (§7.4). Injected as a
   * plain number so nothing here has to know what platform it is running on.
   */
  memoryCapBytes?: () => number;
  /**
   * How many bytes step 2.5 may re-hash in one pass (§3.5). Injected for the same
   * reason as the memory cap: the number is a platform fact, not an engine one.
   */
  rehashBudgetBytes?: () => number;
  /**
   * §7.2's per-file auto-fetch ceiling. Above it an attachment is DEFERRED and
   * the deferral is persisted, so the user can ask for the file later.
   */
  autofetchMaxBytes?: () => number;
  /**
   * §7.2's second gate: how many bytes this session fetches unattended, across
   * every attachment. A per-file ceiling alone is not enough — 4,000 files of one
   * megabyte each pass every per-file check and still eat a data plan.
   */
  sessionBudgetBytes?: () => number;
  /**
   * Paths the modify handler has flagged since the last pass, folded, and TAKEN
   * (not copied): the pass owns the set it is given.
   *
   * They bypass the re-hash budget, because they are the one change the user is
   * actually waiting on. `VaultWatcher.takeDirtyPaths` is the implementation; the
   * default is an empty set, which costs nothing but a slower first hash.
   */
  takeDirtyPaths?: () => ReadonlySet<string>;
  /**
   * §3.5 rule 2: this device's copy of an attachment differs from the tree, and
   * the tree still names what this device last confirmed — so the difference is
   * ours and unpublished. `PublishQueue.requeue` is the implementation.
   *
   * An injected collaborator rather than a `PublishQueue` dependency, for the same
   * reason as `publishUntracked`: the reconciler is a pure driver over a tree
   * snapshot, and giving it the queue would let a future pass publish from inside
   * the loop that is deciding what to publish.
   */
  requeuePublish?: (nodeId: string, intent: string) => void;
  /**
   * This device's display name, which appears inside the name of a forked file
   * (§4.3). Display only, and optional: with none, the fork keeps the hash and
   * drops the name rather than inventing one.
   */
  displayName?: string;
}

/**
 * A per-item failure that is expected to succeed later: the content doc had not
 * synced yet. Distinguished from a hard error so the retry policy can back off
 * rather than surface it as a defect.
 */
export class RetryLater extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryLater';
  }
}

// ============================================================ internals

/** Shared default for `pendingDecision`, so the common case allocates nothing. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** The pass's own working set. `DeletionContext` is the subset step 4 is given. */
interface PassContext extends DeletionContext {
  /** nodeId -> where a live, valid, seeded file node wants to be. Files only. */
  desired: Map<string, { path: string; kind: Kind }>;
  /** Vault paths of every folder the tree implies, shallowest first (CF-8). */
  folderPaths: string[];
  /** Vault paths of dead directory nodes, deepest first. */
  deadFolderPaths: string[];
  /**
   * Directories under the share that this pass moved a file OUT of, ancestors
   * included. Step 5's other sweep candidates.
   */
  vacatedDirs: Set<string>;
  /** fold(state.materialized[id]) for every currently-dead id. CF-1. */
  deadMaterializedFold: Set<string>;
  /** fold(literal path) -> nodeId, the inverse of `have`. */
  boundAtFold: Map<string, string>;
  /**
   * fold(path) of every file the modify handler flagged since the last pass.
   *
   * Taken once per pass, so a save that lands mid-pass is answered by the next
   * one rather than half-answered by this one.
   */
  dirtyPaths: ReadonlySet<string>;
  /**
   * Node ids this pass refused to fetch on POLICY grounds (§7.2) — the auto-fetch
   * ceiling or the session budget, never the memory cap.
   *
   * It is what keeps `state.fetchDeferred` from being a map that only grows: an
   * id absent from here when the pass ends is one this pass either fetched,
   * adopted, or no longer knows about, and a record for it would make the status
   * bar count files the user downloaded last week.
   */
  deferredByPolicy: Set<string>;
  diagnostics: ReconcileDiagnostics;
  bind: (id: string, path: string) => void;
}

/**
 * What one pass may still spend on re-hashing (§3.5).
 *
 * `spent` exists so the FIRST hash of a pass is always permitted, however large
 * the file: a share whose smallest attachment is bigger than the whole budget
 * would otherwise defer the same node on every pass, for ever.
 */
interface RehashBudget {
  remaining: number;
  spent: number;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function depthOf(path: string): number {
  return path.split('/').length;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byDepthAsc(a: string, b: string): number {
  return depthOf(a) - depthOf(b) || cmp(a, b);
}

function byDepthDesc(a: string, b: string): number {
  return depthOf(b) - depthOf(a) || cmp(a, b);
}

/** I18: compare and hash on normalized line endings; never write the result to disk. */
function normLF(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Filesystem-safe wall-clock stamp for a stashed copy's name. */
function stampOf(ms: number): string {
  return new Date(ms).toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
}

/**
 * Rewrite a record with its keys in ASCII order.
 *
 * Device state is persisted as JSON, and `JSON.stringify` preserves insertion
 * order — so without this, two runs that performed the same work in a different
 * order would produce byte-different state files. Tests 41 and 42 assert on the
 * serialized bytes precisely because that is what a restart reads back.
 */
function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort(cmp)) out[key] = record[key];
  return out;
}

// ============================================================ Reconciler

export class Reconciler {
  private readonly deps: ReconcilerDeps;
  private readonly shareRoot: string;
  private readonly now: () => number;
  private readonly notice: (msg: string) => void;

  private running = false;
  private dirty = false;
  /**
   * Why the vault is not being mutated, and whether the next pass re-derives it.
   *
   * `recheck: true` marks a verdict this reconciler reached ITSELF from evidence
   * it can read again — the share root was missing, the mount looked wrong. Those
   * are re-diagnosed at the top of every pass rather than remembered, because a
   * verdict that outlives its evidence is how a client that has since been fixed
   * (the folder came back, the watcher bound a file) stays paused for the rest of
   * the session with nothing able to clear it.
   *
   * `recheck: false` is a pause somebody else imposed — a newer schema, a
   * cancelled first sync, a share root whose PARENT vanished. Those the pass
   * cannot re-derive, so it does not try: it refuses without touching the vault.
   */
  private paused: { reason: string; recheck: boolean } | null = null;
  /** The reason the user has already been shown, so a re-diagnosis is not a fresh popup. */
  private announced: string | null = null;
  /**
   * Did the pass before this one contain any failure at all?
   *
   * I2, applied to the mount guard. A pass whose fetches threw `RetryLater`
   * bound nothing — not because the share root points somewhere else, but
   * because a content doc had not synced yet. Reading "nothing is bound" as a
   * wrong mount on the pass after that turns an expected, transient condition
   * into a session-long read-only.
   */
  private lastPassFailed = false;
  /**
   * fold() of every directory that was already under the share when this session
   * ran its first pass, and null until that pass has run.
   *
   * Step 5 removes an empty directory the tree does not claim, which is what
   * converges a folder rename (§4.1 rewrites one `d` per descendant; nothing
   * relocates the directory, so the old one is simply left standing on every
   * peer). One kind of directory must be exempt from that: a folder the user
   * made BEFORE ShadowLink first ran here. It has no `create` event to replay
   * and step 6 offers only files to the publisher, so no node will ever claim it
   * — and an unclaimed folder is a gap in what gets shared (spec §4.5 step 7
   * says folders belong in the `upload` bucket), never a licence to remove the
   * user's directory. Anything that appears later either came from a node, rode
   * in with a rename, or was created by the user, whose `create` mints a node
   * that claims it.
   *
   * A dead folder node and a directory this pass itself emptied are NOT exempt:
   * both are positive evidence about that directory, not an absence of it.
   */
  private preexistingDirs: Set<string> | null = null;
  /**
   * §7.2's session budget, spent. Deliberately NOT persisted and deliberately on
   * the reconciler rather than in device state: it is a statement about this run
   * of the plugin, so a restart starts it at zero and the share picks up exactly
   * where the last session stopped.
   */
  private sessionFetchedBytes = 0;
  /**
   * What the last completed pass decided not to fetch (§7.3).
   *
   * The status bar, the download commands and the markdown post-processor all
   * read it, and all three run OUTSIDE a pass — which is why it is remembered
   * here rather than handed back in `ReconcileResult` and forgotten.
   */
  private lastDeferred: DeferredAttachment[] = [];
  /**
   * What the last completed pass refused to fetch because of the memory cap
   * (§7.5), and what it could not fetch because the store no longer holds it
   * (§6.5) — remembered for the same reason `lastDeferred` is.
   *
   * THREE LISTS, NEVER ONE. Every surface that reads them has to say something
   * different: `lastDeferred` is the only one with a remedy on this device, so it
   * is the only one a Download button belongs to. The cap is tested before an
   * approval is consulted, and an unavailable object has been answered 404 for —
   * a button offered for either could only fail, which is the same broken promise
   * a bare "synced" was making.
   */
  private lastTooLarge: DeferredAttachment[] = [];
  private lastUnavailable: DeferredAttachment[] = [];

  constructor(deps: ReconcilerDeps) {
    this.deps = deps;
    // A trailing slash would make every `startsWith(root + '/')` containment
    // check in assertInsideShare fail closed against perfectly legal paths.
    this.shareRoot = deps.shareRoot.replace(/\/+$/, '');
    this.now = deps.now ?? (() => Date.now());
    this.notice = deps.notice ?? (() => undefined);
  }

  get reconciling(): boolean {
    return this.running;
  }

  get readOnly(): boolean {
    return this.paused !== null;
  }

  /** Why the vault is not being mutated, for the persistent status indicator. */
  get readOnlyReason(): string | null {
    return this.paused?.reason ?? null;
  }

  /**
   * §7.2's session budget, spent so far. Read by `Bootstrap` so the first-sync
   * modal's counts describe the pass that is actually about to run.
   */
  get fetchedThisSession(): number {
    return this.sessionFetchedBytes;
  }

  /**
   * Every attachment the last completed pass decided not to fetch (§7.3).
   *
   * The status bar reads it to say "Synced · 12 attachments available" instead of
   * a bare "Synced", which on a share whose bytes only one peer holds is a lie.
   */
  get deferredAttachments(): readonly DeferredAttachment[] {
    return this.lastDeferred;
  }

  /**
   * Every attachment the last completed pass refused to FETCH because it is
   * larger than this device will load (§7.4, §7.5).
   *
   * Deliberately not folded into `deferredAttachments`: this is the bucket with no
   * remedy here, because `fetchVerdict` tests the cap before it consults an
   * approval. Naming it in the same breath as "available" would offer a button
   * that cannot work however many times it is pressed.
   */
  get tooLargeAttachments(): readonly DeferredAttachment[] {
    return this.lastTooLarge;
  }

  /**
   * Every attachment the workspace store has definitely answered that it no
   * longer holds (§6.5).
   *
   * The only one of the three that nothing done on this device can lift, so it is
   * the one whose wording has to send the user to a PERSON rather than to a
   * command.
   */
  get unavailableAttachments(): readonly DeferredAttachment[] {
    return this.lastUnavailable;
  }

  /**
   * Stop mutating the vault. Imposed from outside, so no pass may re-diagnose it
   * away; only `clearReadOnly` (a genuine reconnect, or a plugin reload) lifts it.
   */
  enterReadOnly(reason: string): void {
    if (this.paused !== null && !this.paused.recheck) return;   // the first imposed reason wins
    this.setPaused(reason, false);
  }

  /**
   * Resume after a genuine reconnect.
   *
   * Nothing is asserted about the vault here: the next pass re-runs the share
   * root and mount checks from scratch and pauses again if either still holds,
   * before it has mutated anything. Read-only is therefore recoverable without
   * ever being recovered ON FAITH — which matters because the alternative,
   * shipped until now, was a reconciler that refused every pass for the rest of
   * the session while `Bootstrap` reported the client as `ready`.
   */
  clearReadOnly(): void {
    this.paused = null;
    this.announced = null;
  }

  private setPaused(reason: string, recheck: boolean): void {
    this.paused = { reason, recheck };
    if (this.announced === reason) return;                      // re-diagnosis, not news
    this.announced = reason;
    this.notice(reason);
  }

  /**
   * Single-flight. A call arriving while a pass is running marks the pass dirty
   * and is refused; the running pass then re-runs once so the caller's change is
   * not lost. Debounced scheduling is P1c's concern — this is timer-free.
   */
  async reconcile(cause: ReconcileCause): Promise<ReconcileResult> {
    if (this.running) {
      this.dirty = true;
      return refused('a reconcile pass is already running');
    }
    let result = await this.runPass(cause);
    while (this.dirty) {
      this.dirty = false;
      result = await this.runPass('retry');
    }
    return result;
  }

  // ---------------------------------------------------------- the pass

  private async runPass(cause: ReconcileCause): Promise<ReconcileResult> {
    // A verdict this reconciler reached itself is dropped here and re-derived
    // below. Both re-derivations run BEFORE anything is mutated, so the worst a
    // stale pause costs is one `vault.exists` and one `vault.list`.
    if (this.paused?.recheck === true) this.paused = null;
    if (this.paused !== null) return refused(this.paused.reason);

    // I2: a share root that is not there is a wrong mount or a moved folder, and
    // never evidence that the user deleted everything in it.
    if (!(await this.exists(this.shareRoot))) {
      const reason = 'The shared folder no longer exists. Sync is paused.';
      this.setPaused(reason, true);
      return refused(reason);
    }

    this.running = true;
    const failures: ReconcileFailure[] = [];
    const diagnostics: ReconcileDiagnostics = {
      pending: [], invalid: [], deletedButPresent: [], tooLarge: [], deferred: [],
      unavailable: [], rehashDeferred: [], fetchTooLarge: [],
    };
    // Stays null until bindings have been observed, so a refusal partway through
    // cannot let the `finally` block rebuild `materialized` from an empty map.
    let ctx: PassContext | null = null;

    try {
      const disk = DiskIndex.build(this.deps.vault, this.shareRoot);
      if (this.preexistingDirs === null) {
        this.preexistingDirs = new Set(disk.dirsUnderShare().map(fold));
      }
      const draft = this.describeDesiredState(disk, failures, diagnostics, cause);

      // MOUNT SANITY (spec §4.1/§4.3): the tree wants files, the share holds
      // files, and not one of them is a file we put there. That shape means the
      // share root points somewhere else, not that the vault is empty.
      const mismatch = this.mountMismatch(disk, draft.desired.size, cause);
      if (mismatch !== null) {
        this.setPaused(mismatch, true);
        return refused(mismatch);
      }
      // Past both guards: the vault is about to be mutated, so whatever the user
      // was last told is stale and a future pause is news again.
      this.announced = null;

      await this.recoverStaging(draft);          // step 0
      this.observeBindings(draft);
      ctx = draft;

      await this.ensureFolders(ctx);             // step 1
      await this.applyMoves(ctx);                // step 2 (+ unstageAll)
      await this.reconcileBlobBytes(ctx);        // step 2.5
      await this.materialize(ctx);               // step 3
      await this.runDeletions(ctx);              // step 4 — injected collaborator
      await this.sweepEmptyFolders(ctx);         // step 5
      await this.publish(ctx);                   // steps 6-7 — injected collaborator

      return { ran: true, failures, diagnostics };
    } finally {
      // I15: whatever happened above, leave nothing armed, record what is
      // actually on disk, and never stay wedged.
      try {
        this.deps.tickets.clearArmed();
        this.absorbCollaboratorBindings(ctx);
        this.recordDeferredAttachments(ctx);
        this.rebuildDeviceStateFromObserved(ctx);
        await this.persist();
      } finally {
        this.lastPassFailed = failures.length > 0;
        this.running = false;
      }
    }
  }

  // ---------------------------------------------------------- desired + observed state

  /**
   * Spec §4.3's "desired state" block, with share-relative paths lifted to vault
   * paths by §4.4's `vaultPathOf`.
   *
   * `wantAtFold` and the dead-node maps are rebuilt from real paths rather than
   * re-keyed from `deriveTree`'s already-folded output. Two reasons: prefixing a
   * folded string assumes `fold` distributes over concatenation, which
   * context-sensitive lowercasing does not guarantee; and CF-1 needs the dead
   * nodes' IDS, which a set of folded paths cannot give back.
   */
  private describeDesiredState(
    disk: DiskIndex,
    failures: ReconcileFailure[],
    diagnostics: ReconcileDiagnostics,
    cause: ReconcileCause,
  ): PassContext {
    // §5.5. A node awaiting the unshare answer is withheld from the derivation
    // ENTIRELY, which is precisely what `deriveTree` does with an invalid one: it
    // gets no derived path, implies no folder, occupies no slot, contributes no
    // tombstone. Filtering here rather than testing the set at each of the four
    // mutation sites is what makes "exactly like an invalid node" true by
    // construction instead of by four separate remembered checks.
    const frozen = this.deps.pendingDecision?.() ?? EMPTY_SET;
    const entries: Array<[string, NodeFields]> = [];
    const withheld: string[] = [];
    for (const entry of this.deps.entries()) {
      if (frozen.has(entry[0])) withheld.push(entry[0]);
      else entries.push(entry);
    }
    const derived = deriveTree(entries);

    const desired = new Map<string, { path: string; kind: Kind }>();
    const wantAtFold = new Map<string, string>();
    for (const [id, rel] of derived.files) {
      const path = this.vaultPathOf(rel);
      // The DISK kind, which is `'f'` for a note and for an attachment alike: an
      // attachment is an ordinary file on disk, and `DiskIndex` speaks the disk's
      // vocabulary. WHICH of the two a node is, is `blobRefs` below.
      desired.set(id, { path, kind: 'f' });
      wantAtFold.set(fold(path), id);
    }
    const folderPaths: string[] = [];
    for (const rel of derived.folders) folderPaths.push(this.vaultPathOf(rel));
    // Folders claim their fold LAST, matching deriveTree: a directory outranks a
    // file at the same folded path, because directories carry no content.
    for (const path of folderPaths) wantAtFold.set(fold(path), DIR_SENTINEL);
    folderPaths.sort(byDepthAsc);

    const deadNodes = new Map<string, NodeFields>();
    const deadFold = new Set<string>();
    for (const [id, f] of entries) {
      if (!validateRel(f.d, f.n, f.k)) continue;       // invalid: never acted on at all (I10)
      if (isLive(f)) continue;
      deadNodes.set(id, f);
      deadFold.add(fold(this.vaultPathOf(relPath(f))));
    }

    const deadFolderPaths: string[] = [];
    for (const rel of derived.deadFolders) deadFolderPaths.push(this.vaultPathOf(rel));
    deadFolderPaths.sort(byDepthDesc);

    diagnostics.pending = [...derived.pending];
    // Withheld ids join `invalid` rather than getting a channel of their own: the
    // user-visible meaning is identical ("this node was skipped, nothing was
    // touched"), and adding a field would be a public surface change.
    diagnostics.invalid = [...derived.invalid, ...withheld].sort(cmp);

    const have = new Map<string, string>();
    const boundAtFold = new Map<string, string>();
    const removedThisPass = new Set<string>();

    const ctx: PassContext = {
      cause,
      deadNodes,
      deadFold,
      deadMaterializedFold: new Set<string>(),
      wantAtFold,
      have,
      boundAtFold,
      disk,
      failures,
      removedThisPass,
      vault: this.deps.vault,
      blobs: this.deps.blobs,
      docs: this.deps.docs,
      state: this.deps.state,
      tickets: this.deps.tickets,
      shareRoot: this.shareRoot,
      notice: this.notice,
      now: this.now,
      desired,
      blobRefs: derived.blobs,
      // Taken, not read: the watcher hands the set over and starts a fresh one, so
      // a save that lands while this pass runs is answered by the next pass rather
      // than silently absorbed by this one after its hashing was decided.
      dirtyPaths: this.deps.takeDirtyPaths?.() ?? EMPTY_SET,
      deferredByPolicy: new Set<string>(),
      folderPaths,
      deadFolderPaths,
      vacatedDirs: new Set<string>(),
      diagnostics,
      guarded: (key, fn) => this.guarded(failures, key, fn),
      bind: (id, path) => this.bindPath(ctx, id, path),
      unbind: (id) => this.unbindPath(ctx, id),
    };
    return ctx;
  }

  /** Spec §4.4: node paths are share-relative; the disk is not. */
  private vaultPathOf(rel: string): string {
    return `${this.shareRoot}/${rel}`;
  }

  /**
   * The mount guard: the tree wants files, the share already holds files, and not
   * one of them is a file this device put there.
   *
   * "Holds files" is counted over FILES only, deliberately. `disk.size()` also
   * counts the share root and every folder — including the folders step 1 creates
   * from the tree — so an ordinary sequence (a folder node arrives, then the file
   * that lives in it) would trip a guard measured on `size()` and wedge the client
   * in read-only on its very first real change.
   *
   * And every clause below is a statement about what was OBSERVED. A pass that
   * failed observed nothing it can be held to (I2): `adopt` and `materialize`
   * throw `RetryLater` when a content doc has not synced, which is expected and
   * transient (I4), and they bind nothing when they do. "Nothing is bound"
   * after such a pass is a report about the network, not about the mount.
   */
  private mountMismatch(disk: DiskIndex, desiredCount: number, cause: ReconcileCause): string | null {
    if (cause === 'bootstrap') return null;
    if (this.lastPassFailed) return null;                  // I2: a failure is evidence of nothing
    if (desiredCount === 0) return null;
    if (disk.filesUnderShare().length === 0) return null;
    for (const path of Object.values(this.deps.state.data.materialized)) {
      if (disk.hasFold(path)) return null;                 // something is bound: the mount is fine
    }
    return "Local layout does not match ShadowLink's records. Re-run first sync.";
  }

  /**
   * I2: a binding whose file is missing is dropped from the working set, never
   * turned into a deletion. Step 3 re-materializes it in this same pass.
   */
  private observeBindings(ctx: PassContext): void {
    for (const [id, path] of Object.entries(this.deps.state.data.materialized)) {
      const literal = ctx.disk.literal(path);
      if (literal === undefined) continue;
      ctx.have.set(id, literal);
      ctx.boundAtFold.set(fold(literal), id);
    }
    // CF-1: where a dead node's file ACTUALLY sits, which its plain derived path
    // does not reveal once a collision suffix was applied.
    for (const id of ctx.deadNodes.keys()) {
      const path = this.deps.state.data.materialized[id];
      if (path !== undefined) ctx.deadMaterializedFold.add(fold(path));
    }
  }

  // ---------------------------------------------------------- step 0 / staging

  /** Step 0 of every pass: replay whatever an interrupted swap left behind. */
  private async recoverStaging(ctx: PassContext): Promise<void> {
    await this.drainStaging(ctx);
  }

  /** End of step 2: place everything the fixpoint loop parked in staging. */
  private async unstageAll(ctx: PassContext): Promise<void> {
    await this.drainStaging(ctx);
  }

  /**
   * Journal-driven, so it is identical whether the entries were written by this
   * pass or by a process that died before finishing one.
   */
  private async drainStaging(ctx: PassContext): Promise<void> {
    const ids = Object.keys(this.deps.state.data.staging).sort(cmp);
    for (const id of ids) {
      const entry = this.deps.state.data.staging[id];
      if (entry === undefined) continue;
      await this.guarded(ctx.failures, `staging:${id}`, async () => {
        const stagePath = `${STAGING_DIR}/${id}${extOf(entry.from)}`;
        // Staging lives OUTSIDE the share, so the share-scoped DiskIndex cannot
        // see it. Ask the adapter directly.
        if (!(await this.exists(stagePath))) {
          delete this.deps.state.data.staging[id];         // nothing parked: a stale journal line
          return;
        }
        const target = ctx.desired.get(id)?.path ?? entry.to;
        const placeable = target !== undefined
          && target !== ''
          && assertInsideShare(this.shareRoot, target)
          && !ctx.disk.hasFold(target);
        if (placeable) {
          await this.ensureDirs(ctx, dirOf(target));
          this.deps.tickets.arm('rename', stagePath, target);
          await this.deps.vault.rename(stagePath, target);
          ctx.disk.add(target, 'f');
          this.bindPath(ctx, id, target);
        } else {
          // The slot the file was heading for is gone or occupied. Park it
          // somewhere visible rather than holding it hostage in staging.
          const rescue = await this.uniquify(`${RECOVERED_DIR}/${baseOf(entry.from)}`);
          await this.ensureReservedDir(RECOVERED_DIR);
          this.deps.tickets.arm('rename', stagePath, rescue);
          await this.deps.vault.rename(stagePath, rescue);
          this.unbindPath(ctx, id);
          this.notice(`Recovered "${baseOf(entry.from)}" from an interrupted move.`);
        }
        delete this.deps.state.data.staging[id];
      });
    }
  }

  /**
   * Move a file out of the way through the visible staging folder.
   *
   * The journal is flushed BEFORE the rename, so the only crash window leaves a
   * file the user can see plus a journal line the next pass replays — never a
   * file that exists nowhere. If the rename then fails, the next pass finds no
   * staged file and drops the line.
   */
  private async stageOut(ctx: PassContext, id: string, from: string): Promise<void> {
    const target = ctx.desired.get(id)?.path;
    const stagePath = `${STAGING_DIR}/${id}${extOf(from)}`;
    this.deps.state.data.staging[id] = { from, to: target ?? from, at: this.now() };
    await this.deps.state.flush();
    await this.ensureReservedDir(STAGING_DIR);
    this.deps.tickets.arm('rename', from, stagePath);
    await this.deps.vault.rename(from, stagePath);
    ctx.disk.remove(from);          // staging is outside the share; it leaves the index entirely
    this.unbindPath(ctx, id);
    this.vacate(ctx, from);
  }

  /**
   * Note every directory between `from`'s parent and the share root as a step 5
   * sweep candidate.
   *
   * `applyMoves` relocates files, never directories (a folder rename arrives as
   * one `d` rewrite per descendant), and step 1 creates the folder they move
   * into — so the directory they came from is simply left standing, with a node
   * that is alive under its new name and therefore never a dead-folder
   * candidate.
   *
   * Positive evidence, which is why it outranks `preexistingDirs`: this pass
   * watched the last file leave. A folder that was already there when the
   * session began is otherwise left alone, but one the pass itself emptied is a
   * folder the tree has demonstrably moved on from.
   */
  private vacate(ctx: PassContext, from: string): void {
    const rootFold = fold(this.shareRoot);
    for (let dir = dirOf(from); dir !== ''; dir = dirOf(dir)) {
      const key = fold(dir);
      if (key === rootFold) return;                       // the share root is not a node (I14)
      if (!key.startsWith(`${rootFold}/`)) return;        // staging / recovered: not ours to sweep
      ctx.vacatedDirs.add(dir);
    }
  }

  // ---------------------------------------------------------- step 1

  /**
   * Spec §4.2. Walks from the share root down, skipping what the folded index
   * already holds, and arms a ticket before every `createFolder`.
   *
   * The ticket is not cosmetic: without it every implicitly-created folder fires
   * an unguarded `create` on every client, each of which mints its own folder
   * node, and the workspace accumulates permanent duplicates.
   */
  private async ensureDirs(ctx: PassContext, dirPath: string): Promise<void> {
    if (dirPath === '' || fold(dirPath) === fold(this.shareRoot)) return;
    if (!assertInsideShare(this.shareRoot, dirPath)) {
      throw new Error(`ensureDirs: path is outside the share: ${dirPath}`);
    }
    const segs = dirPath.split('/');
    const rootDepth = depthOf(this.shareRoot);
    for (let i = rootDepth + 1; i <= segs.length; i++) {
      const p = segs.slice(0, i).join('/');
      if (ctx.disk.hasFold(p)) continue;                     // I11: folded, never `vault.exists`
      this.deps.tickets.arm('create', p);
      await this.deps.vault.createFolder(p);
      ctx.disk.add(p, 'd');
    }
  }

  /** CF-8: sort by depth explicitly. CF-2: dir nodes do not imply their ancestors. */
  private async ensureFolders(ctx: PassContext): Promise<void> {
    for (const path of ctx.folderPaths) {
      await this.guarded(ctx.failures, `folder:${path}`, () => this.ensureDirs(ctx, path));
    }
  }

  // ---------------------------------------------------------- step 2

  /**
   * Move every bound node that is not where the tree wants it, as a fixpoint.
   *
   * A destination occupied by a DIFFERENT node is skipped and retried next round.
   * When a whole round makes no progress the remainder is a genuine swap or
   * rotation, so the lowest nodeId is staged out to break it. A case-only rename
   * always routes through staging, because a folding filesystem refuses to rename
   * a path onto itself.
   *
   * Only FILES move here. `deriveTree` assigns a derived path to file nodes only;
   * a folder is converged by creating the path the tree asks for (step 1) and
   * sweeping the dead one when it is empty (step 5), never by relocating a
   * directory out from under files that are being moved in the same pass. A
   * folder rename therefore arrives as one move per descendant, which is exactly
   * what a per-node `d` rewrite means (spec §4.1).
   *
   * Renaming is also the operation that is SAFE while a note is open — Obsidian
   * keeps the same TFile and the same leaf — so there is deliberately no
   * `isOpenInLeaf` check here. I7 governs writes to a file's bytes (adopt,
   * materialize), not relocation.
   */
  private async applyMoves(ctx: PassContext): Promise<void> {
    let queue: string[] = [];
    for (const [id, from] of ctx.have) {
      const want = ctx.desired.get(id);
      if (want === undefined) continue;
      if (from !== want.path) queue.push(id);
    }
    queue.sort((a, b) => byDepthAsc(ctx.have.get(a)!, ctx.have.get(b)!) || cmp(a, b));

    while (queue.length > 0) {
      let progress = false;
      for (const id of [...queue]) {
        const from = ctx.have.get(id);
        const to = ctx.desired.get(id)?.path;
        if (from === undefined || to === undefined) {
          queue = queue.filter((q) => q !== id);
          continue;
        }
        const occupant = ctx.disk.literal(to);
        if (occupant !== undefined && fold(occupant) !== fold(from)) continue;   // blocked; retry
        const caseOnly = fold(from) === fold(to) && from !== to;

        await this.guarded(ctx.failures, `move:${id}`, async () => {
          if (caseOnly) {
            await this.stageOut(ctx, id, from);
            return;
          }
          if (!assertInsideShare(this.shareRoot, to)) {
            throw new Error(`move: destination is outside the share: ${to}`);
          }
          await this.ensureDirs(ctx, dirOf(to));
          this.deps.tickets.arm('rename', from, to);
          await this.deps.vault.rename(from, to);                                 // I16
          ctx.disk.move(from, to);
          this.bindPath(ctx, id, to);
          this.vacate(ctx, from);
        });
        // Dropped from the queue whether or not it succeeded: a failure is
        // recorded and retried on the NEXT pass, never spun on inside this one.
        queue = queue.filter((q) => q !== id);
        progress = true;
      }

      if (!progress) {
        const victim = [...queue].sort(cmp)[0];
        const from = ctx.have.get(victim);
        if (from !== undefined) {
          await this.guarded(ctx.failures, `stage:${victim}`, () => this.stageOut(ctx, victim, from));
        }
        queue = queue.filter((q) => q !== victim);
      }
    }

    await this.unstageAll(ctx);
  }

  // ---------------------------------------------------------- step 2.5

  /**
   * Spec §3.5. Make each bound attachment's BYTES and the tree agree.
   *
   * It runs after the moves and before materialize, over every bound, live,
   * published `'b'` node, sorted by id — and it is a full recompute, never a
   * delta (I8): the verdict is a function of three hashes that are all re-read
   * every pass, so a missed event, a crash and a restart all converge to the same
   * answer as an uninterrupted run.
   *
   * The cost is what makes this affordable at three gigabytes: `b` rides in the
   * tree, which is already synced, so "is my copy current?" is one `stat` per
   * attachment and a hash only when the recorded size and mtime disagree with
   * what is on disk. Nothing here opens a room, and nothing here touches the
   * network unless a verdict says bytes have to move.
   *
   * `blobRefs` is the kind test for the whole pass (it is derived once, from the
   * same derivation as `desired`), so this loop never re-asks what a node is.
   */
  private async reconcileBlobBytes(ctx: PassContext): Promise<void> {
    const budget: RehashBudget = { remaining: this.rehashBudgetBytes(), spent: 0 };

    for (const id of [...ctx.blobRefs.keys()].sort(cmp)) {
      const ref = ctx.blobRefs.get(id)!;
      const path = ctx.have.get(id);
      // Not bound HERE: nothing on this disk is this node's copy yet, so there is
      // nothing to compare. Step 3 adopts the file at its path or materializes it.
      if (path === undefined) continue;

      await this.guarded(ctx.failures, `bytes:${id}`, async () => {
        // I2: null is a definite not-found — the file went away between `list()`
        // and now, and step 3 re-materializes it. A `stat` that could not look
        // REJECTS, and leaves through `guarded` with no verdict reached at all.
        const st = await this.deps.vault.stat(path);
        if (st === null) return;

        const base = this.deps.state.data.contentHash[id];
        // The staleness oracle, and both clauses are load-bearing. SIZE alone
        // misses every same-size edit; without the MTIME clause a recorded hash is
        // trusted for ever, so an edit made while Obsidian was closed is invisible.
        // A base with no mtime at all (the post-write `stat` did not answer) is not
        // trusted either: this device confirmed a hash but never confirmed WHEN.
        const fresh = base !== undefined
          && base.mtime !== undefined
          && base.mtime === st.mtime
          && base.len === st.bytes;
        const local = fresh
          ? base.sha256
          : await this.hashWithBudget(ctx, id, path, st.bytes, budget);
        // Refused by the cap or the budget. NEVER "assume converged": the whole
        // point of refusing is that this device does not know what is on disk.
        if (local === null) return;

        switch (replaceVerdict(local, ref, base?.sha256)) {
          case 'converged':
            // I17 in its cheapest form: what was confirmed, and when. Recording it
            // is what makes every later pass one `stat`.
            this.recordBlobHash(id, local, st.bytes, st.mtime);
            return;
          case 'republish':
            // The difference is ours and unpublished. The base is deliberately NOT
            // advanced here — it names what is simultaneously on disk and in the
            // tree, and the tree does not name these bytes until the publish
            // confirms (I17).
            this.deps.requeuePublish?.(id, local);
            return;
          case 'replace':
            await this.cleanReplace(ctx, id, path, ref, st);
            return;
          default:
            await this.forkAndTake(ctx, id, path, local, ref, st);
        }
      });
    }
  }

  /**
   * Hash a file, or refuse — and a refusal is never an answer about its content.
   *
   * TWO ceilings, for two different failures. The memory cap is about this device
   * (§7.4): hashing needs the whole file in memory, and a phone that reads a
   * 200 MB video to answer a question it could have skipped simply dies. The
   * per-pass budget is about this PASS: a cold share has no recorded mtimes, so
   * without it the first pass hashes everything at once and the plugin appears to
   * hang on launch.
   *
   * A path the modify handler flagged bypasses the budget but NOT the cap: the
   * user just saved that file, and answering "not this pass" for the one change
   * they made is the wrong trade. The charge is still taken, so one huge save
   * cannot also drag the rest of the share through the same pass.
   */
  private async hashWithBudget(
    ctx: PassContext,
    id: string,
    path: string,
    bytes: number,
    budget: RehashBudget,
  ): Promise<string | null> {
    if (bytes > this.memoryCapBytes()) {
      ctx.diagnostics.tooLarge.push(id);
      return null;
    }
    const urgent = ctx.dirtyPaths.has(fold(path));
    // `spent > 0` keeps the first hash of every pass permitted however large it
    // is, so a share whose smallest attachment exceeds the budget still converges
    // instead of deferring the same node for ever.
    if (!urgent && budget.spent > 0 && bytes > budget.remaining) {
      ctx.diagnostics.rehashDeferred.push(id);
      return null;
    }
    budget.spent += bytes;
    budget.remaining -= bytes;
    return await hashOfBytes(await this.deps.vault.readBinary(path));
  }

  /** How many bytes this pass may re-hash before it starts deferring (§3.5). */
  private rehashBudgetBytes(): number {
    return this.deps.rehashBudgetBytes?.() ?? REHASH_BUDGET_BYTES;
  }

  // ---------------------------------------------------------- step 3

  /**
   * Materialize every desired file that is not already bound — content FIRST.
   *
   * I6/I4: the bytes are fetched before anything touches the disk, and a doc that
   * did not genuinely sync creates nothing at all. A zero-byte file on the
   * canonical path is worse than no file, because it looks correct and gets
   * deleted by hand.
   */
  private async materialize(ctx: PassContext): Promise<void> {
    for (const id of this.materializeOrder(ctx)) {
      const path = ctx.desired.get(id)!.path;
      if (ctx.have.has(id)) continue;
      if (ctx.disk.hasFold(path)) {
        await this.adopt(ctx, id, ctx.disk.literal(path)!);       // I11: the LITERAL casing
        continue;
      }
      // The kind branch, BEFORE anything opens a room or reads a file. A `'b'`
      // node's content lives in the store, not in a content doc, and opening one
      // for it would wait out the sync timeout on a room that will never hold
      // anything — once per attachment, on every pass.
      const ref = ctx.blobRefs.get(id);
      if (ref !== undefined) {
        await this.guarded(
          ctx.failures, `materialize:${id}`, () => this.materializeBlob(ctx, id, path, ref),
        );
        continue;
      }
      await this.guarded(ctx.failures, `materialize:${id}`, async () => {
        const opened = await this.deps.docs.openHeadless(`n_${id}`);
        try {
          if (!opened.synced) throw new RetryLater(`content doc n_${id} did not sync`);
          if (!assertInsideShare(this.shareRoot, path)) {
            throw new Error(`materialize: path is outside the share: ${path}`);
          }
          await this.ensureDirs(ctx, dirOf(path));
          this.deps.tickets.arm('create', path);
          await this.deps.vault.create(path, opened.text);        // ONE write, never a stub
          ctx.disk.add(path, 'f');
          this.bindPath(ctx, id, path);
          await this.recordHash(id, opened.text);                 // I17: only after the write returned
        } finally {
          this.deps.docs.close(opened.handle);
        }
      });
    }
  }

  /**
   * The order step 3 works in: notes first by id, then attachments by ASCENDING
   * BYTE COUNT (§7.2).
   *
   * The byte order is the load-bearing half. A session budget has to stop
   * somewhere, and where it stops must be a decision rather than an accident of
   * 22 random nodeId characters: sorting by size makes the cutoff identical on
   * every device that sees the same tree, and it maximizes the number of FILES
   * that fit in a given allowance instead of spending it on whichever happened to
   * sort first. Ties break on the id, so the order is total.
   *
   * Notes lead because they cost the blob budget nothing, and because the pass
   * that materializes a note is the pass the user is actually waiting on. Nothing
   * else depends on the order: `deriveTree` gives every node its own path, so no
   * two items in this loop can contend for one slot.
   */
  private materializeOrder(ctx: PassContext): string[] {
    return [...ctx.desired.keys()].sort((a, b) => {
      const ra = ctx.blobRefs.get(a);
      const rb = ctx.blobRefs.get(b);
      if (ra === undefined && rb === undefined) return cmp(a, b);
      if (ra === undefined) return -1;
      if (rb === undefined) return 1;
      return ra.bytes - rb.bytes || cmp(a, b);
    });
  }

  /**
   * Spec §3.3. An attachment arrives: fetch, verify what arrived, then ONE write.
   *
   * The discipline is the markdown path's, for the same reason — a file that
   * exists but holds the wrong bytes looks correct, so the user deletes it by
   * hand — and two things make it stricter here. The bytes are checked TWICE,
   * once inside `BlobPort.get` and once again below, because two independent
   * checks is the entire point of having both ends verify. And nothing is written
   * on a failure: a fetch that did not complete is a `RetryLater`, never a stub,
   * never a zero-byte file, and never a delete (I2, I6).
   */
  private async materializeBlob(
    ctx: PassContext,
    id: string,
    path: string,
    ref: BlobRef,
  ): Promise<void> {
    // §7.2/§7.4. Refused BEFORE the request is made: `get` buffers the whole
    // object, so a device that discovers the problem afterwards has already paid
    // for it. The node stays live, valid, published and simply unmaterialized
    // here — and a refusal writes nothing at all: no stub, no sidecar, no
    // zero-byte placeholder standing in for the file (I6, §7.3).
    if (!this.mayFetch(ctx, id, ref)) return;

    const bytes = await this.fetchBlob(ref);
    // `get` never throws and answers null for every failure there is. Not one of
    // them is evidence about the user's disk (I2) — but one of them, a definite
    // 404, is evidence about the STORE, and that one is reported rather than
    // retried for ever.
    if (bytes === null) {
      if (this.reportUnavailable(ctx, id)) return;
      throw new RetryLater(`blob ${ref.sha256} did not fetch`);
    }
    // The second of two independent checks. `get` verified the length and the
    // digest already; this is what makes that a claim rather than an assumption,
    // and it costs one hash of bytes that are already in memory.
    if (await hashOfBytes(bytes) !== ref.sha256) {
      throw new Error(`materialize: ${path} did not match its digest`);
    }
    if (!assertInsideShare(this.shareRoot, path)) {
      throw new Error(`materialize: path is outside the share: ${path}`);
    }

    await this.ensureDirs(ctx, dirOf(path));
    // BOTH tickets, and both before the write. `create` suppresses the echo the
    // watcher would otherwise read as the user adding a file; `modify` suppresses
    // the one P2-d's handler would read as the user editing it, which for a `'b'`
    // node means requeueing a publish of the bytes we have just fetched.
    this.deps.tickets.arm('create', path);
    this.deps.tickets.arm('modify', path);
    await this.deps.vault.createBinary(path, bytes);              // ONE write, never a stub
    ctx.disk.add(path, 'f');
    this.bindPath(ctx, id, path);
    // I17: the base is recorded only once the write has RETURNED, and it carries
    // the mtime that write produced — which is what lets the next pass decide "is
    // my copy current?" with one `stat` instead of re-hashing the file.
    const st = await this.deps.vault.stat(path);
    this.recordBlobHash(id, ref.sha256, ref.bytes, st?.mtime);
  }

  /**
   * §7.2's fetch policy, at the one place every fetch goes through.
   *
   * Three call sites ask it — materialize, clean replace and fork — and all three
   * ask BEFORE any request is made, because `get` buffers the whole object and a
   * device that discovers the problem afterwards has already paid for it.
   *
   * The three refusals are three different user-actionable states, and each is
   * recorded differently:
   *
   *  - `tooLarge` is a fact about this DEVICE (§7.4). Reported, never persisted:
   *    it is re-derived for free from a reference that is already in the tree, and
   *    persisting it would mean re-showing a dismissed notice on every launch.
   *  - `needsApproval` is a decision about this FILE, so it is persisted — that
   *    record is what lets the download button in a note know the attachment
   *    exists, and how big it is, with no pass running.
   *  - `sessionBudget` is a statement about this AFTERNOON, so it is written
   *    nowhere at all and the next session starts from zero.
   */
  private mayFetch(ctx: PassContext, id: string, ref: BlobRef): boolean {
    const verdict = fetchVerdict(
      ref.bytes,
      this.fetchLimits(),
      this.deps.state.data.fetchApproved[id] === true,
      this.sessionFetchedBytes,
    );
    switch (verdict) {
      case 'yes':
        return true;
      case 'tooLarge':
        ctx.diagnostics.tooLarge.push(id);
        // ...and again in the narrow channel, because THIS is the writer that
        // means the bytes are not on the disk. The other two `tooLarge` sites
        // describe a local file the device merely cannot hash, and a user surface
        // that could not tell them apart would call a downloaded attachment
        // missing (§7.5).
        ctx.diagnostics.fetchTooLarge.push(id);
        return false;
      case 'needsApproval':
        ctx.diagnostics.deferred.push(id);
        ctx.deferredByPolicy.add(id);
        this.recordDeferral(id, ref);
        return false;
      default:
        ctx.diagnostics.deferred.push(id);
        // Deliberately no write. The id still joins `deferredByPolicy` so that an
        // EARLIER approval record is not dropped by this pass — leaving a record
        // alone and writing one are different things, and only the second is what
        // §7.2 forbids here.
        ctx.deferredByPolicy.add(id);
        return false;
    }
  }

  /**
   * Fetch an attachment's bytes and charge the session budget for them.
   *
   * THE CHARGE IS ON A COMPLETED FETCH, NEVER ON AN ATTEMPT. `get` answers null
   * for every failure there is, so a flaky link would otherwise burn the whole
   * session allowance retrying one file and leave the user with an afternoon of
   * "not downloaded" for a connection that was merely bad.
   */
  private async fetchBlob(ref: BlobRef): Promise<Uint8Array | null> {
    const bytes = await this.deps.blobs.get(ref.sha256, ref.bytes);
    if (bytes === null) return null;
    this.sessionFetchedBytes += bytes.length;
    return bytes;
  }

  /**
   * Did the fetch fail because the store has DEFINITELY answered that it does not
   * hold those bytes (§6.5)?
   *
   * The distinction is the whole value of the `unavailable` channel. `get` answers
   * null for a socket that closed, a proxy that lied, a truncated body and a 404
   * alike, and only the last of those is a statement about the object. Reporting
   * the others as "the bytes are gone" would tell the user their attachment is
   * lost every time the network hiccups — so anything that is not a definite
   * `BlobUnavailable` stays a `RetryLater`, and the next pass asks again.
   *
   * @returns true when the caller should stop, having reported it.
   */
  private reportUnavailable(ctx: PassContext, id: string): boolean {
    if (!(this.deps.blobs.lastError instanceof BlobUnavailable)) return false;
    ctx.diagnostics.unavailable.push(id);
    return true;
  }

  /**
   * §7.2: write the deferral only when its VALUE changes.
   *
   * `DeviceState.flush()` serializes the whole state object, so an unconditional
   * per-pass write of ~1,100 records turns persistence into a multi-megabyte write
   * every couple of seconds — on a phone, on battery, for a map that did not move.
   */
  private recordDeferral(id: string, ref: BlobRef): void {
    const current = this.deps.state.data.fetchDeferred[id];
    if (current !== undefined && current.sha256 === ref.sha256 && current.bytes === ref.bytes) {
      return;
    }
    this.deps.state.data.fetchDeferred[id] = { sha256: ref.sha256, bytes: ref.bytes };
    this.deps.state.schedulePersist();
  }

  /**
   * Close the pass's account with `fetchDeferred`, and remember what the UI has
   * to say about it (§7.3).
   *
   * Every id NOT refused by policy this pass is dropped: it was fetched, it was
   * adopted from a file that was already there, or the tree no longer has it.
   * Without the drop the map only ever grows, and a status bar counting files the
   * user downloaded last week is worse than no status bar.
   */
  private recordDeferredAttachments(ctx: PassContext | null): void {
    if (ctx === null) return;                    // the pass refused; it observed nothing
    for (const id of Object.keys(this.deps.state.data.fetchDeferred)) {
      if (!ctx.deferredByPolicy.has(id)) delete this.deps.state.data.fetchDeferred[id];
    }

    this.lastDeferred = this.describe(ctx, ctx.diagnostics.deferred);
    // §7.5 and §6.5 reach the user through the same rescue, and through their own
    // lists rather than through `deferred`'s: all three are "this version is not
    // here", and only the first has a remedy on this device.
    this.lastTooLarge = this.describe(ctx, ctx.diagnostics.fetchTooLarge);
    this.lastUnavailable = this.describe(ctx, ctx.diagnostics.unavailable);
  }

  /**
   * Node ids -> everything a user surface needs to talk about them.
   *
   * `blobRefs` and `desired` are the pass's own derivation, so the path and the
   * size come from the same place the verdict did rather than from a second guess
   * about the tree. An id neither of them knows is dropped: the alternative is a
   * status bar naming a file whose node the pass could not resolve.
   *
   * Rebuilt from scratch every pass and never accumulated, because a list still
   * counting what stopped being outstanding last week is worse than no list.
   */
  private describe(ctx: PassContext, ids: readonly string[]): DeferredAttachment[] {
    const seen = new Set<string>();
    const out: DeferredAttachment[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const ref = ctx.blobRefs.get(id);
      const want = ctx.desired.get(id);
      if (ref === undefined || want === undefined) continue;
      out.push({ id, path: want.path, sha256: ref.sha256, bytes: ref.bytes });
    }
    out.sort((a, b) => cmp(a.path, b.path));
    return out;
  }

  /** The three ceilings §7.2 decides against, as one value. */
  private fetchLimits(): FetchLimits {
    return {
      memoryCapBytes: this.memoryCapBytes(),
      autofetchMaxBytes: this.deps.autofetchMaxBytes?.() ?? AUTOFETCH_MAX_BYTES,
      sessionBudgetBytes: this.deps.sessionBudgetBytes?.() ?? AUTOFETCH_SESSION_BUDGET,
    };
  }

  /** The largest attachment this device will hold in memory (§7.4). */
  private memoryCapBytes(): number {
    return this.deps.memoryCapBytes?.() ?? BLOB_MAX_BYTES;
  }

  /**
   * The base for a `'b'` node: what this device confirmed is simultaneously on
   * disk and named by the tree.
   *
   * Never `recordHash`, which normalizes line endings before hashing. That rule is
   * about text; applied to a PNG it both changes the file's identity — so the hash
   * this device computes is not the hash the store holds — and can make two
   * genuinely different files hash equal (I18).
   */
  private recordBlobHash(id: string, sha256: string, len: number, mtime?: number): void {
    this.deps.state.data.contentHash[id] = mtime === undefined
      ? { sha256, len }
      : { sha256, len, mtime };
  }

  /**
   * A local file already sits where a live, seeded node wants to be (spec §4.3).
   *
   * The local copy is moved into `ShadowLink Recovered/` BEFORE the shared bytes
   * are written, so at no point do the user's bytes exist only in memory.
   *
   * DEVIATION from the spec's pseudocode, which stashes with `vault.create(dest,
   * local)` and then overwrites with a second `vault.create(path, text)`:
   * `VaultPort.create` refuses an occupied path outright (it never
   * blind-overwrites, by design), and the port has no `modify`. Renaming the
   * occupant out and creating in its place uses only operations the port
   * actually offers, and it is strictly safer — the stash cannot fail after the
   * original has been overwritten, because the original IS the stash.
   */
  private async adopt(ctx: PassContext, id: string, path: string): Promise<void> {
    // THE KIND BRANCH, before anything reads. Everything below this line assumes
    // the file is text: `vault.read` decodes it as UTF-8, the comparison is a
    // string comparison, and the resolution writes a string. Handed a PNG, that
    // path decodes to mojibake, concludes it differs from the content doc,
    // renames the user's real attachment into `ShadowLink Recovered/` and creates
    // an EMPTY FILE at the canonical path — on every cold start, on every second
    // device, and for every entry in Bootstrap's adopt bucket.
    const ref = ctx.blobRefs.get(id);
    if (ref !== undefined) {
      await this.adoptBlob(ctx, id, path, ref);
      return;
    }
    await this.guarded(ctx.failures, `adopt:${id}`, async () => {
      if (ctx.disk.kindOf(path) !== 'f') {
        throw new Error(`adopt: ${path} is not a file`);          // never touched, never deleted
      }
      // I7: writing under a live yCollab binding turns Obsidian's external-change
      // reload into a whole-document overwrite broadcast to every peer.
      if (this.deps.vault.isOpenInLeaf(path)) return;             // deferred to the next pass

      const local = normLF(await this.deps.vault.read(path));
      const opened = await this.deps.docs.openHeadless(`n_${id}`);
      try {
        if (!opened.synced) throw new RetryLater(`content doc n_${id} did not sync`);
        if (normLF(opened.text) !== local) {
          const dest = await this.uniquify(
            `${RECOVERED_DIR}/${stashName(path, this.now())}`,
          );
          await this.ensureReservedDir(RECOVERED_DIR);
          this.deps.tickets.arm('rename', path, dest);
          await this.deps.vault.rename(path, dest);
          ctx.disk.remove(path);
          this.deps.tickets.arm('create', path);
          await this.deps.vault.create(path, opened.text);        // the shared doc wins on disk
          ctx.disk.add(path, 'f');
          this.notice(
            `Your local "${baseOf(path)}" differed from the shared copy. `
            + `A copy was saved to ${RECOVERED_DIR}/.`,
          );
        }
        this.bindPath(ctx, id, path);
        await this.recordHash(id, opened.text);                   // I17
      } finally {
        this.deps.docs.close(opened.handle);
      }
    });
  }

  /**
   * Spec §3.4. A local file already sits where a live, published `'b'` node wants
   * to be. Decide by its BYTES, and by nothing else.
   *
   * This function never calls `vault.read`, `vault.create` or `openHeadless`, and
   * that is a promise about behaviour rather than about source text: the tests
   * that hold it drive a real pass and assert on the calls that were made.
   *
   * The only two outcomes are "these are the bytes the tree names, so bind" and
   * "these are not, so decide nothing yet". There is deliberately no third one
   * that writes: the local file is the user's, it is the only copy of whatever it
   * holds, and no amount of divergence makes overwriting it the right answer.
   */
  private async adoptBlob(
    ctx: PassContext,
    id: string,
    path: string,
    ref: BlobRef,
  ): Promise<void> {
    await this.guarded(ctx.failures, `adopt:${id}`, async () => {
      if (ctx.disk.kindOf(path) !== 'f') {
        throw new Error(`adopt: ${path} is not a file`);        // never touched, never deleted
      }
      // I7. A file the user has open in a view is one this pass does not touch,
      // and the fork below would rename it out from under that view.
      if (this.deps.vault.isOpenInLeaf(path)) return;           // deferred to the next pass

      // I2: `stat` resolves null only for a definite not-found and REJECTS when
      // the lookup failed, so a null here means the file went away between
      // `list()` and now — step 3 re-materializes it on a later pass — and a
      // rejection leaves through `guarded` without a decision being made at all.
      const st = await this.deps.vault.stat(path);
      if (st === null) return;

      // §7.4. Hashing needs the whole file in memory. A file this device cannot
      // hash is one it cannot decide anything about, so it decides nothing: no
      // binding (which would claim bytes we never compared), and no fork.
      if (st.bytes > this.memoryCapBytes()) {
        ctx.diagnostics.tooLarge.push(id);
        return;
      }

      const local = await hashOfBytes(await this.deps.vault.readBinary(path));
      if (local === ref.sha256) {
        // Converged before the pass even started: the file the user has IS the
        // file the workspace names. Binding is the entire job.
        this.bindPath(ctx, id, path);
        this.recordBlobHash(id, ref.sha256, st.bytes, st.mtime);
        return;
      }
      await this.forkAndTake(ctx, id, path, local, ref, st);
    });
  }

  /**
   * §3.5 rule 3. A peer replaced the file, and the version it published descends
   * from exactly the bytes on this disk — so nothing here is anybody's
   * unpublished work, and taking it is what "sync" means.
   *
   * FETCH FIRST, MUTATE SECOND, RE-CHECK BETWEEN, and each of the three is a
   * separate refusal to guess:
   *
   *  - the bytes are in hand and verified before anything is touched, so a fetch
   *    that fails leaves the file exactly where it was (I2);
   *  - `isOpenInLeaf` is asked AGAIN afterwards, mirroring `Deletions.applyOne`'s
   *    verdict/re-check pair, because a fetch is bounded by file size rather than
   *    by an 8 s doc timeout: this window is minutes wide, and the user can open
   *    the file inside it (I7);
   *  - the file itself is re-`stat`ed, because bytes that changed while the
   *    download ran are unpublished local work, and overwriting them would
   *    destroy the only copy of a change nobody else has seen.
   *
   * The swap then runs through the staging journal, so the only crash window
   * leaves a visible file and a replayable line rather than a hole.
   */
  private async cleanReplace(
    ctx: PassContext,
    id: string,
    path: string,
    ref: BlobRef,
    seen: { bytes: number; mtime: number },
  ): Promise<void> {
    // I7, before the request: a file the user has open is not one this pass pays
    // to download for, let alone writes to.
    if (this.deps.vault.isOpenInLeaf(path)) return;
    // §7.2/§7.4. Refused before the request is made, exactly as in
    // `materializeBlob`: the node stays live, valid, published and simply not
    // current on this device.
    if (!this.mayFetch(ctx, id, ref)) return;

    const bytes = await this.fetchBlob(ref);
    if (bytes === null) {
      if (this.reportUnavailable(ctx, id)) return;
      throw new RetryLater(`blob ${ref.sha256} did not fetch`);
    }
    // The second of two independent checks — the first lives inside the port, and
    // the point of the second is that the first can be wrong.
    if (await hashOfBytes(bytes) !== ref.sha256) {
      throw new Error(`replace: ${path} did not match its digest`);
    }

    // Everything below re-reads the world this verdict was based on.
    if (this.deps.vault.isOpenInLeaf(path)) return;
    const st = await this.deps.vault.stat(path);
    if (st === null || st.mtime !== seen.mtime || st.bytes !== seen.bytes) return;

    await this.swapBytes(ctx, id, path, bytes);
    // I17: the base advances only once the write has RETURNED, and it carries the
    // mtime that write produced.
    const after = await this.deps.vault.stat(path);
    this.recordBlobHash(id, ref.sha256, ref.bytes, after?.mtime);
  }

  /**
   * Replace a file's bytes without ever hard-deleting them, and without a moment
   * in which they exist nowhere (spec §8.1).
   *
   * There is deliberately NO in-place write anywhere in this plugin: an
   * interrupted overwrite leaves a corrupt file at the canonical path with no way
   * to detect it. The previous bytes are RENAMED into the visible staging folder
   * — journal first, rename second — and only then does the new file appear. A
   * crash between the two leaves a file the user can see plus a line
   * `drainStaging` replays; trash-then-create would leave a hole instead.
   *
   * The staged name is per-nodeId, so repeated replaces of DIFFERENT files cannot
   * collide on one basename in the flat vault trash.
   */
  private async swapBytes(
    ctx: PassContext,
    id: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.stageOut(ctx, id, path);
    // Both echoes armed, and both before the write: `create` is what the watcher
    // would otherwise read as the user adding a file, and `modify` what
    // `onModify` would read as the user editing one — which for a `'b'` node
    // means queueing a publish of the bytes we have just fetched.
    this.deps.tickets.arm('create', path);
    this.deps.tickets.arm('modify', path);
    await this.deps.vault.createBinary(path, bytes);
    ctx.disk.add(path, 'f');
    this.bindPath(ctx, id, path);

    const staged = `${STAGING_DIR}/${id}${extOf(path)}`;
    this.deps.tickets.arm('delete', staged);
    await this.deps.vault.trashLocal(staged);                 // I1: vault-local .trash
    delete this.deps.state.data.staging[id];
    await this.deps.state.flush();
  }

  /**
   * §4.3 — rule 4, and the reason this whole design was chosen over a revision
   * log in the tree.
   *
   * Two people changed one attachment without seeing each other, or this device
   * has simply never confirmed what is on its own disk. There is no merge for a
   * PNG, so the only answer that loses nothing is to keep BOTH versions as
   * visible files: ours under a name of its own, theirs at the canonical path.
   *
   * THE ORDER IS THE PROMISE, and every step of it is load-bearing:
   *
   *  1. Fetch and verify FIRST, so a fetch that fails leaves the user's file
   *     exactly where it was — not renamed aside with an empty path beside it
   *     because the network blinked.
   *  2. RE-CHECK BETWEEN, exactly as `cleanReplace` does and for the same reason
   *     twice over — see the two clauses below.
   *  3. `vault.rename` the local file. THE RENAME IS THE PRESERVATION: no copy,
   *     no read, and no instant in which the user's bytes exist only in memory
   *     (I1, I16).
   *  4. Write the incoming bytes at the canonical path — one write, never a stub.
   *  5. Tell the user, naming both files, because a file they did not create has
   *     just appeared next to one they did.
   *
   * §4.3's pseudocode asks `isOpenInLeaf` once and stops there; §11's statement of
   * I7 is the normative one and is wider — "re-checked after every await that can
   * take minutes (the fetch)" — so the re-check belongs here too, and MORE than on
   * the replace path: `cleanReplace` swaps a file's bytes, while this moves the
   * file out from under whatever view is showing it.
   *
   * The local file is re-`stat`ed as well, for a reason the replace path does not
   * have. Nothing here would be DESTROYED by a mid-fetch save — the rename
   * preserves whatever bytes are on disk — but it would preserve them under a name
   * built from `local`, the hash they had before the save, and §4.3 makes that
   * name load-bearing: it is the deterministic handle a re-observed divergence
   * lands on. Worse, the fresh bytes may not be rule 4 at all — a save that landed
   * on `ref.sha256` is rule 1 and a save whose base still matches is rule 2, a
   * republish — so forking on the stale verdict moves the user's newest work off
   * the path they saved it to. Deferring one pass re-derives all three hashes.
   *
   * `forkPathFor` stays BEFORE the fetch, deliberately, matching §4.3 line for
   * line: it is what refuses a file with no shareable name before this device pays
   * to download anything for it. The half of it that perishes — `uniquify` reading
   * the disk — fails safe if it does: `vault.rename` refuses an occupied
   * destination, so a fork path taken during the fetch throws into `guarded` with
   * both copies still intact and the next pass recomputing the name.
   *
   * NO TREE WRITE happens here. Step 6's `publishUntracked` seam mints and owns
   * the fork's node, which is what keeps this class a pure driver over a snapshot
   * of `entries()`. Because the store is content-addressed, publishing the fork is
   * a `HEAD` hit plus a tree write — zero bytes uploaded, since the bytes were
   * already put there by whoever published this version.
   */
  private async forkAndTake(
    ctx: PassContext,
    id: string,
    path: string,
    local: string,
    ref: BlobRef,
    seen: { bytes: number; mtime: number },
  ): Promise<void> {
    // I7: renaming a file out from under an open view is precisely what this
    // invariant exists to prevent. One pass of delay costs nothing.
    if (this.deps.vault.isOpenInLeaf(path)) return;
    // §7.2/§7.4, before the request: a device that will not fetch the incoming
    // object must not fork either — half of the operation is not an outcome.
    if (!this.mayFetch(ctx, id, ref)) return;

    const forkPath = await this.forkPathFor(path, local);
    const bytes = await this.fetchBlob(ref);
    if (bytes === null) {
      // Nothing has moved yet — the rename is still three lines away — so a store
      // that no longer holds the incoming version leaves the user's file exactly
      // where it is, under its own name, and says so.
      if (this.reportUnavailable(ctx, id)) return;
      throw new RetryLater(`blob ${ref.sha256} did not fetch`);
    }
    if (await hashOfBytes(bytes) !== ref.sha256) {
      throw new Error(`fork: ${path} did not match its digest`);
    }
    if (!assertInsideShare(this.shareRoot, forkPath)) {
      throw new Error(`fork: destination is outside the share: ${forkPath}`);
    }

    // Everything below re-reads the world this verdict was based on (I7, §4.3).
    if (this.deps.vault.isOpenInLeaf(path)) return;
    const now = await this.deps.vault.stat(path);
    if (now === null || now.mtime !== seen.mtime || now.bytes !== seen.bytes) return;

    this.deps.tickets.arm('rename', path, forkPath);
    await this.deps.vault.rename(path, forkPath);             // I16, and I1: nothing is destroyed
    ctx.disk.move(path, forkPath);
    this.unbindPath(ctx, id);

    this.deps.tickets.arm('create', path);
    this.deps.tickets.arm('modify', path);
    await this.deps.vault.createBinary(path, bytes);
    ctx.disk.add(path, 'f');
    this.bindPath(ctx, id, path);
    // I17: the base names what was written, once the write has returned.
    const st = await this.deps.vault.stat(path);
    this.recordBlobHash(id, ref.sha256, ref.bytes, st?.mtime);

    this.notice(
      `"${baseOf(path)}" was replaced by a collaborator's version. `
      + `Your version is now "${baseOf(forkPath)}".`,
    );
  }

  /**
   * Where our version goes: the same folder, a deterministic name, and never over
   * something that is already there.
   *
   * The decorated name is validated with the kind the path DERIVES, because the
   * fork is about to be offered to `publishUntracked` as an ordinary untracked
   * file — a name this client would refuse to publish is a file that would sit
   * there for ever, shared with nobody. When the display name pushes it past the
   * rel-path cap the fallback drops the name; when even that will not validate,
   * nothing moves at all and the failure is recorded (both copies are still
   * intact, which is the only thing that must never be negotiable).
   */
  private async forkPathFor(path: string, local: string): Promise<string> {
    const dir = dirOf(path);
    const name = baseOf(path);
    const who = this.deps.displayName;
    const decorated = who === undefined || who.trim() === ''
      ? fallbackForkName(name, local)
      : forkName(name, local, who);
    const candidate = this.isPublishable(`${dir}/${decorated}`)
      ? `${dir}/${decorated}`
      : `${dir}/${fallbackForkName(name, local)}`;
    if (!this.isPublishable(candidate)) {
      throw new Error(`fork: no shareable name for ${path}`);
    }
    // `uniquify` only ever moves off a name something else already occupies, so
    // the deterministic name is what a re-observed divergence lands on.
    return await this.uniquify(candidate);
  }

  // ---------------------------------------------------------- step 4

  /**
   * Step 4 is P1b-2b's. It is guarded rather than awaited bare so a throwing
   * deletion pass cannot skip the folder sweep, lose the diagnostics, or turn
   * `reconcile()` into something callers have to wrap in try/catch (I15).
   */
  private async runDeletions(ctx: PassContext): Promise<void> {
    const apply = this.deps.applyDeletions;
    if (apply === undefined) return;
    await this.guarded(ctx.failures, 'applyDeletions', () => apply(ctx));
  }

  // ---------------------------------------------------------- step 5

  /**
   * Remove directories the tree has finished with, deepest first, and ONLY when
   * they are genuinely empty.
   *
   * Three things qualify, and the last two are both the folder RENAME a peer
   * never used to clean up — its node is alive under a new name, so it was never
   * a dead folder, yet the directory it used to be is an empty shell nothing
   * will claim again:
   *
   *  - a DEAD folder node's path: the folder the user deleted;
   *  - a directory this pass moved the last file out of (`vacatedDirs`);
   *  - any directory under the share that no live node claims and the tree does
   *    not imply, except one that predates this session (`preexistingDirs`).
   *
   * The third clause is deliberately about the DISK rather than about what the
   * tree used to want. A leftover does not stay put: the user renaming the
   * folder above it carries it along, path and all, and any bookkeeping keyed on
   * where it used to be loses it at that moment. Re-deriving the candidates from
   * what is actually there also means a removal that failed — an EPERM, a `.git`
   * that vetoed it — is retried on the next pass for free (I15).
   *
   * Deepest first matters for all three, and for the same reason: sweeping
   * `X/inner` is what makes `X` empty in time for its own turn.
   *
   * Emptiness is decided by `vault.listDir`, never by the DiskIndex: the index is
   * built from `vault.list()`, which cannot see `.git/`, `.obsidian/` or any
   * other dot path, so it would report a folder full of hidden files as empty and
   * this loop would trash it. `listDir` rejects for a missing or unreadable
   * folder, and `guarded` turns that into a no-op rather than permission to
   * remove (I2).
   */
  private async sweepEmptyFolders(ctx: PassContext): Promise<void> {
    const exempt = this.preexistingDirs ?? new Set<string>();
    const rootFold = fold(this.shareRoot);
    const unclaimed = ctx.disk.dirsUnderShare()
      .filter((path) => fold(path) !== rootFold && !exempt.has(fold(path)));

    const candidates = [...new Set([...ctx.deadFolderPaths, ...ctx.vacatedDirs, ...unclaimed])]
      // A live node claims it, or the tree implies it as some node's ancestor —
      // including a file that failed to materialize this pass and will be
      // retried into it on the next one.
      .filter((path) => !ctx.wantAtFold.has(fold(path)) && fold(path) !== rootFold)
      .sort(byDepthDesc);

    for (const path of candidates) {
      await this.guarded(ctx.failures, `emptyfolder:${path}`, async () => {
        if (!ctx.disk.hasFold(path)) return;                      // already gone: idempotent
        const literal = ctx.disk.literal(path)!;
        if (ctx.disk.kindOf(literal) !== 'd') return;             // a file lives there now
        const children = await this.deps.vault.listDir(literal);
        if (children.length !== 0) return;
        this.deps.tickets.arm('delete', literal);
        await this.deps.vault.trashLocal(literal);                // vault-local .trash (I1)
        ctx.disk.remove(literal);
        ctx.removedThisPass.add(fold(literal));
      });
    }
  }

  // ---------------------------------------------------------- steps 6-7

  /**
   * Offer local markdown that no node owns to the publisher (P1b-2c / P1c).
   *
   * The dead-node exclusions come FIRST, before the "already bound" check, and
   * that ordering is load-bearing. A dead node whose file is still on disk is
   * still bound in device state until the deletion slice unbinds it, so testing
   * "bound" first would hide it from both the publisher and the diagnostics, and
   * the user would never learn the file is there.
   */
  private async publish(ctx: PassContext): Promise<void> {
    const declined = new Set(this.deps.state.data.declinedPaths);
    const candidates: string[] = [];

    for (const path of ctx.disk.filesUnderShare()) {
      const key = fold(path);
      if (ctx.wantAtFold.has(key)) continue;                      // a live node owns it
      // §3.2: a path publication has already refused as too large stays refused
      // until the file itself shrinks. Separate from `declinedPaths` on purpose —
      // this one self-heals, and a size refusal must never poison a path the way a
      // user's keep decision does (I13).
      const size = await this.oversizedVerdict(ctx, path);
      if (size === 'refused') continue;
      // I13 + CF-1: `deadFold` holds a dead node's PLAIN path, so a file that
      // materialized at a collision suffix is only recognisable through the
      // device state's record of where that node actually lived. Without the
      // second test, this pass republishes the file the deletion just removed.
      //
      // `healed` is the ONE exemption, and it is narrow by construction: the only
      // tombstone that can sit at a path carrying an `oversized` record is the one
      // `retract` wrote for a node that was never published and never materialized
      // anywhere, so no peer can act on it and nothing here can be re-deleting
      // what a peer removed. Without the exemption the retract would be permanent
      // — the file could never be shared again however small it became, which is
      // exactly the path-poisoning I13 keeps `oversized` separate to avoid.
      if (size !== 'healed' && (ctx.deadFold.has(key) || ctx.deadMaterializedFold.has(key))) {
        ctx.diagnostics.deletedButPresent.push(path);
        continue;
      }
      if (ctx.boundAtFold.has(key)) continue;                     // bound to some live node
      if (declined.has(key)) continue;
      if (ctx.removedThisPass.has(key)) continue;
      // §7's path filter, with the kind this path DERIVES (§3.1). A refused
      // extension can never become a node of either kind, so asking the
      // filesystem about it is pure cost and handing it over only routes it into
      // `onCreate`, which refuses it again.
      if (!this.isPublishable(path)) continue;
      let present = false;
      await this.guarded(ctx.failures, `exists:${path}`, async () => {
        present = await this.deps.vault.exists(path);             // the index can be stale
      });
      if (!present) continue;
      candidates.push(path);
    }

    const hand = this.deps.publishUntracked;
    if (hand === undefined) return;
    await this.guarded(ctx.failures, 'publishUntracked', () => hand(candidates));
  }

  /**
   * Could this vault path become a node at all? The tree kind is derived from the
   * path (`nodeKindOf`), never assumed, so an attachment is offered exactly as a
   * note is and an executable is offered as neither.
   *
   * The share-relative path is sliced by SEGMENT COUNT off the real path (SD-5):
   * the share root's casing on disk need not match the configured one.
   */
  private isPublishable(path: string): boolean {
    const segs = path.split('/');
    if (segs.length <= depthOf(this.shareRoot)) return false;      // the root itself (I14)
    const rel = segs.slice(depthOf(this.shareRoot)).join('/');
    const { d, n } = splitRel(rel);
    return validateRel(d, n, nodeKindOf(rel, 'f'));
  }

  /**
   * Is this path still the oversized file publication refused (§3.2)?
   *
   *   'none'    — no record: an ordinary path, decided by the other filters.
   *   'refused' — the record stands; the path is not offered.
   *   'healed'  — the file has shrunk, the record is dropped, and the path is
   *               offered again even though `retract`'s tombstone still names it.
   *
   * One `stat` per recorded path per pass — a handful of paths, not a sweep. The
   * record is dropped as soon as the file is smaller than the size that was
   * refused, so trimming an attachment re-shares it with no user action and no
   * command. A `stat` that could not answer keeps the record (I2): "I could not
   * look" is not evidence that the file shrank.
   */
  private async oversizedVerdict(
    ctx: PassContext,
    path: string,
  ): Promise<'none' | 'refused' | 'healed'> {
    const key = fold(path);
    const record = this.deps.state.data.oversized[key];
    if (record === undefined) return 'none';

    let st: { bytes: number } | null = null;
    let looked = false;
    await this.guarded(ctx.failures, `oversized:${path}`, async () => {
      st = await this.deps.vault.stat(path);
      looked = true;
    });
    if (!looked || st === null) return 'refused';
    if ((st as { bytes: number }).bytes >= record.bytes) return 'refused';

    delete this.deps.state.data.oversized[key];
    return 'healed';
  }

  // ---------------------------------------------------------- bookkeeping

  private bindPath(ctx: PassContext, id: string, path: string): void {
    const previous = ctx.have.get(id);
    if (previous !== undefined && ctx.boundAtFold.get(fold(previous)) === id) {
      ctx.boundAtFold.delete(fold(previous));
    }
    ctx.have.set(id, path);
    ctx.boundAtFold.set(fold(path), id);
    this.deps.state.data.materialized[id] = path;
  }

  private unbindPath(ctx: PassContext, id: string): void {
    const previous = ctx.have.get(id);
    if (previous !== undefined && ctx.boundAtFold.get(fold(previous)) === id) {
      ctx.boundAtFold.delete(fold(previous));
    }
    ctx.have.delete(id);
    delete this.deps.state.data.materialized[id];
  }

  /** I17: the watermark advances only once the write it describes has returned. */
  private async recordHash(id: string, text: string): Promise<void> {
    const normalized = normLF(text);
    this.deps.state.data.contentHash[id] = {
      sha256: await hashOf(normalized),
      len: normalized.length,
    };
  }

  /**
   * Take in the bindings the pass's COLLABORATORS wrote while it was running.
   *
   * Step 6 hands untracked paths to `publishUntracked`, which is
   * `VaultWatcher.onCreate`: it mints a node for the file and records the binding
   * by writing `state.materialized[id]` directly. That write happens behind the
   * pass's back — `ctx.have` never hears about it — so without this the rebuild
   * below, which keys on `ctx.have` alone, wipes every binding the pass just
   * created. The next pass then finds files under the share, a non-empty desired
   * set and nothing bound, which is exactly the shape `mountMismatch` reads as a
   * wrong mount: a first-joining client that published its own notes wedged
   * itself in read-only for the rest of the session.
   *
   * This is NOT the desired state creeping back in. Every candidate is confirmed
   * against `ctx.disk` first, so a binding whose file is not actually there is
   * still dropped, and a fold already spoken for by another node is left alone.
   * The rebuild stays a record of what was observed.
   */
  private absorbCollaboratorBindings(ctx: PassContext | null): void {
    if (ctx === null) return;
    for (const [id, path] of Object.entries(this.deps.state.data.materialized)) {
      if (ctx.have.has(id)) continue;
      const literal = ctx.disk.literal(path);
      if (literal === undefined) continue;                  // I2/I15: not observed, not recorded
      const claimed = ctx.boundAtFold.get(fold(literal));
      if (claimed !== undefined && claimed !== id) continue; // another node already owns it
      ctx.have.set(id, literal);
      ctx.boundAtFold.set(fold(literal), id);
    }
  }

  /**
   * I15: rebuild from what was OBSERVED, not from what was desired. A node whose
   * write failed must not be recorded as materialized, or the next pass will skip
   * the retry and the file will never appear.
   */
  private rebuildDeviceStateFromObserved(ctx: PassContext | null): void {
    const data = this.deps.state.data;
    if (ctx !== null) {
      const materialized: Record<string, string> = {};
      for (const id of [...ctx.have.keys()].sort(cmp)) {
        // A binding that was dropped from device state WHILE the pass ran is
        // honoured rather than rebuilt from the pass's older view. `bindPath` and
        // `unbindPath` write both structures together, so the only way to be in
        // `have` and absent here is a collaborator that unbound deliberately —
        // today that is `retract` (§3.2), which drops the binding precisely so
        // the next pass's deletion step cannot find a dead node holding a real
        // file and "rescue" the user's oversized attachment out of the share.
        if (data.materialized[id] === undefined) continue;
        const literal = ctx.disk.literal(ctx.have.get(id)!);
        if (literal !== undefined) materialized[id] = literal;
      }
      data.materialized = materialized;
    }
    // contentHash is deliberately NOT pruned: §5.3's `proven` check needs the
    // last confirmed text of a node whose file has since gone.
    data.contentHash = sortRecord(data.contentHash);
    data.owned = sortRecord(data.owned);
    data.publish = sortRecord(data.publish);
    data.staging = sortRecord(data.staging);
    // The attachment maps are sorted for the same reason as the rest: two devices
    // running the same events must serialize byte-identical state, and a map whose
    // key order follows insertion makes that untestable.
    data.fetchDeferred = sortRecord(data.fetchDeferred);
    data.fetchApproved = sortRecord(data.fetchApproved);
    data.oversized = sortRecord(data.oversized);
  }

  /**
   * Write device state at the end of the pass — but only if it MOVED.
   *
   * A converged share reconciles on every remote change, and every pass rebuilds
   * the same maps out of the same evidence. Flushing unconditionally serializes
   * the whole state object and writes it again each time, which on a share with a
   * thousand attachments is a multi-megabyte write every couple of seconds, on a
   * phone, for a file whose contents did not change.
   */
  private async persist(): Promise<void> {
    try {
      await this.deps.state.flushIfChanged();
    } catch (err) {
      this.deps.state.lastPersistError = err;
    }
  }

  // ---------------------------------------------------------- small helpers

  /**
   * `guarded(failures, key, fn)` — spec §4.3. One EPERM, one ENAMETOOLONG, one
   * Windows MAX_PATH overflow, one antivirus lock: contained to one item.
   */
  private async guarded(
    failures: ReconcileFailure[],
    key: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      failures.push({ key, err });
    }
  }

  /** Adapter-level existence, for paths the share-scoped DiskIndex cannot answer for. */
  private async exists(path: string): Promise<boolean> {
    try {
      return await this.deps.vault.exists(path);
    } catch {
      return false;
    }
  }

  /** `ShadowLink Recovered/` and `ShadowLink Staging/` live at the vault root, outside the share. */
  private async ensureReservedDir(dir: string): Promise<void> {
    if (await this.exists(dir)) return;
    this.deps.tickets.arm('create', dir);
    await this.deps.vault.createFolder(dir);
  }

  private async uniquify(candidate: string): Promise<string> {
    if (!(await this.exists(candidate))) return candidate;
    const ext = extOf(candidate);
    const stem = ext === '' ? candidate : candidate.slice(0, candidate.length - ext.length);
    for (let n = 2; n < 1000; n++) {
      const next = `${stem} (${n})${ext}`;
      if (!(await this.exists(next))) return next;
    }
    throw new Error(`could not find a free name for ${candidate}`);
  }
}

/** `Notes/a.md` -> `a (local copy 2026-06-26T10-00-00).md`. */
function stashName(path: string, at: number): string {
  const base = baseOf(path);
  const ext = extOf(base);
  const stem = ext === '' ? base : base.slice(0, base.length - ext.length);
  return `${stem} (local copy ${stampOf(at)})${ext}`;
}

function refused(reason: string): ReconcileResult {
  return {
    ran: false,
    refusedReason: reason,
    failures: [],
    diagnostics: {
      pending: [], invalid: [], deletedButPresent: [], tooLarge: [], deferred: [],
      unavailable: [], rehashDeferred: [], fetchTooLarge: [],
    },
  };
}
