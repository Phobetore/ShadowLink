// src/sync/Bootstrap.ts
// First join and reconnect (spec §4.5, §4.6).
//
// This is the moment the plugin has the LEAST evidence and the MOST power: no
// device state, a tree it has never seen, and a vault already full of the user's
// real notes. Every ordering decision below exists because getting it wrong here
// is unrecoverable.
//
//  I3 — NEVER ACT ON AN UNSYNCED TREE. A timeout is not a sync. A client that
//       bootstraps on one reads an empty tree as "nothing has ever been shared"
//       and proceeds to publish the entire vault as new nodes — which every peer
//       then sees as duplicates of everything they already have.
//  I2 — CLASSIFICATION TOUCHES NOTHING. Step 7 reads the tree and the disk and
//       writes down what it found. The user has not agreed to anything yet, and
//       a plan is not a mutation.
//  §4.5 step 5 — THE FOUNDER CLAIM IS A LATENCY OPTIMIZATION, never a
//       correctness mechanism. Losing it is harmless precisely because adoption
//       is idempotent: matching by `fold(relPath)` makes a double publish MERGE
//       instead of duplicating. Nothing here may read the claim to decide who
//       "wins" — there is no winner, and there does not need to be one.
//
// Tombstones are deliberately NOT processed as part of the first pass. "You were
// offline while the team reorganized" is exactly the case where a silent bulk
// delete is unrecoverable, so `tombstonesEnabled` stays false until step 9's
// reconcile has completed, and deletion then routes through §5.4's confirmation
// like any other batch.
//
// No `obsidian` import, no node builtins.

import {
  AUTOFETCH_MAX_BYTES,
  AUTOFETCH_SESSION_BUDGET,
  BLOB_MAX_BYTES,
  FOUNDER_GRACE_MS,
  FOUNDER_QUIET_MS,
  FOUNDER_SETTLE_MS,
  FOUNDER_WAIT_CAP_MS,
  TREE_SYNC_TIMEOUT_MS,
} from '../tree/constants.ts';
import { fold, isLive, nodeKindOf, relPath, splitRel, validateRel } from '../tree/paths.ts';
import { deriveTree } from '../tree/TreeIndex.ts';
import type { TreeDoc } from '../tree/TreeDoc.ts';
import type { DeviceState } from './DeviceState.ts';
import { DiskIndex } from './DiskIndex.ts';
import { fetchVerdict, type FetchLimits } from './FetchPolicy.ts';
import type { ReconcileCause } from './Reconciler.ts';
import type { VaultPort } from './VaultPort.ts';
import type { Phase } from './VaultWatcher.ts';

// ============================================================ public surface

/**
 * One line of the first-sync modal: how many, and how big.
 *
 * `bytes` is 0 when a size is not knowable at classification time, not when it is
 * genuinely zero. A note's bytes live in a content doc that has not synced, and
 * inventing a number for them would describe a pass that does not happen. An
 * attachment's size rides in the tree and a local file's is on disk, so those two
 * are real.
 */
export interface BucketTotals {
  count: number;
  bytes: number;
}

/** Spec §4.5 step 7 and §7.5. Nothing in here has been acted on. */
export interface BootstrapBuckets {
  /** A live seeded node whose desired path already holds a local file. nodeId -> literal path. */
  adopt: Map<string, string>;
  /** A live seeded node with no local file. nodeId -> the vault path it wants. */
  download: Map<string, string>;
  /**
   * Local content under the share that no live node claims, that is not at a dead
   * node's last path, and that the user has not already declined. Literal vault
   * paths, sorted, NOTES AND ATTACHMENTS TOGETHER: this is the list the
   * confirmation acts on, so nothing may fall between it and the counts below.
   */
  upload: string[];
  /** Live valid file nodes whose author has not published yet — shown, never acted on (I6). */
  pending: string[];

  // §7.5. A user joining a mature folder needs to be told what 3 GB means before
  // it starts, and a user upgrading an existing vault needs to be told they are
  // about to upload 3.1 GB of scans. Four numbers `upload` and `download` cannot
  // express, none of which costs more than a `stat` per local candidate.

