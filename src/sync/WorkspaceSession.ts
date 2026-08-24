// src/sync/WorkspaceSession.ts
// One shared document, bound into the live editor, for the note the user is
// looking at (spec §6.1).
//
// The room is `n_<nodeId>`, and the nodeId is immutable. That is the headline
// behavioural win of P1 and it is worth stating plainly: renaming or moving an
// OPEN note is a genuine no-op for this class. The reconciler calls
// `vault.rename`, Obsidian keeps the same `TFile` and the same leaf, no
// `file-open` fires, the CodeMirror compartment is never reconfigured, and no
// cursor is lost. P0 derived the room from the path and therefore had to tear the
// session down and rebuild it on every rename. That path encoder is deleted
// outright; spec §6.3 says there is NO migration, so the legacy base64url-of-path
// rooms are abandoned and their snapshots stay on disk for manual recovery. A
// test greps this file for the old function's name, so it is not spelled here.
//
// Four invariants shape everything below, and each of them exists because a
// specific scenario broke without it:
//
//  I4  — `_waitForSync` returns a BOOLEAN and every caller branches on it.
//        Seeding on a timeout produces a doubled document on reconnect: the local
//        insert and the server's existing items are disjoint Yjs insertions, so
//        the merge keeps both.
//  I5  — only the node's creator ever writes its first bytes. Two devices seeding
//        one content doc concatenates both copies into every peer's note.
//  I6  — an unpublished node this device does not own is never mounted. An empty
//        file on the canonical path is worse than no file: it looks correct.
//  I7  — a superseded open must not mount. `open()` bumps a token and an in-flight
//        open bails at EVERY await point if it lost it. Without that, the wait
//        window (up to ~11 s: 3 s for the node plus 8 s for the doc) lets note A's
//        Y.Text be seeded with note B's body and mounted into B's editor —
//        adversarial review demonstrated exactly that, end to end.
//  I17 — `s` and `contentHash` are claims that the workspace holds this content.
//        They advance only after `flush()` reports a genuine acknowledgement.
//
// TESTABILITY. Everything that does not need a running Obsidian is behind a port:
// the vault (`VaultPort`), the network (`ProviderPort`) and the editor
// (`EditorBinding`). The CodeMirror mount is the only part that cannot be
// exercised headlessly, so it is the only part behind `EditorBinding` — and its
// real implementation, `CodeMirrorBinding`, is the P0 `Compartment` approach
// unchanged. This file imports `@codemirror/*`, `y-codemirror.next` and
// `y-websocket`, but never `obsidian`: the leaf/view lookup arrives as an
// injected callback so the whole module stays loadable in a headless test.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { Compartment } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { NODE_WAIT_MS, NOTE_SYNC_TIMEOUT_MS, RECOVERED_DIR } from '../tree/constants.ts';
import { assertInsideShare, fold, hashOf } from '../tree/paths.ts';
import { deriveTree } from '../tree/TreeIndex.ts';
import type { TreeDoc } from '../tree/TreeDoc.ts';
import type { DeviceState } from './DeviceState.ts';
import type { VaultPort } from './VaultPort.ts';

// ============================================================ ports

/**
 * The awareness surface the session needs. Structurally satisfied by
 * `y-protocols`' `Awareness`, which is what the real provider hands back.
 */
export interface SessionAwareness {
  setLocalStateField(field: string, value: unknown): void;
}

/**
 * The provider surface the session needs — a subset of y-websocket's
 * `WebsocketProvider`, narrowed so a test can supply one without a socket.
 */
export interface SessionProvider {
  /** True once a GENUINE server sync has been observed. A timeout is not a sync. */
  readonly synced: boolean;
  readonly awareness: SessionAwareness;
  on(event: 'sync', handler: (isSynced: boolean) => void): void;
  off(event: 'sync', handler: (isSynced: boolean) => void): void;
  /**
   * Resolves true only once this connection's pending updates have been
   * acknowledged; false when that confirmation did not arrive. Mirrors
   * `DocPort.flush` and exists for the same reason (I17).
   */
  flush(): Promise<boolean>;
  disconnect(): void;
  destroy(): void;
}

export interface ProviderPort {
  /** Create AND start a provider for `room`, bound to `doc`. */
  connect(room: string, doc: Y.Doc): SessionProvider;
}

/**
 * The editor mount, isolated so everything else in this file is testable.
 *
 * `mount` takes the target PATH rather than a view: it is the binding's job to
 * find the leaf showing that file, and its job to report honestly when there is
 * none, so the session can release the document instead of holding a session
 * nothing is looking at.
 */
