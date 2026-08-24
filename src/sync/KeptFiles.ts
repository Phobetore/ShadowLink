// src/sync/KeptFiles.ts
// The way back out of `declinedPaths` / `declinedNodes` (spec §5.4, §4.5 step 8,
// and the escape hatch risk R6 names).
//
// Both arrays were append-only. `Bootstrap` writes a folded path into
// `declinedPaths` when the user unchecks "share my local files"; `Deletions`
// writes a node id AND a folded path when a remote delete is rescued or kept. And
// from then on three separate places refuse the file for ever: `VaultWatcher.onCreate`
// returns at the declined path, the reconciler's publish step skips it, and
// `Deletions.collectDeletable` skips the node. Nothing removed an entry, so one
// unchecked box on the mandatory first-sync dialog permanently unshared every
// local file — while the dialog said "You can share them later".
//
// This module is that "later". It is deliberately headless and deliberately
// small: listing is a pure function of (device state, tree, disk), and sharing is
// four steps whose ORDER is the entire safety argument.
//
//  1. CLEAR the selected entries from both arrays.
//  2. UNBIND every cleared node that is DEAD in the tree. This is the step that is
//     easy to miss and expensive to get wrong. `declinedNodes` is what stops
//     `collectDeletable` from touching a kept copy of a file some peer deleted;
//     clearing it while `state.materialized[id]` still points at the file would
//     turn "share this again" into "delete it after all" on the very next pass.
//     Unbound, the same node reads as untracked, which invariants I2 and I12
//     already define as never deletable.
//  3. PERSIST before anything acts, so a crash between the decision and the
//     upload cannot leave the file declined-but-published or the reverse.
//  4. ADOPT each file that is still on disk through the watcher's `onCreate` —
//     the same hand-off the reconciler's step 6 uses. Doing it here rather than
//     leaving it to the scheduled pass is not an optimization: a file sitting at a
//     DEAD node's path is excluded from step 6 by invariant I13, so the pass alone
//     would clear the decline and then publish nothing at all.
//
// No `obsidian` import, no node builtins.

import { fold, isLive, relPath } from '../tree/paths.ts';
import { RECOVERED_DIR } from '../tree/constants.ts';
import type { NodeFields } from '../tree/types.ts';
import type { DeviceState } from './DeviceState.ts';
import type { VaultPort } from './VaultPort.ts';

/** One thing the user chose to keep, with enough context to choose again. */
export interface KeptEntry {
  /** Unique within one listing. A selection travels as these, never as indices. */
  readonly key: string;
  /** The path as a human would recognise it. */
  readonly label: string;
  /** Why it is here, and what sharing it will do. */
  readonly detail: string;
  /** The literal path of the file on disk, or null when nothing is there now. */
  readonly path: string | null;
  /** Folded paths this entry clears from `declinedPaths`. */
  readonly paths: readonly string[];
  /** Node ids this entry clears from `declinedNodes`. */
  readonly nodes: readonly string[];
}

export interface KeptFilesDeps {
  state: DeviceState;
  /** Tree snapshot, injected so this module never owns the Y.Doc. */
  entries: () => Array<[string, NodeFields]>;
  /** Only `list()` is used: the share-filtered in-memory index. */
  vault: Pick<VaultPort, 'list'>;
  /** Read fresh — §4.1 can move the shared folder mid-session. */
  shareRoot: () => string;
  /**
   * `VaultWatcher.onCreate`. Mints (or, inside §5.6's window, resurrects) a node
   * for a file already on disk and records this device as its owner.
   */
  adopt: (path: string) => Promise<void>;
  /** Drain the publish queue, so the answer is acted on now rather than in 30 s. */
  drain?: () => Promise<void>;
  scheduleReconcile?: (cause: string) => void;
  notice?: (msg: string) => void;
}

export interface ShareResult {
  /** Entries removed from `declinedPaths` plus ids removed from `declinedNodes`. */
  cleared: number;
  /** Files handed to the watcher for a fresh node. */
  shared: number;
  /** Paths whose adoption threw. Reported, never silently dropped (I15). */
  failed: string[];
}

interface Draft {
  key: string;
  paths: string[];
  nodes: string[];
  /** The node's own idea of where it lives, for a label when the disk has nothing. */
  storedPath: string | null;
  deletedBy: string | null;
  dead: boolean;
}

export class KeptFiles {
  constructor(private readonly deps: KeptFilesDeps) {}

