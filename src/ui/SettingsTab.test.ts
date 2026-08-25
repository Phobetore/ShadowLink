// src/ui/SettingsTab.test.ts
// The four strings everyone in a share must type identically, and what this
// screen does when one of them is typed wrong.
//
// `SettingsTab.ts` had no test file at all, and that is a blind spot rather than
// a coverage gap: every field here is written to `data.json` on the keystroke,
// three of the four are handed verbatim to a server that validates them and
// refuses, and one of them becomes a FILENAME under `.obsidian/plugins/`.
// Between the keyboard and all of that there is a `.trim()` and two slash
// strippers. Several tests below exist to say exactly that — "nothing checks
// this" is a fact worth pinning, because the day somebody adds a check, one of
// these should fail and make them say so.
//
// The stub beside this file is the one `modals.test.ts` already uses, widened by
// one component. It proves three documented facts and no more: `Setting`'s
// builders chain, `TextComponent.setValue` does NOT fire `onChange` (only a real
// edit does), and a disabled input fires nothing at all. Everything else asserted
// here is `SettingsTab.ts`'s own code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';

// The real key function, not a copy of it: one of the assertions below is about
// what a workspace id becomes on disk, and a locally retyped `state-${id}-…`
// would keep agreeing with itself long after the two drifted apart.
import { DeviceState, deviceStateKey } from '../sync/DeviceState.ts';
import type { StatePort } from '../sync/DeviceState.ts';
import { DEFAULT_SETTINGS } from '../types.ts';
import type { ShadowLinkSettings, ShareConfig } from '../types.ts';

/**
 * `module.register()`, reached through a cast for the same reason as in
 * `modals.test.ts`: the pinned `@types/node` predates it, and it needs no
 * command-line flag, which is what lets the client suite stay plain `node --test`.
 */
const register = (nodeModule as unknown as {
  register: (specifier: string, parentURL: string) => void;
}).register;

/** Lazy and memoized — `target: ES6` forbids top-level await. */
let loaded: Promise<typeof import('./SettingsTab.ts')> | null = null;

function settingsTab(): Promise<typeof import('./SettingsTab.ts')> {
  if (loaded === null) {
    register('./obsidian-modal-loader.mjs', import.meta.url);
    loaded = import('./SettingsTab.ts');
  }
  return loaded;
}

// ---------------------------------------------------------------- reading back

/** The stub's text box. `type()` is a real edit; `setValue()` is not. */
interface StubText {
  value: string;
  placeholder: string;
  disabled: boolean;
  inputEl: { type: string; disabled: boolean };
  handler: ((value: string) => unknown) | null;
  type(value: string): Promise<unknown>;
}

interface StubSetting {
  name: string;
  desc: string;
  texts: StubText[];
}

interface StubEl {
  tag: string;
  text: string;
  cls: string;
  children: StubEl[];
  settings: StubSetting[];
}

interface Tab {
  containerEl: StubEl;
  display(): void;
}

/**
 * Everything this screen SAYS: headings, paragraphs, field names, descriptions
 * and placeholders.
 *
 * Deliberately not the boxes' values. A field's own value is the thing the user
 * typed into it and belongs there; prose is where a secret would leak, and
 * keeping the two apart is what makes the server-key test below mean something.
 */
function prose(el: StubEl): string {
  const parts = [el.text];
  for (const child of el.children) parts.push(prose(child));
  for (const setting of el.settings) {
    parts.push(setting.name, setting.desc);
    for (const box of setting.texts) parts.push(box.placeholder);
  }
  return parts.join('\n');
}

function field(tab: Tab, name: string): StubSetting {
  const hit = tab.containerEl.settings.find((s) => s.name === name);
  assert.notEqual(hit, undefined, `no setting named "${name}"`);
  return hit!;
}

function box(tab: Tab, name: string): StubText {
  const texts = field(tab, name).texts;
  assert.equal(texts.length, 1, `"${name}" has exactly one text box`);
  return texts[0]!;
}

// ---------------------------------------------------------------- the plugin

/**
 * As much of `ShadowLinkPlugin` as the tab touches: a settings object, a save,
 * and one derived boolean.
 */
