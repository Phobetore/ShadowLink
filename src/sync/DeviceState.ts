// src/sync/DeviceState.ts
// Per-device, non-CRDT state (spec §2.5) behind an injected storage port.
//
// Everything here is a LOCAL fact about this machine: which node is materialized
// at which path, which nodes this device may publish, what the user already
// declined, and how many remote deletions have been applied recently. None of it
// belongs in the tree document, because none of it is true for any other peer.
//
// The load path is the security-relevant part. `.obsidian/` is replicated
// wholesale by Obsidian Sync and by git-based vault sync, so a state file written
// by a different machine routinely appears in this machine's plugin directory.
// Applying its `materialized` map here would replay another machine's layout as a
// mass relocation, and applying its `declinedNodes` would silently disable
// deletions. So the file is trusted only when it names THIS device and THIS
// workspace, and is discarded whole otherwise. A cold start is not an error —
// every map below is re-derivable from the tree plus the disk (spec §4.5).
//
// No `obsidian` import, no node builtins.

import {
  DEVICE_STATE_DEBOUNCE_MS,
  REMOTE_DELETE_BUDGET,
  REMOTE_DELETE_WINDOW_MS,
} from '../tree/constants.ts';
import { isValidWorkspaceId } from '../tree/ids.ts';

/**
 * Persistence for one opaque blob.
 *
 * This used to promise an ATOMIC write — "`.tmp`, then `adapter.rename`" — and
 * the real implementation cannot keep it. Obsidian's adapter refuses a rename
 * onto an occupied destination, deterministically and on every platform, so only
 * the FIRST write of a key is atomic and every one after it overwrites the live
 * file in place. `ObsidianStatePort.ts`'s header has the whole story, including
 * what a crash inside that window costs and why the removal call that would
 * change it was weighed and refused.
 *
 * What survives of the promise, and what `load()` below is built on: a torn state
 * file read back on the next start is indistinguishable from a corrupt one, so it
 * must cold-start rather than partially adopt.
 */
export interface StatePort {
  read(key: string): Promise<string | null>;
  write(key: string, data: string): Promise<void>;
}

export interface PublishEntry {
  state: 'pending' | 'done';
  attempts: number;
  nextAt: number;
  /**
   * The content this entry was queued to publish — for an attachment, the sha256
   * of the bytes on disk when it was queued. Markdown publication happens once, so
   * a note's entry carries none; attachment publication repeats, so the intent is
   * what lets a requeue tell "the same work, already queued" from "new bytes".
   */
  intent?: string;
}

export interface ContentHashEntry {
  sha256: string;
  len: number;
  /**
   * The file's modification time when the hash was recorded. The cheap staleness
   * oracle: the recorded hash is trusted only when size AND mtime still agree.
   * Optional, because a device that never observed one must re-hash rather than
   * assume.
   */
  mtime?: number;
}

export interface StagingEntry {
  from: string;
  to: string;
  at: number;
}

/** Spec §2.5. */
export interface DeviceStateData {
  v: 1;
  deviceId: string;
  workspaceId: string;
  /** nodeId -> the vault path this device actually wrote it to. */
  materialized: Record<string, string>;
  /** nodeIds this device created, and may therefore publish (spec R-S1, invariant I5). */
  owned: Record<string, true>;
  publish: Record<string, PublishEntry>;
  /** Last CONFIRMED document text per node — the basis of the `proven` check in §5.3. */
  contentHash: Record<string, ContentHashEntry>;
  /** Remote deletes the user chose to keep locally. */
  declinedNodes: string[];
  /** fold(vaultPath) of the same, so a lost nodeId cannot re-share them (invariant I13). */
  declinedPaths: string[];
  /** Applied remote deletions, for the rate window (§5.4). */
  deleteBudget: Array<{ at: number }>;
  staging: Record<string, StagingEntry>;

  // ------------------------------------------------- attachments (spec §8.4)
  //
  // All three are LOCAL facts about this machine's fetching decisions, which is
  // why they are here and not in the tree: another device's disk, budget and
  // dismissed notices are none of this one's business.

