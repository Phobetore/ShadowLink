// src/sync/fakes.ts
// In-memory implementations of VaultPort and DocPort (spec §4.0).
//
// These are not scaffolding. Every reconciler test in Group B runs against them,
// so a fake that is wrong in an interesting way does not fail loudly — it makes
// the whole downstream suite pass while the real thing corrupts a vault. The
// behaviours that follow are therefore modelled on what Obsidian and a real
// filesystem actually do, and each departure is spelled out where it happens:
//
//  - Case-insensitive by DEFAULT, because macOS and Windows are (invariant I11).
//  - `create` / `createFolder` on an occupied path THROW, like `vault.create`.
//  - `trashLocal` RETAINS what it removed, so a test can prove invariant I1
//    positively rather than by the absence of a `delete` call.
//  - `list()` cannot see dot paths; `exists` / `listDir` can.
//  - Every port call is appended to an ordered `calls` log, because end-state
//    assertions cannot see a transient empty stub that was written then fixed.
//
// No `obsidian` import, no node builtins.

import { fold } from '../tree/paths.ts';
import type { DocHandle, DocPort } from './DocPort.ts';
import type { Kind, VaultPort } from './VaultPort.ts';

// ============================================================ FakeVault

export type VaultOp =
  | 'list' | 'exists' | 'listDir' | 'read'
  | 'create' | 'createFolder' | 'rename' | 'trashLocal' | 'isOpenInLeaf';

export interface VaultCall {
  readonly op: VaultOp;
  readonly args: readonly unknown[];
}

/** One entry retained by `trashLocal`. Nothing is ever dropped. */
export interface TrashedEntry {
  /** Where it lived before it was trashed. */
  readonly originalPath: string;
  /** Its uniquified destination under the vault-local `.trash/`. */
  readonly trashPath: string;
  readonly kind: Kind;
  readonly data: string;
}

export interface FakeVaultOptions {
  /**
   * Resolve paths case-insensitively, as macOS (APFS/HFS+) and Windows (NTFS) do.
   * Default true. Setting this false models a case-sensitive Linux vault; it must
   * never be the default, or a reconciler that blind-creates `Notes/README.md`
   * next to `notes/readme.md` would pass its tests and truncate a file in production.
   */
  caseInsensitive?: boolean;
  /**
   * Require a file's or folder's parent directory to exist before creating it,
   * as `vault.create` does. Default true, so a reconciler that forgets
   * `ensureDirs` (spec §4.2) fails loudly rather than silently.
   */
  requireParentDir?: boolean;
}

interface Entry {
  kind: Kind;
  data: string;
}

