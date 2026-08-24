// src/sync/BlobPort.ts
// The engine's only door to the attachment store (spec §8.3).
//
// Like every other port here, this exists so the engine runs headless: `FakeBlobs`
// in `fakes.ts` is an in-memory content-addressed store implementing exactly this
// surface, and `ObsidianBlobPort` is the same surface over HTTP. Nothing in this
// file may import `obsidian`.
//
// THE THREE FAILURE SHAPES ARE DIFFERENT ON PURPOSE, and getting one wrong is a
// data-loss bug rather than a cosmetic one:
//
//  * `has` THROWS on transport failure. It must never answer `false` for "I could
//    not ask", because a definite `false` at deletion time means RESCUE and a
//    `true` means the bytes are safe to trash locally (I2). Collapsing the two is
//    how a flaky network deletes somebody's file.
//  * `put` returns FALSE for a refusal the user has to be told about — too large,
//    no room, the digest did not match — with `lastError` carrying which, and
//    THROWS for transport, which the publish ladder retries on its persisted
//    backoff. A refusal that threw would be retried for ever; a transport failure
//    that returned false would be reported to the user as a permanent refusal.
//  * `get` returns NULL for every failure at all, and verifies the digest BEFORE
//    returning anything. An incomplete or unverifiable fetch is a no-op, never a
//    partial write (I2).
//
// The typed errors below are not decoration either: collapsing them into one type
// is precisely how "the network was down" becomes "the file was deleted".

/** What `GET /blob/<ws>/limits` answers. `freeBytes` is null when unlimited. */
export interface BlobLimits {
  maxFileBytes: number;
  freeBytes: number | null;
}

export interface BlobPresence {
  present: boolean;
  /** Present only when `present` is true. */
  bytes?: number;
}

export interface BlobPort {
  /**
   * HEAD. THROWS on transport failure — never answers false for "I could not
   * ask" (I2). Never answered from a cache: it is both the dedup probe before an
   * upload and the confirmation before a local deletion.
   */
  has(sha256: string): Promise<BlobPresence>;

  /**
   * Chunked, resumable PATCH. Returns FALSE for a refusal the user must be told
   * about (413/507/422) with `lastError` carrying it; THROWS for transport, which
   * the publish ladder retries. Resolves true only on a stored, verified object.
   */
  put(
    sha256: string,
    data: Uint8Array,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<boolean>;

  /**
   * Resumable, Range-based GET, digest-verified BEFORE returning. NULL on any
   * failure at all — I2 says an incomplete fetch is a no-op, never a partial write.
   */
  get(
    sha256: string,
    expectBytes: number,
    signal?: AbortSignal,
    onProgress?: (received: number, total: number) => void,
  ): Promise<Uint8Array | null>;

  /** Server ceilings, fetched once per session and re-fetched after a 413/507. */
  limits(): Promise<BlobLimits>;

  /** Why the most recent refusal or null answer happened. */
  readonly lastError: unknown;
}

/** 413 — the object is over the server's per-file cap. */
export class BlobTooLarge extends Error {}

/** 507 — the store has no room. The node stays unpublished and the entry retries. */
export class BlobQuotaExceeded extends Error {}

/** 422, or a failed LOCAL verify: what arrived is not what the name says. */
export class BlobDigestMismatch extends Error {}

/** 404 — the ONLY error that is about the bytes, and even it is never a delete. */
export class BlobUnavailable extends Error {}

/** 503 — the server is at its transfer cap. Retry after the interval it named. */
export class BlobBusy extends Error {
  constructor(message: string, readonly retryAfterSeconds: number | null = null) {
    super(message);
  }
}

/** Everything else: a socket, a proxy, a 500, a truncated response. */
export class BlobTransport extends Error {}