interface FakePlugin {
  settings: ShadowLinkSettings;
  /** One deep copy per `saveSettings()` — what `data.json` would hold at that moment. */
  saves: ShadowLinkSettings[];
  saveSettings(): Promise<void>;
  readonly configured: boolean;
}

function fakePlugin(
  share: Partial<ShareConfig> = {},
  over: Partial<ShadowLinkSettings> = {},
): FakePlugin {
  const settings: ShadowLinkSettings = {
    ...DEFAULT_SETTINGS,
    ...over,
    share: { ...DEFAULT_SETTINGS.share, ...share },
  };
  const saves: ShadowLinkSettings[] = [];
  return {
    settings,
    saves,
    saveSettings(): Promise<void> {
      // `main.ts` hands the whole object to `saveData`. A deep copy is what lets
      // a test say what reached the disk on THAT keystroke rather than what the
      // live object happens to hold by the end.
      saves.push(JSON.parse(JSON.stringify(settings)) as ShadowLinkSettings);
      return Promise.resolve();
    },
    // Mirrors `ShadowLinkPlugin.configured`: four non-empty strings, nothing
    // else. The tab only reads it, so where it is computed is not this file's to
    // police — but it has to be genuinely derived, or the staleness test below
    // would be asserting against its own fixture.
    get configured(): boolean {
      const s = settings.share;
      return s.serverUrl !== '' && s.serverKey !== ''
        && s.workspaceId !== '' && s.sharedFolder !== '';
    },
  };
}

/** A share that is complete and valid, for tests about what happens after that. */
const GOOD: Partial<ShareConfig> = {
  serverUrl: 'ws://host:4000',
  serverKey: 'sk_key',
  workspaceId: 'alpha',
  sharedFolder: 'Shared',
};

const DEVICE = 'ab12cd34ef567890';

/**
 * Enough of a `StatePort` to construct a `DeviceState`. It is never read from or
 * written to: the only test that builds one asks what filename that instance
 * settled on, which its constructor decides before any I/O.
 */
function nullStatePort(): StatePort {
  return {
    read: () => Promise.resolve(null),
    write: () => Promise.resolve(),
  };
}

async function open(plugin: FakePlugin): Promise<Tab> {
  const { SettingsTab } = await settingsTab();
  const tab = new SettingsTab({} as never, plugin as never) as unknown as Tab;
  tab.display();
  return tab;
}

// ---------------------------------------------------------------- the shape

test('the screen offers exactly the settings the rest of the plugin reads', async () => {
  const tab = await open(fakePlugin(GOOD, { deviceId: DEVICE }));

  assert.deepEqual(tab.containerEl.settings.map((s) => s.name), [
    'Display name', 'Cursor color',
    'Server URL', 'Server key', 'Workspace ID', 'Shared folder',
    'Device ID', 'Sync status',
  ]);
});

// Nothing on this screen restarts anything, so the sentence that says so is the
// only thing standing between a user and four fields that appear to do nothing.
test('the tab says how a change is applied, because nothing here applies one', async () => {
  const tab = await open(fakePlugin());
  const text = prose(tab.containerEl);

  assert.match(text, /same Server URL, Server key and Workspace ID/);
  assert.match(text, /Toggle the plugin off and on/);
});

test('reopening the tab rebuilds it rather than stacking a second copy', async () => {
  const plugin = fakePlugin(GOOD, { deviceId: DEVICE });
  const tab = await open(plugin);
  const before = tab.containerEl.settings.length;

  await box(tab, 'Server URL').type('ws://other:4000');
  tab.display();                            // Obsidian calls this on every open

  assert.equal(tab.containerEl.settings.length, before, 'no duplicated fields');
  assert.equal(box(tab, 'Server URL').value, 'ws://other:4000', 'and it shows what was saved');
});

// ---------------------------------------------------------------- saving

test('every edit is written to disk immediately — there is no Save button', async () => {
  const plugin = fakePlugin();
  const tab = await open(plugin);
  const url = box(tab, 'Server URL');

  await url.type('ws://ho');                // a keystroke, not a finished thought
  await url.type('ws://host:4000');

  assert.equal(plugin.saves.length, 2, 'one save per edit');
  assert.equal(plugin.saves[0]!.share.serverUrl, 'ws://ho',
    'a half-typed URL is what the next launch would load');
  assert.equal(plugin.settings.share.serverUrl, 'ws://host:4000');
});

