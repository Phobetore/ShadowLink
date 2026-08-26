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
//  I17 — `s` and `contentHash` are claims about content, and they are different
//        claims. `s` says the workspace holds it, and advances only after
//        `flush()` reports a genuine acknowledgement. `contentHash` says THIS
//        DISK holds it, and may name only bytes that are simultaneously in the
//        workspace and in this device's own file — never the CRDT's text on the
//        strength of a mount, which is how one vault came to record another
//        vault's file as its own base.
//  I18 — a content document contains no `\r`, EVER. Both writers of disk bytes
//        into one normalize with `\r\n?`, and a document written by an older
//        build is repaired in place before anything compares it. CodeMirror
//        cannot hold a `\r` at all, so a document that holds one can never equal
//        a buffer, and I19 would refuse such a note for the rest of its life.
//  I19 — a `Y.Text` is bound into an editor only when it EQUALS what that editor
//        holds, raw `===`, re-read after every dispatch. The two sides are made
//        equal beforehand by moving whichever one is PROVABLY stale, and the
//        buffer may be moved into the CRDT only where this device can show it is
//        its own continuation of that note. See `decide`.
//
// I19 is why this file has five arms instead of one. The version before it
// replaced the editor's buffer whenever it differed from the shared document,
// which is right on exactly one of them: it destroyed a brand-new note's only
// copy on the arm that was about to seed from it, and destroyed a healthy note's
// keystrokes with no copy and no notice on the arm where the workspace and the
// disk agreed and only the user's own typing had moved.
//
// TESTABILITY. Everything that does not need a running Obsidian is behind a port:
// the vault (`VaultPort`), the network (`ProviderPort`) and the editor
// (`EditorBinding`). This file imports `@codemirror/*`, `y-codemirror.next` and
// `y-websocket`, but never `obsidian`: the leaf/view lookup arrives as an
// injected callback so the whole module stays loadable in a headless test.
//
// This header used to say the CodeMirror mount was the one part that could not
// be exercised headlessly, and left it to a GUI checklist. That was wrong, and
// it was expensive: `EditorState` needs no DOM, so `CodeMirrorBinding` can be
// driven against a real document with nothing but `@codemirror/state`, and
// `FakeEditorBinding` in `fakes.ts` does exactly that. The belief that the mount
// was untestable is why a fake editor with no document went unnoticed for three
// phases, and why "mounted a 184-character document into an editor showing 166
// characters" and "mounted correctly" were the same assertion in every test.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { Compartment, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { NODE_WAIT_MS, NOTE_SYNC_TIMEOUT_MS, RECOVERED_DIR } from '../tree/constants.ts';
import {
  assertInsideShare, fallbackForkName, fold, forkName, hashOf, validateRel,
} from '../tree/paths.ts';
import { deriveTree } from '../tree/TreeIndex.ts';
import type { TreeDoc } from '../tree/TreeDoc.ts';
import type { DeviceState } from './DeviceState.ts';
import { ProviderAck } from './ProviderAck.ts';
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
 * The single contiguous change that turns one string into another.
 *
 * Exact, not approximate: applying it to `from` yields `to`, always. It is the
 * common prefix and the common suffix held fixed and everything between them
 * replaced, which is the only edit shape this file needs — the two strings it is
 * ever computed over are one revision of a note and the same revision with the
 * user's last few seconds of typing in it.
 */
export interface AffixEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** The single contiguous change turning `from` into `to`. */
export function affixEdit(from: string, to: string): AffixEdit {
  const max = Math.min(from.length, to.length);
  let p = 0;
  while (p < max && from[p] === to[p]) p += 1;
  let s = 0;
  while (s < max - p && from[from.length - 1 - s] === to[to.length - 1 - s]) s += 1;
  return { from: p, to: from.length - s, insert: to.slice(p, to.length - s) };
}

/**
 * Does `buf` keep at least half of `base` untouched at its two ends?
 *
 * THIS IS NOT A MERGE HEURISTIC. It is a sanity bound on the claim *"this buffer
 * was built from this note"*, and it exists because `viewFor` resolves a leaf by
 * `view.file.path` while reading `view.editor.cm`, and Obsidian sets the file
 * before it loads the document. A foreign buffer that happens to share a prefix
 * and a suffix with the shared text passes an affix check and would then be
 * broadcast to every peer as this note's new body.
 *
 * One half is the only tuned number in this design, and it was picked rather
 * than derived: comfortably above any realistic eight seconds of typing, and
 * comfortably below any realistic foreign buffer. What it costs is named: a user
 * who deletes more than half a note inside the open window has that edit refused,
 * the buffer preserved, and the cursor reset. Nothing is lost and they are told —
 * and the alternative, on a state genuinely indistinguishable from inside the
 * plugin, is broadcasting another note's body to everybody.
 */
export function retains(base: string, buf: string): boolean {
  if (base === '') return true;
  const edit = affixEdit(base, buf);
  return edit.from + (base.length - edit.to) >= base.length / 2;
}

/**
 * What `apply` is being asked to do, decided BEFORE it is called and from four
 * strings and two booleans (see `decide`).
 *
 * `expect` is the buffer the decision was made from. `apply` re-reads the live
 * document and refuses if it has moved, so a plan can never be executed against
 * a buffer nobody looked at.
 */
