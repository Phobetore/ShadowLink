// src/tree/constants.ts
// Single source of truth for P1 tuning constants (spec §10 "Constants").
// Values are deliberate; changing one without re-reading the spec section that
// justifies it is a bug.

export const RECONCILE_DEBOUNCE_MS = 250;
export const DELETE_COALESCE_MS = 500;
export const TICKET_TTL_MS = 10_000;
export const TREE_SYNC_TIMEOUT_MS = 15_000;
export const NOTE_SYNC_TIMEOUT_MS = 8_000;
export const NODE_WAIT_MS = 3_000;
export const PUBLISH_CONCURRENCY = 4;
export const FETCH_CONCURRENCY = 4;
export const PUBLISH_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];
export const RESURRECT_WINDOW_MS = 300_000; // 5 minutes
export const REMOTE_DELETE_BUDGET = 10;
export const REMOTE_DELETE_WINDOW_MS = 600_000; // 10 minutes
export const LOCAL_BULK_DELETE_THRESHOLD = 25;
export const MAX_REL_PATH_LEN = 400;
export const TREE_SNAPSHOT_DEBOUNCE_MS = 2_000;
export const DEVICE_STATE_DEBOUNCE_MS = 1_000;
export const FOUNDER_GRACE_MS = 2_000;
export const FOUNDER_SETTLE_MS = 1_500;
export const FOUNDER_WAIT_CAP_MS = 15_000;
/**
 * How long the tree must stop changing before a client that LOST the founder
 * claim accepts that the founder has finished publishing (spec §4.5 step 5).
 *
 * A founder mints one node per file, each in its own Yjs transaction, so "the
 * tree has a node in it" is a statement about the first frame of a burst, not
 * about the burst being over. Classifying then is what mints a rival node at
 * every path whose node was still in flight.
 */
export const FOUNDER_QUIET_MS = 500;

/** Vault-root folders owned by ShadowLink. Never synced, never inside the share. */
export const RECOVERED_DIR = 'ShadowLink Recovered';
export const STAGING_DIR = 'ShadowLink Staging';

// ---------------------------------------------------------------- attachments (spec §7.4)

/**
 * How long the two `stat`s that decide "this file has stopped being written" are
 * separated by (spec §3.2).
 *
 * Obsidian fires `create` when a file APPEARS, not when it is complete. Publishing
 * between those two moments puts a truncated-but-verified object in the store and
 * hands it to every peer as the real thing — content addressing makes that
 * permanent, because the corrupt bytes hash to exactly the name the tree carries.
 */
export const ATTACHMENT_SETTLE_MS = 400;

/**
 * The largest attachment this device will hold in memory, in either direction.
 *
 * It gates every WHOLE-FILE allocation, not just downloads: `createBinary` takes a
 * whole buffer, `requestUrl`/`fetch` buffer a whole response, and Web Crypto has no
 * incremental digest API, so there is no honest streaming path that also runs on a
 * phone. A cap applied only to fetches leaves the two paths that most reliably kill
 * a mobile renderer — the first-pass hash sweep and publishing a screen recording
 * made on that phone — completely unguarded.
 */
export const BLOB_MAX_BYTES = 104_857_600;          // 100 MB, desktop
export const BLOB_MAX_BYTES_MOBILE = 33_554_432;    //  32 MB, mobile

/**
 * Attachment publishes run in their own lane, so one video upload cannot occupy
 * all four markdown slots and park every note's publication behind it.
 */
export const BLOB_PUBLISH_CONCURRENCY = 2;
