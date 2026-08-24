// src/sync/ObsidianBlobPort.ts
// `BlobPort` (spec §8.3) over the server's HTTP blob routes (§6.3).
//
// NO `obsidian` IMPORT. The spec expected this to be the fourth file allowed one,
// over `requestUrl`; it turned out not to need it. Plain `fetch` is present on
// desktop and on mobile, it streams a response instead of buffering it the way
// `requestUrl` does, and staying headless is what lets this file be tested
// against the real server rather than against a mock of it. The one thing
// `requestUrl` would have bought is bypassing CORS, which does not arise here:
// the server sets no CORS policy and Obsidian's renderer is not a browser origin
// making cross-site requests. If a self-hoster ever puts a CORS-enforcing proxy
// in front, THAT is the moment to reconsider — and it is a one-method change,
// because every request in this file goes through `send()`.
//
// THE THREE FAILURE SHAPES, which are the whole reason this file is long:
//
//  * `has` THROWS for anything that is not a definite 200 or 404. It must never
//    answer `false` for "I could not ask": a definite false at deletion time means
//    RESCUE and a true means the local bytes are safe to trash (I2).
//  * `put` returns FALSE for 413 / 507 / 422 — refusals a human has to be told
//    about — with `lastError` carrying which, and THROWS for transport and for 503,
//    which the publish ladder retries on its persisted backoff.
//  * `get` returns NULL for every failure, and verifies the LENGTH and the DIGEST
//    before returning anything at all. An incomplete or unverifiable fetch is a
//    no-op, never a partial write.
//
// AND BOTH ENDS VERIFY. The server rehashes what it assembled before renaming it
// into place; this port rehashes what it received before handing it to the vault,
// and rehashes what it is about to send before sending it. Neither end trusts the
// other's arithmetic, which is what makes "the hash in the tree names these exact
// bytes" enforceable rather than conventional.

import { hashOfBytes } from '../tree/paths.ts';
import {
  BlobBusy,
  BlobDigestMismatch,
  BlobQuotaExceeded,
  BlobTooLarge,
  BlobTransport,
  BlobUnavailable,
} from './BlobPort.ts';
import type { BlobLimits, BlobPort, BlobPresence } from './BlobPort.ts';

/** Matches the client's `BLOB_CHUNK_BYTES` and the server's default. */
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ObsidianBlobPortConfig {
  /** `ws://host:port`, `wss://…`, or the http form. No trailing slash needed. */
  serverUrl: string;
  serverKey: string;
  workspaceId: string;
  chunkBytes?: number;
  /**
   * Injected only by tests, which drive this against the real routes over a real
   * socket. Production takes the global.
   */
  fetchImpl?: typeof fetch;
}

export class ObsidianBlobPort implements BlobPort {
  private readonly base: string;
  private readonly serverKey: string;
  private readonly workspaceId: string;
  private readonly chunkBytes: number;
  private readonly doFetch: typeof fetch;

  private lastErrorValue: unknown = null;

