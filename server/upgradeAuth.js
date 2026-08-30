// server/upgradeAuth.js
// Validates a WebSocket upgrade BEFORE any document data flows.
// URL shape: ws://host/<docId>?t=<SERVER_KEY>&w=<workspaceId>
// The docId is the single path segment (the client sends base64url(notePath));
// workspaceId travels as a query param so the URL needs no multi-segment path
// (robust regardless of how y-websocket encodes the room name).
// Both ids are charset-validated so they are safe to use as snapshot filenames.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_RE = /^[A-Za-z0-9_-]{1,300}$/;

/**
 * Is `docId` a name this server will relay, and therefore a name it will use as
 * a path segment under the snapshot directory?
 *
 * Exported because the P3 mux (`server/mux.js`) has to ask the SAME question at
 * a different time. On the per-room route the docId is in the URL, so one check
 * at upgrade covers the socket's whole life. A mux socket authenticates once and
 * then names a room in every frame, so the check moves from upgrade time to
 * frame time — and if that were a second, separately written regex, the two
 * would drift and the mux would be the looser of the two. It is one predicate,
 * used twice, and `mux.test.js` cross-checks the two call sites against each
 * other on the same strings rather than trusting that they still agree.
 */
export function isValidDocId(docId) {
  return typeof docId === 'string' && DOC_RE.test(docId);
}

/** The same question for a workspace id, which is the other half of a docName. */
export function isValidWorkspaceId(workspaceId) {
  return typeof workspaceId === 'string' && ID_RE.test(workspaceId);
}

export function authorizeUpgrade(rawUrl, isValidKey) {
  if (rawUrl == null) return { ok: false, code: 400 };
  let url;
  try {
    url = new URL(rawUrl, 'http://placeholder');
  } catch {
    return { ok: false, code: 400 };
  }
  const token = url.searchParams.get('t') ?? '';
  if (!isValidKey(token)) return { ok: false, code: 401 };

  const workspaceId = url.searchParams.get('w') ?? '';
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 1) return { ok: false, code: 400 };

  const docId = parts[0];
  if (!isValidWorkspaceId(workspaceId) || !isValidDocId(docId)) return { ok: false, code: 400 };

  return { ok: true, workspaceId, docId, docName: `${workspaceId}/${docId}` };
}