export type MountPlan =
  | { kind: 'agree'; expect: string }
  | { kind: 'converge-up'; expect: string; edit: AffixEdit }
  | { kind: 'take-shared'; expect: string };

/**
 * What a mount did, which is three facts and not one.
 *
 * It used to be a boolean, and the missing half cost the user their keystrokes:
 * a mount that establishes an equality by REPLACING a document has destroyed
 * whatever that document held, and only the mount knows what that was. The
 * caller reads the file, not the editor, so it cannot find out afterwards —
 * by then the buffer holds the shared text.
 */
export interface MountResult {
  /** A binding is installed AND the editor holds the shared text, EXACTLY. */
  readonly ok: boolean;
  /**
   * The buffer `apply` actually displaced, present only when it displaced any.
   *
   * This is the newest copy of the note in existence at that instant: newer
   * than the file, because Obsidian's save of a dirty buffer is asynchronous
   * and the user has been typing into it since the open began. Preserving it is
   * the caller's job (I1), and preserving the FILE instead — which is what the
   * caller could see on its own — preserves a revision the user has already
   * moved past while destroying the paragraph they just wrote.
   *
   * Reported on a refusal too. The buffer is deliberately left holding the
   * shared text when a bind does not take, so the characters are just as gone
   * as they are after a success.
   */
  readonly replaced?: string;
  /** The buffer moved between `bufferOf` and `apply`; NOTHING was written. */
  readonly stale?: boolean;
}

export interface EditorBinding {
  /**
   * What the editor showing `notePath` HOLDS right now, or null when there is no
   * bindable leaf for it — no view, or a view whose state does not carry the
   * compartment. Never writes. Never dispatches.
   *
   * Split out of `mount` deliberately. On the three arms that do not displace
   * anything there is now no `await` between reading the buffer and acting on
   * it, so the window in which a keystroke could be decided about and then
   * destroyed does not exist to be raced rather than merely being narrower.
   */
  bufferOf(notePath: string): string | null;
  /**
   * Execute `plan` against the editor showing `notePath`, then bind `text` into
   * it. Synchronous from the first read to the gate.
   *
   * `y-codemirror.next` never reconciles an editor with the `Y.Text` it is
   * handed: `YSyncPluginValue`'s constructor installs an observer and nothing
   * else, so its documented usage is `EditorState.create({ doc: ytext.toString(),
   * … })` — the caller is expected to have made the two equal already. Bind a
   * 184-character `Y.Text` into an editor showing 166 characters and every
   * later remote delta addresses a position in a document that does not exist:
   * `RangeError: Invalid change range 15 to 16 (in doc of length 0)`, and a note
   * whose content never appears and whose file is never rewritten.
   *
   * So `ok` is a claim about what the editor now CONTAINS, not about a dispatch
   * having been issued, and the gate that decides it compares raw `===` (I19).
   */
  apply(
    notePath: string,
    text: Y.Text,
    awareness: SessionAwareness,
    plan: MountPlan,
  ): MountResult;
  /** Remove any binding. Idempotent, and safe once the view is gone. */
  unmount(): void;
}

/**
 * I19, entire, and pure so that every case of it is a table rather than a
 * scenario.
 *
 * `B` — what the editor holds. Always LF: CodeMirror cannot hold a `\r`.
 * `R` — the shared document, after the line-ending repair.
 * `f` — `toLF` of what `vault.read` returned at the top of this open.
 *
 * The order of the arms is the design. Read it as: agree if the two sides are
 * already the same string; refuse if the buffer is not there to be believed;
 * move the CRDT up to the buffer when this device can SHOW the buffer is its own
 * continuation of that note; otherwise the shared copy wins on screen and
 * whatever it displaces is preserved first.
 *
 * Nothing here normalises anything. Both writers into a content document
 * normalise on the way in and the document is repaired before this is called, so
 * every string reaching it is already LF-only — and a comparison that decides a
 * binding must never be normalised (I18).
 */
export type Decision =
  | { kind: 'agree' }
  | { kind: 'converge-up'; edit: AffixEdit }
  | { kind: 'take-shared' }
  | { kind: 'local-only'; reason: string };

