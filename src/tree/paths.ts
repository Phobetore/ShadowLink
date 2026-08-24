// src/tree/paths.ts
// Pure path, name-validation, liveness and collision semantics (spec §2.2, §5.1, §7).
// This module imports nothing from obsidian, yjs or node builtins: it is the
// headlessly testable core that every stateful P1 module is built on, and it must
// also run on Obsidian mobile, where node builtins do not exist.

// Node's type stripping resolves ESM specifiers literally, so relative imports of
// local modules carry the '.ts' extension (`allowImportingTsExtensions` in tsconfig).
import type { NodeFields, NodeKind } from './types.ts';
import { MAX_REL_PATH_LEN, RECOVERED_DIR, STAGING_DIR } from './constants.ts';

/** Windows device names that cannot exist as files even on POSIX vaults synced to Windows. */
const RESERVED_BASENAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Characters no path segment may contain: separators, Windows-illegal glyphs, and
 * control characters (including NUL).
 *
 * Do NOT "tidy" the class into `?* -`: inside a character class `* -` is the RANGE
 * 0x2A..0x2D, which silently rejects SPACE and HYPHEN and would make ordinary names
 * like "Project Notes" and "meeting-2026.md" unsyncable. Spec test A2 guards this.
 * Trailing spaces are rejected separately in validSegment().
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_NAME_CHARS = /[/\\<>:"|?*\x00-\x1f\x7f]/;

/** The share-relative path of a node. `path` is never stored — this is the only derivation. */
export function relPath(f: Pick<NodeFields, 'd' | 'n'>): string {
  return f.d === '' ? f.n : `${f.d}/${f.n}`;
}

/** Inverse of relPath. */
export function splitRel(rel: string): { d: string; n: string } {
  const i = rel.lastIndexOf('/');
  return i === -1 ? { d: '', n: rel } : { d: rel.slice(0, i), n: rel.slice(i + 1) };
}

/**
 * Comparison key for paths. Case-insensitive and unicode-normalized, because
 * macOS and Windows filesystems are, and `getAbstractFileByPath` is not.
 * Used for occupancy checks — NEVER for writing to disk.
 */
export function fold(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

/** Lowercase hex of a digest. */
function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Stable content hash of TEXT. Line endings are normalized so a CRLF/LF round-trip
 * does not look like an edit (I18). Uses Web Crypto (not node:crypto) so the plugin
 * works on Obsidian mobile, where node builtins do not exist.
 */
export async function hashOf(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.replace(/\r\n/g, '\n'));
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Stable content hash of RAW BYTES (spec §2.2). Deliberately a second function
 * rather than a branch in `hashOf`.
 *
 * It must NEVER apply `hashOf`'s CRLF normalization: that rule is about text, and
 * a PNG or a PDF that happens to contain the pair `0D 0A` is not the same file as
 * one containing `0A`. Normalizing here would change a file's identity, so the
 * hash this device computes would not be the hash the store holds, and two
 * genuinely different attachments could collide onto one object.
 *
 * The argument is a `Uint8Array` and its offset and length are honoured, so a
 * subarray of a larger read hashes the view rather than the backing buffer.
 */
export async function hashOfBytes(data: Uint8Array): Promise<string> {
  // The cast is a typing artefact, not a conversion: `digest` accepts any
  // BufferSource at runtime, while this toolchain's DOM lib narrows an
  // ArrayBufferView to a non-shared buffer. Nothing is copied — copying a
  // 100 MB attachment to hash it is exactly what the memory cap exists to avoid.
  return toHex(await crypto.subtle.digest('SHA-256', data as unknown as BufferSource));
}

/** A parsed `b` field: which bytes belong at a node's path, and what they replaced. */
export interface BlobRef {
  sha256: string;
  bytes: number;
  /** The hash this version replaced, or null for the first version (`-` on the wire). */
  parent: string | null;
}

/**
 * `<sha256hex>:<bytes>:<parent>`, anchored. The size cap is 12 digits because the
 * field is a size in bytes, not an arbitrary number, and an unbounded `\d+` is a
 * value nothing downstream could allocate for.
 */
const BLOB_REF_RE = /^([0-9a-f]{64}):(\d{1,12}):([0-9a-f]{64}|-)$/;

/**
 * Parse a `b` field. Null for anything that is not exactly the packed form —
 * absent, malformed, uppercase, extra fields, a non-numeric size.
 *
 * This is the ONLY validator of the reference. `formatBlobRef` is a formatter and
 * checks nothing, so a caller that builds a reference by hand and a peer running
 * an older build both fail here rather than half-succeeding into a hash the
 * fetcher would then chase.
 */
export function parseBlobRef(b: string | undefined): BlobRef | null {
  if (typeof b !== 'string') return null;
  const m = BLOB_REF_RE.exec(b);
  if (m === null) return null;
  return { sha256: m[1], bytes: Number(m[2]), parent: m[3] === '-' ? null : m[3] };
}

/** Build a `b` field. `parent` is null for a first publish, which serializes as `-`. */
export function formatBlobRef(sha256: string, bytes: number, parent: string | null): string {
  return `${sha256}:${bytes}:${parent ?? '-'}`;
}

/**
 * The ONE place a path becomes a tree kind (spec §2.2). `diskKind` is what the
 * filesystem reports — `'f' | 'd'`, all Obsidian knows — and the tree kind is
 * derived from the name. Every call site routes through this rather than testing
 * `.md` itself, which is how the `'f'`/`'b'` split stays a single rule.
 */
export function nodeKindOf(rel: string, diskKind: 'f' | 'd'): NodeKind {
  if (diskKind === 'd') return 'd';
  return extOf(rel).toLowerCase() === '.md' ? 'f' : 'b';
}

/**
 * "Published" for both content kinds, defined exactly once (I6).
 *
 * A note is published when its creator has seeded the content doc. An attachment
 * needs that AND a reference naming the bytes: `s` alone would materialize a node
 * whose content nobody can name, and every gate that asks this question — both
 * `TreeIndex` gates and Bootstrap — has to give the same answer or the two halves
 * of one derivation disagree.
 */
export function isPublished(f: NodeFields): boolean {
  return f.k === 'b' ? (f.s === 1 && parseBlobRef(f.b) !== null) : f.s === 1;
}

/**
 * `.png` for `a/b.png`; `''` for an extensionless name and for a dotfile.
 *
 * Lifted here from `Reconciler`, `Deletions` and `WorkspaceSession`, which each
 * held a private copy. It now decides a node's KIND (`nodeKindOf`) as well as
 * naming rescued and staged files, and three copies of that rule is how one of
 * them gets missed.
 */
export function extOf(path: string): string {
  const base = splitRel(path).n;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

/** Longest run of a peer's display name that may appear inside a filename. */
const MAX_NAME_IN_FILENAME = 40;

/**
 * A remote-controlled string that is about to become part of a FILENAME. A display
 * name containing a separator would place the file in a folder that does not exist
 * (at best) or somewhere nobody looks (at worst), so the same character class
 * `validateRel` rejects in a path segment is stripped here. Nothing about this is
 * cosmetic: it is the only sanitization between a peer's profile name and a path
 * we write.
 */
export function safeInFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\<>:"|?*\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'a collaborator';
  return cleaned.slice(0, MAX_NAME_IN_FILENAME).trim();
}

function validSegment(seg: string): boolean {
  if (seg === '' || seg === '.' || seg === '..') return false;
  // Spec §7: reject the whole leading-dot class, not a denylist — .obsidian, .trash,
  // .git, .DS_Store and any future dot-state. Inbound, this stops a peer materializing
  // files under a dot-directory, which Obsidian's explorer does not show and the user
  // therefore cannot see or manage. Outbound, it stops dotfiles inside the share being
  // adopted and published.
  if (seg.startsWith('.')) return false;
  if (ILLEGAL_NAME_CHARS.test(seg)) return false;
  if (seg !== seg.trimEnd()) return false;  // trailing space
  if (seg.endsWith('.')) return false;      // trailing dot
  const stem = seg.includes('.') ? seg.slice(0, seg.indexOf('.')) : seg;
  if (RESERVED_BASENAMES.has(stem.toUpperCase())) return false;
  return true;
}

/**
 * Validates a node's `d`/`n` pair before it is trusted for any filesystem operation.
 * A node failing this is skipped entirely (never materialized, never renamed to).
 */
export function validateRel(d: string, n: string, kind: NodeKind): boolean {
  if (typeof d !== 'string' || typeof n !== 'string') return false;
  const rel = d === '' ? n : `${d}/${n}`;
  if (rel.length === 0 || rel.length > MAX_REL_PATH_LEN) return false;
  // The name is a single segment: it may not contain a separator at all.
  if (!validSegment(n)) return false;
  if (d !== '') {
    for (const seg of d.split('/')) {
      if (!validSegment(seg)) return false;
    }
  }
  if (kind === 'f' && !n.toLowerCase().endsWith('.md')) return false;
  return true;
}

/**
 * Every vault-mutation site calls this. `allowReserved` is set only for rescue and
 * staging destinations, which live at the vault root and outside the share by design.
 */
export function assertInsideShare(shareRoot: string, path: string, allowReserved = false): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.includes('\\')) return false;
  for (const seg of path.split('/')) {
    // An empty segment means a doubled or trailing slash ('Shared//a.md', 'Shared/').
    // Not an escape, but such a string would reach the vault API verbatim.
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  const root = shareRoot.replace(/\/+$/, '');
  if (allowReserved) {
    for (const reserved of [RECOVERED_DIR, STAGING_DIR]) {
      if (path === reserved || path.startsWith(reserved + '/')) return true;
    }
  }
  if (root === '') return false;
  return path === root || path.startsWith(root + '/');
}

/** True when `dir` is `root` itself or lies beneath it. Pure string containment. */
export function isUnderDir(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root + '/');
}

