// main.ts
import { Plugin, Notice, MarkdownView, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { WorkspaceSession } from './src/sync/WorkspaceSession';
import { SettingsTab } from './src/ui/SettingsTab';
import { DEFAULT_SETTINGS, ShadowLinkSettings } from './src/types';

export default class ShadowLinkPlugin extends Plugin {
  settings: ShadowLinkSettings = { ...DEFAULT_SETTINGS };
  private session: WorkspaceSession | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));

    this.session = new WorkspaceSession({
      serverUrl: this.settings.share.serverUrl,
      serverKey: this.settings.share.serverKey,
      workspaceId: this.settings.share.workspaceId,
      userName: this.settings.displayName,
      userColor: this.settings.cursorColor,
      getActiveEditorView: () => this._activeEditorView(),
      getNoteContent: () =>
        this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.getValue() ?? '',
      onError: (msg) => new Notice(msg, 6000),
    });

    // Register the binding compartment once; WorkspaceSession reconfigures it per note.
    this.registerEditorExtension([this.session.editorExtension()]);

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (!this.session) return;
        if (file instanceof TFile && this._isShared(file.path)) {
          void this.session.open(file.path);
        } else {
          void this.session.open(null);
        }
      }),
    );
  }

  async onunload(): Promise<void> {
    await this.session?.destroy();
    this.session = null;
  }

  private _activeEditorView(): EditorView | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cm = (view?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
    return cm ?? null;
  }

  private _isShared(path: string): boolean {
    const s = this.settings.share;
    if (!s.serverUrl || !s.serverKey || !s.workspaceId || !s.sharedFolder) return false;
    const folder = s.sharedFolder.replace(/\/+$/, '');
    return path === folder || path.startsWith(folder + '/');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.share = Object.assign({}, DEFAULT_SETTINGS.share, this.settings.share);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
