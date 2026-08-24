// src/ui/modals.ts
// The four decisions P1 is not allowed to take on the user's behalf.
//
// Every module that asks one of these questions already treats a MISSING answer
// as the safe one: `Bootstrap` stays read-only when the first sync is not
// confirmed, `Deletions` keeps the local copies when no dialog answers, the
// watcher restores a local bulk delete when the confirmation is declined, and an
// unanswered unshare is undone. So these modals do not have to be clever — they
// have to be HONEST. Every one of them resolves with the safe answer when it is
// dismissed, which means Escape, the close button, and a modal torn down with the
// workspace all mean the same thing as saying no.
//
// That is the whole reason `DecisionModal` exists rather than four ad-hoc
// promises: the settlement is written once, in `onClose`, where every exit path
// goes through it, instead of four times in four places where one of them would
// eventually be forgotten and leave a promise pending for ever — which, since
// `Deletions` awaits it, would hang the reconcile pass rather than fail safe.

import { App, Modal, Setting } from 'obsidian';

import type { BootstrapConfirmation, BootstrapDecision } from '../sync/Bootstrap.ts';
import type { BulkChoice, BulkSummary } from '../sync/Deletions.ts';

/** Longest list any of these dialogs renders inline before it summarizes. */
const MAX_LISTED = 8;

abstract class DecisionModal<T> extends Modal {
  /** Resolves exactly once, with the safe answer if the user never chose. */
  readonly answer: Promise<T>;

  private settle!: (value: T) => void;
  private answered = false;

  protected constructor(app: App, private readonly safeAnswer: T) {
    super(app);
    this.answer = new Promise<T>((resolve) => { this.settle = resolve; });
  }

  /** Open, and hand back the promise the caller awaits. */
  ask(): Promise<T> {
    this.open();
    return this.answer;
  }

  protected choose(value: T): void {
    if (this.answered) return;
    this.answered = true;
    this.settle(value);
    this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
    // Escape, the close button, and a workspace teardown all land here. Whatever
    // brought us here, the question has to stop being open.
    if (this.answered) return;
    this.answered = true;
    this.settle(this.safeAnswer);
  }

  /** A bulleted sample, with an honest "and N more" rather than a silent truncation. */
  protected listPaths(paths: readonly string[]): void {
    if (paths.length === 0) return;
    const list = this.contentEl.createEl('ul');
    for (const path of paths.slice(0, MAX_LISTED)) list.createEl('li', { text: path });
    if (paths.length > MAX_LISTED) {
      list.createEl('li', { text: `…and ${paths.length - MAX_LISTED} more` });
    }
  }
}

// ============================================================ §4.5 step 8

/**
 * The first-sync confirmation. Mandatory the first time a device sees a
 * workspace, and skipped afterwards unless there is something new to share.
 *
 * Dismissing it does NOT mean "start anyway with nothing shared": it means
 * cancel. `Bootstrap` treats a cancelled first sync as a read-only state that a
 * reconnect cannot lift, precisely so a network blip a minute later does not
 * quietly do the thing the user just declined.
 */
class FirstSyncModal extends DecisionModal<BootstrapDecision> {
  private shareLocalFiles = true;

  constructor(app: App, private readonly info: BootstrapConfirmation) {
    super(app, { proceed: false, shareLocalFiles: false });
  }

  override onOpen(): void {
    const { contentEl, titleEl, info } = this;
    titleEl.setText(info.firstSync ? 'ShadowLink — first sync' : 'ShadowLink — new local files');

    contentEl.createEl('p', {
      text: `Shared folder: ${info.shareRoot}`,
    });

    const summary = contentEl.createEl('ul');
    summary.createEl('li', {
      text: `${info.adopt.size} local file(s) already match this workspace and will be adopted.`,
    });
    summary.createEl('li', {
      text: `${info.download.size} file(s) will be downloaded from this workspace.`,
    });
    summary.createEl('li', {
      text: `${info.upload.length} local file(s) can be shared with this workspace.`,
    });
    if (info.pending.length > 0) {
      summary.createEl('li', {
        text: `${info.pending.length} file(s) are waiting for their author to upload them, `
          + 'and will not be created here yet.',
      });
    }

    if (info.upload.length > 0) {
      contentEl.createEl('p', { text: 'Local files that would be shared:' });
      this.listPaths(info.upload);

      new Setting(contentEl)
        .setName('Share my local files with this workspace')
        .setDesc('Uncheck to keep them on this device only. You can share them later.')
        .addToggle((t) => t.setValue(true).onChange((v) => { this.shareLocalFiles = v; }));
    }

    new Setting(contentEl)
      .addButton((b) => b
        .setButtonText('Cancel')
        .setCta()
        .onClick(() => { this.choose({ proceed: false, shareLocalFiles: false }); }))
      .addButton((b) => b
        .setButtonText('Start syncing')
        .onClick(() => {
          this.choose({ proceed: true, shareLocalFiles: this.shareLocalFiles });
        }));
  }
}

