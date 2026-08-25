// src/sync/VaultWatcher.ts
// Local vault event -> tree mutation (spec §4.1), plus §5.5 (dragging out of the
// share) and §5.6 (bounded resurrect).
//
// This is the reconciler's mirror image: the reconciler drives the disk FROM the
// tree, and this module writes the user's local intent INTO it. One idea carries
// the whole design.
//
// INVARIANT I8 — every handler is "make the tree match reality", never "apply
// this delta". If the tree already describes what the handler observed, it writes
// nothing. That is why the module needs no assumption whatsoever about Obsidian's
// event fan-out: whether or not a folder rename also emits an event for each of
// its 400 descendants, each of those events finds the tree already correct and
// writes nothing (Group B tests 49 and 50 assert exactly that, both ways).
//
// Two mechanisms that look like correctness are only optimizations, and treating
// them as anything more is how the failure modes in I9 got into other plugins:
//   - TICKETS suppress the filesystem echo of our OWN mutations. They are
//     single-shot and TTL-bounded, and the reconciler clears the whole book in its
//     `finally` — so an echo that arrives after the pass ended finds no ticket at
//     all, and lands on I8 instead. It must be harmless there, and it is.
//   - The LOCAL transaction origin lets the tree observer skip a reconcile it
//     knows it already performed.
// There is no `applyingRemote` flag and no handler ever consults `reconciling`
// (I9): a handler that mutes is a handler that silently discards the user's work.
//
// Order of checks in EVERY handler, and the first two are not negotiable:
//   1. shareRootGuard (I14) — the shared folder itself is never a node.
//   2. the phase gate — while booting, queue; never drop.
//   3. the ticket, the scope filter, then idempotence.
//
// No `obsidian` import, no node builtins.

import {
  DELETE_COALESCE_MS,
  LOCAL_BULK_DELETE_THRESHOLD,
  MODIFY_COALESCE_MS,
  RECOVERED_DIR,
  RESURRECT_WINDOW_MS,
  STAGING_DIR,
} from '../tree/constants.ts';
import { DIR_SENTINEL, deriveTree, type DerivedTree } from '../tree/TreeIndex.ts';
import {
  fold, hashOf, hashOfBytes, isUnderDir, nodeKindOf, relPath, splitRel, validateRel,
} from '../tree/paths.ts';
import type { NodePatch, TreeDoc } from '../tree/TreeDoc.ts';
import type { NodeFields, NodeKind } from '../tree/types.ts';
import type { DeviceState } from './DeviceState.ts';
import type { Tickets } from './Tickets.ts';
import type { Kind, VaultPort } from './VaultPort.ts';

// ============================================================ public surface

export type Phase = 'boot' | 'readonly' | 'ready';

export interface WatcherDeps {
  tree: TreeDoc;
  /** Snapshot for `deriveTree`. Injected so the watcher never owns the Y.Doc. */
  entries: () => Array<[string, NodeFields]>;
  vault: VaultPort;
  state: DeviceState;
  tickets: Tickets;
  getShareRoot: () => string;
  /** Persists settings. P1c supplies the real one; §4.1's `saveSettings()`. */
  setShareRoot: (next: string) => void;
  /** This device's display name, written to a tombstone's `xb`. Display only. */
  displayName: string;
  phase: () => Phase;
  now?: () => number;
  notice?: (msg: string) => void;
  enterReadOnly?: (reason: string) => void;
  scheduleReconcile?: (cause: string) => void;
  /** I5 — only the creator publishes. Called for a node this device just minted. */
  enqueuePublish?: (nodeId: string) => void;
  /**
   * §3.8: repeatable admission, for a `'b'` node that just came back from the
   * dead. The intent is the hash of the bytes ON DISK, so a node whose reference
   * had drifted converges on what is actually there rather than on whatever the
   * tree last happened to name. `PublishQueue.requeue` is the implementation.
   */
  requeuePublish?: (nodeId: string, intent: string) => void;
  /**
   * §7.4's per-device whole-file allocation cap, injected as a plain number so
   * nothing here has to know what platform it is running on. It gates the
   * resurrect hash exactly as it gates every other whole-file read.
   */
  memoryCapBytes: () => number;
  /** Local bulk-delete gate (§4.1 step 5). Default action MUST be cancel. */
  confirmLocalBulkDelete?: (count: number) => Promise<boolean>;
  /** §5.5 — dragging content out of the share. Default action MUST be 'undo'. */
  confirmUnshare?: (rootPath: string, count: number) => Promise<'unshare' | 'undo'>;
}

// ============================================================ internals

/** One queued vault event, replayed verbatim once the plugin reaches `ready` (I9). */
type PendingEvent =
  | { op: 'create'; path: string; kind: Kind }
  | { op: 'rename'; path: string; oldPath: string; kind: Kind }
  | { op: 'delete'; path: string; kind: Kind }
  | { op: 'modify'; path: string };

/** A path the user removed from the share, resolved to the node that owns it. */
interface Batched {
  id: string;
  /** The node's STORED rel path — never the observed one, which may carry a suffix. */
  rel: string;
  /** The node's TREE kind (it comes from `f.k`), which is not the disk kind. */
  kind: NodeKind;
  /** Where the path was, and (for an unshare) where it went. */
  from: string;
  to: string;
}

interface WatcherIndex {
  tree: DerivedTree;
  /** fold(derived rel path) -> nodeId: where a live node actually MATERIALIZES. */
  byDerivedFold: Map<string, string>;
}

/** The three coalesced batches, each with its own timer and its own window. */
type Batch = 'delete' | 'unshare' | 'modify';

/**
 * §3.8's answer when a dead node may be reused: `hash` is the disk digest of a
 * `'b'` node's bytes, which the resurrect then requeues for publication. Null,
 * not this, is the refusal — so "no verdict" can never be read as "go ahead".
 */
