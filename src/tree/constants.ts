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
