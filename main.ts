// main.ts
// The plugin shell: settings, and the wiring that turns P1's headless machinery
// into something that runs inside Obsidian (spec §4.1, §4.5, §4.6, §6.1).
//
// Almost nothing here is logic. Every decision that could be made without
// Obsidian already was, behind `VaultPort`, `DocPort` and `StatePort`, so that it
// could be tested; what is left is the handful of things only the real
// application can supply — its events, its editor, its status bar, its modals —
// plus the order in which the pieces are handed to each other. That order is the
// part that matters, and each constraint below cost a specific failure to find.
//
//  * HANDLERS ARE REGISTERED INSIDE `onLayoutReady`. Registered any earlier,
//    Obsidian replays a `create` for every file already in the vault, and a
//    2000-note vault becomes 2000 spurious node mints. They are registered
//    IMMEDIATELY at layout-ready, though, because `phase !== 'ready'` makes them
//    queue rather than drop (I9), and dropping is what loses the user's work.
//
//  * ONE `Reconciler`, for the whole session. Its `preexistingDirs` exemption set
//    is captured on its FIRST pass — the folders that were already there before
//    ShadowLink ever ran here, which no node will ever claim and which the
//    empty-folder sweep must therefore leave alone. A fresh reconciler per pass
//    would re-capture that set every time and disable the sweep entirely.
//
//  * DELETIONS ARE GATED ON BOOTSTRAP. `applyDeletions` consults
//    `bootstrap.tombstonesEnabled`, which only flips after the first
//    `reconcile('bootstrap')` has RESOLVED. Without the gate, a client returning
//    after a week offline deletes files in the same breath as it discovers them.
//
//  * THE EDITOR EXTENSION IS REGISTERED EXACTLY ONCE, in `onload`. The CM6
//    compartment is then reconfigured in place, which is what makes renaming an
//    open note invisible to the editing session — the headline behavioural win of
//    P1, and the thing a second registration would quietly throw away.
//
//  * THE STATUS INDICATOR POLLS AND NEVER LATCHES. Read-only has two kinds: a
//    pause the reconciler diagnosed itself (the share root looks missing) clears
//    on the next pass with no user action, while an imposed one (a newer schema, a
//    cancelled first sync) survives until it is lifted. A latched one-shot event
//    would show the first kind for ever.

import { MarkdownView, Notice, Platform, Plugin, TFolder, normalizePath } from 'obsidian';
import type { TAbstractFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { WebsocketProvider } from 'y-websocket';

import { SettingsTab } from './src/ui/SettingsTab';
import {
  chooseAttachments,
  chooseKeptFiles,
  confirmBulkDelete,
  confirmFirstSync,
  confirmLocalBulkDelete,
  confirmUnshare,
  warnAttachmentFolder,
} from './src/ui/modals';
import { deferredEmbedProcessor, matchDeferred } from './src/ui/DeferredEmbeds';
import { formatBytes, nothingToDownload, statusLine, syncedStatus } from './src/ui/format';
import { DEFAULT_SETTINGS, ShadowLinkSettings } from './src/types';

import {
  AUTOFETCH_MAX_BYTES,
  AUTOFETCH_MAX_BYTES_MOBILE,
  AUTOFETCH_SESSION_BUDGET,
  AUTOFETCH_SESSION_BUDGET_MOBILE,
  BLOB_MAX_BYTES,
  BLOB_MAX_BYTES_MOBILE,
  RECONCILE_DEBOUNCE_MS,
  REHASH_BUDGET_BYTES,
  REHASH_BUDGET_BYTES_MOBILE,
  TREE_SNAPSHOT_DEBOUNCE_MS,
} from './src/tree/constants';
import { attachmentsLandInsideShare } from './src/tree/paths';
import { TreeDoc } from './src/tree/TreeDoc';
import { Bootstrap } from './src/sync/Bootstrap';
import { DeviceState } from './src/sync/DeviceState';
import { Deletions } from './src/sync/Deletions';
import { KeptFiles } from './src/sync/KeptFiles';
import { ObsidianBlobPort } from './src/sync/ObsidianBlobPort';
import { ObsidianDocPort } from './src/sync/ObsidianDocPort';
import { ObsidianStatePort, treeSnapshotKey } from './src/sync/ObsidianStatePort';
import { ObsidianVaultPort } from './src/sync/ObsidianVaultPort';
import { PublishQueue } from './src/sync/PublishQueue';
import { Reconciler } from './src/sync/Reconciler';
import type { DeferredAttachment, ReconcileCause } from './src/sync/Reconciler';
import { Tickets } from './src/sync/Tickets';
import { VaultWatcher } from './src/sync/VaultWatcher';
import type { Kind } from './src/sync/VaultPort';
import { CodeMirrorBinding, WorkspaceSession, WebsocketProviderPort } from './src/sync/WorkspaceSession';

/** How often the status indicator re-reads both modules' read-only reasons. */
const STATUS_POLL_MS = 1_000;

/**
 * How often a pass is scheduled purely so the publish queue's backoff ladder can
 * advance. The ladder's own rungs are minutes long; this only guarantees that
 * something asks.
 */
const PUBLISH_RETRY_MS = 30_000;

/**
 * Spec §7.4's `memoryCapBytes`, the platform half of it.
 *
 * Obsidian's `createBinary` takes a whole `ArrayBuffer`, `fetch` buffers a whole
 * response and Web Crypto has no incremental digest, so every attachment this
 * plugin touches is held whole in memory once. A phone cannot do that with a
 * 100 MB screen recording, so the cap is lower there — and it is applied to
 * uploads as well as downloads, because the file the user made ON the phone is
 * the one most likely to be huge.
 */
function blobMemoryCap(): number {
  return Platform.isMobile ? BLOB_MAX_BYTES_MOBILE : BLOB_MAX_BYTES;
}

/**
 * Spec §3.5/§7.4: how many bytes one reconcile pass may re-hash.
 *
 * The same platform reasoning as the memory cap, applied to a different failure:
 * the first pass over a share with no recorded mtimes would hash all of it at
 * once, which on a phone is the difference between a slow launch and a killed
 * renderer.
 */
function blobRehashBudget(): number {
  return Platform.isMobile ? REHASH_BUDGET_BYTES_MOBILE : REHASH_BUDGET_BYTES;
}

/**
 * Spec §7.2's first gate: the largest attachment this device fetches unasked.
 *
 * Far below the memory cap, and about a different question. The cap asks whether
 * this device COULD hold the file; this asks whether the user would expect it to
 * arrive on its own. A 40 MB video syncing silently onto a phone on a hotel
 * connection is not a feature, and it is exactly the complaint every comparable
 * product collects.
 */
function blobAutofetchMax(): number {
  return Platform.isMobile ? AUTOFETCH_MAX_BYTES_MOBILE : AUTOFETCH_MAX_BYTES;
}

/**
 * Spec §7.2's second gate: how many bytes one session fetches unattended.
 *
 * The per-file ceiling cannot express this one — 4,000 files of a megabyte each
 * pass every per-file check ever written and still eat a data plan. Not
 * persisted, deliberately: it is a statement about this afternoon, so a restart
 * picks up exactly where the last session stopped.
 */
function blobSessionBudget(): number {
  return Platform.isMobile ? AUTOFETCH_SESSION_BUDGET_MOBILE : AUTOFETCH_SESSION_BUDGET;
}

/** Spec §2.5: 16 random hex characters, minted once per device. */
function newDeviceId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `TFolder`, not an extension test: a `delete` event hands back a live object. */
function kindOf(file: TAbstractFile): Kind {
  return file instanceof TFolder ? 'd' : 'f';
}

/**
 * Obsidian's "Default location for new attachments", or null (spec §7.5).
 *
 * `getConfig` is undocumented and absent from the public typings, which is why
 * every failure to read it answers NULL rather than a default. `null` means "this
 * plugin could not tell", and `attachmentsLandInsideShare` treats that as no
 * reason to warn — the same habit as I2, applied to a preference. Guessing `''`
 * instead would accuse every user on a future Obsidian of a problem nobody has
 * confirmed they have.
 */
function attachmentFolderSetting(app: { vault: unknown }): string | null {
  const holder = app.vault as { getConfig?: (key: string) => unknown };
  if (typeof holder?.getConfig !== 'function') return null;
  try {
    const value = holder.getConfig('attachmentFolderPath');
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The reconciler's four causes, from a watcher that describes its own reasons.
 *
 * Only `'bootstrap'` genuinely changes behaviour (it suppresses the mount-mismatch
 * guard and forces the deletion confirmation), so an unrecognised reason maps to
 * `'sync'` — the conservative choice, since it keeps every guard armed.
 */
function toCause(reason: string): ReconcileCause {
  return reason === 'remote' || reason === 'sync' || reason === 'bootstrap' || reason === 'retry'
    ? reason
    : 'sync';
}

/** Resolves TRUE only on a genuine provider `sync` event. A timeout is not a sync (I3). */
function waitForSync(provider: WebsocketProvider, ms: number): Promise<boolean> {
  if (provider.synced) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      provider.off('sync', onSync);
      resolve(value);
    };
    const onSync = (isSynced: boolean): void => { if (isSynced) finish(true); };
    provider.on('sync', onSync);
    const timer = setTimeout(() => finish(provider.synced), ms);
  });
}