export function decide(
  B: string,
  R: string,
  f: string,
  own: boolean,
  seeded: boolean,
): Decision {
  // 1. AGREE. Nothing is written to either side and nothing is ever preserved
  //    on this arm — which, with a content-derived preservation name, is what
  //    leaves the nine-copies failure no path at all.
  if (B === R) return { kind: 'agree' };

  // 2. The buffer is empty and the file is not. A leaf Obsidian has not
  //    populated and a select-all-delete are the same state from in here, and
  //    one of them is "empty a shared note on the strength of a transient
  //    editor state". Costs one open; the next `file-open` heals it.
  if (B === '' && f !== '') {
    return {
      kind: 'local-only',
      reason: 'its editor had not finished loading — switch away and back to try again.',
    };
  }

  // 3. The shared document has never held anything.
  if (R === '' && !seeded) {
    // I5. Only the creator writes a content doc's first bytes; two devices
    // seeding one concatenates both copies into every peer's note. Checked in
    // `doOpen` as well, before the editor is touched at all — kept here so this
    // function is total and the table is the whole rule.
    if (!own) return { kind: 'local-only', reason: 'Waiting for the author to upload this note.' };
    // SEED: the degenerate converge-up, from nothing to the buffer. The buffer
    // is the only copy of a brand-new note in existence, so the one thing this
    // arm must never do is replace it.
    if (retains(f, B)) return { kind: 'converge-up', edit: affixEdit(R, B) };
    return { kind: 'take-shared' };
  }

  // 4. The workspace and this disk agree, so the buffer is the only thing that
  //    has moved — this device's own typing during the open window. CATCH-UP:
  //    the CRDT comes up to the buffer, and the buffer is never touched.
  if (R !== '' && R === f) {
    if (retains(R, B)) return { kind: 'converge-up', edit: affixEdit(R, B) };
    return { kind: 'take-shared' };
  }

  // 5. Genuine divergence: the file and the workspace hold different revisions
  //    of this note and there is no merge UI (spec §8 item 15).
  return { kind: 'take-shared' };
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
  /**
   * Tell the publish queue this session has published a node itself.
   *
   * `publishOne` DEFERS on a node the session holds open (I7), and a deferral is
   * "not now" rather than "not ever", so the entry stays pending and stays
   * counted — which means an unpublished note held open asks the reconciler for
   * a full pass every 30 seconds for as long as it is open. This is the one
   * writer of `s` that is not the queue, so it is the one that owes the queue an
   * answer.
   */
  markPublished?: (nodeId: string) => void;
  /**
   * Ask for a reconcile pass. Called when a session CLOSES, and that is the whole
   * handoff: `publishOne` defers on a node this session holds open (I7), and the
   * deferral lifts the moment `openNodeId()` goes null. Without this the queue
   * finds out at the next 30-second tick, so a note the user closed sits
   * unpublished for up to half a minute for no reason.
   */
  scheduleReconcile?: (cause: string) => void;
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

  /**
   * The digest of the shared text this session most recently BOUND for a node.
   *
   * A THIRD claim about content, with a third name, and that is I17's own lesson
   * applied once more. `s` says THE WORKSPACE holds it. `contentHash` says THIS
   * DISK holds it. This says THIS WORKSPACE'S DOCUMENT HELD THESE BYTES — it
   * makes no claim about any disk, so it can never be misread as `contentHash`,
   * whose whole amendment was that conflating the two put each vault's watermark
   * on the other's file.
   *
   * It exists for exactly one decision: whether a copy is owed when the buffer is
   * about to be replaced. Notes are never rewritten from the CRDT while closed —
   * the reconciler skips every bound node — so a stale disk copy is the NORMAL
   * state of every note a collaborator has touched, and without a redundancy test
   * every one of those opens files a recovery copy of this device's own past
   * revision and tells the user their work differed.
   *
   * `contentHash` answers the same question for a note this device materialized
   * or published, and it survives a restart. This covers the case it cannot: a
   * divergent open deliberately DELETES the watermark (there are no bytes both in
   * the workspace and on this disk at that moment), so the next divergence would
   * otherwise fork the revision this very session put on screen.
   */
  private readonly sharedSeen = new Map<string, string>();

  /** Disposes the first-byte publisher's observer, or null when none is armed. */
  private publisherOff: (() => void) | null = null;

  /**
   * Whether this session has already said an update did not reach the server.
   * Once is information; once per keystroke is noise the user learns to ignore.
   */
  private publishNoticed = false;

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
      localText = toLF(await this.deps.vault.read(notePath));
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
    // (L) I18. Before ANY comparison, and before the mount can be asked to make
    // an equality no configuration can satisfy. A document written by an older
    // build can hold `\r`; both writers that put disk bytes into one normalize
    // now, so this is a repair of history rather than an ongoing hazard.
    this.repairLineEndings(text);
    const seeded = this.deps.tree.get(nodeId)?.s === 1;
    const own = this.deps.state.data.owned[nodeId] === true;
    /** `R`: the shared document, after the repair. Read once, before the buffer. */
    const shared = text.toString();

    if (shared === '' && !seeded && !own) {
      // I5. Not an error and not a failure: the author simply has not uploaded
      // yet. Binding an empty document here would strand their content, because
      // the first keystroke would make this device's empty doc the shared truth.
      // `decide` encodes this rule too, so the table is the whole of I19; it is
      // ALSO here so the editor is never even read for a note this device has no
      // business writing into.
      release(provider, doc);
      this.localOnly(notePath, 'Waiting for the author to upload this note.');
      return;
    }

    // The target must still be the file the user is looking at. Between the first
    // await and here the user may have switched notes without a newer `open()`
    // having reached us yet.
    if (this.deps.activePath() !== notePath) { release(provider, doc); return; }

    // THE DECISION AND ITS APPLICATION, and on three of the five arms there is no
    // `await` between them.
    //
    // That is blocker 2 closed structurally rather than narrowed: the buffer is
    // read, decided about and acted on inside one turn of the event loop, so
    // there is no window in which a keystroke can be observed and then thrown
    // away. The loop runs at most twice, and only for the `stale` answer that the
    // no-await arms cannot produce — a can't-happen worth one comparison, because
    // what it would otherwise write is a string nobody looked at into a document
    // every peer reads.
    let mounted: MountResult | undefined;
    let buffer = '';
    let preserved: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const B = this.deps.editor.bufferOf(notePath);
      if (B === null) { release(provider, doc); return; }      // arm 0: no bindable leaf
      buffer = B;
      const plan = decide(B, shared, localText, own, seeded);
      if (plan.kind === 'local-only') {
        release(provider, doc);
        this.localOnly(notePath, plan.reason);
        return;
      }
      if (plan.kind === 'take-shared') {
        // PRESERVE FIRST, and this ordering is the whole of I1 on this arm. Both
        // the buffer and the file are about to stop existing — the buffer is
        // replaced with the shared text, and Obsidian then saves that over the
        // file — so nothing is displaced until a copy of it is CONFIRMED on
        // disk. The previous round preserved afterwards, on the strength of what
        // the apply reported, which leaves a window between the replacement and
        // a `vault.create` that throws in which the user's bytes are nowhere.
        preserved = [];
        for (const lost of await this.lostStrings(nodeId, B, localText, shared)) {
          const dest = await this.preserveCopy(notePath, lost);
          if (dest === null) {
            // NO BIND. A bind after a failed preservation lets Obsidian save the
            // shared text over bytes nothing holds. `preserveCopy` has already
            // said so, naming the note and the reason (I15).
            release(provider, doc);
            return;
          }
          if (dest !== '') preserved.push(dest);
        }
        if (token !== this.token) { release(provider, doc); return; }
      }
      const planned: MountPlan = plan.kind === 'converge-up'
        ? { kind: 'converge-up', expect: B, edit: plan.edit }
        : plan.kind === 'agree'
          ? { kind: 'agree', expect: B }
          : { kind: 'take-shared', expect: B };
      mounted = this.deps.editor.apply(notePath, text, provider.awareness, planned);
      if (mounted.stale !== true) break;
    }
    if (mounted === undefined) { release(provider, doc); return; }
    if (mounted.ok) this.active = { nodeId, notePath, doc, provider };
    else release(provider, doc);

    // BELT AND BRACES: what the apply ACTUALLY displaced, when that is not the
    // buffer the decision was made about.
    //
    // `take-shared` is the one arm with an await between reading the buffer and
    // acting on it, and Obsidian's save of a dirty buffer is asynchronous — so
    // from the user's first keystroke the EDITOR holds the newest copy of this
    // note and the file does not, and only `apply` ever sees the copy it
    // displaced. Owed on a REFUSAL too: the buffer is left holding the shared
    // text either way, so those characters are exactly as gone as after a
    // success.
    if (mounted.replaced !== undefined && mounted.replaced !== buffer) {
      const dest = await this.preserveCopy(notePath, mounted.replaced);
      if (dest !== null && dest !== '') preserved.push(dest);
    }

    if (!mounted.ok) return;
    if (mounted.replaced !== undefined) this.reportTakeShared(notePath, preserved);

    // I6: the node goes live the moment it HAS content, and not before.
    if (!seeded && own) {
      if (text.length > 0) await this.publishFirstBytes(nodeId, text, provider, token);
      else this.armPublisher(nodeId, text, provider, token);
      if (token !== this.token) return;
    }

    // I17. A watermark names bytes that are simultaneously in the workspace and
    // on THIS disk, and it may advance only once a write has returned. This
    // method performs no disk write and can observe none, so the only string in
    // it that this device is known to hold is `localText` — the bytes it read
    // off its own disk a moment ago. Recording is therefore honest in exactly
    // one case: when the workspace's text IS that string.
    //
    // It used to record `text.toString()` unconditionally, which is how vault A
    // came to record vault B's file as its own base and vault B came to record
    // the server's content it did not have. That is not cosmetic: §5.3's
    // `proven` check reads this watermark to choose between the vault trash and
    // a rescue.
    //
    // The divergent case deliberately records NOTHING and removes what it finds,
    // because after the mount the disk holds a revision the workspace has moved
    // past and the editor holds one the disk has not caught up with — there is
    // no text that is on both. The evidence arrives at the next open of this
    // note: `vault.read` returns the bytes Obsidian saved, they equal the shared
    // text, and the watermark is recorded from a string this device read off its
    // own disk. Absence in the meantime is the safe direction — an unproven note
    // is rescued rather than trashed.
    //
    // The token is tested once more on the far side of the hash, because
    // mounting is itself an observable event: a `file-open` fired by the dispatch
    // above can supersede this session before the digest resolves, and recording
    // a watermark for a session that is already being torn down would claim this
    // device holds content it no longer has open.
    const finalText = text.toString();
    const sha256 = await hashOf(finalText);
    if (token !== this.token) return;

    // "This workspace's document held these bytes." Recorded on EVERY bind,
    // including the ones that record no watermark, because it makes no claim
    // about any disk and so cannot go stale in the way `contentHash` can.
    this.sharedSeen.set(nodeId, sha256);

    if (finalText !== localText) {
      if (this.deps.state.data.contentHash[nodeId] !== undefined) {
        delete this.deps.state.data.contentHash[nodeId];
        this.deps.state.schedulePersist();
      }
      return;
    }
    if (this.deps.tree.get(nodeId)?.s === 1) {
      this.deps.state.data.contentHash[nodeId] = { sha256, len: finalText.length };
      this.deps.state.schedulePersist();
    }
  }

  /**
   * I6, and blocker 4's other half: publish this node the moment its document
   * HAS content, rather than when the note closes.
   *
   * Obsidian's "New note" is a 0-byte file that Obsidian then opens, so the
   * session reaches such a node before the publish queue can. The queue in turn
   * DEFERS on a node the session holds open (I7), and a deferral is "not now"
   * rather than "not ever" — so without a publisher here the note is invisible
   * to every peer for as long as it is open, and its still-pending entry asks
   * the reconciler for a full pass every 30 seconds meanwhile.
   *
   * A one-shot observer on the document, disposed by `closeActive`. In
   * production the user's own typing reaches the `Y.Text` through `yCollab`, so
   * this fires on the first keystroke.
   */
  private armPublisher(
    nodeId: string,
    text: Y.Text,
    provider: SessionProvider,
    token: number,
  ): void {
    this.disarmPublisher();
    const observer = (): void => {
      if (text.length === 0) return;
      this.disarmPublisher();
      void this.publishFirstBytes(nodeId, text, provider, token);
    };
    text.observe(observer);
    this.publisherOff = (): void => { text.unobserve(observer); };
  }

  private disarmPublisher(): void {
    const off = this.publisherOff;
    this.publisherOff = null;
    off?.();
  }

  /**
   * I17: confirm, then advance. `s` is never re-offered by anybody, so a
   * premature one is permanent content loss rather than a retry.
   *
   * `contentHash` is deliberately NOT recorded alongside it. A watermark names
   * bytes that are simultaneously in the workspace and ON THIS DISK, and at this
   * moment the disk still holds whatever it held before the user typed —
   * Obsidian's save is asynchronous and this method performs no disk write. Such
   * a note is "unproven" until its next converged open, which means a remote
   * tombstone rescues it rather than trashing it: the safe direction.
   */
  private async publishFirstBytes(
    nodeId: string,
    text: Y.Text,
    provider: SessionProvider,
    token: number,
  ): Promise<void> {
    let confirmed = false;
    try {
      confirmed = await provider.flush();
    } catch {
      confirmed = false;                                 // transport, not a publish
    }
    if (token !== this.token) return;
    if (confirmed && text.length > 0) {
      this.deps.tree.patchNode(nodeId, { s: 1 });
      this.deps.markPublished?.(nodeId);
      return;
    }
    // An unconfirmed flush is a retry. Re-armed on the NEXT change rather than
    // immediately, because retrying in a tight loop is not retrying — and said
    // once rather than once per keystroke.
    if (!this.publishNoticed) {
      this.publishNoticed = true;
      this.deps.notice('This note has not reached the server yet; it will retry.');
    }
    this.armPublisher(nodeId, text, provider, token);
  }

  /**
   * I18. Make the content document LF-only, in place, before anything compares
   * it. Returns whether it had to do anything.
   *
   * WHY IT EXISTS AT ALL. CodeMirror cannot hold a `\r`:
   * `EditorState.create({ doc: 'a\r\nb' })` yields `"a\nb"`, `{ doc: 'a\rb' }`
   * yields `"a\nb"`, `EditorState.lineSeparator` does not change it, and
   * `y-codemirror.next` sends `sliceString(0, len, '\n')`. So a `Y.Text` holding
   * `\r` can never equal a buffer, and I19's gate would refuse such a note for
   * ever. Repairing is the only answer that lets the note be edited again.
   *
   * BACKWARDS, so an index that has already been visited stays valid, and in ONE
   * transaction, so no remote update can interleave and no peer sees a half-fixed
   * document.
   *
   * DELETE-THEN-INSERT for a lone `\r`, and this was measured rather than
   * reasoned about. Delete-only is idempotent and converges, but for a lone `\r`
   * it removes the break entirely — `"one\rtwo\rthree"` becomes `"onetwothree"`
   * on every device, with one repairer or ten, which is destroying structure the
   * user typed. Delete-then-insert is lossless with one repairer; two peers
   * repairing inside one sync window converge on one extra blank line per site,
   * which is convergent, cosmetic, and confined to classic-Mac line endings.
   * For `\r\n` the two rules are identical. Three peers repairing CRLF
   * independently all reach the LF text, and repairing twice is a no-op.
   */
  private repairLineEndings(text: Y.Text): boolean {
    const before = text.toString();
    if (!before.includes('\r')) return false;
    text.doc?.transact(() => {
      for (let i = before.length - 1; i >= 0; i--) {
        if (before[i] !== '\r') continue;
        text.delete(i, 1);
        if (before[i + 1] !== '\n') text.insert(i, '\n');
      }
    });
    return true;
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
    // Before anything else: an observer left on a released document would keep
    // this session publishing a node it no longer holds.
    this.disarmPublisher();
    const session = this.active;
    this.active = null;
    if (session === null) return;
    try {
      this.deps.editor.unmount();
    } catch {
      /* the view is already gone; nothing left to unbind */
    }
    release(session.provider, session.doc);
    // `openNodeId()` is null from here, so the queue's I7 deferral has just
    // lifted. Telling it now rather than letting the 30-second tick find out is
    // the difference between a note publishing when the user closes it and half
    // a minute later.
    this.deps.scheduleReconcile?.('sync');
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
   * Which of the two strings about to stop existing are owed a copy (I1).
   *
   * `B` is the buffer — replaced with the shared text. `f` is the file, which
   * Obsidian then saves that same shared text over. Both are about to be gone,
   * and a copy is owed for each one that is neither the shared text itself nor
   * PROVABLY still held by the workspace.
   *
   * Provably held means the workspace can give those exact bytes back: it holds
   * something (`R !== ''`), and this device has a record of those bytes having
   * been in the workspace's document or on this disk. Notes are never rewritten
   * from the CRDT while closed, so a stale disk copy is the ordinary state of
   * every note a collaborator has touched — without this test, the single most
   * common event in the product files a recovery copy and tells the user their
   * work differed.
   *
   * An EMPTIED document holds nothing to give back, so when `R === ''` nothing
   * is ever provably held, whatever the watermarks say.
   *
   * `f` is skipped when `B` is being preserved and the buffer retains it: the
   * buffer is then this device's own continuation of the file, so a second file
   * for one note is noise rather than safety.
   */
  private async lostStrings(nodeId: string, B: string, f: string, R: string): Promise<string[]> {
    const held = async (x: string): Promise<boolean> => {
      if (R === '') return false;
      if (x === '') return true;
      const h = await hashOf(x);
      return this.sharedSeen.get(nodeId) === h
        || this.deps.state.data.contentHash[nodeId]?.sha256 === h;
    };
    const out: string[] = [];
    const keepB = B !== '' && B !== R && !(await held(B));
    if (keepB) out.push(B);
    if (f !== '' && f !== R && f !== B && !(keepB && retains(f, B)) && !(await held(f))) {
      out.push(f);
    }
    return out;
  }

  /**
   * Put `lost` under `ShadowLink Recovered/` (spec §2.3), which is at the vault
   * root and outside the share by construction — so the watcher ignores it and
   * no node is ever minted for a preserved copy.
   *
   * Returns the destination path, `''` when there was nothing to preserve, or
   * NULL when the copy could not be made. Null is not advisory: the caller must
   * not bind after it, because a bind lets Obsidian save the shared text over
   * bytes nothing holds.
   *
   * THE NAME IS DERIVED FROM THE CONTENT, and deliberately carries no timestamp.
   * That, plus `VaultPort.create` refusing an occupied path, is what replaces the
   * session-scoped map of "already preserved" digests the previous round used:
   * nine `file-open`s inside Obsidian's save window land on ONE name and produce
   * ONE file, structurally, and unlike a map it survives a plugin reload. It
   * mirrors `Reconciler.forkPathFor`, which reached the same conclusion for
   * attachments and for the same reason.
   *
   * The file at the canonical path is not removed: Obsidian is about to write the
   * editor's buffer over it, and removing it first would leave the user staring
   * at a missing note for as long as that save took.
   *
   * EVERY step is inside the try, hashing and name-finding included. I15's rule
   * is that a failed preservation must not abort the open and must not be silent;
   * a rule that only holds for the failures someone happened to wrap is neither.
   */
  private async preserveCopy(notePath: string, lost: string): Promise<string | null> {
    // A copy of nothing preserves nothing, and the notice that goes with it is
    // untrue. Nine 0-byte "local copies" is what the incident looked like from
    // the user's side, and not one of them held anything.
    if (lost.length === 0) return '';
    try {
      const dest = `${RECOVERED_DIR}/${this.forkNameFor(baseOf(notePath), await hashOf(lost))}`;
      if (!assertInsideShare(this.deps.shareRoot(), dest, true)) {
        throw new Error(`${dest} is not a destination this plugin may write`);
      }
      // The name names the content, so an occupied path already holds these
      // exact bytes. Preserved, and nothing more to do.
      if (await this.exists(dest)) return dest;
      if (!(await this.exists(RECOVERED_DIR))) await this.deps.vault.createFolder(RECOVERED_DIR);
      await this.deps.vault.create(dest, lost);
      return dest;
    } catch (err) {
      this.deps.notice(
        `Could not save a copy of "${baseOf(notePath)}": ${messageOf(err)}. `
        + 'It is not syncing and the shared copy has not been applied — your text is untouched.',
      );
      return null;
    }
  }

  /**
   * `Plan.md` -> `Plan (conflicted copy — Ada, 3f9c1a02).md`, falling back to the
   * undecorated form when the display name pushes the result past what
   * `validateRel` accepts. Mirrors `Reconciler.forkPathFor`.
   */
  private forkNameFor(name: string, digest: string): string {
    const who = this.deps.userName;
    const decorated = who.trim() === ''
      ? fallbackForkName(name, digest)
      : forkName(name, digest, who);
    if (validateRel(RECOVERED_DIR, decorated, 'f')) return decorated;
    const plain = fallbackForkName(name, digest);
    if (validateRel(RECOVERED_DIR, plain, 'f')) return plain;
    throw new Error(`no valid name under ${RECOVERED_DIR}/ for ${name}`);
  }

  /**
   * What the user is told after the one arm that displaces anything.
   *
   * The other three say NOTHING, and that is the point: they did not do anything
   * the user needs to know about. This one names the note and, where there is
   * one, the file — never "a copy was saved to ShadowLink Recovered/", which
   * leaves them to work out which of the files in it is theirs.
   */
  private reportTakeShared(notePath: string, preserved: string[]): void {
    const name = baseOf(notePath);
    if (preserved.length === 0) {
      this.deps.notice(`"${name}" was updated to the shared version.`);
      return;
    }
    const where = preserved.length === 1
      ? preserved[0]
      : `${preserved.slice(0, -1).join(', ')} and ${preserved[preserved.length - 1]}`;
    this.deps.notice(
      `"${name}" now shows the shared version. `
      + `What was on your screen is saved to ${where}.`,
    );
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return await this.deps.vault.exists(path);
    } catch {
      return false;
    }
  }

}

