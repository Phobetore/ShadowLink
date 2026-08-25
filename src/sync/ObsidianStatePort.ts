// src/sync/ObsidianStatePort.ts
// `StatePort` (spec §2.5) and the local tree snapshot (§2.6) over `vault.adapter`.
//
// One of only three files in `src/sync/` allowed to import `obsidian`.
//
// Both files live under `.obsidian/plugins/shadowlink/`. What is at stake in how
// they are written: a torn device-state file read back on the next start is
// indistinguishable from a corrupt one, so `DeviceState.load` cold-starts, and a
// cold start is a silent degradation — `materialized`, `owned` and `declinedPaths`
// are rebuilt from scratch and until the first reconcile finishes the client
// believes it owns nothing. A truncated tree snapshot is worse still:
// `Y.applyUpdate` throws on it, which spec §2.6's whole purpose — being able to
// re-merge full tree history into a server whose snapshot was lost — depends on
// not happening.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS PORT CAN AND CANNOT PROMISE. Read this before "restoring" atomicity.
//
// Spec §2.5 and §2.6 both USED to say these files are written "atomically (write
// `.tmp`, then `adapter.rename`)". That prescription DOES NOT WORK; §2.5.1 is the
// amendment, and it was written from this file rather than the other way round.
// `vault.adapter` is not `node:fs`:
//
//   * `FileSystemAdapter.prototype.rename` tests the destination itself and
//     throws BEFORE it reaches `fsPromises.rename` —
//         if (await this._exists(newPath, false)
//             && (!this.insensitive || path.toLowerCase() !== newPath.toLowerCase()))
//           throw new Error('Destination file already exists!');
//     — so an occupied destination is refused DETERMINISTICALLY, on every
//     platform, mobile adapter included. It is not a transient Windows `EPERM`
//     and no retry budget will ever clear it. (Node's own `fs.rename` DOES
//     replace, which is what made this look fine in review and in the fake.)
//   * `adapter.write` / `adapter.writeBinary` are a bare `fsPromises.writeFile`.
//     Truncate-then-fill: the live file IS the half-written one while it runs.
//   * The adapter's `remove` would let us free the destination and then rename
//     into it. It is banned in shipped source by I1's guard in
//     `banned-calls.test.ts`, and the ban was WEIGHED AND KEPT — see below.
//
// Without a removal primitive you cannot recycle a name, and without recycling a
// name there is no atomic replace to be had. So:
//
//   CREATE (destination free)  — genuinely atomic. Staged, then linked into
//                                place. The file appears whole or not at all.
//   OVERWRITE (destination in use) — NOT atomic, and cannot be made so here.
//
// THE REMOVAL CALL: CONSIDERED, REFUSED, AND WHAT THAT COSTS.
//
// `banned-calls.test.ts` already exempts this one file from the ban on
// `adapter.writeBinary`, on the ground that it writes the plugin's own two files
// inside the plugin's own data directory and can name nothing of the user's.
// That ground covers `adapter.remove` word for word, so widening the exemption
// and doing remove-then-rename was available. It was not taken, for two reasons:
//
//   1. IT WOULD NOT BUY THE WORD. remove-then-rename is not atomic either — it
//      opens a window in which the target does not exist at all. What it buys is
//      a different failure: "target absent, complete `.tmp` beside it" instead of
//      "target torn". Better, but this whole file exists because the code claimed
//      an atomicity the adapter cannot deliver, and buying a hole in I1's guard
//      in order to STILL not be able to say "atomic" is the wrong trade.
//   2. THE HOLE IS BIGGER THAN THE ONE SENTENCE. The removal ban is enforced by
//      three tests, not one: the literal needle, a rule that no destructive call
//      may be written on a vault- or adapter-shaped receiver, and an allowlist
//      whose own guard asserts that such a receiver "may never be allowlisted".
//      Turning that never into a sometimes — in the file that holds the
//      `DataAdapter` — costs more than the failure it removes.
//
// SO, PLAINLY: on this platform the plugin's own state is written NON-ATOMICALLY
// whenever the target already exists, which is every write after the first. A
// crash or a power loss inside one `writeFile` of one small file leaves the live
// file torn, and the read path below prefers an existing target, so it is the
// torn copy that gets read back.
//
// What that costs, in full, and why it is survivable:
//   * device state — `DeviceState.load` cannot parse it and cold-starts.
//     `materialized`, `owned`, `declinedPaths`, `contentHash` and the deletion
//     budget are all rebuilt from nothing. Ignorance, not a wrong answer: every
//     reader of a missing base defaults to RESCUE, so the direction is safe.
//   * tree snapshot — `Bootstrap.loadSnapshot` catches the `Y.applyUpdate` throw,
//     tells the user, and refetches from the server. The offline baseline is lost
//     until then.
// Neither loses the user's content, and both are already written that way on
// purpose. If a future Obsidian ships an adapter whose `rename` replaces, this
// file gets a genuinely atomic overwrite with no change at all — see `link`.
//
// The `.tmp` sibling is therefore NOT an atomicity mechanism on the overwrite
// path; it is the read path's fallback copy, and it is rewritten BEFORE the live
// file on every single write for one reason: so that it can never be STALE. A
// stale device state is worse than a missing one, because it is read as
// authoritative — it carries `contentHash` (I17), `declinedPaths` and the
// deletion budget, and rolling those back by one revision is how a file that
// should have been rescued gets proven deletable instead.
//
// It follows that both files keep a `.tmp` sibling on disk from the second write
// onward. That is deliberate, not litter. Removing it would need the same
// removal primitive that would have made the write atomic in the first place.
// ─────────────────────────────────────────────────────────────────────────────
//
// The read path completes the story. If the target is absent but its `.tmp`
// sibling is there, the process died between the write and the rename, or the
// target was lost after one, and the `.tmp` copy is a complete file holding the
// most recent bytes this port was given. Reading it is recovery; reading it in
// PREFERENCE to an existing target would not be, so it is only ever the fallback.

import { normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';

import { isValidWorkspaceId } from '../tree/ids.ts';
import type { StatePort } from './DeviceState.ts';

/**
 * Spec §2.6: `tree-<workspaceId>.bin`, beside the device state.
 *
 * Checked for the same reason as `deviceStateKey`, and refused the same way. This
 * name too is built out of a string a human typed into a settings box, and it too
 * is joined onto the plugin's directory below by a `normalizePath` that tidies
 * slashes without resolving `..`.
 */
export function treeSnapshotKey(workspaceId: string): string {
  if (!isValidWorkspaceId(workspaceId)) {
    throw new Error(
      'ShadowLink: refusing to name a tree snapshot after an unusable workspace id: '
      + JSON.stringify(workspaceId),
    );
  }
  return `tree-${workspaceId}.bin`;
}

/** Tuning for the rename retry. Defaults mirror `server/blobStore.js`. */
export interface StatePortOptions {
  /** Total rename attempts before the write is failed outright. */
  readonly renameAttempts?: number;
  /** Backoff base; attempt _n_ waits `renameDelayMs * n`. */
  readonly renameDelayMs?: number;
}

export class ObsidianStatePort implements StatePort {
  private readonly adapter: DataAdapter;
  private readonly dir: string;
  private readonly renameAttempts: number;
  private readonly renameDelayMs: number;

  /**
   * @param dir The plugin's data directory, normally `plugin.manifest.dir`
   *            (`.obsidian/plugins/shadowlink`).
   */
  constructor(adapter: DataAdapter, dir: string, options: StatePortOptions = {}) {
    this.adapter = adapter;
    this.dir = normalizePath(dir.replace(/\/+$/, ''));
    this.renameAttempts = options.renameAttempts ?? 5;
    this.renameDelayMs = options.renameDelayMs ?? 25;
  }

  // ---------------------------------------------------------- StatePort

  async read(key: string): Promise<string | null> {
    const target = this.pathFor(key);
    if (await this.adapter.exists(target)) return this.adapter.read(target);
    const tmp = `${target}.tmp`;
    if (await this.adapter.exists(tmp)) return this.adapter.read(tmp);
    return null;
  }

  async write(key: string, data: string): Promise<void> {
    await this.put(this.pathFor(key), (path) => this.adapter.write(path, data));
  }

  // ---------------------------------------------------------- §2.6 snapshot

  async readBinary(key: string): Promise<Uint8Array | null> {
    const target = this.pathFor(key);
    const source = (await this.adapter.exists(target))
      ? target
      : (await this.adapter.exists(`${target}.tmp`)) ? `${target}.tmp` : null;
    if (source === null) return null;
    return new Uint8Array(await this.adapter.readBinary(source));
  }

  async writeBinary(key: string, data: Uint8Array): Promise<void> {
    const target = this.pathFor(key);
    const buffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    await this.put(target, (path) => this.adapter.writeBinary(path, buffer));
  }

  // ---------------------------------------------------------- internals

  /**
   * `<dir>/<key>` — and the one line in this file where a NAME becomes a PATH.
   *
   * `normalizePath` collapses separators and does not resolve `..`, so a key
   * carrying one is joined verbatim and addresses a file outside the plugin's own
   * directory. Both keys this port is ever handed are built from a charset-checked
   * workspace id, so nothing here should ever fire — which is the point. A
   * boundary that holds only while its callers are correct is not a boundary, and
   * the callers include a `deviceId` this file has no rule for.
   *
   * A throw, never a repaired name: silently writing device state or a tree
   * snapshot into some other file is worse than not writing it at all.
   */
  private pathFor(key: string): string {
    if (key === '' || key === '.' || key === '..' || /[/\\]/.test(key)) {
      throw new Error(
        `ShadowLink: refusing a state key that is not a plain filename: ${JSON.stringify(key)}`,
      );
    }
    return normalizePath(`${this.dir}/${key}`);
  }

  private async ensureDir(): Promise<void> {
    if (await this.adapter.exists(this.dir)) return;
    try {
      await this.adapter.mkdir(this.dir);
    } catch {
      // A concurrent creation is the only expected failure, and it produced the
      // directory we wanted. A real failure resurfaces on the write below.
    }
  }

  /**
   * One write of one file, through the only atomic path this adapter has — and
   * in place when it has none. See the header for why those are the only two.
   *
   * The staged copy is written FIRST in both cases, so that if the live file is
   * about to be overwritten non-atomically, the fallback the read path would
   * reach for already holds the NEW bytes rather than the previous revision.
   *
   * @param writeAt Writes the caller's bytes at whatever path it is handed — the
   *                text and binary arms differ in nothing else.
   */
  private async put(target: string, writeAt: (path: string) => Promise<void>): Promise<void> {
    const tmp = `${target}.tmp`;
    await this.ensureDir();
    await writeAt(tmp);
    if (await this.link(tmp, target)) return;
    await writeAt(target);
  }

  /**
   * Try to link the staged copy into place, and say whether it worked.
   *
   * The rename is ATTEMPTED rather than predicted. Checking `exists(target)`
   * first and skipping the call would hard-code today's Obsidian into this file;
   * attempting it means an adapter that does replace a destination — a future
   * Obsidian, or a desktop build whose behaviour we have not read — gets a truly
   * atomic overwrite here with no code change at all.
   *
   * Failures split in two, and the old code's mistake was treating them alike:
   *
   *   * the destination EXISTS afterwards — the adapter's own occupancy check
   *     refused it. Deterministic, unclearable without a removal primitive we do
   *     not have, and identical on the next four attempts. Report it so the
   *     caller falls back to the in-place write; retrying is pure waste.
   *   * the destination is still free — the rename failed for a reason that has
   *     nothing to do with occupancy: a scanner, a backup agent or an indexer
   *     holding a handle, which on Windows surfaces as `EPERM`/`EACCES`/`EBUSY`
   *     and clears on its own. This is `server/blobStore.js`'s `renameWithRetry`
   *     case exactly, so it gets that treatment — a short backoff, a few tries.
   *
   * When the budget runs out the error is THROWN, not swallowed. The staged copy
   * is complete and on disk for the read path, and `DeviceState` only records
   * `lastWritten` once this returns, so a throw is what makes the next flush try
   * again. Quietly writing the live file instead — which is what this used to do
   * on the very first transient blip — turned a self-clearing failure into a
   * permanently non-atomic write, and said nothing.
   *
   * The one thing it deliberately does NOT do is `server/blobStore.js`'s cleanup
   * of the temporary file on give-up. That store's `.part` is an INCOMPLETE
   * upload and keeping it would be wrong; this port's `.tmp` is a complete copy
   * and is the only place the caller's bytes exist at that moment.
   *
   * @returns true when the staged copy is now the live file.
   */
  private async link(tmp: string, target: string): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.adapter.rename(tmp, target);
        return true;
      } catch (err) {
        if (await this.occupied(target)) return false;
        if (attempt >= this.renameAttempts) throw err;
        await sleep(this.renameDelayMs * attempt);
      }
    }
  }

  /**
   * Why the rename above failed: because something is already at `target`, or
   * for some other reason.
   *
   * An `exists` that throws answers neither, and must not become the error the
   * caller sees — the rename failure is the interesting one. Reporting "not
   * occupied" hands the decision back to the retry budget, which either clears
   * the problem or rethrows the original.
   */
  private async occupied(target: string): Promise<boolean> {
    try {
      return await this.adapter.exists(target);
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
