// server/blobRoutes.js
// The five blob routes (spec §6.3), dispatched from `server/index.js` ahead of
// the existing 404 and riding the same `createServer` the WebSocket upgrade uses,
// so self-hosters open one port and P1's SERVER_KEY model is unchanged.
//
//   HEAD /blob/<ws>/<sha>             200 + content-length, or 404. The dedup probe.
//   HEAD /blob/<ws>/<sha>?partial=1   204 + x-shadowlink-received: <n>, the resume offset.
//   GET  /blob/<ws>/<sha>             the bytes; etag, immutable, Range honoured.
//   PATCH /blob/<ws>/<sha>            content-range: bytes a-b/total. Appends iff a === received.
//   GET  /blob/<ws>/limits            {"maxFileBytes":N,"freeBytes":N|null}
//
// There is NO DELETE. The server never removes a blob because a client asked.
//
// `DocHub`, `upgradeAuth.js` and `auth.js` are untouched by this file — that is
// load-bearing rather than incidental: the most dangerous surface in P1 (the
// initial-seed race on content docs) gains no new callers here.
//
// THE STATUS CODES MEAN GENUINELY DIFFERENT THINGS and the client branches on all
// of them:
//
//   413  too large            the object exceeds MAX_FILE_SIZE_MB
//   507  quota exhausted      the store is full; the node stays unpublished and retries
//   422  digest mismatch      what arrived is not what the name says
//   409  wrong offset         + x-shadowlink-received, so the client re-seeks
//   404  not stored           the ONLY answer that is about the bytes…
//   503  busy                 + Retry-After
//   everything else           transport
//
// …and even 404 is never a delete (invariant I2): it becomes a permanently-pending
// materialization plus a diagnostic, never a tombstone.

import { createReadStream } from 'node:fs';
import { authorizeBearer } from './httpAuth.js';

/** The charset `upgradeAuth.js` already applies, so `<ws>` is a safe path component. */
const WS_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;
const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;

/** Per workspace. Four large uploads plus a Range download otherwise share the
 *  event loop with every Y.applyUpdate, and real-time text — P0's whole feature —
 *  degrades to visible keystroke latency for everyone on the deployment. */
const MAX_BLOB_CONCURRENCY = 6;
/** Per connection, so one client cannot take every slot in its workspace. */
const MAX_PER_CONNECTION = 2;
const RETRY_AFTER_SECONDS = 2;

function send(res, code, headers = {}) {
  res.writeHead(code, headers);
  res.end();
}