  /**
   * Everything this device is currently refusing to share, newest facts first.
   *
   * Pure: it reads state, tree and the vault index and writes nothing. A path and
   * the node that used to live there are ONE entry — `Deletions` records both
   * halves of the same decision, and offering them separately would let a user
   * clear one and be quietly refused by the other.
   */
  list(): KeptEntry[] {
    const data = this.deps.state.data;
    const root = this.deps.shareRoot().replace(/\/+$/, '');
    const nodes = new Map(this.deps.entries());

    const onDisk = new Map<string, string>();
    for (const entry of this.deps.vault.list()) {
      if (entry.kind === 'f') onDisk.set(fold(entry.path), entry.path);
    }

    const drafts = new Map<string, Draft>();
    const draftFor = (key: string): Draft => {
      let draft = drafts.get(key);
      if (draft === undefined) {
        draft = { key, paths: [], nodes: [], storedPath: null, deletedBy: null, dead: false };
        drafts.set(key, draft);
      }
      return draft;
    };

    for (const folded of data.declinedPaths) draftFor(folded).paths.push(folded);

    for (const id of data.declinedNodes) {
      const f = nodes.get(id) ?? null;
      // Two ways to find the fold key this decline was filed under: where the file
      // actually sat (a collision suffix means that is NOT the node's stored path),
      // and failing that the node's own `d`/`n`.
      const bound = data.materialized[id];
      const stored = f === null || root === '' ? null : `${root}/${relPath(f)}`;
      const candidates = [bound, stored].filter((p): p is string => typeof p === 'string');
      const matched = candidates.map(fold).find((key) => drafts.has(key));
      const draft = draftFor(matched ?? `node:${id}`);
      draft.nodes.push(id);
      if (draft.storedPath === null) draft.storedPath = candidates[0] ?? null;
      if (f !== null && !isLive(f)) {
        draft.dead = true;
        if (typeof f.xb === 'string' && f.xb !== '') draft.deletedBy = f.xb;
      }
    }

    const out: KeptEntry[] = [];
    for (const draft of drafts.values()) {
      const folded = draft.paths[0] ?? (draft.storedPath === null ? null : fold(draft.storedPath));
      const path = folded === null ? null : onDisk.get(folded) ?? null;
      const label = path ?? draft.storedPath ?? folded ?? draft.key;
      out.push({
        key: draft.key,
        label,
        detail: detailOf(draft, path !== null),
        path,
        paths: draft.paths,
        nodes: draft.nodes,
      });
    }
    return out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  }

  /**
   * Share the selected entries again: clear, unbind, persist, adopt.
   *
   * An empty selection is a legitimate answer — it is what dismissing the dialog
   * means — and writes nothing at all.
   */
  async share(selected: readonly KeptEntry[]): Promise<ShareResult> {
    const result: ShareResult = { cleared: 0, shared: 0, failed: [] };
    if (selected.length === 0) return result;

    const data = this.deps.state.data;
    const clearPaths = new Set<string>();
    const clearNodes = new Set<string>();
    for (const entry of selected) {
      for (const folded of entry.paths) clearPaths.add(folded);
      for (const id of entry.nodes) clearNodes.add(id);
    }

    data.declinedPaths = data.declinedPaths.filter((p) => !clearPaths.has(p));
    data.declinedNodes = data.declinedNodes.filter((id) => !clearNodes.has(id));
    result.cleared = clearPaths.size + clearNodes.size;

    // Step 2, and the reason this module is not three lines. See the header.
    const nodes = new Map(this.deps.entries());
    for (const id of clearNodes) {
      const f = nodes.get(id) ?? null;
      if (f !== null && isLive(f)) continue;
      delete data.materialized[id];
    }

    // Step 3. `flush`, not `schedulePersist`: the next step publishes to every
    // peer in the workspace, and a decision that reached the network must not be
    // able to be missing from disk afterwards.
    await this.deps.state.flush();

    for (const entry of selected) {
      const path = entry.path;
      if (path === null) continue;
      try {
        await this.deps.adopt(path);
        result.shared += 1;
      } catch {
        // I15: one unshareable file must not abandon the rest of the selection.
        result.failed.push(path);
      }
    }

    if (result.shared > 0 && this.deps.drain !== undefined) {
      try {
        await this.deps.drain();
      } catch {
        // The queue retries on its own ladder; the pass below asks again anyway.
      }
    }
    this.deps.scheduleReconcile?.('sync');
    if (result.failed.length > 0) {
      this.deps.notice?.(`ShadowLink could not share ${result.failed.length} file(s).`);
    }
    return result;
  }
}

// ============================================================ helpers

function detailOf(draft: Draft, present: boolean): string {
  if (!present) {
    return draft.dead
      ? `Deleted in the workspace${draft.deletedBy === null ? '' : ` by ${draft.deletedBy}`}; `
        + `your copy is in ${RECOVERED_DIR}/. Nothing is at this path now — `
        + 'sharing only lets a file created here later be shared again.'
      : 'Nothing is at this path now — sharing only lets a file created here later '
        + 'be shared again.';
  }
  if (draft.dead) {
    return `Deleted in the workspace${draft.deletedBy === null ? '' : ` by ${draft.deletedBy}`}, `
      + 'and kept here. Sharing uploads your copy again as a new note.';
  }
  return 'On this device only. Sharing uploads it to the workspace.';
}
