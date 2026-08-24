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

import { RECOVERED_DIR, STAGING_DIR } from '../tree/constants.ts';
import { DIR_SENTINEL, deriveTree } from '../tree/TreeIndex.ts';
import type { NodeFields } from '../tree/types.ts';
import {
  assertInsideShare, extOf, fold, hashOf, isLive, relPath, validateRel,
} from '../tree/paths.ts';
import type { DeviceState } from './DeviceState.ts';
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
  disk: DiskIndex;
  failures: ReconcileFailure[];
  /** fold(path) of everything this pass removed. Feeds step 6's exclusion list. */
  removedThisPass: Set<string>;
  vault: VaultPort;
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
  diagnostics: ReconcileDiagnostics;
  bind: (id: string, path: string) => void;
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
    const diagnostics: ReconcileDiagnostics = { pending: [], invalid: [], deletedButPresent: [] };
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
      docs: this.deps.docs,
      state: this.deps.state,
      tickets: this.deps.tickets,
      shareRoot: this.shareRoot,
      notice: this.notice,
      now: this.now,
      desired,
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
    for (const id of [...ctx.desired.keys()].sort(cmp)) {
      const path = ctx.desired.get(id)!.path;
      if (ctx.have.has(id)) continue;
      if (ctx.disk.hasFold(path)) {
        await this.adopt(ctx, id, ctx.disk.literal(path)!);       // I11: the LITERAL casing
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
      // I13 + CF-1: `deadFold` holds a dead node's PLAIN path, so a file that
      // materialized at a collision suffix is only recognisable through the
      // device state's record of where that node actually lived. Without the
      // second test, this pass republishes the file the deletion just removed.
      if (ctx.deadFold.has(key) || ctx.deadMaterializedFold.has(key)) {
        ctx.diagnostics.deletedButPresent.push(path);
        continue;
      }
      if (ctx.boundAtFold.has(key)) continue;                     // bound to some live node
      if (declined.has(key)) continue;
      if (ctx.removedThisPass.has(key)) continue;
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

  private async persist(): Promise<void> {
    try {
      await this.deps.state.flush();
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
    diagnostics: { pending: [], invalid: [], deletedButPresent: [] },
  };
}
