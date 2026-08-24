// src/sync/DocPort.ts
// Access to a note's content document without a CodeMirror binding (spec §4.0).
//
// "Headless" matters: the publish queue and the materializer need a document's
// text while the note is NOT open in an editor. Reusing the editor's binding for
// that would mean writing under a live `yCollab` session, which invariant I7
// forbids — Obsidian's external-change reload gets translated into Y.Text ops and
// broadcast to every peer as a whole-document overwrite.
//
// Like VaultPort, this file must stay free of `obsidian` imports.

/**
 * An opaque, released-by-`close` reference to one open content document.
 * Implementations may carry more; callers may rely only on `room`.
 */
export interface DocHandle {
  readonly room: string;
}

export interface DocPort {
  /**
   * Open `room` without an editor binding.
   *
   * `synced` reports whether a GENUINE provider sync event was observed. A timeout
   * is not a sync (invariant I3/I4): callers must branch on this flag, because
   * seeding on a timeout produces a doubled document on reconnect — the local
   * insert and the server's existing items are disjoint Yjs insertions and both
   * survive the merge.
   */
  openHeadless(room: string): Promise<{ text: string; synced: boolean; handle: DocHandle }>;

  /**
   * Write `text` into the document only if it is still empty; returns false and
   * changes nothing otherwise. This emptiness check is the guard behind invariant
   * I5 — concurrent seeding concatenates both copies into every peer's note.
   */
  insertIfEmpty(handle: DocHandle, text: string): Promise<boolean>;

  /**
   * Await the round trip: resolves `true` only once the local updates on this
   * handle have been acknowledged by the server, `false` when that confirmation
   * did not arrive in time.
   *
   * Invariant I17 is why this returns a boolean rather than `void`. The publish
   * queue advances two watermarks after seeding — the node's `s` flag and this
   * device's `contentHash` — and both are claims that the workspace now holds the
   * content. Advancing them on an update that is still sitting in an outbound
   * buffer means the node reads as published on a machine that then loses the
   * write, and no later pass will ever offer it again, because `s` says the job
   * is done. An unconfirmed flush is a retry, never a completion.
   */
  flush(handle: DocHandle): Promise<boolean>;

  /** Release the handle. Safe to call more than once (callers close in a `finally`). */
  close(handle: DocHandle): void;
}