  /** Notes to download. `bytes` is 0 — see `BucketTotals`. */
  downloadNotes: BucketTotals;
  /** Attachments the first pass will actually fetch, sized from the tree. */
  downloadNow: BucketTotals;
  /**
   * Attachments the first pass will NOT fetch, sized from the tree.
   *
   * Three refusals land here and they are deliberately one line to the user,
   * because from their side they are one fact — "this will not arrive yet":
   * over this device's memory cap (§7.4), over the auto-fetch ceiling, or past
   * this session's fetch budget (§7.2). The node stays live, valid, published and
   * simply unmaterialized HERE in every one of those cases.
   */
  downloadDeferred: BucketTotals;
  /** Local markdown that would be shared, sized from disk. */
  uploadNotes: BucketTotals;
  /** Local attachments that would be shared, sized from disk. */
  uploadAttachments: BucketTotals;
}

/** What the confirmation modal is handed. The modal itself is P1c Task 4's. */
export interface BootstrapConfirmation extends BootstrapBuckets {
  shareRoot: string;
  /** True when this device has no usable state for this workspace: the mandatory first sync. */
  firstSync: boolean;
}

export interface BootstrapDecision {
  /** False aborts: nothing is touched and the client stays read-only. */
  proceed: boolean;
  /**
   * Spec §4.5 step 8's checkbox, default CHECKED. Unchecking sends every
   * `upload` path to `declinedPaths`, where both the watcher and the
   * reconciler's publish step will keep skipping it.
   */
  shareLocalFiles: boolean;
}

export type BootstrapOutcome = 'ready' | 'readonly' | 'cancelled';

export interface BootstrapResult {
  outcome: BootstrapOutcome;
  phase: Phase;
  /** Why the client is read-only, for the persistent status indicator. */
  reason?: string;
  /** Empty when the run stopped before step 7. */
  buckets: BootstrapBuckets;
  /** True when device state was absent, unreadable or written by another device. */
  coldStart: boolean;
}

export interface BootstrapDeps {
  state: DeviceState;
  tree: TreeDoc;
  vault: VaultPort;
  shareRoot: string;
  deviceId: string;

  /** The local tree snapshot (spec §2.6), or null when there is none. */
  loadSnapshot: () => Promise<Uint8Array | null>;

  /**
   * Connect the `_tree` provider and resolve TRUE only on a genuine `sync`
   * event. Resolving true on a timeout is invariant I3's failure mode and this
   * module cannot detect it — the contract is the whole guarantee.
   */
  connectTree: (timeoutMs: number) => Promise<boolean>;

  /** Spec §4.5 step 8. Exactly one, and the default action must be safe. */
  confirm: (confirmation: BootstrapConfirmation) => Promise<BootstrapDecision>;

  reconcile: (cause: ReconcileCause) => Promise<unknown>;

  /**
   * Why the reconciler is refusing to mutate the vault, or null. Wire it to
   * `Reconciler.readOnlyReason`.
   *
   * Two modules can each decide to stop, and until they were joined up they
   * could disagree: the reconciler paused itself mid-session (a mount that
   * looked wrong, a share root that had gone) while this class went on
   * reporting `ready`, so the status indicator said everything was fine and
   * every pass was refused. Reading the collaborator's own answer is what makes
   * one phase mean one thing.
   */
  syncPaused?: () => string | null;

  /**
   * Lift a collaborator's self-imposed pause once the tree has genuinely synced
   * again. `Reconciler.clearReadOnly` is the implementation.
   *
   * Safe because it asserts nothing: the reconciler re-runs its own share-root
   * and mount checks on the very next pass, before mutating anything, and
   * pauses again if either still holds.
   */
  resumeSync?: () => void;

  /** Spec §4.5 step 10 — `VaultWatcher.flushPending`. */
  replayPendingEvents: () => Promise<void>;

