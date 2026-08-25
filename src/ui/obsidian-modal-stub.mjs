// src/ui/obsidian-modal-stub.mjs
// A runtime stand-in for the parts of `obsidian` that `modals.ts` uses, so the
// six dialogs can be tested at all.
//
// The published `obsidian` package is TYPES ONLY — its `main` is empty — so every
// module that imports it is unloadable outside the application. `src/testing/`
// already solves that for the three adapters; this is the same trick for a
// different set of runtime symbols, kept beside the module it serves rather than
// bolted onto that stub, so neither can break the other.
//
// WHAT THIS IS ALLOWED TO PROVE, and nothing wider:
//
//  * `Modal.close()` runs `onClose` (for `modals.ts`);
//  * `Setting`'s builders are chainable (for both callers);
//  * a text box's `onChange` fires when the USER types and not when
//    `setValue()` writes into it, and a disabled input fires nothing at all
//    (for `SettingsTab.ts`).
//
// All three are documented Obsidian/DOM behaviour, and they are the facts every
// answer in `modals.ts` and `SettingsTab.ts` rests on. It is deliberately NOT a
// DOM: `createEl` records a tag and a string and stops there, because a fake that
// tried to be a browser would start proving things about itself instead of about
// the code under test.
//
// Not shipped: `.mjs` is outside the plugin build (which starts at `main.ts`) and
// outside `banned-calls.test.ts`'s `.ts` scan.

/** `App` is imported as a value binding by `modals.ts` and used only as a type. */
export class App {}

/**
 * The recorded shape of one `createEl` call. Not an element — there is no tree to
 * lay out, only text a test needs to read back.
 */
class StubEl {
  constructor(tag) {
    this.tag = tag;
    this.text = '';
    this.cls = '';
    this.children = [];
    /** `Setting`s built against this container, in construction order. */
    this.settings = [];
  }

  createEl(tag, options = {}) {
    const child = new StubEl(tag);
    if (options.text !== undefined) child.text = String(options.text);
    if (options.cls !== undefined) child.cls = String(options.cls);
    this.children.push(child);
    return child;
  }

  setText(value) {
    this.text = String(value);
    return this;
  }

  empty() {
    this.children.length = 0;
    this.settings.length = 0;
  }
}

/**
 * The base every plugin settings pane extends.
 *
 * Obsidian builds one of these per plugin, hands it a container it has already
 * emptied of the previous pane, and calls `display()` each time the user opens
 * the tab — never in between. That "never in between" is behaviour a test needs
 * to be able to rely on, so nothing here calls `display()` on its own.
 */
export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = new StubEl('div');
  }

  display() {}

  hide() {}
}

export class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = new StubEl('div');
    this.titleEl = new StubEl('div');
    this.isOpen = false;
  }

  open() {
    this.isOpen = true;
    this.onOpen();
  }

  /** Obsidian runs `onClose` on every route out — the button, Escape, teardown. */
  close() {
    this.isOpen = false;
    this.onClose();
  }

  onOpen() {}

  onClose() {}
}

class StubToggle {
  constructor() {
    this.value = false;
    this.handler = null;
  }

  setValue(value) {
    this.value = value;
    return this;
  }

  onChange(handler) {
    this.handler = handler;
    return this;
  }

  /** Test-side: what a click on the toggle does. */
  toggle(value) {
    this.value = value;
    if (this.handler !== null) this.handler(value);
  }
}

/**
 * One text box.
 *
 * The split between `setValue` and `type` is the whole point of this class.
 * Obsidian's `TextComponent.setValue` writes straight into the input element, so
 * it does NOT fire `onChange`; only a real edit does. A stub that fired the
 * handler from `setValue` would make every `display()` look like the user had
 * just retyped all four share settings, and would hide the exact bug this is here
 * to catch.
 */
class StubText {
  constructor() {
    this.value = '';
    this.placeholder = '';
    this.handler = null;
    /**
     * Obsidian exposes the real `<input>`; `SettingsTab` reaches through to set
     * `.type = 'password'` on it, because there is no component method for that.
     */
    this.inputEl = { type: 'text', disabled: false };
  }

  get disabled() {
    return this.inputEl.disabled;
  }

  setValue(value) {
    this.value = String(value);
    return this;
  }

  setPlaceholder(value) {
    this.placeholder = String(value);
    return this;
  }

  setDisabled(disabled) {
    this.inputEl.disabled = disabled === true;
    return this;
  }

  onChange(handler) {
    this.handler = handler;
    return this;
  }

  /**
   * Test-side: what typing into the box does.
   *
   * Returns the handler's promise, because `SettingsTab`'s handlers are async and
   * every one of them awaits a save — a test that did not await would assert
   * against settings that had not been written yet.
   *
   * A disabled input fires no input event, so it runs no handler. That is the
   * browser's rule, not this stub's opinion.
   */
  type(value) {
    if (this.inputEl.disabled) return Promise.resolve();
    this.value = String(value);
    return Promise.resolve(this.handler === null ? undefined : this.handler(this.value));
  }
}

class StubButton {
  constructor() {
    this.text = '';
    this.cta = false;
    this.warning = false;
    this.handler = null;
  }

  setButtonText(text) {
    this.text = String(text);
    return this;
  }

  setCta() {
    this.cta = true;
    return this;
  }

  setWarning() {
    this.warning = true;
    return this;
  }

  onClick(handler) {
    this.handler = handler;
    return this;
  }

  /** Test-side: what a click does. */
  click() {
    if (this.handler !== null) this.handler();
  }
}

export class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.name = '';
    this.desc = '';
    this.toggles = [];
    this.buttons = [];
    this.texts = [];
    containerEl.settings.push(this);
  }

  setName(value) {
    this.name = String(value);
    return this;
  }

  setDesc(value) {
    this.desc = String(value);
    return this;
  }

  addText(build) {
    const text = new StubText();
    build(text);
    this.texts.push(text);
    return this;
  }

  addToggle(build) {
    const toggle = new StubToggle();
    build(toggle);
    this.toggles.push(toggle);
    return this;
  }

  addButton(build) {
    const button = new StubButton();
    build(button);
    this.buttons.push(button);
    return this;
  }
}
