// src/ui/obsidian-modal-loader.mjs
// A module-resolution hook that points the bare specifier `obsidian` at the modal
// stub beside this file.
//
// Registered from `modals.test.ts` with `module.register()`, which needs no
// command-line flag — the client suite runs as plain `node --test` and
// `package.json` is not this change's to touch. Only `resolve` is overridden, so
// `modals.ts` and everything it imports still travel the default `load` path and
// are type-stripped exactly as they would be otherwise.
//
// `node --test` gives each test file its own process, so this redirection cannot
// reach any other test.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const STUB = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'obsidian-modal-stub.mjs'),
).href;

export function resolve(specifier, context, next) {
  if (specifier === 'obsidian') return { url: STUB, shortCircuit: true, format: 'module' };
  return next(specifier, context);
}