  notice?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * §7.4's per-device whole-file allocation cap, injected as a plain number so
   * nothing here has to know what platform it is running on.
   *
   * Classification only READS it, to say which attachments this device will not
   * be fetching. The reconciler applies the same number when the pass actually
   * runs, which is what keeps the counts a description of that pass.
   */
  memoryCapBytes?: () => number;
  /**
   * §7.2's two policy ceilings, injected for exactly the same reason as the
   * memory cap: they are platform facts, and classification only READS them.
   *
   * Both are load-bearing for the modal rather than for the vault. Splitting the
   * download counts on the memory cap alone said "412 attachments will be
   * downloaded" about a pass that fetches forty of them, because the cap is not
   * the rule `materialize` applies — the fetch policy is.
   */
  autofetchMaxBytes?: () => number;
  sessionBudgetBytes?: () => number;
  /**
   * How much of this session's fetch budget the reconciler has already spent.
   *
   * `Reconciler.fetchedThisSession` is the implementation. It is zero on a first
   * join, which is when the modal is shown; wiring it anyway is what keeps the two
   * modules from disagreeing on a re-classification later in the session.
   */
  sessionSpentBytes?: () => number;
  treeSyncTimeoutMs?: number;
  founderWaitCapMs?: number;
}

// ============================================================ Bootstrap

export class Bootstrap {
  /** Last contained failure from step 9 or 10, for diagnostics (I15). */
  lastFailure: unknown = null;

  private readonly deps: BootstrapDeps;
  private readonly shareRoot: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly treeSyncTimeoutMs: number;
  private readonly founderWaitCapMs: number;

  private _phase: Phase = 'boot';
  private _readOnlyReason: string | null = null;
  private _tombstonesEnabled = false;
  private _buckets: BootstrapBuckets = emptyBuckets();
  private _coldStart = true;

  /**
   * A read-only state a reconnect cannot heal.
   *
   * Two things land here. A tree written by a newer schema: reconnecting does
   * not make this client any newer. And a first sync the user CANCELLED: they
   * were shown what would happen and said no, so a network blip a minute later
   * must not quietly do it anyway. Both are reversible by reloading the plugin,
   * which is a deliberate action rather than an accident of connectivity.
   */
  private fatal = false;

  /** Set once the confirmation has been answered, so a reconnect does not re-ask. */
  private confirmed = false;

  constructor(deps: BootstrapDeps) {
    this.deps = deps;
    // A trailing slash would break every `startsWith(root + '/')` containment test.
    this.shareRoot = deps.shareRoot.replace(/\/+$/, '');
    this.now = deps.now ?? ((): number => Date.now());
    this.sleep = deps.sleep ?? ((ms): Promise<void> => new Promise((r) => setTimeout(r, ms)));
    this.treeSyncTimeoutMs = deps.treeSyncTimeoutMs ?? TREE_SYNC_TIMEOUT_MS;
    this.founderWaitCapMs = deps.founderWaitCapMs ?? FOUNDER_WAIT_CAP_MS;
  }

  /** `VaultWatcher` reads this: while it is not `ready`, events queue rather than drop (I9). */
  get phase(): Phase {
    return this._phase;
  }

  /** Non-null while the client is read-only. Drives the persistent status indicator. */
  get readOnlyReason(): string | null {
    return this._readOnlyReason;
  }

  /**
   * Spec §4.5: tombstone processing is deferred until step 9's first reconcile
   * has COMPLETED.
   *
   * The reconciler's step 4 is an injected collaborator, so the wiring must gate
   * it on this flag — `applyDeletions: (ctx) => bootstrap.tombstonesEnabled ?
   * deletions.apply(ctx) : Promise.resolve()`. Applying tombstones in the very
   * pass that materializes and adopts would mean a client returning after a week
   * offline deletes files in the same breath as it discovers them, before the
   * user has seen a single thing.
   */
  get tombstonesEnabled(): boolean {
    return this._tombstonesEnabled;
  }

  /** The most recent classification, for a diagnostics panel. */
  get buckets(): BootstrapBuckets {
    return this._buckets;
  }

  // ---------------------------------------------------------- §4.5