// ============================================================ the runtime

/**
 * Everything that exists only while a workspace is configured and connected.
 *
 * It is a separate object from the plugin so that `onunload` has exactly one
 * thing to tear down, and so the plugin can load — settings tab and all — when
 * the share is not configured yet, without half a sync stack in an undefined
 * state.
 */
class SyncRuntime {
  readonly vault: ObsidianVaultPort;
  readonly docs: ObsidianDocPort;
  readonly blobs: ObsidianBlobPort;
  readonly statePort: ObsidianStatePort;
  readonly state: DeviceState;
  readonly tickets: Tickets;
  readonly tree: TreeDoc;
  readonly treeProvider: WebsocketProvider;
  readonly session: WorkspaceSession;
  readonly queue: PublishQueue;
  readonly watcher: VaultWatcher;
  readonly deletions: Deletions;
  readonly reconciler: Reconciler;
  readonly bootstrap: Bootstrap;
  readonly kept: KeptFiles;

  /** Read fresh by the watcher and the session; §4.1 can move it mid-session. */
  private shareRoot: string;

  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  /** One re-open at a time: a tick must not cancel the open the last tick started. */
  private reopening = false;
  private reconcileRunning = false;
  private reconcileDirty = false;
  private nextCause: ReconcileCause = 'sync';

  /** Chained so two `status: connected` transitions cannot run bootstrap twice at once. */
  private reconnectChain: Promise<void> = Promise.resolve();
  private booted = false;
  private disposed = false;