/**
 * Every editable field, the value used to exercise it, and where that value has
 * to turn up in what was saved.
 *
 * One test per row rather than one test over the table, because the failure this
 * guards is per-handler: each `onChange` ends in its own
 * `await this.plugin.saveSettings()`, and a missing one is invisible from every
 * other field.
 */
const PERSISTED: ReadonlyArray<{
  field: string;
  typed: string;
  read: (s: ShadowLinkSettings) => string;
}> = [
  { field: 'Display name', typed: 'Ann', read: (s) => s.displayName },
  { field: 'Cursor color', typed: '#00ff00', read: (s) => s.cursorColor },
  { field: 'Server URL', typed: 'ws://host:4000', read: (s) => s.share.serverUrl },
  { field: 'Server key', typed: 'sk_key', read: (s) => s.share.serverKey },
  { field: 'Workspace ID', typed: 'team-alpha', read: (s) => s.share.workspaceId },
  { field: 'Shared folder', typed: 'Shared', read: (s) => s.share.sharedFolder },
];

// ⚠ WHY THIS IS SIX TESTS AND NOT AN ASSERTION ON THE LIVE OBJECT.
//
// The tab writes THROUGH `plugin.settings`, which is the same object a running
// session captured, so an edit takes effect immediately whether or not it is ever
// saved. Drop the `saveSettings()` from one handler and nothing on screen and
// nothing in the session changes: the field accepts the value, the status line
// agrees, syncing follows it. The value is simply not in `data.json`, so the next
// launch loads the previous one — and for the Workspace ID that means silently
// reconnecting to the workspace the user just moved away from.
//
// So each of these asserts the SAVED copy, not the live one. `saveSettings` in
// the fake deep-copies, which is what makes "reached the disk on this keystroke"
// distinguishable from "is in the object by now".
for (const { field: name, typed, read } of PERSISTED) {
  test(`"${name}" reaches data.json and not only the live settings object`, async () => {
    const plugin = fakePlugin();
    const tab = await open(plugin);

    await box(tab, name).type(typed);

    assert.equal(read(plugin.settings), typed, 'the live object took the edit');
    assert.equal(plugin.saves.length, 1, 'and exactly one save carried it out of memory');
    assert.equal(read(plugin.saves[0]!), typed, 'which is what the next launch would load');
  });
}

// Two fields rewrite what was typed before saving it. Both are helpful; both are
// silent; and for one input both erase the field entirely, which is how a share
// can become "not configured" from a single keystroke.
test('the URL and the folder are rewritten on the way to disk, sometimes to nothing', async () => {
  const plugin = fakePlugin();
  const tab = await open(plugin);
  const url = box(tab, 'Server URL');
  const folder = box(tab, 'Shared folder');

  await url.type('ws://host:4000/');
  assert.equal(plugin.settings.share.serverUrl, 'ws://host:4000');
  await url.type('ws://host:4000///');
  assert.equal(plugin.settings.share.serverUrl, 'ws://host:4000');

  await folder.type('/Shared/');
  assert.equal(plugin.settings.share.sharedFolder, 'Shared');
  await folder.type('///Notes/Shared///');
  assert.equal(plugin.settings.share.sharedFolder, 'Notes/Shared', 'inner slashes are kept');

  // ⚠ A lone slash in either field is stripped down to the empty string, and an
  // empty string is exactly what `configured` tests for. Typing "/" into the
  // shared folder does not select the vault root; it silently unconfigures the
  // plugin, and the screen says nothing.
  await folder.type('/');
  assert.equal(plugin.settings.share.sharedFolder, '');
  await url.type('/');
  assert.equal(plugin.settings.share.serverUrl, '');
  assert.equal(plugin.configured, false);
});

// ---------------------------------------------------------------- no validation

test('nothing checks the Server URL: scheme, host and path are stored as typed', async () => {
  const plugin = fakePlugin();
  const tab = await open(plugin);
  const url = box(tab, 'Server URL');

  for (const typed of ['http://host:4000', 'https://host', 'ws://host:4000/tree', 'nonsense', ' ']) {
    await url.type(typed);
    assert.equal(plugin.settings.share.serverUrl, typed, `"${typed}" was stored as typed`);
  }

  // The description is a hint, not a rule, and no other line contradicts it.
  assert.equal(field(tab, 'Server URL').desc, 'ws://host:4000');
  assert.doesNotMatch(prose(tab.containerEl), /invalid|must start with|not a valid/i);
});