  constructor(config: ObsidianBlobPortConfig) {
    this.base = httpBase(config.serverUrl);
    this.serverKey = config.serverKey;
    this.workspaceId = config.workspaceId;
    this.chunkBytes = config.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.doFetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get lastError(): unknown {
    return this.lastErrorValue;
  }

  // ------------------------------------------------------------------ has

  /**
   * The dedup probe before an upload, and the confirmation before a local
   * deletion. THROWS for anything that is not a definite answer.
   */
  async has(sha256: string): Promise<BlobPresence> {
    const res = await this.send('HEAD', this.blobUrl(sha256));
    if (res.status === 200) {
      const declared = Number(res.headers.get('content-length'));
      return Number.isFinite(declared) && declared >= 0
        ? { present: true, bytes: declared }
        : { present: true };
    }
    if (res.status === 404) return { present: false };
    throw this.record(errorFor(res, `has(${sha256})`));
  }

  // ------------------------------------------------------------------ put

  /**
   * Chunked and resumable. One `HEAD ?partial=1` establishes where to start —
   * which also short-circuits an object the workspace already holds, because the
   * store reports a complete object's full length and a partial is by construction
   * shorter than its total.
   */
  async put(
    sha256: string,
    data: Uint8Array,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<boolean> {
    this.lastErrorValue = null;

    if (data.length === 0) {
      // The routes cannot express a zero-length object (`bytes a-b/total` has no
      // spelling for it) and nothing upstream should ever offer one: a 0-byte file
      // is exactly what the publish settle check refuses.
      return this.refuse(new BlobDigestMismatch(`put(${sha256}): refusing a zero-length object`));
    }
    // The port recomputes the digest ITSELF rather than trusting the caller's:
    // sending bytes under a name they do not hash to would burn the whole upload
    // on a 422 the server can only discover at the very end.
    if (await hashOfBytes(data) !== sha256) {
      return this.refuse(new BlobDigestMismatch(
        `put(${sha256}): the bytes do not hash to that name`,
      ));
    }

    const url = this.blobUrl(sha256);
    let sent = await this.resumeOffset(sha256);
    if (sent >= data.length) {
      onProgress?.(data.length, data.length);
      return true;                                  // already stored, byte for byte
    }
    onProgress?.(sent, data.length);

    // A 409 re-seek is legitimate but must not be able to loop for ever: two
    // re-seeks per chunk plus a fixed allowance is generous and still bounded.
    let steps = 0;
    const maxSteps = Math.ceil(data.length / this.chunkBytes) * 3 + 8;

    while (sent < data.length) {
      if (++steps > maxSteps) {
        throw this.record(new BlobTransport(`put(${sha256}): too many re-seeks`));
      }
      const end = Math.min(sent + this.chunkBytes, data.length);
      const res = await this.send('PATCH', url, {
        body: data.subarray(sent, end),
        headers: {
          'content-range': `bytes ${sent}-${end - 1}/${data.length}`,
          'content-type': 'application/octet-stream',
        },
      });

      switch (res.status) {
        case 200:                                   // already held: dedup
        case 201:                                   // stored and verified by the server
          onProgress?.(data.length, data.length);
          return true;

        case 204: {
          sent = this.offsetFrom(res, sha256, end, data.length);
          onProgress?.(sent, data.length);
          break;
        }

        case 409: {
          // The server holds a different prefix than we assumed. Re-seek rather
          // than append over its bytes — this is what stops a resumed upload
          // producing an object that hashes to nothing.
          sent = this.offsetFrom(res, sha256, null, data.length);
          onProgress?.(sent, data.length);
          break;
        }

        // The three refusals a human has to be told about.
        case 413:
          return this.refuse(new BlobTooLarge(
            `put(${sha256}): ${data.length} bytes is over the server's per-file limit`,
          ));
        case 507:
          return this.refuse(new BlobQuotaExceeded(
            `put(${sha256}): the server has no room for ${data.length} bytes`,
          ));
        case 422:
          return this.refuse(new BlobDigestMismatch(
            `put(${sha256}): the server rehashed what it assembled and refused it`,
          ));

        default:
          // 503 included: busy is transport, and the publish ladder retries it.
          throw this.record(errorFor(res, `put(${sha256})`));
      }
    }

    // The loop can only leave here by a re-seek landing exactly on the total,
    // which the store reports only for an object it has already finalised.
    onProgress?.(data.length, data.length);
    return true;
  }

  // ------------------------------------------------------------------ get

  /**
   * Range-based and resumable, verified before it returns. NULL for every failure,
   * including an abort: invariant I2 makes an incomplete fetch a no-op, and the
   * caller must never be handed bytes it could then write to the vault unverified.
   */
  async get(
    sha256: string,
    expectBytes: number,
    signal?: AbortSignal,
    onProgress?: (received: number, total: number) => void,
  ): Promise<Uint8Array | null> {
    this.lastErrorValue = null;

    if (!Number.isInteger(expectBytes) || expectBytes < 0) {
      return this.fail(new BlobTransport(`get(${sha256}): bad expected length ${expectBytes}`));
    }

    try {
      const url = this.blobUrl(sha256);
      const out = new Uint8Array(expectBytes);
      let received = 0;

      while (received < expectBytes) {
        if (signal?.aborted === true) {
          return this.fail(new BlobTransport(`get(${sha256}): aborted`));
        }
        const end = Math.min(received + this.chunkBytes, expectBytes) - 1;
        const res = await this.send('GET', url, {
          headers: { range: `bytes=${received}-${end}` },
          signal,
        });

        if (res.status === 404) {
          // The ONLY answer that is about the bytes — and even it is never a
          // delete: it becomes a permanently pending materialization (I2).
          return this.fail(new BlobUnavailable(`get(${sha256}): the store does not hold it`));
        }
        if (res.status !== 200 && res.status !== 206) {
          return this.fail(errorFor(res, `get(${sha256})`));
        }

        const total = totalFromContentRange(res.headers.get('content-range'));
        if (total !== null && total !== expectBytes) {
          return this.fail(new BlobDigestMismatch(
            `get(${sha256}): the store holds ${total} bytes, the tree says ${expectBytes}`,
          ));
        }

        const body = new Uint8Array(await res.arrayBuffer());
        if (res.status === 200) {
          // A server or proxy that ignored the Range and sent the whole object.
          if (body.length !== expectBytes) {
            return this.fail(new BlobTransport(
              `get(${sha256}): expected ${expectBytes} bytes, got ${body.length}`,
            ));
          }
          out.set(body, 0);
          received = expectBytes;
        } else {
          if (body.length === 0 || received + body.length > expectBytes) {
            return this.fail(new BlobTransport(
              `get(${sha256}): a range reply of ${body.length} bytes at ${received}`,
            ));
          }
          out.set(body, received);
          received += body.length;
        }
        onProgress?.(received, expectBytes);
      }

      // BOTH ends verify. What came back is checked against the name it was asked
      // for, so a corrupted store, a truncating proxy or a mistaken server cannot
      // put wrong bytes at the canonical path.
      if (await hashOfBytes(out) !== sha256) {
        return this.fail(new BlobDigestMismatch(
          `get(${sha256}): what arrived does not hash to that name`,
        ));
      }
      return out;
    } catch (err) {
      return this.fail(err);
    }
  }

  // --------------------------------------------------------------- limits

  /** Fetched once per session, and re-fetched after any 413 or 507. */
  async limits(): Promise<BlobLimits> {
    const res = await this.send('GET', `${this.base}/blob/${this.workspaceId}/limits`);
    if (res.status !== 200) throw this.record(errorFor(res, 'limits()'));

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw this.record(new BlobTransport(`limits(): unparseable reply (${String(err)})`));
    }

    const value = parsed as { maxFileBytes?: unknown; freeBytes?: unknown };
    const maxFileBytes = value?.maxFileBytes;
    const freeBytes = value?.freeBytes;
    if (typeof maxFileBytes !== 'number' || !Number.isFinite(maxFileBytes) || maxFileBytes < 0) {
      throw this.record(new BlobTransport(`limits(): bad maxFileBytes ${String(maxFileBytes)}`));
    }
    if (freeBytes !== null && (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes))) {
      throw this.record(new BlobTransport(`limits(): bad freeBytes ${String(freeBytes)}`));
    }
    return { maxFileBytes, freeBytes: freeBytes as number | null };
  }