  constructor(private readonly plugin: ShadowLinkPlugin, deviceId: string) {
    const app = plugin.app;
    const share = plugin.settings.share;
    this.shareRoot = normalizePath(share.sharedFolder).replace(/\/+$/, '');

    this.vault = new ObsidianVaultPort({
      vault: app.vault,
      workspace: app.workspace,
      getShareRoot: () => this.shareRoot,
    });

    this.statePort = new ObsidianStatePort(
      app.vault.adapter,
      plugin.manifest.dir ?? '.obsidian/plugins/shadowlink',
    );
    this.state = new DeviceState(this.statePort, deviceId, share.workspaceId);
    this.tickets = new Tickets();

    this.tree = new TreeDoc();
    this.tree.onSubscriberError = (err): void => {
      console.error('[ShadowLink] a tree observer threw', err);
    };

    this.docs = new ObsidianDocPort({
      serverUrl: share.serverUrl,
      serverKey: share.serverKey,
      workspaceId: share.workspaceId,
    });

    // Attachments travel over HTTP to the server's content-addressed store, not
    // through Yjs (spec §1.1). Same host, same key, same workspace.
    this.blobs = new ObsidianBlobPort({
      serverUrl: share.serverUrl,
      serverKey: share.serverKey,
      workspaceId: share.workspaceId,
    });

    this.session = new WorkspaceSession({
      vault: this.vault,
      state: this.state,
      tree: this.tree,
      providers: new WebsocketProviderPort({
        serverUrl: share.serverUrl,
        serverKey: share.serverKey,
        workspaceId: share.workspaceId,
      }),
      editor: plugin.editorBinding,
      shareRoot: () => this.shareRoot,
      activePath: () => app.workspace.getActiveFile()?.path ?? null,
      userName: plugin.settings.displayName,
      userColor: plugin.settings.cursorColor,
      notice: (msg) => { new Notice(msg); },
      // The session is the one writer of `s` that is not the queue: it publishes
      // a brand-new note the moment it has a byte in it, because the queue may
      // not touch a document it holds open (I7). Without this the queue keeps
      // deferring on that node for as long as the note stays open — a full
      // reconcile pass every 30 seconds, and a status bar that never says synced.
      markPublished: (nodeId) => { this.queue.markPublished(nodeId); },
      // The other half of the same I7 handoff: a note that CLOSES stops being
      // deferred, and a pass now beats one up to 30 seconds from now.
      scheduleReconcile: (cause) => { this.scheduleReconcile(toCause(cause)); },
    });

    this.queue = new PublishQueue({
      docs: this.docs,
      vault: this.vault,
      blobs: this.blobs,
      state: this.state,
      tree: this.tree,
      openNodeId: this.session.openNodeId,
      displayName: plugin.settings.displayName,
      notice: (msg) => { new Notice(msg); },
      // §7.4: the platform test lives HERE and reaches the engine as a plain
      // number, so nothing under src/sync has to know what Obsidian is running on.
      memoryCapBytes: () => blobMemoryCap(),
    });

    this.watcher = new VaultWatcher({
      tree: this.tree,
      entries: () => this.tree.entries(),
      vault: this.vault,
      state: this.state,
      tickets: this.tickets,
      getShareRoot: () => this.shareRoot,
      // §4.1: following the folder is only half the job — the new root has to
      // survive a restart, or the next launch mounts the old one and every file
      // under it reads as missing.
      setShareRoot: (next) => { void this.moveShareRoot(next); },
      displayName: plugin.settings.displayName,
      phase: () => this.bootstrap.phase,
      notice: (msg) => { new Notice(msg); },
      enterReadOnly: (reason) => { this.reconciler.enterReadOnly(reason); },
      scheduleReconcile: (reason) => { this.scheduleReconcile(toCause(reason)); },
      // A freshly minted node has nothing to publish it: the tree observer skips
      // local-origin transactions by design, so without this a brand-new note
      // would sit unpublished until some unrelated remote change arrived.
      enqueuePublish: (nodeId) => {
        this.queue.enqueue(nodeId);
        this.scheduleReconcile('sync');
      },
      // §3.8: an attachment that just came back from the dead republishes the
      // bytes that are actually on disk, so a reference that had drifted from
      // them converges instead of pointing at a version nobody has.
      requeuePublish: (nodeId, intent) => {
        this.queue.requeue(nodeId, intent);
        this.scheduleReconcile('sync');
      },
      // §7.4: the same platform cap again, here on the hash that decides whether
      // a recreated attachment may reuse a dead node.
      memoryCapBytes: () => blobMemoryCap(),
      confirmLocalBulkDelete: (count) => confirmLocalBulkDelete(app, count),
      confirmUnshare: (rootPath, count) => confirmUnshare(app, rootPath, count),
    });

    this.deletions = new Deletions({
      vault: this.vault,
      // §5.1: an attachment is proven by asking the store whether it still holds
      // the exact bytes the tree names. With no store the answer is "I could not
      // ask", which rescues — safe, but it fills Recovered/ with 200 MB files.
      blobs: this.blobs,
      state: this.state,
      tickets: this.tickets,
      shareRoot: this.shareRoot,
      // §7.4: the same platform cap the publisher and the reconciler use, here
      // applied to the hash a deletion verdict would otherwise cost.
      memoryCapBytes: () => blobMemoryCap(),
      notice: (msg, ms) => { new Notice(msg, ms); },
      confirmBulk: (summary) => confirmBulkDelete(app, summary),
      openNodeId: this.session.openNodeId,
      // I7: unbind the editor before anything touches that file's bytes.
      closeSession: async (nodeId) => {
        if (this.session.openNodeId() === nodeId) await this.session.open(null);
      },
    });

    this.reconciler = new Reconciler({
      vault: this.vault,
      docs: this.docs,
      blobs: this.blobs,
      state: this.state,
      memoryCapBytes: () => blobMemoryCap(),
      // §3.5: the same platform test, applied to the first-pass hash sweep. A
      // cold 3 GB share amortizes it over several passes instead of freezing one.
      rehashBudgetBytes: () => blobRehashBudget(),
      // §7.2's two gates. Both are plain numbers by the time they reach the
      // engine, so nothing under src/sync has to know what a phone is.
      autofetchMaxBytes: () => blobAutofetchMax(),
      sessionBudgetBytes: () => blobSessionBudget(),
      tickets: this.tickets,
      shareRoot: this.shareRoot,
      entries: () => this.tree.entries(),
      // §3.5 rule 2. The queue is reached through a callback rather than injected,
      // so the pass stays a driver over a tree snapshot; the entry it writes is
      // drained by step 7 below, in this same pass.
      requeuePublish: (nodeId, intent) => { this.queue.requeue(nodeId, intent); },
      // §3.5: the files the user has just saved go to the front of the re-hash
      // budget. The pass TAKES the set, so a save landing mid-pass is answered by
      // the next one rather than absorbed by this one.
      takeDirtyPaths: () => this.watcher.takeDirtyPaths(),
      // §5.5: a pass firing while the unshare modal is open must not put back the
      // very file the user just dragged out.
      pendingDecision: () => this.watcher.pendingDecision,
      // §4.5: tombstones stay off until bootstrap's first reconcile has finished.
      applyDeletions: (ctx) => (
        this.bootstrap.tombstonesEnabled ? this.deletions.apply(ctx) : Promise.resolve()
      ),
      // Steps 6-7. `onCreate` mints the node, records `owned[id]` and binds
      // `materialized[id]` before it enqueues — `enqueue` refuses an unowned node,
      // and a node with no binding costs a whole backoff step. The drain is step 7
      // and therefore runs after the pass has materialized everything, never
      // before.
      publishUntracked: async (paths) => {
        for (const path of paths) await this.watcher.onCreate(path, 'f');
        await this.queue.drain();
      },
      notice: (msg) => { new Notice(msg); },
    });

    this.treeProvider = new WebsocketProvider(share.serverUrl, '_tree', this.tree.doc, {
      connect: true,
      params: { t: share.serverKey, w: share.workspaceId },
      disableBc: true,
    });

    this.bootstrap = new Bootstrap({
      state: this.state,
      tree: this.tree,
      vault: this.vault,
      shareRoot: this.shareRoot,
      deviceId,
      loadSnapshot: () => this.statePort.readBinary(treeSnapshotKey(share.workspaceId)),
      connectTree: async (ms) => {
        if (this.treeProvider.synced) return true;
        try {
          this.treeProvider.connect();
        } catch {
          /* already connecting; the wait below is what decides */
        }
        return waitForSync(this.treeProvider, ms);
      },
      confirm: (confirmation) => confirmFirstSync(app, confirmation),
      // §7.2/§7.5: the same three numbers the reconciler applies, so the
      // attachments the modal says will not be downloaded are exactly the ones
      // the first pass then declines to fetch. A split made on the memory cap
      // alone described a pass that does something else.
      memoryCapBytes: () => blobMemoryCap(),
      autofetchMaxBytes: () => blobAutofetchMax(),
      sessionBudgetBytes: () => blobSessionBudget(),
      sessionSpentBytes: () => this.reconciler.fetchedThisSession,
      reconcile: (cause) => this.reconciler.reconcile(cause),
      // Both halves of the same answer: one module must not report `ready` while
      // the other is refusing every pass.
      syncPaused: () => this.reconciler.readOnlyReason,
      resumeSync: () => { this.reconciler.clearReadOnly(); },
      replayPendingEvents: () => this.watcher.flushPending(),
      notice: (msg) => { new Notice(msg); },
    });

    // §5.4 / R6's escape hatch. The adoption hand-off is deliberately the SAME
    // pair the reconciler's steps 6-7 use — `onCreate` mints and owns the node,
    // the drain publishes it — because a file at a dead node's path is excluded
    // from the reconciler's own step 6 by I13, so clearing the decline alone would
    // publish nothing at all.
    this.kept = new KeptFiles({
      state: this.state,
      entries: () => this.tree.entries(),
      vault: this.vault,
      shareRoot: () => this.shareRoot,
      adopt: (path) => this.watcher.onCreate(path, 'f'),
      drain: () => this.queue.drain(),
      scheduleReconcile: (cause) => { this.scheduleReconcile(toCause(cause)); },
      notice: (msg) => { new Notice(msg); },
    });
  }