export interface EditorBinding {
  /** Bind `text` into the editor showing `notePath`. False when there is no such editor. */
  mount(notePath: string, text: Y.Text, awareness: SessionAwareness): boolean;
  /** Remove any binding. Idempotent, and safe once the view is gone. */
  unmount(): void;
}

// ============================================================ public surface

export interface WorkspaceSessionDeps {
  vault: VaultPort;
  state: DeviceState;
  tree: TreeDoc;
  providers: ProviderPort;
  editor: EditorBinding;
  /** Read fresh: the user can move the shared folder mid-session. */
  shareRoot: () => string;
  /** The path of the file currently focused. Re-checked before the editor is touched. */
  activePath: () => string | null;
  userName: string;
  userColor: string;
  notice: (msg: string) => void;
  now?: () => number;
  /** Bound wait for the tree to name a node for the path (spec §6.1). */
  nodeWaitMs?: number;
  /** Bound wait for a GENUINE content-doc sync. */
  syncTimeoutMs?: number;
}

interface ActiveSession {
  nodeId: string;
  notePath: string;
  doc: Y.Doc;
  provider: SessionProvider;
}

export class WorkspaceSession {
  private readonly deps: WorkspaceSessionDeps;
  private readonly now: () => number;
  private readonly nodeWaitMs: number;
  private readonly syncTimeoutMs: number;

  private active: ActiveSession | null = null;

  /**
   * Bumped by every `open()`. An in-flight open compares it at every await point
   * and abandons its work the moment it no longer matches (I7).
   */
  private token = 0;

  /**
   * Waits that must be interrupted when a newer open arrives. Without this the
   * token would only be READ after the full 8 s wait elapsed, so switching notes
   * would still stall behind the previous note's timeout.
   */
  private readonly waiters = new Set<() => void>();

