// main.ts
//
// P1c NOTE: the P0 editing session was wired straight from here, with rooms
// derived from the note's PATH. Spec §6.3 abandons that scheme outright and
// there is no migration, so leaving the old wiring in place would have the
// plugin talk to rooms nothing else in P1 uses. The session now needs the full
// port stack (VaultPort, DocPort, StatePort, TreeDoc, DeviceState, Bootstrap),
// which is P1c Task 4's job — `src/sync/ObsidianVaultPort.ts`,
// `ObsidianDocPort.ts`, `ObsidianStatePort.ts` plus the wiring described in the
// P1c plan. Until that lands the plugin loads its settings and nothing else.
import { Plugin } from 'obsidian';
import { SettingsTab } from './src/ui/SettingsTab';
import { DEFAULT_SETTINGS, ShadowLinkSettings } from './src/types';

export default class ShadowLinkPlugin extends Plugin {
  settings: ShadowLinkSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.share = Object.assign({}, DEFAULT_SETTINGS.share, this.settings.share);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