  async run(): Promise<BootstrapResult> {
    // 1. Device state. A file naming another device or another workspace is
    //    discarded WHOLE by DeviceState.load — `.obsidian/` is replicated by
    //    Obsidian Sync and by git, so another machine's path map turning up here
    //    is routine, and replaying it is a mass relocation.
    const loaded = await this.deps.state.load();
    this._coldStart = loaded.coldStart;

    // 2. The offline baseline, BEFORE connecting: it is what lets a client
    //    re-merge full tree history into a server whose snapshot was lost.
    await this.loadSnapshot();

    // 3. A tree written by a newer schema. Read-only and STOP — a client that
    //    does not understand the fields must not rewrite them.
    if (this.deps.tree.isFutureSchema()) {
      this.fatal = true;
      return this.enterReadOnly(
        'This workspace was created by a newer version of ShadowLink. '
        + 'Update the plugin; syncing is paused until then.',
      );
    }

    return this.syncAndClassify();
  }

  /**
   * Spec §4.6. Called on every `provider.on('status', 'connected')` transition.
   *
   * Re-attempts step 4 and, if the tree genuinely syncs this time, runs steps
   * 6-10. A ready client is left alone; a client held read-only by a schema it
   * cannot read is never retried, because reconnecting does not make it older.
   *
   * "Ready" means ready in BOTH modules. A client whose reconciler paused itself
   * after bootstrap finished is not left alone — that pause is exactly the one a
   * reconnect is able to lift, and skipping the re-run is what used to strand a
   * client reporting `ready` while every reconcile pass was refused.
   */
  async onReconnect(): Promise<BootstrapResult> {
    if (this.fatal) {
      return this.result('readonly', this._readOnlyReason ?? undefined);
    }
    if (this._phase === 'ready' && this.pausedReason() === null) return this.result('ready');
    return this.syncAndClassify();
  }

  // ---------------------------------------------------------- steps 4-10

  private async syncAndClassify(): Promise<BootstrapResult> {
    // 4. A GENUINE sync (I3). A timeout is read-only with a persistent
    //    indicator, retried on every reconnect — never a bootstrap.
    let synced = false;
    try {
      synced = await this.deps.connectTree(this.treeSyncTimeoutMs);
    } catch {
      synced = false;
    }
    if (!synced) {
      return this.enterReadOnly(
        'ShadowLink could not reach the workspace. Editing locally; sync is paused.',
      );
    }
    this._readOnlyReason = null;
    // The tree is genuinely synced, so a collaborator that paused ITSELF gets to
    // try again. It re-runs its own guards before it mutates anything, so this
    // resumes the client without assuming anything about the vault.
    this.deps.resumeSync?.();

    // 5. Founder claim. Latency only; skipped on a reconnect, which by
    //    definition is not a first join (§4.6 runs steps 6-10).
    if (this._phase === 'boot') await this.founderClaim();

    // 6 + 7. Walk the share and classify, touching nothing.
    const buckets = await this.classify();
    this._buckets = buckets;

    // 8. One confirmation. Mandatory on the first sync of this workspace on this
    //    device; on later starts it is skipped unless there is something new to
    //    share, because a modal nobody needs is a modal everybody dismisses.
    if (!this.confirmed && (this._coldStart || buckets.upload.length > 0)) {
      const decision = await this.deps.confirm({
        ...buckets,
        shareRoot: this.shareRoot,
        firstSync: this._coldStart,
      });
      this.confirmed = true;
      if (!decision.proceed) {
        this.fatal = true;
        return this.enterReadOnly('ShadowLink is not syncing: the first sync was cancelled.');
      }
      if (!decision.shareLocalFiles) this.decline(buckets.upload);
    }

    // 9. Only now may anything be touched.
    this.deps.tree.initMeta();
    this._phase = 'ready';
    await this.guarded(() => this.deps.reconcile('bootstrap'));

    // Deferred until the first reconcile has COMPLETED (§4.5).
    this._tombstonesEnabled = true;

    // 10. Replay what arrived while we were booting. The handlers are
    //     idempotent, so anything the pass above already fixed drops straight
    //     out — which is most of it.
    await this.guarded(() => this.deps.replayPendingEvents());

    // Step 9 may have paused the reconciler on evidence only it can see (the
    // share root really is gone). Report ITS answer rather than a `ready` the
    // pass just contradicted — one phase, one meaning.
    const paused = this.pausedReason();
    if (paused !== null) {
      this._phase = 'readonly';
      this._readOnlyReason = paused;
      return this.result('readonly', paused);
    }

    return this.result('ready');
  }