  // ------------------------------------------------------------ internals

  private blobUrl(sha256: string): string {
    return `${this.base}/blob/${this.workspaceId}/${sha256}`;
  }

  /**
   * `HEAD ?partial=1`. The upload is its own session — the partial is keyed by the
   * content hash — so this is the only state a resume needs, on either side.
   */
  private async resumeOffset(sha256: string): Promise<number> {
    const res = await this.send('HEAD', `${this.blobUrl(sha256)}?partial=1`);
    if (res.status !== 204 && res.status !== 200) {
      throw this.record(errorFor(res, `resume(${sha256})`));
    }
    const offset = Number(res.headers.get('x-shadowlink-received'));
    return Number.isInteger(offset) && offset >= 0 ? offset : 0;
  }

  /** The offset the server reported, refused unless it is usable. */
  private offsetFrom(
    res: Response,
    sha256: string,
    fallback: number | null,
    total: number,
  ): number {
    const raw = res.headers.get('x-shadowlink-received');
    const offset = Number(raw);
    if (Number.isInteger(offset) && offset >= 0 && offset <= total) return offset;
    if (fallback !== null) return fallback;
    // Without a usable offset there is nowhere safe to continue from, and guessing
    // is how a resumed upload silently assembles bytes that hash to nothing.
    throw this.record(new BlobTransport(
      `put(${sha256}): the server refused a chunk without a usable offset (${String(raw)})`,
    ));
  }

  private async send(
    method: string,
    url: string,
    options: { body?: Uint8Array; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      // A HEADER, never a query parameter: a query string lands in access logs,
      // proxy logs and browser history, and this endpoint is hit hundreds of times
      // per session where the WebSocket upgrade is hit once.
      authorization: `Bearer ${this.serverKey}`,
      ...(options.headers ?? {}),
    };
    try {
      return await this.doFetch(url, {
        method,
        headers,
        body: options.body as BodyInit | undefined,
        signal: options.signal,
        // The bytes are content-addressed and immutable, but a HEAD must never be
        // answered from a cache: it decides dedup and it confirms a deletion.
        cache: 'no-store',
      });
    } catch (err) {
      throw this.record(new BlobTransport(`${method} ${url} failed: ${String(err)}`));
    }
  }

  /** A refusal the user is told about: false, with the reason retained. */
  private refuse(error: unknown): false {
    this.lastErrorValue = error;
    return false;
  }

  /** A `get` failure: null, with the reason retained. `get` never throws. */
  private fail(error: unknown): null {
    this.lastErrorValue = error;
    return null;
  }

  /** Retain the reason for a throw too, so callers can inspect it uniformly. */
  private record<T>(error: T): T {
    this.lastErrorValue = error;
    return error;
  }
}

/**
 * The relay's URL is a WebSocket URL; the blob routes ride the same host and port
 * over HTTP. Converting here rather than asking for a second setting is what keeps
 * "one port, one URL, one key" true for a self-hoster.
 */
function httpBase(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`;
  return trimmed;
}

/** The `/total` of a `content-range: bytes a-b/total`, when the server sent one. */
function totalFromContentRange(header: string | null): number | null {
  if (header === null) return null;
  const match = /^bytes \d+-\d+\/(\d+)$/.exec(header.trim());
  if (match === null) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Status to typed error. The distinctions are the point: collapsing them into one
 * type is how "the network was down" becomes "the file was deleted".
 */
function errorFor(res: Response, context: string): Error {
  switch (res.status) {
    case 404: return new BlobUnavailable(`${context}: not stored`);
    case 413: return new BlobTooLarge(`${context}: over the per-file limit`);
    case 422: return new BlobDigestMismatch(`${context}: digest mismatch`);
    case 503: {
      const raw = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(raw) && raw > 0 ? raw : null;
      return new BlobBusy(`${context}: the server is at its transfer cap`, retryAfter);
    }
    case 507: return new BlobQuotaExceeded(`${context}: the store is full`);
    default: return new BlobTransport(`${context}: HTTP ${res.status}`);
  }
}
