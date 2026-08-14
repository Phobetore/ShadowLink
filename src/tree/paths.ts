// src/tree/paths.ts
// Pure path, name-validation, liveness and collision semantics (spec §2.2, §5.1, §7).
// This module imports nothing from obsidian, yjs or node builtins: it is the
// headlessly testable core that every stateful P1 module is built on, and it must
// also run on Obsidian mobile, where node builtins do not exist.

// Node's type stripping resolves ESM specifiers literally, so the runtime import
// below must carry the '.ts' extension — which TypeScript 4.7 rejects outright
// (`allowImportingTsExtensions` only arrived in TS 5.0). The checker is therefore
// silenced on that one line and the values are re-bound with the real module's
// types immediately after, so nothing here degrades to `any`. Type-only imports
// need no extension: they are erased before Node ever sees them.
import type { NodeFields } from './types';
// @ts-ignore -- see note above
import * as constantsModule from './constants.ts';

const {
  MAX_REL_PATH_LEN,
  RECOVERED_DIR,
  STAGING_DIR,
}: typeof import('./constants') = constantsModule;

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
const ILLEGAL_NAME_CHARS = /[/\\<>:"|?*\x00-\x1f]/;

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

/**
 * Stable content hash. Line endings are normalized so a CRLF/LF round-trip does not
 * look like an edit. Uses Web Crypto (not node:crypto) so the plugin works on
 * Obsidian mobile, where node builtins do not exist.
 */
export async function hashOf(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.replace(/\r\n/g, '\n'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function validSegment(seg: string): boolean {
  if (seg === '' || seg === '.' || seg === '..') return false;
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
export function validateRel(d: string, n: string, kind: 'f' | 'd'): boolean {
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
    if (seg === '.' || seg === '..') return false;
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
  if (f.xp !== undefined && !isUnderDir(f.d, f.xp)) return true;
  return false;
}

/** `todo.md` + 2 -> `todo (2).md`; `Notes` + 2 -> `Notes (2)`. */
function withSuffix(name: string, ordinal: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (${ordinal})`;
  return `${name.slice(0, dot)} (${ordinal})${name.slice(dot)}`;
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
