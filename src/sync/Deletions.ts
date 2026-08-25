// src/sync/Deletions.ts
// Reconciler step 4: applying a remote tombstone to the local vault (spec §5.3,
// §5.4).
//
// This is the most dangerous module in P1, so it is written around one rule and
// one posture.
//
// THE RULE — `proven`. A file is removed only when its bytes are provably the
// bytes of the shared document: the node says it was seeded, this device recorded
// a confirmed content hash for it, and that hash still matches what is on disk
// right now. Anything else — an unseeded node, a hash we never recorded, a hash
// that no longer matches, or a note the user has open — is content this device
// cannot prove is recoverable from the workspace.
//
// AN ATTACHMENT IS PROVEN DIFFERENTLY, and more strongly (spec §5.1). Its
// authoritative digest rides in the TREE, where every peer can see it, and the
// content-addressed store can be asked whether it still holds exactly those
// bytes — so the comparison is against the workspace's own digest rather than a
// device-local memory, and the store's answer is evidence the bytes are
// retrievable NOW. The happy consequence is the one that matters at 200 MB: for
// markdown `proven` fails often and `ShadowLink Recovered/` fills with small text
// files, while for a binary it usually succeeds, so the common attachment delete
// goes to the restorable `.trash` instead of becoming a permanent gigabyte in a
// folder nobody prunes.
//
// THE POSTURE — rescue on ignorance. Unproven content is not left in place and it
// is not removed: it is MOVED into `ShadowLink Recovered/` under a name that says
// who deleted it and when, and the node is added to the declined set so no later
// pass tries again. A rescue is a rename, so an open editor leaf follows the file
// and no bytes ever exist only in memory. Removal proper goes to the vault-local
// `.trash`, which is restorable from inside Obsidian on every platform including
// mobile; the two irreversible vault calls named by invariant I1 appear nowhere
// in this file, and `Deletions.test.ts` asserts that by reading the source.
//
// The circuit breaker (§5.4, §5.3) sits in front of all of it. A batch that would
// push this device past its persisted deletion rate window, a batch whose
// attachments total more than the byte alert, and ANY batch on a bootstrap pass —
// the "you were offline while the team reorganized" case — apply nothing until a
// human says otherwise. A missing dialog, a rejected dialog and an explicit "keep
// my copies" are all the same answer: decline, persist the decision, never ask
// again.
//
// No `obsidian` import, no node builtins.

import {
  PROVE_HASH_MAX_BYTES, RECOVERED_DIR, REMOTE_DELETE_BUDGET,
  REMOTE_DELETE_BYTES_ALERT,
} from '../tree/constants.ts';
import {
  assertInsideShare, extOf, fold, hashOf, hashOfBytes, parseBlobRef, safeInFilename,
  type BlobRef,
} from '../tree/paths.ts';
import type { NodeFields } from '../tree/types.ts';
import type { BlobPort } from './BlobPort.ts';
import type { DeviceState } from './DeviceState.ts';
import type { DeletionContext } from './Reconciler.ts';
import type { Tickets } from './Tickets.ts';
import type { VaultPort } from './VaultPort.ts';

// ============================================================ public surface

export type BulkChoice = 'apply' | 'keep';

/** What the aggregated dialog needs to describe a batch it is refusing to apply. */
export interface BulkSummary {
  count: number;
  /**
   * Total size of the batch's ATTACHMENTS, from their tree references (§5.3).
   *
   * Zero for a batch of notes: markdown has no size in the tree, and inventing
   * one would mean reading every file to answer a question about a dialog.
   */
  bytes: number;
  /** Distinct display names taken from `xb`, in first-seen order. */
  deletedBy: string[];
  /** A few literal paths, for the dialog's body. */
  samplePaths: string[];
}

/** One tombstone that survived `collectDeletable`. `path` is the LITERAL disk casing. */
export interface Deletable {
  id: string;
  path: string;
  f: NodeFields;
}