  // ---------------------------------------------------------- §5.4 / R6

  /**
   * The `resolve kept files` command's whole body.
   *
   * Listing is free and side-effect-free, so the "nothing is kept" case is
   * answered without opening a window; everything else is the user's decision,
   * and dismissing the dialog shares nothing.
   */
  async resolveKeptFiles(): Promise<void> {
    const entries = this.kept.list();
    if (entries.length === 0) {
      new Notice('ShadowLink: nothing is being kept back — every local file is shared.');
      return;
    }
    const chosen = await chooseKeptFiles(this.plugin.app, entries);
    if (chosen.length === 0) return;

    const result = await this.kept.share(chosen);
    const failed = result.failed.length;
    // `chosen.length`, never `result.cleared`: one decision can hold two records —
    // a node id and a folded path — and telling the user "2" for one file they
    // picked would be arithmetic about device state rather than about their vault.
    new Notice(
      `ShadowLink shared ${result.shared} file(s)`
      + (failed > 0 ? `, ${failed} could not be shared` : '')
      + `. ${chosen.length} item(s) are no longer kept back.`,
    );
  }

  // ---------------------------------------------------------- lifecycle

  /** Spec §4.5, run from inside `onLayoutReady` with the handlers already queueing. */
  async start(): Promise<void> {
    // Any tree transaction, whatever its origin, changes what the offline
    // baseline should say (§2.6). Only a REMOTE one implies work on disk — a
    // local write was made by a module that schedules its own pass.
    this.tree.observe((isLocal) => {
      this.scheduleSnapshot();
      if (!isLocal) this.scheduleReconcile('remote');
    });

    this.treeProvider.on('status', (event: { status?: string }) => {
      if (event?.status !== 'connected') return;
      this.onReconnect();
    });

    // The ladder in `state.publish` is measured in minutes; this is only what
    // guarantees somebody asks once a rung comes due.
    this.retryTimer = setInterval(() => { void this.drainTick(); }, PUBLISH_RETRY_MS);

    try {
      await this.bootstrap.run();
    } catch (err) {
      console.error('[ShadowLink] bootstrap failed', err);
      new Notice('ShadowLink could not start. See the developer console for details.');
    } finally {
      // A failed bootstrap must still let a reconnect retry (I15).
      this.booted = true;
    }
    await this.writeSnapshot();

    // A note that was already open when the plugin loaded never fires
    // `file-open`, so without this the one note the user is actually looking at
    // is the one note that does not collaborate until they switch away and back.
    const active = this.plugin.app.workspace.getActiveFile();
    if (active !== null && this.isSharedNote(active.path)) {
      void this.session.open(active.path);
    }

    // Last, so it lands on top of the first-sync modal rather than under it, and
    // never on a client that failed to start.
    await this.warnIfAttachmentsLandOutside();
  }

  /**
   * Spec §7.5. One check, one string — and skipping it ships a feature that does
   * not work on a default install.
   *
   * ShadowLink shares one FOLDER; Obsidian's "Default location for new
   * attachments" is vault-global and defaults to the vault root. So the very first
   * image the user drags into a shared note is written outside the share, is never
   * published, and shows every peer a broken embed. Nothing in the sync engine can
   * fix that — the file genuinely is not in the shared folder — so the only honest
   * remedy is to say so once, name the setting, and let them dismiss it.
   *
   * Checked on every start rather than only on a first join, because the share
   * root can move (§4.1) and the vault setting can change under it. Dismissing is
   * what makes that bounded, and a user who fixes the setting stops seeing it with
   * no dismissal at all.
   */
  private async warnIfAttachmentsLandOutside(): Promise<void> {
    if (this.plugin.settings.attachmentFolderWarningDismissed) return;
    const folder = attachmentFolderSetting(this.plugin.app);
    if (attachmentsLandInsideShare(folder, this.shareRoot)) return;

    const answer = await warnAttachmentFolder(
      this.plugin.app, this.shareRoot, folder ?? '',
    );
    if (answer !== 'dismiss') return;
    this.plugin.settings.attachmentFolderWarningDismissed = true;
    await this.plugin.saveSettings();
  }

