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

  /** Release the handle. Safe to call more than once (callers close in a `finally`). */
  close(handle: DocHandle): void;
}
