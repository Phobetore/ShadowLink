// src/ui/modals.test.ts
// The six dialogs, and the one promise all of them make.
//
// `modals.ts` had no test file at all, because it imports `obsidian` and the
// published package is types only. That silence was not free: `DecisionModal`'s
// `onClose` settlement is the mechanism that makes `super(app, 'keep')`,
// `super(app, false)` and `super(app, 'undo')` mean anything, and `Deletions`
// AWAITS one of those promises — so a modal that failed to settle would not lose a
// dialog, it would hang the reconcile pass. Nothing checked that it settles.
//
// The stub beside this file is deliberately narrow. It proves exactly two facts,
// both documented Obsidian behaviour: `Modal.close()` runs `onClose`, and
// `Setting`'s builders are chainable. Everything else these tests assert is
// `modals.ts`'s own code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';

import type { BootstrapConfirmation } from '../sync/Bootstrap.ts';
import type { BulkSummary } from '../sync/Deletions.ts';
import type { KeptEntry } from '../sync/KeptFiles.ts';
import type { DeferredAttachment } from '../sync/Reconciler.ts';

/**
 * `module.register()`, reached through a cast: the pinned `@types/node` predates
 * it, and `package.json` is out of scope here. It needs no command-line flag,
 * which is what lets the client suite stay plain `node --test`.
 */
const register = (nodeModule as unknown as {
  register: (specifier: string, parentURL: string) => void;
}).register;

/**
 * Load the dialogs with `obsidian` pointed at the stub.
 *
 * Memoized and lazy — not top-level — because `target: ES6` in `tsconfig.json`
 * forbids top-level await.
 */
let loaded: Promise<typeof import('./modals.ts')> | null = null;

function modals(): Promise<typeof import('./modals.ts')> {
  if (loaded === null) {
    register('./obsidian-modal-loader.mjs', import.meta.url);
    loaded = import('./modals.ts');
  }
  return loaded;
}

// ---------------------------------------------------------------- reading back

/** The stub's recorded element: a tag, a string, children, and `Setting`s. */
interface StubEl {
  tag: string;
  text: string;
  cls: string;
  children: StubEl[];
  settings: StubSetting[];
}

interface StubSetting {
  name: string;
  desc: string;
  toggles: { value: boolean; toggle(v: boolean): void }[];
  buttons: { text: string; cta: boolean; warning: boolean; click(): void }[];
}

interface StubModal {
  contentEl: StubEl;
  titleEl: StubEl;
  open(): void;
  close(): void;
}

/** Every string the dialog rendered, flattened — labels and descriptions included. */
function allText(el: StubEl): string {
  const parts = [el.text];
  for (const child of el.children) parts.push(allText(child));
  for (const setting of el.settings) parts.push(setting.name, setting.desc);
  return parts.join('\n');
}

function buttons(el: StubEl): StubSetting['buttons'] {
  const out: StubSetting['buttons'] = [];
  for (const setting of el.settings) out.push(...setting.buttons);
  for (const child of el.children) out.push(...buttons(child));
  return out;
}

function press(modal: StubModal, label: string): void {
  const hit = buttons(modal.contentEl).find((b) => b.text === label);
  assert.notEqual(hit, undefined, `no button labelled "${label}"`);
  hit!.click();
}

/**
 * Everything an `ask()` returns, plus the modal itself.
 *
 * `ask()` opens the dialog and hands back the promise, so the object under test is
 * the one the production caller holds — this only reaches around it far enough to
 * press a button.
 */
function shown<T>(open: () => Promise<T>): { answer: Promise<T>; modal: StubModal } {
  const before = OPENED.length;
  const answer = open();
  const made = OPENED.slice(before);
  assert.equal(made.length, 1, 'exactly one modal was opened');
  return { answer, modal: made[0]! };
}

/**
 * Modals are constructed inside the exported helpers, so nothing outside holds a
 * reference to them. Recording every `open()` on the stub's prototype is how a
 * test reaches the instance the helper made, without `modals.ts` growing a seam
 * that exists only for tests.
 */
const OPENED: StubModal[] = [];

let patched = false;

async function install(): Promise<typeof import('./modals.ts')> {
  const mod = await modals();
  if (!patched) {
    patched = true;
    const obsidian = await import('obsidian') as unknown as {
      Modal: { prototype: { open(): void } };
    };
    const original = obsidian.Modal.prototype.open;
    obsidian.Modal.prototype.open = function open(this: StubModal): void {
      OPENED.push(this);
      original.call(this);
    };
  }
  return mod;
}

// ---------------------------------------------------------------- fixtures

const SUMMARY: BulkSummary = {
  count: 12,
  bytes: 3 * 1024 * 1024,
  deletedBy: ['Ann'],
  samplePaths: ['Shared/a.md', 'Shared/b.md'],
};

const KEPT: KeptEntry[] = [
  {
    key: 'k1',
    label: 'Shared/notes.md',
    detail: 'kept on first sync',
    path: 'Shared/notes.md',
    paths: ['shared/notes.md'],
    nodes: [],
  },
];

const ATTACHMENTS: DeferredAttachment[] = [
  { id: 'n1', path: 'Shared/report.pdf', sha256: 'a'.repeat(64), bytes: 8 * 1024 * 1024 },
];

function confirmation(over: Partial<BootstrapConfirmation> = {}): BootstrapConfirmation {
  return {
    shareRoot: 'Shared',
    firstSync: true,
    adopt: new Map(),
    download: new Map(),
    upload: [],
    pending: [],
    downloadNotes: { count: 0, bytes: 0 },
    downloadNow: { count: 0, bytes: 0 },
    downloadDeferred: { count: 0, bytes: 0 },
    uploadNotes: { count: 0, bytes: 0 },
    uploadAttachments: { count: 0, bytes: 0 },
    ...over,
  };
}