interface ResurrectVerdict {
  hash?: string;
}

/** Shared empty answer for `takeDirtyPaths`, so the common case allocates nothing. */
const EMPTY_DIRTY: ReadonlySet<string> = new Set<string>();

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function depthOf(path: string): number {
  return path.split('/').length;
}

/** I18: compare and hash on normalized line endings; never write the result to disk. */
function normLF(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Path containment, compared segment by folded segment.
 *
 * SD-5: a folded string is never prefixed, concatenated or sliced. `fold` is
 * `toLowerCase` on an NFC string, and case mapping is neither length-preserving
 * nor guaranteed to distribute over concatenation, so the only safe way to ask
 * "is this the same path?" on a case-folding filesystem is to fold each segment
 * of the real strings and compare the lists. Every slice below is taken from the
 * REAL path using a SEGMENT COUNT, never from a folded one using a byte offset.
 */
function pathIsUnder(path: string, root: string): boolean {
  if (root === '') return false;
  const p = path.normalize('NFC').split('/');
  const r = root.normalize('NFC').split('/');
  if (p.length < r.length) return false;
  for (let i = 0; i < r.length; i++) if (fold(p[i]) !== fold(r[i])) return false;
  return true;
}

function isSamePath(a: string, b: string): boolean {
  return depthOf(a.normalize('NFC')) === depthOf(b.normalize('NFC')) && pathIsUnder(a, b);
}

/** `ShadowLink Recovered/` and `ShadowLink Staging/` are ours (§2.3), never the user's doing. */
function isReserved(path: string): boolean {
  return pathIsUnder(path, RECOVERED_DIR) || pathIsUnder(path, STAGING_DIR);
}

/**
 * Spec §4.1 step 3 / §5.5: sort by depth ascending and drop every entry lying
 * under a batched FOLDER. Deleting `Archive` and three of its notes in one batch
 * must tombstone the folder once and reach the notes through the cascade, not
 * write two tombstones on each of them.
 */
function dropDescendants(items: Batched[]): Batched[] {
  const sorted = [...items].sort((a, b) => depthOf(a.rel) - depthOf(b.rel) || cmp(a.rel, b.rel));
  const folders: string[] = [];
  const out: Batched[] = [];
  for (const item of sorted) {
    if (folders.some((root) => isUnderDir(item.rel, root))) continue;
    out.push(item);
    if (item.kind === 'd') folders.push(item.rel);
  }
  return out;
}

// ============================================================ VaultWatcher

export class VaultWatcher {
  /** Last contained failure from a coalesced flush, for diagnostics (I15). */
  lastFailure: unknown = null;

  private readonly deps: WatcherDeps;
  private readonly nowFn: () => number;

  private readonly pending: PendingEvent[] = [];
  /** literal path -> kind, coalesced over DELETE_COALESCE_MS. */
  private readonly deleteBatch = new Map<string, Kind>();
  /** fold(from) -> the move, coalesced over the same window (§5.5). */
  private readonly unshareBatch = new Map<string, { from: string; to: string }>();
  /** §5.5: nodes awaiting the user's answer. Reconcile must treat these as invalid. */
  private readonly decisionPending = new Set<string>();
  /**
   * fold(path) of every attachment the user has saved over since the last pass
   * took the set (§3.5).
   *
   * It is a hint about WHERE to spend the pass's re-hash budget and nothing more:
   * the pass recomputes every bound attachment either way, so losing this set
   * costs one slower convergence and never a wrong answer.
   */
  private readonly dirtyPaths = new Set<string>();

  private deleteTimer: ReturnType<typeof setTimeout> | null = null;
  private unshareTimer: ReturnType<typeof setTimeout> | null = null;
  private modifyTimer: ReturnType<typeof setTimeout> | null = null;
  private deleteChain: Promise<void> = Promise.resolve();
  private unshareChain: Promise<void> = Promise.resolve();

  constructor(deps: WatcherDeps) {
    this.deps = deps;
    this.nowFn = deps.now ?? ((): number => Date.now());
  }

  /**
   * §5.5. Until the user answers the unshare dialog these nodes are in limbo:
   * reconcile must treat them exactly like an invalid node — do nothing, do not
   * re-materialize. Without that, a pass fired while the modal is open puts the
   * file straight back into the folder the user just pulled it out of.
   */
  get pendingDecision(): ReadonlySet<string> {
    return this.decisionPending;
  }

  /** Events queued because the plugin was not `ready` yet (I9). */
  get pendingEventCount(): number {
    return this.pending.length;
  }

  /**
   * §3.5. Paths the modify handler has flagged, handed to the pass that asks for
   * them — and cleared in the same breath.
   *
   * TAKEN rather than read: the pass owns what it is given, so a save that lands
   * while the pass is running is answered by the NEXT pass instead of being
   * absorbed by one whose hashing was already decided.
   */
  takeDirtyPaths(): ReadonlySet<string> {
    if (this.dirtyPaths.size === 0) return EMPTY_DIRTY;
    const taken = new Set(this.dirtyPaths);
    this.dirtyPaths.clear();
    return taken;
  }

  /** Drop every pending timer. P1c calls this from `onunload`. */
  dispose(): void {
    this.clearTimer('delete');
    this.clearTimer('unshare');
    this.clearTimer('modify');
  }

  // ---------------------------------------------------------- I14

  /**
   * Spec §4.1, and it runs FIRST in every handler.
   *
   * The shared folder is not a node (I14): `toRel(shareRoot)` is a hard error, so
   * an event about the share root itself — or about one of its ancestors — has to
   * be resolved before any code path can try to turn it into one. Moving the
   * folder is a MOUNT change; losing it is a reason to stop, never evidence that
   * the user deleted everything inside it (I2).
   */
  shareRootGuard(path: string, newPath?: string): 'handled' | 'continue' {
    const root = this.shareRoot();

    if (isSamePath(path, root)) {
      if (newPath !== undefined) {
        this.deps.setShareRoot(trimRoot(newPath));
        this.deps.notice?.('Shared folder moved. ShadowLink is following it.');
        return 'handled';
      }
      this.deps.enterReadOnly?.('The shared folder no longer exists. Sync is paused.');
      return 'handled';
    }

    if (pathIsUnder(root, path) && depthOf(root) > depthOf(path)) {
      if (newPath !== undefined) {
        // Segment arithmetic on the REAL strings (SD-5), so a case-mapping that
        // changes a segment's length cannot corrupt the rewritten root.
        const tail = root.normalize('NFC').split('/').slice(depthOf(path));
        this.deps.setShareRoot([trimRoot(newPath), ...tail].join('/'));
        return 'handled';
      }
      this.deps.enterReadOnly?.('A parent of the shared folder was removed. Sync is paused.');
      return 'handled';
    }

    return 'continue';
  }

  // ---------------------------------------------------------- onCreate

  /**
   * Spec §4.1. A create is a claim that something exists at a path; the handler's
   * job is to make sure the tree agrees, which most of the time means doing
   * nothing at all.
   *
   * `kind` is Obsidian's DISK kind (`'f' | 'd'`), which is all Obsidian reports.
   * The TREE kind is derived here, through `nodeKindOf` and nowhere else, so a
   * `.png` becomes a `'b'` node and `Notes.MD` stays an `'f'` (spec §3.1).
   *
   * There is deliberately NO size check here. Obsidian fires `create` when a file
   * APPEARS, not when it is complete, so a `stat` at this moment would refuse a
   * file that is fine or mint a node for one that is not. Size is decided at
   * publish, where the bytes have settled, and a permanent refusal is retracted
   * (§3.2) rather than left as a ghost in every peer's Pending list.
   */
  async onCreate(path: string, kind: Kind): Promise<void> {
    if (this.shareRootGuard(path) === 'handled') return;
    if (this.deps.phase() !== 'ready') {
      this.pending.push({ op: 'create', path, kind });
      return;
    }
    const rel = this.toRel(path);
    if (rel === null) return;
    const nodeKind = nodeKindOf(rel, kind);
    if (!this.isSyncable(rel, nodeKind)) return;
    if (this.deps.tickets.claim('create', path)) return;
    // I13. `declinedPaths` holds fold(VAULT path) — the key Deletions writes when
    // it rescues a file or when the user keeps their copies. Re-adopting one of
    // those would re-share, as a brand-new node, a file the user chose to keep.
    if (this.isDeclined(path)) return;
    // §3.2. Publication has already refused this exact path as too large and
    // retracted the node it minted for it. Minting a second one here puts the same
    // file straight back into the same refusal — and a create event fires for
    // every rename and every restore, so it would do it again and again.
    //
    // No `stat` is taken to re-decide: this handler runs at the moment a file
    // APPEARS, where a size is not yet meaningful. The record self-heals in
    // reconciler step 6, which stats it once per pass with the bytes at rest.
    if (this.isOversized(path)) return;

    const idx = this.index();
    const key = fold(rel);

    // I8, twice over: a node may CLAIM this path (its stored `d`/`n`) or MATERIALIZE
    // at it (a collision suffix the tree assigned). Either way the tree already
    // describes the file, so all that is left is the local binding.
    const live = this.resolveLive(idx, rel);
    if (live !== undefined) {
      this.bind(live, path);
      return;
    }

    // I8 through the folder set. A directory the tree already IMPLIES — because
    // some node's `d` runs through it — needs no node of its own: folder nodes
    // exist so that an EMPTY folder can sync, nothing more. Minting one here is
    // how `ensureDirs`' echo (spec §4.2) turns into a permanent duplicate folder
    // node on every client once its ticket has expired.
    if (nodeKind === 'd' && idx.tree.wantAtFold.get(key) === DIR_SENTINEL) return;

    const dead = idx.tree.deadByFoldRel.get(key);
    if (dead !== undefined) {
      const verdict = await this.canResurrect(dead, path, nodeKind);
      if (verdict !== null) {
        this.resurrect(dead.nodeId, path, verdict.hash);
        return;
      }
    }

    const { d, n } = splitRel(rel);
    const id = this.deps.tree.createNode({ k: nodeKind, d, n }, this.nowFn());
    this.bind(id, path);
    if (nodeKind !== 'd') {
      // I5: creator-ness is recorded HERE, in local state, and never in the tree.
      // Exactly one client may ever seed a content doc, and only a node's creator
      // may publish an attachment's FIRST version (I5a).
      this.deps.state.data.owned[id] = true;
      this.deps.enqueuePublish?.(id);
      this.persist();
    }
  }

  // ---------------------------------------------------------- onModify

  /**
   * Spec §3.5. The user saved over an attachment.
   *
   * This handler has NO logic, and that is the design rather than an omission.
   * Reconciler step 2.5 is already "make the file and the tree agree" — a full
   * recompute over every bound attachment — so anything decided here would be a
   * second, weaker copy of that rule, running at the one moment the file is most
   * likely to be half-written. All it does is remember which path to spend the
   * pass's re-hash budget on first, and ask for a pass (I8).
   *
   * IT RETURNS IMMEDIATELY FOR A NOTE. Markdown modifications flow through the
   * CRDT and nowhere else: a modify handler that touched a note would fight the
   * live `yCollab` binding, turning Obsidian's external-change reload into a
   * whole-document overwrite broadcast to every peer — which is exactly the I7
   * failure this plugin exists to avoid.
   *
   * Same order as every other handler: share-root guard, phase gate, ticket,
   * scope, then idempotence. The ticket is an optimization only (I9) — without
   * one the next pass re-hashes the file, finds the tree already agrees, and does
   * nothing.
   */
  async onModify(path: string): Promise<void> {
    if (this.shareRootGuard(path) === 'handled') return;
    if (this.deps.phase() !== 'ready') {
      this.pending.push({ op: 'modify', path });
      return;
    }
    if (this.deps.tickets.claim('modify', path)) return;         // our own write, echoing back
    const rel = this.toRel(path);
    if (rel === null) return;

    // A path no live node owns is step 6's business (it offers untracked files to
    // the publisher), never this handler's: there is no content to compare yet.
    const id = this.resolveLive(this.index(), rel);
    if (id === undefined) return;
    const f = this.deps.tree.get(id);
    if (f === null || f.k !== 'b') return;                       // I7: notes are the CRDT's

    this.dirtyPaths.add(fold(path));
    this.scheduleFlush('modify');
  }

  /** Force the coalesced modify batch to resolve now. Tests call this; so does P1c. */
  async flushModify(): Promise<void> {
    this.clearTimer('modify');
    if (this.dirtyPaths.size === 0) return;
    this.deps.scheduleReconcile?.('modify');
  }

  // ---------------------------------------------------------- §5.6

  /**
   * Spec §5.6 and §3.8. Delete then Ctrl-Z brings the node back — and with it the
   * content doc and its entire history. Everything outside that narrow window is
   * a different file that merely shares a name.
   *
   * Both clauses are load-bearing. The WINDOW is what stops "Bob drags his own
   * `inbox.md` into the share three months later and is silently handed Alice's
   * March note". The CONTENT test is what stops the same thing happening inside
   * five minutes.
   *
   * Null refuses. A verdict resurrects, and for a `'b'` it carries the hash of
   * the bytes that were actually on disk, which is what the node then republishes.
   */
  private async canResurrect(
    dead: { nodeId: string; k: NodeKind; xa?: number; xh?: string },
    path: string,
    kind: NodeKind,
  ): Promise<ResurrectVerdict | null> {
    // §3.8: a dead `.md` never adopts a `.png`, and a dead FOLDER never adopts
    // either. `xh` is a hash of TEXT for a note and of RAW BYTES for an
    // attachment, and a directory has no content at all — so a tombstone of one
    // kind is never evidence about a file of another, and reusing it across kinds
    // would bind a live node to content it has never described.
    if (dead.k !== kind) return null;
    // A directory has no bytes to compare, so there is nothing to bound the reuse
    // with. A fresh dir node is free — directories carry no content and dedupe by
    // path (§1.4) — so the safe answer is always to mint one.
    if (kind === 'd') return null;
    if (dead.xa === undefined) return null;
    if (this.nowFn() - dead.xa > RESURRECT_WINDOW_MS) return null;

    if (kind === 'f') {
      let local: string;
      try {
        local = normLF(await this.deps.vault.read(path));
      } catch {
        return null;                      // I2: "I could not look" is never evidence
      }
      // Not a loophole: Obsidian emits `create` for a file whose bytes have not
      // landed yet, and an empty file is exactly the state a recreate passes
      // through. The CRDT merges over the mistake afterwards.
      if (local.length === 0) return {};
      if (dead.xh === undefined) return null;
      return await hashOf(local) === dead.xh ? {} : null;
    }

    // kind === 'b'. THE ZERO-LENGTH ESCAPE IS DELIBERATELY ABSENT. For a note an
    // empty file is a state a recreate genuinely passes through and the CRDT
    // merges over it; for a binary there is no merge, so the escape would bind a
    // live, seeded node with a stale `b` to a COMPLETELY DIFFERENT file — and the
    // workspace would then restore the deleted image on every peer while the
    // user's new one existed only here. Refusing costs almost nothing: content
    // addressing makes a fresh node a HEAD and a tree write.
    let st: { bytes: number } | null;
    try {
      st = await this.deps.vault.stat(path);
    } catch {
      return null;                        // I2
    }
    if (st === null) return null;         // I2
    if (st.bytes === 0) return null;
    if (st.bytes > this.deps.memoryCapBytes()) return null;   // §7.4: never read to answer
    if (dead.xh === undefined) return null;

    let hash: string;
    try {
      hash = await hashOfBytes(await this.deps.vault.readBinary(path));
    } catch {
      return null;                        // I2
    }
    return hash === dead.xh ? { hash } : null;
  }


  /**
   * Spec §5.6. `g = x + 1`, which is the whole reason liveness is a COMPARISON
   * rather than a boolean: a recreate merged with a concurrent delete always wins,
   * because `g` converges to the higher value while `x` stays behind. An LWW
   * `deleted: true` would resolve that race by coin flip.
   *
   * `s` is deliberately untouched (R-S3): the content doc still holds the bytes,
   * and clearing `s` would strand them behind a node nobody may publish. `b` is
   * untouched for the same reason — and because the requeue below is what makes
   * it right again if it has drifted.
   */
  private resurrect(id: string, path: string, hash?: string): void {
    const f = this.deps.tree.get(id);
    const rel = this.toRel(path);
    if (f === null || rel === null) return;
    const { d, n } = splitRel(rel);
    this.deps.tree.patchNode(id, {
      g: (f.x ?? f.g) + 1,
      d,
      n,
      xa: undefined,
      xb: undefined,
      xh: undefined,
      xp: undefined,
    });
    this.bind(id, path);
    // §3.8. An attachment's bytes live outside the tree, so nothing else would
    // notice that `b` and the disk disagree; a repeatable admission keyed on the
    // DISK hash converges the tree on what is actually there. A matching intent
    // is a no-op in the queue, so a node that never drifted costs nothing.
    if (hash !== undefined) this.deps.requeuePublish?.(id, hash);
  }

  // ---------------------------------------------------------- onRename

  /** Spec §4.1. Covers rename AND move; they are the same event in Obsidian. */
  async onRename(path: string, oldPath: string, kind: Kind): Promise<void> {
    if (this.shareRootGuard(oldPath, path) === 'handled') return;
    if (this.deps.phase() !== 'ready') {
      this.pending.push({ op: 'rename', path, oldPath, kind });
      return;
    }
    if (this.deps.tickets.claim('rename', oldPath, path)) return;

    const relOld = this.toRel(oldPath);
    const relNew = this.toRel(path);
    const was = relOld !== null;
    // The scope test uses the TREE kind (§3.6). Handing it Obsidian's disk kind
    // asks `validateRel(d, n, 'f')`, which refuses every name that is not `.md` —
    // so every attachment move INSIDE the share read as a drag-out and was
    // misrouted to `queueUnshare`: a workspace-wide tombstone, or a silent undo of
    // the user's own move. That is the most common attachment operation there is.
    const nowInside = relNew !== null && this.isSyncable(relNew, nodeKindOf(relNew, kind));

    if (!was && !nowInside) return;
    if (!was) { await this.onCreate(path, kind); return; }
    if (!nowInside) { this.queueUnshare(oldPath, path); return; }             // §5.5

    const idx = this.index();
    const id = await this.resolveRenamed(idx, oldPath, relOld, relNew!);
    if (id === undefined) { await this.onCreate(path, kind); return; }

    // I8. The tree already places this node exactly where the event says it is —
    // which is what every descendant event of a folder rename sees, because the
    // parent's `d` rewrite has already landed.
    if (idx.tree.derivedPath.get(id) === relNew) {
      this.bind(id, path);
      return;
    }

    const f = this.deps.tree.get(id);
    if (f === null) { await this.onCreate(path, kind); return; }
    const { d, n } = splitRel(relNew!);
    const tree = this.deps.tree;

    // §3.6, the KIND-CROSSING rename (`notes.md` -> `notes.png`, `scan.png` ->
    // `scan.md`). `k` is written once and never mutated, so this is not
    // expressible as a patch — and leaving it unhandled makes the node
    // permanently INVALID on every peer: no derived path, never materialized,
    // never deleted, a stale file on every disk behind one diagnostics line.
    //
    // So the old node is tombstoned where it was and a new one of the right kind
    // is minted, in ONE transaction. The history stays with the old name, which
    // is a real loss and is why the user is told; it is strictly better than a
    // node nothing can act on.
    if (nodeKindOf(relNew!, kind) !== f.k) {
      const newKind = nodeKindOf(relNew!, kind);
      let minted = '';
      tree.transactLocal(() => {
        const patch: NodePatch = { x: f.g, xa: this.nowFn(), xb: this.deps.displayName };
        // The bytes this device last confirmed, so a peer holding the old file can
        // still prove what it is holding (§5.3's rescue).
        const known = this.deps.state.data.contentHash[id];
        if (known !== undefined) patch.xh = known.sha256;
        tree.patchNode(id, patch);
        minted = tree.createNode({ k: newKind, d, n }, this.nowFn());
      });
      this.unbind(id);
      this.bind(minted, path);
      // I5: this device minted it, so this device publishes it — and nobody else.
      this.deps.state.data.owned[minted] = true;
      this.deps.enqueuePublish?.(minted);
      this.persist();
      this.deps.notice?.(
        `"${relOld}" became "${relNew!}". It is now shared as a new file; `
        + 'its history stays with the old name.',
      );
      return;
    }

    // ONE transaction: the node and, for a directory, every descendant's `d`.
    // Nested `transactLocal` calls merge into this one, so observers see a single
    // change however many nodes it touches.
    tree.transactLocal(() => {
      const patch: NodePatch = {};
      if (f.d !== d) patch.d = d;
      if (f.n !== n) patch.n = n;
      if (patch.d !== undefined || patch.n !== undefined) tree.patchNode(id, patch);

      if (f.k !== 'd') return;
      // The prefix rewrite. It is what makes the design independent of whether
      // Obsidian emits an event per descendant: by the time those arrive (if they
      // arrive), the tree already says what they are about to claim.
      for (const [cid, cf] of tree.entries()) {
        if (cid === id) continue;
        if (cf.d === relOld) tree.patchNode(cid, { d: relNew! });
        else if (cf.d.startsWith(`${relOld}/`)) {
          tree.patchNode(cid, { d: relNew! + cf.d.slice(relOld.length) });
        }
      }
    });

    this.bind(id, path);
    if (f.k === 'd') this.rebindSubtree(oldPath, path);
  }

  // ---------------------------------------------------------- §5.5

  /**
   * Spec §5.5. Dragging a 300-note folder out of the share must produce ONE
   * question, not 301, so the moves coalesce and reduce to their shallowest paths
   * before anybody is asked anything.
   */
  queueUnshare(from: string, to: string): void {
    // Our own two-phase move and our own rescue both look exactly like a drag-out.
    // Neither is one: the reserved folders are ShadowLink's (§2.3), and a rescue
    // moves a file whose node is ALREADY dead.
    if (isReserved(to)) return;
    this.unshareBatch.set(fold(from), { from, to });
    this.scheduleFlush('unshare');
  }

  /** Force the coalesced unshare batch to resolve now. Tests call this; so does P1c. */
  async flushUnshare(): Promise<void> {
    this.clearTimer('unshare');
    const run = this.unshareChain.then(
      () => this.runUnshareFlush(),
      () => this.runUnshareFlush(),
    );
    this.unshareChain = run.catch(() => undefined);
    return run;
  }

  private async runUnshareFlush(): Promise<void> {
    const moves = [...this.unshareBatch.values()];
    this.unshareBatch.clear();
    if (moves.length === 0) return;

    try {
      const idx = this.index();
      const items: Batched[] = [];
      const seen = new Set<string>();
      for (const move of moves) {
        const rel = this.toRel(move.from);
        if (rel === null) continue;
        // LIVE only. A dead node's file leaving the share is our own rescue
        // (§5.3), and asking the user to unshare something already deleted would
        // be nonsense. This is the same idempotence check `onDelete` makes.
        const id = this.resolveLive(idx, rel);
        if (id === undefined || seen.has(id)) continue;
        const f = this.deps.tree.get(id);
        if (f === null) continue;
        seen.add(id);
        items.push({ id, rel: relPath(f), kind: f.k, from: move.from, to: move.to });
      }
      if (items.length === 0) return;

      const roots = dropDescendants(items);
      const { affected, cascade } = this.expandCascade(idx, roots);
      for (const id of affected) this.decisionPending.add(id);

      let choice: 'unshare' | 'undo' = 'undo';
      try {
        const ask = this.deps.confirmUnshare;
        // No dialog, a rejected dialog and an unrecognized answer are all 'undo'.
        // Silence is never consent to remove a folder for the whole workspace.
        if (ask !== undefined) {
          choice = await ask(roots[0].from, affected.length) === 'unshare' ? 'unshare' : 'undo';
        }
      } catch {
        choice = 'undo';
      }

      try {
        if (choice === 'unshare') this.writeTombstones(roots, cascade);
        else await this.undoMoves(roots);
      } finally {
        for (const id of affected) this.decisionPending.delete(id);
      }
      this.deps.scheduleReconcile?.(choice === 'unshare' ? 'unshared' : 'undo-unshare');
    } catch (err) {
      this.lastFailure = err;
    }
  }

  /**
   * "Undo the move" — the reverse `vault.rename`, through the ticket system, and
   * only after checking the original path is free. A failure here is a no-op: the
   * tree still says the file belongs in the share, so the next reconcile puts it
   * back anyway (I2).
   */
  private async undoMoves(roots: Batched[]): Promise<void> {
    for (const root of roots) {
      try {
        if (await this.deps.vault.exists(root.from)) continue;
        this.deps.tickets.arm('rename', root.to, root.from);
        await this.deps.vault.rename(root.to, root.from);
      } catch (err) {
        this.lastFailure = err;
      }
    }
  }

  // ---------------------------------------------------------- onDelete

  /**
   * Spec §4.1. A delete does nothing on its own: it joins a batch. Every
   * expensive and irreversible decision — re-verification, cascade expansion, the
   * circuit breaker — is made once, in `flushDeleteBatch`, over the whole batch.
   */
  onDelete(path: string, kind: Kind): void {
    if (this.shareRootGuard(path) === 'handled') return;
    if (this.deps.phase() !== 'ready') {
      this.pending.push({ op: 'delete', path, kind });
      return;
    }
    if (this.deps.tickets.claim('delete', path)) return;
    if (this.toRel(path) === null) return;
    this.deleteBatch.set(path, kind);
    this.scheduleFlush('delete');
  }

  /** Force the coalesced delete batch to flush now. Tests call this; so does P1c. */
  async flushDeleteBatch(): Promise<void> {
    this.clearTimer('delete');
    const run = this.deleteChain.then(
      () => this.runDeleteFlush(),
      () => this.runDeleteFlush(),
    );
    this.deleteChain = run.catch(() => undefined);
    return run;
  }

  private async runDeleteFlush(): Promise<void> {
    const paths = [...this.deleteBatch.keys()];
    this.deleteBatch.clear();
    if (paths.length === 0) return;

    try {
      // 1. RE-VERIFY (I2). A path that is back on disk was a staging move or a
      //    rename, not a delete. An `exists` that throws is not evidence either:
      //    it reads as present, because the cost of being wrong runs one way.
      const gone: string[] = [];
      for (const path of paths) {
        let present = true;
        try {
          present = await this.deps.vault.exists(path);
        } catch (err) {
          this.lastFailure = err;
        }
        if (!present) gone.push(path);
      }
      if (gone.length === 0) return;

      // 2. Map to LIVE nodes. A path whose node is already dead drops out — that
      //    is `onDelete`'s idempotence check, and it is what stops every peer
      //    writing its own explicit tombstone for the same descendant.
      const idx = this.index();
      const items: Batched[] = [];
      const seen = new Set<string>();
      for (const path of gone) {
        const rel = this.toRel(path);
        if (rel === null) continue;
        const id = this.resolveLive(idx, rel);
        if (id === undefined || seen.has(id)) continue;
        const f = this.deps.tree.get(id);
        if (f === null) continue;
        seen.add(id);
        // The node's STORED path, not the observed one: `xp` and the containment
        // test in `expandCascade` are both expressed in stored coordinates.
        items.push({ id, rel: relPath(f), kind: f.k, from: path, to: path });
      }
      if (items.length === 0) return;

      // 3 + 4. Reduce to roots, then expand to everything they kill.
      const roots = dropDescendants(items);
      const { affected, cascade } = this.expandCascade(idx, roots);

      // 5. The LOCAL circuit breaker. `git checkout`, Syncthing and Dropbox all
      //    remove files behind Obsidian's back, and every one of those looks
      //    exactly like the user deleting them. Declining writes NOTHING and
      //    schedules a reconcile: the tree still says the files should exist, so
      //    the next pass restores them. That is the correct answer for an external
      //    tool having removed them, and it is why the default must be cancel — a
      //    missing callback and a rejected dialog are both a decline.
      if (affected.length > LOCAL_BULK_DELETE_THRESHOLD) {
        let ok = false;
        try {
          const ask = this.deps.confirmLocalBulkDelete;
          if (ask !== undefined) ok = await ask(affected.length);
        } catch (err) {
          this.lastFailure = err;
          ok = false;
        }
        if (!ok) {
          this.deps.scheduleReconcile?.('declined-local-delete');
          return;
        }
      }

      // 6. ONE transaction.
      this.writeTombstones(roots, cascade);
    } catch (err) {
      this.lastFailure = err;
    }
  }

  // ---------------------------------------------------------- tombstones

  /**
   * Spec §4.1 step 6 and §5.5, in one transaction.
   *
   * A folder root additionally marks every live descendant with `xp = rootRel`,
   * the cascade marker of §2.2. That marker is what lets a child which
   * concurrently moved OUT of the folder survive: its tombstone only applies
   * while its `d` is still under the folder it was cascaded from.
   */
  private writeTombstones(roots: Batched[], cascade: Map<string, string[]>): void {
    const at = this.nowFn();
    const by = this.deps.displayName;
    const tree = this.deps.tree;
    const hashes = this.deps.state.data.contentHash;

    tree.transactLocal(() => {
      for (const root of roots) {
        const f = tree.get(root.id);
        if (f === null) continue;
        const patch: NodePatch = { x: f.g, xa: at, xb: by };
        const known = hashes[root.id];
        if (known !== undefined) patch.xh = known.sha256;
        tree.patchNode(root.id, patch);

        for (const cid of cascade.get(root.id) ?? []) {
          const cf = tree.get(cid);
          if (cf === null) continue;
          const child: NodePatch = { x: cf.g, xa: at, xb: by, xp: root.rel };
          const childHash = hashes[cid];
          if (childHash !== undefined) child.xh = childHash.sha256;
          tree.patchNode(cid, child);
        }
      }
    });

    for (const root of roots) {
      this.unbind(root.id);
      for (const cid of cascade.get(root.id) ?? []) this.unbind(cid);
    }
    this.persist();
  }

  /**
   * Spec §4.1 step 4: the roots plus every live node under a folder root.
   *
   * Invalid nodes are excluded (I10) — they are skipped entirely, everywhere, and
   * a tombstone is an action like any other. So are already-dead ones: `affected`
   * feeds the circuit breaker's count, and inflating it with nodes nothing is
   * about to happen to would raise a dialog about work that is already done.
   */
  private expandCascade(
    idx: WatcherIndex,
    roots: Batched[],
  ): { affected: string[]; cascade: Map<string, string[]> } {
    const cascade = new Map<string, string[]>();
    const affected: string[] = [];
    const seen = new Set<string>();

    for (const root of roots) {
      if (seen.has(root.id)) continue;
      seen.add(root.id);
      affected.push(root.id);
    }

    for (const root of roots) {
      if (root.kind !== 'd') {
        cascade.set(root.id, []);
        continue;
      }
      const children: string[] = [];
      for (const [cid, f] of this.deps.entries()) {
        if (cid === root.id) continue;
        if (!idx.tree.derivedPath.has(cid)) continue;      // dead or invalid: not ours to touch
        if (!isUnderDir(f.d, root.rel)) continue;
        children.push(cid);
        if (seen.has(cid)) continue;
        seen.add(cid);
        affected.push(cid);
      }
      children.sort(cmp);
      cascade.set(root.id, children);
    }

    return { affected, cascade };
  }

  // ---------------------------------------------------------- pending events

  /**
   * Replay everything that arrived before bootstrap finished (I9, §4.5 step 10).
   * Anything the tree already describes drops out on its own — which is most of
   * it, because the bootstrap pass that just ran is what put it there.
   */
  async flushPending(): Promise<void> {
    const queued = [...this.pending];
    this.pending.length = 0;
    for (const event of queued) {
      if (event.op === 'create') await this.onCreate(event.path, event.kind);
      else if (event.op === 'rename') await this.onRename(event.path, event.oldPath, event.kind);
      else if (event.op === 'modify') await this.onModify(event.path);
      else this.onDelete(event.path, event.kind);
    }
    await this.flushDeleteBatch();
    await this.flushUnshare();
  }

  // ---------------------------------------------------------- index + resolution

  /**
   * Recomputed per event, for ALL origins including our own.
   *
   * Spec risk R12 forbids patching a derived index incrementally, and recomputing
   * it for local transactions too is what fixes "create-then-rename forks the
   * node" (test 48): the rename must be able to see the node the create just
   * minted, with no reconcile in between.
   */
  private index(): WatcherIndex {
    const tree = deriveTree(this.deps.entries());
    const byDerivedFold = new Map<string, string>();
    for (const [id, path] of tree.derivedPath) {
      const key = fold(path);
      const claimed = byDerivedFold.get(key);
      // Two live dir nodes at one path are one directory (§1.4); resolve to the
      // lowest nodeId, exactly as `liveByFoldRel` does.
      if (claimed === undefined || cmp(id, claimed) < 0) byDerivedFold.set(key, id);
    }
    return { tree, byDerivedFold };
  }

  /** The live node that stores this path, or the one that materializes at it. */
  private resolveLive(idx: WatcherIndex, rel: string): string | undefined {
    const key = fold(rel);
    return idx.tree.liveByFoldRel.get(key) ?? idx.byDerivedFold.get(key);
  }

  /**
   * Spec §4.1: the local binding first, then the old path, then the new one.
   *
   * A binding is only trusted when it names a node that is still live and valid —
   * `derivedPath` holds exactly those. A stale binding to a node a peer has since
   * deleted must not turn a local rename into an edit of somebody's tombstone.
   */
  private async resolveRenamed(
    idx: WatcherIndex,
    oldPath: string,
    relOld: string,
    relNew: string,
  ): Promise<string | undefined> {
    // §3.6. A rename whose OLD path is occupied again is not a rename of whatever
    // used to live there. The fork sequence produces exactly that shape —
    // `rename A -> B`, then `create A` — and once the pass's `clearArmed()` has
    // dropped the ticket, a late echo would otherwise be trusted and rename the
    // CANONICAL node to the conflicted-copy name on every peer. Treating it as a
    // create of the new path is what makes a missing ticket harmless (I9).
    //
    // Only a definite `true` blocks: `exists` throwing is "I could not look", and
    // I2 says that is never evidence — here, evidence that the old path came back.
    let backOnDisk = false;
    try {
      backOnDisk = await this.deps.vault.exists(oldPath);
    } catch (err) {
      this.lastFailure = err;
    }
    if (backOnDisk) return this.resolveLive(idx, relNew);

    const bound = this.boundId(oldPath);
    if (bound !== undefined && idx.tree.derivedPath.has(bound)) return bound;
    return this.resolveLive(idx, relOld) ?? this.resolveLive(idx, relNew);
  }

  private boundId(path: string): string | undefined {
    const key = fold(path);
    for (const [id, bound] of Object.entries(this.deps.state.data.materialized)) {
      if (fold(bound) === key) return id;
    }
    return undefined;
  }

  // ---------------------------------------------------------- scope

  private shareRoot(): string {
    return trimRoot(this.deps.getShareRoot());
  }

  /**
   * Share-relative path, NFC-normalized, or null when the path is outside the
   * share — or IS the share (I14: `toRel(shareRoot)` is a hard error, expressed
   * here as "there is no such node" so every caller has to handle it).
   */
  private toRel(path: string): string | null {
    const root = this.shareRoot();
    if (!pathIsUnder(path, root)) return null;
    const segs = path.normalize('NFC').split('/');
    if (segs.length <= depthOf(root)) return null;
    return segs.slice(depthOf(root)).join('/');
  }

  /**
   * §7's path filter, applied to a LOCAL path before it may become a node.
   *
   * The kind is the TREE kind, never the disk kind: `validateRel`'s rules differ
   * per kind (an `'f'` must be `.md`, a `'b'` must have a short, non-`.md`,
   * non-executable extension), so asking it about the wrong one refuses files that
   * are perfectly shareable.
   */
  private isSyncable(rel: string, kind: NodeKind): boolean {
    const { d, n } = splitRel(rel);
    return validateRel(d, n, kind);
  }

  private isDeclined(path: string): boolean {
    return this.deps.state.data.declinedPaths.includes(fold(path));
  }

  /**
   * §3.2. Is this path one publication refused as too large?
   *
   * Deliberately NOT the same map as `declinedPaths`: a keep decision is the
   * user's and is permanent, while a size refusal is a statement about a file at a
   * size and is dropped again the moment the file is smaller (I13).
   */
  private isOversized(path: string): boolean {
    return this.deps.state.data.oversized[fold(path)] !== undefined;
  }

  // ---------------------------------------------------------- bookkeeping

  /** `bindIndex` in the spec: a LOCAL fact about this device, never a tree write. */
  private bind(id: string, path: string): void {
    if (this.deps.state.data.materialized[id] === path) return;
    this.deps.state.data.materialized[id] = path;
    this.persist();
  }

  private unbind(id: string): void {
    delete this.deps.state.data.materialized[id];
  }

  /**
   * A folder rename moves every descendant's file too, so their bindings move
   * with it. Sliced by SEGMENT COUNT off the real paths (SD-5).
   */
  private rebindSubtree(oldPath: string, newPath: string): void {
    const bindings = this.deps.state.data.materialized;
    const depth = depthOf(oldPath.normalize('NFC'));
    for (const [id, bound] of Object.entries(bindings)) {
      if (!pathIsUnder(bound, oldPath)) continue;
      const tail = bound.normalize('NFC').split('/').slice(depth);
      bindings[id] = tail.length === 0 ? newPath : [newPath, ...tail].join('/');
    }
    this.persist();
  }

  private persist(): void {
    this.deps.state.schedulePersist();
  }

  // ---------------------------------------------------------- timers

  private scheduleFlush(which: Batch): void {
    if (this.timerFor(which) !== null) return;
    // A modify window is longer than a delete window on purpose: an editor that
    // saves in three steps fires three events, and the file is still being
    // written through all of them (§3.5).
    const delay = which === 'modify' ? MODIFY_COALESCE_MS : DELETE_COALESCE_MS;
    const handle = setTimeout(() => {
      if (which === 'delete') {
        this.deleteTimer = null;
        void this.flushDeleteBatch();
      } else if (which === 'unshare') {
        this.unshareTimer = null;
        void this.flushUnshare();
      } else {
        this.modifyTimer = null;
        void this.flushModify();
      }
    }, delay);
    // Node keeps the process alive for a pending timer; Obsidian's setTimeout
    // returns a plain number with no `unref`. Optional-call both ways.
    (handle as unknown as { unref?: () => void }).unref?.();
    if (which === 'delete') this.deleteTimer = handle;
    else if (which === 'unshare') this.unshareTimer = handle;
    else this.modifyTimer = handle;
  }

  private timerFor(which: Batch): ReturnType<typeof setTimeout> | null {
    if (which === 'delete') return this.deleteTimer;
    if (which === 'unshare') return this.unshareTimer;
    return this.modifyTimer;
  }

  private clearTimer(which: Batch): void {
    const handle = this.timerFor(which);
    if (handle !== null) clearTimeout(handle);
    if (which === 'delete') this.deleteTimer = null;
    else if (which === 'unshare') this.unshareTimer = null;
    else this.modifyTimer = null;
  }
}

/** A trailing slash would make every containment check fail closed. */
function trimRoot(root: string): string {
  return root.replace(/\/+$/, '');
}