  /**
   * THREE questions, and each of them exists because the one before it left a
   * state nothing else in the plugin could reach.
   *
   * `pendingCount()` is the STATUS BAR's number and excludes parked entries — an
   * empty note, a `.md` file that is not text — because no upload is owed for
   * them and no amount of waiting changes that. The DRAIN must still reach them,
   * and nothing else ever will: `VaultWatcher.onModify` returns early for a note
   * by design (I7), so this interval is the ONLY periodic drain in the plugin.
   * Narrowing the number without widening this is what silently unhooked it, and
   * an empty note that could never publish again is not a status-bar bug.
   *
   * `repark()` is a `stat` per parked entry, typically zero, rather than a full
   * pass — an idle vault holding one permanently empty note would otherwise pay
   * a tree derivation and a stat per attachment every 30 seconds for ever.
   *
   * `reopenUnbound()` is R18, and it is the same shape of gap one layer up:
   * publishing recovers by itself and BINDING did not. A note the session
   * declined — a brand-new one whose bytes had not reached the disk, one whose
   * room had not synced, one whose author had not published it yet — stayed
   * shared-but-not-collaborative for as long as it stayed open, because the only
   * things that ever open a note are `file-open` and start-up. The user's remedy
   * was to switch away and back, which is a remedy the plugin can perform. It is
   * asked LAST and only when the queue is idle, so a tick that has just found
   * work lets the pass it asked for finish first.
   */
  private async drainTick(): Promise<void> {
    if (this.queue.pendingCount() > 0) { this.scheduleReconcile('retry'); return; }
    if (await this.queue.repark()) { this.scheduleReconcile('retry'); return; }
    this.reopenUnbound();
  }

  /**
   * Ask the session for the active note again, when nothing is bound.
   *
   * The refusals this recovers from are all "not yet" states — I2's whole
   * position — and every one of them ends without the user doing anything: the
   * disk gains the note's bytes, the room syncs, the author publishes. Re-asking
   * is what turns "not yet" back into a binding instead of leaving it at "not
   * until you switch tabs".
   *
   * Cheap by construction: it runs only when the queue has nothing owed and
   * nothing bound, so an ordinary vault with a note open never reaches it at
   * all. `WorkspaceSession.localOnly` says each refusal once per path per
   * reason, so a note that genuinely cannot bind produces one notice rather than
   * one every thirty seconds — and says something again the moment its answer
   * changes, or the moment it binds and breaks again.
   */
  private reopenUnbound(): void {
    if (this.reopening) return;
    if (this.session.openNodeId() !== null) return;
    const active = this.plugin.app.workspace.getActiveFile();
    if (active === null || !this.isSharedNote(active.path)) return;
    this.reopening = true;
    void this.session.open(active.path).finally(() => { this.reopening = false; });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimer('reconcile');
    this.clearTimer('snapshot');
    if (this.retryTimer !== null) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.watcher.dispose();

    try {
      await this.session.destroy();
    } catch (err) {
      console.error('[ShadowLink] closing the editing session failed', err);
    }
    // The snapshot before the state, and both before the sockets: they are what
    // the next start reads, and neither needs a connection.
    try {
      await this.writeSnapshot();
    } catch (err) {
      console.error('[ShadowLink] writing the tree snapshot failed', err);
    }
    try {
      await this.state.flush();
    } catch (err) {
      console.error('[ShadowLink] writing device state failed', err);
    }
    try {
      this.treeProvider.destroy();
    } catch {
      /* already gone */
    }
    this.docs.destroy();
    try {
      this.tree.doc.destroy();
    } catch {
      /* already gone */
    }
  }

  // ---------------------------------------------------------- vault events

  /**
   * Spec §4.1. Called from inside `onLayoutReady`, so Obsidian does not replay a
   * `create` for the whole vault.
   */
  registerVaultEvents(): void {
    const plugin = this.plugin;
    const vault = plugin.app.vault;

    plugin.registerEvent(vault.on('create', (file) => {
      void this.guard(this.watcher.onCreate(file.path, kindOf(file)));
    }));
    plugin.registerEvent(vault.on('rename', (file, oldPath) => {
      void this.guard(this.watcher.onRename(file.path, oldPath, kindOf(file)));
    }));
    plugin.registerEvent(vault.on('delete', (file) => {
      this.watcher.onDelete(file.path, kindOf(file));
    }));
    // §3.5. Registered for the first time in P2, and it is only ever about
    // attachments: the handler returns immediately for a note, because markdown
    // modifications flow through the CRDT and a second writer under a live
    // yCollab binding is the I7 failure this plugin exists to avoid.
    plugin.registerEvent(vault.on('modify', (file) => {
      void this.guard(this.watcher.onModify(file.path));
    }));

    plugin.registerEvent(plugin.app.workspace.on('file-open', (file) => {
      const path = file === null ? null : file.path;
      void this.session.open(path !== null && this.isSharedNote(path) ? path : null);
    }));
  }

  // ---------------------------------------------------------- status

  /**
   * What the status bar should say right now — the STATE of it. The wording is
   * `statusLine`'s, in `src/ui/format.ts`, where the suite can read it.
   *
   * That split is the point. This file imports `obsidian`, so nothing in it is
   * reachable from a unit test, and the only thing that could ever check these
   * sentences was a guard reading the file as text — which is not a test of a
   * sentence, and which was itself failing open until this round. Plural forms,
   * the branch between the two parked sentences and whether a parked entry
   * reached the tooltip at all were verified by nothing.
   *
   * Both read-only reasons are POLLED rather than latched from an event, because
   * one of the two kinds heals by itself: the reconciler re-derives a pause it
   * diagnosed on its own evidence at the top of every pass, so a one-shot listener
   * would keep showing a state that stopped being true several passes ago.
   *
   * `pendingCount()` is every entry the queue will act on by itself, and it
   * deliberately EXCLUDES the ones it parked or blocked. Counting those is what
   * pinned this bar on "syncing…" for the lifetime of a vault holding one empty
   * note.
   *
   * ALL FOUR ATTACHMENT BUCKETS into `syncedStatus`, never just the fetchable
   * one: §7.5's refusal leaves a file off this disk exactly as §7.2's does, and
   * §7.4's local half has no remedy and so reaches the tooltip and stops. Passed
   * as a THUNK because three of the four branches never look at it.
   */
  status(): { text: string; tooltip: string } {
    return statusLine({
      paused: this.bootstrap.readOnlyReason ?? this.reconciler.readOnlyReason,
      ready: this.bootstrap.phase === 'ready',
      busy: this.reconciler.reconciling || this.reconcileRunning
        || this.reconcileTimer !== null,
      pending: this.queue.pendingCount(),
      parked: this.queue.parked(),
      synced: () => syncedStatus(
        this.shareRoot,
        this.reconciler.deferredAttachments,
        this.reconciler.tooLargeAttachments,
        this.reconciler.unavailableAttachments,
        blobMemoryCap(),
        this.reconciler.uncheckableAttachments,
      ),
    });
  }

