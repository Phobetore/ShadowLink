// server/blobStore.js
// The content-addressed store behind the blob routes (spec §6.4, §6.5).
//
//   <PERSISTENCE_DIR>/blobs/<ws>/<sha[0:2]>/<sha[2:4]>/<sha>   final, immutable
//   <PERSISTENCE_DIR>/blobs/<ws>/incoming/<sha>.part           resumable partial
//   <PERSISTENCE_DIR>/blobs/<ws>/usage.json                    {bytes, files}
//   <PERSISTENCE_DIR>/blobs/<ws>/.attic/<sha>                  swept, awaiting removal
//
// Five properties are load-bearing, and every one of them is here because the
// obvious implementation is silently wrong:
//
//  * A FINAL OBJECT IS WRITTEN ONCE, BY RENAME, and never modified. The rename is
//    the same temp-then-rename `DocHub._writeSnapshot` uses, INCLUDING its Windows
//    EPERM retry: replacing a file another handle has open fails with EPERM,
//    EACCES or EBUSY on Windows, transiently, and CI on windows-latest is what
//    caught that for snapshots. Here it would corrupt a store rather than a
//    snapshot.
//  * THE SERVER REHASHES what it assembled before that rename. Neither end trusts
//    the other's arithmetic, which is what makes "the hash in the tree names these
//    exact bytes" enforceable rather than conventional. A mismatch is 422 and the
//    partial is unlinked.
//  * USAGE.JSON GOES THROUGH A PER-WORKSPACE PROMISE CHAIN, the pattern
//    `DocHub._persistChain` already uses. The update is a genuine read-modify-write
//    against the file, and two concurrent finalisations that both read the old
//    total lose the smaller of the pair — silently, monotonically, and without ever
//    producing a torn file the rebuild path would notice.
//  * `incoming/` COUNTS TOWARDS THE QUOTA. Otherwise partials are invisible to it,
//    the volume fills, and `DocHub._writeSnapshot` starts failing into
//    `lastPersistError` where nothing surfaces it.
//  * BYTES ARE NOT SHARED ACROSS WORKSPACES even though the hash is global. Under
//    one shared SERVER_KEY a cross-workspace store would let any key holder use
//    HEAD to prove a specific file exists in a workspace they cannot otherwise
//    read. Duplicating the bytes is the cheaper price.
//
// There is NO delete API. The server never removes a blob because a client asked.
// The only removals here are the `.part` TTL sweep — bytes that were never a
// complete object — and, in a later slice, the offline admin sweeper.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** The same charset `upgradeAuth.js` applies, so `<ws>` is a safe path component. */
const WS_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const FAN_RE = /^[0-9a-f]{2}$/;

const USAGE_FILE = 'usage.json';
const INCOMING_DIR = 'incoming';

/** Rescan usage and sweep stale partials on this cadence (spec §6.5). */
const MAINTENANCE_INTERVAL_MS = 6 * 3600_000;

const ZERO_USAGE = { bytes: 0, files: 0 };

function isSafeInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function readdirOrEmpty(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
}

/**
 * `DocHub._renameWithRetry`, lifted so the store gets the identical behaviour.
 *
 * It is duplicated rather than shared because `DocHub` is untouched in this slice
 * — deliberately, since it is P1's most dangerous surface and gains no new callers
 * here. The reasoning is `DocHub`'s verbatim: POSIX `rename` over an existing path
 * is atomic and cannot fail because somebody is reading the destination; Windows
 * is not POSIX and fails transiently with EPERM/EACCES/EBUSY when an antivirus
 * scanner, a backup agent or a concurrent reader holds a handle. If every attempt
 * fails the temp file is removed — an incomplete object is never the file to keep —
 * and the error is rethrown.
 */