  /** Opens are serialized: a session fully closes before the next one starts. */
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: WorkspaceSessionDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
    this.nodeWaitMs = deps.nodeWaitMs ?? NODE_WAIT_MS;
    this.syncTimeoutMs = deps.syncTimeoutMs ?? NOTE_SYNC_TIMEOUT_MS;
  }

  /**
   * The nodeId currently bound in the editor, or null.
   *
   * An arrow property rather than a method so it can be handed straight to
   * `PublishQueue`, the reconciler, `adopt` and `Deletions` — all of which must
   * refuse to write a file's bytes while it is live under a `yCollab` binding
   * (I7). `PublishQueue` DEFERS on a match, which is why the seeding path below
   * is not optional: a note held open here is a note only this session can
   * publish.
   */
  readonly openNodeId = (): string | null => this.active?.nodeId ?? null;

  /** The path currently bound, or null. Diagnostics and status only. */
  openNotePath(): string | null {
    return this.active?.notePath ?? null;
  }

  /**
   * Open `notePath` for collaboration, or pass null to close the active session.
   *
   * The token is bumped SYNCHRONOUSLY, before anything is queued, so a rapid
   * sequence of `file-open` events leaves exactly one winner however the
   * scheduler interleaves them.
   */
  open(notePath: string | null): Promise<void> {
    this.token += 1;
    const token = this.token;
    this.wakeWaiters();
    this.queue = this.queue
      .then(() => this.doOpen(notePath, token))
      .catch((err) => { this.deps.notice(`ShadowLink: ${messageOf(err)}`); });
    return this.queue;
  }

  /** Close whatever is open and stop. Safe to call more than once. */
  async destroy(): Promise<void> {
    this.token += 1;
    this.wakeWaiters();
    this.queue = this.queue.then(() => { this.closeActive(); });
    await this.queue;
  }

  // ============================================================ the open

  private async doOpen(notePath: string | null, token: number): Promise<void> {
    this.closeActive();
    if (notePath === null) return;
    if (token !== this.token) return;

    // Spec §6.1: resolve the room through the TREE. Never derive it from the
    // path and never guess: a guessed room is a room some other note may already
    // own, and binding into it publishes this note's bytes into that one.
    const nodeId = await this.awaitNodeForPath(notePath, this.nodeWaitMs);
    if (token !== this.token) return;
    if (nodeId === null) {
      this.localOnly(notePath, 'Not synced yet — editing locally only.');
      return;
    }

    // The bytes of the file BEING OPENED, not whatever the active editor happens
    // to hold. Reading the editor is how note B's body ends up seeding note A.
    let localText: string;
    try {
      localText = normLF(await this.deps.vault.read(notePath));
    } catch {
      if (token !== this.token) return;
      this.localOnly(notePath, 'This note could not be read — editing locally only.');
      return;
    }
    if (token !== this.token) return;

    const doc = new Y.Doc();
    const provider = this.deps.providers.connect(`n_${nodeId}`, doc);
    provider.awareness.setLocalStateField('user', {
      name: this.deps.userName,
      color: this.deps.userColor,
      colorLight: `${this.deps.userColor}33`,
    });

    const synced = await this.waitForSync(provider, this.syncTimeoutMs);
    // The token check comes FIRST. A superseded open that tested `synced` first
    // would emit a misleading "this note is not syncing" notice about a note the
    // user already navigated away from.
    if (token !== this.token) { release(provider, doc); return; }
    if (!synced) {
      release(provider, doc);
      this.localOnly(notePath, 'Offline — this note is not syncing.');
      return;
    }

    const text = doc.getText('content');
    const seeded = this.deps.tree.get(nodeId)?.s === 1;

    if (text.length === 0 && !seeded) {
      // I5. Not an error and not a failure: the author simply has not uploaded
      // yet. Mounting an empty document here would strand their content, because
      // the first keystroke would make this device's empty doc the shared truth.
      if (this.deps.state.data.owned[nodeId] !== true) {
        release(provider, doc);
        this.localOnly(notePath, 'Waiting for the author to upload this note.');
        return;
      }
      if (localText.length > 0) text.insert(0, localText);

      // I17: the round trip decides whether the workspace may be told this node
      // is published. An unconfirmed flush is a retry — the update stays in this
      // doc and the publish queue will offer the node again once the note closes.
      const confirmed = await provider.flush();
      if (token !== this.token) { release(provider, doc); return; }
      if (confirmed) this.deps.tree.patchNode(nodeId, { s: 1 });
      else this.deps.notice('This note has not reached the server yet; it will retry.');
    } else if (normLF(text.toString()) !== localText) {
      // The shared document wins on disk (spec §8 item 15: there is no merge UI),
      // so the local copy is preserved out of the way BEFORE the editor is bound.
      await this.stashLocalCopy(notePath, localText);
      if (token !== this.token) { release(provider, doc); return; }
    }

    // The target must still be the file the user is looking at. Between the first
    // await and here the user may have switched notes without a newer `open()`
    // having reached us yet.
    if (this.deps.activePath() !== notePath) { release(provider, doc); return; }
    if (!this.deps.editor.mount(notePath, text, provider.awareness)) {
      release(provider, doc);
      return;
    }
    this.active = { nodeId, notePath, doc, provider };

    // I17: the watermark is recorded only now, because only now is this device
    // genuinely bound to that text — `PublishQueue` and §5.3's `proven` check
    // both read it. The token is tested once more on the far side of the hash,
    // because mounting is itself an observable event: a `file-open` fired by the
    // dispatch above can supersede this session before the digest resolves, and
    // recording a watermark for a session that is already being torn down would
    // claim this device holds content it no longer has open.
    const finalText = normLF(text.toString());
    const sha256 = await hashOf(finalText);
    if (token !== this.token) return;
    if (this.deps.tree.get(nodeId)?.s === 1) {
      this.deps.state.data.contentHash[nodeId] = { sha256, len: finalText.length };
      this.deps.state.schedulePersist();
    }
  }

  // ============================================================ waits

  /**
   * Spec §6.1. Returns whether a GENUINE sync happened — never "the wait is
   * over" (I4). On supersession it returns the provider's real state so the
   * caller's token check, not a lie about syncing, is what ends the open.
   */
  private waitForSync(provider: SessionProvider, ms: number): Promise<boolean> {
    if (provider.synced) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        provider.off('sync', onSync);
        this.waiters.delete(wake);
        resolve(value);
      };
      const onSync = (isSynced: boolean): void => { if (isSynced) finish(true); };
      const wake = (): void => finish(provider.synced);
      provider.on('sync', onSync);
      this.waiters.add(wake);
      const timer = setTimeout(() => finish(provider.synced), ms);
    });
  }

  /**
   * Spec §6.1's `tree.awaitNodeForPath`. Bounded, and it resolves against the
   * DERIVED path (collision suffixes applied), because that is where the file
   * actually sits on disk. A stored-path lookup would hand back the node that
   * lost the collision, i.e. a different note's room.
   */
  private awaitNodeForPath(notePath: string, ms: number): Promise<string | null> {
    const immediate = this.resolveNode(notePath);
    if (immediate !== null) return Promise.resolve(immediate);

    return new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (value: string | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unobserve();
        this.waiters.delete(wake);
        resolve(value);
      };
      const wake = (): void => finish(this.resolveNode(notePath));
      // Every tree transaction, local or remote (I9): the node may be minted by
      // this device's own watcher a moment after the file was created.
      const unobserve = this.deps.tree.observe(() => {
        const id = this.resolveNode(notePath);
        if (id !== null) finish(id);
      });
      this.waiters.add(wake);
      const timer = setTimeout(() => finish(this.resolveNode(notePath)), ms);
    });
  }

  /** The live, valid FILE node materializing at `notePath`, or null. */
  private resolveNode(notePath: string): string | null {
    const root = this.deps.shareRoot().replace(/\/+$/, '');
    if (root === '') return null;
    if (!notePath.startsWith(`${root}/`)) return null;      // outside the share, and never the root itself (I14)
    const rel = notePath.slice(root.length + 1);
    if (rel === '') return null;

    const key = fold(rel);
    const entries = this.deps.tree.entries();
    const kinds = new Map(entries.map(([id, f]) => [id, f.k]));
    const derived = deriveTree(entries);

    let best: string | null = null;
    for (const [id, path] of derived.derivedPath) {
      if (kinds.get(id) !== 'f') continue;                  // a folder is not a note
      if (fold(path) !== key) continue;
      if (best === null || id < best) best = id;
    }
    return best;
  }

  private wakeWaiters(): void {
    for (const wake of [...this.waiters]) wake();
  }

  // ============================================================ teardown + notices

  private closeActive(): void {
    const session = this.active;
    this.active = null;
    if (session === null) return;
    try {
      this.deps.editor.unmount();
    } catch {
      /* the view is already gone; nothing left to unbind */
    }
    release(session.provider, session.doc);
  }

  /**
   * The note stays editable, it simply is not collaborative. This is never an
   * error path: a node that has not arrived, a doc that will not sync and an
   * author who has not published are all "not yet", and I2 forbids turning any
   * of them into something destructive.
   */
  private localOnly(notePath: string, reason: string): void {
    this.deps.notice(`${baseOf(notePath)}: ${reason}`);
  }

  /**
   * Preserve the local bytes under `ShadowLink Recovered/` (spec §2.3), which is
   * at the vault root and outside the share by construction — so the watcher
   * ignores it and no node is ever minted for a stashed copy.
   *
   * The original is left exactly where it is: the editor is about to bind the
   * shared document into it, and a stash that removed the file first would leave
   * the user staring at a missing note if the mount then failed.
   */
  private async stashLocalCopy(notePath: string, localText: string): Promise<void> {
    const dest = await this.uniquify(`${RECOVERED_DIR}/${stashName(notePath, this.now())}`);
    if (!assertInsideShare(this.deps.shareRoot(), dest, true)) return;
    try {
      if (!(await this.exists(RECOVERED_DIR))) await this.deps.vault.createFolder(RECOVERED_DIR);
      await this.deps.vault.create(dest, localText);
      this.deps.notice(
        `Your local "${baseOf(notePath)}" differed from the shared copy. `
        + `A copy was saved to ${RECOVERED_DIR}/.`,
      );
    } catch (err) {
      // I15: a stash that failed must not abort the open, and must not be
      // silent either — the shared copy is about to become what is on screen.
      this.deps.notice(`Could not save a local copy of "${baseOf(notePath)}": ${messageOf(err)}`);
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return await this.deps.vault.exists(path);
    } catch {
      return false;
    }
  }

  private async uniquify(candidate: string): Promise<string> {
    if (!(await this.exists(candidate))) return candidate;
    const ext = extOf(candidate);
    const stem = ext === '' ? candidate : candidate.slice(0, candidate.length - ext.length);
    for (let n = 2; n < 1000; n++) {
      const next = `${stem} (${n})${ext}`;
      if (!(await this.exists(next))) return next;
    }
    throw new Error(`could not find a free name for ${candidate}`);
  }
}

