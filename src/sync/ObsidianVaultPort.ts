// src/sync/ObsidianVaultPort.ts
// `VaultPort` (spec §4.0) over Obsidian's real `Vault`.
//
// One of only three files in `src/sync/` allowed to import `obsidian`. Everything
// it does is dictated by `FakeVault` in `fakes.ts`: every reconciler test in Group
// B runs against that fake, so a divergence here does not fail loudly — it makes
// the whole suite pass while the real thing corrupts a vault. The departures the
// real API forces are spelled out where they happen.
//
// Three behaviours are load-bearing and are the reason this file is not a
// two-line pass-through:
//
//  I1  — removal is Obsidian's trash call with the system flag FALSE: the
//        vault-local `.trash`, restorable from inside Obsidian on every platform
//        including mobile. The hard delete and the system-trash variant are
//        banned outright and are guarded by `banned-calls.test.ts`, which greps
//        shipped source — so neither is spelled here, not even in a comment.
//  I11 — `vault.getAbstractFileByPath` is a case-SENSITIVE map lookup, and macOS
//        and Windows are not case-sensitive. Every resolution below therefore
//        falls back to a folded scan of the loaded-file index, so a case-variant
//        neighbour is found rather than silently truncated by the next `create`.
//  I16 — renames go through `vault.rename`. The other API rewrites backlinks, and
//        backlink rewriting must happen exactly once, on the machine where the
//        human performed the rename; if every peer rewrote too, the same logical
//        edit would be inserted N times into one shared `Y.Text`.
//
// The two visibility levels `VaultPort` documents are honoured literally:
// `list()` mirrors the in-memory index and never sees dot paths; `exists()` and
// `listDir()` go to the adapter and do.

import { TFolder, normalizePath } from 'obsidian';
import type { DataAdapter, FileView, TAbstractFile, TFile, Vault, Workspace } from 'obsidian';

import { fold } from '../tree/paths.ts';
import type { Kind, VaultPort } from './VaultPort.ts';