// ⚠ THE ONE FIELD WITH A WRITTEN RULE AND NO ENFORCEMENT OF IT.
//
// The description states the charset. `src/types.ts` states it again on
// `ShareConfig.workspaceId`. `server/upgradeAuth.js` states it a third time as
// `ID_RE = /^[A-Za-z0-9_-]{1,64}$/` and refuses the upgrade with a 400 when it
// does not hold — and says why in a comment: the ids are "charset-validated so
// they are safe to use as snapshot filenames". The client uses the very same id
// as a filename and validates nothing.
test('the Workspace ID is trimmed and nothing more, including the charset it advertises',
  async () => {
    const plugin = fakePlugin();
    const tab = await open(plugin);
    const ws = box(tab, 'Workspace ID');

    assert.match(field(tab, 'Workspace ID').desc, /Letters, digits, _ or - \(max 64\)/);

    await ws.type('  team-alpha  ');
    assert.equal(plugin.settings.share.workspaceId, 'team-alpha', 'surrounding space comes off');

    for (const typed of ['team alpha', 'team/alpha', '../../elsewhere', 'x'.repeat(65)]) {
      await ws.type(typed);
      assert.equal(plugin.settings.share.workspaceId, typed,
        'stored despite the rule three files agree on');
    }
  });

test('an unchecked Workspace ID reaches both a socket that refuses it and a filename',
  async () => {
    const plugin = fakePlugin({}, { deviceId: DEVICE });
    const tab = await open(plugin);

    await box(tab, 'Server URL').type('ws://host:4000');
    await box(tab, 'Server key').type('sk_key');
    await box(tab, 'Shared folder').type('Shared');
    await box(tab, 'Workspace ID').type('../../../elsewhere');

    // The share now looks complete, so `main.ts` builds a runtime and opens the
    // sockets — at a server whose `authorizeUpgrade` answers 400 for this id,
    // which surfaces on no screen the user can see.
    assert.equal(plugin.configured, true);

    // And before any of that fails, the device-state filename leaves the plugin's
    // own directory. `ObsidianStatePort` joins this onto
    // `.obsidian/plugins/shadowlink/` with `normalizePath`, which tidies slashes
    // and does not resolve `..`.
    assert.equal(
      deviceStateKey(plugin.settings.share.workspaceId, plugin.settings.deviceId),
      `state-../../../elsewhere-${DEVICE}.json`,
    );
  });

test('a Workspace ID the server can never accept is not what gets persisted', {
  // DEFECT, unfixed. `SettingsTab.ts` stores `v.trim()` with no charset check,
  // so an id the server refuses and a path that escapes the plugin folder are
  // both one keystroke away. The rule itself is unambiguous — three files state
  // the same regex — but the REMEDY is not: refusing the keystroke, refusing the
  // save, or showing an error are three different screens, and picking one is a
  // design decision rather than a patch. Left for whoever owns that call.
  skip: 'defect: no charset check on Workspace ID — see the comment on this test',
}, async () => {
  const plugin = fakePlugin({ workspaceId: 'alpha' });
  const tab = await open(plugin);

  await box(tab, 'Workspace ID').type('team/alpha');

  assert.notEqual(plugin.settings.share.workspaceId, 'team/alpha');
});

// ---------------------------------------------------------------- the secret

test('the server key is masked on screen and plaintext in what is saved', async () => {
  const plugin = fakePlugin();
  const tab = await open(plugin);
  const key = box(tab, 'Server key');

  assert.equal(key.inputEl.type, 'password', 'the box does not show the key on screen');

  await key.type('  sk_live_swordfish  ');
  assert.equal(plugin.settings.share.serverKey, 'sk_live_swordfish', 'stored trimmed');

  // ⚠ Masking is a display choice, not protection. `saveSettings` hands this
  // straight to `saveData`, so `data.json` holds the key in the clear inside
  // `.obsidian/` — the directory other sync tools replicate. True of every
  // Obsidian plugin secret; worth knowing when reading the field's asterisks.
  const last = plugin.saves[plugin.saves.length - 1]!;
  assert.equal(last.share.serverKey, 'sk_live_swordfish');
});

