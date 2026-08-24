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
//  - Content is BYTES, one store, with `read`/`create` encoding and decoding UTF-8
//    at the edge. A parallel `bin?` field beside a string would produce a fake
//    where `create` then `readBinary` fails while production succeeds, and would
//    let a test write a PNG and read back a string — a world that cannot exist.
//  - `stat` reports a MONOTONIC mtime that bumps on every write, so the
//    "size and mtime still agree" cache branch is genuinely exercised rather than
//    always missing.
//
// No `obsidian` import, no node builtins.

import { extOf, fold, hashOfBytes } from '../tree/paths.ts';
import type { BlobLimits, BlobPort, BlobPresence } from './BlobPort.ts';
import type { DocHandle, DocPort } from './DocPort.ts';
import type { Kind, VaultPort } from './VaultPort.ts';

export type { BlobLimits } from './BlobPort.ts';

// ============================================================ FakeVault

export type VaultOp =
  | 'list' | 'exists' | 'listDir' | 'read' | 'readBinary' | 'stat'
  | 'create' | 'createBinary' | 'createFolder' | 'rename' | 'trashLocal' | 'isOpenInLeaf';

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
  /** The retained content as text. Lossy for an attachment — see `bytes`. */
  readonly data: string;
  /**
   * The retained content as bytes. This is the copy that proves I1 for a binary:
   * a PNG round-tripped through `data` would not come back byte-identical, so
   * "nothing was destroyed" could not be asserted positively without it.
   */
  readonly bytes: Uint8Array;
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
  /** The single source of truth for content. Text is a view over these bytes. */
  bytes: Uint8Array;
  /** Bumped on every write, never on a rename — what a real filesystem does. */
  mtime: number;
}

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

function encode(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

function decode(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes);
}

/** A defensive copy, so a caller holding a returned array cannot edit the vault. */
function copyOf(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

/** The mtime the first write gets; each later write adds `MTIME_STEP_MS`. */
const MTIME_EPOCH = 1_700_000_000_000;
const MTIME_STEP_MS = 1_000;

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
  /** Monotonic, so "the file changed under us" is expressible without a real clock. */
  private mtimeCursor = MTIME_EPOCH;

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
    this.seedEntry(path, kind, encode(data));
  }

  /** `seed` for content that is not text. Same store, same rules — bytes go in as bytes. */
  seedBinary(path: string, bytes: Uint8Array): void {
    this.seedEntry(path, 'f', copyOf(bytes));
  }

  /** Literal path -> contents as TEXT, FILES only, key-sorted. Folders are in `list()`. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of [...this.entries.keys()].sort()) {
      const entry = this.entries.get(path)!;
      if (entry.kind === 'f') out[path] = decode(entry.bytes);
    }
    return out;
  }

  /** The same snapshot as bytes, for content a UTF-8 round trip would destroy. */
  binarySnapshot(): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    for (const path of [...this.entries.keys()].sort()) {
      const entry = this.entries.get(path)!;
      if (entry.kind === 'f') out[path] = copyOf(entry.bytes);
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

    return decode(this.fileBytes(p, 'read', path));
  }

  /**
   * `vault.readBinary`. Rejects for an absent path or a directory, exactly like
   * `read`, and returns a COPY: a caller that keeps the array must not be holding
   * a handle that edits the vault.
   */
  async readBinary(path: string): Promise<Uint8Array> {
    const p = normPath(path);
    this.record('readBinary', [path]);
    this.maybeFail('readBinary');
    return copyOf(this.fileBytes(p, 'readBinary', path));
  }

  /**
   * `adapter.stat`. Resolves NULL only for a definite not-found and REJECTS when
   * the lookup itself failed (`failNext('stat', ...)`) — invariant I2: "it is not
   * there" is an answer, "I could not look" is not, and the two must not collapse
   * into one value.
   */
  async stat(path: string): Promise<{ kind: Kind; bytes: number; mtime: number } | null> {
    const p = normPath(path);
    this.record('stat', [path]);
    this.maybeFail('stat');

    const literal = this.resolve(p);
    if (literal === undefined) return null;
    const entry = this.entries.get(literal)!;
    return { kind: entry.kind, bytes: entry.bytes.length, mtime: entry.mtime };
  }

  async create(path: string, data: string): Promise<void> {
    const p = normPath(path);
    this.record('create', [path, data]);
    this.maybeFail('create');
    this.assertFree(p, 'create');
    this.assertParent(p, 'create');
    this.put(p, { kind: 'f', bytes: encode(data), mtime: this.nextMtime() });
  }

  /** `vault.createBinary`. Refuses an occupied path, exactly like `create` (I1/I11). */
  async createBinary(path: string, data: Uint8Array): Promise<void> {
    const p = normPath(path);
    this.record('createBinary', [path, data]);
    this.maybeFail('createBinary');
    this.assertFree(p, 'createBinary');
    this.assertParent(p, 'createBinary');
    this.put(p, { kind: 'f', bytes: copyOf(data), mtime: this.nextMtime() });
  }

  async createFolder(path: string): Promise<void> {
    const p = normPath(path);
    this.record('createFolder', [path]);
    this.maybeFail('createFolder');
    this.assertFree(p, 'createFolder');
    this.assertParent(p, 'createFolder');
    this.put(p, { kind: 'd', bytes: new Uint8Array(0), mtime: this.nextMtime() });
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
        originalPath: victim,
        trashPath,
        kind: entry.kind,
        data: decode(entry.bytes),
        bytes: copyOf(entry.bytes),
      });
      this.drop(victim);
    }
  }

  isOpenInLeaf(path: string): boolean {
    this.record('isOpenInLeaf', [path]);
    return this.open.has(fold(normPath(path)));
  }

  // ---------------------------------------------------------- internals

  /** Shared by `seed` and `seedBinary`: setup, so it is absent from `calls`. */
  private seedEntry(path: string, kind: Kind, bytes: Uint8Array): void {
    const p = normPath(path);
    if (p === '') throw new Error('FakeVault.seed: empty path');
    // A real vault always has a TFolder for every ancestor of every file.
    this.ensureAncestors(p);
    this.put(p, { kind, bytes, mtime: this.nextMtime() });
  }

  /** The stored bytes of a FILE, or the same rejections `read` has always made. */
  private fileBytes(p: string, op: string, requested: string): Uint8Array {
    const literal = this.resolve(p);
    if (literal === undefined) throw new Error(`FakeVault.${op}: not found: ${requested}`);
    const entry = this.entries.get(literal)!;
    if (entry.kind !== 'f') throw new Error(`FakeVault.${op}: not a file: ${requested}`);
    return entry.bytes;
  }

  private nextMtime(): number {
    this.mtimeCursor += MTIME_STEP_MS;
    return this.mtimeCursor;
  }

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
      if (this.resolve(dir) === undefined) {
        this.put(dir, { kind: 'd', bytes: new Uint8Array(0), mtime: this.nextMtime() });
      }
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
    // The same extension rule the reconciler and the deletion path use. A fourth
    // private copy is how a fake starts disagreeing with production.
    const ext = extOf(base);
    const stem = ext === '' ? base : base.slice(0, base.length - ext.length);
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