// ============================================================ real ports

/**
 * The `Compartment` approach behind `EditorBinding`.
 *
 * `editorExtension()` must be registered exactly ONCE, via
 * `plugin.registerEditorExtension`. The compartment is then reconfigured in
 * place, which is what makes a rename of an open note invisible to the editor.
 *
 * This carried the P0 implementation unchanged until 2026-08-25, which is when
 * it turned out that reconfiguring the compartment is not a mount: it binds a
 * `Y.Text` into whatever document the editor happens to hold, and
 * `y-codemirror.next` will not reconcile the two for you. `mount` below now
 * establishes that equality itself, and reports honestly when it cannot.
 */
export class CodeMirrorBinding implements EditorBinding {
  private readonly compartment = new Compartment();
  private mounted: EditorView | null = null;

  /** Resolve the CM6 view of the leaf whose file is `path`, or null. */
  constructor(private readonly viewFor: (path: string) => EditorView | null) {}

  editorExtension(): Extension {
    return this.compartment.of([]);
  }

  /**
   * The buffer, and nothing else. No writes, no dispatch, no decision.
   *
   * `null` covers both "there is no view for this path" and "there is a view
   * whose state does not carry the compartment". The LIVENESS CHECK belongs
   * here, before anything is read or written, because `Compartment.reconfigure`
   * aimed at a state that does not contain the compartment is inert and SILENT —
   * `compartment.get(state)` is `undefined` there — so an `apply` into an editor
   * Obsidian has not finished building would otherwise report success having
   * bound nothing at all, and the session would behave as though the user were
   * editing collaboratively.
   */
  bufferOf(notePath: string): string | null {
    const view = this.viewFor(notePath);
    if (view === null) return null;
    if (this.compartment.get(view.state) === undefined) return null;
    return view.state.doc.toString();
  }