export function createBlobRoutes(deps) {
  const {
    store,
    isValidKey,
    maxConcurrency = MAX_BLOB_CONCURRENCY,
    maxPerConnection = MAX_PER_CONNECTION,
    retryAfterSeconds = RETRY_AFTER_SECONDS,
  } = deps;

  /** ws -> in-flight transfers. */
  const perWorkspace = new Map();
  /** socket -> in-flight transfers. A socket object is the connection's identity. */
  const perConnection = new Map();

  function acquire(ws, socket) {
    const workspace = perWorkspace.get(ws) ?? 0;
    const connection = perConnection.get(socket) ?? 0;
    if (workspace >= maxConcurrency || connection >= maxPerConnection) return null;
    perWorkspace.set(ws, workspace + 1);
    perConnection.set(socket, connection + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const w = (perWorkspace.get(ws) ?? 1) - 1;
      if (w > 0) perWorkspace.set(ws, w); else perWorkspace.delete(ws);
      const c = (perConnection.get(socket) ?? 1) - 1;
      if (c > 0) perConnection.set(socket, c); else perConnection.delete(socket);
    };
  }

  /**
   * @returns {boolean} true when this router owns the request. The caller falls
   *   through to its own 404 otherwise.
   */
  function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '', 'http://placeholder');
    } catch {
      return false;
    }
    // Ownership is decided on the NORMALIZED path, so `/blob/../secret` is not a
    // blob route at all: it resolves out of the namespace and falls through to the
    // caller's 404, rather than being claimed and then argued with.
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'blob') return false;

    // AUTH FIRST, and it reads nothing but headers: a 401 is answered before a
    // single byte of body is read. `connection: close` because an unauthenticated
    // peer does not keep a socket — otherwise a refused upload still streams its
    // whole body into the dump.
    const auth = authorizeBearer(req, isValidKey);
    if (!auth.ok) {
      send(res, auth.code, {
        'www-authenticate': 'Bearer realm="shadowlink"',
        'cache-control': 'no-store',
        connection: 'close',
      });
      return true;
    }

    void dispatch(req, res, url, parts).catch(() => {
      // Any escape is a bug in this file, not a client-visible condition. Answer
      // 500 if we still can, and never take the process down: the WebSocket relay
      // is sharing this event loop.
      try {
        if (!res.headersSent) send(res, 500, { 'cache-control': 'no-store' });
        else res.end();
      } catch { /* the socket is already gone */ }
    });
    return true;
  }

  async function dispatch(req, res, url, parts) {
    // ['blob', ws, tail] — anything else is not one of the five routes.
    if (parts.length !== 3) return send(res, 404, { 'cache-control': 'no-store' });

    const ws = parts[1];
    const tail = parts[2];
    // Charset-validated, and therefore safe as filesystem path components by
    // construction — the same discipline `upgradeAuth.js` applies.
    if (!WS_RE.test(ws)) return send(res, 400, { 'cache-control': 'no-store' });

    if (tail === 'limits') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      }
      const body = JSON.stringify(store.limits());
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    if (!SHA_RE.test(tail)) return send(res, 400, { 'cache-control': 'no-store' });

    switch (req.method) {
      case 'HEAD':   return headBlob(req, res, url, ws, tail);
      case 'GET':    return getBlob(req, res, ws, tail);
      case 'PATCH':  return patchBlob(req, res, ws, tail);
      default:
        return send(res, 405, { allow: 'HEAD, GET, PATCH', 'cache-control': 'no-store' });
    }
  }

  // ------------------------------------------------------------------ HEAD

  async function headBlob(req, res, url, ws, sha) {
    // `?partial=1`: the resume offset. The partial is keyed by the content hash,
    // so the upload IS its own session — a client that slept for two hours issues
    // one HEAD, learns the offset, and continues, with no server-side state.
    if (url.searchParams.get('partial') === '1') {
      const received = await store.received(ws, sha);
      return send(res, 204, {
        'x-shadowlink-received': String(received),
        'cache-control': 'no-store',
      });
    }

    const found = await store.stat(ws, sha);
    if (found === null) return send(res, 404, { 'cache-control': 'no-store' });
    // Never answered from a cache: this is the dedup probe AND the `proven`
    // confirmation before a deletion, and a stale yes there is a lost file.
    return send(res, 200, {
      'content-length': String(found.bytes),
      'content-type': 'application/octet-stream',
      etag: `"${sha}"`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
  }

  // ------------------------------------------------------------------- GET

  async function getBlob(req, res, ws, sha) {
    const found = await store.stat(ws, sha);
    if (found === null) return send(res, 404, { 'cache-control': 'no-store' });

    const release = acquire(ws, req.socket);
    if (release === null) {
      return send(res, 503, {
        'retry-after': String(retryAfterSeconds),
        'cache-control': 'no-store',
      });
    }

    const total = found.bytes;
    const range = parseRange(req.headers.range, total);
    if (range === 'invalid') {
      release();
      return send(res, 416, {
        'content-range': `bytes */${total}`,
        'cache-control': 'no-store',
      });
    }

    const start = range === null ? 0 : range.start;
    const end = range === null ? total - 1 : range.end;
    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      etag: `"${sha}"`,
      'accept-ranges': 'bytes',
      // The bytes ARE the name: an object under this URL can never change, so
      // this is the one thing in the protocol that is safe to cache for ever.
      'cache-control': 'public, max-age=31536000, immutable',
    };
    if (range !== null) headers['content-range'] = `bytes ${start}-${end}/${total}`;

    res.writeHead(range === null ? 200 : 206, headers);
    const stream = createReadStream(found.path, { start, end });
    stream.on('error', () => { res.destroy(); });
    res.on('close', () => { stream.destroy(); });
    res.on('finish', release);
    res.on('close', release);
    stream.pipe(res);
  }

  // ----------------------------------------------------------------- PATCH

  async function patchBlob(req, res, ws, sha) {
    const range = parseContentRange(req.headers['content-range']);
    if (range === null) return send(res, 400, { 'cache-control': 'no-store' });

    const declared = req.headers['content-length'];
    const length = range.end - range.start + 1;
    if (declared === undefined || Number(declared) !== length) {
      // The two framings must agree before a byte is written, or the resume offset
      // is built on a number the request itself contradicts.
      return send(res, 400, { 'cache-control': 'no-store' });
    }

    const release = acquire(ws, req.socket);
    if (release === null) {
      return send(res, 503, {
        'retry-after': String(retryAfterSeconds),
        'cache-control': 'no-store',
      });
    }

    try {
      // The store makes every refusal decision BEFORE it touches the stream, so a
      // 413 or a 507 is answered without the body ever being read.
      const result = await store.appendChunk(ws, sha, {
        offset: range.start,
        total: range.total,
        length,
        stream: req,
      });

      if (result.ok) {
        const headers = {
          'x-shadowlink-received': String(result.received),
          'cache-control': 'no-store',
        };
        if (!result.complete) return send(res, 204, headers);
        headers.etag = `"${sha}"`;
        // 200 for an object the store already held, 201 for one this request
        // created. The client needs neither, but a human reading a log does.
        return send(res, result.deduped === true ? 200 : 201, headers);
      }

      const headers = { 'cache-control': 'no-store' };
      if (result.received !== undefined) {
        headers['x-shadowlink-received'] = String(result.received);
      }
      return send(res, result.code, headers);
    } catch {
      // A reset mid-chunk. Whatever landed is a valid prefix at a known offset, so
      // the next HEAD ?partial=1 tells the client exactly where to resume.
      if (!res.headersSent) send(res, 500, { 'cache-control': 'no-store' });
      else res.destroy();
      return undefined;
    } finally {
      release();
    }
  }

  return { handle };
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-suffix`. null for no header, 'invalid' for 416. */
function parseRange(header, total) {
  if (header === undefined) return null;
  const m = RANGE_RE.exec(String(header).trim());
  if (m === null) return 'invalid';

  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start >= total) return 'invalid';
  const end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
  if (!Number.isInteger(end) || end < start) return 'invalid';
  return { start, end };
}

/** `bytes a-b/total`, with every field checked for internal consistency. */
function parseContentRange(header) {
  if (typeof header !== 'string') return null;
  const m = CONTENT_RANGE_RE.exec(header.trim());
  if (m === null) return null;

  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = Number(m[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
    return null;
  }
  if (total < 1 || end < start || end >= total) return null;
  return { start, end, total };
}
