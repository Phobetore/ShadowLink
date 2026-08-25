// server/test/harness/blobs.mjs
// Spec §11 Group C1–C7 and C10 — the blob transport against the REAL server
// process, over real HTTP, on the same port the WebSocket relay rides.
//
// `server/test/blobRoutes.test.js` covers every status code in process, where the
// limits can be set to numbers a test can reach. What is proved HERE is the part
// that only the real process can prove: that `server/index.js` dispatches the
// routes ahead of its 404, that a resume survives a restart, that the `.part`
// sweep runs on boot, that usage.json is exactly right after a concurrent
// finalisation, and — C10, the reason the concurrency cap exists at all — that a
// saturated store does not stall the relay.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';

import { test, assert } from './runner.mjs';
import { startServer, REPO_ROOT } from './server.mjs';
import { DocLink, sleep } from './net.mjs';
import { ObsidianBlobPort } from '../../../src/sync/ObsidianBlobPort.ts';
import {
  BlobTooLarge, BlobTransport, BlobUnavailable,
} from '../../../src/sync/BlobPort.ts';

const WS = 'blobs';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function bytes(n, seed = 7) {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

/** One HTTP round trip against a running server. `key: null` sends no header. */
function call(server, { method = 'GET', path, headers = {}, body, key }) {
  return new Promise((resolve, reject) => {
    const merged = { ...headers };
    const token = key === undefined ? server.serverKey : key;
    if (token !== null) merged.authorization = `Bearer ${token}`;
    if (body !== undefined) merged['content-length'] = String(body.length);

    const req = httpRequest({
      host: '127.0.0.1', port: server.port, path, method, headers: merged, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const CHUNK = 4 * 1024 * 1024;                       // BLOB_CHUNK_BYTES

async function upload(server, ws, hash, buf, chunkBytes = CHUNK) {
  let offset = 0;
  let last = null;
  while (offset < buf.length) {
    const end = Math.min(offset + chunkBytes, buf.length);
    last = await call(server, {
      method: 'PATCH',
      path: `/blob/${ws}/${hash}`,
      headers: { 'content-range': `bytes ${offset}-${end - 1}/${buf.length}` },
      body: buf.subarray(offset, end),
    });
    if (last.status >= 400) return last;
    offset = end;
  }
  return last;
}

/** A PATCH that is still in flight when it resolves. `finish()` completes it. */
function slowPatch(server, ws, hash, buf) {
  let settle;
  const done = new Promise((r) => { settle = r; });
  const req = httpRequest({
    host: '127.0.0.1', port: server.port, path: `/blob/${ws}/${hash}`, method: 'PATCH',
    agent: false,
    headers: {
      authorization: `Bearer ${server.serverKey}`,
      'content-range': `bytes 0-${buf.length - 1}/${buf.length}`,
      'content-length': String(buf.length),
    },
  }, (res) => { res.resume(); res.on('end', () => settle(res.statusCode)); });
  req.on('error', () => settle(0));
  req.write(buf.subarray(0, 1));
  return { done, finish() { req.end(buf.subarray(1)); } };
}

/** Poll a file until it parses to the expected shape, or give up and return it. */
async function waitForJson(path, matches, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(readFileSync(path, 'utf8'));
      if (matches(last)) return last;
    } catch { /* mid-rename, or not written yet */ }
    await sleep(25);
  }
  return last;
}

/**
 * @param {() => object} getServer the suite's shared server, started in `main()`.
 * @param {number} basePort ports for the cases that need their own configuration.
 */
export function registerBlobCases(getServer, basePort) {
  // ------------------------------------------------------------------ C1

  test('C1 a 12 MB object PATCHes in 4 MB chunks and HEADs and GETs back byte-identical', async () => {
    const server = getServer();
    const buf = bytes(12 * 1024 * 1024, 17);
    const hash = sha256(buf);

    const cold = await call(server, { method: 'HEAD', path: `/blob/${WS}/${hash}` });
    assert.equal(cold.status, 404, 'the store does not hold it yet');

    const done = await upload(server, WS, hash, buf);
    assert.equal(done.status, 201, `upload finished with ${done.status}`);

    const head = await call(server, { method: 'HEAD', path: `/blob/${WS}/${hash}` });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(buf.length));
    assert.equal(head.headers.etag, `"${hash}"`);

    const got = await call(server, { method: 'GET', path: `/blob/${WS}/${hash}` });
    assert.equal(got.status, 200);
    assert.equal(sha256(got.body), hash, 'the bytes that came back are the bytes that went in');
    assert.equal(got.headers.etag, `"${hash}"`);

    const ranged = await call(server, {
      method: 'GET', path: `/blob/${WS}/${hash}`, headers: { range: 'bytes=1048576-2097151' },
    });
    assert.equal(ranged.status, 206);
    assert.deepEqual(ranged.body, buf.subarray(1048576, 2097152));
  });

  // ------------------------------------------------------------------ C2

  test('C2 an interrupted upload resumes from HEAD ?partial=1 and verifies', async () => {
    const server = getServer();
    const buf = bytes(3 * 1024 * 1024, 23);
    const hash = sha256(buf);

    // Cut the socket in the middle of the chunk, the way a laptop lid does.
    await new Promise((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1', port: server.port, path: `/blob/${WS}/${hash}`, method: 'PATCH',
        agent: false,
        headers: {
          authorization: `Bearer ${server.serverKey}`,
          'content-range': `bytes 0-${buf.length - 1}/${buf.length}`,
          'content-length': String(buf.length),
        },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);
      req.write(buf.subarray(0, 700_000));
      setTimeout(() => { req.destroy(); resolve(); }, 120);
    });
    await sleep(150);

    const probe = await call(server, { method: 'HEAD', path: `/blob/${WS}/${hash}?partial=1` });
    assert.equal(probe.status, 204);
    const received = Number(probe.headers['x-shadowlink-received']);
    assert.ok(received > 0, 'the arrived prefix was kept');
    assert.ok(received < buf.length, `the upload really was interrupted (${received})`);

    // A client that blindly restarts from zero is refused rather than silently
    // appending over its own bytes, and is told where to seek to.
    const blind = await call(server, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes 0-${buf.length - 1}/${buf.length}` },
      body: buf,
    });
    assert.equal(blind.status, 409, 'a blind restart is refused, not silently accepted');
    assert.equal(Number(blind.headers['x-shadowlink-received']), received);

    const rest = await call(server, {
      method: 'PATCH',
      path: `/blob/${WS}/${hash}`,
      headers: { 'content-range': `bytes ${received}-${buf.length - 1}/${buf.length}` },
      body: buf.subarray(received),
    });
    assert.equal(rest.status, 201);

    const got = await call(server, { method: 'GET', path: `/blob/${WS}/${hash}` });
    assert.equal(sha256(got.body), hash, 'the resumed object hashes to its name');
  });

  // ------------------------------------------------------------------ C4

  test('C4 the real server refuses an absent or wrong bearer token on every route', async () => {
    const server = getServer();
    const buf = bytes(4096, 31);
    const hash = sha256(buf);

    for (const key of [null, 'sk_wrong', '']) {
      for (const probe of [
        { method: 'HEAD', path: `/blob/${WS}/${hash}` },
        { method: 'HEAD', path: `/blob/${WS}/${hash}?partial=1` },
        { method: 'GET', path: `/blob/${WS}/${hash}` },
        { method: 'GET', path: `/blob/${WS}/limits` },
        {
          method: 'PATCH',
          path: `/blob/${WS}/${hash}`,
          headers: { 'content-range': `bytes 0-4095/4096` },
          body: buf,
        },
      ]) {
        const res = await call(server, { ...probe, key });
        assert.equal(res.status, 401, `${probe.method} ${probe.path} with key ${String(key)}`);
      }
    }

    // The key must be a HEADER: a query parameter lands in access and proxy logs,
    // and unlike the one-shot upgrade this endpoint is hit hundreds of times.
    const viaQuery = await call(server, {
      method: 'HEAD', path: `/blob/${WS}/${hash}?t=${server.serverKey}`, key: null,
    });
    assert.equal(viaQuery.status, 401, 'the upgrade\'s query parameter authorizes nothing here');

    const stored = await call(server, { method: 'HEAD', path: `/blob/${WS}/${hash}` });
    assert.equal(stored.status, 404, 'and no refused PATCH stored anything');
  });

  test('C4 a bad workspace or hash charset is 400 and the relay still answers', async () => {
    const server = getServer();
    for (const path of [
      `/blob/${'w'.repeat(65)}/${'a'.repeat(64)}`,
      `/blob/${WS}/${'A'.repeat(64)}`,
      `/blob/${WS}/nope`,
    ]) {
      assert.equal((await call(server, { method: 'HEAD', path })).status, 400, path);
    }
    // The pre-existing routes are untouched by the new dispatch.
    const health = await call(server, { method: 'GET', path: '/health', key: null });
    assert.equal(health.status, 200);
    assert.equal(health.body.toString(), '{"status":"ok"}');
    assert.equal((await call(server, { method: 'GET', path: '/nothing', key: null })).status, 404);
  });

  // ------------------------------------------------------------------ C6

  test('C6 concurrent finalisations leave usage.json exactly correct', async () => {
    const server = getServer();
    const ws = 'usagec6';
    const objects = [];
    // Five, deliberately inside MAX_BLOB_CONCURRENCY: a sixth would be answered
    // 503 by the cap, which is the cap working rather than the race this case is
    // about. The lost-update window is per finalisation, not per wave.
    for (let i = 0; i < 5; i++) {
      const buf = bytes(200_000 + i * 1000, 50 + i);
      objects.push({ buf, hash: sha256(buf) });
    }

    // One request each, all in flight together: five finalisations racing the
    // same usage.json. A plain read-modify-write loses the smaller of every
    // concurrent pair, silently and monotonically.
    const results = await Promise.all(objects.map(({ buf, hash }) => call(server, {
      method: 'PATCH',
      path: `/blob/${ws}/${hash}`,
      headers: { 'content-range': `bytes 0-${buf.length - 1}/${buf.length}` },
      body: buf,
    })));
    for (const res of results) assert.equal(res.status, 201);

    const expected = {
      bytes: objects.reduce((sum, o) => sum + o.buf.length, 0),
      files: objects.length,
    };
    const usagePath = join(server.dir, 'blobs', ws, 'usage.json');
    const usage = await waitForJson(usagePath, (u) => u?.files === expected.files);
    assert.deepEqual(usage, expected, 'every finalisation landed in the total');

    const limits = await call(server, { method: 'GET', path: `/blob/${ws}/limits` });
    assert.equal(JSON.parse(limits.body.toString()).maxFileBytes > 0, true);
  });

  // ------------------------------------------------------------------ C5

  test('C5 an object over MAX_FILE_SIZE_MB is 413 and nothing lands', async () => {
    const server = await startServer({ port: basePort, env: { MAX_FILE_SIZE_MB: '1' } });
    try {
      const limits = await call(server, { method: 'GET', path: `/blob/${WS}/limits` });
      assert.deepEqual(JSON.parse(limits.body.toString()).maxFileBytes, 1024 * 1024);

      const buf = bytes(2 * 1024 * 1024, 77);
      const hash = sha256(buf);
      const res = await call(server, {
        method: 'PATCH',
        path: `/blob/${WS}/${hash}`,
        headers: { 'content-range': `bytes 0-${buf.length - 1}/${buf.length}` },
        body: buf,
      });
      assert.equal(res.status, 413);

      assert.equal((await call(server, { method: 'HEAD', path: `/blob/${WS}/${hash}` })).status, 404);
      const partial = await call(server, {
        method: 'HEAD', path: `/blob/${WS}/${hash}?partial=1`,
      });
      assert.equal(partial.headers['x-shadowlink-received'], '0', 'not even a partial landed');
      assert.equal(
        existsSync(join(server.dir, 'blobs', WS, 'incoming', `${hash}.part`)), false,
      );

      // Under the cap, the same server stores normally.
      const small = bytes(100_000, 78);
      const ok = await upload(server, WS, sha256(small), small);
      assert.equal(ok.status, 201);
    } finally {
      await server.stop();
      server.cleanup();
    }
  });

  // ------------------------------------------------------------------ C7

  test('C7 a .part older than INCOMPLETE_UPLOAD_TTL_HOURS is swept on boot and stops counting', async () => {
    const env = { INCOMPLETE_UPLOAD_TTL_HOURS: '1', MAX_TOTAL_STORAGE_GB: '1' };
    const port = basePort + 1;
    const first = await startServer({ port, env });
    const dir = first.dir;
    const quota = 1024 * 1024 * 1024;
    let partPath = null;
    try {
      const buf = bytes(500_000, 91);
      const hash = sha256(buf);
      const started = await call(first, {
        method: 'PATCH',
        path: `/blob/${WS}/${hash}`,
        headers: { 'content-range': `bytes 0-249999/500000` },
        body: buf.subarray(0, 250_000),
      });
      assert.equal(started.status, 204);
      assert.equal(started.headers['x-shadowlink-received'], '250000');

      const before = JSON.parse(
        (await call(first, { method: 'GET', path: `/blob/${WS}/limits` })).body.toString(),
      );
      assert.equal(
        before.freeBytes, quota - 250_000,
        'incoming/ counts against the quota — otherwise partials are invisible to it '
        + 'and the volume fills while usage.json still reports room',
      );

      partPath = join(dir, 'blobs', WS, 'incoming', `${hash}.part`);
      assert.equal(existsSync(partPath), true);
      await first.stop();

      const stale = new Date(Date.now() - 3 * 3600_000);
      utimesSync(partPath, stale, stale);

      const second = await startServer({ port, dir, env });
      try {
        assert.equal(existsSync(partPath), false, 'the stale partial was swept on boot');
        const resumed = await call(second, {
          method: 'HEAD', path: `/blob/${WS}/${hash}?partial=1`,
        });
        assert.equal(resumed.headers['x-shadowlink-received'], '0');

        const after = JSON.parse(
          (await call(second, { method: 'GET', path: `/blob/${WS}/limits` })).body.toString(),
        );
        assert.equal(after.freeBytes, quota, 'and the swept bytes stopped counting');
      } finally {
        await second.stop();
      }
    } finally {
      first.cleanup();
    }
  });

  test('C7 a partial inside the TTL survives a restart and still resumes', async () => {
    const env = { INCOMPLETE_UPLOAD_TTL_HOURS: '24' };
    const port = basePort + 2;
    const first = await startServer({ port, env });
    const dir = first.dir;
    try {
      const buf = bytes(400_000, 97);
      const hash = sha256(buf);
      await call(first, {
        method: 'PATCH',
        path: `/blob/${WS}/${hash}`,
        headers: { 'content-range': `bytes 0-199999/400000` },
        body: buf.subarray(0, 200_000),
      });
      await first.stop();

      const second = await startServer({ port, dir, env });
      try {
        const probe = await call(second, { method: 'HEAD', path: `/blob/${WS}/${hash}?partial=1` });
        assert.equal(probe.headers['x-shadowlink-received'], '200000', 'the upload is its own session');

        const rest = await call(second, {
          method: 'PATCH',
          path: `/blob/${WS}/${hash}`,
          headers: { 'content-range': `bytes 200000-399999/400000` },
          body: buf.subarray(200_000),
        });
        assert.equal(rest.status, 201);
        const got = await call(second, { method: 'GET', path: `/blob/${WS}/${hash}` });
        assert.equal(sha256(got.body), hash);
      } finally {
        await second.stop();
      }
    } finally {
      first.cleanup();
    }
  });

  // ------------------------------------------------- the client port, for real

  test('the client BlobPort round-trips against the real server process', async () => {
    const server = getServer();
    const ws = 'portrt';
    const port = new ObsidianBlobPort({
      // The plugin holds ONE server URL and it is a WebSocket one. If this port
      // could not take it as given, every user would need a second setting.
      serverUrl: `ws://127.0.0.1:${server.port}`,
      serverKey: server.serverKey,
      workspaceId: ws,
    });

    // The shipped defaults, arriving over the wire: proof that the config change
    // reaches the CLIENT rather than only the server's own arithmetic.
    const limits = await port.limits();
    assert.equal(limits.maxFileBytes, 104_857_600, 'MAX_FILE_SIZE_MB = 100');
    // `freeBytes` is the whole store's remaining room and every earlier case in
    // this run has already put objects in it, so what is asserted is the ceiling
    // and the arithmetic, not a pristine number.
    assert.ok(
      limits.freeBytes > 0 && limits.freeBytes <= 10_737_418_240,
      `MAX_TOTAL_STORAGE_GB = 10, less what is stored (${limits.freeBytes})`,
    );

    const data = bytes(5 * 1024 * 1024, 61);
    const hash = sha256(data);

    assert.deepEqual(await port.has(hash), { present: false });
    assert.equal(await port.put(hash, data), true);
    assert.deepEqual(await port.has(hash), { present: true, bytes: data.length });

    const back = await port.get(hash, data.length);
    assert.notEqual(back, null, 'the fetch produced nothing');
    assert.equal(sha256(Buffer.from(back)), hash, 'byte-identical after a real round trip');
    assert.equal(port.lastError, null);
  });

  test('the client BlobPort resumes an interrupted upload against the real server', async () => {
    const server = getServer();
    const ws = 'portres';
    const patches = [];
    const port = new ObsidianBlobPort({
      serverUrl: `ws://127.0.0.1:${server.port}`,
      serverKey: server.serverKey,
      workspaceId: ws,
      chunkBytes: 512 * 1024,
      fetchImpl: (input, init) => {
        if ((init?.method ?? 'GET') === 'PATCH') patches.push(init.headers['content-range']);
        return fetch(input, init);
      },
    });
    const data = bytes(3 * 1024 * 1024, 63);
    const hash = sha256(data);

    // Abort part-way, exactly as a dropped link would.
    const controller = new AbortController();
    let stopped = 0;
    const partial = new ObsidianBlobPort({
      serverUrl: `ws://127.0.0.1:${server.port}`,
      serverKey: server.serverKey,
      workspaceId: ws,
      chunkBytes: 512 * 1024,
      fetchImpl: (input, init) => {
        if (controller.signal.aborted) throw new Error('link down');
        return fetch(input, init);
      },
    });
    await partial.put(hash, data, (sent) => {
      if (sent >= 1024 * 1024 && stopped === 0) { stopped = sent; controller.abort(); }
    }).catch(() => { /* the interruption is the point */ });
    assert.ok(stopped > 0, 'the upload really did get part way');

    // The server kept the prefix that arrived, and says so.
    const probe = await call(server, { method: 'HEAD', path: `/blob/${ws}/${hash}?partial=1` });
    const offset = Number(probe.headers['x-shadowlink-received']);
    assert.ok(offset > 0, 'the arrived prefix was retained');
    assert.ok(offset < data.length, `the upload really was interrupted (${offset})`);

    // A fresh port, no shared state: the partial is keyed by the content hash, so
    // the upload IS its own session on both sides.
    assert.equal(await port.put(hash, data), true);
    assert.ok(patches.length > 0, 'the resume sent something');
    assert.equal(
      patches[0], `bytes ${offset}-${Math.min(offset + 512 * 1024, data.length) - 1}/${data.length}`,
      'the resume began at the offset the server reported, not at zero',
    );
    assert.ok(
      patches.length < Math.ceil(data.length / (512 * 1024)),
      `the resume re-sent the whole object (${patches.length} chunks)`,
    );

    const back = await port.get(hash, data.length);
    assert.equal(sha256(Buffer.from(back)), hash);
  });

  test('the client BlobPort tells the real server refusals apart', async () => {
    const small = await startServer({ port: basePort + 3, env: { MAX_FILE_SIZE_MB: '1' } });
    try {
      const port = new ObsidianBlobPort({
        serverUrl: `ws://127.0.0.1:${small.port}`,
        serverKey: small.serverKey,
        workspaceId: 'portref',
      });

      const big = bytes(2 * 1024 * 1024, 65);
      assert.equal(await port.put(sha256(big), big), false, '413 is a refusal, not a throw');
      assert.ok(port.lastError instanceof BlobTooLarge, `got ${String(port.lastError)}`);

      // 404 is the only answer that is about the bytes — and `get` still returns
      // null rather than throwing, so the caller can only ever no-op on it.
      assert.equal(await port.get('f'.repeat(64), 128), null);
      assert.ok(port.lastError instanceof BlobUnavailable, `got ${String(port.lastError)}`);

      // A wrong key is "I could not ask", and `has` must never fold that into a
      // definite `false` — a definite false at deletion time means rescue (I2).
      const wrongKey = new ObsidianBlobPort({
        serverUrl: `ws://127.0.0.1:${small.port}`,
        serverKey: 'sk_wrong',
        workspaceId: 'portref',
      });
      let threw = null;
      try { await wrongKey.has('a'.repeat(64)); } catch (err) { threw = err; }
      assert.ok(threw instanceof BlobTransport, `has must throw, got ${String(threw)}`);
    } finally {
      await small.stop();
      small.cleanup();
    }
  });

  // ------------------------------------------------------------------ C9

  // ⚠ The only code in this project that removes a blob, run as the real script,
  // against a snapshot the real `DocHub` wrote, over a real socket.
  //
  // Everything below is about the sweeper's REFUSALS, because the way it goes
  // wrong is not subtle: it decides what to remove by reading one file, and every
  // way that file can be wrong — absent, truncated, empty, stale — produces the
  // same wrong answer, "nothing references these bytes", about a workspace that
  // references all of them. The unit suite covers each refusal in isolation; what
  // is proved HERE is that the shipped script, invoked the way an operator invokes
  // it, reads what the server actually writes.
  test('C9 the offline sweeper is dry by default, keeps tombstoned bytes, and refuses what it cannot trust', async () => {
    const server = getServer();
    const ws = 'sweepc9';
    const sweeper = join(REPO_ROOT, 'server', 'tools', 'sweep-blobs.mjs');

    const run = (...args) => {
      const out = spawnSync(process.execPath, [sweeper, '--json', ...args], {
        cwd: REPO_ROOT, encoding: 'utf8',
      });
      assert.equal(out.status, 0, `sweep-blobs exited ${out.status}: ${out.stderr}`);
      const report = JSON.parse(out.stdout);
      return report.workspaces.find((w) => w.workspace === ws);
    };
    const objectPath = (sha) => join(server.dir, 'blobs', ws, sha.slice(0, 2), sha.slice(2, 4), sha);
    const atticPath = (sha) => join(server.dir, 'blobs', ws, '.attic', sha);

    // Three objects. One a live node names, one only a TOMBSTONED node names, and
    // one nothing names at all.
    const live = bytes(2048, 61);
    const dead = bytes(2048, 62);
    const orphan = bytes(2048, 63);
    for (const buf of [live, dead, orphan]) {
      const done = await upload(server, ws, sha256(buf), buf);
      assert.equal(done.status, 201, `upload finished with ${done.status}`);
    }

    // A real tree, written through the relay, so what the sweeper reads is what
    // `DocHub._writeSnapshot` produced rather than something this test invented.
    const doc = new Y.Doc();
    const link = new DocLink(server.url('_tree', ws), doc);
    try {
      link.connect();
      assert.equal(await link.waitSync(4000), true, 'the tree never synced');
      doc.transact(() => {
        const nodes = doc.getMap('nodes');
        const a = new Y.Map();
        a.set('k', 'b'); a.set('d', ''); a.set('n', 'live.png');
        a.set('g', 1); a.set('c', 1); a.set('s', 1);
        a.set('b', `${sha256(live)}:${live.length}:-`);
        nodes.set('AAAAAAAAAAAAAAAAAAAAAA', a);
        const b = new Y.Map();
        b.set('k', 'b'); b.set('d', ''); b.set('n', 'deleted.png');
        b.set('g', 1); b.set('c', 1); b.set('s', 1); b.set('x', 1);
        b.set('b', `${sha256(dead)}:${dead.length}:-`);
        nodes.set('BBBBBBBBBBBBBBBBBBBBBB', b);
      });
      assert.equal(await link.flush(4000), true, 'the tree write was never acknowledged');
    } finally {
      link.destroy();
    }

    // The snapshot rides a 2 s debounce, and the sweeper reads the FILE.
    const treePath = join(server.dir, 'yjs', ws, '_tree.bin');
    const deadline = Date.now() + 8000;
    let nodeCount = 0;
    while (Date.now() < deadline && nodeCount < 2) {
      await sleep(100);
      if (!existsSync(treePath)) continue;
      try {
        const probe = new Y.Doc();
        Y.applyUpdate(probe, new Uint8Array(readFileSync(treePath)));
        nodeCount = probe.getMap('nodes').size;
      } catch { /* mid-rename */ }
    }
    assert.equal(nodeCount, 2, 'the server never wrote a tree snapshot holding both nodes');

    // Age the objects past a one-day TTL. This also keeps them comfortably OLDER
    // than the snapshot, so the staleness guard has nothing to complain about.
    const old = (Date.now() - 30 * 86_400_000) / 1000;
    for (const buf of [live, dead, orphan]) utimesSync(objectPath(sha256(buf)), old, old);

    // 1. `--dry-run` is the default: it says what it would do, and does none of it.
    const dry = run('--dir', server.dir, '--workspace', ws, '--ttl-days', '1');
    assert.equal(dry.refused, null, `the workspace was refused: ${dry.refused}`);
    assert.deepEqual(dry.attic, [sha256(orphan)], 'exactly the one nothing references');
    assert.equal(existsSync(objectPath(sha256(orphan))), true, 'and nothing moved');

    // 2. …and with --apply, only the orphan moves, to `.attic` rather than away.
    const applied = run('--dir', server.dir, '--workspace', ws, '--ttl-days', '1', '--apply');
    assert.deepEqual(applied.attic, [sha256(orphan)]);
    assert.deepEqual(applied.unlinked, [], 'a second TTL stands between .attic and gone');
    assert.equal(existsSync(atticPath(sha256(orphan))), true);
    assert.equal(existsSync(objectPath(sha256(orphan))), false);

    // ⚠ 3. The tombstoned node's bytes are STILL THERE. A resurrect, an undelete
    // from the vault-local `.trash`, and the `proven` probe every peer runs before
    // it removes its own copy all need exactly these bytes.
    assert.equal(existsSync(objectPath(sha256(dead))), true, 'a deleted file is not a deleted blob');
    assert.equal(existsSync(objectPath(sha256(live))), true);

    // ⚠ 4. A snapshot it cannot decode refuses the whole workspace. Without this,
    // a truncated file reads as "nothing is referenced" and empties the store.
    writeFileSync(treePath, Buffer.from([0xff, 0x00, 0x13, 0x37]));
    const refused = run('--dir', server.dir, '--workspace', ws, '--ttl-days', '1', '--apply');
    assert.notEqual(refused.refused, null, 'a corrupt snapshot must refuse the workspace');
    assert.deepEqual(refused.attic, []);
    assert.equal(existsSync(objectPath(sha256(live))), true, 'and touches nothing');
    assert.equal(existsSync(objectPath(sha256(dead))), true);
  });

  // ----------------------------------------------------------------- C10

  test('C10 a saturated blob store still answers the relay, and the overflow gets 503', async () => {
    const server = getServer();
    const ws = 'loadc10';
    const inFlight = [];
    // MAX_BLOB_CONCURRENCY is 6 per workspace and 2 per connection; each of these
    // is its own socket, so six of them saturate the workspace.
    for (let i = 0; i < 6; i++) {
      const buf = bytes(64_000, 200 + i);
      inFlight.push(slowPatch(server, ws, sha256(buf), buf));
    }
    await sleep(250);

    const doc = new Y.Doc();
    const link = new DocLink(server.url('_tree', ws), doc);
    try {
      const spare = bytes(1000, 250);
      const overflow = await call(server, {
        method: 'PATCH',
        path: `/blob/${ws}/${sha256(spare)}`,
        headers: { 'content-range': `bytes 0-999/1000` },
        body: spare,
      });
      assert.equal(overflow.status, 503, 'overflow is refused, never unbounded acceptance');
      assert.ok(
        Number(overflow.headers['retry-after']) > 0,
        `503 must carry a Retry-After (${overflow.headers['retry-after']})`,
      );

      // …and the point of the cap: real-time text does not degrade while the
      // store is busy. This is the same 2 s budget every other case uses.
      const started = Date.now();
      link.connect();
      assert.equal(await link.waitSync(2000), true, 'the relay never synced under blob load');
      doc.getMap('nodes').set('probe', 'x');
      assert.equal(await link.flush(2000), true, 'the relay never acknowledged under blob load');
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2000, `the relay round trip took ${elapsed}ms under blob load`);
    } finally {
      link.destroy();
      for (const transfer of inFlight) transfer.finish();
      await Promise.all(inFlight.map((t) => t.done));
    }

    // The slots are released once the transfers finish.
    const after = bytes(1000, 251);
    const accepted = await call(server, {
      method: 'PATCH',
      path: `/blob/${ws}/${sha256(after)}`,
      headers: { 'content-range': `bytes 0-999/1000` },
      body: after,
    });
    assert.equal(accepted.status, 201);
  });
}
