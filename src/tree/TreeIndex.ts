// src/tree/TreeIndex.ts
// The desired state one reconcile pass needs, projected from a tree snapshot
// (spec §4.3, the "desired state" block).
//
// This is a PURE, WHOLESALE derivation. Spec risk R12 forbids patching it
// incrementally from Yjs deltas: collision suffixes and cascade escapes depend
// on the whole live set, so a per-event patch would drift from what a rebuild
// computes, and nothing would ever notice. Always recompute.
//
// Every path here is SHARE-RELATIVE. Prefixing shareRoot is the reconciler's
// job (spec §4.4 `vaultPathOf`), so this module never needs to know it.

import type { NodeFields, NodeKind } from './types.ts';
import {
  fold, isLive, isPublished, parseBlobRef, relPath, splitRel, suffixedVaultPath, validateRel,
  type BlobRef,
} from './paths.ts';

export interface DerivedTree {
  /**
   * nodeId -> share-relative path, for LIVE, VALID, PUBLISHED content nodes —
   * notes and attachments alike. "Published" is `isPublished`, one predicate for
   * both kinds.
   */
  files: Map<string, string>;
  /** share-relative paths of every live valid directory node, plus every ancestor implied by a file. */
  folders: Set<string>;
  /** fold(path) -> nodeId for files, or DIR_SENTINEL for a folder path. */
  wantAtFold: Map<string, string>;
  /** fold(path) of nodes that are dead (tombstoned and not escaped). */
  deadFold: Set<string>;
  /** dead directory paths, for the empty-folder sweep. */
  deadFolders: Set<string>;
  /**
   * live valid content nodes that are not published — never materialized (I6).
   *
   * A note is here while `s` is unset. An attachment is here while `s` is unset OR
   * its `b` does not parse: such a node is NOT invalid, because its path is
   * perfectly good; it simply names no bytes anybody could fetch, so it is
   * diagnosed here, never materialized and never deleted.
   */
  pending: string[];
  /** node ids rejected by validateRel — skipped entirely, never deleted (I10). */
  invalid: string[];

  // ------------------------------------------------- watcher-facing (spec §4.1)
  //
  // The three lookups a LOCAL vault event needs. They are part of this derivation
  // rather than a parallel index because two views of one tree drift apart in
  // exactly the way spec risk R12 describes, and nothing ever notices.

  /**
   * fold(relPath) -> nodeId, for every LIVE VALID node, files AND dirs, keyed on
   * the STORED path (`d` + '/' + `n`) rather than the collision-suffixed one.
   *
   * Unseeded files are in here. I6 governs materialization, not identity: the node
   * exists, so a local create at its path must bind to it, never fork it.
   * Collisions resolve to the lowest nodeId, deterministically.
   */
  liveByFoldRel: Map<string, string>;

  /**
   * fold(relPath) -> the most recently deleted node at that path, for the bounded
   * resurrect of §5.6. Greatest `xa` wins; a tie breaks on the lowest nodeId, so
   * the answer never depends on iteration order.
   *
   * `k` travels with the entry so a resurrect can refuse to cross kinds: a `.png`
   * recreated where a note died is a different file that merely shares a name.
   */
  deadByFoldRel: Map<string, { nodeId: string; k: NodeKind; xa?: number; xh?: string }>;

  /**
   * nodeId -> share-relative path WITH collision suffixes applied, for every LIVE
   * VALID node. This is the idempotence oracle (I8): a handler compares it to what
   * it just observed on disk and writes nothing when the two already agree.
   */
  derivedPath: Map<string, string>;

  /**
   * nodeId -> the parsed `b` of every LIVE, VALID, PUBLISHED `'b'` node.
   *
   * Parsed once here so the reconciler never re-parses per pass, and so "which
   * bytes belong at this path" has exactly one answer per derivation. A node
   * missing from this map is one nothing may fetch bytes for.
   */
  blobs: Map<string, BlobRef>;
}

