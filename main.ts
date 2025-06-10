import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

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

    async onload() {
        await this.loadSettings();

        this.doc = new Y.Doc();
        this.provider = new WebsocketProvider(
            this.settings.serverUrl,
            'shadowlink',
            this.doc
        );

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
