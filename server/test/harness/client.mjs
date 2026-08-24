// server/test/harness/client.mjs
// One simulated ShadowLink client for the structural end-to-end suite.
//
// Everything below the vault is REAL: the shipped `Bootstrap`, `VaultWatcher`,
// `Reconciler`, `Deletions`, `PublishQueue`, `TreeDoc`, `TreeIndex`, `DiskIndex`,
// `Tickets` and `DeviceState`, wired exactly as spec §4.1/§4.3/§4.5 describe. Only
// the two ports are simulated, and only in the way the spec's §4.0 anticipates:
// the vault is `FakeVault` (in-memory, case-insensitive, retains what it trashes)
// and the doc port is a real WebSocket to the real server.
//
// The one piece of fidelity this file adds over the Group B fakes is EVENT ECHO.
// Obsidian fires `create` / `rename` / `delete` for the plugin's own vault
// mutations, and those echoes are the whole reason tickets and invariant I8
// exist. `WatchedVault` therefore feeds every mutation back through the watcher,
// synchronously, exactly as Obsidian does — so a broken ticket or a
// non-idempotent handler shows up here as an echo loop rather than as nothing at
// all (Group C test 71).

import { FakeVault } from '../../../src/sync/fakes.ts';
import { TreeDoc, LOCAL_ORIGIN } from '../../../src/tree/TreeDoc.ts';
import { deriveTree } from '../../../src/tree/TreeIndex.ts';
import { fold, isLive, relPath } from '../../../src/tree/paths.ts';
import { DeviceState } from '../../../src/sync/DeviceState.ts';
import { Tickets } from '../../../src/sync/Tickets.ts';
import { Reconciler } from '../../../src/sync/Reconciler.ts';
import { VaultWatcher } from '../../../src/sync/VaultWatcher.ts';
import { Deletions } from '../../../src/sync/Deletions.ts';
import { PublishQueue } from '../../../src/sync/PublishQueue.ts';
import { Bootstrap } from '../../../src/sync/Bootstrap.ts';
import * as Y from 'yjs';
import { DocLink, WsDocPort, sleep } from './net.mjs';

export const SHARE_ROOT = 'Shared';
const MUTATIONS = new Set(['create', 'createFolder', 'rename', 'trashLocal']);

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// ============================================================ WatchedVault

/**
 * `FakeVault` that reports its own mutations, the way Obsidian's vault does.
 *
 * The handler is invoked SYNCHRONOUSLY from the mutating call, because every
 * watcher handler consumes its suppression ticket before its first `await` — so
 * a delayed delivery would silently turn every ticket into a miss and hide the
 * echo-suppression behaviour this harness is meant to exercise.
 */
class WatchedVault extends FakeVault {
  constructor(options, emit) {
    super(options);
    this._emit = emit;
  }

  _kind(path) {
    const key = fold(path);
    for (const entry of super.list()) if (fold(entry.path) === key) return entry.kind;
    return 'f';
  }

  async create(path, data) {
    await super.create(path, data);
    this._emit({ op: 'create', path, kind: 'f' });
  }

  async createFolder(path) {
    await super.createFolder(path);
    this._emit({ op: 'create', path, kind: 'd' });
  }

  async rename(from, to) {
    const kind = this._kind(from);
    await super.rename(from, to);
    this._emit({ op: 'rename', path: to, oldPath: from, kind });
  }

  async trashLocal(path) {
    const kind = this._kind(path);
    await super.trashLocal(path);
    this._emit({ op: 'delete', path, kind });
  }

  /**
   * The USER removing something, by hand or through an external tool.
   *
   * It reaches the plugin as a bare `delete` event and nothing else: it must not
   * appear in `trashed` (which is how a test proves the PLUGIN trashed a file)
   * and it must not appear in `calls` (which is how a test proves the plugin
   * mutated the vault at all).
   */
  async userRemove(path) {
    const kind = this._kind(path);
    const before = new Set(this.trashed.keys());
    const callCount = this.calls.length;
    await FakeVault.prototype.trashLocal.call(this, path);
    for (const key of [...this.trashed.keys()]) {
      if (!before.has(key)) this.trashed.delete(key);
    }
    this.calls.length = callCount;
    this._emit({ op: 'delete', path, kind });
  }
}

