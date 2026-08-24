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

import { MarkdownView, Notice, Plugin, TFolder, normalizePath } from 'obsidian';
import type { TAbstractFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { WebsocketProvider } from 'y-websocket';

import { SettingsTab } from './src/ui/SettingsTab';
import {
  confirmBulkDelete,
  confirmFirstSync,
  confirmLocalBulkDelete,
  confirmUnshare,
} from './src/ui/modals';
import { DEFAULT_SETTINGS, ShadowLinkSettings } from './src/types';

import { RECONCILE_DEBOUNCE_MS, TREE_SNAPSHOT_DEBOUNCE_MS } from './src/tree/constants';
import { TreeDoc } from './src/tree/TreeDoc';
import { Bootstrap } from './src/sync/Bootstrap';
import { DeviceState } from './src/sync/DeviceState';
import { Deletions } from './src/sync/Deletions';
import { ObsidianDocPort } from './src/sync/ObsidianDocPort';
import { ObsidianStatePort, treeSnapshotKey } from './src/sync/ObsidianStatePort';
import { ObsidianVaultPort } from './src/sync/ObsidianVaultPort';
import { PublishQueue } from './src/sync/PublishQueue';
import { Reconciler } from './src/sync/Reconciler';
import type { ReconcileCause } from './src/sync/Reconciler';
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

  /** Read fresh by the watcher and the session; §4.1 can move it mid-session. */
  private shareRoot: string;

  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
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
    });

    this.queue = new PublishQueue({
      docs: this.docs,
      vault: this.vault,
      state: this.state,
      tree: this.tree,
      openNodeId: this.session.openNodeId,
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
      confirmLocalBulkDelete: (count) => confirmLocalBulkDelete(app, count),
      confirmUnshare: (rootPath, count) => confirmUnshare(app, rootPath, count),
    });

    this.deletions = new Deletions({
      vault: this.vault,
      state: this.state,
      tickets: this.tickets,
      shareRoot: this.shareRoot,
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
      state: this.state,
      tickets: this.tickets,
      shareRoot: this.shareRoot,
      entries: () => this.tree.entries(),
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
      reconcile: (cause) => this.reconciler.reconcile(cause),
      // Both halves of the same answer: one module must not report `ready` while
      // the other is refusing every pass.
      syncPaused: () => this.reconciler.readOnlyReason,
      resumeSync: () => { this.reconciler.clearReadOnly(); },
      replayPendingEvents: () => this.watcher.flushPending(),
      notice: (msg) => { new Notice(msg); },
    });
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
    this.retryTimer = setInterval(() => {
      if (this.queue.pendingCount() > 0) this.scheduleReconcile('retry');
    }, PUBLISH_RETRY_MS);

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

    plugin.registerEvent(plugin.app.workspace.on('file-open', (file) => {
      const path = file === null ? null : file.path;
      void this.session.open(path !== null && this.isSharedNote(path) ? path : null);
    }));
  }

  // ---------------------------------------------------------- status

  /**
   * What the status bar should say right now.
   *
   * Both read-only reasons are POLLED rather than latched from an event, because
   * one of the two kinds heals by itself: the reconciler re-derives a pause it
   * diagnosed on its own evidence at the top of every pass, so a one-shot listener
   * would keep showing a state that stopped being true several passes ago.
   */
  status(): { text: string; tooltip: string } {
    const paused = this.bootstrap.readOnlyReason ?? this.reconciler.readOnlyReason;
    if (paused !== null) return { text: 'ShadowLink: paused', tooltip: paused };
    if (this.bootstrap.phase !== 'ready') {
      return { text: 'ShadowLink: starting…', tooltip: 'ShadowLink is joining the workspace.' };
    }
    const pending = this.queue.pendingCount();
    if (this.reconciler.reconciling || this.reconcileRunning || this.reconcileTimer !== null
        || pending > 0) {
      return {
        text: 'ShadowLink: syncing…',
        tooltip: pending > 0 ? `${pending} file(s) waiting to upload` : 'Reconciling the vault',
      };
    }
    return { text: 'ShadowLink: synced', tooltip: `Sharing ${this.shareRoot}` };
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
