// server/upgradeAuth.js
// Validates a WebSocket upgrade BEFORE any document data flows.
// URL shape: ws://host/<docId>?t=<SERVER_KEY>&w=<workspaceId>
// The docId is the single path segment (the client sends base64url(notePath));
// workspaceId travels as a query param so the URL needs no multi-segment path
// (robust regardless of how y-websocket encodes the room name).
// Both ids are charset-validated so they are safe to use as snapshot filenames.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_RE = /^[A-Za-z0-9_-]{1,300}$/;

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
  if (!ID_RE.test(workspaceId) || !DOC_RE.test(docId)) return { ok: false, code: 400 };

  return { ok: true, workspaceId, docId, docName: `${workspaceId}/${docId}` };
}