// ============================================================ StatePort

class MemoryStatePort {
  constructor() { this.files = new Map(); }
  async read(key) { return this.files.get(key) ?? null; }
  async write(key, data) { this.files.set(key, data); }
}

// ============================================================ Client

export class Client {
  /**
   * @param {object} options
   *   name, server (from startServer), workspace, deviceId,
   *   treeSyncTimeoutMs, docSyncTimeoutMs, publishBackoff
   */
  constructor(options) {
    const {
      name,
      server,
      workspace,
      deviceId = `dev-${name}`,
      treeSyncTimeoutMs = 4000,
      docSyncTimeoutMs = 2500,
      publishBackoff = [5, 10, 25, 50],
      sleepFn = async () => undefined,
      founderWaitCapMs = 4000,
    } = options;

    this.name = name;
    this.server = server;
    this.workspace = workspace;
    this.deviceId = deviceId;
    this.shareRoot = SHARE_ROOT;
    this.treeSyncTimeoutMs = treeSyncTimeoutMs;

    this.notices = [];
    this.confirmations = [];
    this.bulkPrompts = [];
    this.localBulkPrompts = [];
    this.unsharePrompts = [];
    this.eventErrors = [];
    /** Answers the first-sync modal. Tests may swap it out before `start()`. */
    this.decision = { proceed: true, shareLocalFiles: true };
    /** Answer to §5.4's aggregated remote-delete dialog. */
    this.bulkChoice = 'apply';

    /** Every handler promise started by an echo, awaited by `drainEvents`. */
    this._events = [];
    this._eventsEnabled = false;

    /**
     * Per-item failures reported by the most recent reconcile pass.
     *
     * A pass that threw `RetryLater` on a content doc did not converge, it
     * DEFERRED — the file it was asked to materialize is still missing and the
     * next pass is expected to fetch it. `settleAll` reads this so that it keeps
     * pumping instead of counting a deferral as a quiet round.
     */
    this.lastFailures = [];

    this.vault = new WatchedVault({}, (ev) => this._onVaultEvent(ev));
    this.vault.seed(SHARE_ROOT, 'd');

    this.statePort = new MemoryStatePort();
    this.state = new DeviceState(this.statePort, deviceId, workspace, () => Date.now(), 5);
    this.tickets = new Tickets();

    this.tree = new TreeDoc();
    this.localTxns = 0;
    this.remoteTxns = 0;
    this.dirty = false;
    this.tree.doc.on('afterTransaction', (txn) => {
      if (txn.origin === LOCAL_ORIGIN) this.localTxns += 1;
    });
    this.tree.observe((isLocal) => {
      if (isLocal) return;
      this.remoteTxns += 1;
      this.dirty = true;                       // spec §4.3: mark dirty, schedule
    });

    this.treeLink = new DocLink(server.url('_tree', workspace), this.tree.doc);
    this.docs = new WsDocPort({
      urlFor: (room) => server.url(room, workspace),
      syncTimeoutMs: docSyncTimeoutMs,
      flushTimeoutMs: docSyncTimeoutMs,
    });

    this.publishQueue = new PublishQueue({
      docs: this.docs,
      vault: this.vault,
      state: this.state,
      tree: this.tree,
      openNodeId: () => null,                  // no editing session in a headless client
      backoff: publishBackoff,
    });

    this.watcher = new VaultWatcher({
      tree: this.tree,
      entries: () => this.tree.entries(),
      vault: this.vault,
      state: this.state,
      tickets: this.tickets,
      getShareRoot: () => this.shareRoot,
      setShareRoot: (next) => { this.shareRoot = next; },
      displayName: name,
      phase: () => this.bootstrap.phase,
      notice: (m) => this.notices.push(m),
      enterReadOnly: (reason) => this.reconciler.enterReadOnly(reason),
      scheduleReconcile: () => { this.dirty = true; },
      enqueuePublish: (id) => this.publishQueue.enqueue(id),
      confirmLocalBulkDelete: async (count) => {
        this.localBulkPrompts.push(count);
        return this.localBulkChoice ?? true;
      },
      confirmUnshare: async (root, count) => {
        this.unsharePrompts.push({ root, count });
        return this.unshareChoice ?? 'unshare';
      },
    });

    this.deletions = new Deletions({
      vault: this.vault,
      state: this.state,
      tickets: this.tickets,
      shareRoot: SHARE_ROOT,
      notice: (m) => this.notices.push(m),
      confirmBulk: async (summary) => {
        this.bulkPrompts.push(summary);
        return this.bulkChoice;
      },
    });

    this.reconciler = new Reconciler({
      vault: this.vault,
      docs: this.docs,
      state: this.state,
      tickets: this.tickets,
      shareRoot: SHARE_ROOT,
      entries: () => this.tree.entries(),
      pendingDecision: () => this.watcher.pendingDecision,
      // Spec §4.5: tombstones stay off until bootstrap's first reconcile is done.
      applyDeletions: (ctx) => (
        this.bootstrap.tombstonesEnabled ? this.deletions.apply(ctx) : Promise.resolve()
      ),
      publishUntracked: async (paths) => {
        for (const path of paths) await this.watcher.onCreate(path, 'f');
        await this.publishQueue.drain();
      },
      notice: (m) => this.notices.push(m),
    });

    this.snapshotBytes = null;
    this.bootstrap = new Bootstrap({
      state: this.state,
      tree: this.tree,
      vault: this.vault,
      shareRoot: SHARE_ROOT,
      deviceId,
      loadSnapshot: async () => this.snapshotBytes,
      connectTree: async (ms) => {
        this.treeLink.connect();
        return this.treeLink.waitSync(ms);
      },
      confirm: async (confirmation) => {
        this.confirmations.push(confirmation);
        return this.decision;
      },
      reconcile: (cause) => this.reconciler.reconcile(cause),
      replayPendingEvents: () => this.watcher.flushPending(),
      notice: (m) => this.notices.push(m),
      sleep: sleepFn,
      treeSyncTimeoutMs,
      founderWaitCapMs,
    });
  }

