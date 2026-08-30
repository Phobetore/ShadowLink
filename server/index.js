// server/index.js
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { Auth } from './auth.js';
import { DocHub } from './DocHub.js';
import { authorizeUpgrade } from './upgradeAuth.js';
import { attachMux, MUX_DOC_ID } from './mux.js';
import { BlobStore } from './blobStore.js';
import { createBlobRoutes } from './blobRoutes.js';

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
    // P3 spec §4. `_mux` already matches the upgrade's `DOC_RE`, so this route is
    // purely additive: it needs no grammar change, and a client that has not been
    // upgraded takes the branch below and cannot tell the difference. The socket
    // is authenticated exactly once, here, by the check every other socket faces,
    // and `result.workspaceId` is the only workspace its frames can ever reach.
    if (result.docId === MUX_DOC_ID) {
      attachMux(ws, { hub: docHub, workspaceId: result.workspaceId });
      return;
    }
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