/**
 * Occupancy marker for a folder in `wantAtFold`. Contains characters a nodeId
 * cannot (nodeIds are exactly 22 chars of [A-Za-z0-9]), so it can never be
 * mistaken for one.
 */
export const DIR_SENTINEL = '__dir__';

/** `x/y/z.md` -> `['x', 'x/y']`. Every directory a path needs to already exist. */
function ancestorsOf(rel: string): string[] {
  const parts = rel.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every directory path the reconciler will actually put on disk for this tree,
 * share-relative and fold-deduplicated (CF-4).
 *
 * Only ANCESTORS are collected. A dir node's own path is already reserved by
 * `suffixedVaultPath`; its ancestors are not, and `ensureDirs` creates them all
 * the same by walking from the share root down (CF-2 keeps them out of
 * `folders`, which is a different question — what to create, not what to
 * reserve).
 *
 * Unpublished and dead nodes contribute nothing: I6 says an unpublished node
 * reserves neither its path nor the folders that path would have needed, and a
 * dead node's folder is one nobody will create. Either would otherwise push a
 * perfectly materializable file off the path it is entitled to.
 *
 * The published test here MUST be the same predicate the main loop uses. If the
 * two disagree — say this one accepts an attachment whose `b` does not parse — the
 * folder that node implies is reserved for a directory `folders` never contains,
 * and the file that wanted the name is suffixed off it for ever. That is the CF-4
 * bug class, and it was paid for once already in P1.
 *
 * Computed from the STORED path rather than the derived one, which is exact
 * rather than approximate: `suffixedVaultPath` splits the directory off before
 * suffixing, so a collision suffix only ever changes a basename. That is also
 * what keeps this non-circular — the folder set does not depend on the file
 * paths it is about to constrain.
 */
function impliedDirPaths(valid: Array<[string, NodeFields]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const [, f] of valid) {
    if (!isLive(f)) continue;
    if (f.k !== 'd' && !isPublished(f)) continue;
    for (const anc of ancestorsOf(relPath(f))) {
      const key = fold(anc);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(anc);
    }
  }
  return out;
}

/** Deletion recency, total and order-independent: later `xa` first, then lowest nodeId. */
function wins(xa: number | undefined, id: string, bestXa: number | undefined, bestId: string): boolean {
  const a = xa ?? Number.NEGATIVE_INFINITY;
  const b = bestXa ?? Number.NEGATIVE_INFINITY;
  if (a !== b) return a > b;
  return compareIds(id, bestId) < 0;
}

/**
 * Pure. The same snapshot yields a deeply-equal result whatever order the
 * entries arrive in — `pending` and `invalid` are sorted for that reason, and
 * everything else is a Map or Set keyed by content.
 */
