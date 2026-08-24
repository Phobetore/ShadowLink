// server/test/harness/server.mjs
// Boot and tear down the REAL server process for the structural end-to-end
// suite. Everything the suite asserts travels over a real WebSocket into
// `server/index.js`, so nothing here may stub any part of it.

import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './net.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

function health(port) {
  return new Promise((res) => {
    const req = get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, (r) => {
      r.resume();
      res(r.statusCode === 200);
    });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}

/**
 * Start `server/index.js` on `port`, persisting into `dir` (a fresh temp
 * directory unless one is supplied, so a restart can reuse the same snapshots).
 */
export async function startServer({ port, dir = null }) {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'sl-e2es-'));
  const proc = spawn(process.execPath, [join(REPO_ROOT, 'server', 'index.js')], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), PERSISTENCE_DIR: dataDir },
    stdio: 'ignore',
  });
  proc.on('error', () => { /* surfaced by the health poll below */ });

  const tokensPath = join(dataDir, 'tokens.json');
  for (let i = 0; i < 120 && !existsSync(tokensPath); i++) await sleep(100);
  if (!existsSync(tokensPath)) {
    proc.kill();
    throw new Error(`server did not start on port ${port} (no tokens.json)`);
  }
  const { serverKey } = JSON.parse(readFileSync(tokensPath, 'utf8'));
  if (!serverKey) throw new Error('no serverKey in tokens.json');

  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    up = await health(port);
    if (!up) await sleep(50);
  }
  if (!up) {
    proc.kill();
    throw new Error(`server on port ${port} never answered /health`);
  }

  return {
    port,
    dir: dataDir,
    serverKey,
    proc,
    snapshotDir: join(dataDir, 'yjs'),
    url(room, workspace) {
      return `ws://127.0.0.1:${port}/${room}?t=${serverKey}&w=${workspace}`;
    },
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise((res) => proc.once('exit', res));
        proc.kill();
        await Promise.race([exited, sleep(2000)]);
      }
    },
    cleanup() {
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