  /** The collaborator's own read-only reason, or null when it is not wired. */
  private pausedReason(): string | null {
    return this.deps.syncPaused?.() ?? null;
  }

  // ---------------------------------------------------------- step 7

  /**
   * Read the tree and the disk, write down what is there, change NOTHING.
   *
   * Adoption matches on `fold(relPath)`. That single choice is what makes a
   * double founder merge: a client whose 100 local files sit exactly where
   * another client's 100 nodes want to be adopts all 100 and publishes none,
   * rather than minting a rival node at every path and leaving both peers with
   * `note (2).md` beside every note.
   */
  private async classify(): Promise<BootstrapBuckets> {
    const disk = DiskIndex.build(this.deps.vault, this.shareRoot);
    const entries = this.deps.tree.entries();
    const derived = deriveTree(entries);

    const adopt = new Map<string, string>();
    const download = new Map<string, string>();
    // §7.5's three download lines. All three come out of the tree, which is
    // already synced, so counting them costs nothing at all.
    const downloadNotes = { count: 0, bytes: 0 };
    const downloadNow = { count: 0, bytes: 0 };
    const downloadDeferred = { count: 0, bytes: 0 };

    for (const id of [...derived.files.keys()].sort(cmp)) {
      const path = this.vaultPathOf(derived.files.get(id)!);
      // Mirrors the reconciler's step 3 exactly: occupied means adopt, free
      // means materialize. Deciding it differently here would make the counts
      // shown to the user a description of a pass that never happens.
      if (disk.hasFold(path)) adopt.set(id, disk.literal(path)!);
      else download.set(id, path);
    }

    // A note's size is in a content doc that has not synced, so there is no honest
    // number to show for it — see `BucketTotals`.
    const blobIds: string[] = [];
    for (const id of download.keys()) {
      if (derived.blobs.has(id)) blobIds.push(id);
      else downloadNotes.count += 1;
    }
    // §7.2, walked exactly as `Reconciler.materialize` walks it: ASCENDING BYTE
    // ORDER, through the same pure predicate, charging the same session budget as
    // it goes. Anything else makes these two counts a description of a pass that
    // does not happen — which is the whole failure the fetch policy's user-facing
    // half exists to avoid.
    const limits: FetchLimits = {
      memoryCapBytes: this.deps.memoryCapBytes?.() ?? BLOB_MAX_BYTES,
      autofetchMaxBytes: this.deps.autofetchMaxBytes?.() ?? AUTOFETCH_MAX_BYTES,
      sessionBudgetBytes: this.deps.sessionBudgetBytes?.() ?? AUTOFETCH_SESSION_BUDGET,
    };
    let spent = this.deps.sessionSpentBytes?.() ?? 0;
    const approved = this.deps.state.data.fetchApproved;
    blobIds.sort((a, b) => derived.blobs.get(a)!.bytes - derived.blobs.get(b)!.bytes || cmp(a, b));
    for (const id of blobIds) {
      const ref = derived.blobs.get(id)!;
      const willFetch = fetchVerdict(ref.bytes, limits, approved[id] === true, spent) === 'yes';
      const bucket = willFetch ? downloadNow : downloadDeferred;
      bucket.count += 1;
      bucket.bytes += ref.bytes;
      if (willFetch) spent += ref.bytes;
    }

    // Occupancy, rebuilt from REAL paths rather than by prefixing `deriveTree`'s
    // already-folded keys: `fold` is `toLowerCase` on an NFC string and case
    // mapping does not reliably distribute over concatenation.
    const claimedFold = new Set<string>();
    const deadFold = new Set<string>();
    for (const [, f] of entries) {
      if (!validateRel(f.d, f.n, f.k)) continue;         // invalid: never acted on at all (I10)
      const path = this.vaultPathOf(relPath(f));
      // A LIVE node's stored path counts as claimed even when the node is
      // unseeded or a directory: the question here is "does the tree already
      // have a node here?", which is about identity, not materialization.
      if (isLive(f)) claimedFold.add(fold(path));
      else deadFold.add(fold(path));
    }
    // ...plus the collision-suffixed paths files actually land on, and every
    // folder the tree implies.
    for (const rel of derived.files.values()) claimedFold.add(fold(this.vaultPathOf(rel)));
    for (const rel of derived.folders) claimedFold.add(fold(this.vaultPathOf(rel)));

    const declined = new Set(this.deps.state.data.declinedPaths);
    const rootDepth = this.shareRoot.split('/').length;
    const upload: string[] = [];
    const uploadNotePaths: string[] = [];
    const uploadAttachmentPaths: string[] = [];
    for (const path of disk.filesUnderShare()) {
      const key = fold(path);
      if (claimedFold.has(key)) continue;
      if (deadFold.has(key)) continue;                   // I13: never republish a delete
      if (declined.has(key)) continue;
      // Sliced by SEGMENT COUNT off the real path, never by a byte offset into a
      // folded one (SD-5). The share root's casing on disk need not match the
      // configured one.
      const rel = path.split('/').slice(rootDepth).join('/');
      const { d, n } = splitRel(rel);
      // The TREE kind, derived from the path (§3.1). Hardcoding `'f'` here dropped
      // every attachment in the vault on the floor: the counts the user is shown
      // before their first sync would then describe a pass that does something
      // else, and 3 GB of scans would be uploaded — or not — without a word.
      const kind = nodeKindOf(rel, 'f');
      if (!validateRel(d, n, kind)) continue;            // §7: not eligible
      upload.push(path);
      (kind === 'b' ? uploadAttachmentPaths : uploadNotePaths).push(path);
    }
    upload.sort(cmp);
    uploadNotePaths.sort(cmp);
    uploadAttachmentPaths.sort(cmp);

    return {
      adopt,
      download,
      upload,
      pending: [...derived.pending],
      downloadNotes,
      downloadNow,
      downloadDeferred,
      uploadNotes: await this.sizeOf(uploadNotePaths),
      uploadAttachments: await this.sizeOf(uploadAttachmentPaths),
    };
  }

