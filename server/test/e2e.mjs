// server/test/e2e.mjs
// End-to-end runtime proof for P0: boot the real server, connect two Yjs
// clients over real WebSockets speaking the standard y-protocols sync protocol,
// and assert they converge. Also assert a wrong SERVER_KEY is rejected.
//
// Run with: npm run test:e2e
// (Kept out of the default `npm test` glob because it spawns a server process.)

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;
const PORT = 4159;
const WORKSPACE = 'e2e';
const DOC_ID = 'bm90ZS5tZA'; // base64url("note.md")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`✗ E2E FAILED: ${msg}`);
  process.exitCode = 1;
}

// Minimal y-protocols client over a raw ws connection.
function connect(url, doc) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.on('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, doc);
    ws.send(encoding.toUint8Array(enc));
  });

  ws.on('message', (data) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(dec) !== MESSAGE_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(dec, enc, doc, ws); // origin = ws
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
  });

  // Send local edits (origin !== ws) to the server.
  doc.on('update', (update, origin) => {
    if (origin === ws) return; // applied from the socket — don't echo
    if (ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });

  return ws;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sl-e2e-'));
  const server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), PERSISTENCE_DIR: dir },
    stdio: 'ignore',
  });

  try {
    // Wait for the server to write its tokens file, then read the SERVER_KEY.
    const tokensPath = join(dir, 'tokens.json');
    for (let i = 0; i < 50 && !existsSync(tokensPath); i++) await sleep(100);
    if (!existsSync(tokensPath)) throw new Error('server did not start (no tokens.json)');
    await sleep(300);
    const { serverKey } = JSON.parse(readFileSync(tokensPath, 'utf8'));
    if (!serverKey) throw new Error('no serverKey in tokens.json');

    const base = `ws://localhost:${PORT}/${DOC_ID}?w=${WORKSPACE}`;

    // --- Test 1: wrong key is rejected ---
    const bad = new WebSocket(`${base}&t=sk_wrong`);
    const badResult = await new Promise((resolve) => {
      bad.on('open', () => resolve('opened'));
      bad.on('error', () => resolve('rejected'));
      bad.on('unexpected-response', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 2000);
    });
    try { bad.close(); } catch { /* ignore */ }
    if (badResult === 'opened') fail('wrong SERVER_KEY was accepted (should be rejected)');
    else console.log(`✓ wrong key rejected (${badResult})`);

    // --- Test 2: two valid clients converge ---
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const url = `${base}&t=${serverKey}`;
    const wsA = connect(url, docA);
    const wsB = connect(url, docB);

    // Wait for both sockets to be open + initial sync to settle.
    await new Promise((resolve) => {
      let open = 0;
      const done = () => { if (++open === 2) resolve(); };
      wsA.on('open', done);
      wsB.on('open', done);
      setTimeout(resolve, 3000);
    });
    await sleep(500);

    const TEXT = 'hello from client A';
    docA.getText('content').insert(0, TEXT);

    // Poll docB for convergence (up to ~4s).
    let converged = false;
    for (let i = 0; i < 40; i++) {
      if (docB.getText('content').toString() === TEXT) { converged = true; break; }
      await sleep(100);
    }
    if (converged) console.log(`✓ two clients converged: docB = "${docB.getText('content')}"`);
    else fail(`docB did not converge (got "${docB.getText('content').toString()}")`);

    // --- Test 3: bidirectional (B edits, A receives) ---
    docB.getText('content').insert(docB.getText('content').length, ' + B');
    const EXPECT = TEXT + ' + B';
    let conv2 = false;
    for (let i = 0; i < 40; i++) {
      if (docA.getText('content').toString() === EXPECT) { conv2 = true; break; }
      await sleep(100);
    }
    if (conv2) console.log(`✓ bidirectional converge: docA = "${docA.getText('content')}"`);
    else fail(`docA did not receive B's edit (got "${docA.getText('content').toString()}")`);

    try { wsA.close(); wsB.close(); } catch { /* ignore */ }
    await sleep(200);

    if (!process.exitCode) console.log('\n✓ E2E PASSED');
  } catch (e) {
    fail(e?.message ?? String(e));
  } finally {
    server.kill();
    await sleep(200);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main();
