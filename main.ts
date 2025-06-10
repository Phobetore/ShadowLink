import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TFile } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { keymap, EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

interface ShadowLinkSettings {
    serverUrl: string;
}

const DEFAULT_SETTINGS: ShadowLinkSettings = {
    serverUrl: 'ws://localhost:1234'
};

export default class ShadowLinkPlugin extends Plugin {
    settings: ShadowLinkSettings;
    doc: Y.Doc | null = null;
    provider: WebsocketProvider | null = null;
    collabExtensions: Extension[] = [];

    async onload() {
        await this.loadSettings();

        this.doc = new Y.Doc();
        this.provider = new WebsocketProvider(
            this.settings.serverUrl,
            'shadowlink',
            this.doc
        );

        this.registerEditorExtension(this.collabExtensions);
        this.registerEvent(this.app.workspace.on('file-open', this.handleFileOpen.bind(this)));
        // Initialize with the currently active file if any
        this.handleFileOpen(this.app.workspace.getActiveFile());

        this.addSettingTab(new ShadowLinkSettingTab(this.app, this));
        console.log('ShadowLink: connected to', this.settings.serverUrl);
    }

    onunload() {
        this.provider?.destroy();
        this.doc?.destroy();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private handleFileOpen(file: TFile | null) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!file || !view || !this.doc || !this.provider) return;

        const ytext = this.doc.getText(file.path);

        if (ytext.length === 0) {
            ytext.insert(0, view.editor.getValue());
        } else {
            view.editor.setValue(ytext.toString());
        }

        this.collabExtensions.length = 0;
        this.collabExtensions.push(
            yCollab(ytext, this.provider.awareness),
            keymap.of(yUndoManagerKeymap)
        );
        this.app.workspace.updateOptions();

        const cm = (view.editor as any).cm as EditorView | undefined;
        if (cm) {
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
                .setPlaceholder('ws://localhost:1234')
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (value) => {
                    this.plugin.settings.serverUrl = value;
                    await this.plugin.saveSettings();
                }));
    }
}