  // ---------------------------------------------------------- lifecycle

  /** Spec §4.5. Returns the bootstrap result. */
  async start() {
    this._eventsEnabled = true;
    const result = await this.bootstrap.run();
    await this.drainEvents();
    return result;
  }

  /**
   * Spec §4.6, after a partition heals.
   *
   * Reviving the socket is the PROVIDER's job, not `Bootstrap`'s: a client that
   * is already `ready` short-circuits `onReconnect`, and in Obsidian the
   * y-websocket provider has reconnected on its own by the time the status
   * transition that calls this fires.
   */
  async reconnect() {
    this.docs.goOnline();
    this.treeLink.blocked = false;
    this.treeLink.connect();
    const synced = await this.treeLink.waitSync(this.treeSyncTimeoutMs);
    const result = await this.bootstrap.onReconnect();
    await this.drainEvents();
    return { synced, ...result };
  }

  /** Cut this client off from the server entirely — tree and content docs. */
  partition() {
    this.treeLink.blocked = true;
    this.treeLink.disconnect();
    this.docs.goOffline();
  }

  async dispose() {
    this.watcher.dispose();
    this.treeLink.destroy();
    await this.docs.destroy();
  }

  // ---------------------------------------------------------- vault events

  _onVaultEvent(ev) {
    if (!this._eventsEnabled) return;
    let promise;
    if (ev.op === 'create') promise = this.watcher.onCreate(ev.path, ev.kind);
    else if (ev.op === 'rename') promise = this.watcher.onRename(ev.path, ev.oldPath, ev.kind);
    else { this.watcher.onDelete(ev.path, ev.kind); promise = Promise.resolve(); }
    this._events.push(promise.catch((err) => { this.eventErrors.push(err); }));
  }

