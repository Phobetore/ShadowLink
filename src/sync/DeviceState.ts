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

/**
 * Persistence for one opaque blob. The real implementation writes through
 * `vault.adapter` ATOMICALLY — write `.tmp`, then `adapter.rename` — because a
 * torn state file read back on the next start is indistinguishable from a corrupt
 * one, and cold-starting on every launch would be a permanent silent degradation.
 */
export interface StatePort {
  read(key: string): Promise<string | null>;
  write(key: string, data: string): Promise<void>;
}

export interface PublishEntry {
  state: 'pending' | 'done';
  attempts: number;
  nextAt: number;
}

export interface ContentHashEntry {
  sha256: string;
  len: number;
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
}

/** The schema version this client writes and accepts. */
const STATE_VERSION = 1;

/** Filename within the plugin's data directory; the port resolves the directory. */
export function deviceStateKey(workspaceId: string, deviceId: string): string {
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
  };
}

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
      return { state: x.state, attempts: x.attempts, nextAt: x.nextAt };
    }),
    contentHash: recordOf(raw.contentHash, (x) => {
      if (!isRecord(x)) return undefined;
      if (typeof x.sha256 !== 'string' || typeof x.len !== 'number') return undefined;
      return { sha256: x.sha256, len: x.len };
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

  private write(): Promise<void> {
    // Serialize at write time, not at schedule time, so the newest state wins.
    return this.port.write(this.key, JSON.stringify(this.data));
  }
}