  // ---------------------------------------------------------- §7.3 downloads

  /** Every attachment the last pass decided not to fetch, for the commands and the UI. */
  get deferredAttachments(): readonly DeferredAttachment[] {
    return this.reconciler.deferredAttachments;
  }

  /**
   * The two buckets a download command CANNOT act on (§7.5, §6.5).
   *
   * Kept apart from `deferredAttachments` all the way to the surface, because
   * every consumer of that list either offers a Download button for it or counts
   * it as fetchable — and both are promises this device cannot keep for these.
   */
  get tooLargeAttachments(): readonly DeferredAttachment[] {
    return this.reconciler.tooLargeAttachments;
  }

  get unavailableAttachments(): readonly DeferredAttachment[] {
    return this.reconciler.unavailableAttachments;
  }

  /**
   * The bucket that is not a download at all (§7.4's local half).
   *
   * These files are on this disk. What is missing is this device's ability to
   * hash them, so a change made here cannot be detected and would not be shared —
   * and no command can fix that. It is threaded to the same surfaces as the other
   * three purely so the user is told once, passively, in the place they already
   * look.
   */
  get uncheckableAttachments(): readonly DeferredAttachment[] {
    return this.reconciler.uncheckableAttachments;
  }

  /**
   * §7.3's one mechanism, behind all three commands and the embed button:
   * `fetchApproved[id] = true`, then a pass.
   *
   * Approval is PERSISTED before the pass runs, deliberately. It survives a
   * reconciler that refuses this pass, a network that is down right now and a
   * restart in between — "I want this file" is a decision the user made once, and
   * making them make it again because a fetch failed is how a download button
   * becomes something people press five times.
   *
   * Nothing here fetches anything itself. The pass owns every rule about what may
   * be written where, and a command that reached around it would be a second
   * writer with none of them.
   */
  async downloadAttachments(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      // Reached only by a caller that asked for nothing; every command has already
      // said something more specific by here. It deliberately makes no claim about
      // what IS downloaded — that answer belongs to `nothingToDownload`, which can
      // see the buckets this early return cannot.
      new Notice('ShadowLink: nothing to download.');
      return;
    }
    for (const id of ids) this.state.data.fetchApproved[id] = true;
    await this.state.flush();
    await this.reconciler.reconcile('sync');

