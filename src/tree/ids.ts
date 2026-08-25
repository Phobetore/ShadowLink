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

/**
 * The workspaceId charset — the CLIENT's single statement of it.
 *
 * `server/upgradeAuth.js` states the same rule independently as `ID_RE`, and that
 * duplication is correct rather than a copy waiting to rot, because the two sit on
 * opposite sides of a trust boundary and each side has to hold on its own:
 *
 *  - the server may not assume any client checked. Anything at all can open a
 *    socket to it, and it builds `<workspaceId>/<docId>` snapshot names out of
 *    whatever arrives, which is exactly what its own header says the check is for.
 *  - the client may not lean on the server's 400 to keep it safe. By the time an
 *    upgrade is answered it has already built `state-<workspaceId>-<deviceId>.json`
 *    and `tree-<workspaceId>.bin` under `.obsidian/plugins/`, and `normalizePath`
 *    tidies slashes without resolving `..`.
 *
 * One module imported by both would make a server depend on code its untrusted
 * clients also run, which is the thing a trust boundary exists to prevent. Two
 * independent statements of one rule, each enforced on its own side, is the shape
 * that is wanted. Inside the client there is exactly one statement, and this is it.
 */
export const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Is this a workspaceId the server would accept and the filesystem can hold?
 *
 * The empty string is refused, and callers give it its own meaning: it is what
 * `ShadowLinkPlugin.configured` reads as "not set up yet", so the settings tab must
 * treat an empty field as unfinished rather than as an error.
 */
export function isValidWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_RE.test(id);
}

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