export interface DeletionsDeps {
  vault: VaultPort;
  /**
   * The attachment store (spec §8.3), used for one thing only: asking whether the
   * exact bytes a tombstoned `'b'` node names are still retrievable (§5.1).
   *
   * Optional, and absent means "cannot ask" — which reads as rescue, like every
   * other form of ignorance in this module.
   */
  blobs?: BlobPort;
  state: DeviceState;
  tickets: Tickets;
  shareRoot: string;
  now?: () => number;
  /**
   * §7.4's per-device whole-file allocation cap, injected as a plain number so
   * nothing here has to know what platform it is running on. It gates the prove
   * hash exactly as it gates every other whole-file read.
   */
  memoryCapBytes: () => number;
  notice?: (msg: string, ms?: number) => void;
  /**
   * Ask the user about a batch that exceeds the budget. MUST default to 'keep':
   * the caller's dialog defaults to do-nothing and Escape means do-nothing (§5.4).
   * Omitted => treated as 'keep' (never silently apply).
   */
  confirmBulk?: (summary: BulkSummary) => Promise<BulkChoice>;
  /** nodeId currently bound in the editor, or null (I7). */
  openNodeId?: () => string | null;
  /** Unbind the editor from that node before its file is touched (I7). */
  closeSession?: (nodeId: string) => Promise<void>;
}

// The reconciler owns the shape of the context it hands step 4; re-exported here
// so callers of this module do not have to reach into the reconciler for a type.
export type { DeletionContext };

// ============================================================ internals

/** How long the two notices stay up (spec §5.3). */
const RESCUE_NOTICE_MS = 10_000;
const TRASH_NOTICE_MS = 6_000;

/** How many literal paths the aggregated dialog is given to show. */
const SAMPLE_PATHS = 5;

/** Shared empty answer for a partial context, so the common case allocates nothing. */
const EMPTY_REFS: ReadonlyMap<string, BlobRef> = new Map<string, BlobRef>();

/**
 * The collaborators one `apply` runs against.
 *
 * The pass's own structures win over the constructor deps wherever the context
 * supplies them: a deletion must be decided against the same vault, the same
 * disk view, the same ticket book and the same clock the rest of the pass used,
 * and the reconciler hands those over precisely so step 4 cannot drift from
 * them. The deps remain the fallback for a caller that assembles a partial
 * context, and the only source for what a pass cannot know — the dialog and the
 * editor session.
 */
