// server/httpAuth.js
// The bearer check in front of every blob route (spec §6.2).
//
// `Authorization: Bearer <SERVER_KEY>`, a HEADER and deliberately not a query
// parameter. `upgradeAuth.js` reads `?t=` because a WebSocket upgrade has nowhere
// else to put a credential and happens once per session; the blob endpoints are
// hit hundreds of times per session, and a query string is written verbatim into
// access logs, proxy logs and error pages. So the query parameter authorizes
// nothing here, and there is a test that holds that line.
//
// The same `auth.validateServerKey` decides — this file parses, it does not
// compare. That keeps the timing-safe comparison in one place (`auth.js`, which
// this slice does not touch) and keeps the parse independently testable.
//
// This function reads `req.headers` and NOTHING else. That is the whole point of
// its shape: a 401 must be answered before a single byte of body is read, and the
// cheapest way to guarantee that is for the check to have no way to read one.

/**
 * `Bearer <token>`, anchored, scheme case-insensitive (RFC 7235 §2.1), credential
 * a single token with no internal whitespace. `\S+` rather than the base64 charset
 * because the credential is an opaque server key whose alphabet is `auth.js`'s
 * business, not this parser's; anything that is not the real key is refused by the
 * comparison a line later regardless.
 */
const BEARER_RE = /^Bearer[ \t]+(\S+)$/i;

/**
 * @param {{ headers?: Record<string, unknown> } | null | undefined} req
 * @param {(key: string) => boolean} isValidKey  `auth.validateServerKey`.
 * @returns {{ ok: true } | { ok: false, code: 401 }}
 */
export function authorizeBearer(req, isValidKey) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return { ok: false, code: 401 };

  const match = BEARER_RE.exec(header);
  if (match === null) return { ok: false, code: 401 };

  return isValidKey(match[1]) ? { ok: true } : { ok: false, code: 401 };
}