  /**
   * Total the sizes of local files, with one `stat` each.
   *
   * A read, never a mutation, so I2 stands: classification still touches nothing.
   * It is the only way to answer §7.5's question at all — `list()` reports paths
   * and kinds and no sizes — and it is paid once, on a cold start, over untracked
   * files only.
   *
   * A `stat` that fails contributes nothing rather than aborting the run: this
   * number goes into a sentence, and a sentence is not a decision.
   */
  private async sizeOf(paths: string[]): Promise<BucketTotals> {
    let bytes = 0;
    for (const path of paths) {
      try {
        const st = await this.deps.vault.stat(path);
        if (st !== null) bytes += st.bytes;
      } catch {
        // Counted, unsized. Never a reason to refuse the sync.
      }
    }
    return { count: paths.length, bytes };
  }

  // ---------------------------------------------------------- step 5

  /**
   * Spec §4.5 step 5, verbatim in shape and deliberately weak in effect.
   *
   * Waiting is BOUNDED and losing the claim is survivable, so the worst outcome
   * of every branch here is a slower first join, never a wrong one.
   */
  private async founderClaim(): Promise<void> {
    if (this.deps.tree.size() !== 0) return;

    await this.sleep(FOUNDER_GRACE_MS);
    this.deps.tree.claimFounder(this.deps.deviceId, this.now());
    await this.sleep(FOUNDER_SETTLE_MS);

    if (this.deps.tree.getMeta()?.claim?.by === this.deps.deviceId) return;
    await this.waitForNodes(this.founderWaitCapMs);
  }