// ============================================================ FakeBlobs

// The content-addressed store, in memory (spec §8.5). It gets the same rigour as
// `FakeVault` because the same reasoning applies: the store is where "the bytes
// exist" is decided, and a fake that answers that question more generously than
// the real one would let every downstream test pass while a peer's attachment is
// silently unrecoverable.
//
// Three refusals are modelled separately on purpose (spec §8.3):
//  - `has` THROWS on transport failure. It never answers `false` for "I could not
//    ask", because a definite `false` at delete time means RESCUE (I2).
//  - `put` returns FALSE for a refusal the user must be told about, with the
//    reason in `lastError`, and THROWS for transport, which the caller retries.
//  - `get` returns NULL for every failure at all, verified by DIGEST before it
//    returns anything, so an incomplete or corrupted fetch is a no-op rather than
//    a partial write.

export type BlobOp = 'has' | 'put' | 'get' | 'limits';

export interface BlobCall {
  readonly op: BlobOp;
  readonly args: readonly unknown[];
}

/** Default ceiling, matching nothing in particular: tests that care call `setLimits`. */
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

export class FakeBlobs implements BlobPort {
  /** Ordered log of every call, arguments included, throwing calls included. */
  readonly calls: BlobCall[] = [];

  /** The reason for the most recent refusal, exactly like the real port. */
  lastError: unknown = null;

  /** sha256 -> stored bytes. `corrupt()` is the only way the two can disagree. */
  private readonly objects = new Map<string, Uint8Array>();
  private readonly failures = new Map<BlobOp, Error[]>();
  private readonly putRefusals: unknown[] = [];
  private limitsValue: BlobLimits = {
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    freeBytes: null,
  };

  // ---------------------------------------------------------- test helpers

  /** Place bytes in the store under their true hash. Setup, so it is not logged. */
  async seed(data: Uint8Array): Promise<string> {
    const sha256 = await hashOfBytes(data);
    this.objects.set(sha256, copyOf(data));
    return sha256;
  }

  /** Model a blob the server no longer holds — swept, lost, or never finished. */
  setAbsent(sha256: string): void {
    this.objects.delete(sha256);
  }