export function deriveTree(entries: Array<[string, NodeFields]>): DerivedTree {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const wantAtFold = new Map<string, string>();
  const deadFold = new Set<string>();
  const deadFolders = new Set<string>();
  const pending: string[] = [];
  const invalid: string[] = [];
  const liveByFoldRel = new Map<string, string>();
  const deadByFoldRel = new Map<string, { nodeId: string; k: NodeKind; xa?: number; xh?: string }>();
  const blobs = new Map<string, BlobRef>();

  // Validity gate FIRST (I10). An invalid node is skipped entirely — never
  // materialized, never renamed to, never counted as occupying a path, and
  // above all never deleted. It must not even contribute a tombstoned path,
  // which is why this runs before the liveness test.
  const valid: Array<[string, NodeFields]> = [];
  for (const [id, f] of entries) {
    if (!validateRel(f.d, f.n, f.k)) { invalid.push(id); continue; }
    valid.push([id, f]);
  }

  // Collision resolution runs over the whole LIVE VALID set, unseeded files
  // included. An unseeded node holds its slot, so the disk path of a file that
  // IS materialized does not shift the day its unpublished sibling seeds.
  //
  // CF-4: the set is extended with a stand-in dir node for every folder the tree
  // merely IMPLIES. `suffixedVaultPath` reserves paths for explicit dir nodes
  // only, so without these a file node named `Notes.md` and a folder `Notes.md`
  // implied by some other node's `d` both claimed the same path — `files` said
  // the file owned it, `wantAtFold` said the folder did, and the reconciler's
  // `adopt` refused the folder as "not a file" on every pass, for ever. The
  // folder wins: it is a container other nodes live inside, so suffixing it would
  // orphan them, while suffixing the file costs nothing. Feeding the reservation
  // into the resolver rather than patching the reconciler is what makes `files`
  // and `wantAtFold` incapable of disagreeing in the first place.
  //
  // The stand-ins are discarded immediately afterwards; their ids are impossible
  // for a real node (a nodeId is exactly 22 characters of [A-Za-z0-9]), and they
  // change nothing else, because `suffixedVaultPath` never suffixes a directory
  // and orders files among themselves by id.
  const standIns: Array<[string, NodeFields]> = [];
  const implied = impliedDirPaths(valid);
  for (let i = 0; i < implied.length; i++) {
    const { d, n } = splitRel(implied[i]);
    standIns.push([`_implied-dir-${i}`, { k: 'd', d, n, g: 1, c: 0 }]);
  }
  const derivedPath = suffixedVaultPath(standIns.length === 0 ? valid : [...valid, ...standIns]);
  for (const [id] of standIns) derivedPath.delete(id);

  for (const [id, f] of valid) {
    if (!isLive(f)) {
      // Dead nodes get no derived path; their last known path is the plain one.
      const rel = relPath(f);
      const key = fold(rel);
      deadFold.add(key);
      if (f.k === 'd') deadFolders.add(rel);
      // §5.6 needs ONE candidate per path, and which one must not depend on the
      // order Yjs happens to hand the nodes back. A missing `xa` sorts below every
      // real timestamp: such a node can never pass the resurrect window anyway.
      const previous = deadByFoldRel.get(key);
      if (previous === undefined || wins(f.xa, id, previous.xa, previous.nodeId)) {
        deadByFoldRel.set(key, { nodeId: id, k: f.k, xa: f.xa, xh: f.xh });
      }
      continue;
    }

    // Keyed on the STORED path, before any collision suffix, and populated for
    // dirs and unseeded files too — this map answers "does the tree already have
    // a node here?", which is a question about identity, not about materialization.
    const relKey = fold(relPath(f));
    const claimed = liveByFoldRel.get(relKey);
    if (claimed === undefined || compareIds(id, claimed) < 0) liveByFoldRel.set(relKey, id);

    const path = derivedPath.get(id);
    if (path === undefined) continue;   // unreachable: every live node is assigned one

    // Directories are never suffixed: two live dir nodes at one path are one
    // directory, so duplicates deduplicate here for free (spec §1.4).
    if (f.k === 'd') { folders.add(path); continue; }

    // I6: an unpublished node is never materialized by anyone, so it reserves
    // nothing — not the path, and not the folders that path would have needed.
    // `isPublished` is the same predicate `impliedDirPaths` uses above; the two
    // gates are one rule, and splitting them is the CF-4 bug class.
    if (!isPublished(f)) { pending.push(id); continue; }

    if (f.k === 'b') {
      // Non-null by construction — `isPublished` just proved this parses — but the
      // narrowing is done honestly rather than asserted away.
      const ref = parseBlobRef(f.b);
      if (ref !== null) blobs.set(id, ref);
    }

    files.set(id, path);
    wantAtFold.set(fold(path), id);
    for (const anc of ancestorsOf(path)) folders.add(anc);
  }

  // Folders claim their path last: a directory outranks a file at the same
  // folded path, matching suffixedVaultPath's ranking.
  for (const p of folders) wantAtFold.set(fold(p), DIR_SENTINEL);

  pending.sort(compareIds);
  invalid.sort(compareIds);

  return {
    files, folders, wantAtFold, deadFold, deadFolders, pending, invalid,
    liveByFoldRel, deadByFoldRel, derivedPath, blobs,
  };
}
