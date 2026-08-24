// src/testing/obsidian-stub.mjs
// A runtime stand-in for the `obsidian` module, for the three adapter tests.
//
// The published `obsidian` package is TYPES ONLY — its `main` is empty — so any
// module that imports it is unloadable outside the application. That is why the
// three adapters had no behavioural tests at all, and why mutating
// `ObsidianDocPort.flush` to a constant left the whole suite green.
//
// What is stubbed here is exactly what the adapters use at RUNTIME, and nothing
// more: `normalizePath`, and the `TFolder` / `TFile` classes they test with
// `instanceof`. Everything else an adapter touches (a `Vault`, a `DataAdapter`, a
// `Workspace`) is supplied by the test as a plain object, so the stub cannot
// drift into being a second, wrong implementation of Obsidian.
//
// `normalizePath` mirrors the real one's observable behaviour: NFC, backslashes
// to forward slashes, collapsed and trimmed separators, and '/' for an empty
// result.
//
// Not shipped: `.mjs` is outside the plugin build (which starts at `main.ts`) and
// outside `banned-calls.test.ts`'s `.ts` scan.

export function normalizePath(path) {
  const normalized = String(path)
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return normalized === '' ? '/' : normalized;
}

/** The base of Obsidian's file hierarchy. `instanceof` on it decides file vs folder. */
export class TAbstractFile {
  constructor(path = '') {
    this.path = path;
    this.name = path.slice(path.lastIndexOf('/') + 1);
  }
}

export class TFile extends TAbstractFile {}

export class TFolder extends TAbstractFile {
  constructor(path = '', children = []) {
    super(path);
    this.children = children;
  }
}