export async function renameWithRetry(from, to, options = {}) {
  const {
    rename: doRename = rename,
    attempts = 5,
    delayMs = 25,
    cleanup = () => rm(from, { force: true }),
  } = options;
  const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

  for (let i = 0; ; i++) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      if (i >= attempts - 1 || !TRANSIENT.has(err?.code)) {
        await Promise.resolve(cleanup()).catch(() => { /* best effort */ });
        throw err;
      }
      await new Promise((resolve) => { setTimeout(resolve, delayMs * (i + 1)); });
    }
  }
}

export class BlobStore {
  /**
   * @param {string} dataDir  `PERSISTENCE_DIR`; the store lives in `blobs/` beside
   *                          `DocHub`'s `yjs/` and inherits its workspace isolation.
   */
  constructor(dataDir, options = {}) {
    this.baseDir = join(dataDir, 'blobs');
    mkdirSync(this.baseDir, { recursive: true });

    /** Per blob. 0 means unlimited, matching the quota's convention. */
    this.maxFileBytes = options.maxFileBytes ?? 0;
    /**
     * Across the WHOLE store, not per workspace: the failure this guards against
     * is the volume filling up, which is a disk-level fact. `MAX_TOTAL_STORAGE_GB`
     * says total, and 0 still means unlimited.
     */
    this.maxTotalBytes = options.maxTotalBytes ?? 0;
    this.incompleteUploadTtlMs = (options.incompleteUploadTtlHours ?? 24) * 3600_000;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? MAINTENANCE_INTERVAL_MS;
    this.renameAttempts = options.renameAttempts ?? 5;
    this.renameDelayMs = options.renameDelayMs ?? 25;

    /** ws -> {bytes, files}. Authoritative copy is usage.json; this mirrors it. */
    this._usage = new Map();
    /** ws -> Map<sha, bytes> for `incoming/`, which counts against the quota. */
    this._incoming = new Map();
    /** ws -> Promise. usage.json's read-modify-write is serialized per workspace. */
    this._usageChain = new Map();
    /**
     * ws -> a count that moves whenever a delta is on its way. `rescan` walks the
     * tree OUTSIDE the chain and then writes an ABSOLUTE total, so it is the one
     * writer that can overwrite a delta it never saw; comparing this before and
     * after the walk is how it tells that its count went stale mid-flight.
     */
    this._usageDeltas = new Map();
    /** `${ws}/${sha}` -> Promise. Appends to one partial are serialized. */
    this._partChain = new Map();
    /** Last usage-write error per workspace, for diagnostics. Never thrown at a caller. */
    this.lastUsageError = new Map();

    this._timer = null;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Scan the store, sweep stale partials, and arm the maintenance timer.
   *
   * usage.json is REBUILT from the objects on every boot rather than believed: it
   * is a cache of a fact the filesystem already holds, and a stale or truncated
   * one would either refuse uploads into an empty store or let a full one keep
   * accepting.
   */
  async start() {
    for (const ws of await this.workspaces()) {
      await this._rescanIncoming(ws);
      await this.rescan(ws);
    }
    await this.sweepPartials();

    if (this.maintenanceIntervalMs > 0) {
      this._timer = setInterval(() => { void this._maintenance(); }, this.maintenanceIntervalMs);
      // Never the only reason the process stays alive — the same reasoning
      // `DocHub` applies to its snapshot timers.
      this._timer.unref?.();
    }
  }

  stop() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Resolve once every queued usage write and partial append has landed. */
  async settled() {
    await Promise.allSettled([...this._partChain.values()]);
    await Promise.allSettled([...this._usageChain.values()]);
  }

  async _maintenance() {
    try {
      for (const ws of await this.workspaces()) await this.rescan(ws);
      await this.sweepPartials();
    } catch (err) {
      this.lastUsageError.set('*', err);
    }
  }

  // ---------------------------------------------------------------- reads

  /** Every workspace that has a store directory. */
  async workspaces() {
    const entries = await readdirOrEmpty(this.baseDir);
    return entries
      .filter((e) => e.isDirectory() && WS_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  }

  /** The final object, or null. Never answered from a cache: it is a disk fact. */
  async stat(ws, sha256) {
    const path = this.finalPath(ws, sha256);
    const found = await statOrNull(path);
    return found === null || !found.isFile() ? null : { bytes: found.size, path };
  }

  /**
   * The resume offset for `<sha>`: how many bytes the store already holds.
   *
   * A COMPLETE object reports its full length, so a client that resumes an upload
   * somebody else finished in the meantime learns it has nothing left to send
   * instead of appending to a partial that will never be renamed.
   */
  async received(ws, sha256) {
    const final = await this.stat(ws, sha256);
    if (final !== null) return final.bytes;
    return this._partSize(ws, sha256);
  }

  finalPath(ws, sha256) {
    // Two levels of fan-out, so 100k attachments do not land in one directory.
    return join(this.baseDir, ws, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  partPath(ws, sha256) {
    return join(this.baseDir, ws, INCOMING_DIR, `${sha256}.part`);
  }

  /** The workspace's share of the store, as usage.json records it. */
  usage(ws) {
    return { ...(this._usage.get(ws) ?? ZERO_USAGE) };
  }

  /** Bytes in final objects, across every workspace. */
  totalBytes() {
    let sum = 0;
    for (const entry of this._usage.values()) sum += entry.bytes;
    return sum;
  }

  /** Bytes sitting in `incoming/`, across every workspace. Counted by the quota. */
  incomingBytes() {
    let sum = 0;
    for (const parts of this._incoming.values()) {
      for (const bytes of parts.values()) sum += bytes;
    }
    return sum;
  }

  /** What `GET /blob/<ws>/limits` answers. `freeBytes` is null when unlimited. */
  limits() {
    const used = this.totalBytes() + this.incomingBytes();
    return {
      maxFileBytes: this.maxFileBytes,
      freeBytes: this.maxTotalBytes > 0 ? Math.max(0, this.maxTotalBytes - used) : null,
    };
  }

  // ---------------------------------------------------------------- writing

  /**
   * Append one chunk of `<sha>`, and finalise the object when it completes.
   *
   * Appends to a single partial are serialized: the offset check and the write
   * that depends on it have to be one atomic step, or two concurrent chunks both
   * read the same offset and one of them appends over the other's bytes.
   *
   * @returns {Promise<
   *   | { ok: true, complete: boolean, received: number, deduped?: boolean }
   *   | { ok: false, code: 400|409|413|422|507, received?: number }
   * >}
   */
  appendChunk(ws, sha256, chunk) {
    const key = `${ws}/${sha256}`;
    const previous = this._partChain.get(key) ?? Promise.resolve();
    const run = () => this._appendChunk(ws, sha256, chunk);
    const next = previous.then(run, run);
    // A rejected predecessor must not poison the chain, or one ENOSPC would
    // disable uploads of that object for the rest of the process's life.
    this._partChain.set(key, next.then(() => {}, () => {}));
    return next;
  }

  async _appendChunk(ws, sha256, { offset, total, length, stream }) {
    if (!isSafeInt(offset) || !isSafeInt(total) || !isSafeInt(length)
        || total < 1 || length < 1) {
      return { ok: false, code: 400, received: await this._partSize(ws, sha256) };
    }

    // Dedup is intrinsic and per-workspace: identical bytes at ten paths in one
    // share store once. The client's `has()` probe usually avoids sending anything
    // at all; this is the case where two peers raced that probe.
    const existing = await this.stat(ws, sha256);
    if (existing !== null) {
      await this._dropPart(ws, sha256);
      return { ok: true, complete: true, received: existing.bytes, deduped: true };
    }

    // The declared size, refused before a byte is read. An object over the cap can
    // never be stored, so any partial for it is dead weight against the quota.
    if (this.maxFileBytes > 0 && total > this.maxFileBytes) {
      await this._dropPart(ws, sha256);
      return { ok: false, code: 413 };
    }

    const received = await this._partSize(ws, sha256);
    if (offset + length > total) return { ok: false, code: 400, received };
    // Appends iff `a === received`; otherwise the client re-seeks rather than
    // corrupting. The true offset travels back so it can.
    if (offset !== received) return { ok: false, code: 409, received };

    if (this.maxTotalBytes > 0
        && this.totalBytes() + this.incomingBytes() + length > this.maxTotalBytes) {
      // Clean degradation: the partial stays, so the upload resumes untouched when
      // the admin raises the quota.
      return { ok: false, code: 507 };
    }

    const written = await this._writeChunk(ws, sha256, received, length, stream);
    if (written.overCap) {
      // Defence in depth behind the declared-size check above: with `total` bounded
      // and `offset + length <= total`, this is unreachable — which is exactly why
      // it is here, since a future refactor of either check would make it reachable
      // and a per-file cap that is only advisory is not a cap.
      await this._dropPart(ws, sha256);
      return { ok: false, code: 413 };
    }
    if (written.excess || written.bytes !== length) {
      // A short or over-long body: the request contradicted itself. Everything that
      // landed is a valid prefix at a known offset, so the partial stays and the
      // truthful offset goes back for the client to re-seek from.
      return { ok: false, code: 400, received: received + written.bytes };
    }

    const now = received + written.bytes;
    if (now < total) return { ok: true, complete: false, received: now };

    return this._finalize(ws, sha256, total);
  }

  /**
   * Stream the body onto the partial, bounded by BOTH the declared chunk length
   * and the per-file cap.
   *
   * The declared length is the bound that normally bites: it is the bookkeeping
   * the resume offset is built on, and writing past it would corrupt a partial in
   * a way only the final rehash could catch — throwing away an entire upload
   * instead of one chunk.
   */
  async _writeChunk(ws, sha256, received, length, stream) {
    const path = this.partPath(ws, sha256);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'a');
    let bytes = 0;
    let overCap = false;
    let excess = false;
    try {
      for await (const raw of stream) {
        let piece = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (bytes + piece.length > length) {
          piece = piece.subarray(0, length - bytes);
          excess = true;                      // the body is longer than it declared
        }
        if (this.maxFileBytes > 0 && received + bytes + piece.length > this.maxFileBytes) {
          piece = piece.subarray(0, Math.max(0, this.maxFileBytes - received - bytes));
          overCap = true;
        }
        if (piece.length > 0) {
          await handle.write(piece);
          bytes += piece.length;
        }
        if (overCap || excess) break;
      }
    } finally {
      await handle.close();
      this._setIncoming(ws, sha256, received + bytes);
    }
    return { bytes, overCap, excess };
  }

  /**
   * Rehash the finished partial and rename it into place.
   *
   * The rehash is not optional and not a belt: the client computed the name, the
   * client sent the bytes, and a client that got either wrong would otherwise
   * poison the store under a good name — for every peer, permanently, because a
   * final object is never rewritten.
   */
  async _finalize(ws, sha256, total) {
    const part = this.partPath(ws, sha256);
    const actual = await hashFile(part);
    if (actual !== sha256) {
      await this._dropPart(ws, sha256);
      return { ok: false, code: 422 };
    }

    const final = this.finalPath(ws, sha256);
    await mkdir(dirname(final), { recursive: true });
    // Mark the workspace dirty BEFORE the object can appear at its address, not
    // after. A rescan's walk can only see this object once the rename lands, so a
    // mark taken from here on is guaranteed to be visible to any walk that could
    // have counted it — which is what stops the count below being added twice.
    // Doing it after `renameWithRetry` would be a microtask before `_addUsage`
    // marks it anyway, and would leave the whole rename, including its Windows
    // EPERM retries, unmarked.
    this._usageDeltas.set(ws, (this._usageDeltas.get(ws) ?? 0) + 1);
    await renameWithRetry(part, final, {
      rename: (from, to) => this._rename(from, to),
      attempts: this.renameAttempts,
      delayMs: this.renameDelayMs,
      cleanup: async () => { await this._dropPart(ws, sha256); },
    });
    this._setIncoming(ws, sha256, 0);
    await this._addUsage(ws, total, 1);
    return { ok: true, complete: true, received: total, deduped: false };
  }

  /** Indirection so a test can drive the retry path deterministically. */
  _rename(from, to) {
    return rename(from, to);
  }

  // ---------------------------------------------------------------- partials

  async _partSize(ws, sha256) {
    const found = await statOrNull(this.partPath(ws, sha256));
    const size = found === null || !found.isFile() ? 0 : found.size;
    this._setIncoming(ws, sha256, size);
    return size;
  }

  _setIncoming(ws, sha256, bytes) {
    let parts = this._incoming.get(ws);
    if (parts === undefined) {
      parts = new Map();
      this._incoming.set(ws, parts);
    }
    if (bytes > 0) parts.set(sha256, bytes);
    else parts.delete(sha256);
  }

  async _dropPart(ws, sha256) {
    await rm(this.partPath(ws, sha256), { force: true }).catch(() => { /* best effort */ });
    this._setIncoming(ws, sha256, 0);
  }

  async _rescanIncoming(ws) {
    const dir = join(this.baseDir, ws, INCOMING_DIR);
    const parts = new Map();
    for (const entry of await readdirOrEmpty(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
      const sha = entry.name.slice(0, -5);
      if (!SHA_RE.test(sha)) continue;
      const found = await statOrNull(join(dir, entry.name));
      if (found !== null && found.size > 0) parts.set(sha, found.size);
    }
    this._incoming.set(ws, parts);
  }

  /**
   * Remove `.part` files older than `INCOMPLETE_UPLOAD_TTL_HOURS`. Run on boot and
   * on the maintenance timer.
   *
   * A partial is not a blob: it is bytes that never became an object, so removing
   * it takes nothing away from anybody. Leaving them is what fills the volume,
   * because they count against the quota by design.
   *
   * @returns {Promise<number>} how many were removed.
   */
  async sweepPartials() {
    if (this.incompleteUploadTtlMs <= 0) return 0;
    const cutoff = Date.now() - this.incompleteUploadTtlMs;
    let removed = 0;
    for (const ws of await this.workspaces()) {
      const dir = join(this.baseDir, ws, INCOMING_DIR);
      for (const entry of await readdirOrEmpty(dir)) {
        if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
        const path = join(dir, entry.name);
        const found = await statOrNull(path);
        if (found === null || found.mtimeMs >= cutoff) continue;
        await rm(path, { force: true }).catch(() => { /* a locked file is swept next pass */ });
        const sha = entry.name.slice(0, -5);
        if (SHA_RE.test(sha)) this._setIncoming(ws, sha, 0);
        removed += 1;
      }
    }
    return removed;
  }

  // ---------------------------------------------------------------- usage

  /**
   * Recount a workspace's objects and write the answer back.
   *
   * Only files that sit at their own fanned-out address are counted. A correctly
   * named object in the wrong bucket is unreachable through `finalPath`, so
   * counting it would mean the quota charging for bytes no client can ever fetch.
   * `incoming/` and `.attic/` are not objects and are excluded here — `incoming/`
   * is tracked separately because the quota counts it, `.attic/` holds bytes the
   * offline sweeper has already condemned.
   */
  async rescan(ws) {
    const root = join(this.baseDir, ws);
    const mark = this._usageDeltas.get(ws) ?? 0;
    let bytes = 0;
    let files = 0;
    for (const first of await readdirOrEmpty(root)) {
      if (!first.isDirectory() || !FAN_RE.test(first.name)) continue;
      for (const second of await readdirOrEmpty(join(root, first.name))) {
        if (!second.isDirectory() || !FAN_RE.test(second.name)) continue;
        for (const object of await readdirOrEmpty(join(root, first.name, second.name))) {
          if (!object.isFile() || !SHA_RE.test(object.name)) continue;
          if (!object.name.startsWith(first.name + second.name)) continue;
          const found = await statOrNull(join(root, first.name, second.name, object.name));
          if (found === null) continue;
          bytes += found.size;
          files += 1;
        }
      }
    }
    const next = { bytes, files };
    // A DELTA LANDED WHILE WE WERE WALKING, so this count is already history and
    // writing it would silently erase that delta from memory and from usage.json —
    // which every later delta then reads back as its base. The walk cannot be
    // merged with the delta instead: whether it happened to reach the new object's
    // bucket before or after the rename is unknowable from here, so adding the
    // delta on top would double-count exactly as often as it would repair.
    // Abandoning is the only safe reading, and it is affordable because the delta
    // path is exact — a store whose usage writes all succeed never needs this walk.
    //
    // ACCEPTED COST: on a store busy enough for the walk to take seconds, every
    // periodic rescan can abandon indefinitely, and rescan is also the repair path
    // for drift after a failed usage write or an operator sweep against a live
    // server. That repair is then deferred to the next quiet cycle or to boot,
    // where `start()` runs before `listen` and cannot race. Deliberately not
    // re-armed on a timer: a retry that walks a large tree again is the same cost
    // as the next cycle, and `lastUsageError` already records the drift's cause.
    if ((this._usageDeltas.get(ws) ?? 0) !== mark) {
      return { ...(this._usage.get(ws) ?? next) };
    }
    const current = this._usage.get(ws);
    this._usage.set(ws, next);
    if (current === undefined || current.bytes !== bytes || current.files !== files) {
      await this._enqueueUsage(ws, async () => { await this._writeUsage(ws, next); });
    }
    return { ...next };
  }

  /**
   * Apply a delta to usage.json, THROUGH THE CHAIN.
   *
   * This is a read-modify-write against the file on purpose: usage.json is the
   * record that survives a restart, and making the in-memory copy authoritative
   * would hide a lost update until the next boot loaded a total that was quietly
   * too small. It is only correct because the chain serializes it — two
   * finalisations landing in the same tick both read the old total otherwise, and
   * the store forgets the smaller of the pair for ever.
   */
  _addUsage(ws, deltaBytes, deltaFiles) {
    // Synchronously, before the task is even queued: a rescan that samples the
    // mark after this point must see the change, whether or not the walk saw the
    // object the delta is for.
    this._usageDeltas.set(ws, (this._usageDeltas.get(ws) ?? 0) + 1);
    return this._enqueueUsage(ws, async () => {
      const current = await this._readUsage(ws);
      const next = {
        bytes: Math.max(0, current.bytes + deltaBytes),
        files: Math.max(0, current.files + deltaFiles),
      };
      await this._writeUsage(ws, next);
      this._usage.set(ws, next);
    });
  }

  _enqueueUsage(ws, task) {
    const previous = this._usageChain.get(ws) ?? Promise.resolve();
    const next = previous.then(task, task).catch((err) => {
      this.lastUsageError.set(ws, err);
    });
    this._usageChain.set(ws, next);
    return next;
  }

  async _readUsage(ws) {
    try {
      const parsed = JSON.parse(await readFile(join(this.baseDir, ws, USAGE_FILE), 'utf8'));
      if (isSafeInt(parsed?.bytes) && isSafeInt(parsed?.files)) {
        return { bytes: parsed.bytes, files: parsed.files };
      }
    } catch {
      /* absent or unparseable: the objects on disk are the truth anyway */
    }
    return { ...(this._usage.get(ws) ?? ZERO_USAGE) };
  }

  /** Temp-then-rename, so a reader only ever sees a complete usage.json. */
  async _writeUsage(ws, value) {
    const path = join(this.baseDir, ws, USAGE_FILE);
    const tmp = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(value));
    await renameWithRetry(tmp, path, {
      rename: (from, to) => this._rename(from, to),
      attempts: this.renameAttempts,
      delayMs: this.renameDelayMs,
    });
  }
}

/** Stream a file through SHA-256 without ever holding it in memory. */
async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