  apply(
    notePath: string,
    text: Y.Text,
    awareness: SessionAwareness,
    plan: MountPlan,
  ): MountResult {
    const view = this.viewFor(notePath);
    if (view === null) return { ok: false };
    // Liveness again, and again before anything is written: `bufferOf` and this
    // are two calls, and on the one arm that has an await between them Obsidian
    // may have rebuilt the state in the meantime.
    if (this.compartment.get(view.state) === undefined) return { ok: false };

    // WHAT IS ON SCREEN NOW, re-read rather than trusted. It is not necessarily
    // the file's bytes: Obsidian's save of a dirty buffer is asynchronous, so
    // from the user's first keystroke after the open began this is the newest
    // copy of the note anywhere.
    const now = view.state.doc.toString();
    if (now !== plan.expect && plan.kind !== 'take-shared') {
      // The decision was made about a buffer that no longer exists. On the two
      // arms that write the buffer INTO the CRDT that is a can't-happen — there
      // is no await between `bufferOf` and here — and a can't-happen that writes
      // a stale string into a shared document is worth one comparison. Nothing
      // is written; the caller re-reads and re-decides.
      //
      // `take-shared` deliberately proceeds: its preservation is already
      // confirmed on disk, and the buffer it actually displaces is `now`, which
      // is what it reports.
      return { ok: false, stale: true };
    }

    let replaced: string | undefined;
    if (plan.kind === 'converge-up') {
      // The CRDT comes up to the buffer, in ONE transaction and as genuine ops,
      // so peers receive an edit rather than a whole-document rewrite. `yCollab`
      // is not installed yet, so nothing echoes this back — and the editor is
      // not dispatched into AT ALL, which is why the cursor, the selection and
      // the undo history all survive this arm and blockers 1 and 2 have no path.
      const edit = plan.edit;
      text.doc?.transact(() => {
        if (edit.to > edit.from) text.delete(edit.from, edit.to - edit.from);
        if (edit.insert !== '') text.insert(edit.from, edit.insert);
      });
    } else if (plan.kind === 'take-shared') {
      replaced = now;
      // WHAT THIS COSTS, deliberately. Replacing the whole document is the
      // bluntest possible convergence: the user's selection is remapped through
      // a change that touches every character, so a cursor mid-note lands at the
      // start, and any inline decoration state for the old text is discarded.
      // The alternative — a minimal diff — is not available here, because the
      // two sides are not two revisions of one edit history but two independent
      // revisions of one note, and a diff that guesses wrong writes the guess
      // into the CRDT for every peer. The blunt version is the one whose result
      // is knowable: after it, the editor holds exactly the workspace's text.
      //
      // It is now ONE arm of three rather than the default, and that is the
      // whole of blockers 1 and 2: the other two reach the same equality without
      // touching the buffer at all.
      //
      // `addToHistory: false` keeps the replacement out of the undo stack. It
      // has to: once `yCollab` is installed one Ctrl+Z would push the stale
      // local revision back through `YSyncPluginValue.update` as a local edit,
      // and broadcast it to every peer.
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text.toString() },
        annotations: Transaction.addToHistory.of(false),
      });
    }

    // TWO dispatches, not one, and the replacement goes first. Going first
    // matters because `yCollab` is not installed yet, so `YSyncPluginValue`
    // cannot see the replacement and cannot echo the old bytes back into the
    // shared document. Keeping them separate matters because a single dispatch
    // would depend on CodeMirror constructing a newly added `ViewPlugin` from
    // the POST-transaction state and never handing it that transaction's
    // `update()` — true of the copy in this repo, but `@codemirror/state` and
    // `@codemirror/view` are `external` in the build, so at runtime this is
    // Obsidian's CodeMirror and not one this suite can pin.
    //
    // `yCollab` types its awareness parameter as `any`; the structural interface
    // above is what the session is allowed to depend on, and the real provider
    // hands over a y-protocols Awareness that satisfies both.
    view.dispatch({ effects: this.compartment.reconfigure([yCollab(text, awareness)]) });

    // THE GATE (I19), and RAW `===`, re-read from the live state after every
    // dispatch. This is the single most important line in the file.
    //
    // It used to normalize both sides, on the argument that CodeMirror cannot
    // hold a CRLF so an exact comparison would replace the document on every
    // open and then refuse the mount it had just performed. The first half is
    // true and the conclusion was wrong: `yCollab` indexes the RAW text, so a
    // normalized comparison answers "equal" for a `Y.Text` two characters out
    // per line ending, binds it, and every later remote delta addresses a
    // position the editor does not have. Measured: 21 characters bound into a
    // 19-character buffer, then `Invalid change range 22 to 22 (in doc of
    // length 20)`.
    //
    // The equality is made ACHIEVABLE rather than asserted away: the session
    // repairs the document before anything compares it, so both sides are
    // LF-only by the time they get here. One that still holds a `\r` is refused,
    // which is the honest answer — there is no configuration in which such a
    // document and a buffer are equal.
    if (
      this.compartment.get(view.state) === undefined
      || text.toString() !== view.state.doc.toString()
    ) {
      // The two claims `ok` makes are that the binding is installed and that the
      // editor holds the shared text. If either is false after the dispatches,
      // say so rather than let the session record a watermark and defer repairs
      // for a note nothing is bound to. The buffer is left holding whatever it
      // now holds — restoring a stale revision would only re-dirty it with bytes
      // the workspace has already moved past.
      //
      // `replaced` is reported all the same, and this is the whole reason it is
      // on the failure arm too: the displaced characters are exactly as gone as
      // they would be after a success, so the caller owes them the same copy.
      try {
        view.dispatch({ effects: this.compartment.reconfigure([]) });
      } catch {
        /* the view was destroyed with its leaf */
      }
      return { ok: false, replaced };
    }

    this.mounted = view;
    return { ok: true, replaced };
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