  /**
   * nodeId -> attachment BYTES this device chose not to fetch yet (§7.2).
   *
   * Usually there is nothing on disk for it at all — the node was never
   * materialized here. It also covers the narrower case where an older version IS
   * on disk and the REPLACEMENT was held back, which from the user's side is the
   * same fact ("this version has not been downloaded") and takes the same remedy.
   * The `sha256` says which of the two it is: it always names the bytes the tree
   * wants here, never the bytes on disk.
   *
   * A session-budget refusal is deliberately absent from here — that is a
   * statement about one run of the plugin, not about the share.
   */
  fetchDeferred: Record<string, { sha256: string; bytes: number }>;
  /** nodeIds the user explicitly approved for fetching despite the policy. */
  fetchApproved: Record<string, true>;
  /**
   * fold(vaultPath) -> why a local file could not be published. Persisted so a
   * refusal is explained once rather than re-announced on every pass, and dropped
   * again when the file shrinks below the cap.
   */
  oversized: Record<string, { bytes: number; cap: number; why: 'server' | 'device' }>;
}

/** The schema version this client writes and accepts. */
const STATE_VERSION = 1;

/**
 * Filename within the plugin's data directory; the port resolves the directory.
 *
 * The id is CHECKED here, not trusted, and this is the half of that check that is
 * a safety property. The settings tab refuses an unusable id at the keystroke,
 * which protects ids typed since it started doing so — while `data.json` is a
 * plain file people open, it is replicated between machines by everything that
 * syncs `.obsidian/`, and it was written by whatever version of this plugin ran
 * last. `ObsidianStatePort` joins what comes back from here onto
 * `.obsidian/plugins/shadowlink/` with `normalizePath`, and `normalizePath` tidies
 * slashes without resolving `..`.
 *
 * A THROW, never a substitute name (I15). A refusal costs a cold start, which is
 * recoverable by construction (spec §4.5) and loses nothing; quietly falling back
 * to some other filename would let two workspaces share one state file, each
 * discarding the other's on load, for ever and without a word.
 */
export function deviceStateKey(workspaceId: string, deviceId: string): string {
  if (!isValidWorkspaceId(workspaceId)) {
    throw new Error(
      'ShadowLink: refusing to name a device-state file after an unusable workspace id: '
      + JSON.stringify(workspaceId),
    );
  }
  return `state-${workspaceId}-${deviceId}.json`;
}

export function emptyDeviceState(deviceId: string, workspaceId: string): DeviceStateData {
  return {
    v: STATE_VERSION,
    deviceId,
    workspaceId,
    materialized: {},
    owned: {},
    publish: {},
    contentHash: {},
    declinedNodes: [],
    declinedPaths: [],
    deleteBudget: [],
    staging: {},
    fetchDeferred: {},
    fetchApproved: {},
    oversized: {},
  };
}