// The regression this guards: a later "Currently: sk_…", a status line that
// echoes the whole share config, or a second field pre-filled from the key. All
// three would defeat the password box without touching it.
test('the server key appears in no label, description or other field', async () => {
  const plugin = fakePlugin(
    { ...GOOD, serverKey: 'sk_live_swordfish' },
    { deviceId: DEVICE },
  );
  const tab = await open(plugin);

  assert.doesNotMatch(prose(tab.containerEl), /swordfish/,
    'not in any prose the tab renders');

  const holding = tab.containerEl.settings
    .reduce<StubText[]>((all, s) => all.concat(s.texts), [])
    .filter((t) => t.value.indexOf('swordfish') !== -1);
  assert.equal(holding.length, 1, 'exactly one box holds it');
  assert.equal(holding[0]!.inputEl.type, 'password', 'and that box is the masked one');
});

// ---------------------------------------------------------------- this device

test('the Device ID is shown, not editable, and its placeholder is never persisted',
  async () => {
    const plugin = fakePlugin();              // deviceId '', as before it is minted
    const tab = await open(plugin);
    const id = box(tab, 'Device ID');

    assert.equal(id.value, '(not yet generated)');
    assert.equal(id.disabled, true);
    assert.equal(id.handler, null, 'no onChange at all, so nothing can be written back');

    // ⚠ The displayed string is a stand-in, not a value. If it ever reached
    // `settings.deviceId` the device-state file would be named after it and every
    // vault on earth would agree on the same device identity.
    await id.type('deadbeefdeadbeef');
    assert.equal(plugin.settings.deviceId, '', 'the field cannot mint or change an id');
    assert.equal(plugin.saves.length, 0, 'and it saves nothing');
  });

// ---------------------------------------------------------------- status line

// ⚠ The one line on this screen that reports state is computed inside
// `display()`, from `plugin.configured`, and `display()` runs only when the tab
// is opened. So it is read at exactly the moment it cannot be right yet, and it
// stays wrong for the whole visit in which the user does the thing that changes
// it.
test('the Sync status line still says "not configured" after the last field is typed',
  async () => {
    const plugin = fakePlugin();
    const tab = await open(plugin);

    assert.match(field(tab, 'Sync status').desc, /Not configured yet/);

    await box(tab, 'Server URL').type('ws://host:4000');
    await box(tab, 'Server key').type('sk_key');
    await box(tab, 'Workspace ID').type('team');
    await box(tab, 'Shared folder').type('Shared');

    assert.equal(plugin.configured, true, 'the share IS configured now');
    assert.match(field(tab, 'Sync status').desc, /Not configured yet/,
      'and the only line that could say so still says the opposite');

    tab.display();                            // reopening the tab is the remedy
    assert.match(field(tab, 'Sync status').desc, /^Configured\./);
  });

test('the Sync status line agrees with the fields the user has just filled in', {
  // DEFECT, unfixed. The line above is stale for the entire visit in which it
  // matters most — a first-time self-hoster fills in all four fields and is told
  // to "fill in every field above". Re-rendering from `onChange` is the obvious
  // fix and is wrong: `display()` calls `containerEl.empty()`, so re-running it
  // per keystroke destroys the input the user is typing into and takes the caret
  // with it. A real fix updates that one `Setting` in place, which is a change to
  // how this screen is built rather than a line edit.
  skip: 'defect: the status line is computed once per display() — see the comment',
}, async () => {
  const plugin = fakePlugin();
  const tab = await open(plugin);

  await box(tab, 'Server URL').type('ws://host:4000');
  await box(tab, 'Server key').type('sk_key');
  await box(tab, 'Workspace ID').type('team');
  await box(tab, 'Shared folder').type('Shared');

  assert.match(field(tab, 'Sync status').desc, /^Configured\./);
});

// ---------------------------------------------------------------- identity

