// src/sync/fakes.ts
// In-memory implementations of VaultPort, DocPort, BlobPort and EditorBinding
// (spec §4.0).
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
//  - The EDITOR has a document. `FakeEditorBinding` keeps a real `EditorState`
//    per leaf and runs the SHIPPED `CodeMirrorBinding` over it, because the fake
//    it replaced modelled a mount as total success — which is exactly how a
//    binding that never made the editor equal the document it bound survived
//    three phases and 879 tests, and then corrupted a live share.
//
// No `obsidian` import, no node builtins. `@codemirror/state` is imported for
// real: `EditorState` needs no DOM, so the one seam this suite used to declare
// untestable is not one.

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { EditorState } from '@codemirror/state';
import type { Extension, Transaction, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { extOf, fold, hashOfBytes } from '../tree/paths.ts';
import {
  AUTOFETCH_MAX_BYTES,
  AUTOFETCH_SESSION_BUDGET,
  BLOB_MAX_BYTES,
  REHASH_BUDGET_BYTES,
} from '../tree/constants.ts';
import {
  BlobDigestMismatch,
  BlobTooLarge,
  BlobTransport,
  BlobUnavailable,
  type BlobLimits,
  type BlobPort,
  type BlobPresence,
} from './BlobPort.ts';
import type { DocHandle, DocPort } from './DocPort.ts';
import { decodeMuxFrame, encodeMuxFrame } from './MuxLink.ts';
import type { Kind, VaultPort } from './VaultPort.ts';
import { CodeMirrorBinding } from './WorkspaceSession.ts';
import type {
  EditorBinding, MountPlan, MountResult, SessionAwareness,
} from './WorkspaceSession.ts';

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

// ============================================================ FakeEditorBinding

/**
 * One leaf: a REAL CodeMirror document, and the transactions dispatched into it.
 *
 * `EditorState` needs no DOM, so this is the genuine article — `state.update`
 * applies changes and raises the genuine `RangeError` when one addresses a
 * position the document does not have. It stands in for `EditorView` because
 * `CodeMirrorBinding` only ever uses `view.state` and `view.dispatch`.
 */
class FakeLeaf {
  state: EditorState;
  readonly transactions: Transaction[] = [];

  constructor(doc: string, compartment: Extension | null) {
    this.state = EditorState.create({
      doc,
      // `null` models a leaf whose state Obsidian has built WITHOUT the plugin's
      // compartment — a not-yet-initialised editor, or one Obsidian rebuilt after
      // the extension was registered. A `reconfigure` aimed at it is inert.
      extensions: compartment === null ? [] : [compartment],
    });
  }

  dispatch(spec: TransactionSpec): void {
    const tr = this.state.update(spec);
    this.transactions.push(tr);
    this.state = tr.state;
  }

  get doc(): string {
    return this.state.doc.toString();
  }
}

/**
 * An editor that has its own document.
 *
 * The fake this replaces recorded `{ notePath, text }` and returned true. It had
 * no document, so "mounted a 184-character `Y.Text` into an editor showing 166
 * characters" and "mounted correctly" were the same assertion, and 879 tests
 * could not see a defect that corrupted a live share in twenty minutes. A fake
 * that models a port as total success is not a fake of that port.
 *
 * What this one models that the old one did not:
 *
 *  1. A DOCUMENT PER LEAF, seeded from the FILE's bytes, which may differ from
 *     the `Y.Text` — the whole failure. It is a real `EditorState`.
 *  2. THE SHIPPED BIND. `bufferOf` and `apply` delegate to the production
 *     `CodeMirrorBinding` over these leaves, so nothing here decides what a bind
 *     does to a document; `CodeMirrorBinding` does, exactly as it does in
 *     Obsidian. A test therefore cannot pass because the fake was generous.
 *  3. `y-codemirror.next`'s ACTUAL BEHAVIOUR after the mount: it never seeds an
 *     editor from its `Y.Text`, it applies FUTURE deltas only. The observer
 *     below is `YSyncPluginValue._observer`'s delta -> `{from,to,insert}`
 *     translation, verbatim, dispatched into a real `EditorState` — so a delta
 *     that outruns a diverged document raises the production `RangeError` in a
 *     headless test instead of only in a user's console.
 *  4. WHO WRITES THE FILE. For an open note the plugin may not (I7) and
 *     `VaultPort` has no `modify`; Obsidian's save of the dirty buffer is the
 *     only route, and it is asynchronous. `save()` is that route, and it is
 *     explicit precisely so a test has to say when the disk caught up.
 *
 *  5. THE EDITOR -> `Y.Text` DIRECTION. `type` and `cut` on a leaf that is
 *     CURRENTLY BOUND write through into the bound `Y.Text`, as
 *     `YSyncPluginValue.update` does, under an origin the observer above
 *     ignores.
 *
 *     This used to be the declared omission — "local typing is not what
 *     corrupted the share" — and the omission cost a round. It meant the harness
 *     could not express *a bound leaf that has moved since it was bound*, which
 *     is precisely and only the state the seed arm's `prior.text === B` guard
 *     covered; every test written for that guard therefore used a leaf frozen at
 *     bind time and the guard looked total, while one call to `type` before
 *     switching notes defeated it and published the previous note's body under a
 *     new node. A fake that cannot express the case a guard is about does not
 *     test that guard.
 *
 *     It is a translation of ONE range rather than of CodeMirror's change
 *     iteration, because `type` and `cut` each make one — which is the whole of
 *     what a test needs to say and none of the second copy of `iterChanges` that
 *     would start disagreeing with production.
 */
export class FakeEditorBinding implements EditorBinding {
  /** Every successful mount, in order. */
  readonly mounts: Array<{ notePath: string; text: Y.Text }> = [];
  /** Refused mounts, in order — a leaf that is missing or not initialised. */
  readonly refused: string[] = [];
  unmounts = 0;
  /** Paths that have no editor view — `mount` refuses them, as a closed leaf would. */
  readonly missing = new Set<string>();

  private readonly binding: CodeMirrorBinding;
  private readonly leaves = new Map<string, FakeLeaf>();
  private observed: {
    notePath: string;
    text: Y.Text;
    observer: (event: Y.YTextEvent, tr: Y.Transaction) => void;
  } | null = null;

  /** The vault `save()` writes through. Omitted when a test never saves. */
  constructor(private readonly vault: FakeVault | null = null) {
    this.binding = new CodeMirrorBinding((path) => {
      if (this.missing.has(path)) return null;
      const leaf = this.leaves.get(path);
      // `FakeLeaf` is an `EditorView` as far as `CodeMirrorBinding` is concerned:
      // it uses `view.state` and `view.dispatch` and nothing else.
      return leaf === undefined ? null : (leaf as unknown as EditorView);
    });
  }

  // ---------------------------------------------------------- test helpers

  /**
   * A leaf is showing `notePath` with `doc` in its buffer — normally the file's
   * own bytes, because that is what Obsidian puts there.
   *
   * `initialized: false` models an editor whose state does not carry the
   * plugin's compartment, which is the case where a `reconfigure` is inert and
   * silent and a naive mount reports success having bound nothing.
   */
  openLeaf(notePath: string, doc: string, opts: { initialized?: boolean } = {}): void {
    const initialized = opts.initialized ?? true;
    this.leaves.set(
      notePath,
      new FakeLeaf(doc, initialized ? this.binding.editorExtension() : null),
    );
  }

  /** What the editor is showing for `notePath`, or undefined when no leaf is open. */
  document(notePath: string): string | undefined {
    return this.leaves.get(notePath)?.doc;
  }

  /**
   * The user typing into the open note.
   *
   * Modelled because the interesting moment is BETWEEN the session's
   * `vault.read` and its `mount` — the provider's connect-and-sync round trip,
   * which is the first second after opening a note and therefore exactly when
   * people type. From that point the editor's buffer, not the file, is the
   * newest copy of the note, and it is the thing a mount replaces.
   *
   * Appended at the end by default, because for most of these tests where the
   * characters went is not what it turns on; that they were there is. `at` is
   * there for the ones where it does — a buffer whose edit is in the MIDDLE is
   * what tells a retention bound apart from a prefix check.
   *
   * On a leaf that is CURRENTLY BOUND the characters reach the bound `Y.Text`
   * too. See point 5 of the class comment: without that, "the note the user was
   * reading has moved since it was bound" is a sentence this harness could not
   * say, and it is the only state some guards on the open path are about.
   */
  type(notePath: string, text: string, at?: number): void {
    const leaf = this.leaves.get(notePath);
    if (leaf === undefined) throw new Error(`no leaf is open for ${notePath}`);
    const pos = at ?? leaf.state.doc.length;
    this.localEdit(notePath, leaf, pos, pos, text);
  }

  /** The user deleting a range. The other half of `type`, for the same reason. */
  cut(notePath: string, from: number, to: number): void {
    const leaf = this.leaves.get(notePath);
    if (leaf === undefined) throw new Error(`no leaf is open for ${notePath}`);
    this.localEdit(notePath, leaf, from, to, '');
  }

  /**
   * `YSyncPluginValue.update`, for the one range `type` and `cut` each make.
   *
   * The editor moves first and the `Y.Text` follows, inside a transaction whose
   * origin is this binding — which is exactly the guard the observer above
   * already carries (`tr.origin === this`), so the edit does not echo back into
   * the leaf it came from. A leaf that is not the bound one, or a session with
   * nothing bound, changes only the editor: that is what an unbound note is.
   */
  private localEdit(
    notePath: string, leaf: FakeLeaf, from: number, to: number, insert: string,
  ): void {
    leaf.dispatch({ changes: { from, to, insert } });
    const bound = this.observed;
    if (bound === null || bound.notePath !== notePath) return;
    const doc = bound.text.doc;
    if (doc === null) return;
    doc.transact(() => {
      if (to > from) bound.text.delete(from, to - from);
      if (insert !== '') bound.text.insert(from, insert);
    }, this);
  }

  /**
   * A PEER's edit, delivered the way `y-codemirror.next` delivers one.
   *
   * `fn` runs inside a `Y.Doc` transaction whose origin is not this binding, so
   * the observer installed at bind time translates the resulting delta into
   * CodeMirror changes at `Y.Text` offsets — which is where a document that was
   * not equal at bind time raises the production `RangeError`.
   */
  remoteDelta(notePath: string, fn: (text: Y.Text) => void): void {
    const bound = this.observed;
    if (bound === null) throw new Error(`nothing is bound for ${notePath}`);
    const doc = bound.text.doc;
    if (doc === null) throw new Error(`the text bound for ${notePath} has no document`);
    doc.transact(() => { fn(bound.text); }, 'a peer');
  }

  /**
   * I19, as an assertion: does the editor hold EXACTLY what the bound `Y.Text`
   * holds?
   *
   * This is the watchdog the design considered and dropped. A permanent `Y.Text`
   * observer that re-enters `open()` from inside a Yjs callback guards a case
   * for which no mechanism could be constructed once both writers normalise; as
   * a test helper it costs nothing in production and still fails loudly the
   * moment a bind leaves the two sides one position apart per line ending.
   */
  inStep(notePath: string): boolean {
    const leaf = this.leaves.get(notePath);
    if (leaf === undefined || this.observed === null) return false;
    return this.observed.text.toString() === leaf.doc;
  }

  /** Every transaction that reached this leaf, in order. */
  transactions(notePath: string): readonly Transaction[] {
    return this.leaves.get(notePath)?.transactions ?? [];
  }

  /**
   * Obsidian persisting a dirty buffer.
   *
   * The plugin cannot write an open note's bytes (I7) and `VaultPort` has no
   * `modify`, so in production this is the ONLY way an open note's file changes
   * — and it happens whenever Obsidian gets round to it, not when the plugin
   * would like. Calling it explicitly is how a test states that the disk has
   * caught up; not calling it is how a test states that it has not.
   */
  save(notePath: string): void {
    if (this.vault === null) throw new Error('this FakeEditorBinding has no vault to save through');
    const leaf = this.leaves.get(notePath);
    if (leaf === undefined) return;
    // `seed`, not `create`: this is a writer OUTSIDE the plugin, and the port the
    // plugin is given deliberately cannot overwrite an occupied path.
    this.vault.seed(notePath, 'f', leaf.doc);
  }

  /** The last successful mount. */
  get current(): { notePath: string; text: Y.Text } | undefined {
    return this.mounts[this.mounts.length - 1];
  }

  // ---------------------------------------------------------- EditorBinding

  bufferOf(notePath: string): string | null {
    return this.binding.bufferOf(notePath);
  }

  apply(
    notePath: string,
    text: Y.Text,
    awareness: SessionAwareness,
    plan: MountPlan,
  ): MountResult {
    // The shipped binding's result is passed through UNTOUCHED, `replaced` and
    // `stale` included: what an apply displaced is the one thing the session
    // cannot find out for itself afterwards, so a fake that summarised it away
    // would hide exactly the defect this class exists to expose.
    const result = this.binding.apply(notePath, text, awareness, plan);
    if (!result.ok) {
      this.refused.push(notePath);
      return result;
    }
    this.mounts.push({ notePath, text });
    this.observe(notePath, text);
    return result;
  }

  unmount(): void {
    this.unmounts += 1;
    if (this.observed !== null) {
      this.observed.text.unobserve(this.observed.observer);
      this.observed = null;
    }
    this.binding.unmount();
  }

  // ---------------------------------------------------------- y-sync's observer

  private observe(notePath: string, text: Y.Text): void {
    // The leaf is resolved on every delta rather than captured at mount, so
    // `openLeaf` can put the editor back out of step afterwards. Production's
    // observer closes over one `EditorView`; a test needs to be able to say "and
    // then the editor was showing something else", because that is the state a
    // mount that equalises nothing leaves behind.
    const observer = (event: Y.YTextEvent, tr: Y.Transaction): void => {
      const leaf = this.leaves.get(notePath);
      if (leaf === undefined) return;
      // `YSyncPluginValue._observer`, y-sync.js:107-123. Note what is NOT here:
      // any check that the editor's document is the length these offsets assume.
      // That absence is the production defect, and it belongs in the fake.
      if (tr.origin === this) return;
      const changes: Array<{ from: number; to: number; insert: string }> = [];
      let pos = 0;
      for (const d of event.delta) {
        if (d.insert !== undefined) {
          changes.push({ from: pos, to: pos, insert: String(d.insert) });
        } else if (d.delete !== undefined) {
          changes.push({ from: pos, to: pos + d.delete, insert: '' });
          pos += d.delete;
        } else if (d.retain !== undefined) {
          pos += d.retain;
        }
      }
      if (changes.length > 0) leaf.dispatch({ changes });
    };
    text.observe(observer);
    this.observed = { notePath, text, observer };
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

  /**
   * Fail exactly the next call of `op`, IN THE SHAPE THAT `op` FAILS IN (§8.3).
   * `has`, `put` and `limits` THROW the error; `get` answers NULL with the error
   * in `lastError`. Queues, so it can be called twice.
   *
   * `get` has no way to throw here, deliberately. `ObsidianBlobPort.get` catches
   * everything and answers null for every failure there is — its header says so,
   * and the reconciler is written against exactly that. A fake that threw from
   * `get` would let a test drive a shape production cannot produce and "prove"
   * that a caller handles an exception it will never be handed.
   */
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

    // `ObsidianBlobPort.put` refuses a zero-length object before it makes any
    // request at all: `bytes a-b/total` has no spelling for one, so the routes
    // cannot express it. Nothing offers one today — the publish settle check
    // refuses a 0-byte file upstream — which is precisely why the fake and the
    // port would drift here without anybody noticing.
    //
    // Checked BEFORE `putRefusals`, because those model server answers (413, 507,
    // 422) and an object that is never sent cannot receive one.
    if (data.length === 0) {
      this.lastError = new BlobDigestMismatch(`put(${sha256}): refusing a zero-length object`);
      return false;
    }
    if (this.putRefusals.length > 0) {
      this.lastError = this.putRefusals.shift();
      return false;
    }
    // The TYPES are the real port's, not plain Errors. `lastError` is what the
    // publish queue keeps for diagnostics and what the reconciler reads to tell a
    // 404 from a hiccup; a fake that flattened the family to `Error` would make
    // any future check on one of them untestable through the fakes.
    if (data.length > this.limitsValue.maxFileBytes) {
      this.lastError = new BlobTooLarge(
        `too large: ${data.length} > ${this.limitsValue.maxFileBytes}`,
      );
      return false;
    }
    if (await hashOfBytes(data) !== sha256) {
      this.lastError = new BlobDigestMismatch(`digest mismatch for ${sha256}`);
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
    // An injected failure answers NULL here, never a throw: `ObsidianBlobPort.get`
    // catches every failure there is and returns null, so a thrown `get` is a
    // world production cannot produce. See `failNext`.
    if (this.nextFailure('get') !== undefined) return null;

    if (signal?.aborted === true) {
      this.lastError = new BlobTransport(`get(${sha256}): aborted`);
      return null;
    }
    const stored = this.objects.get(sha256);
    if (stored === undefined) {
      // The TYPE matters, not just the null. `ObsidianBlobPort` answers a 404 with
      // `BlobUnavailable` and everything else with one of the other five, and the
      // reconciler reads that difference to tell "the store no longer holds these
      // bytes" from "the network did not answer" — the first is reported to the
      // user as unavailable, the second is retried. A fake that flattened both to
      // a plain Error would make that check untestable, and the check is the only
      // thing standing between a hiccuping proxy and telling somebody their
      // attachment is lost.
      this.lastError = new BlobUnavailable(`no such object: ${sha256}`);
      return null;
    }
    if (stored.length !== expectBytes) {
      this.lastError = new BlobDigestMismatch(
        `length mismatch: ${stored.length} != ${expectBytes}`,
      );
      return null;
    }
    if (await hashOfBytes(stored) !== sha256) {
      this.lastError = new BlobDigestMismatch(`digest mismatch for ${sha256}`);
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

  /**
   * Pop the injected failure for `op` and record it as the reason, or undefined
   * when none is queued. WHETHER it throws is the caller's business: the four
   * methods fail in three different shapes and this must not flatten them.
   */
  private nextFailure(op: BlobOp): unknown {
    const queue = this.failures.get(op);
    if (!queue || queue.length === 0) return undefined;
    const error = queue.shift()!;
    this.lastError = error;
    return error;
  }

  /** For the three methods that THROW on a transport failure: has, put, limits. */
  private maybeFail(op: BlobOp): void {
    const error = this.nextFailure(op);
    if (error !== undefined) throw error;
  }
}

// ============================================================ FakeMux

/**
 * A mux server and its transport, in memory (P3 spec §7).
 *
 * ⚠ WHY THIS ONE HAS TO BE ABLE TO PARTITION PER ROOM. Five fakes in this repo
 * have already hidden a defect by not being able to SAY the failure — the editor
 * fake that modelled every mount as total success is the expensive one, and the
 * server's own `FakeSocket` grew `holdsWrites` for the same reason last round.
 * The failures the later P3 slices live in are per-ROOM, not per-client: one
 * room's frames stop while every other room on the same socket keeps flowing,
 * and the question is whether that room alone goes `unsynced` (I24) or whether
 * something downstream treats a live link as proof about it. A fake with only a
 * whole-client `goOffline` cannot express that sentence, and a suite written
 * against it would pass with the bug in.
 *
 * So `cut(room)` drops that room's frames in BOTH directions while the socket
 * stays up and every other room keeps working, and `hold(room)` parks them so
 * they can be released later, out of order with respect to the rooms that kept
 * flowing.
 *
 * The server half is a faithful-enough `DocHub`: one `Y.Doc` per room, a
 * SyncStep1 written the first time a socket names a room, `readSyncMessage` for
 * the sync tag, and awareness relayed to the room's other sockets. That fidelity
 * is what lets the SAME `MuxRoom` be driven here and against the real server in
 * the structural suite, which is the only way to know the two agree.
 */
export type FakeMuxOpenMode = 'sync' | 'deferred';

export interface FakeMuxOptions {
  /**
   * `'sync'` opens the socket inside the factory call, which keeps a test free of
   * awaits. `'deferred'` fires `onopen` on a microtask, which is the only way to
   * exercise the handler a real transport uses.
   */
  openMode?: FakeMuxOpenMode;
  /**
   * Behave like a server from before P3: accept the socket, answer with a RAW
   * y-websocket SyncStep1 that is not a mux frame, and ignore every frame sent.
   *
   * Those are the measured bytes — `[0x00, 0x00, 0x01, 0x00]` — from a server
   * checked out at the last commit before the mux work. It is what makes the
   * legacy detector testable without a second process.
   */
  legacy?: boolean;
}

export class FakeMux {
  /** The SERVER's document for each room. */
  readonly docs = new Map<string, Y.Doc>();
  /** Every socket this mux ever handed out, open or not. */
  readonly sockets: FakeMuxSocket[] = [];

  legacy: boolean;
  /** When set, the next `openSocket` throws — a link that cannot even dial. */
  refuseConnect = false;

  private readonly openMode: FakeMuxOpenMode;
  private readonly cutRooms = new Set<string>();
  private readonly heldRooms = new Set<string>();
  /** Frames parked by `hold`, as `[socket, room, payload, direction]`. */
  private readonly parked: Array<{
    socket: FakeMuxSocket; room: string; payload: Uint8Array; inbound: boolean;
  }> = [];

  /** Rooms whose outbound frames are written twice. Duplicate delivery, on demand. */
  private readonly duplicated = new Set<string>();

  readonly stats = { framesIn: 0, framesOut: 0, droppedIn: 0, droppedOut: 0 };

  constructor(options: FakeMuxOptions = {}) {
    this.legacy = options.legacy ?? false;
    // ⚠ A legacy server's whole tell is a message it writes UNPROMPTED on
    // connect, and a socket that is already open when the link's factory returns
    // has nowhere to put it: the link has not assigned `onmessage` yet. So the
    // old-server fake opens on a later turn, which is what a real socket does
    // anyway. A test that wants the greeting has to await one microtask, and
    // that await is the honest part.
    this.openMode = options.openMode ?? (this.legacy ? 'deferred' : 'sync');
  }

  /** Hand this to `MuxLink`'s `openSocket`. */
  get openSocket(): (url: string) => FakeMuxSocket {
    return (url: string): FakeMuxSocket => {
      if (this.refuseConnect) throw new Error('FakeMux: refusing to connect');
      const socket = new FakeMuxSocket(this, url, this.openMode);
      this.sockets.push(socket);
      return socket;
    };
  }

  get liveSockets(): FakeMuxSocket[] {
    return this.sockets.filter((s) => s.readyState === 1);
  }

  // ---------------------------------------------------------- the server's rooms

  doc(room: string): Y.Doc {
    let doc = this.docs.get(room);
    if (doc === undefined) {
      doc = new Y.Doc();
      this.docs.set(room, doc);
    }
    return doc;
  }

  text(room: string): string {
    return this.doc(room).getText('content').toString();
  }

  /** Put something in a room BEFORE anybody connects — a workspace with history. */
  seed(room: string, text: string): void {
    this.doc(room).getText('content').insert(0, text);
  }

  // ---------------------------------------------------------- partition

  /** Cut ONE room's traffic, both directions, with the socket still up. */
  cut(room: string): void { this.cutRooms.add(room); }

  heal(room: string): void { this.cutRooms.delete(room); }

  isCut(room: string): boolean { return this.cutRooms.has(room); }

  /** Park one room's frames instead of dropping them. `release` delivers them. */
  hold(room: string): void { this.heldRooms.add(room); }

  /** Deliver everything parked for `room`, in arrival order, and stop parking. */
  release(room: string): void {
    this.heldRooms.delete(room);
    const mine = this.parked.filter((f) => f.room === room);
    for (const frame of mine) this.parked.splice(this.parked.indexOf(frame), 1);
    for (const frame of mine) {
      if (frame.inbound) frame.socket.deliverToServer(frame.room, frame.payload);
      else frame.socket.deliverToClient(frame.room, frame.payload);
    }
  }

  /** Every outbound frame for `room` is written twice from here on. */
  duplicate(room: string): void { this.duplicated.add(room); }

  isDuplicated(room: string): boolean { return this.duplicated.has(room); }

  parkedCount(room?: string): number {
    return room === undefined
      ? this.parked.length
      : this.parked.filter((f) => f.room === room).length;
  }

  /** Kill every live socket, the way a network does. The link's backoff answers. */
  dropSockets(code = 1006): void {
    for (const socket of this.liveSockets) socket.serverClose(code);
  }

  // ---------------------------------------------------------- internals

  /** @internal — routed by `FakeMuxSocket`. */
  gate(
    socket: FakeMuxSocket, room: string, payload: Uint8Array, inbound: boolean,
  ): 'pass' | 'drop' | 'park' {
    if (this.cutRooms.has(room)) {
      if (inbound) this.stats.droppedIn += 1;
      else this.stats.droppedOut += 1;
      return 'drop';
    }
    if (this.heldRooms.has(room)) {
      this.parked.push({ socket, room, payload, inbound });
      return 'park';
    }
    return 'pass';
  }

  /** @internal — the other sockets that have this room open. */
  peersOf(room: string, except: FakeMuxSocket): FakeMuxSocket[] {
    return this.liveSockets.filter((s) => s !== except && s.hasRoom(room));
  }
}

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/**
 * One socket to `FakeMux`, satisfying `MuxLink`'s `MuxSocket` structurally.
 *
 * The server logic lives here rather than in `FakeMux` because a room is opened
 * PER SOCKET — that is what `DocHub.handleConnection` does, and it is why the
 * first frame for a room gets a SyncStep1 back before anything else.
 */
export class FakeMuxSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';

  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  /** Every frame this socket wrote, as `[room, payload]`. The wire, recorded. */
  readonly sent: Array<{ room: string; payload: Uint8Array }> = [];
  /** Raw bytes written that were not decodable frames. Only legacy mode makes any. */
  readonly sentRaw: Uint8Array[] = [];

  /** When true, `bufferedAmount` grows by what is written and never drains. */
  holdsWrites = false;

  private readonly rooms = new Set<string>();
  private readonly updateHandlers = new Map<string, (u: Uint8Array, o: unknown) => void>();

  constructor(
    private readonly mux: FakeMux,
    readonly url: string,
    openMode: FakeMuxOpenMode,
  ) {
    if (openMode === 'sync') this.openNow();
    else queueMicrotask(() => { this.openNow(); });
  }

  hasRoom(room: string): boolean { return this.rooms.has(room); }

  openRooms(): string[] { return [...this.rooms].sort(); }

  // ---------------------------------------------------------- MuxSocket

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error('FakeMuxSocket: send on a closed socket');
    if (this.holdsWrites) this.bufferedAmount += data.byteLength;
    const frame = decodeMuxFrame(data);
    if (frame === null) { this.sentRaw.push(data.slice()); return; }
    this.sent.push({ room: frame.room, payload: frame.payload });
    this.mux.stats.framesIn += 1;
    // A pre-P3 server reads this as a y-websocket message whose tag is the room
    // name's length, finds no handler for it, and does nothing at all.
    if (this.mux.legacy) return;
    if (this.mux.gate(this, frame.room, frame.payload, true) !== 'pass') return;
    this.deliverToServer(frame.room, frame.payload);
  }

  close(): void {
    this.shut(1000);
  }

  // ---------------------------------------------------------- test controls

  /** Drain whatever `holdsWrites` accumulated, the way a reading peer would. */
  drain(): void { this.bufferedAmount = 0; }

  /** The SERVER hangs up: `MuxLink` sees a close it did not ask for. */
  serverClose(code = 1006): void { this.shut(code); }

  /**
   * The socket is GONE but nobody has been told yet.
   *
   * ⚠ This is what `ws.terminate()` really does, and the reason the fake needs to
   * be able to say it: `readyState` becomes CLOSED in the calling tick while the
   * close EVENT arrives on a later one. In between, anything that answers "am I
   * current?" from a latched flag is answering about a connection that is already
   * dead. Without this knob that window is only reachable by racing a real socket,
   * which is not a test.
   */
  dieAbruptly(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => { this.shut(code); });
  }

  /**
   * The server writing one frame toward this client, THROUGH the gates.
   *
   * This is what a test should use to push a frame: `cut`, `hold` and `duplicate`
   * all live on this path, so a test that reached past it into `deliverToClient`
   * would be asserting about a partition that was never applied.
   */
  push(room: string, payload: Uint8Array): void { this.write(room, payload); }

  // ---------------------------------------------------------- server side

  /** @internal */
  deliverToServer(room: string, payload: Uint8Array): void {
    // ⚠ THE LEAVE, modelled where `server/mux.js` puts it: BEFORE the lazy open,
    // so a leave for a room this socket does not hold opens nothing. A fake that
    // opened one would make the shipped server's one security-relevant ordering
    // untestable from this side, and would report a fan-out that had stopped when
    // it had not.
    if (payload.byteLength === 0) {
      if (!this.rooms.has(room)) return;
      this.leaveRoom(room);
      return;
    }
    if (!this.rooms.has(room)) this.openRoom(room);
    const doc = this.mux.doc(room);
    try {
      const dec = decoding.createDecoder(payload);
      const tag = decoding.readVarUint(dec);
      if (tag === MESSAGE_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(dec, enc, doc, this);
        if (encoding.length(enc) > 1) this.write(room, encoding.toUint8Array(enc));
      } else if (tag === MESSAGE_AWARENESS) {
        // Relayed opaquely to the room's other sockets, which is all a relay owes
        // awareness: this fake keeps no awareness state of its own.
        for (const peer of this.mux.peersOf(room, this)) peer.write(room, payload);
      }
    } catch {
      /* a malformed payload is dropped, exactly as DocHub drops one */
    }
  }

  /** @internal — one frame from the server to this client. */
  deliverToClient(room: string, payload: Uint8Array): void {
    if (this.readyState !== 1) return;
    this.mux.stats.framesOut += 1;
    const frame = encodeMuxFrame(room, payload);
    this.onmessage?.({ data: frame });
    if (this.mux.isDuplicated(room)) this.onmessage?.({ data: frame });
  }

  private openRoom(room: string): void {
    this.rooms.add(room);
    const doc = this.mux.doc(room);
    // DocHub writes its own SyncStep1 the moment a connection joins a room, and
    // that is the frame the legacy detector's positive test looks for.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, doc);
    this.write(room, encoding.toUint8Array(enc));

    const handler = (update: Uint8Array, origin: unknown): void => {
      if (origin === this) return;                // this socket's own write; do not echo
      const uenc = encoding.createEncoder();
      encoding.writeVarUint(uenc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(uenc, update);
      this.write(room, encoding.toUint8Array(uenc));
    };
    this.updateHandlers.set(room, handler);
    doc.on('update', handler);
  }

  /**
   * The client left this room: stop relaying it here, exactly as
   * `VirtualConn.shutdown` does on the real server.
   *
   * Taking the update handler off is the whole of the fan-out leak, expressed:
   * without it this socket goes on being written to for a room nobody on this end
   * is listening to any more.
   */
  private leaveRoom(room: string): void {
    const handler = this.updateHandlers.get(room);
    if (handler !== undefined) this.mux.doc(room).off('update', handler);
    this.updateHandlers.delete(room);
    this.rooms.delete(room);
  }

  /** @internal — the server writing one payload toward this client, gated. */
  private write(room: string, payload: Uint8Array): void {
    if (this.readyState !== 1) return;
    if (this.mux.gate(this, room, payload, false) !== 'pass') return;
    this.deliverToClient(room, payload);
  }

  private openNow(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
    if (!this.mux.legacy) return;
    // ⚠ The measured behaviour of a pre-P3 server: a raw y-websocket SyncStep1
    // for the room it thinks this socket is, sent unprompted on connect. Read as
    // a mux frame it is a zero-length room name, an empty payload, and two bytes
    // left over — which is exactly what `decodeMuxFrame` refuses.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, new Y.Doc());
    this.onmessage?.({ data: encoding.toUint8Array(enc) });
  }

  private shut(code: number): void {
    // ⚠ Guarded on "has the close event been delivered", NOT on `readyState`.
    // `dieAbruptly` sets CLOSED first and delivers later, which is what a real
    // `terminate()` does; a guard that read `readyState` would swallow the very
    // event that knob exists to delay.
    if (this.closeDelivered) return;
    this.closeDelivered = true;
    this.readyState = 3;
    for (const [room, handler] of this.updateHandlers) this.mux.doc(room).off('update', handler);
    this.updateHandlers.clear();
    this.rooms.clear();
    this.onclose?.({ code });
  }

  private closeDelivered = false;
}

// ============================================================ platform numbers

// §7.4 and §7.2 reach the engine as four plain numbers, and every class that
// reads one takes it as a REQUIRED constructor argument — no fallback, because a
// fallback is exactly what let `main.ts` forget one and hand a phone the desktop
// ceilings with every test still green.
//
// Requiring them costs every harness in the suite the same four lines, so the
// three shapes the engine actually asks for live here instead, spelled DESKTOP so
// a test reading `{ ...DESKTOP_PASS_LIMITS }` can see which platform it is
// standing on. A test about a phone overrides the one number it cares about; a
// test that is not about sizes at all says nothing and gets the desktop values,
// which is what it used to get from the fallbacks.

/** What `PublishQueue`, `VaultWatcher` and `Deletions` need: the memory cap alone. */
export const DESKTOP_MEMORY_CAP = {
  memoryCapBytes: () => BLOB_MAX_BYTES,
};

/** What `Bootstrap` needs: the cap plus §7.2's two fetch gates. */
export const DESKTOP_FETCH_LIMITS = {
  ...DESKTOP_MEMORY_CAP,
  autofetchMaxBytes: () => AUTOFETCH_MAX_BYTES,
  sessionBudgetBytes: () => AUTOFETCH_SESSION_BUDGET,
};

/** What `Reconciler` needs: those three plus §3.5's per-pass re-hash budget. */
export const DESKTOP_PASS_LIMITS = {
  ...DESKTOP_FETCH_LIMITS,
  rehashBudgetBytes: () => REHASH_BUDGET_BYTES,
};