  /** Run every queued handler to completion, including the coalesced batches. */
  async drainEvents() {
    for (let i = 0; i < 40; i++) {
      const queued = this._events.splice(0);
      if (queued.length > 0) await Promise.all(queued);
      await this.watcher.flushDeleteBatch();
      await this.watcher.flushUnshare();
      if (this._events.length === 0) return;
    }
    throw new Error(`${this.name}: vault event handlers never quiesced`);
  }

  // ---------------------------------------------------------- user actions

  path(rel) { return rel === '' ? SHARE_ROOT : `${SHARE_ROOT}/${rel}`; }

  async userCreateFolder(rel) {
    const target = this.path(rel);
    const segs = target.split('/');
    for (let i = 2; i <= segs.length; i++) {
      const p = segs.slice(0, i).join('/');
      if (!(await this.vault.exists(p))) await this.vault.createFolder(p);
    }
    await this.drainEvents();
  }

  async userCreateFile(rel, text) {
    const target = this.path(rel);
    const parent = target.slice(0, target.lastIndexOf('/'));
    if (parent !== SHARE_ROOT) await this.userCreateFolder(parent.slice(SHARE_ROOT.length + 1));
    await this.vault.create(target, text);
    await this.drainEvents();
  }

  async userRename(fromRel, toRel) {
    const to = this.path(toRel);
    const parent = to.slice(0, to.lastIndexOf('/'));
    if (parent !== SHARE_ROOT && !(await this.vault.exists(parent))) {
      await this.userCreateFolder(parent.slice(SHARE_ROOT.length + 1));
    }
    await this.vault.rename(this.path(fromRel), to);
    await this.drainEvents();
  }

  /** Move a path out of the share entirely (spec §5.5). */
  async userMoveOutOfShare(fromRel, absoluteTo) {
    await this.vault.rename(this.path(fromRel), absoluteTo);
    await this.drainEvents();
  }

  async userDelete(rel) {
    await this.vault.userRemove(this.path(rel));
    await this.drainEvents();
  }

  // ---------------------------------------------------------- reconcile

  mutationCount() {
    let n = 0;
    for (const call of this.vault.calls) if (MUTATIONS.has(call.op)) n += 1;
    return n;
  }

  mutationCalls() {
    return this.vault.calls.filter((c) => MUTATIONS.has(c.op));
  }

  /** Order-independent fingerprint of the tree, for quiescence detection. */
  treeFingerprint() {
    return JSON.stringify(
      this.tree.entries()
        .sort((a, b) => cmp(a[0], b[0]))
        .map(([id, f]) => [id, f]),
    );
  }

  /**
   * Run reconcile passes until the client stops changing anything.
   * Returns the number of passes that actually did work.
   */
  async settle(maxPasses = 8) {
    let worked = 0;
    for (let i = 0; i < maxPasses; i++) {
      await this.drainEvents();
      const beforeCalls = this.mutationCount();
      const beforeTree = this.treeFingerprint();
      this.dirty = false;
      const result = await this.reconciler.reconcile('remote');
      this.lastFailures = result.failures ?? [];
      await this.drainEvents();
      const changed = this.mutationCount() !== beforeCalls
        || this.treeFingerprint() !== beforeTree;
      if (changed) worked += 1;
      if (!changed && !this.dirty) return worked;
    }
    return worked;
  }

  // ---------------------------------------------------------- observation

  /** Live node ids, sorted. */
  liveNodeIds() {
    return this.tree.entries()
      .filter(([, f]) => isLive(f))
      .map(([id]) => id)
      .sort(cmp);
  }

  /** nodeId -> share-relative derived path, for live valid nodes. */
  derived() {
    return deriveTree(this.tree.entries()).derivedPath;
  }