    // Report against what is STILL deferred rather than against what was asked
    // for: the memory cap outranks an approval (§7.4), so "download" and "arrived"
    // are genuinely different numbers on a phone, and claiming otherwise would be
    // the same lie the status bar just stopped telling.
    const stuck = new Set(this.reconciler.deferredAttachments.map((d) => d.id));
    const done = ids.filter((id) => !stuck.has(id)).length;
    new Notice(
      done === ids.length
        ? `ShadowLink downloaded ${done} attachment(s).`
        : `ShadowLink downloaded ${done} of ${ids.length} attachment(s); the rest could not `
          + 'be fetched yet. See the status bar for what is still outstanding.',
    );
  }

  /** §7.3's "download attachments in this note" — the fetchable bucket only. */
  deferredInNote(path: string): DeferredAttachment[] {
    return this.inNote(path, this.reconciler.deferredAttachments);
  }

  /**
   * §7.3's answer when a download command finds nothing it can fetch.
   *
   * The claim "every attachment here is already downloaded" is only true when
   * NOTHING is outstanding, and the two buckets below are outstanding and
   * unfetchable — the cap is tested before an approval is consulted, and the store
   * has answered 404. This is where the first-sync modal sends the user, so the
   * command answering falsely is the shipped surface that contradicts the other.
   */
  nothingToDownloadHere(): string {
    return this.sayNothing(
      'this workspace',
      this.reconciler.tooLargeAttachments,
      this.reconciler.unavailableAttachments,
      this.reconciler.uncheckableAttachments,
    );
  }

  /** The same answer, scoped to one note's embeds and links. */
  nothingToDownloadInNote(path: string): string {
    return this.sayNothing(
      'this note',
      this.inNote(path, this.reconciler.tooLargeAttachments),
      this.inNote(path, this.reconciler.unavailableAttachments),
      this.inNote(path, this.reconciler.uncheckableAttachments),
    );
  }

  private sayNothing(
    where: string,
    tooLarge: readonly DeferredAttachment[],
    unavailable: readonly DeferredAttachment[],
    uncheckable: readonly DeferredAttachment[],
  ): string {
    return nothingToDownload(
      this.shareRoot, where, tooLarge, unavailable, blobMemoryCap(), uncheckable,
    );
  }

  /**
   * Which of `entries` this note embeds or links to.
   *
   * The links come from Obsidian's own metadata cache, which lists an embed whether
   * or not it resolves — and for an attachment that is not here it never resolves,
   * because there is deliberately nothing on disk to resolve to. That is why the
   * match runs against a list of paths rather than against a `TFile`, and it is why
   * the same routine serves every bucket: three of the four have no file to look
   * at, and the fourth — a local file this device cannot hash — has one that
   * resolves perfectly well, so matching on the link text works for both.
   */
  private inNote(path: string, entries: readonly DeferredAttachment[]): DeferredAttachment[] {
    if (entries.length === 0) return [];
    const file = this.plugin.app.vault.getFileByPath(path);
    if (file === null) return [];
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const out = new Map<string, DeferredAttachment>();
    for (const embed of cache?.embeds ?? []) {
      const hit = matchDeferred(embed.link, path, entries);
      if (hit !== null) out.set(hit.id, hit);
    }
    for (const link of cache?.links ?? []) {
      const hit = matchDeferred(link.link, path, entries);
      if (hit !== null) out.set(hit.id, hit);
    }
    return [...out.values()];
  }

  // ---------------------------------------------------------- reconcile driver

  /**
   * Spec §4.3's scheduling contract: debounced, single-flight, and dirty-looped so
   * a trigger that lands mid-pass is answered by another pass rather than lost.
   *
   * The reconciler has its own single-flight too; this one exists so that a burst
   * of vault events collapses into ONE pass instead of a queue of refusals.
   */
  scheduleReconcile(cause: ReconcileCause): void {
    if (this.disposed) return;
    // 'bootstrap' outranks everything: it is the only cause that suppresses the
    // mount guard, and a later trigger must not downgrade it.
    if (cause === 'bootstrap' || this.nextCause !== 'bootstrap') this.nextCause = cause;
    if (this.reconcileTimer !== null) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.runReconcile();
    }, RECONCILE_DEBOUNCE_MS);
  }

  private async runReconcile(): Promise<void> {
    if (this.reconcileRunning) {
      this.reconcileDirty = true;
      return;
    }
    this.reconcileRunning = true;
    try {
      do {
        this.reconcileDirty = false;
        const cause = this.nextCause;
        this.nextCause = 'sync';
        await this.reconciler.reconcile(cause);
      } while (this.reconcileDirty && !this.disposed);
    } catch (err) {
      // I15: a pass that threw must not wedge the driver for the rest of the
      // session. The reconciler contains its own per-item failures; anything that
      // escapes it is a defect and is surfaced rather than swallowed.
      console.error('[ShadowLink] reconcile pass failed', err);
    } finally {
      this.reconcileRunning = false;
    }
  }

  // ---------------------------------------------------------- §4.6

  private onReconnect(): void {
    if (this.disposed || !this.booted) return;
    this.reconnectChain = this.reconnectChain.then(async () => {
      if (this.disposed) return;
      try {
        await this.bootstrap.onReconnect();
      } catch (err) {
        console.error('[ShadowLink] reconnect failed', err);
      }
    });
  }

  // ---------------------------------------------------------- §2.6

  private scheduleSnapshot(): void {
    if (this.disposed || this.snapshotTimer !== null) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.writeSnapshot();
    }, TREE_SNAPSHOT_DEBOUNCE_MS);
  }

  private async writeSnapshot(): Promise<void> {
    const workspaceId = this.plugin.settings.share.workspaceId;
    if (workspaceId === '') return;
    try {
      await this.statePort.writeBinary(treeSnapshotKey(workspaceId), this.tree.encodeState());
    } catch (err) {
      // The offline baseline is an optimization and a recovery aid, never a
      // precondition: the server's copy is authoritative and step 4 refetches it.
      console.error('[ShadowLink] tree snapshot could not be written', err);
    }
  }

  // ---------------------------------------------------------- helpers

  /**
   * §4.1's share-root move, made durable.
   *
   * The watcher and the editing session both read `shareRoot` fresh, so they
   * follow immediately. `Reconciler`, `Deletions` and `Bootstrap` each captured
   * the root at construction — deliberately, since a mid-pass change of mount
   * would be far worse than a stale one — so the move is only fully applied after
   * a reload, and the user is told so rather than left to discover it.
   */
  private async moveShareRoot(next: string): Promise<void> {
    const target = normalizePath(next).replace(/\/+$/, '');
    if (target === this.shareRoot) return;
    this.shareRoot = target;
    this.plugin.settings.share.sharedFolder = target;
    await this.plugin.saveSettings();
    new Notice(
      `ShadowLink is now watching "${target}". Reload the plugin to finish moving `
      + 'the shared folder.',
    );
  }

  /** A markdown file inside the share — the only thing an editing session applies to. */
  private isSharedNote(path: string): boolean {
    if (this.shareRoot === '') return false;
    if (!path.toLowerCase().endsWith('.md')) return false;
    return path.startsWith(`${this.shareRoot}/`);
  }

  /** I15: one failing handler must never take the event pipeline down with it. */
  private guard(work: Promise<void>): Promise<void> {
    return work.catch((err) => {
      console.error('[ShadowLink] a vault event handler failed', err);
    });
  }

  private clearTimer(which: 'reconcile' | 'snapshot'): void {
    const timer = which === 'reconcile' ? this.reconcileTimer : this.snapshotTimer;
    if (timer !== null) clearTimeout(timer);
    if (which === 'reconcile') this.reconcileTimer = null;
    else this.snapshotTimer = null;
  }
}

// ============================================================ the plugin

export default class ShadowLinkPlugin extends Plugin {
  settings: ShadowLinkSettings = { ...DEFAULT_SETTINGS };

  /**
   * The CM6 mount, created here and registered ONCE.
   *
   * It has to outlive any single session: `registerEditorExtension` is what puts
   * the compartment into every editor, and reconfiguring that one compartment in
   * place is what makes a rename of an open note invisible to the collaboration
   * session (spec §6). Registering a second one would leave the first still
   * installed and holding a stale binding.
   */
  readonly editorBinding: CodeMirrorBinding = new CodeMirrorBinding((path) => this.viewFor(path));

  private runtime: SyncRuntime | null = null;
  private statusEl: HTMLElement | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerEditorExtension(this.editorBinding.editorExtension());

    // Spec §5.4 and risk R6 both point at this command as the reason permanent
    // local divergence is acceptable, and the first-sync dialog now names it. It
    // is registered in `onload`, not with the runtime, so it exists — and can say
    // so honestly — even when the share is not configured or sync failed to start.
    this.addCommand({
      id: 'resolve-kept-files',
      name: 'Resolve kept files',
      callback: () => { void this.resolveKeptFiles(); },
    });

    // §7.3's three ways to ask for a deferred attachment. All three are the same
    // mechanism — `fetchApproved[id] = true`, then a pass — and they exist as
    // three because "the picture in front of me", "everything" and "these ones"
    // are three genuinely different questions, and only offering the middle one
    // makes the answer to the first "download 3 GB".
    this.addCommand({
      id: 'download-attachments-in-note',
      name: 'Download attachments in this note',
      callback: () => { void this.downloadInActiveNote(); },
    });
    this.addCommand({
      id: 'download-all-attachments',
      name: 'Download all attachments',
      callback: () => { void this.downloadAllAttachments(); },
    });
    this.addCommand({
      id: 'download-attachments',
      name: 'Download attachments',
      callback: () => { void this.chooseAttachmentsToDownload(); },
    });

