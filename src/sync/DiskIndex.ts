// src/sync/DiskIndex.ts
// The folded view of what is actually on disk (spec §4.3, invariant I11).
//
// `vault.getAbstractFileByPath` is a case-SENSITIVE map lookup. macOS (APFS/HFS+)
// and Windows (NTFS) are not. Ask that lookup about `Notes/README.md` when the
// disk holds `notes/readme.md` and it reports "free" — and the reconciler's next
// `vault.create` truncates the neighbour it never saw. Invariant I11 forbids any
// existence or occupancy check in the reconciler from going straight to the
// vault for exactly that reason: every one of them goes through this index
// instead, built once per pass and kept in step with the mutations the pass
// performs, so the pass never re-lists mid-pass.
//
// CF-9 (carry-forward from P1b-1): `VaultPort.list()` documents itself as
// share-filtered, but `FakeVault.list()` — which every reconciler test runs
// against — deliberately is NOT. Filtering here is therefore not cosmetic; it is
// the only thing standing between this index and leaking the rest of the vault.
//
// Folding (`fold` from ../tree/paths.ts) is for COMPARISON only. `literal()` is
// the only path this index ever hands back that is safe to pass to
// `vault.create` / `vault.rename` — painting a folded path over a real filename
// is exactly the bug I11 exists to prevent.
//
// No `obsidian` import, no node builtins.

import { fold } from '../tree/paths.ts';
import type { Kind, VaultPort } from './VaultPort.ts';

/** One entry as seen on disk: its real (literal) casing and kind. */
export interface DiskEntry {
  path: string;
  kind: Kind;
}

/**
 * True when `pathFold` is `rootFold` itself or lies beneath it. The classic
 * prefix trap: `SharedNotes/x.md` is NOT inside `Shared` — a bare
 * `startsWith(rootFold)` would fold it in, so the '/' boundary is load-bearing.
 */
function isUnderShareFold(pathFold: string, rootFold: string): boolean {
  return pathFold === rootFold || pathFold.startsWith(`${rootFold}/`);
}

export class DiskIndex {
  /** fold(literal path) -> the entry, literal casing included. */
  private readonly byFold = new Map<string, DiskEntry>();

  private constructor() {}

  /**
   * Build from `VaultPort.list()`, keeping only entries at or under `shareRoot`.
   * CF-9: that filter is applied HERE, unconditionally — never assume the port
   * already did it.
   */
  static build(vault: VaultPort, shareRoot: string): DiskIndex {
    const index = new DiskIndex();
    const rootFold = fold(shareRoot);
    for (const entry of vault.list()) {
      const pathFold = fold(entry.path);
      if (!isUnderShareFold(pathFold, rootFold)) continue;
      index.byFold.set(pathFold, { path: entry.path, kind: entry.kind });
    }
    return index;
  }

  hasFold(path: string): boolean {
    return this.byFold.has(fold(path));
  }

  /** The real on-disk casing for a folded path, or undefined. Never fold() this. */
  literal(path: string): string | undefined {
    return this.byFold.get(fold(path))?.path;
  }

  kindOf(path: string): Kind | undefined {
    return this.byFold.get(fold(path))?.kind;
  }

  /** Every file (kind 'f') under the share, literal paths, sorted for determinism. */
  filesUnderShare(): string[] {
    const out: string[] = [];
    for (const entry of this.byFold.values()) {
      if (entry.kind === 'f') out.push(entry.path);
    }
    return out.sort();
  }

  size(): number {
    return this.byFold.size;
  }

  /** Record a fresh entry the pass just created. `path` MUST be the literal casing written to disk. */
  add(path: string, kind: Kind): void {
    this.byFold.set(fold(path), { path, kind });
  }

  /**
   * Relocate `from` to `to`, carrying every descendant along when `from` is a
   * folder. A no-op when `from` is not present — callers are expected to have
   * checked `hasFold`/`kindOf` before issuing the `vault.rename` this mirrors.
   */
  move(from: string, to: string): void {
    const fromFold = fold(from);
    const entry = this.byFold.get(fromFold);
    if (entry === undefined) return;

    const descendants: DiskEntry[] = [];
    if (entry.kind === 'd') {
      const prefix = `${fromFold}/`;
      for (const [key, d] of this.byFold) {
        if (key.startsWith(prefix)) descendants.push(d);
      }
    }

    this.byFold.delete(fromFold);
    this.byFold.set(fold(to), { path: to, kind: entry.kind });

    // Descendant literal paths are rebuilt from the folder's OWN stored literal
    // casing (`entry.path`), not from the caller's `from` argument, so this is
    // correct even when the caller passed a case variant of the real path.
    const oldBaseLen = entry.path.length + 1;
    for (const d of descendants) {
      this.byFold.delete(fold(d.path));
      const rel = d.path.slice(oldBaseLen);
      const newPath = `${to}/${rel}`;
      this.byFold.set(fold(newPath), { path: newPath, kind: d.kind });
    }
  }

  /** Drop `path`, and every descendant when it is a folder. A no-op when absent. */
  remove(path: string): void {
    const pathFold = fold(path);
    const entry = this.byFold.get(pathFold);
    if (entry === undefined) return;

    this.byFold.delete(pathFold);
    if (entry.kind === 'd') {
      const prefix = `${pathFold}/`;
      for (const key of [...this.byFold.keys()]) {
        if (key.startsWith(prefix)) this.byFold.delete(key);
      }
    }
  }
}
