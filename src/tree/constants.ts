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

// ---------------------------------------------------------------- the mux (P3 spec §8.1)

/**
 * The backoff ladder for the ONE socket a vault holds (P3 spec §2, §8.1).
 *
 * One ladder for the whole link rather than one per room is the entire point of
 * the mux on the client side: at 2,000 live rooms, per-room reconnect loops are
 * 2,000 independent timers racing each other onto the same TCP accept queue, and
 * this machine already reproduces `ECONNREFUSED` at 300 simultaneous connects.
 *
 * ⚠ THE TOP RUNG USED TO BE 60 SECONDS, AND IT WAS PROTECTING THE WRONG THING.
 * The ladder exists so that N DEVICES coming back together do not stampede a
 * server; it is not a reason to make one device wait. Measured against a real
 * server stopped for thirty seconds and restarted on the same port and data dir:
 * a `WebsocketProvider` on that server resynced in 649 ms, the mux link in
 * 52,703 ms. `TREE_SYNC_TIMEOUT_MS` is 15 s, so any bootstrap or reconnect
 * landing in that window reported "ShadowLink could not reach the workspace" and
 * dropped the plugin to read-only against a server that was up.
 *
 * The mux already removed the pressure the long tail was buying: y-websocket
 * capped at 2,500 ms PER PROVIDER, so a vault with N open rooms dialled N times
 * per 2.5 s. One link at a 5 s cap is strictly gentler than the topology this
 * replaces, and 12× faster to recover than 60 s. Anything user-visible also gets
 * `connect({ immediate: true })`, which does not wait for a rung at all.
 */
export const MUX_RECONNECT_BACKOFF_MS = [1_000, 2_000, 3_000, 5_000];

/**
 * How far either side of a backoff rung the next attempt may land, as a fraction.
 *
 * A fleet that went offline together comes back together, and an unjittered
 * ladder turns that into a synchronized retry storm on every rung — the thundering
 * herd the ladder exists to avoid. ±25% is enough to smear a share's worth of
 * devices across the window without materially changing what the ladder promises.
 */
export const MUX_RECONNECT_JITTER = 0.25;

/**
 * How long a connected mux socket may stay silent before the client concludes the
 * server does not speak the mux protocol at all (P3 spec §4 "Compatibility").
 *
 * ⚠ This is a BACKSTOP, not the mechanism. A pre-P3 server accepts the `/_mux`
 * upgrade — `_mux` matches its `DOC_RE`, so `authorizeUpgrade` is satisfied and
 * `DocHub` serves it as an ordinary room called `_mux` — and it then sends a raw
 * y-websocket SyncStep1 immediately, which is not a well-formed mux frame for any
 * room this client subscribed. That is the detection in practice, and it lands in
 * one round trip. This timeout only covers a server that says nothing at all.
 */
export const MUX_DETECT_TIMEOUT_MS = 10_000;

/**
 * How long a CONNECTED mux socket may receive nothing at all before the link
 * concludes it is dead and closes it (P3 spec §2 "Liveness").
 *
 * ⚠ THIS IS y-websocket's `messageReconnectTimeout`, restored. A socket can be
 * OPEN and dead — a dropped NAT flow, a slept laptop, a wifi handover — and
 * `readyState` never moves, so nothing that reads it can tell. Measured through a
 * TCP proxy that stops forwarding without a FIN or an RST: a `WebsocketProvider`
 * on the frozen path noticed at 30,266 ms; a link without this timer reported
 * `connected` and `synced` for the whole 78 s the probe watched, and would have
 * done so for ever.
 *
 * 30 s is not arbitrary. A healthy idle link is NOT quiet: every room's awareness
 * re-broadcasts its own state every 15 s and `DocHub` echoes it back to the
 * sender, which is what feeds y-websocket's watchdog too. Measured on a healthy
 * idle mux link against the real server: six inbound messages in 95 s, gaps of
 * 15029/15030/15040/15040/15041/15036 ms. 30 s is two heartbeats of headroom.
 */
export const MUX_IDLE_TIMEOUT_MS = 30_000;

/**
 * How long a dial may take before it is counted as a failed attempt.
 *
 * `MuxLink.open()` assigns `this.socket` before the socket opens and `connect()`
 * refuses to dial while one exists, so a dial that HANGS — the TCP connection
 * accepted and the HTTP upgrade never answered, which is what a misconfigured
 * reverse proxy does — parked the link for ever with no timer armed. Measured: 1
 * dial, 0 timers, still 1 dial 45 s later.
 */
export const MUX_CONNECT_TIMEOUT_MS = 4_000;

/**
 * How many dials in a row may fail to produce an OPEN socket before the link
 * says so out loud (P3 spec §4).
 *
 * Every other route into the legacy verdict needs a socket that opened, so a
 * refused or black-holed `/_mux` upgrade reached nothing at all. This is the
 * signal that covers it. It is NOT a verdict on its own — a server that is merely
 * down fails dials the same way — so it is reported rather than latched, and the
 * bridge is what decides, by checking whether the per-room route works.
 */
export const MUX_UNREACHABLE_DIALS = 2;

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
 * The largest attachment this device downloads WITHOUT ASKING (spec §7.2).
 *
 * Deliberately far below the memory cap, because the two answer different
 * questions: the cap is "could this device hold the whole file at once", this one
 * is "would the user expect this to arrive on its own". A 40 MB video that syncs
 * silently onto a phone on a hotel connection is not a feature.
 *
 * Above it the node is deferred and the deferral is PERSISTED, so the download
 * button in the note and the download commands both know the file exists and how
 * big it is, without a pass having to be running.
 */
export const AUTOFETCH_MAX_BYTES = 10_485_760;          //  10 MB, desktop
export const AUTOFETCH_MAX_BYTES_MOBILE = 2_097_152;    //   2 MB, mobile

/**
 * How many bytes one SESSION fetches unattended, across every attachment (§7.2).
 *
 * The second gate, and the reason a per-file ceiling alone is not enough: four
 * thousand files of one megabyte each pass every per-file check that has ever
 * been written and still eat a data plan. Charged only on a COMPLETED fetch, so a
 * flaky link cannot burn the whole allowance retrying one file, and deliberately
 * NOT persisted — it is a statement about this afternoon, not about the share, so
 * the next session starts from zero and picks up where this one stopped.
 */
export const AUTOFETCH_SESSION_BUDGET = 536_870_912;        // 512 MB, desktop
export const AUTOFETCH_SESSION_BUDGET_MOBILE = 20_971_520;  //  20 MB, mobile

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