  /**
   * Model bytes that no longer hash to the key they are stored under, keeping the
   * LENGTH identical so only a digest check can catch it. Its whole job is to
   * prove `get` returns null and writes nothing, rather than putting bad bytes on
   * a user's disk.
   */
  corrupt(sha256: string): void {
    const stored = this.objects.get(sha256);
    if (stored === undefined) throw new Error(`FakeBlobs.corrupt: no such object: ${sha256}`);
    const damaged = copyOf(stored);
    if (damaged.length === 0) throw new Error('FakeBlobs.corrupt: cannot damage an empty object');
    damaged[0] = damaged[0] ^ 0xff;
    this.objects.set(sha256, damaged);
  }

  setLimits(limits: Partial<BlobLimits>): void {
    this.limitsValue = { ...this.limitsValue, ...limits };
  }

  /** Make exactly the next call of `op` throw — transport, not refusal. */
  failNext(op: BlobOp, error: Error): void {
    const queue = this.failures.get(op);
    if (queue) queue.push(error);
    else this.failures.set(op, [error]);
  }

  /** Make exactly the next `put` REFUSE: resolves false, `lastError` carries why. */
  refuseNextPut(error: unknown): void {
    this.putRefusals.push(error);
  }

  /** What the store holds under `sha256`, for assertions. A copy. */
  stored(sha256: string): Uint8Array | undefined {
    const bytes = this.objects.get(sha256);
    return bytes === undefined ? undefined : copyOf(bytes);
  }

  /** How many distinct objects the store holds — a dedup assertion in one number. */
  objectCount(): number {
    return this.objects.size;
  }

  callsTo(op: BlobOp): BlobCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  // ---------------------------------------------------------- BlobPort

  /** HEAD. Throws on transport failure — never answers false for "I could not ask". */
  async has(sha256: string): Promise<BlobPresence> {
    this.record('has', [sha256]);
    this.maybeFail('has');

    const stored = this.objects.get(sha256);
    return stored === undefined ? { present: false } : { present: true, bytes: stored.length };
  }

  /**
   * Chunked, resumable PATCH, collapsed to one step. False for a refusal the user
   * must be told about; throws for transport. Resolves true only for a stored
   * object whose digest the store itself recomputed — a `put` whose bytes do not
   * hash to the URL's `<sha>` stores NOTHING.
   */
  async put(
    sha256: string,
    data: Uint8Array,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<boolean> {
    this.record('put', [sha256, data.length]);
    this.maybeFail('put');

    if (this.putRefusals.length > 0) {
      this.lastError = this.putRefusals.shift();
      return false;
    }
    if (data.length > this.limitsValue.maxFileBytes) {
      this.lastError = new Error(`too large: ${data.length} > ${this.limitsValue.maxFileBytes}`);
      return false;
    }
    if (await hashOfBytes(data) !== sha256) {
      this.lastError = new Error(`digest mismatch for ${sha256}`);
      return false;
    }

    this.objects.set(sha256, copyOf(data));
    onProgress?.(data.length, data.length);
    this.lastError = null;
    return true;
  }

  /**
   * Resumable, Range-based GET, digest-verified BEFORE returning. Null on any
   * failure at all: an incomplete or unverifiable fetch is a no-op, never a
   * partial write.
   */
  async get(
    sha256: string,
    expectBytes: number,
    signal?: AbortSignal,
    onProgress?: (received: number, total: number) => void,
  ): Promise<Uint8Array | null> {
    this.record('get', [sha256, expectBytes]);
    this.maybeFail('get');

    if (signal?.aborted === true) {
      this.lastError = new Error('aborted');
      return null;
    }
    const stored = this.objects.get(sha256);
    if (stored === undefined) {
      this.lastError = new Error(`no such object: ${sha256}`);
      return null;
    }
    if (stored.length !== expectBytes) {
      this.lastError = new Error(`length mismatch: ${stored.length} != ${expectBytes}`);
      return null;
    }
    if (await hashOfBytes(stored) !== sha256) {
      this.lastError = new Error(`digest mismatch for ${sha256}`);
      return null;
    }

    onProgress?.(stored.length, stored.length);
    this.lastError = null;
    return copyOf(stored);
  }

  async limits(): Promise<BlobLimits> {
    this.record('limits', []);
    this.maybeFail('limits');
    return { ...this.limitsValue };
  }

  // ---------------------------------------------------------- internals

  private record(op: BlobOp, args: readonly unknown[]): void {
    this.calls.push({ op, args });
  }

  private maybeFail(op: BlobOp): void {
    const queue = this.failures.get(op);
    if (!queue || queue.length === 0) return;
    const error = queue.shift()!;
    this.lastError = error;
    throw error;
  }
}
