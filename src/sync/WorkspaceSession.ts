// src/sync/WorkspaceSession.ts
// Owns one Yjs document + provider for the currently-open shared note, and
// mounts the y-codemirror.next binding into Obsidian's live CM6 editor through
// a Compartment. Opens are serialized so a session fully closes before the next
// one opens (no overlap, no race). An empty server doc is seeded from the local
// file so opening a note never blanks it.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { Compartment } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export interface WorkspaceSessionDeps {
  serverUrl: string;
  serverKey: string;
  workspaceId: string;
  userName: string;
  userColor: string;
  getActiveEditorView: () => EditorView | null;
  getNoteContent: () => string;
  onError: (msg: string) => void;
}

interface OpenSession {
  notePath: string;
  doc: Y.Doc;
  provider: WebsocketProvider;
  view: EditorView | null;
}

const SYNC_WAIT_MS = 8000;
const CLOSE_TIMEOUT_MS = 5000;

/** base64url(UTF-8 notePath) — URL-safe, charset [A-Za-z0-9_-]; matches the server's DOC_RE. */
export function toDocId(notePath: string): string {
  const bytes = new TextEncoder().encode(notePath);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class WorkspaceSession {
  private readonly yCompartment = new Compartment();
  private queue: Promise<void> = Promise.resolve();
  private active: OpenSession | null = null;

  constructor(private readonly deps: WorkspaceSessionDeps) {}

  /** Register this ONCE via plugin.registerEditorExtension. */
  editorExtension(): Extension {
    return this.yCompartment.of([]);
  }

  /** Open `notePath` for collaboration, or pass null to just close the active session. Serialized. */
  open(notePath: string | null): Promise<void> {
    this.queue = this.queue
      .then(() => this._doOpen(notePath))
      .catch((e) => this.deps.onError(`ShadowLink: ${e?.message ?? e}`));
    return this.queue;
  }

  async destroy(): Promise<void> {
    this.queue = this.queue.then(() => this._closeActive());
    await this.queue;
  }

  private async _doOpen(notePath: string | null): Promise<void> {
    await this._closeActive();
    if (!notePath) return;
    if (!this.deps.serverUrl || !this.deps.serverKey || !this.deps.workspaceId) {
      this.deps.onError('ShadowLink: configure server URL, key and workspace ID in settings.');
      return;
    }

    const doc = new Y.Doc();
    // Room = docId (single URL segment); workspaceId travels as the `w` query param.
    // This matches server/upgradeAuth.js and avoids depending on how y-websocket
    // encodes a room name containing a slash.
    const provider = new WebsocketProvider(this.deps.serverUrl, toDocId(notePath), doc, {
      connect: true,
      params: { t: this.deps.serverKey, w: this.deps.workspaceId },
      disableBc: true,
    });
    provider.awareness.setLocalStateField('user', {
      name: this.deps.userName,
      color: this.deps.userColor,
      colorLight: this.deps.userColor + '33',
    });

    // Bind only after the first server sync, so we never blank a note before
    // we know the authoritative server state.
    await this._waitForSync(provider);

    const ytext = doc.getText('content');
    if (ytext.length === 0) {
      const seed = this.deps.getNoteContent();
      if (seed.length > 0) ytext.insert(0, seed);
    }

    const view = this.deps.getActiveEditorView();
    if (view) {
      view.dispatch({
        effects: this.yCompartment.reconfigure([yCollab(ytext, provider.awareness)]),
      });
    }

    this.active = { notePath, doc, provider, view };
  }

  private _waitForSync(provider: WebsocketProvider): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; resolve(); } };
      if (provider.synced) { finish(); return; }
      provider.once('sync', () => finish());
      setTimeout(finish, SYNC_WAIT_MS);
    });
  }

  private async _closeActive(): Promise<void> {
    const s = this.active;
    this.active = null;
    if (!s) return;

    if (s.view) {
      try {
        s.view.dispatch({ effects: this.yCompartment.reconfigure([]) });
      } catch {
        /* editor view already gone */
      }
    }

    const destroy = (async (): Promise<void> => {
      s.provider.disconnect();
      s.provider.destroy();
      s.doc.destroy();
    })();
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        this.deps.onError(`Session for "${s.notePath}" timed out while closing.`);
        resolve();
      }, CLOSE_TIMEOUT_MS),
    );
    await Promise.race([destroy, timeout]);
  }
}
