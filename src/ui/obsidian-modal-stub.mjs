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
// WHAT THIS IS ALLOWED TO PROVE, and nothing wider: that `Modal.close()` runs
// `onClose`, and that `Setting`'s builders are chainable. Both are documented
// Obsidian behaviour, and they are the two facts every safe answer in `modals.ts`
// rests on. It is deliberately NOT a DOM: `createEl` records a tag and a string
// and stops there, because a fake that tried to be a browser would start proving
// things about itself instead of about the dialogs.
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