  /** Share-relative path of a live node, or null. */
  pathOf(nodeId) {
    return this.derived().get(nodeId) ?? null;
  }

  /** The live node whose STORED path is `rel`, or null. */
  nodeAt(rel) {
    for (const [id, f] of this.tree.entries()) {
      if (isLive(f) && fold(relPath(f)) === fold(rel)) return id;
    }
    return null;
  }

  /** Everything under the share, as `{ files: {path: text}, folders: [path] }`. */
  layout() {
    const files = {};
    const folders = [];
    for (const entry of this.vault.list()) {
      if (!entry.path.startsWith(`${SHARE_ROOT}/`)) continue;   // the root is not a node (I14)
      if (entry.kind === 'd') folders.push(entry.path);
    }
    const snapshot = this.vault.snapshot();
    for (const path of Object.keys(snapshot).sort()) {
      if (!path.startsWith(`${SHARE_ROOT}/`)) continue;
      files[path] = snapshot[path];
    }
    return { files, folders: folders.sort() };
  }

  /** Paths that exist anywhere in the vault, including the reserved folders. */
  wholeVault() {
    return this.vault.snapshot();
  }

  /** Everything the plugin moved into `ShadowLink Recovered/`. */
  recovered() {
    return Object.keys(this.vault.snapshot()).filter((p) => p.startsWith('ShadowLink Recovered/'));
  }

  /** Content-doc state for `nodeId`, as the local pooled connection sees it. */
  contentText(nodeId) {
    const doc = this.docs.rawDoc(`n_${nodeId}`);
    return doc === null ? null : doc.getText('content').toString();
  }

  contentStateBytes(nodeId) {
    const doc = this.docs.rawDoc(`n_${nodeId}`);
    return doc === null ? null : Y.encodeStateAsUpdate(doc);
  }
}

// ============================================================ orchestration

/**
 * Pump every client until the whole workspace is quiet: nothing left to
 * reconcile locally, nothing deferred to a later pass, and nothing new arriving
 * from the server.
 *
 * The clients handed here are ones the caller expects to be SYNCING. A client
 * that never got past `boot` mutates nothing and therefore looks perfectly quiet
 * — which is how a tree provider that failed to sync used to surface three
 * hundred lines later as "only 0 live nodes", a sentence about a symptom rather
 * than about the cause. Say the cause instead.
 */
export async function settleAll(clients, { rounds = 25, waitMs = 60 } = {}) {
  for (const client of clients) {
    if (client.bootstrap.phase !== 'ready') {
      throw new Error(
        `${client.name} is not syncing (phase ${client.bootstrap.phase}): `
        + `${client.bootstrap.readOnlyReason ?? 'no reason recorded'}`,
      );
    }
  }

  let quietRounds = 0;
  let maxWork = 0;
  for (let r = 0; r < rounds; r++) {
    await sleep(waitMs);
    let changed = false;
    let deferred = false;
    for (const client of clients) {
      const before = `${client.mutationCount()}|${client.treeFingerprint()}`;
      const work = await client.settle();
      if (work > maxWork) maxWork = work;
      const after = `${client.mutationCount()}|${client.treeFingerprint()}`;
      if (before !== after || client.dirty) changed = true;
      if (client.lastFailures.length > 0) deferred = true;
    }
    // A pass that reported per-item failures changed nothing precisely BECAUSE
    // it could not — a content doc that had not synced yet leaves the file it
    // was going to write still missing. Reading that as quiet is what let this
    // pump exit with a client half-materialized, and every assertion afterwards
    // then described a state nobody was still waiting for.
    quietRounds = (changed || deferred) ? 0 : quietRounds + 1;
    // Two consecutive silent rounds: one for the local fixpoint, one to prove
    // nothing was still in flight when the first one ended.
    if (quietRounds >= 2) return { rounds: r + 1, maxWork, converged: true };
  }
  return { rounds, maxWork, converged: false };
}