// ============================================================ real ports

/**
 * The P0 `Compartment` approach, unchanged, behind `EditorBinding`.
 *
 * `editorExtension()` must be registered exactly ONCE, via
 * `plugin.registerEditorExtension`. The compartment is then reconfigured in
 * place, which is what makes a rename of an open note invisible to the editor.
 */
export class CodeMirrorBinding implements EditorBinding {
  private readonly compartment = new Compartment();
  private mounted: EditorView | null = null;

  /** Resolve the CM6 view of the leaf whose file is `path`, or null. */
  constructor(private readonly viewFor: (path: string) => EditorView | null) {}

  editorExtension(): Extension {
    return this.compartment.of([]);
  }

  mount(notePath: string, text: Y.Text, awareness: SessionAwareness): boolean {
    const view = this.viewFor(notePath);
    if (view === null) return false;
    // `yCollab` types its awareness parameter as `any`; the structural interface
    // above is what the session is allowed to depend on, and the real provider
    // hands over a y-protocols Awareness that satisfies both.
    view.dispatch({ effects: this.compartment.reconfigure([yCollab(text, awareness)]) });
    this.mounted = view;
    return true;
  }

  unmount(): void {
    const view = this.mounted;
    this.mounted = null;
    if (view === null) return;
    try {
      view.dispatch({ effects: this.compartment.reconfigure([]) });
    } catch {
      /* the view was destroyed with its leaf */
    }
  }
}

