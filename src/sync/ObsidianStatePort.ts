// src/sync/ObsidianStatePort.ts
// `StatePort` (spec §2.5) and the local tree snapshot (§2.6) over `vault.adapter`.
//
// One of only three files in `src/sync/` allowed to import `obsidian`.
//
// Both files live under `.obsidian/plugins/shadowlink/` and both are written
// ATOMICALLY — a `.tmp` sibling first, then a rename over the target. That is not
// ceremony. A torn device-state file read back on the next start is
// indistinguishable from a corrupt one, so `DeviceState.load` cold-starts, and a
// cold start on every launch is a permanent silent degradation: `materialized`,
// `owned` and `declinedPaths` are all rebuilt from scratch, and until the first
// reconcile finishes the client believes it owns nothing. A truncated tree
// snapshot is worse still: `Y.applyUpdate` throws on it, which spec §2.6's whole
// purpose — being able to re-merge full tree history into a server whose snapshot
// was lost — depends on not happening.
//
// The read path completes the story. If the target is absent but its `.tmp`
// sibling is there, the process died between the write and the rename, and the
// `.tmp` copy is a complete file that was never linked into place. Reading it is
// recovery; reading it in PREFERENCE to an existing target would not be, so it is
// only ever the fallback.

import { normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';

import type { StatePort } from './DeviceState.ts';

/** Spec §2.6: `tree-<workspaceId>.bin`, beside the device state. */
export function treeSnapshotKey(workspaceId: string): string {
  return `tree-${workspaceId}.bin`;
}

export class ObsidianStatePort implements StatePort {
  private readonly adapter: DataAdapter;
  private readonly dir: string;

  /**
   * @param dir The plugin's data directory, normally `plugin.manifest.dir`
   *            (`.obsidian/plugins/shadowlink`).
   */
  constructor(adapter: DataAdapter, dir: string) {
    this.adapter = adapter;
    this.dir = normalizePath(dir.replace(/\/+$/, ''));
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
    const target = this.pathFor(key);
    const tmp = `${target}.tmp`;
    await this.ensureDir();
    await this.adapter.write(tmp, data);
    await this.commit(tmp, target, () => this.adapter.write(target, data));
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
    const tmp = `${target}.tmp`;
    await this.ensureDir();
    const buffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    await this.adapter.writeBinary(tmp, buffer);
    await this.commit(tmp, target, () => this.adapter.writeBinary(target, buffer));
  }

  // ---------------------------------------------------------- internals

  private pathFor(key: string): string {
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
   * Link the staged copy into place.
   *
   * Node's `rename` replaces an existing destination on every platform this
   * plugin runs on, which is what makes the swap atomic. An adapter that refuses
   * one anyway must not cost the caller its data, so the fallback writes the
   * target directly: not atomic, but the complete `.tmp` copy written a moment
   * ago is still on disk and the read path above knows how to find it.
   */
  private async commit(tmp: string, target: string, fallback: () => Promise<void>): Promise<void> {
    try {
      await this.adapter.rename(tmp, target);
    } catch {
      await fallback();
    }
  }
}
