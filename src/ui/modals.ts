// src/ui/modals.ts
// The five decisions P1 is not allowed to take on the user's behalf.
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
// That is the whole reason `DecisionModal` exists rather than five ad-hoc
// promises: the settlement is written once, in `onClose`, where every exit path
// goes through it, instead of five times in five places where one of them would
// eventually be forgotten and leave a promise pending for ever — which, since
// `Deletions` awaits it, would hang the reconcile pass rather than fail safe.
//
// The fifth dialog is the only one that is not a refusal to act: `KeptFilesModal`
// is where a decision taken by one of the other four is taken BACK, and its safe
// answer — share nothing — is the one that leaves everything exactly as the user
// last left it.

import { App, Modal, Setting } from 'obsidian';

import type { BootstrapConfirmation, BootstrapDecision } from '../sync/Bootstrap.ts';
import type { BulkChoice, BulkSummary } from '../sync/Deletions.ts';
import type { KeptEntry } from '../sync/KeptFiles.ts';

/** Longest list any of these dialogs renders inline before it summarizes. */
const MAX_LISTED = 8;

/**
 * Bytes as a size a human reads, for the dialogs that have to make "a lot"
 * concrete.
 *
 * "3 files" and "3 files (218 MB)" are different questions, and only the second
 * one can actually be answered.
 */
function sizeOf(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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

    // §7.5: counts AND byte totals, because "412 files" and "412 files, 3.1 GB"
    // are different decisions — and the second one is the one being asked for.
    const summary = contentEl.createEl('ul');
    summary.createEl('li', {
      text: `${info.adopt.size} local file(s) already match this workspace and will be adopted.`,
    });
    summary.createEl('li', {
      text: `${info.downloadNotes.count} note(s) will be downloaded from this workspace.`,
    });
    if (info.downloadNow.count > 0) {
      summary.createEl('li', {
        text: `${info.downloadNow.count} attachment(s) (${sizeOf(info.downloadNow.bytes)}) `
          + 'will be downloaded.',
      });
    }
    if (info.downloadDeferred.count > 0) {
      // §7.2's three refusals are one sentence on purpose. "Over the auto-fetch
      // ceiling", "past this session's budget" and "larger than this device can
      // hold" are one fact to the person reading this — the file will not arrive
      // yet — and the commands that fetch it are the same in all three cases.
      summary.createEl('li', {
        text: `${info.downloadDeferred.count} attachment(s) `
          + `(${sizeOf(info.downloadDeferred.bytes)}) will not be downloaded here yet. `
          + 'Use "ShadowLink: Download attachments" to fetch them.',
      });
    }
    summary.createEl('li', {
      text: `${info.uploadNotes.count} local note(s) can be shared with this workspace.`,
    });
    if (info.uploadAttachments.count > 0) {
      summary.createEl('li', {
        text: `${info.uploadAttachments.count} local attachment(s) `
          + `(${sizeOf(info.uploadAttachments.bytes)}) can be uploaded to this workspace.`,
      });
    }
    if (info.pending.length > 0) {
      summary.createEl('li', {
        text: `${info.pending.length} file(s) are waiting for their author to upload them, `
          + 'and will not be created here yet.',
      });
    }

    if (info.upload.length > 0) {
      contentEl.createEl('p', { text: 'Local files that would be shared:' });
      this.listPaths(info.upload);

      // The promise in the second sentence is only true because the command
      // exists, and it names the command so it can be acted on: an escape hatch
      // nobody can find is the same as no escape hatch (spec §5.4, risk R6).
      new Setting(contentEl)
        .setName('Share my local files with this workspace')
        .setDesc(
          'Uncheck to keep them on this device only. The command '
          + '"ShadowLink: Resolve kept files" lists them again and can share them later.',
        )
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
    // The size is named only when there is one: a batch of notes carries no bytes
    // in the tree, and "(0 KB)" would be a claim about the files rather than about
    // what this dialog actually knows.
    const how = summary.bytes > 0
      ? `${summary.count} file(s) (${sizeOf(summary.bytes)})`
      : `${summary.count} file(s)`;
    contentEl.createEl('p', {
      text: `${how} in the shared folder were deleted by ${who}. `
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

// ============================================================ §5.4 / R6

/**
 * The escape hatch: everything this device is refusing to share, with a checkbox
 * each.
 *
 * Nothing is pre-selected and dismissing shares nothing, because every entry here
 * is a file the user already chose to keep — the burden is on the new decision,
 * not on the old one. `KeptFiles.share` is what acts on the answer; this dialog
 * only collects it.
 */
class KeptFilesModal extends DecisionModal<KeptEntry[]> {
  private readonly selected = new Set<string>();

  constructor(app: App, private readonly entries: readonly KeptEntry[]) {
    super(app, []);
  }

  override onOpen(): void {
    const { contentEl, titleEl, entries } = this;
    titleEl.setText('ShadowLink — files you chose to keep');

    contentEl.createEl('p', {
      text: `${entries.length} item(s) on this device are deliberately not shared: `
        + 'local files you kept back on first sync, and files a peer deleted whose '
        + 'copies you kept. Tick the ones to share with the workspace now.',
    });

    for (const entry of entries) {
      new Setting(contentEl)
        .setName(entry.label)
        .setDesc(entry.detail)
        .addToggle((t) => t
          .setValue(false)
          .onChange((v) => {
            if (v) this.selected.add(entry.key);
            else this.selected.delete(entry.key);
          }));
    }

    new Setting(contentEl)
      .addButton((b) => b
        .setButtonText('Keep them all')
        .setCta()
        .onClick(() => { this.choose([]); }))
      .addButton((b) => b
        .setButtonText('Share these')
        .onClick(() => {
          this.choose(this.entries.filter((e) => this.selected.has(e.key)));
        }));
  }
}

export function chooseKeptFiles(
  app: App,
  entries: readonly KeptEntry[],
): Promise<KeptEntry[]> {
  return new KeptFilesModal(app, entries).ask();
}
