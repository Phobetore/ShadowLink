// src/tree/ids.ts
// Node identity and document-room naming (spec §2.1).
//
// A nodeId is 22 chars from a 62-symbol alphabet (~131 bits) drawn with
// rejection sampling so the distribution is uniform. It deliberately excludes
// '-' and '_' so that `n_<nodeId>` parses unambiguously.

const NODE_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const NODE_ID_LEN = 22;

/** Matches a well-formed nodeId. */
export const NODE_ID_RE = /^[A-Za-z0-9]{22}$/;

/** The server's docId charset (server/upgradeAuth.js DOC_RE) — kept in sync deliberately. */
export const DOC_RE = /^[A-Za-z0-9_-]{1,300}$/;

export function newNodeId(): string {
  const out: string[] = [];
  const buf = new Uint8Array(32);
  while (out.length < NODE_ID_LEN) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < NODE_ID_LEN; i++) {
      const b = buf[i];
      // 248 = 4 * 62: reject the tail so `b % 62` stays uniform.
      if (b < 248) out.push(NODE_ID_ALPHABET[b % 62]);
    }
  }
  return out.join('');
}

/** Room name of the workspace tree document. */
export function treeRoom(): string {
  return '_tree';
}

/** Room name of a note's content document. Stable across rename and move. */
export function noteRoom(nodeId: string): string {
  return `n_${nodeId}`;
}

/** Extract the nodeId from a note room, or null if it is not one. */
export function nodeIdFromRoom(room: string): string | null {
  if (!room.startsWith('n_')) return null;
  const id = room.slice(2);
  return NODE_ID_RE.test(id) ? id : null;
}
