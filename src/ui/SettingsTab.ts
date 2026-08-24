// src/ui/SettingsTab.ts
import { App, PluginSettingTab, Setting } from 'obsidian';
import type ShadowLinkPlugin from '../../main';

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ShadowLinkPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'ShadowLink' });

    containerEl.createEl('h3', { text: 'Identity' });
    new Setting(containerEl)
      .setName('Display name')
      .addText((t) =>
        t.setValue(this.plugin.settings.displayName).onChange(async (v) => {
          this.plugin.settings.displayName = v || 'Anonymous';
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Cursor color')
      .addText((t) =>
        t.setPlaceholder('#7c6af7').setValue(this.plugin.settings.cursorColor).onChange(async (v) => {
          this.plugin.settings.cursorColor = v || '#7c6af7';
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl('h3', { text: 'Shared workspace' });
    containerEl.createEl('p', {
      text:
        'All members must use the same Server URL, Server key and Workspace ID. The shared folder ' +
        'is local to this vault and may be named differently on each device. Toggle the plugin ' +
        'off and on after changing any of these to apply them.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('ws://host:4000')
      .addText((t) =>
        t.setValue(this.plugin.settings.share.serverUrl).onChange(async (v) => {
          this.plugin.settings.share.serverUrl = v.replace(/\/+$/, '');
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Server key')
      .setDesc('sk_... from SHADOWLINK_ADMIN_CREDS.txt')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setValue(this.plugin.settings.share.serverKey).onChange(async (v) => {
          this.plugin.settings.share.serverKey = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Workspace ID')
      .setDesc('Letters, digits, _ or - (max 64). Identical for all members.')
      .addText((t) =>
        t.setValue(this.plugin.settings.share.workspaceId).onChange(async (v) => {
          this.plugin.settings.share.workspaceId = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Shared folder')
      .setDesc('Vault-relative folder to sync, e.g. "Shared".')
      .addText((t) =>
        t.setValue(this.plugin.settings.share.sharedFolder).onChange(async (v) => {
          this.plugin.settings.share.sharedFolder = v.replace(/^\/+|\/+$/g, '');
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl('h3', { text: 'This device' });

    // Spec §2.5: the device-state file is named after this id and is trusted only
    // when it names this id back. Showing it is what makes
    // `state-<workspace>-<device>.json` in the plugin folder identifiable when
    // somebody is looking at a vault that several machines have written to.
    new Setting(containerEl)
      .setName('Device ID')
      .setDesc(
        'Generated once for this vault on this machine. ShadowLink ignores any device-state '
        + 'file that names a different one.',
      )
      .addText((t) => {
        t.setValue(this.plugin.settings.deviceId || '(not yet generated)');
        t.setDisabled(true);
      });

    new Setting(containerEl)
      .setName('Sync status')
      .setDesc(
        this.plugin.configured
          ? 'Configured. The status bar shows whether syncing is running or paused.'
          : 'Not configured yet — fill in every field above, then reload the plugin.',
      );
  }
}