// ---------------------------------------------------- the settlement, per dialog

// ⚠ The whole reason `DecisionModal` exists rather than five ad-hoc promises: the
// settlement is written ONCE, in `onClose`, where Escape, the close button and a
// workspace teardown all land. `Deletions` awaits one of these, so a promise that
// never settled would not lose a dialog — it would hang the reconcile pass.
test('every dialog dismissed without an answer settles on its safe answer', async () => {
  const m = await install();
  const app = {} as never;

  const cases: { name: string; open: () => Promise<unknown>; safe: unknown }[] = [
    { name: 'first sync', open: () => m.confirmFirstSync(app, confirmation()),
      safe: { proceed: false, shareLocalFiles: false } },
    { name: 'bulk delete', open: () => m.confirmBulkDelete(app, SUMMARY), safe: 'keep' },
    { name: 'local bulk delete', open: () => m.confirmLocalBulkDelete(app, 40), safe: false },
    { name: 'unshare', open: () => m.confirmUnshare(app, 'Shared/img', 3), safe: 'undo' },
    { name: 'kept files', open: () => m.chooseKeptFiles(app, KEPT), safe: [] },
    { name: 'attachments', open: () => m.chooseAttachments(app, ATTACHMENTS), safe: [] },
    { name: 'attachment folder', open: () => m.warnAttachmentFolder(app, 'Shared', ''),
      safe: 'later' },
  ];

  for (const c of cases) {
    const { answer, modal } = shown(c.open);
    modal.close();                                   // Escape, the X, a teardown
    assert.deepEqual(await answer, c.safe, `${c.name} did not settle safely`);
  }
});

// A promise that settles twice is a promise that settles wrongly the second time.
// `choose` closes the modal, which re-enters `onClose` — the guard there is the
// only thing between a chosen answer and the safe one overwriting it.
test('choosing wins, and the close it triggers cannot overwrite the choice', async () => {
  const m = await install();
  const { answer, modal } = shown(() => m.confirmBulkDelete({} as never, SUMMARY));

  press(modal, 'Delete them here too');
  modal.close();                                     // a second route out, after the fact

  assert.equal(await answer, 'apply');
});

// The safe answer is not merely "some answer": for each of the destructive
// dialogs it is the one that leaves the user's files exactly as they were.
test('the safe answer of every destructive dialog is the one that changes nothing', async () => {
  const m = await install();
  const app = {} as never;

  const keep = shown(() => m.confirmBulkDelete(app, SUMMARY));
  keep.modal.close();
  assert.equal(await keep.answer, 'keep', 'a remote bulk delete keeps the local copies');

  const local = shown(() => m.confirmLocalBulkDelete(app, 40));
  local.modal.close();
  assert.equal(await local.answer, false, 'a local bulk delete is not published for everyone');

  const unshare = shown(() => m.confirmUnshare(app, 'Shared/img', 1));
  unshare.modal.close();
  assert.equal(await unshare.answer, 'undo', 'a drag out of the share is put back');
});

// R6's escape hatch: nothing is pre-selected, so "Share these" with no toggle
// touched shares nothing — the burden is on the new decision, not the old one.
test('the kept-files dialog shares nothing until something is ticked', async () => {
  const m = await install();
  const { answer, modal } = shown(() => m.chooseKeptFiles({} as never, KEPT));

  press(modal, 'Share these');

  assert.deepEqual(await answer, []);
});

test('a ticked kept file is the one that comes back, and only that one', async () => {
  const m = await install();
  const { answer, modal } = shown(() => m.chooseKeptFiles({} as never, KEPT));

  modal.contentEl.settings.flatMap((s) => s.toggles).forEach((t) => { t.toggle(true); });
  press(modal, 'Share these');

  assert.deepEqual(await answer, KEPT);
});

// ---------------------------------------------------------------- §7.5 wording

// ⚠ The promise this dialog was making that the device could not keep. §7.2's
// three refusals are one COUNT here on purpose — `Bootstrap.classify` buckets them
// together and "it will not arrive yet" is one fact to the reader — but the REMEDY
// is not one thing. The download command tests the memory cap before it consults
// an approval, so for an oversized file it does nothing however many times it is
// pressed, and it used to answer "every attachment in this workspace is already
// downloaded" about a file that is not on the disk. Two shipped surfaces, and the
// user following the wrong one.
test('the first-sync modal does not promise the download command can fetch every refusal',
  async () => {
    const m = await install();
    const { answer, modal } = shown(() => m.confirmFirstSync(
      {} as never,
      confirmation({ downloadDeferred: { count: 3, bytes: 900 * 1024 * 1024 } }),
    ));
    const text = allText(modal.contentEl);

    assert.match(text, /3 attachment\(s\)/, 'the count is still shown');
    assert.match(text, /Download attachments/, 'and the command is still named');
    assert.doesNotMatch(
      text, /Download attachments" to fetch them/,
      'but not as a promise that it fetches all three',
    );
    assert.match(
      text, /status bar/,
      'the surface that CAN describe an oversized attachment is named instead',
    );

    modal.close();
    await answer;
  });

test('a first sync with nothing held back says nothing about held-back attachments',
  async () => {
    const m = await install();
    const { answer, modal } = shown(() => m.confirmFirstSync({} as never, confirmation()));

    assert.doesNotMatch(allText(modal.contentEl), /will not be downloaded here yet/);

    modal.close();
    await answer;
  });