/**
 * Liveness is a pure function of converged fields — no clocks, no ordering.
 * A node is dead when its tombstone generation has caught up with its generation,
 * UNLESS it was killed by a folder cascade (`xp`) and has since escaped that folder.
 */
export function isLive(f: NodeFields): boolean {
  if (f.x === undefined || f.x < f.g) return true;
  // `xp === ''` would mean the cascade root is the share root itself, under which
  // everything lives — nothing can escape it. Guarding here keeps a malformed node
  // from reading as live instead of dead.
  if (f.xp !== undefined && f.xp !== '' && !isUnderDir(f.d, f.xp)) return true;
  return false;
}

/**
 * `todo.md` + 2 -> `todo (2).md`; `Notes` + 2 -> `Notes (2)`.
 *
 * Splits off the directory component FIRST. Suffixing the whole relative path would
 * find the last dot anywhere in it, so a file with no extension inside a dotted folder
 * (`2024.Q1/README`) would become `2024 (2).Q1/README` — mangling the DIRECTORY and
 * placing the file in a different, newly created folder. Valid `.md` files always keep
 * the last dot in the basename, so that path is unreachable through validateRel today;
 * doing the split makes it impossible by construction rather than by caller contract.
 */
function withSuffix(rel: string, ordinal: number): string {
  const slash = rel.lastIndexOf('/');
  const dir = slash === -1 ? '' : rel.slice(0, slash + 1);
  const name = slash === -1 ? rel : rel.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const suffixed = dot <= 0
    ? `${name} (${ordinal})`
    : `${name.slice(0, dot)} (${ordinal})${name.slice(dot)}`;
  return dir + suffixed;
}

