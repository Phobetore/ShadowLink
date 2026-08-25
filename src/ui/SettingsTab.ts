// src/ui/SettingsTab.ts
import { App, PluginSettingTab, Setting } from 'obsidian';
import type ShadowLinkPlugin from '../../main';
import { isValidWorkspaceId } from '../tree/ids.ts';

/** The rule, in the field's own words. Also the "nothing is wrong" state of the line. */
const WORKSPACE_ID_DESC = 'Letters, digits, _ or - (max 64). Identical for all members.';

/**
 * What the field says the moment something the rule refuses is typed.
 *
 * "Not saved" is the whole message. The box goes on showing what was typed — that
 * is the browser's doing, not this screen's — so without a line saying otherwise
 * the user has every reason to believe the ID took.
 */
const WORKSPACE_ID_REJECTED =
  'Not saved. A workspace ID may only contain letters, digits, _ or -, and at most 64 '
  + 'of them. The server refuses any other ID, and this ID also names files in this vault.';

/**
 * And what it says when the ID ALREADY in `data.json` breaks the rule — hand
 * edited, or written by a build that did not check.
 *
 * Nothing was typed, so nothing was rejected; what the user needs told is why a
 * share that looks completely filled in never connects. Without this line that
 * question has no answer anywhere on screen: the failure is a 400 at the socket
 * upgrade, and the status bar simply stays on "starting…".
 */
const WORKSPACE_ID_STORED_BAD =
  'This ID cannot work: letters, digits, _ or - only, at most 64 of them. The server '
  + 'refuses it, so nothing will sync until it is corrected.';

/** Empty is "not filled in yet" (what `configured` reads), never an error. */
function describeWorkspaceId(id: string): string {
  return id === '' || isValidWorkspaceId(id) ? WORKSPACE_ID_DESC : WORKSPACE_ID_STORED_BAD;
}

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

    // The ID is checked HERE, at the keystroke, and an ID that fails is not
    // persisted. Everything downstream of this field is too late to be the place a
    // user finds out: `configured` would already read the share as complete, so
    // `main.ts` starts a session, the sockets open, and the server's 400 at the
    // upgrade reaches no screen at all — the status bar just stays on "starting…".
    // Before even that, the ID has become `state-<id>-<device>.json` and
    // `tree-<id>.bin` inside the plugin's own directory.
    const workspaceId = new Setting(containerEl).setName('Workspace ID');
    workspaceId
      .setDesc(describeWorkspaceId(this.plugin.settings.share.workspaceId))
      .addText((t) =>
        t.setValue(this.plugin.settings.share.workspaceId).onChange(async (v) => {
          const id = v.trim();
          if (id !== '' && !isValidWorkspaceId(id)) {
            // Contained: say so, change nothing. The last usable ID stays both in
            // memory and on disk, so a stray keystroke cannot unconfigure a share.
            workspaceId.setDesc(WORKSPACE_ID_REJECTED);
            return;
          }
          workspaceId.setDesc(WORKSPACE_ID_DESC);
          this.plugin.settings.share.workspaceId = id;
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
