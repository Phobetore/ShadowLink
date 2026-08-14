// src/tree/types.ts
// The tree document's value shapes (spec §2.2). Field names are one or two
// characters because every one of them is repeated per node in the CRDT.

/** Node kind: file (markdown) or directory. */
export type NodeKind = 'f' | 'd';

export interface NodeFields {
  k: NodeKind;   // kind. Written once at creation, never mutated.
  d: string;     // parent dir, share-root-relative, POSIX separators, '' at top level. NFC.
  n: string;     // basename including extension, e.g. "Weekly review.md". NFC.
  g: number;     // generation. 1 at creation; incremented only on local resurrect.
  c: number;     // ctime, wall clock ms. Diagnostics only — never a convergence input.
  s?: 1;         // seeded: the creator has published this node's content.
  x?: number;    // deadGen. Dead iff x >= g, subject to the cascade escape rule.
  xa?: number;   // deletedAt, wall clock ms. Display only.
  xb?: string;   // deletedBy, display name. Display only.
  xh?: string;   // content hash at delete time, for bounded resurrect.
  xp?: string;   // cascade root: dir of the FOLDER whose deletion killed this node.
}

export interface TreeMeta {
  v: 1;                               // schema version. Higher => this client goes read-only.
  claim?: { by: string; at: number };  // founder claim; latency optimization only.
}