/** I18: NFC, POSIX separators, no edge slashes — applied at every ingestion point. */
function normPath(path: string): string {
  return path.normalize('NFC').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** True when any segment is a dot path — invisible to Obsidian's loaded-file index. */
function isDotPath(path: string): boolean {
  return path.split('/').some((seg) => seg.startsWith('.'));
}

/**
 * The one place a `Uint8Array` becomes the `ArrayBuffer` Obsidian's API wants.
 *
 * `data.buffer` is handed over UNCOPIED when the view spans it exactly, which is
 * the common case and the one that matters: a 100 MB attachment copied here is a
 * second 100 MB allocation at the moment the device is already holding the first.
 * A view over part of a larger buffer is sliced, because handing the whole buffer
 * over would write bytes the caller never offered.
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const spansWholeBuffer = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
  return spansWholeBuffer
    ? (data.buffer as ArrayBuffer)
    : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
}

/**
 * `TFolder` rather than `TFile`, because a `delete` event hands back an object
 * whose parent links have already been cleared but whose prototype is intact.
 */
function kindOf(file: TAbstractFile): Kind {
  return file instanceof TFolder ? 'd' : 'f';
}

export interface ObsidianVaultPortDeps {
  vault: Vault;
  workspace: Workspace;
  /**
   * Read FRESH on every `list()`: the user can move the shared folder mid-session
   * and §4.1's `shareRootGuard` follows it without a reload.
   */
  getShareRoot: () => string;
}

export class ObsidianVaultPort implements VaultPort {
  private readonly vault: Vault;
  private readonly workspace: Workspace;
  private readonly getShareRoot: () => string;

  constructor(deps: ObsidianVaultPortDeps) {
    this.vault = deps.vault;
    this.workspace = deps.workspace;
    this.getShareRoot = deps.getShareRoot;
  }

  private get adapter(): DataAdapter {
    return this.vault.adapter;
  }

  // ---------------------------------------------------------- the index

  /**
   * The share-filtered in-memory index.
   *
   * Dot paths are excluded explicitly rather than left to Obsidian: the contract
   * says `list()` cannot see them, `DiskIndex` is built from it, and the folder
   * sweep reads "not in the index" as "not claimed by the tree" — so a `.git`
   * directory leaking in here would become a sweep candidate. `exists()` and
   * `listDir()` are the two calls that DO see dot paths, and spec test 39 turns on
   * exactly that gap.
   */
  list(): Array<{ path: string; kind: Kind }> {
    const root = normPath(this.getShareRoot());
    if (root === '') return [];
    const rootFold = fold(root);
    const out: Array<{ path: string; kind: Kind }> = [];
    for (const file of this.vault.getAllLoadedFiles()) {
      const path = normPath(file.path);
      if (path === '') continue;                        // the vault root is not an entry
      if (isDotPath(path)) continue;
      const key = fold(path);
      if (key !== rootFold && !key.startsWith(`${rootFold}/`)) continue;
      out.push({ path, kind: kindOf(file) });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // ---------------------------------------------------------- adapter level

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(normPath(path)));
  }

  /**
   * Direct children, dot paths included.
   *
   * It REJECTS for a path that is absent or is a file. Returning `[]` there would
   * read as "the folder is empty", which is precisely what the reconciler's
   * empty-folder sweep treats as permission to remove it — invariant I2 says an
   * absence of evidence is never a delete, so the answer to "I could not look" has
   * to be an error and not a value.
   */
  async listDir(path: string): Promise<string[]> {
    const p = normalizePath(normPath(path));
    // The adapters disagree about a missing path (one throws ENOENT, one resolves
    // with empty lists), so the check is made here rather than inferred from
    // whichever answer came back.
    const stat = await this.adapter.stat(p);
    if (stat === null) throw new Error(`ObsidianVaultPort.listDir: not found: ${path}`);
    if (stat.type !== 'folder') throw new Error(`ObsidianVaultPort.listDir: not a folder: ${path}`);
    const listed = await this.adapter.list(p);
    return [...listed.files, ...listed.folders].map(normPath).sort();
  }

  // ---------------------------------------------------------- reads

  async read(path: string): Promise<string> {
    const file = this.resolve(path);
    if (file === null) throw new Error(`ObsidianVaultPort.read: not found: ${path}`);
    if (file instanceof TFolder) throw new Error(`ObsidianVaultPort.read: not a file: ${path}`);
    // `cachedRead`, not `read`: the reconciler compares and hashes, and the cache
    // is what the editor is showing.
    return this.vault.cachedRead(file as TFile);
  }

  /**
   * The same resolution and the same refusals as `read`, in bytes.
   *
   * There is no cached variant of this call, and there should not be: an
   * attachment is read to hash it or to upload it, and both want what is on disk
   * rather than what an editor is showing.
   *
   * The `ArrayBuffer` becomes a `Uint8Array` HERE and nowhere else. That is the
   * single conversion the port contract promises, and it wraps rather than copies:
   * copying a 100 MB attachment to hand it on is exactly what the memory cap
   * exists to avoid.
   */
  async readBinary(path: string): Promise<Uint8Array> {
    const file = this.resolve(path);
    if (file === null) throw new Error(`ObsidianVaultPort.readBinary: not found: ${path}`);
    if (file instanceof TFolder) {
      throw new Error(`ObsidianVaultPort.readBinary: not a file: ${path}`);
    }
    return new Uint8Array(await this.vault.readBinary(file as TFile));
  }

  /**
   * `adapter.stat`, with the two answers kept apart.
   *
   * NULL is a definite not-found. A REJECTION is "I could not look" — a
   * permission error, an unmounted volume, a file another process has locked —
   * and it is deliberately not caught here. Invariant I2 turns on that
   * distinction: the reconciler acts on the first and must no-op on the second,
   * and a `catch { return null }` anywhere on this path is how an unreadable
   * volume becomes a vault-wide delete.
   *
   * Adapter level, so it sees dot paths, exactly like `exists` and `listDir`.
   */
  async stat(path: string): Promise<{ kind: Kind; bytes: number; mtime: number } | null> {
    const found = await this.adapter.stat(normalizePath(normPath(path)));
    if (found === null || found === undefined) return null;
    return {
      kind: found.type === 'folder' ? 'd' : 'f',
      bytes: found.type === 'folder' ? 0 : found.size,
      mtime: found.mtime,
    };
  }

  // ---------------------------------------------------------- mutations

  /**
   * `vault.create`, with the occupancy check made against the FOLDED index first.
   *
   * Obsidian's own duplicate check is a case-sensitive lookup (I11), so on macOS
   * and Windows `create('Notes/README.md')` beside an existing `notes/readme.md`
   * reaches the filesystem and truncates it. Refusing here is what makes this
   * adapter behave like `FakeVault.create`, which every reconciler test relies on.
   */
  async create(path: string, data: string): Promise<void> {
    const p = normPath(path);
    this.assertFree(p, 'create');
    await this.vault.create(p, data);
  }

  /**
   * `vault.createBinary`, behind the SAME folded occupancy check as `create`.
   *
   * The check is not a nicety: Obsidian's own duplicate test is a case-sensitive
   * lookup (I11), so on macOS and Windows `createBinary('Shared/Shot.png')` beside
   * an existing `shared/shot.PNG` reaches the filesystem and truncates it. A
   * truncated attachment is unrecoverable in a way a truncated note is not —
   * there is no content doc holding a second copy of the bytes.
   *
   * There is no in-place variant here on purpose. Replacing an attachment's bytes
   * goes through the staging journal, which renames the previous bytes out BEFORE
   * the new ones exist, so an interrupted replace leaves a visible file rather
   * than a corrupt one.
   */
  async createBinary(path: string, data: Uint8Array): Promise<void> {
    const p = normPath(path);
    this.assertFree(p, 'createBinary');
    await this.vault.createBinary(p, toArrayBuffer(data));
  }

  /** Does NOT create intermediates — callers walk the segments through `ensureDirs` (§4.2). */
  async createFolder(path: string): Promise<void> {
    const p = normPath(path);
    this.assertFree(p, 'createFolder');
    await this.vault.createFolder(p);
  }

  /**
   * I16. `vault.rename` moves the file and leaves backlinks alone; the other API
   * rewrites every link that pointed at it. On the machine where the human did the
   * rename Obsidian has already rewritten them, and the rewrite travels to every
   * peer as ordinary text edits — so a peer that rewrote as well would insert the
   * same logical edit a second time into one shared `Y.Text`.
   */
  async rename(from: string, to: string): Promise<void> {
    const file = this.resolve(from);
    if (file === null) throw new Error(`ObsidianVaultPort.rename: not found: ${from}`);
    await this.vault.rename(file, normPath(to));
  }

  /**
   * Removal, invariant I1's only permitted form: the vault-local `.trash`.
   *
   * The system flag is FALSE on purpose. The system recycle bin does not exist on
   * mobile at all, whereas `<vault>/.trash` is restorable from Settings → Files →
   * Deleted files on every platform. The other two calls — the hard delete and
   * this same call with the flag set to true — are banned outright and are never
   * spelled in shipped source, `banned-calls.test.ts` included.
   */
  async trashLocal(path: string): Promise<void> {
    const file = this.resolve(path);
    if (file === null) throw new Error(`ObsidianVaultPort.trashLocal: not found: ${path}`);
    const toLocalTrash = false;
    await this.vault.trash(file, toLocalTrash);
  }

  // ---------------------------------------------------------- editor state

  /**
   * I7. True when some leaf is currently displaying this file.
   *
   * Every leaf is walked rather than only the active one: a file open in a split,
   * a background tab or another window is just as live under a `yCollab` binding
   * as the focused one, and a plugin-initiated write to its bytes is exactly the
   * whole-document overwrite that invariant exists to prevent.
   */
  isOpenInLeaf(path: string): boolean {
    const key = fold(normPath(path));
    const hits: true[] = [];
    this.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as Partial<FileView>;
      const file = view.file;
      if (file === undefined || file === null) return;
      if (fold(normPath(file.path)) === key) hits.push(true);
    });
    return hits.length > 0;
  }

  // ---------------------------------------------------------- internals

  /**
   * The `TAbstractFile` at `path`, resolved case-insensitively.
   *
   * The fast path is Obsidian's own lookup, which is a case-SENSITIVE map read
   * and therefore misses a case-variant neighbour — the exact miss invariant I11
   * names, after which `vault.create` truncates the file it never saw. The
   * fallback walks the folder tree segment by segment, comparing each segment
   * FOLDED against the real names.
   *
   * Segment-wise is not incidental (SD-5): `fold` is `toLowerCase` on an NFC
   * string, case mapping is neither length-preserving nor guaranteed to
   * distribute over concatenation, so folding a whole path and slicing it is
   * unsound. It is also what keeps the fallback proportional to the siblings
   * along one path rather than to the size of the vault.
   */
  private resolve(path: string): TAbstractFile | null {
    const p = normPath(path);
    if (p === '') return null;
    const direct = this.vault.getAbstractFileByPath(p);
    if (direct !== null) return direct;

    const segments = p.split('/');
    let folder: TFolder = this.vault.getRoot();
    for (let i = 0; i < segments.length; i++) {
      const want = fold(segments[i]);
      let match: TAbstractFile | null = null;
      for (const child of folder.children) {
        if (fold(child.name) === want) { match = child; break; }
      }
      if (match === null) return null;
      if (i === segments.length - 1) return match;
      if (!(match instanceof TFolder)) return null;      // a file cannot hold children
      folder = match;
    }
    return null;
  }

  private assertFree(path: string, op: string): void {
    if (path === '') throw new Error(`ObsidianVaultPort.${op}: empty path`);
    const occupant = this.resolve(path);
    if (occupant !== null) {
      throw new Error(
        `ObsidianVaultPort.${op}: already exists: ${path} (occupied by ${occupant.path})`,
      );
    }
  }
}
