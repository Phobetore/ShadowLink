// src/tree/types.ts
// The tree document's value shapes (spec §2.2). Field names are one or two
// characters because every one of them is repeated per node in the CRDT.

/**
 * Node kind: markdown file, directory, or binary attachment. Written once at
 * creation, never mutated.
 *
 * This is NO LONGER structurally identical to `VaultPort.Kind`, which stays
 * `'f' | 'd'` because that is all the disk (and Obsidian) reports. A `'b'` node is
 * an ordinary file on disk; conflating the two vocabularies is the single most
 * likely source of bugs in P2, so a disk kind becomes a tree kind in exactly one
 * place — `nodeKindOf` in paths.ts.
 */
export type NodeKind = 'f' | 'd' | 'b';

export interface NodeFields {
  k: NodeKind;   // kind. Written once at creation, never mutated.
  d: string;     // parent dir, share-root-relative, POSIX separators, '' at top level. NFC.
  n: string;     // basename including extension, e.g. "Weekly review.md". NFC.
  g: number;     // generation. 1 at creation; incremented only on local resurrect.
  c: number;     // ctime, wall clock ms. Diagnostics only — never a convergence input.
  s?: 1;         // seeded: the creator has published this node's content.
  /**
   * Blob reference, only ever present on k:'b' (spec §2.1).
   *   "<sha256hex>:<bytes>:<parent>"   parent = 64 hex, or "-" for the first version.
   *
   * ONE last-writer-wins register on purpose: hash, length and ancestry can never
   * be split across a concurrent write, for the same reason `path` is derived from
   * `d`+`n` rather than stored. Parse it with `parseBlobRef`, never by hand.
   */
  b?: string;
  x?: number;    // deadGen. Dead iff x >= g, subject to the cascade escape rule.
  xa?: number;   // deletedAt, wall clock ms. Display only.
  xb?: string;   // deletedBy, display name. Display only.
  xh?: string;   // content hash at delete time, for bounded resurrect.
  xp?: string;   // cascade root: dir of the FOLDER whose deletion killed this node.
}

export interface TreeMeta {
  v: 2;                               // schema version. Higher => this client goes read-only.
  claim?: { by: string; at: number };  // founder claim; latency optimization only.
}