  /**
   * Wait for the founder's first publish — and then for it to STOP.
   *
   * "The tree holds a node" is not the condition this needs. A founder mints one
   * node per file and each is its own Yjs transaction, so a tree that has just
   * gained its first node is a tree that is still being filled in. Classifying
   * at that moment is not a merge: the paths whose nodes are still in flight
   * look unclaimed, step 6 hands them to the publisher, and this client mints a
   * rival node at every one of them. What makes adoption idempotent is matching
   * on `fold(relPath)`, and that can only match nodes that have ARRIVED — which
   * is exactly why the claim's loser has to wait for the whole burst rather than
   * for the head of it.
   *
   * So: resolve once the tree holds nodes AND has been quiet for
   * `FOUNDER_QUIET_MS`, and never later than `ms`. Both bounds are load-bearing.
   * The quiet window is what makes this a wait for the founder rather than a
   * wait on a timer; the cap is what stops a chatty workspace — or a founder
   * that crashed halfway — from holding this client in `boot` for ever. Running
   * off the cap is survivable exactly as it was before: the worst case is a
   * duplicate node, which is a collision suffix, never lost content.
   */
  private waitForNodes(ms: number): Promise<void> {
    const quietMs = Math.min(FOUNDER_QUIET_MS, ms);
    return new Promise<void>((resolve) => {
      let done = false;
      let quiet: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (quiet !== null) clearTimeout(quiet);
        clearTimeout(cap);
        unobserve();
        resolve();
      };
      // Every arriving change restarts the window, so the wait ends on the
      // founder falling silent rather than on a fixed delay after its first node.
      const restartQuiet = (): void => {
        if (done) return;
        if (quiet !== null) clearTimeout(quiet);
        quiet = setTimeout(finish, quietMs);
      };
      const unobserve = this.deps.tree.observe(() => {
        if (this.deps.tree.size() > 0) restartQuiet();
      });
      const cap = setTimeout(finish, ms);
      if (this.deps.tree.size() > 0) restartQuiet();
    });
  }

  // ---------------------------------------------------------- helpers

  private async loadSnapshot(): Promise<void> {
    let snapshot: Uint8Array | null = null;
    try {
      snapshot = await this.deps.loadSnapshot();
    } catch {
      snapshot = null;
    }
    if (snapshot === null || snapshot.length === 0) return;
    try {
      this.deps.tree.applyUpdate(snapshot);
    } catch {
      // A truncated snapshot is a lost offline baseline, not a reason to refuse
      // to start: the server's copy is authoritative and step 4 is about to
      // fetch it. Surfaced rather than swallowed, because it means the local
      // file is corrupt and will keep being.
      this.notice('The local tree snapshot could not be read; rebuilding it from the server.');
    }
  }

  /**
   * Spec §4.5 step 8's opt-out. `declinedPaths` holds `fold(vaultPath)`, which
   * is the key both `VaultWatcher.onCreate` and the reconciler's publish step
   * already test — so a declined file stays local even if its nodeId is lost.
   */
  private decline(paths: string[]): void {
    const declined = new Set(this.deps.state.data.declinedPaths);
    for (const path of paths) declined.add(fold(path));
    this.deps.state.data.declinedPaths = [...declined].sort(cmp);
    this.deps.state.schedulePersist();
  }

  private enterReadOnly(reason: string): BootstrapResult {
    this._phase = 'readonly';
    this._readOnlyReason = reason;
    this.notice(reason);
    return this.result(reason.includes('cancelled') ? 'cancelled' : 'readonly', reason);
  }

  private result(outcome: BootstrapOutcome, reason?: string): BootstrapResult {
    return {
      outcome,
      phase: this._phase,
      ...(reason === undefined ? {} : { reason }),
      buckets: this._buckets,
      coldStart: this._coldStart,
    };
  }

  /** I15: a failing step 9 or 10 must not wedge the plugin in `boot` for ever. */
  private async guarded(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.lastFailure = err;
    }
  }

  private vaultPathOf(rel: string): string {
    return `${this.shareRoot}/${rel}`;
  }

  private notice(msg: string): void {
    this.deps.notice?.(msg);
  }
}

// ============================================================ helpers

function emptyBuckets(): BootstrapBuckets {
  return {
    adopt: new Map(), download: new Map(), upload: [], pending: [],
    downloadNotes: noTotals(), downloadNow: noTotals(), downloadDeferred: noTotals(),
    uploadNotes: noTotals(), uploadAttachments: noTotals(),
  };
}

function noTotals(): BucketTotals {
  return { count: 0, bytes: 0 };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