    // §7.3's embed button. Registered ONCE, in `onload`, for the same reason the
    // editor extension is: it has to outlive any single runtime, and it reads the
    // runtime through a closure so a share that starts later still gets it. With
    // no runtime it finds nothing deferred and does nothing at all.
    this.registerMarkdownPostProcessor(deferredEmbedProcessor({
      deferred: () => this.runtime?.deferredAttachments ?? [],
      download: (id) => { void this.downloadAttachments([id]); },
    }));

    this.statusEl = this.addStatusBarItem();
    this.setStatus('ShadowLink: starting…', 'ShadowLink is waiting for the workspace to load.');

    // Spec §4.1: registering the vault handlers any earlier makes Obsidian replay
    // a `create` for every file already in the vault.
    this.app.workspace.onLayoutReady(() => { void this.startSync(); });
  }

  async onunload(): Promise<void> {
    if (this.statusTimer !== null) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime !== null) await runtime.dispose();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.share = Object.assign({}, DEFAULT_SETTINGS.share, this.settings.share);
    // Minted once and then never again: the device-state file is only trusted
    // when it names this exact id (§2.5), so regenerating it would cold-start the
    // client on every launch.
    if (this.settings.deviceId === '') {
      this.settings.deviceId = newDeviceId();
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** True once the share is fully configured; the settings tab reads it. */
  get configured(): boolean {
    const share = this.settings.share;
    return share.serverUrl !== '' && share.serverKey !== ''
      && share.workspaceId !== '' && share.sharedFolder !== '';
  }

  // ---------------------------------------------------------- start

  private async startSync(): Promise<void> {
    if (!this.configured) {
      this.setStatus(
        'ShadowLink: not configured',
        'Set the server, workspace and shared folder in ShadowLink\'s settings.',
      );
      return;
    }

    const runtime = new SyncRuntime(this, this.settings.deviceId);
    this.runtime = runtime;
    // Registered BEFORE the bootstrap is awaited, and deliberately: while
    // `phase !== 'ready'` the handlers queue rather than drop, and bootstrap's
    // last step replays the queue through them (I9).
    runtime.registerVaultEvents();

    this.statusTimer = setInterval(() => { this.refreshStatus(); }, STATUS_POLL_MS);
    this.refreshStatus();

    await runtime.start();
    this.refreshStatus();
  }

  // ---------------------------------------------------------- commands

  /**
   * §5.4 / R6. Delegated to the runtime, which owns the state the answer changes.
   *
   * Without a runtime there is nothing to list and nothing that could act on an
   * answer, so the command says so rather than opening an empty window: the
   * declines live in device state, which only a configured, started share reads.
   */
  private async resolveKeptFiles(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null) {
      new Notice('ShadowLink is not running in this vault. Check its settings and reload it.');
      return;
    }
    try {
      await runtime.resolveKeptFiles();
    } catch (err) {
      console.error('[ShadowLink] resolving kept files failed', err);
      new Notice('ShadowLink could not finish sharing those files. See the console.');
    }
  }

  // ---------------------------------------------------------- §7.3

  /** The active note's unresolved attachment embeds — the picture in front of you. */
  private async downloadInActiveNote(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null) return this.notRunning();
    const file = this.app.workspace.getActiveFile();
    if (file === null) {
      new Notice('ShadowLink: open a note first.');
      return;
    }
    const wanted = runtime.deferredInNote(file.path);
    if (wanted.length === 0) {
      new Notice(runtime.nothingToDownloadInNote(file.path));
      return;
    }
    await this.downloadAttachments(wanted.map((d) => d.id));
  }

  /**
   * Everything, sizes and all.
   *
   * The total goes in the Notice rather than in a confirmation dialog: this command
   * only exists because the user went looking for it, and asking "are you sure" after
   * somebody typed the words "download all attachments" is a dialog that teaches
   * people to dismiss dialogs.
   */
  private async downloadAllAttachments(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null) return this.notRunning();
    const entries = runtime.deferredAttachments;
    if (entries.length === 0) {
      new Notice(runtime.nothingToDownloadHere());
      return;
    }
    const bytes = entries.reduce((sum, d) => sum + d.bytes, 0);
    new Notice(`ShadowLink is downloading ${entries.length} attachment(s) (${formatBytes(bytes)})…`);
    await this.downloadAttachments(entries.map((d) => d.id));
  }

  /** The per-item list: names, sizes, and a toggle each. */
  private async chooseAttachmentsToDownload(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null) return this.notRunning();
    const entries = runtime.deferredAttachments;
    if (entries.length === 0) {
      new Notice(runtime.nothingToDownloadHere());
      return;
    }
    const chosen = await chooseAttachments(this.app, entries);
    if (chosen.length === 0) return;                       // dismissing downloads nothing
    await this.downloadAttachments(chosen);
  }

  private async downloadAttachments(ids: readonly string[]): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null) return this.notRunning();
    try {
      await runtime.downloadAttachments(ids);
    } catch (err) {
      console.error('[ShadowLink] downloading attachments failed', err);
      new Notice('ShadowLink could not download those attachments. See the console.');
    }
  }

  private notRunning(): void {
    new Notice('ShadowLink is not running in this vault. Check its settings and reload it.');
  }

  // ---------------------------------------------------------- status bar

  private refreshStatus(): void {
    const runtime = this.runtime;
    if (runtime === null) return;
    const status = runtime.status();
    this.setStatus(status.text, status.tooltip);
  }

  private setStatus(text: string, tooltip: string): void {
    const el = this.statusEl;
    if (el === null) return;
    el.setText(text);
    el.setAttribute('aria-label', tooltip);
    el.setAttribute('title', tooltip);
  }

  // ---------------------------------------------------------- editor lookup

  /**
   * The CM6 view of the leaf whose file is `path` — NOT the active view.
   *
   * That distinction is the whole rename-while-open win. When the reconciler
   * renames an open note, the leaf keeps the same `TFile` and no `file-open`
   * fires; a lookup that went through the ACTIVE view would resolve to whatever
   * the user happens to be looking at instead, and mount one note's document into
   * another note's editor.
   */
  private viewFor(path: string): EditorView | null {
    const found: EditorView[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found.length > 0) return;
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (view.file === null || view.file.path !== path) return;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (cm !== undefined) found.push(cm);
    });
    return found.length > 0 ? found[0] : null;
  }
}
