// src/sync/ObsidianDocPort.test.ts
//
// The adapter that talks to the network, against the REAL server process — the
// same one the structural end-to-end suite boots (`server/test/harness/server.mjs`).
//
// Until this file existed, `ObsidianDocPort` was referenced by nothing but a
// source-text lint guard: mutating `flush` to `return true` left 354 tests
// passing. That is the single most expensive function in the branch to get wrong.
// `flush`'s answer sets `s` on a node and `contentHash` on this device, both of
// which claim the WORKSPACE holds the content, and a node whose `s` is set is
// never offered for publication again by anybody (I17). A false confirmation is
// permanent content loss, not a retry.
//
// So the assertions here are about the two directions of that answer:
//
//  * TRUE means the server really has the bytes — proven by reading them back
//    through a second, independent client rather than by trusting the port;
//  * FALSE means anything else. Two of the tests take the connection away at the
//    moment it matters, through a TCP proxy that can hold the client's frames
//    and cut the socket on demand, so "the server never acknowledged this" is
//    produced rather than simulated.
//
// `openHeadless` is held to the same standard: a room that genuinely holds text,
// reached over a connection whose sync cannot complete, must report `synced:
// false` and hand back NOTHING. An unsynced document reads as empty when it is
// not, and seeding into that is what doubles a note on reconnect (I4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import * as Y from 'yjs';

import { ObsidianDocPort } from './ObsidianDocPort.ts';
import { startServer } from '../../server/test/harness/server.mjs';
import { DocLink } from '../../server/test/harness/net.mjs';

// ---------------------------------------------------------------- fixtures

const WORKSPACE = 'wsdocport';

