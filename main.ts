import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TFile } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { keymap, EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

interface ShadowLinkSettings {
    /**
     * Server address. May include ws:// or wss:// but the scheme is optional.
     */
    serverUrl: string;
    username: string;
}

const DEFAULT_SETTINGS: ShadowLinkSettings = {
    // Default without protocol so the plugin can decide between ws:// and wss://
    serverUrl: 'localhost:1234',
    username: 'Anonymous'
};

export default class ShadowLinkPlugin extends Plugin {
    settings: ShadowLinkSettings;
    doc: Y.Doc | null = null;
    provider: WebsocketProvider | null = null;
    collabExtensions: Extension[] = [];
    statusBarItemEl: HTMLElement | null = null;
    statusHandler?: (event: { status: string }) => void;
    pendingSyncHandler?: (isSynced: boolean) => void;
    currentText: Y.Text | null = null;

    async onload() {
        await this.loadSettings();

        this.doc = new Y.Doc();
        const url = this.resolveServerUrl(this.settings.serverUrl);
        this.provider = new WebsocketProvider(
            url,
            'shadowlink',
            this.doc
        );

        const color = this.colorFromId(this.provider.awareness.clientID);
        this.provider.awareness.setLocalStateField('user', {
            name: this.settings.username,
            color,
            colorLight: color + '33'
        });

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
        this.provider.on('status', this.statusHandler);

        this.registerEditorExtension(this.collabExtensions);
        this.registerEvent(this.app.workspace.on('file-open', (file) => { void this.handleFileOpen(file); }));
        this.registerEvent(this.app.vault.on('delete', this.handleFileDelete.bind(this)));
        // Initialize with the currently active file if any
        void this.handleFileOpen(this.app.workspace.getActiveFile());

        this.addSettingTab(new ShadowLinkSettingTab(this.app, this));
        console.log('ShadowLink: connected to', url);
    }

    onunload() {
        if (this.provider && this.statusHandler) {
            this.provider.off('status', this.statusHandler);
        }
        this.provider?.destroy();
        this.doc?.destroy();
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

    private handleFileDelete(file: TFile) {
        if (!this.doc) return;
        const ytext = this.doc.getText(file.path);
        ytext.delete(0, ytext.length);
    }

    private async handleFileOpen(file: TFile | null) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!file || !view || !this.doc || !this.provider) return;

        if (this.pendingSyncHandler) {
            this.provider.off('sync', this.pendingSyncHandler);
            this.pendingSyncHandler = undefined;
        }

        const ytext = this.doc.getText(file.path);
        this.currentText = ytext;

        const initializeText = async () => {
            if (ytext.length === 0) {
                ytext.insert(0, view.editor.getValue());
            } else {
                await this.defer();
                if (this.currentText !== ytext) return;
                view.editor.setValue(ytext.toString());
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
            yCollab(ytext, this.provider.awareness),
            keymap.of(yUndoManagerKeymap)
        );
        this.app.workspace.updateOptions();

        const cm = (view.editor as any).cm as EditorView | undefined;
        if (cm) {
            await this.defer();
            if (this.currentText !== ytext) return;
            cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: ytext.toString() } });
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
    }
}
