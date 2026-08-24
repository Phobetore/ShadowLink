// src/testing/obsidian-loader.mjs
// A module-resolution hook that points the bare specifier `obsidian` at the stub
// beside this file.
//
// Registered from a test with `module.register()`, which needs no command-line
// flag — the client suite runs as plain `node --test`, and `package.json` is not
// this branch's to change. Only `resolve` is overridden, so every other module
// (the adapters' own `.ts` files included) still travels the default `load` path
// and is type-stripped exactly as it would be otherwise.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const STUB = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'obsidian-stub.mjs'),
).href;

export function resolve(specifier, context, next) {
  if (specifier === 'obsidian') return { url: STUB, shortCircuit: true, format: 'module' };
  return next(specifier, context);
}