/** A content hash as it is written on the wire and on disk: 64 lowercase hex. */
const SHA256_RE = /^[0-9a-f]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keep only the entries whose value survives `pick`. Everything else is dropped. */
function recordOf<T>(v: unknown, pick: (value: unknown) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    const value = pick(raw);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Rebuild a trusted `DeviceStateData` from parsed JSON, field by field.
 *
 * This is not paranoia about a malicious file: it is a plain JSON document in a
 * directory users open, and a hand edit or a partially-synced copy must not leave
 * `undefined` where the reconciler will index a map.
 */
function normalize(raw: Record<string, unknown>, deviceId: string, workspaceId: string): DeviceStateData {
  return {
    v: STATE_VERSION,
    deviceId,
    workspaceId,
    materialized: recordOf(raw.materialized, (x) => (typeof x === 'string' ? x : undefined)),
    owned: recordOf(raw.owned, (x) => (x === true ? (true as const) : undefined)),
    publish: recordOf(raw.publish, (x) => {
      if (!isRecord(x)) return undefined;
      if (x.state !== 'pending' && x.state !== 'done') return undefined;
      if (typeof x.attempts !== 'number' || typeof x.nextAt !== 'number') return undefined;
      const entry: PublishEntry = { state: x.state, attempts: x.attempts, nextAt: x.nextAt };
      // A bad intent costs the intent, not the entry: the work is still owed, it
      // simply has to be re-decided rather than matched.
      if (typeof x.intent === 'string') entry.intent = x.intent;
      return entry;
    }),
    contentHash: recordOf(raw.contentHash, (x) => {
      if (!isRecord(x)) return undefined;
      if (typeof x.sha256 !== 'string' || typeof x.len !== 'number') return undefined;
      const entry: ContentHashEntry = { sha256: x.sha256, len: x.len };
      // Likewise: without a usable mtime the entry still says what this device last
      // confirmed, it just cannot take the cheap "size and mtime agree" branch.
      if (typeof x.mtime === 'number') entry.mtime = x.mtime;
      return entry;
    }),
    declinedNodes: stringArray(raw.declinedNodes),
    declinedPaths: stringArray(raw.declinedPaths),
    deleteBudget: Array.isArray(raw.deleteBudget)
      ? raw.deleteBudget
          .filter((e): e is { at: number } => isRecord(e) && typeof e.at === 'number')
          .map((e) => ({ at: e.at }))
      : [],
    staging: recordOf(raw.staging, (x) => {
      if (!isRecord(x)) return undefined;
      if (typeof x.from !== 'string' || typeof x.to !== 'string' || typeof x.at !== 'number') {
        return undefined;
      }
      return { from: x.from, to: x.to, at: x.at };
    }),
    // A deferred fetch names bytes this device will later ask the store for, so a
    // hash that is not a hash is worse than no entry at all.
    fetchDeferred: recordOf(raw.fetchDeferred, (x) => {
      if (!isRecord(x)) return undefined;
      if (typeof x.sha256 !== 'string' || !SHA256_RE.test(x.sha256)) return undefined;
      if (typeof x.bytes !== 'number') return undefined;
      return { sha256: x.sha256, bytes: x.bytes };
    }),
    fetchApproved: recordOf(raw.fetchApproved, (x) => (x === true ? (true as const) : undefined)),
    oversized: recordOf(raw.oversized, (x) => {
      if (!isRecord(x)) return undefined;
      if (typeof x.bytes !== 'number' || typeof x.cap !== 'number') return undefined;
      if (x.why !== 'server' && x.why !== 'device') return undefined;
      return { bytes: x.bytes, cap: x.cap, why: x.why };
    }),
  };
}

export class DeviceState {
  /** The storage key this instance reads and writes. */
  readonly key: string;

  /** Live state. Callers mutate this directly and then `schedulePersist()`. */
  data: DeviceStateData;

  /** Last error thrown by a debounced write, for diagnostics. `flush()` throws instead. */
  lastPersistError: unknown = null;

  private readonly port: StatePort;
  private readonly deviceId: string;
  private readonly workspaceId: string;
  private readonly now: () => number;
  private readonly debounceMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes writes, so a debounced write and a flush cannot land out of order. */
  private queue: Promise<void> = Promise.resolve();
  /**
   * The serialization of the last write that reached the port, or null.
   *
   * Deliberately not seeded from `load()`: the file on disk may hold fields
   * `normalize` dropped, so the first write of a session is what canonicalizes it.
   */
  private lastWritten: string | null = null;

  constructor(
    port: StatePort,
    deviceId: string,
    workspaceId: string,
    now: () => number = () => Date.now(),
    debounceMs: number = DEVICE_STATE_DEBOUNCE_MS,
  ) {
    this.port = port;
    this.deviceId = deviceId;
    this.workspaceId = workspaceId;
    this.now = now;
    this.debounceMs = debounceMs;
    this.key = deviceStateKey(workspaceId, deviceId);
    this.data = emptyDeviceState(deviceId, workspaceId);
  }

  /**
   * Read the persisted state, or cold-start.
   *
   * Cold-starts (never throws, never partially adopts) when the file is absent,
   * unreadable, not JSON, not an object, written by a different device or
   * workspace, or stamped with a schema version this client does not write.
   */
  async load(): Promise<{ coldStart: boolean }> {
    let raw: string | null = null;
    try {
      raw = await this.port.read(this.key);
    } catch {
      // An unreadable file is exactly as untrustworthy as an absent one, and a
      // cold start is recoverable (spec §4.5). Throwing here would abort boot.
      raw = null;
    }
    if (raw === null) return this.coldStart();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.coldStart();
    }
    if (!isRecord(parsed)) return this.coldStart();
    if (parsed.v !== STATE_VERSION) return this.coldStart();

    // Spec §2.5: the identity check. Discard the file ENTIRELY on a mismatch —
    // no merging, no partial trust.
    if (parsed.deviceId !== this.deviceId || parsed.workspaceId !== this.workspaceId) {
      return this.coldStart();
    }

    this.data = normalize(parsed, this.deviceId, this.workspaceId);
    return { coldStart: false };
  }

  /** Trailing-debounced persist. Repeated calls inside the window collapse into one write. */
  schedulePersist(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.persistNow().catch((err) => { this.lastPersistError = err; });
    }, this.debounceMs);
  }

  /** Cancel any pending debounce and write now. Called on unload and before risky work. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.persistNow();
  }

  /**
   * Flush only when the bytes would DIFFER from the last write this instance made.
   *
   * The reconciler ends every pass here, and a converged share reconciles on every
   * remote change: rebuilding the same maps out of the same evidence and writing
   * them again is a whole-object serialization plus a disk write, repeatedly, for
   * a file that did not move. On a share with a thousand attachments that is
   * megabytes every couple of seconds on a phone.
   *
   * It is a SEPARATE method rather than a change to `flush`, because `flush`'s
   * contract — called on unload, before a rename, after a staging journal entry —
   * is "the disk now holds this", and a caller that needs that guarantee must not
   * have it quietly turned into "…unless I thought nothing changed".
   *
   * @returns true when a write was actually issued.
   */
  async flushIfChanged(): Promise<boolean> {
    const json = JSON.stringify(this.data);
    if (json === this.lastWritten) {
      // A debounce armed by a change that has since been undone would only rewrite
      // these same bytes.
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return false;
    }
    await this.flush();
    return true;
  }

  // ---------------------------------------------------------- delete rate window

  /** Record one APPLIED remote deletion (spec §5.4). */
  recordDeletion(at: number = this.now()): void {
    this.data.deleteBudget.push({ at });
  }

  /** Applied deletions inside the trailing window. Prunes stale entries as it goes. */
  deletionsInWindow(at: number = this.now()): number {
    this.data.deleteBudget = this.data.deleteBudget.filter(
      (e) => at - e.at < REMOTE_DELETE_WINDOW_MS,
    );
    return this.data.deleteBudget.length;
  }

  /**
   * True once the window is full. The budget is PERSISTED, so a restart cannot
   * reset it — that is what turns the circuit breaker from a nuisance into a
   * containment mechanism for a peer deleting hundreds of files.
   */
  deleteBudgetExhausted(at: number = this.now()): boolean {
    return this.deletionsInWindow(at) >= REMOTE_DELETE_BUDGET;
  }

  // ---------------------------------------------------------- internals

  private coldStart(): { coldStart: boolean } {
    this.data = emptyDeviceState(this.deviceId, this.workspaceId);
    return { coldStart: true };
  }

  private persistNow(): Promise<void> {
    // Chain onto the previous write rather than racing it. A rejected predecessor
    // must not poison the chain, or one ENOSPC would disable persistence for the
    // rest of the session.
    const next = this.queue.then(
      () => this.write(),
      () => this.write(),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async write(): Promise<void> {
    // Serialize at write time, not at schedule time, so the newest state wins.
    const json = JSON.stringify(this.data);
    await this.port.write(this.key, json);
    // Only after the port RETURNED: a write that threw did not reach the disk, and
    // recording it would let `flushIfChanged` skip the retry.
    this.lastWritten = json;
  }
}
