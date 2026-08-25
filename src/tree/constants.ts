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

/**
 * How many bytes one pass may re-hash before it defers the rest (spec §3.5).
 *
 * Step 2.5 asks "is my copy current?" for every attachment, and answers it from
 * one `stat` whenever the recorded size and mtime still agree. The first pass on
 * a cold share has no recorded mtimes at all, so it would otherwise hash the
 * whole share at once — three gigabytes of scans, in one pass, on a phone.
 * Charging each hash against a per-pass budget amortizes that over several
 * passes instead, and a deferral is exactly that: never a report that the file
 * converged.
 *
 * A pass always hashes at least one file, however large, so a share whose
 * smallest attachment exceeds the budget still makes progress.
 */
export const REHASH_BUDGET_BYTES = 268_435_456;         // 256 MB, desktop
export const REHASH_BUDGET_BYTES_MOBILE = 33_554_432;   //  32 MB, mobile

/**
 * The largest attachment this device will hash purely to decide whether a remote
 * tombstone may remove it (spec §5.1).
 *
 * Deliberately lower than the memory cap, and the gap between them is the point:
 * the memory cap answers "could this device hold the whole file at once", this
 * one answers "is answering worth what it costs". Above either, there is no
 * guess — the file is rescued into `ShadowLink Recovered/`, which is what this
 * module does with every other form of ignorance.
 */
export const PROVE_HASH_MAX_BYTES = 67_108_864;         //  64 MB

/**
 * How many BYTES a batch of remote deletions may carry before the circuit
 * breaker asks a human (spec §5.3).
 *
 * A count alone measures the wrong thing for attachments: deleting one 200 MB
 * video is at least as consequential as deleting eleven notes, and the count
 * budget would wave it straight through. The total comes from each node's `b`
 * reference, which is already in the tree, so this condition costs no I/O at all.
 */
export const REMOTE_DELETE_BYTES_ALERT = 104_857_600;   // 100 MB

/**
 * How long the modify handler waits before asking for a reconcile (spec §3.5).
 *
 * Obsidian fires `modify` while a file is still being written, and an editor that
 * saves in three steps fires it three times. Coalescing costs two seconds of
 * latency on a change nobody else is waiting for, and saves a hash (and possibly
 * an upload) of bytes that were about to change again.
 */
export const MODIFY_COALESCE_MS = 2_000;