export function confirmFirstSync(
  app: App,
  info: BootstrapConfirmation,
): Promise<BootstrapDecision> {
  return new FirstSyncModal(app, info).ask();
}

// ============================================================ §5.4

/**
 * The aggregated remote-delete dialog. The default action is KEEP, and so is
 * every way of not answering.
 */
class BulkDeleteModal extends DecisionModal<BulkChoice> {
  constructor(app: App, private readonly summary: BulkSummary) {
    super(app, 'keep');
  }

  override onOpen(): void {
    const { contentEl, titleEl, summary } = this;
    titleEl.setText('ShadowLink — a lot of files were deleted');

    const who = summary.deletedBy.length > 0 ? summary.deletedBy.join(', ') : 'someone';
    contentEl.createEl('p', {
      text: `${summary.count} file(s) in the shared folder were deleted by ${who}. `
        + 'ShadowLink has not touched your copies yet.',
    });
    this.listPaths(summary.samplePaths);
    contentEl.createEl('p', {
      text: 'Deleting moves them to this vault\'s .trash, where Settings → Files → '
        + 'Deleted files can restore them.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((b) => b
        .setButtonText('Keep my copies')
        .setCta()
        .onClick(() => { this.choose('keep'); }))
      .addButton((b) => b
        .setButtonText('Delete them here too')
        .setWarning()
        .onClick(() => { this.choose('apply'); }));
  }
}

export function confirmBulkDelete(app: App, summary: BulkSummary): Promise<BulkChoice> {
  return new BulkDeleteModal(app, summary).ask();
}

// ============================================================ §4.1 step 5

/**
 * The LOCAL bulk-delete gate: a `git checkout`, a Syncthing conflict resolution
 * or a Dropbox mass delete arrives here as hundreds of `delete` events.
 *
 * The default action is CANCEL. Declining writes nothing to the tree, so the tree
 * still says the files should exist and the next reconcile puts them back — which
 * is the correct outcome for an external tool having removed them.
 */
class LocalBulkDeleteModal extends DecisionModal<boolean> {
  constructor(app: App, private readonly count: number) {
    super(app, false);
  }

  override onOpen(): void {
    const { contentEl, titleEl, count } = this;
    titleEl.setText('ShadowLink — delete these for everyone?');
    contentEl.createEl('p', {
      text: `${count} item(s) were just removed from the shared folder on this device. `
        + 'Should ShadowLink delete them for everyone in the workspace?',
    });
    contentEl.createEl('p', {
      text: 'If this was an external tool (a git checkout, a sync client), choose Cancel — '
        + 'ShadowLink will restore them here instead.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((b) => b
        .setButtonText('Cancel')
        .setCta()
        .onClick(() => { this.choose(false); }))
      .addButton((b) => b
        .setButtonText('Delete for everyone')
        .setWarning()
        .onClick(() => { this.choose(true); }));
  }
}

export function confirmLocalBulkDelete(app: App, count: number): Promise<boolean> {
  return new LocalBulkDeleteModal(app, count).ask();
}

// ============================================================ §5.5

/**
 * Dragging something OUT of the shared folder. The default action is UNDO: the
 * file comes back where it was, and nobody else loses anything.
 */
class UnshareModal extends DecisionModal<'unshare' | 'undo'> {
  constructor(app: App, private readonly rootPath: string, private readonly count: number) {
    super(app, 'undo');
  }

  override onOpen(): void {
    const { contentEl, titleEl, rootPath, count } = this;
    titleEl.setText('ShadowLink — stop sharing?');
    contentEl.createEl('p', {
      text: `"${rootPath}" was moved out of the shared folder`
        + (count > 1 ? `, along with ${count - 1} other item(s).` : '.'),
    });
    contentEl.createEl('p', {
      text: 'Stop sharing removes it for everyone in the workspace. '
        + 'Move it back keeps it shared and returns it to where it was.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((b) => b
        .setButtonText('Move it back')
        .setCta()
        .onClick(() => { this.choose('undo'); }))
      .addButton((b) => b
        .setButtonText('Stop sharing')
        .setWarning()
        .onClick(() => { this.choose('unshare'); }));
  }
}

export function confirmUnshare(
  app: App,
  rootPath: string,
  count: number,
): Promise<'unshare' | 'undo'> {
  return new UnshareModal(app, rootPath, count).ask();
}
