// src/sync/VaultPort.ts
// The reconciler's only door to the filesystem (spec §4.0).
//
// This interface exists so that every reconciler test in Group B can run headless
// against an in-memory fake. Nothing in this file may import `obsidian`: the
// Obsidian-backed implementation lands in a later slice and lives behind exactly
// this surface.
//
// Two visibility levels are deliberately mixed and must not be conflated:
//  - `list()` mirrors `vault.getAllLoadedFiles()`, the in-memory index. It is
//    share-filtered and, like Obsidian's index, does NOT contain dot paths.
//  - `exists()` / `listDir()` are adapter-level and DO see dot paths. Spec test 39
//    (a tombstoned folder whose only surviving child is `.git`) turns on that gap.

/** File or directory. Structurally identical to `NodeKind` in the tree model. */
export type Kind = 'f' | 'd';

/** One entry of the vault's in-memory file index. */
export interface VaultEntry {
  path: string;
  kind: Kind;
}

export interface VaultPort {
  /** Share-filtered snapshot of the vault's in-memory index. Never sees dot paths. */
  list(): Array<{ path: string; kind: Kind }>;

  /** Adapter-level existence check. Sees dotfiles. Case-folded on folding filesystems. */
  exists(path: string): Promise<boolean>;

  /**
   * Adapter-level listing of a directory's DIRECT children. Sees dotfiles.
   * Rejects for a path that is absent or is a file — invariant I2 forbids letting
   * "I could not look" read as "it is empty", which the folder sweep would treat
   * as permission to remove.
   */
  listDir(path: string): Promise<string[]>;

  /** `vault.cachedRead`. Rejects for an absent path or a directory. */
  read(path: string): Promise<string>;

  /** `vault.create`. Rejects if the path is already occupied — never blind-overwrites. */
  create(path: string, data: string): Promise<void>;

  /** `vault.createFolder`. Does NOT create intermediates; `ensureDirs` walks segments itself. */
  createFolder(path: string): Promise<void>;

  /**
   * `vault.rename` — never `fileManager.renameFile` (invariant I16). Backlink
   * rewriting must happen exactly once, on the machine where the human renamed;
   * if every peer rewrote too, the same edit would be inserted N times into one
   * shared Y.Text.
   */
  rename(from: string, to: string): Promise<void>;

  /**
   * `vault.trash(file, false)` — the vault-local `.trash`, recoverable from inside
   * Obsidian on every platform including mobile. `vault.delete` and
   * `vault.trash(file, true)` are banned outright by invariant I1.
   */
  trashLocal(path: string): Promise<void>;

  /** True when the path is currently bound in an editor leaf (invariant I7). */
  isOpenInLeaf(path: string): boolean;
}
