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

import type { NodeFields } from './types.ts';
import { fold, isLive, relPath, suffixedVaultPath, validateRel } from './paths.ts';

export interface DerivedTree {
  /** nodeId -> share-relative path, for LIVE, VALID, SEEDED file nodes only. */
  files: Map<string, string>;
  /** share-relative paths of every live valid directory node, plus every ancestor implied by a file. */
  folders: Set<string>;
  /** fold(path) -> nodeId for files, or DIR_SENTINEL for a folder path. */
  wantAtFold: Map<string, string>;
  /** fold(path) of nodes that are dead (tombstoned and not escaped). */
  deadFold: Set<string>;
  /** dead directory paths, for the empty-folder sweep. */
  deadFolders: Set<string>;
  /** live valid file nodes whose content has never been published (s unset) — never materialized (I6). */
  pending: string[];
  /** node ids rejected by validateRel — skipped entirely, never deleted (I10). */
  invalid: string[];
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
  const derivedPath = suffixedVaultPath(valid);

  for (const [id, f] of valid) {
    if (!isLive(f)) {
      // Dead nodes get no derived path; their last known path is the plain one.
      const rel = relPath(f);
      deadFold.add(fold(rel));
      if (f.k === 'd') deadFolders.add(rel);
      continue;
    }

    const path = derivedPath.get(id);
    if (path === undefined) continue;   // unreachable: every live node is assigned one

    // Directories are never suffixed: two live dir nodes at one path are one
    // directory, so duplicates deduplicate here for free (spec §1.4).
    if (f.k === 'd') { folders.add(path); continue; }

    // I6: an unpublished node is never materialized by anyone, so it reserves
    // nothing — not the path, and not the folders that path would have needed.
    if (!f.s) { pending.push(id); continue; }

    files.set(id, path);
    wantAtFold.set(fold(path), id);
    for (const anc of ancestorsOf(path)) folders.add(anc);
  }

  // Folders claim their path last: a directory outranks a file at the same
  // folded path, matching suffixedVaultPath's ranking.
  for (const p of folders) wantAtFold.set(fold(p), DIR_SENTINEL);

  pending.sort(compareIds);
  invalid.sort(compareIds);

  return { files, folders, wantAtFold, deadFold, deadFolders, pending, invalid };
}