/**
 * Assign a concrete vault path (share-relative) to every LIVE node, resolving
 * collisions at derive time. Never writes to the tree: write-back would ping-pong
 * against concurrent renames.
 *
 * Rules (all deterministic, all independent of iteration order and wall clocks):
 *  - Dead nodes get no path.
 *  - Directories are never suffixed: two live dir nodes at one path ARE one directory.
 *  - Among colliding files, the lowest nodeId keeps the plain name; the rest are
 *    suffixed " (2)", " (3)", ... in nodeId order.
 *  - A directory outranks a file at the same path.
 */
export function suffixedVaultPath(
  entries: Array<[string, NodeFields]>,
): Map<string, string> {
  const live = entries
    .filter(([, f]) => isLive(f))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const out = new Map<string, string>();
  // fold(relPath) -> how many FILES have already taken that path
  const taken = new Map<string, number>();

  // Directories first: they own their path outright and never collide with each other.
  for (const [id, f] of live) {
    if (f.k !== 'd') continue;
    const rel = relPath(f);
    out.set(id, rel);
    taken.set(fold(rel), 1);
  }

  for (const [id, f] of live) {
    if (f.k !== 'f') continue;
    const rel = relPath(f);
    const key = fold(rel);
    const used = taken.get(key) ?? 0;
    if (used === 0) {
      out.set(id, rel);
      taken.set(key, 1);
      continue;
    }
    let ordinal = used + 1;
    let candidate = withSuffix(rel, ordinal);
    while (taken.has(fold(candidate))) {
      ordinal += 1;
      candidate = withSuffix(rel, ordinal);
    }
    out.set(id, candidate);
    taken.set(key, ordinal);
    taken.set(fold(candidate), 1);
  }

  return out;
}