/** The server accepts `_tree` and `n_` plus 22 characters (spec test 78). */
function room(seed: string): string {
  return `n_${seed}${'0'.repeat(22 - seed.length)}`;
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createTcpServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const found = (probe.address() as AddressInfo).port;
      probe.close(() => { resolve(found); });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/**
 * A TCP proxy that can stop forwarding the CLIENT's bytes, and cut the link.
 *
 * `holdAfterChunks` is what makes "connected but never synced" reproducible: the
 * first chunk is the HTTP upgrade request, so forwarding exactly one chunk gets a
 * real WebSocket established and then silently swallows every frame the client
 * sends afterwards — including its SyncStep1. The server answers nothing, because
 * it was never asked.
 */
interface Proxy {
  port: number;
  /** Forward this many client chunks per connection, then buffer the rest. */
  holdAfterChunks: number;
  cut(): void;
  close(): Promise<void>;
}

async function startProxy(targetPort: number): Promise<Proxy> {
  const live = new Set<Socket>();
  let server: Server;

  const proxy: Proxy = {
    port: 0,
    holdAfterChunks: Number.POSITIVE_INFINITY,
    cut(): void {
      for (const socket of [...live]) socket.destroy();
      live.clear();
    },
    close(): Promise<void> {
      proxy.cut();
      return new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };

  server = createTcpServer((client) => {
    const upstream = tcpConnect(targetPort, '127.0.0.1');
    live.add(client);
    live.add(upstream);
    let chunks = 0;

    client.on('data', (data) => {
      chunks += 1;
      if (chunks <= proxy.holdAfterChunks) upstream.write(data);
      // else: swallowed. The server cannot answer what it never received.
    });
    upstream.on('data', (data) => { client.write(data); });

    const bye = (): void => {
      live.delete(client);
      live.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on('error', bye);
      socket.on('close', bye);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { resolve(); });
  });
  proxy.port = (server.address() as AddressInfo).port;
  return proxy;
}

// ---------------------------------------------------------------- the suite

/**
 * The server and its proxy, booted once for the whole file.
 *
 * Lazily rather than in a `before` hook, and torn down by the last test rather
 * than an `after` one, because the pinned `@types/node` predates both — and the
 * branch's rules put `package.json` out of scope. Tests in one file run in order,
 * which is all this needs.
 */
interface Fixture {
  server: Awaited<ReturnType<typeof startServer>>;
  proxy: Proxy;
}

let fixture: Promise<Fixture> | null = null;

function ready(): Promise<Fixture> {
  if (fixture === null) {
    fixture = (async (): Promise<Fixture> => {
      const server = await startServer({ port: await freePort() });
      const proxy = await startProxy(server.port);
      return { server, proxy };
    })();
  }
  return fixture;
}

function portTo(
  fx: Fixture,
  tcpPort: number,
  over: { syncTimeoutMs?: number; flushTimeoutMs?: number } = {},
): ObsidianDocPort {
  return new ObsidianDocPort({
    serverUrl: `ws://127.0.0.1:${tcpPort}`,
    serverKey: fx.server.serverKey,
    workspaceId: WORKSPACE,
    syncTimeoutMs: over.syncTimeoutMs ?? 4_000,
    flushTimeoutMs: over.flushTimeoutMs ?? 6_000,
  });
}

/** Read a room through a second, independent client. Never through the port. */
async function textOnServer(fx: Fixture, name: string): Promise<string> {
  const doc = new Y.Doc();
  const link = new DocLink(fx.server.url(name, WORKSPACE), doc);
  link.connect();
  const synced = await link.waitSync(4_000);
  const text = doc.getText('content').toString();
  link.destroy();
  assert.equal(synced, true, `the verifying client could not sync ${name}`);
  return text;
}

// -------------------------------------------------------------- true

test('flush returns true only once the server really holds the bytes', async () => {
  const fx = await ready();
  const name = room('conf');
  const port = portTo(fx, fx.server.port);
  try {
    const opened = await port.openHeadless(name);
    assert.equal(opened.synced, true, 'a live server syncs');
    assert.equal(opened.text, '', 'a fresh room is empty');
    assert.equal(await port.insertIfEmpty(opened.handle, 'the published bytes'), true);

    assert.equal(await port.flush(opened.handle), true, 'the round trip completed');

    // The whole meaning of that `true`, checked independently of the port.
    assert.equal(await textOnServer(fx, name), 'the published bytes');

    // I5: a second seed into a non-empty document is refused.
    assert.equal(await port.insertIfEmpty(opened.handle, 'again'), false);
    port.close(opened.handle);
    assert.equal(await port.flush(opened.handle), false, 'a released handle confirms nothing');
  } finally {
    port.destroy();
  }
});

test('a reopened room hands back the text the server holds', async () => {
  const fx = await ready();
  const name = room('reop');
  const writer = portTo(fx, fx.server.port);
  try {
    const opened = await writer.openHeadless(name);
    await writer.insertIfEmpty(opened.handle, 'written once');
    assert.equal(await writer.flush(opened.handle), true);
  } finally {
    writer.destroy();
  }

  const reader = portTo(fx, fx.server.port);
  try {
    const reopened = await reader.openHeadless(name);
    assert.equal(reopened.synced, true);
    assert.equal(reopened.text, 'written once');
  } finally {
    reader.destroy();
  }
});

// -------------------------------------------------------------- false

test('flush returns false when the server is gone', async () => {
  // Its own server, so killing it cannot disturb the rest of the suite.
  const doomed = await startServer({ port: await freePort() });
  const port = new ObsidianDocPort({
    serverUrl: `ws://127.0.0.1:${doomed.port}`,
    serverKey: doomed.serverKey,
    workspaceId: WORKSPACE,
    syncTimeoutMs: 4_000,
    flushTimeoutMs: 2_000,
  });
  try {
    const opened = await port.openHeadless(room('dead'));
    assert.equal(opened.synced, true, 'it was alive a moment ago');

    await doomed.stop();
    await sleep(250);                       // let the close reach this process

    await port.insertIfEmpty(opened.handle, 'nobody will ever see this');
    assert.equal(await port.flush(opened.handle), false, 'there is nothing to acknowledge it');
  } finally {
    port.destroy();
    doomed.cleanup();
  }
});

test('flush returns false when the socket is cut mid-flush', async () => {
  const fx = await ready();
  const name = room('cut');
  // A long deadline: the point is that the CLOSE ends the flush, not the clock.
  const port = portTo(fx, fx.proxy.port, { flushTimeoutMs: 20_000 });
  try {
    const opened = await port.openHeadless(name);
    assert.equal(opened.synced, true, 'the proxy passes everything until told not to');

    // From here the server hears nothing this client says.
    fx.proxy.holdAfterChunks = 0;
    await port.insertIfEmpty(opened.handle, 'bytes that never arrive');

    const started = Date.now();
    const pending = port.flush(opened.handle);
    await sleep(300);
    fx.proxy.cut();

    assert.equal(await pending, false, 'a cut connection acknowledged nothing');
    assert.ok(Date.now() - started < 10_000, 'and it was the cut that ended the wait');

    // The server never received the update, which is exactly what `false` said.
    fx.proxy.holdAfterChunks = Number.POSITIVE_INFINITY;
    assert.equal(await textOnServer(fx, name), '');
  } finally {
    port.destroy();
    fx.proxy.holdAfterChunks = Number.POSITIVE_INFINITY;
  }
});

// -------------------------------------------------------------- I4

test('openHeadless reports synced:false and withholds the text on a timeout', async () => {
  const fx = await ready();
  const name = room('held');

  // The room genuinely holds text, so an empty answer below is a withholding
  // rather than a coincidence.
  const seeder = portTo(fx, fx.server.port);
  try {
    const opened = await seeder.openHeadless(name);
    await seeder.insertIfEmpty(opened.handle, 'content the client cannot see');
    assert.equal(await seeder.flush(opened.handle), true);
  } finally {
    seeder.destroy();
  }
  assert.equal(await textOnServer(fx, name), 'content the client cannot see');

  // Connected, but every frame after the upgrade is swallowed: the client's
  // SyncStep1 never arrives, so no SyncStep2 ever comes back.
  fx.proxy.holdAfterChunks = 1;
  const blind = portTo(fx, fx.proxy.port, { syncTimeoutMs: 800 });
  try {
    const opened = await blind.openHeadless(name);
    assert.equal(opened.synced, false, 'a timeout is not a sync (I3/I4)');
    assert.equal(opened.text, '', 'and an unproven document is handed back empty');
    // A handle is still returned: branching on `synced` is the CALLER's job.
    assert.notEqual(opened.handle, undefined);
    assert.equal(await blind.flush(opened.handle), false, 'nor can it confirm anything');
  } finally {
    blind.destroy();
    fx.proxy.holdAfterChunks = Number.POSITIVE_INFINITY;
    fx.proxy.cut();
  }
});

test('openHeadless reports synced:false when nothing is listening at all', async () => {
  const fx = await ready();
  const nowhere = new ObsidianDocPort({
    serverUrl: `ws://127.0.0.1:${await freePort()}`,
    serverKey: fx.server.serverKey,
    workspaceId: WORKSPACE,
    syncTimeoutMs: 600,
    flushTimeoutMs: 600,
  });
  try {
    const opened = await nowhere.openHeadless(room('none'));
    assert.equal(opened.synced, false);
    assert.equal(opened.text, '');
    assert.equal(await nowhere.flush(opened.handle), false);
  } finally {
    nowhere.destroy();
  }
});

// -------------------------------------------------------------- pooling

test('rooms are pooled per name and released with the last handle', async () => {
  const fx = await ready();
  const name = room('pool');
  const port = portTo(fx, fx.server.port);
  try {
    const first = await port.openHeadless(name);
    const second = await port.openHeadless(name);
    assert.equal(await port.insertIfEmpty(first.handle, 'shared connection'), true);
    // The second handle sees the first handle's write, so both are one document.
    assert.equal(await port.insertIfEmpty(second.handle, 'other'), false);
    assert.equal(await port.flush(second.handle), true);

    port.close(first.handle);
    assert.equal(await port.flush(second.handle), true, 'the connection outlived one handle');

    port.close(second.handle);
    port.close(second.handle);              // idempotent
    assert.equal(await port.flush(second.handle), false, 'and is gone with the last');
  } finally {
    port.destroy();
  }
});

// ---------------------------------------------------------------- teardown

test('the server and its proxy are released', async () => {
  const fx = await ready();
  await fx.proxy.close();
  await fx.server.stop();
  fx.server.cleanup();
});