interface Env {
  vault: VaultPort;
  /** Null when no store was wired: "cannot ask", which is never proof (I2). */
  blobs: BlobPort | null;
  /** The pass's parsed references for LIVE published `'b'` nodes (§5.2). */
  blobRefs: ReadonlyMap<string, BlobRef>;
  state: DeviceState;
  tickets: Tickets;
  shareRoot: string;
  now: () => number;
  notice: (msg: string, ms?: number) => void;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** I18: compare and hash on normalized line endings; never write the result to disk. */
function normLF(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** `2026-06-26`. Display only — `xa` is a peer's wall clock and converges nothing. */
function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function displayName(f: NodeFields): string {
  return f.xb ?? 'a collaborator';
}

/**
 * Spec §5.3's rescue name: `<basename> (deleted by <who> <date>)<ext>`.
 *
 * The basename keeps its own extension, so a rescued `todo.md` becomes
 * `todo.md (deleted by Ann 2026-06-26).md` and a rescued `shot.png` becomes
 * `shot.png (deleted by Ann 2026-06-26).png`. That is the spec's literal
 * construction and it is the right one: the name Obsidian shows is then exactly
 * the name the file had, plus the reason it moved.
 *
 * The FALLBACK is kind-aware (§5.2). `validateRel` guarantees a `'b'` node has an
 * extension, so it is unreachable today — but a hardcoded `.md` on a rescued PNG
 * would be silently wrong the day that stops being true, and the file would come
 * back as an unreadable note rather than an image.
 *
 * Exported for its Group A test: it is a pure naming function, and reaching it
 * only through a context that could not legally exist would test less than it.
 */
export function rescueName(path: string, f: NodeFields, fallbackAt: number): string {
  const who = safeInFilename(displayName(f));
  const when = dateOf(f.xa ?? fallbackAt);
  const ext = extOf(path);
  const fallback = f.k === 'b' ? '.bin' : '.md';
  return `${baseOf(path)} (deleted by ${who} ${when})${ext === '' ? fallback : ext}`;
}

function summaryOf(batch: Deletable[]): BulkSummary {
  const deletedBy: string[] = [];
  let bytes = 0;
  for (const item of batch) {
    const name = item.f.xb;
    if (name !== undefined && !deletedBy.includes(name)) deletedBy.push(name);
    // The tree's own claim about how big the file is. It is already here, so the
    // byte total costs no `stat` and no read — which is what makes it affordable
    // to compute for every batch, tripped or not.
    bytes += parseBlobRef(item.f.b)?.bytes ?? 0;
  }
  return {
    count: batch.length,
    bytes,
    deletedBy,
    samplePaths: batch.slice(0, SAMPLE_PATHS).map((item) => item.path),
  };
}

function pushOnce(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

// ============================================================ Deletions

export class Deletions {
  private readonly deps: DeletionsDeps;

  /**
   * The open dialog, if any. §5.4: a batch arriving while one is open coalesces
   * into the pending decision instead of stacking a second window on top of it.
   */
  private pending: Promise<BulkChoice> | null = null;

  constructor(deps: DeletionsDeps) {
    this.deps = deps;
  }

  /** Reconciler step 4. Never throws: per-item failures land in `ctx.failures` (I15). */
  async apply(ctx: DeletionContext): Promise<void> {
    const env = this.envOf(ctx);
    const batch = this.collectDeletable(ctx);

    if (batch.length > 0) {
      const summary = summaryOf(batch);
      // Three conditions, and the third is why a count is not enough on its own:
      // deleting one 200 MB video is at least as consequential as deleting eleven
      // notes, and the count budget waves it straight through. Bootstrap remains
      // unconditional — a batch that arrived while this device was away is
      // exactly the case a user cannot undo by hand.
      const tripped = ctx.cause === 'bootstrap'
        || this.overBudget(env, batch.length)
        || summary.bytes > REMOTE_DELETE_BYTES_ALERT;
      const choice = tripped ? await this.askOnce(summary) : 'apply';

      if (choice === 'apply') {
        for (const item of batch) {
          await ctx.guarded(`delete:${item.id}`, () => this.applyOne(ctx, env, item));
        }
      } else {
        this.declineAll(env, batch);
      }
    }

    // CF-7: the rate window, the declined sets and every unbind above are only
    // containment if they are on disk. The reconciler's `finally` flushes too;
    // this makes the module correct on its own.
    await this.persist(env);
  }

  /**
   * Spec §5.3. Every filter here is an invariant, not a heuristic:
   *
   *  - a dead FOLDER is not ours — the reconciler's step 5 sweeps those, and only
   *    when `listDir` proves them genuinely empty;
   *  - an untracked path was never written by this device (I2, I12);
   *  - a path that is not on disk is already gone: unbind and no-op, which is
   *    what makes a replayed pass free (test 39);
   *  - a path a LIVE node claims, or that another node is bound to, belongs to
   *    that node — a tombstone never removes a file by path alone (I12);
   *  - a node the user already declined stays declined, forever (§5.4).
   *
   * Public because it is the whole verdict: a test that cannot see the batch can
   * only assert on what happened afterwards.
   */
  collectDeletable(ctx: DeletionContext): Deletable[] {
    const env = this.envOf(ctx);
    const declined = new Set(env.state.data.declinedNodes);

    // fold(literal) -> every node bound there. A list rather than one id: two
    // nodes can be bound to the same path mid-pass (a move that has not happened
    // yet), and which of them "wins" a last-write-wins map is iteration order,
    // which must never decide whether a file is deleted.
    const boundAtFold = new Map<string, string[]>();
    for (const [id, literal] of ctx.have) {
      const key = fold(literal);
      const list = boundAtFold.get(key);
      if (list === undefined) boundAtFold.set(key, [id]);
      else list.push(id);
    }

    const out: Deletable[] = [];
    for (const id of [...ctx.deadNodes.keys()].sort(cmp)) {
      const f = ctx.deadNodes.get(id)!;
      if (f.k === 'd') continue;                              // step 5's, not ours

      const recorded = env.state.data.materialized[id];
      if (recorded === undefined) continue;                   // untracked (I2, I12)
      if (!ctx.disk.hasFold(recorded)) {
        ctx.unbind(id);                                       // already gone: idempotent
        continue;
      }
      const key = fold(recorded);
      if (ctx.wantAtFold.has(key)) continue;                  // a live node claims it (I12)
      const holders = boundAtFold.get(key);
      if (holders !== undefined && holders.some((held) => held !== id)) continue;   // I12
      if (declined.has(id)) continue;

      const literal = ctx.disk.literal(recorded)!;
      // A file node whose recorded path now holds a FOLDER is an ambiguity, and
      // an ambiguity is never a deletion (I2).
      if (ctx.disk.kindOf(literal) !== 'f') continue;
      if (!assertInsideShare(env.shareRoot, literal)) continue;                     // I10

      out.push({ id, path: literal, f });
    }
    return out;
  }

  /**
   * Spec §5.4 with carry-forwards CF-5 and CF-6 applied.
   *
   * CF-6: the gate is `+ n > BUDGET`, not `>= BUDGET`. A 47-file batch arriving on
   * an empty budget is not "exhausted" by the latter and would apply in full —
   * which is the shape of both catastrophic obsidian-livesync incidents.
   *
   * CF-5: the window is pruned with the pass's injected clock. Pruning against a
   * caller-supplied timestamp (an event mtime, a batch stamp, an NTP correction)
   * empties the persisted budget for good and disarms the breaker permanently.
   */
  private overBudget(env: Env, n: number): boolean {
    return env.state.deletionsInWindow(env.now()) + n > REMOTE_DELETE_BUDGET;
  }

  /**
   * Spec §5.3. The verdict is recomputed in the same tick as the act, because the
   * gap between "this is safe to remove" and "remove it" is a window in which the
   * user can open the note — and trashing a note somebody is typing in is the
   * failure this whole module exists to prevent.
   */
  private async applyOne(ctx: DeletionContext, env: Env, item: Deletable): Promise<void> {
    const { id, path, f } = item;

    // I7, and the ordering matters: the CM6 binding is dropped BEFORE the file's
    // bytes are read or moved, never after.
    const openNodeId = this.deps.openNodeId;
    const closeSession = this.deps.closeSession;
    if (openNodeId !== undefined && closeSession !== undefined && openNodeId() === id) {
      await closeSession(id);
    }

    const openAtVerdict = env.vault.isOpenInLeaf(path);
    const proven = !openAtVerdict && await this.isProven(env, item);
    // The re-check. `isProven` awaited a read and a hash; the leaf may have been
    // bound in between (Group B test 36).
    const openNow = env.vault.isOpenInLeaf(path);

    if (openAtVerdict || openNow || !proven) {
      await this.rescue(ctx, env, item);
    } else {
      await this.trash(ctx, env, item);
    }

    // Reached only when the move or the removal returned. A failed item is still
    // on disk and still bound, so the next pass retries it (I15, I17).
    ctx.removedThisPass.add(fold(path));                      // I13
    env.state.recordDeletion(env.now());                      // §5.4
  }

  /**
   * `proven`, split by kind — and the split is the whole of §5.1.
   *
   * The two rules answer the same question ("are these bytes recoverable from the
   * workspace?") from different evidence, and a note read through the binary rule
   * or an attachment read through the markdown one is not a near miss: markdown's
   * `read` decodes a PNG to lossy UTF-8, so its hash could never match and every
   * remote attachment delete would rescue — 200 MB at a time, into a folder
   * nobody prunes.
   */
  private async isProven(env: Env, item: Deletable): Promise<boolean> {
    return item.f.k === 'b'
      ? await this.isProvenBlob(env, item)
      : await this.isProvenNote(env, item);
  }

  /**
   * `proven` for markdown — spec §5.3. All three clauses are necessary and none is
   * sufficient: `s` says the creator published SOMETHING, the recorded hash says
   * this device confirmed WHAT, and the comparison says the disk still holds it.
   */
  private async isProvenNote(env: Env, item: Deletable): Promise<boolean> {
    if (item.f.s !== 1) return false;
    const known = env.state.data.contentHash[item.id];
    if (known === undefined) return false;
    const local = normLF(await env.vault.read(item.path));
    return known.sha256 === await hashOf(local);
  }

  /**
   * `proven` for an attachment — spec §5.1, and STRONGER than the markdown rule
   * rather than weaker.
   *
   * Markdown can only ask a device-local memory what the shared bytes were. A
   * binary's authoritative digest is in the TREE, where every peer can see it, and
   * the store can be asked whether it still holds those exact bytes — so `H ===
   * ref.sha256` compares against the workspace's own digest, and `has` is positive
   * evidence that the bytes are retrievable NOW rather than that we once saw them.
   *
   * Both failure directions keep the user's file, and they are different failures:
   * `has` THROWS on transport, which leaves through `guarded` with nothing
   * removed and nothing decided; a definite `false` means this copy may be the
   * only copy, which is a rescue. Anything above either ceiling is a rescue too —
   * "defaults to rescue on ignorance", unchanged.
   */
  private async isProvenBlob(env: Env, item: Deletable): Promise<boolean> {
    // A deletable is a DEAD node, and the pass's reference map holds LIVE ones,
    // so a node in both is the two halves of one derivation disagreeing about
    // whether this file should exist. An ambiguity is never a deletion (I2).
    if (env.blobRefs.has(item.id)) return false;

    const ref = parseBlobRef(item.f.b);
    if (item.f.s !== 1 || ref === null) return false;    // never published => never proven
    const blobs = env.blobs;
    if (blobs === null) return false;                    // no store to ask (I2)

    const st = await env.vault.stat(item.path);
    if (st === null) return false;                       // I2

    // The SAME two-clause staleness oracle step 2.5 uses, and for the same reason:
    // size alone misses every same-size edit, and without the mtime clause a
    // recorded hash is trusted for ever — so an edit made while Obsidian was
    // closed would be invisible at exactly the moment it decides a deletion. A
    // base with no mtime at all confirmed a hash but never confirmed WHEN.
    const known = env.state.data.contentHash[item.id];
    const fresh = known !== undefined
      && known.mtime !== undefined
      && known.mtime === st.mtime
      && known.len === st.bytes;

    let H: string;
    if (fresh) {
      H = known!.sha256;                                 // cheap, and size+mtime gated
    } else {
      if (st.bytes > PROVE_HASH_MAX_BYTES) return false; // too costly to prove => rescue
      if (st.bytes > this.deps.memoryCapBytes()) return false; // cannot hash it at all => rescue
      H = await hashOfBytes(await env.vault.readBinary(item.path));
    }

    if (H !== ref.sha256) return false;                  // some other version => rescue

    // A LIVE probe, never a cached answer: the cache says what this device saw,
    // and the question is what the workspace can still hand back.
    return (await blobs.has(H)).present;
  }


  /**
   * Move the file out of the share instead of removing it, and remember that the
   * user is keeping it so no later pass revisits the decision.
   *
   * A rename rather than a copy: Obsidian keeps the same TFile, so an open leaf
   * follows the file rather than going blank, and the bytes never exist only in
   * memory.
   */
  private async rescue(ctx: DeletionContext, env: Env, item: Deletable): Promise<void> {
    const { id, path, f } = item;
    const dest = await this.uniquify(env, `${RECOVERED_DIR}/${rescueName(path, f, env.now())}`);
    // I10: the reserved folder is outside the share, so containment is checked
    // against it explicitly rather than assumed from the name.
    if (!assertInsideShare(env.shareRoot, dest, true)) {
      throw new Error(`rescue: destination is not inside a reserved folder: ${dest}`);
    }

    await this.ensureRecoveredDir(env);
    env.tickets.arm('rename', path, dest);
    await env.vault.rename(path, dest);

    // `ShadowLink Recovered/` is outside the share, so the file leaves the
    // share-scoped index entirely. Recording the destination in it instead would
    // hand the rescued copy straight back to the publisher as untracked markdown.
    ctx.disk.remove(path);
    ctx.unbind(id);
    pushOnce(env.state.data.declinedNodes, id);
    pushOnce(env.state.data.declinedPaths, fold(path));       // I13
    env.notice(
      `"${baseOf(path)}" was deleted by ${displayName(f)}. Your copy is in ${RECOVERED_DIR}/.`,
      RESCUE_NOTICE_MS,
    );
  }

  /** The only removal path: the vault-local `.trash` (I1). */
  private async trash(ctx: DeletionContext, env: Env, item: Deletable): Promise<void> {
    const { id, path, f } = item;
    env.tickets.arm('delete', path);
    await env.vault.trashLocal(path);
    ctx.disk.remove(path);
    ctx.unbind(id);
    env.notice(
      `"${baseOf(path)}" deleted by ${displayName(f)}. `
      + 'Recover from Settings → Files → Deleted files.',
      TRASH_NOTICE_MS,
    );
  }

  /**
   * §5.4's "keep my copies", also reached by a missing dialog and by a rejected
   * one. Nothing on disk changes; the decision is recorded by node id AND by
   * folded path, so a lost binding cannot re-share the file later (I13).
   */
  private declineAll(env: Env, batch: Deletable[]): void {
    for (const item of batch) {
      pushOnce(env.state.data.declinedNodes, item.id);
      pushOnce(env.state.data.declinedPaths, fold(item.path));
    }
    env.notice(
      `Kept your local ${batch.length === 1 ? 'copy' : `copies of ${batch.length} files`}. `
      + 'They are no longer shared.',
      RESCUE_NOTICE_MS,
    );
  }

  /**
   * One dialog per decision, serialized. A second batch arriving while the first
   * is open coalesces into it rather than stacking a window the user cannot
   * answer meaningfully.
   *
   * Every path that is not an explicit 'apply' is a decline: no callback, a
   * rejected promise, and an unrecognized answer all mean keep. Silence is never
   * consent to remove somebody's files.
   */
  private async askOnce(summary: BulkSummary): Promise<BulkChoice> {
    const inflight = this.pending;
    if (inflight !== null) return inflight;

    const ask = this.deps.confirmBulk;
    if (ask === undefined) return 'keep';

    const decision = (async (): Promise<BulkChoice> => {
      try {
        return await ask(summary) === 'apply' ? 'apply' : 'keep';
      } catch {
        return 'keep';
      }
    })();

    this.pending = decision;
    try {
      return await decision;
    } finally {
      this.pending = null;
    }
  }

  // ---------------------------------------------------------- small helpers

  private envOf(ctx: DeletionContext): Env {
    const shareRoot = ctx.shareRoot ?? this.deps.shareRoot;
    return {
      vault: ctx.vault ?? this.deps.vault,
      blobs: ctx.blobs ?? this.deps.blobs ?? null,
      blobRefs: ctx.blobRefs ?? EMPTY_REFS,
      state: ctx.state ?? this.deps.state,
      tickets: ctx.tickets ?? this.deps.tickets,
      shareRoot: shareRoot.replace(/\/+$/, ''),
      now: ctx.now ?? this.deps.now ?? (() => Date.now()),
      notice: this.deps.notice ?? ((msg: string) => { ctx.notice(msg); }),
    };
  }

  private async persist(env: Env): Promise<void> {
    try {
      await env.state.flush();
    } catch (err) {
      env.state.lastPersistError = err;
    }
  }

  /**
   * Adapter-level existence, and an unreadable answer is not evidence of absence
   * (I2). The error PROPAGATES: `rescue` runs inside `guarded`, so it becomes one
   * contained failure with the file still on disk and still bound, and the next
   * pass retries it once the adapter can answer again (I15, I17).
   *
   * Swallowing it to `false` would be a guess, and both callers guess in the same
   * direction — the one that lets the rename proceed. `uniquify` would report an
   * occupied destination as free and hand `vault.rename` a path that already
   * holds an EARLIER rescue; the adapter's `rename`, unlike its `create` /
   * `createBinary` / `createFolder` siblings, performs no occupancy check, so one
   * rescued file would land on top of another inside the single folder whose
   * whole purpose is that nothing in it is ever lost. `ensureRecoveredDir` would
   * invent a folder it could not see.
   *
   * Guessing "occupied" instead is no better: `uniquify` would probe 998 further
   * candidates that throw just as hard and end in a misleading "could not find a
   * free name", and `ensureRecoveredDir` would skip a creation that may be needed.
   * Propagation is also what this module already does with every other unreadable
   * answer — `vault.stat` rejects rather than reporting null, and `blobs.has`
   * throws rather than reporting absent.
   */
  private async exists(env: Env, path: string): Promise<boolean> {
    return await env.vault.exists(path);
  }

  private async ensureRecoveredDir(env: Env): Promise<void> {
    if (await this.exists(env, RECOVERED_DIR)) return;
    env.tickets.arm('create', RECOVERED_DIR);
    await env.vault.createFolder(RECOVERED_DIR);
  }

  private async uniquify(env: Env, candidate: string): Promise<string> {
    if (!(await this.exists(env, candidate))) return candidate;
    const ext = extOf(candidate);
    const stem = ext === '' ? candidate : candidate.slice(0, candidate.length - ext.length);
    for (let n = 2; n < 1000; n++) {
      const next = `${stem} (${n})${ext}`;
      if (!(await this.exists(env, next))) return next;
    }
    throw new Error(`could not find a free name for ${candidate}`);
  }
}