/** How long `flush()` waits for the server's acknowledgement before giving up. */
const FLUSH_TIMEOUT_MS = 5_000;

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
    return new WebsocketSessionProvider(provider, doc);
  }
}

class WebsocketSessionProvider implements SessionProvider {
  /** The same round trip `ObsidianDocPort` uses, on the same terms (I17). */
  private readonly ack: ProviderAck;

  constructor(private readonly provider: WebsocketProvider, doc: Y.Doc) {
    this.ack = new ProviderAck(provider, doc);
  }

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
   * A genuine server acknowledgement — the same one `ObsidianDocPort.flush`
   * awaits, through the same `ProviderAck`.
   *
   * This used to return `provider.synced` once `bufferedAmount` reached zero,
   * which is "the bytes left this process" and, worse, a flag that LATCHES after
   * the first sync. Its result sets `s` on the node, which is the exact watermark
   * `DocPort.flush` exists to protect: a peer materializing a file from an `s = 1`
   * node that the server never received writes an empty note and never re-fetches
   * it. The publish queue's `pending` entry made that a recoverable window rather
   * than permanent loss, but the window had no business existing on the path every
   * user takes on every note they open.
   */
  flush(): Promise<boolean> {
    return this.ack.flush(FLUSH_TIMEOUT_MS);
  }

  disconnect(): void {
    this.provider.disconnect();
  }

  destroy(): void {
    this.ack.destroy();
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

/**
 * I18. Normalize on the way IN: the normalized form is the only form that
 * exists inside ShadowLink, and it is what gets written.
 *
 * `\r\n?` and not `\r\n`. The missing `?` is blocker 5. CodeMirror normalizes a
 * LONE `\r` as well — `EditorState.create({ doc: 'a\rb' })` yields `"a\nb"`,
 * length 3 — so a half-normalizer makes a lone `\r` compare unequal to its own
 * normalization, for ever: the buffer holds `one\ntwo`, the document holds
 * `one\rtwo`, the mount refuses, and every launch manufactures another recovery
 * file for a note nothing was wrong with.
 *
 * NEVER normalize a comparison that decides a BINDING. `yCollab` indexes the raw
 * text, so a normalized comparison of an unnormalized document is how a note
 * ends up one position out per line ending — which is blocker 6, and the
 * incident. The bind gate compares raw, and `repairLineEndings` is what makes
 * that equality achievable rather than unsatisfiable.
 */
function toLF(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
