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

/**
 * File or directory. This is a DISK kind, and since P2 it is NO LONGER
 * structurally identical to `NodeKind`, which gained `'b'`: a binary attachment
 * is an ordinary file on disk. Conflating the two vocabularies is the single most
 * likely source of bugs in P2, so the conversion happens in exactly one place —
 * `nodeKindOf` in `src/tree/paths.ts`.
 */
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

  /**
   * `vault.readBinary`. Rejects for an absent path or a directory, exactly like
   * `read`.
   *
   * `Uint8Array`, not `ArrayBuffer`: it carries its own offset and length, so a
   * subarray can never silently become a whole-buffer copy, and it is what both
   * Web Crypto and the port fakes want. `ObsidianVaultPort` converts exactly once,
   * at the boundary.
   */
  readBinary(path: string): Promise<Uint8Array>;

  /** `vault.create`. Rejects if the path is already occupied — never blind-overwrites. */
  create(path: string, data: string): Promise<void>;

  /**
   * `vault.createBinary`. Rejects if the path is occupied — never blind-overwrites,
   * exactly like `create`, and through the same folded occupancy check (I11).
   *
   * There is deliberately NO in-place binary write (`modifyBinary`,
   * `adapter.writeBinary`): an interrupted overwrite leaves a corrupt file at the
   * canonical path with no way to detect it. Every byte replacement goes through
   * the staging journal instead — the previous bytes are renamed into staging
   * BEFORE the new ones exist, so a crash leaves a visible file and a journal line
   * rather than a hole.
   */
  createBinary(path: string, data: Uint8Array): Promise<void>;

  /**
   * `adapter.stat`. RESOLVES NULL only for a definite not-found; REJECTS when the
   * lookup itself failed.
   *
   * That distinction is invariant I2: "it is not there" is an answer, "I could not
   * look" is not, and the two must not collapse into one value — the first is what
   * the reconciler acts on, and the second must be a no-op.
   *
   * `mtime` is what makes the cheap staleness test possible: a pass over a share
   * with 2,000 attachments decides "is my copy current?" with one `stat` each and
   * a full hash only when size and mtime disagree with the recorded base.
   */
  stat(path: string): Promise<{ kind: Kind; bytes: number; mtime: number } | null>;

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
   * Implemented with Obsidian's trash call and the system flag set to FALSE: the
   * vault-local `.trash`, recoverable from inside Obsidian on every platform
   * including mobile.
   *
   * Hard deletion and the system-trash variant (that same call with the flag set
   * to true) are banned outright by invariant I1 and are guarded by a test that
   * greps `src/`. Both are spelled out only in that test, never in shipped source
   * — including in a comment like this one, which would otherwise trip the guard.
   */
  trashLocal(path: string): Promise<void>;

  /** True when the path is currently bound in an editor leaf (invariant I7). */
  isOpenInLeaf(path: string): boolean;
}