test('an emptied name or colour is saved as the default, though the box looks empty',
  async () => {
    const plugin = fakePlugin({}, { displayName: 'Ann', cursorColor: '#ff0000' });
    const tab = await open(plugin);

    await box(tab, 'Display name').type('');
    await box(tab, 'Cursor color').type('');

    assert.equal(plugin.settings.displayName, 'Anonymous');
    assert.equal(plugin.settings.cursorColor, '#7c6af7');
    // The box and the file disagree until the tab is reopened. Harmless, and
    // surprising enough to be worth writing down.
    assert.equal(box(tab, 'Display name').value, '');
    assert.equal(box(tab, 'Cursor color').value, '');
  });

test('the cursor colour is not checked for being a colour', async () => {
  const plugin = fakePlugin();
  const tab = await open(plugin);

  await box(tab, 'Cursor color').type('rebeccapurple');

  // ⚠ `WorkspaceSession` publishes the selection tint as `${cursorColor}33`, an
  // eight-digit hex. Anything that is not a six-digit hex reaches every peer as
  // `rebeccapurple33`, which is not a colour, and their selection highlight for
  // this user disappears. The placeholder is the only thing suggesting hex.
  assert.equal(plugin.settings.cursorColor, 'rebeccapurple');
  assert.equal(box(tab, 'Cursor color').placeholder, '#7c6af7');
});

// ---------------------------------------------------------------- live session

// `SyncRuntime`'s constructor does `const share = plugin.settings.share` and
// holds that reference for the whole session. This screen writes THROUGH it.
test('editing a share field changes the object a running session is already holding',
  async () => {
    const plugin = fakePlugin(GOOD, { deviceId: DEVICE });
    const live = plugin.settings.share;             // what the runtime captured
    const tab = await open(plugin);

    await box(tab, 'Workspace ID').type('beta');
    await box(tab, 'Shared folder').type('Elsewhere');

    assert.equal(live.workspaceId, 'beta', 'the running session sees it immediately');
    assert.equal(live.sharedFolder, 'Elsewhere');
  });

// The other half of the same fact, and the reason the pair is worth stating.
//
// Writing through the live object is only half of what a running session does
// with a share field. Every one of them is also captured BY VALUE at construction
// — `new DeviceState(port, deviceId, share.workspaceId)`, `w: share.workspaceId`
// on each provider, the same on both HTTP ports — and `DeviceState` then fixes
// `key` in its constructor from what it was handed. So one edit puts the session
// in two states at once: it reads the NEW id out of `settings.share` and it goes
// on reading and writing the OLD id's files and rooms.
//
// This is asserted against the real `DeviceState`, constructed exactly as
// `main.ts` constructs it, because a hand-written "the key is fixed" fixture would
// agree with itself no matter what the class did.
test('a mid-session Workspace ID edit does not move the state file that session is writing',
  async () => {
    const plugin = fakePlugin(GOOD, { deviceId: DEVICE });
    // main.ts:271, verbatim: the id goes in by value, once.
    const state = new DeviceState(nullStatePort(), DEVICE, plugin.settings.share.workspaceId);
    const tab = await open(plugin);

    await box(tab, 'Workspace ID').type('beta');

    assert.equal(plugin.settings.share.workspaceId, 'beta', 'the edit landed and was saved');
    assert.equal(state.key, deviceStateKey('alpha', DEVICE),
      'while the session goes on reading and writing the state file it opened with');
    assert.notEqual(state.key, deviceStateKey('beta', DEVICE));
  });

// ⚠ DEFECT, real, and NOT fixable from this file.
//
// One share field escapes the by-value capture above: `main.ts`'s
// `writeSnapshot()` re-reads `this.plugin.settings.share.workspaceId` on every
// run. So the divergence the two tests above describe is not symmetric — after
// this edit the session talks to `alpha` on every socket and writes `alpha`'s
// state file, but the next tree change writes `tree-beta.bin` holding `alpha`'s
// tree. Nothing guards that file by content: `DeviceState` discards a state file
// naming another workspace, while the snapshot is trusted purely by filename and
// `Bootstrap` applies it into the document before connecting. Reload onto `beta`
// and `alpha`'s whole tree merges into it and is pushed up.
//
// It is deliberately NOT a skipped test here. A skipped test is a claim that this
// file could make it pass, and it cannot: both remedies — capturing the snapshot
// key at construction like every other share field, or not writing a live
// workspace id through to a running session at all — are edits to `main.ts`.
