// server/test/e2e-structural.mjs
// Group C of the P1 spec (§10, tests 61-79): structural convergence across REAL
// clients, over REAL WebSockets, against the REAL server process.
//
// Run with: node server/test/e2e-structural.mjs [--only=<substring>]
// Env: SL_E2E_SEEDS (default 20), SL_E2E_OPS (default 200), SL_E2E_PORT,
//      SL_E2E_DEAD_PORT.
//
// The suite drives the shipped `Bootstrap` / `VaultWatcher` / `Reconciler` /
// `Deletions` / `PublishQueue` against an in-memory vault per client (spec §4.0's
// `VaultPort` fake) and a real WebSocket `DocPort`. Because those modules are
// TypeScript, this entry point re-executes itself under
// `--experimental-transform-types` when it was not started with it, so
// `node server/test/e2e-structural.mjs` works with no flags and no npm script.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FLAG = '--experimental-transform-types';
const enabled = process.execArgv.some((a) => a.startsWith(FLAG))
  || (process.env.NODE_OPTIONS ?? '').includes(FLAG);

if (!enabled) {
  const result = spawnSync(
    process.execPath,
    [FLAG, '--no-warnings=ExperimentalWarning', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  // `process.exitCode`, never `process.exit()`: this module has a top-level
  // await in the other branch, so Node treats a synchronous exit during
  // evaluation as an unsettled top-level await and rewrites a 0 into a 13.
  process.exitCode = result.status ?? 1;
} else {
  // Dynamic, so the static `.ts` imports inside are never evaluated by a process
  // that cannot strip types.
  await import('./harness/suite.mjs');
}
