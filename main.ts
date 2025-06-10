import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TFile, TAbstractFile } from 'obsidian';
import { createHash } from 'crypto';
import type * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import type { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { keymap, EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

interface ShadowLinkSettings {
    /**
     * Server address. May include ws:// or wss:// but the scheme is optional.
     */
    serverUrl: string;
    username: string;
    authToken: string;
}

const DEFAULT_SETTINGS: ShadowLinkSettings = {
    // Default without protocol so the plugin can decide between ws:// and wss://
    serverUrl: 'localhost:1234',
    username: 'Anonymous',
    authToken: ''
};

export default class ShadowLinkPlugin extends Plugin {
    settings: ShadowLinkSettings;
    doc: Y.Doc | null = null;
    provider: WebsocketProvider | null = null;
    currentFile: TFile | null = null;
    vaultId = '';
    metadataDoc: Y.Doc | null = null;
    metadataProvider: WebsocketProvider | null = null;
    collabExtensions: Extension[] = [];
    statusBarItemEl: HTMLElement | null = null;
    statusHandler?: (event: { status: string }) => void;
    connectionCloseHandler?: (event: CloseEvent) => void;
    pendingSyncHandler?: (isSynced: boolean) => void;
    currentText: Y.Text | null = null;
    private Y?: typeof import('yjs');
    private WebsocketProviderClass?: typeof import('y-websocket').WebsocketProvider;
    private yCollab?: typeof import('y-codemirror.next').yCollab;
    private yUndoManagerKeymap?: typeof import('y-codemirror.next').yUndoManagerKeymap;
    private cmKeymap?: typeof import('@codemirror/view').keymap;
    private modulesPromise: Promise<void> | null = null;

    async onload() {
        await this.loadSettings();

        const basePath = (this.app.vault.adapter as any).basePath || this.app.vault.getName();
        this.vaultId = createHash('sha256').update(basePath).digest('hex').slice(0, 8);

        const url = this.resolveServerUrl(this.settings.serverUrl);

        this.statusBarItemEl = this.addStatusBarItem();
        this.statusBarItemEl.setText('ShadowLink: connecting');
        this.statusHandler = (event: { status: string }) => {
            if (!this.statusBarItemEl) return;
            switch (event.status) {
                case 'connected':
                    this.statusBarItemEl.setText('ShadowLink: connected');
                    break;
                case 'disconnected':
                    this.statusBarItemEl.setText('ShadowLink: disconnected');
                    break;
                default:
                    this.statusBarItemEl.setText('ShadowLink: ' + event.status);
            }
        };
        this.connectionCloseHandler = (event: CloseEvent) => {
            if (!this.statusBarItemEl) return;
            const reason = event?.reason ? `: ${event.reason}` : '';
            this.statusBarItemEl.setText(`ShadowLink: disconnected${reason}`);
        };
        await this.connectMetadata();
        this.registerEditorExtension(this.collabExtensions);
        this.registerEvent(this.app.workspace.on('file-open', (file) => { void this.handleFileOpen(file); }));
        this.registerEvent(this.app.vault.on('delete', this.handleFileDelete.bind(this)));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { void this.handleFileRename(file, oldPath); }));
        this.registerEvent(this.app.vault.on('create', (file) => { void this.handleFileCreate(file); }));
        // Initialize with the currently active file if any
        void this.handleFileOpen(this.app.workspace.getActiveFile());

        this.addSettingTab(new ShadowLinkSettingTab(this.app, this));
        console.log('ShadowLink: ready, server', url);
    }

    onunload() {
        this.cleanupCurrent();
        this.cleanupMetadata();
        this.statusBarItemEl?.remove();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Resolve the final WebSocket URL. If the provided value includes a
     * protocol it is used as-is. Otherwise the scheme is selected based on the
     * current page (wss for https, ws otherwise).
     */
    private resolveServerUrl(url: string): string {
        if (/^wss?:\/\//.test(url)) {
            return url;
        }
        if (/^https?:\/\//.test(url)) {
            const rest = url.replace(/^https?:\/\//, '');
            return url.startsWith('https://') ? `wss://${rest}` : `ws://${rest}`;
        }
        const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        if (url.startsWith('//')) {
            return scheme + url.slice(2);
        }
        return scheme + url;
    }

    private colorFromId(id: number): string {
        const hue = id % 360;
        return `hsl(${hue}, 80%, 50%)`;
    }

    /**
     * Yield to the event loop to keep the UI responsive.
     */
    private defer(): Promise<void> {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    private async loadCollabModules(): Promise<void> {
        if (!this.modulesPromise) {
            this.modulesPromise = Promise.all([
                import('yjs'),
                import('y-websocket'),
                import('y-codemirror.next'),
                import('@codemirror/view')
            ]).then(([Y, yws, ycm, view]) => {
                this.Y = Y as typeof import('yjs');
                this.WebsocketProviderClass = yws.WebsocketProvider;
                this.yCollab = ycm.yCollab;
                this.yUndoManagerKeymap = ycm.yUndoManagerKeymap;
                this.cmKeymap = view.keymap;
            });
        }
        await this.modulesPromise;
    }

    private docNameForFile(file: TFile): string {
        return `${this.vaultId}/${file.path}`;
    }

    private metadataDocName(): string {
        return `${this.vaultId}/vault-metadata`;
    }

    private cleanupCurrent() {
        if (this.provider && this.statusHandler) {
            this.provider.off('status', this.statusHandler);
        }
        if (this.provider && this.connectionCloseHandler) {
            this.provider.off('connection-close', this.connectionCloseHandler);
        }
        this.provider?.destroy();
        this.doc?.destroy();
        this.provider = null;
        this.doc = null;
        this.currentText = null;
        this.currentFile = null;
    }

    private cleanupMetadata() {
        this.metadataProvider?.destroy();
        this.metadataDoc?.destroy();
        this.metadataProvider = null;
        this.metadataDoc = null;
    }

    private async connectMetadata(): Promise<void> {
        await this.loadCollabModules();
        const url = this.resolveServerUrl(this.settings.serverUrl);
        this.metadataDoc = new this.Y!.Doc();
        this.metadataProvider = new this.WebsocketProviderClass!(url, this.metadataDocName(), this.metadataDoc, {
            params: { token: this.settings.authToken }
        });
        const onSync = async (synced: boolean) => {
            if (synced) {
                await this.syncLocalWithMetadata();
                this.metadataProvider?.off('sync', onSync);
            }
        };
        if (this.metadataProvider.synced) {
            await this.syncLocalWithMetadata();
        } else {
            this.metadataProvider.on('sync', onSync);
        }
    }

    private async syncLocalWithMetadata() {
        if (!this.metadataDoc) return;
        const arr = this.metadataDoc.getArray<string>('paths');
        const remote = new Set(arr.toArray());
        const localFiles = this.app.vault.getFiles();
        const localSet = new Set(localFiles.map(f => f.path));
        for (const p of remote) {
            if (!localSet.has(p)) {
                await this.app.vault.create(p, '');
            }
        }
        for (const p of localSet) {
            if (!remote.has(p)) {
                const f = this.app.vault.getAbstractFileByPath(p);
                if (f instanceof TFile) {
                    await this.app.vault.delete(f);
                }
            }
        }
    }
    private async handleFileDelete(file: TFile) {
        await this.loadCollabModules();
        if (this.currentFile && file.path === this.currentFile.path) {
            this.cleanupCurrent();
        }
        if (this.metadataDoc) {
            const arr = this.metadataDoc.getArray<string>('paths');
            const idx = arr.toArray().indexOf(file.path);
            if (idx >= 0) arr.delete(idx, 1);
        }
        // Optionally inform the server about the deletion
        const doc = new this.Y!.Doc();
        const url = this.resolveServerUrl(this.settings.serverUrl);
        const provider = new this.WebsocketProviderClass!(url, this.docNameForFile(file), doc, {
            params: { token: this.settings.authToken }
        });
        const text = doc.getText('content');
        provider.once('sync', () => {
            text.delete(0, text.length);
            provider.destroy();
            doc.destroy();
        });
    }

    private async handleFileCreate(file: TAbstractFile) {
        if (!(file instanceof TFile)) return;
        if (this.metadataDoc) {
            const arr = this.metadataDoc.getArray<string>('paths');
            if (!arr.toArray().includes(file.path)) {
                arr.push([file.path]);
            }
        }
    }

    private async handleFileRename(file: TAbstractFile, oldPath: string) {
        if (!(file instanceof TFile)) return;
        if (this.currentFile && oldPath === this.currentFile.path) {
            this.cleanupCurrent();
            const doc = new this.Y!.Doc();
            const url = this.resolveServerUrl(this.settings.serverUrl);
            const provider = new this.WebsocketProviderClass!(url, `${this.vaultId}/${oldPath}`, doc, {
                params: { token: this.settings.authToken }
            });
            const text = doc.getText('content');
            provider.once('sync', () => {
                text.delete(0, text.length);
                provider.destroy();
                doc.destroy();
            });
            await this.handleFileOpen(file);
        }
        if (this.metadataDoc) {
            const arr = this.metadataDoc.getArray<string>('paths');
            const list = arr.toArray();
            const oldIdx = list.indexOf(oldPath);
            if (oldIdx >= 0) arr.delete(oldIdx, 1);
            if (!list.includes(file.path)) arr.push([file.path]);
        }
    }

    private async handleFileOpen(file: TFile | null) {
        await this.loadCollabModules();
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!file || !view) {
            this.cleanupCurrent();
            return;
        }

        if (this.currentFile && this.currentFile.path === file.path) {
            return;
        }

        this.cleanupCurrent();

        const url = this.resolveServerUrl(this.settings.serverUrl);
        this.doc = new this.Y!.Doc();
        this.provider = new this.WebsocketProviderClass!(url, this.docNameForFile(file), this.doc, {
            params: { token: this.settings.authToken }
        });
        this.currentFile = file;

        const clientId = this.provider.awareness.clientID;
        const hue = clientId % 360;
        const color = this.colorFromId(clientId);
        this.provider.awareness.setLocalStateField('user', {
            name: this.settings.username,
            color,
            colorLight: `hsla(${hue}, 80%, 50%, 0.2)`
        });
        if (this.statusHandler) {
            this.provider.on('status', this.statusHandler);
        }
        if (this.connectionCloseHandler) {
            this.provider.on('connection-close', this.connectionCloseHandler);
        }
        if (this.pendingSyncHandler) {
            this.provider.off('sync', this.pendingSyncHandler);
            this.pendingSyncHandler = undefined;
        }

        const ytext = this.doc.getText('content');
        this.currentText = ytext;

        const initializeText = async () => {
            if (ytext.length === 0) {
                ytext.insert(0, view.editor.getValue());
            } else {
                const newValue = ytext.toString();
                if (view.editor.getValue() === newValue) return;
                await this.defer();
                if (this.currentText !== ytext) return;
                view.editor.setValue(newValue);
            }
        };

        if (this.provider.synced) {
            await initializeText();
        } else {
            this.pendingSyncHandler = async (isSynced: boolean) => {
                if (isSynced && this.currentText === ytext) {
                    await initializeText();
                    this.provider?.off('sync', this.pendingSyncHandler!);
                    this.pendingSyncHandler = undefined;
                }
            };
            this.provider.on('sync', this.pendingSyncHandler);
        }

        this.collabExtensions.length = 0;
        this.collabExtensions.push(
            this.yCollab!(ytext, this.provider.awareness),
            this.cmKeymap!.of(this.yUndoManagerKeymap!)
        );
        this.app.workspace.updateOptions();

        const cm = (view.editor as any).cm as EditorView | undefined;
        if (cm) {
            const newValue = ytext.toString();
            if (cm.state.doc.toString() !== newValue) {
                await this.defer();
                if (this.currentText !== ytext) return;
                cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: newValue } });
            }
        }
    }
}

class ShadowLinkSettingTab extends PluginSettingTab {
    plugin: ShadowLinkPlugin;

    constructor(app: App, plugin: ShadowLinkPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('WebSocket server used for collaboration')
            .addText(text => text
                .setPlaceholder('localhost:1234')
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (value) => {
                    this.plugin.settings.serverUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Username')
            .setDesc('Displayed to collaborators')
            .addText(text => text
                .setPlaceholder('Anonymous')
                .setValue(this.plugin.settings.username)
                .onChange(async (value) => {
                    this.plugin.settings.username = value;
                    await this.plugin.saveSettings();
                    if (this.plugin.provider) {
                        const current = this.plugin.provider.awareness.getLocalState() || {};
                        this.plugin.provider.awareness.setLocalStateField('user', {
                            ...current.user,
                            name: value
                        });
                    }
                }));

        new Setting(containerEl)
            .setName('Auth Token')
            .setDesc('Shared secret required by the server')
            .addText(text => text
                .setPlaceholder('optional')
                .setValue(this.plugin.settings.authToken)
                .onChange(async (value) => {
                    this.plugin.settings.authToken = value;
                    await this.plugin.saveSettings();
                }));
    }
}