/** Directory component of a path, or '' for a top-level entry. */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Invariant I18: normalize at every ingestion point. NFC, POSIX separators, no edge slashes. */
function normPath(path: string): string {
  return path.normalize('NFC').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** True when any segment is a dot path — invisible to Obsidian's loaded-file index. */
function isDotPath(path: string): boolean {
  return path.split('/').some((seg) => seg.startsWith('.'));
}

export class FakeVault implements VaultPort {
  /** Ordered log of every port call, arguments included, throwing calls included. */
  readonly calls: VaultCall[] = [];

  /** Everything `trashLocal` removed, keyed by its uniquified `.trash/` destination. */
  readonly trashed = new Map<string, TrashedEntry>();

  private readonly entries = new Map<string, Entry>();
  /** fold(path) -> literal path. Maintained only in case-insensitive mode. */
  private readonly byFold = new Map<string, string>();
  private readonly open = new Set<string>();
  private readonly failures = new Map<VaultOp, Error[]>();

  private readonly caseInsensitive: boolean;
  private readonly requireParentDir: boolean;

  constructor(options: FakeVaultOptions = {}) {
    this.caseInsensitive = options.caseInsensitive ?? true;
    this.requireParentDir = options.requireParentDir ?? true;
  }

  // ---------------------------------------------------------- test helpers

  /**
   * Place an entry directly, bypassing the port surface: setup, not a call, so it
   * is absent from `calls`. Ancestor directories are materialized because a real
   * vault always has a TFolder for every ancestor of every file.
   */
  seed(path: string, kind: Kind, data = ''): void {
    const p = normPath(path);
    if (p === '') throw new Error('FakeVault.seed: empty path');
    this.ensureAncestors(p);
    this.put(p, { kind, data });
  }

  /** Literal path -> contents, FILES only, key-sorted. Directories are visible via `list()`. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of [...this.entries.keys()].sort()) {
      const entry = this.entries.get(path)!;
      if (entry.kind === 'f') out[path] = entry.data;
    }
    return out;
  }

  /** Make exactly the next call of `op` throw `error`. Queues, so it can be called twice. */
  failNext(op: VaultOp, error: Error): void {
    const queue = this.failures.get(op);
    if (queue) queue.push(error);
    else this.failures.set(op, [error]);
  }

  setOpen(path: string, open: boolean): void {
    const key = fold(normPath(path));
    if (open) this.open.add(key);
    else this.open.delete(key);
  }

  callsTo(op: VaultOp): VaultCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  /** Every retained copy of `path`, oldest first. Fold-aware. */
  trashedFor(path: string): TrashedEntry[] {
    const key = this.foldKey(normPath(path));
    return [...this.trashed.values()].filter((e) => this.foldKey(e.originalPath) === key);
  }

  wasTrashed(path: string): boolean {
    return this.trashedFor(path).length > 0;
  }

  // ---------------------------------------------------------- VaultPort

  list(): Array<{ path: string; kind: Kind }> {
    this.record('list', []);
    return [...this.entries.entries()]
      .filter(([path]) => !isDotPath(path))
      .map(([path, entry]) => ({ path, kind: entry.kind }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async exists(path: string): Promise<boolean> {
    const p = normPath(path);
    this.record('exists', [path]);
    this.maybeFail('exists');
    return this.resolve(p) !== undefined;
  }

  async listDir(path: string): Promise<string[]> {
    const p = normPath(path);
    this.record('listDir', [path]);
    this.maybeFail('listDir');

    // '' is the vault root: always present, never an entry of its own.
    //
    // Children MUST be enumerated from the RESOLVED literal, not from the requested
    // path. Resolving existence case-insensitively but then prefix-matching on the
    // caller's casing answers "the folder exists AND is empty" for a case variant —
    // a state no real filesystem produces, and exactly the invariant I2 trap: the
    // reconciler's empty-folder sweep walks TREE-cased paths while the disk holds
    // literal case, so it would trash a folder that still holds files.
    let base = p;
    if (p !== '') {
      const literal = this.resolve(p);
      if (literal === undefined) throw new Error(`FakeVault.listDir: not found: ${path}`);
      if (this.entries.get(literal)!.kind !== 'd') {
        throw new Error(`FakeVault.listDir: not a folder: ${path}`);
      }
      base = literal;
    }
    const prefix = base === '' ? '' : `${base}/`;
    return [...this.entries.keys()]
      .filter((k) => k.startsWith(prefix) && k.length > prefix.length)
      .filter((k) => !k.slice(prefix.length).includes('/'))   // direct children only
      .sort();
  }

  async read(path: string): Promise<string> {
    const p = normPath(path);
    this.record('read', [path]);
    this.maybeFail('read');

    const literal = this.resolve(p);
    if (literal === undefined) throw new Error(`FakeVault.read: not found: ${path}`);
    const entry = this.entries.get(literal)!;
    if (entry.kind !== 'f') throw new Error(`FakeVault.read: not a file: ${path}`);
    return entry.data;
  }

  async create(path: string, data: string): Promise<void> {
    const p = normPath(path);
    this.record('create', [path, data]);
    this.maybeFail('create');
    this.assertFree(p, 'create');
    this.assertParent(p, 'create');
    this.put(p, { kind: 'f', data });
  }

  async createFolder(path: string): Promise<void> {
    const p = normPath(path);
    this.record('createFolder', [path]);
    this.maybeFail('createFolder');
    this.assertFree(p, 'createFolder');
    this.assertParent(p, 'createFolder');
    this.put(p, { kind: 'd', data: '' });
  }

  async rename(from: string, to: string): Promise<void> {
    const src = normPath(from);
    const dst = normPath(to);
    this.record('rename', [from, to]);
    this.maybeFail('rename');

    const literal = this.resolve(src);
    if (literal === undefined) throw new Error(`FakeVault.rename: not found: ${from}`);
    // A directory cannot be moved inside itself. Real vault.rename refuses; without
    // this the fake happily produces `Notes/sub/a.md` with no `Notes` left, so a
    // reconciler pass computing such a move would look green here and fail in
    // production. The flat node registry can represent it (`d` and `n` are free
    // strings), so it is reachable rather than theoretical.
    if (this.entries.get(literal)!.kind === 'd' && fold(dst).startsWith(fold(literal) + '/')) {
      throw new Error(`FakeVault.rename: cannot move a folder into itself: ${from} -> ${to}`);
    }
    // On a folding filesystem this also refuses a CASE-ONLY rename, where the
    // destination resolves back to the source. That refusal is precisely why
    // spec §4.3 routes case-only renames out through ShadowLink Staging/ and back.
    this.assertFree(dst, 'rename');
    this.assertParent(dst, 'rename');

    const moves: Array<[string, string]> = [[literal, dst]];
    if (this.entries.get(literal)!.kind === 'd') {
      const prefix = `${literal}/`;
      for (const key of this.entries.keys()) {
        if (key.startsWith(prefix)) moves.push([key, `${dst}/${key.slice(prefix.length)}`]);
      }
    }
    for (const [oldPath, newPath] of moves) {
      const entry = this.entries.get(oldPath)!;
      this.drop(oldPath);
      this.put(newPath, entry);
    }
  }

  async trashLocal(path: string): Promise<void> {
    const p = normPath(path);
    this.record('trashLocal', [path]);
    this.maybeFail('trashLocal');

    const literal = this.resolve(p);
    if (literal === undefined) throw new Error(`FakeVault.trashLocal: not found: ${path}`);

    // Obsidian moves the whole subtree into <vault>/.trash. Retaining each member
    // separately is what lets a test prove nothing was hard-deleted (invariant I1).
    const victims = [literal];
    if (this.entries.get(literal)!.kind === 'd') {
      const prefix = `${literal}/`;
      for (const key of this.entries.keys()) if (key.startsWith(prefix)) victims.push(key);
    }
    const root = this.uniqueTrashPath(`.trash/${baseOf(literal)}`);
    for (const victim of victims.sort()) {
      const entry = this.entries.get(victim)!;
      const trashPath = victim === literal
        ? root
        : `${root}/${victim.slice(literal.length + 1)}`;
      this.trashed.set(trashPath, {
        originalPath: victim, trashPath, kind: entry.kind, data: entry.data,
      });
      this.drop(victim);
    }
  }

  isOpenInLeaf(path: string): boolean {
    this.record('isOpenInLeaf', [path]);
    return this.open.has(fold(normPath(path)));
  }

  // ---------------------------------------------------------- internals

  private record(op: VaultOp, args: readonly unknown[]): void {
    this.calls.push({ op, args });
  }

  private maybeFail(op: VaultOp): void {
    const queue = this.failures.get(op);
    if (!queue || queue.length === 0) return;
    throw queue.shift()!;
  }

  /** Key under which `byFold` indexes a path, and the comparison key for trash lookups. */
  private foldKey(path: string): string {
    return this.caseInsensitive ? fold(path) : path;
  }

  /** The literal key currently holding `path`, or undefined. Case-folds when configured. */
  private resolve(path: string): string | undefined {
    if (this.entries.has(path)) return path;
    if (!this.caseInsensitive) return undefined;
    return this.byFold.get(fold(path));
  }

  private assertFree(path: string, op: string): void {
    if (path === '') throw new Error(`FakeVault.${op}: empty path`);
    const literal = this.resolve(path);
    if (literal !== undefined) {
      throw new Error(`FakeVault.${op}: already exists: ${path} (occupied by ${literal})`);
    }
  }

  private assertParent(path: string, op: string): void {
    const parent = parentOf(path);
    if (parent === '') return;
    const literal = this.resolve(parent);
    if (literal === undefined) {
      // vault.create and vault.createFolder both fail this way; ensureDirs (spec
      // §4.2) exists because the API does not create intermediates.
      if (this.requireParentDir) {
        throw new Error(`FakeVault.${op}: parent folder does not exist: ${parent}`);
      }
      this.ensureAncestors(path);
      return;
    }
    if (this.entries.get(literal)!.kind !== 'd') {
      throw new Error(`FakeVault.${op}: parent is not a folder: ${parent}`);
    }
  }

  private ensureAncestors(path: string): void {
    const segs = path.split('/');
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      if (this.resolve(dir) === undefined) this.put(dir, { kind: 'd', data: '' });
    }
  }

  private put(path: string, entry: Entry): void {
    this.entries.set(path, entry);
    if (this.caseInsensitive) this.byFold.set(fold(path), path);
  }

  private drop(path: string): void {
    this.entries.delete(path);
    if (this.caseInsensitive) {
      const key = fold(path);
      if (this.byFold.get(key) === path) this.byFold.delete(key);
    }
  }

  private uniqueTrashPath(base: string): string {
    if (!this.trashed.has(base)) return base;
    const dot = baseOf(base).lastIndexOf('.');
    const stem = dot <= 0 ? base : base.slice(0, base.length - (baseOf(base).length - dot));
    const ext = dot <= 0 ? '' : baseOf(base).slice(dot);
    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!this.trashed.has(candidate)) return candidate;
    }
  }
}

// ============================================================ FakeDocs

export type DocOp = 'openHeadless' | 'insertIfEmpty' | 'flush' | 'close';

export interface DocCall {
  readonly op: DocOp;
  readonly args: readonly unknown[];
}

interface FakeHandle extends DocHandle {
  readonly room: string;
  readonly id: number;
}

export class FakeDocs implements DocPort {
  readonly calls: DocCall[] = [];

  private readonly contents = new Map<string, string>();
  private readonly syncedRooms = new Map<string, boolean>();
  private readonly flushConfirms = new Map<string, boolean>();
  private readonly opens = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  private readonly closedHandles = new Set<number>();
  private readonly liveHandles = new Set<number>();
  private readonly failures = new Map<DocOp, Error[]>();
  private nextHandleId = 1;

  // ---------------------------------------------------------- test helpers

  setText(room: string, text: string): void {
    this.contents.set(room, text);
  }

  /** Simulate "the content doc never synced" (spec test 20). Rooms default to synced. */
  setSynced(room: string, synced: boolean): void {
    this.syncedRooms.set(room, synced);
  }

  /**
   * Simulate "the update never came back from the server". Rooms default to
   * confirming, so a caller that ignores the flag is exercised by every other
   * test and only fails where the flag is deliberately turned off — which is the
   * point: invariant I17 says an unconfirmed flush is a retry, not a completion.
   */
  setFlushConfirmed(room: string, confirmed: boolean): void {
    this.flushConfirms.set(room, confirmed);
  }

  text(room: string): string {
    return this.contents.get(room) ?? '';
  }

  failNext(op: DocOp, error: Error): void {
    const queue = this.failures.get(op);
    if (queue) queue.push(error);
    else this.failures.set(op, [error]);
  }

  /** Handles currently open on `room`. */
  openCount(room: string): number {
    return this.opens.get(room) ?? 0;
  }

  /** Handles ever opened on `room`, closed ones included. */
  totalOpens(room: string): number {
    return this.totals.get(room) ?? 0;
  }

  /** True when every handle this port ever issued has been released. */
  allClosed(): boolean {
    return this.liveHandles.size === 0;
  }

  // ---------------------------------------------------------- DocPort

  async openHeadless(room: string): Promise<{ text: string; synced: boolean; handle: DocHandle }> {
    this.calls.push({ op: 'openHeadless', args: [room] });
    this.maybeFail('openHeadless');

    const handle: FakeHandle = { room, id: this.nextHandleId++ };
    this.liveHandles.add(handle.id);
    this.opens.set(room, this.openCount(room) + 1);
    this.totals.set(room, this.totalOpens(room) + 1);
    // A handle is returned even when the room never synced. Branching on `synced`
    // is the CALLER's obligation (invariant I4); a fake that withheld the handle
    // would hide a caller that ignores the flag.
    return { text: this.text(room), synced: this.syncedRooms.get(room) ?? true, handle };
  }

  async insertIfEmpty(handle: DocHandle, text: string): Promise<boolean> {
    this.calls.push({ op: 'insertIfEmpty', args: [handle.room, text] });
    this.maybeFail('insertIfEmpty');

    const h = handle as FakeHandle;
    if (typeof h.id !== 'number') throw new Error('FakeDocs.insertIfEmpty: foreign handle');
    if (this.closedHandles.has(h.id)) {
      throw new Error(`FakeDocs.insertIfEmpty: handle is closed (${h.room})`);
    }
    if (this.text(h.room) !== '') return false;   // invariant I5
    this.contents.set(h.room, text);
    return true;
  }

  async flush(handle: DocHandle): Promise<boolean> {
    this.calls.push({ op: 'flush', args: [handle.room] });
    this.maybeFail('flush');

    const h = handle as FakeHandle;
    if (typeof h.id !== 'number') throw new Error('FakeDocs.flush: foreign handle');
    // Flushing a released handle is a caller bug, not a no-op: the real port has
    // nothing left to await once the provider is gone, so it could only ever
    // answer "confirmed" by lying.
    if (this.closedHandles.has(h.id)) {
      throw new Error(`FakeDocs.flush: handle is closed (${h.room})`);
    }
    return this.flushConfirms.get(h.room) ?? true;
  }

  close(handle: DocHandle): void {
    this.calls.push({ op: 'close', args: [handle.room] });
    const h = handle as FakeHandle;
    if (typeof h.id !== 'number' || this.closedHandles.has(h.id)) return;   // idempotent
    this.closedHandles.add(h.id);
    this.liveHandles.delete(h.id);
    this.opens.set(h.room, Math.max(0, this.openCount(h.room) - 1));
  }

  private maybeFail(op: DocOp): void {
    const queue = this.failures.get(op);
    if (!queue || queue.length === 0) return;
    throw queue.shift()!;
  }
}
