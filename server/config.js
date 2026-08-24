// server/config.js
const VALID_TTL = ['session', '24h', '7d', '30d', 'permanent'];

/**
 * A whole non-negative number, or a thrown error.
 *
 * `parseInt` is not used, and the reason matters: `parseInt('unlimited')` is NaN,
 * every comparison against NaN is false, and a setting that reads NaN therefore
 * does not raise its ceiling — it REMOVES it. Since P2 these numbers gate real
 * refusals (a 100 MB per-file cap, a 10 GB quota, a six-transfer concurrency cap),
 * so a typo that silently disabled one would be discovered by a full disk rather
 * than by a message. Refusing at boot is the same discipline `ROOM_DEFAULT_TTL`
 * already applies, and a server that will not start is a better failure than one
 * that starts with no limits.
 */
function whole(env, key, fallback, { min = 0 } = {}) {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (raw === '' || !Number.isInteger(value) || value < min) {
    throw new Error(
      `Invalid ${key}: "${raw}". Must be a whole number ${min > 0 ? `of at least ${min}` : '0 or greater'}.`,
    );
  }
  return value;
}

export function loadConfig(env = process.env) {
  const roomDefaultTtl = env.ROOM_DEFAULT_TTL ?? 'permanent';
  if (!VALID_TTL.includes(roomDefaultTtl)) {
    throw new Error(`Invalid ROOM_DEFAULT_TTL: "${roomDefaultTtl}". Must be one of: ${VALID_TTL.join(', ')}`);
  }
  return {
    port:                     whole(env, 'PORT', 4000, { min: 1 }),

    // ---------------------------------------------------------------- blobs
    // Every one of these was inert until P2-b; `MAX_FILE_SIZE_MB` and
    // `MAX_TOTAL_STORAGE_GB` had defaults chosen when nothing read them.

    /**
     * Per attachment. 100, down from 700: the client holds a whole file in memory
     * to hash it, Obsidian's mobile API offers no streaming binary write and Web
     * Crypto no incremental digest, so there is no honest path on which 700 MB
     * ever completes on the far end (spec §7.4).
     */
    maxFileSizeMb:            whole(env, 'MAX_FILE_SIZE_MB', 100, { min: 1 }),
    /**
     * Across the whole blob store, `incoming/` included. 10, up from 0: an
     * unbounded store fills the volume `DocHub` writes its snapshots to, and that
     * failure lands in `lastPersistError` where nothing surfaces it. 0 still means
     * unlimited, for a self-hoster who would rather watch the disk themselves.
     */
    maxTotalStorageGb:        whole(env, 'MAX_TOTAL_STORAGE_GB', 10),
    /** How long a resumable `.part` survives without progress. Swept on boot and on a timer. */
    incompleteUploadTtlHours: whole(env, 'INCOMPLETE_UPLOAD_TTL_HOURS', 24),
    /**
     * Concurrent blob transfers per workspace (2 per connection). Without a cap,
     * four large uploads plus a Range download share the event loop with every
     * `Y.applyUpdate`, and real-time text degrades to visible keystroke latency
     * for everyone on the deployment.
     */
    maxBlobConcurrency:       whole(env, 'MAX_BLOB_CONCURRENCY', 6, { min: 1 }),
    /**
     * The chunk the client PATCHes, bounding both the request body and the
     * per-chunk work on the event loop. Read by the client through its own
     * constant today; declared here so a self-hoster tuning a slow link has one
     * place to look. The server accepts any chunk that is internally consistent.
     */
    blobChunkBytes:           whole(env, 'BLOB_CHUNK_BYTES', 4_194_304, { min: 1 }),
    /**
     * How long an unreferenced blob survives before the OFFLINE admin sweeper may
     * move it to `.attic/`. The server itself never removes a blob — there is no
     * DELETE route and no automatic collection — so nothing in this process reads
     * this yet; the sweeper (P2-f) will.
     */
    blobOrphanTtlDays:        whole(env, 'BLOB_ORPHAN_TTL_DAYS', 90),

    // ---------------------------------------------------------------- rest
    persistenceDir:           env.PERSISTENCE_DIR ?? './data',
    roomDefaultTtl,
    rateLimitOpsPerSec:       whole(env, 'RATE_LIMIT_OPS_PER_SEC', 10),
    maxConnectionsPerIp:      whole(env, 'MAX_CONNECTIONS_PER_IP', 50),
    sessionCloseTimeoutMs:    whole(env, 'SESSION_CLOSE_TIMEOUT_MS', 5000),
  };
}
