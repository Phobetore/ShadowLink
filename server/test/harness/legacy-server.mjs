// server/test/harness/legacy-server.mjs
//
// ⚠ A SERVER FROM BEFORE P3, run as a real process so the client's fallback is
// exercised against a server that GENUINELY LACKS the endpoint rather than
// against a flag (spec §9 slice 2's definition of done).
//
// This is `server/index.js` at commit fd06a1b — the last commit before any of
// the mux work — verbatim, with only the import paths moved. It is checked in
// rather than read out of git history so it runs in a shallow CI clone, and it
// imports today's `DocHub.js`, `auth.js`, `config.js` and `blobStore.js`
// because the P3 server delta is exactly one thing: the `/_mux` branch in the
// upgrade handler below. `DocHub.js` is byte-pinned, so it IS the old one; the
// only other change since fd06a1b was naming two id predicates in
// `upgradeAuth.js`, which alters no behaviour.
//
// WHAT IT DOES WITH A MUX CLIENT, measured before the detector was written:
// it ACCEPTS `ws://…/_mux?t=…&w=…` — `_mux` matches its own `DOC_RE`, so the
// upgrade is authorised and DocHub serves the socket as an ordinary room
// literally named `_mux` — then writes a raw y-websocket SyncStep1 of
// [0x00, 0x00, 0x01, 0x00] and ignores every mux frame it is sent, forever,
// with the socket still open. That is why detection cannot be "the dial
// failed", and why it is that first message instead.
//
// ⚠ Regenerating it: `git show fd06a1b:server/index.js`, then re-point the six
// relative imports at `../../`. Nothing else may be edited — a doctored copy
// would prove nothing.
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../../config.js';
import { Auth } from '../../auth.js';
import { DocHub } from '../../DocHub.js';
import { authorizeUpgrade } from '../../upgradeAuth.js';
import { BlobStore } from '../../blobStore.js';
import { createBlobRoutes } from '../../blobRoutes.js';

const config = loadConfig();
mkdirSync(config.persistenceDir, { recursive: true });

const auth = new Auth(config.persistenceDir);
await auth.bootstrap(`ws://0.0.0.0:${config.port}`);

console.log('\n========================================');
console.log('  SHADOWLINK SERVER (P0 — text sync)');
console.log('========================================');
console.log(`  Port:       ${config.port}`);
console.log(`  Creds file: ${config.persistenceDir}/SHADOWLINK_ADMIN_CREDS.txt`);
console.log('========================================\n');

const docHub = new DocHub(config.persistenceDir);

// The content-addressed attachment store (spec §6). It shares this process and
// this port with the relay, and nothing else: `DocHub` gains no new callers.
const blobStore = new BlobStore(config.persistenceDir, {
  maxFileBytes: config.maxFileSizeMb * 1024 * 1024,
  maxTotalBytes: config.maxTotalStorageGb * 1024 * 1024 * 1024,
  incompleteUploadTtlHours: config.incompleteUploadTtlHours,
});
await blobStore.start();

const blobRoutes = createBlobRoutes({
  store: blobStore,
  isValidKey: (key) => auth.validateServerKey(key),
  maxConcurrency: config.maxBlobConcurrency,
});

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
  } else if (!blobRoutes.handle(req, res)) {
    res.writeHead(404).end();
  }
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const result = authorizeUpgrade(req.url, (key) => auth.validateServerKey(key));
  if (!result.ok) {
    socket.write(`HTTP/1.1 ${result.code} Unauthorized\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    docHub.handleConnection(ws, result.docName);
  });
});

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

// Snapshots are written on a trailing debounce (DocHub, spec §1.5), so an
// orderly shutdown must write the tail of the window before the process goes.
// Synchronous — and still temp-file-then-rename, so an interrupted shutdown
// cannot leave a truncated snapshot behind either.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      docHub.flushAllSync();
    } catch (err) {
      console.error('[shutdown] snapshot flush failed', err);
    }
    // A partial upload needs nothing written on the way out: it is already on
    // disk, keyed by its content hash, and resumes from a HEAD ?partial=1.
    blobStore.stop();
    process.exit(0);
  });
}

httpServer.listen(config.port, () => {
  console.log(`ShadowLink server listening on ws://0.0.0.0:${config.port}`);
});