/** How long `flush()` waits for the socket to drain before reporting failure. */
const FLUSH_TIMEOUT_MS = 5_000;
const FLUSH_POLL_MS = 25;

/**
 * y-websocket behind `ProviderPort`.
 *
 * The room is a single URL segment and the workspace travels as the `w` query
 * parameter, matching `server/upgradeAuth.js`; that also avoids depending on how
 * y-websocket encodes a room name containing a slash.
 */
export class WebsocketProviderPort implements ProviderPort {
  constructor(
    private readonly config: { serverUrl: string; serverKey: string; workspaceId: string },
  ) {}

  connect(room: string, doc: Y.Doc): SessionProvider {
    const provider = new WebsocketProvider(this.config.serverUrl, room, doc, {
      connect: true,
      params: { t: this.config.serverKey, w: this.config.workspaceId },
      disableBc: true,
    });
    return new WebsocketSessionProvider(provider);
  }
}

class WebsocketSessionProvider implements SessionProvider {
  constructor(private readonly provider: WebsocketProvider) {}

  get synced(): boolean {
    return this.provider.synced;
  }

  get awareness(): SessionAwareness {
    return this.provider.awareness;
  }

  on(event: 'sync', handler: (isSynced: boolean) => void): void {
    this.provider.on(event, handler);
  }

  off(event: 'sync', handler: (isSynced: boolean) => void): void {
    this.provider.off(event, handler);
  }

  /**
   * KNOWN LIMITATION, deliberately explicit. y-websocket exposes no
   * application-level acknowledgement, so the strongest signal available without
   * a protocol change is "the bytes left this process and the connection is still
   * up": the socket's send buffer has drained while the provider is still
   * connected and synced. It is a weaker guarantee than `DocPort.flush`'s server
   * acknowledgement, so it is reported honestly (false on any doubt) and it never
   * reports true for a socket that closed. Strengthening it belongs with the
   * server work in spec §1.5.
   */
  async flush(): Promise<boolean> {
    const deadline = Date.now() + FLUSH_TIMEOUT_MS;
    for (;;) {
      const ws = this.provider.ws;
      if (!this.provider.wsconnected || ws === null) return false;
      if (ws.bufferedAmount === 0) return this.provider.synced;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, FLUSH_POLL_MS));
    }
  }

  disconnect(): void {
    this.provider.disconnect();
  }

  destroy(): void {
    this.provider.destroy();
  }
}

// ============================================================ helpers

/** Release a provider and its document. Never throws: teardown is not optional. */
function release(provider: SessionProvider, doc: Y.Doc): void {
  try {
    provider.disconnect();
  } catch {
    /* already gone */
  }
  try {
    provider.destroy();
  } catch {
    /* already gone */
  }
  try {
    doc.destroy();
  } catch {
    /* already gone */
  }
}

/** I18: compare and hash on normalized line endings; never write the result to disk. */
function normLF(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** `.md` for `a/b.md`, `''` for an extensionless or dotfile name. */
function extOf(path: string): string {
  const base = baseOf(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

/** Filesystem-safe wall-clock stamp for a stashed copy's name. */
function stampOf(ms: number): string {
  return new Date(ms).toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
}

/** `Notes/a.md` -> `a (local copy 2026-06-26T10-00-00).md`. Mirrors the reconciler. */
function stashName(path: string, at: number): string {
  const base = baseOf(path);
  const ext = extOf(base);
  const stem = ext === '' ? base : base.slice(0, base.length - ext.length);
  return `${stem} (local copy ${stampOf(at)})${ext}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
