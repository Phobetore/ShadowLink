// server/test/harness/muxtree.mjs
// P3 slice 2, Group C — the SHIPPED client mux against REAL server processes.
//
// `MuxLink.test.ts` and `MuxRoom.test.ts` drive the same classes against
// `FakeMux`, which is faithful enough to be worth having and is still a fake.
// What only a real process can settle is here:
//
//  * the frame codec agrees with `server/mux.js`'s. Both files write
//    `varString(room) + varUint8Array(payload)` and neither imports the other —
//    a drift would leave every unit test green and address the wrong room;
//  * `ProviderAck` really is re-hosted. Its guarantee is that DocHub processes
//    one socket's frames in order, and DocHub is what has to be doing that;
//  * the fallback fires against a server that GENUINELY has no endpoint. That is
//    `legacy-server.mjs`, which is `server/index.js` from before any of this
//    work, run as its own process on its own port. A flag would prove nothing:
//    the whole finding is that an old server ACCEPTS the socket.
//
// The socket count is measured rather than asserted from the design, because the
// slice's stated goal is "one fewer socket" and the honest answer at slice 2 is
// more interesting than that. See case 80d.

import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import net from 'node:net';
import { WebSocket } from 'ws';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, assert } from './runner.mjs';
import { startServer } from './server.mjs';
import { DocLink, sleep } from './net.mjs';
import { MuxLink } from '../../../src/sync/MuxLink.ts';
import { MuxRoom } from '../../../src/sync/MuxRoom.ts';
import {
  LegacyTreeTransport, MUX_UNREACHABLE_NOTICE, legacyNoticeFor, openTreeTransport,
} from '../../../src/sync/LegacyTreeTransport.ts';
import { TreeDoc } from '../../../src/tree/TreeDoc.ts';
import { routeUnserved, statusLine } from '../../../src/ui/format.ts';
import { TREE_SYNC_TIMEOUT_MS } from '../../../src/tree/constants.ts';

// ⚠ THE PROBE HAS TO BE THE ONE THAT SHIPS. `LegacyTreeTransport` is a
// `WebsocketProvider`, whose whole reconnect loop runs out of `onclose` — and
// Node 22's global (undici) `WebSocket` fires `error` on a refused connection and
// NEVER fires `close`, so under it the probe is a ONE-SHOT that can never make a
// second attempt. Measured: `wsconnected false / wsconnecting true /
// wsUnsuccessfulReconnects 0 / ws non-null`, held for 14 s across a path that came
// back and stayed up. Obsidian is Chromium, which fires error-then-close(1006)
// exactly as `ws` does, so every case below was running against a probe that
// behaves differently from the shipped one. One line settles it.
global.WebSocket = WebSocket;

const HERE = dirname(fileURLToPath(import.meta.url));
export const LEGACY_ENTRY = join(HERE, 'legacy-server.mjs');

/** Poll `predicate` until it holds or `ms` elapses. */
async function until(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

/**
 * A `MuxLink` over real `ws` sockets, counting every one it opens.
 *
 * The count is the point of the slice, so it is taken at the factory — the one
 * place a socket can come into existence — rather than inferred from the server.
 */
function realLink(server, workspace, opts = {}) {
  const opened = [];
  const link = new MuxLink({
    serverUrl: `ws://127.0.0.1:${server.port}`,
    serverKey: server.serverKey,
    workspaceId: workspace,
    openSocket: (url) => {
      const socket = new WebSocket(url);
      opened.push(socket);
      return socket;
    },
    ...opts,
  });
  return { link, opened, socketCount: () => opened.length };
}

/**
 * A TCP proxy in front of the real server that REFUSES the `/_mux` upgrade —
 * 404 at the HTTP layer — and forwards every other path untouched.
 *
 * ⚠ The point is that this is not a flag and not a fake: it is the shipped server
 * with one route unreachable, which is precisely what a reverse proxy configured
 * for the routes somebody knew about produces. `mode: 'blackhole'` is the other
 * half of the same misconfiguration: the TCP connection is accepted and the
 * upgrade is never answered at all.
 */
function hostileProxy({ listen, target, mode }) {
  const held = [];
  const live = [];
  // Mutable so a case can start with the route WORKING and take it away later,
  // which is a different question from "was it ever there" and needs the same
  // proxy to answer both.
  const state = { mode };
  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    client.once('data', (first) => {
      const head = first.toString('latin1').split('\r\n')[0] ?? '';
      if (head.includes(' /_mux') && state.mode !== 'forward') {
        if (state.mode === 'blackhole') { held.push(client); return; }
        client.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        client.end();
        return;
      }
      const up = net.connect(target, '127.0.0.1', () => { up.write(first); });
      live.push({ client, up });
      up.on('error', () => undefined);
      client.pipe(up);
      up.pipe(client);
      const bye = () => {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      };
      client.on('close', bye);
      up.on('close', bye);
    });
  });
  return {
    start: () => new Promise((resolve) => server.listen(listen, '127.0.0.1', resolve)),
    /** Change what `/_mux` gets from here on: 'forward', 'refuse' or 'blackhole'. */
    setMode(next) { state.mode = next; },
    /** One ordinary RST on every pair the proxy is carrying. */
    cutAll() {
      for (const { client, up } of live) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      live.length = 0;
    },
    async stop() {
      for (const client of held) { try { client.destroy(); } catch { /* gone */ } }
      for (const { client, up } of live) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A TCP proxy that can STOP FORWARDING without closing anything — no FIN, no RST.
 *
 * ⚠ This is the only honest way to make a socket that is OPEN and dead, and it is
 * what a dropped NAT flow, a slept laptop and a wifi handover all do. Calling a
 * close method instead would test the close path, which was never the broken one.
 * While frozen it does not propagate a close either: on a frozen path, nothing
 * moves in either direction, including the news that something died.
 */
function freezableProxy({ listen, target }) {
  const state = { frozen: false, pairs: [] };
  const server = net.createServer((client) => {
    const up = net.connect(target, '127.0.0.1');
    state.pairs.push({ client, up });
    client.on('error', () => undefined);
    up.on('error', () => undefined);
    client.on('data', (b) => { if (!state.frozen) up.write(b); });
    up.on('data', (b) => { if (!state.frozen) client.write(b); });
    const bye = () => {
      if (state.frozen) return;
      try { client.destroy(); } catch { /* gone */ }
      try { up.destroy(); } catch { /* gone */ }
    };
    client.on('close', bye);
    up.on('close', bye);
  });
  return {
    async start() {
      await new Promise((resolve) => server.listen(listen, '127.0.0.1', resolve));
      return `ws://127.0.0.1:${listen}`;
    },
    freeze() { state.frozen = true; },
    thaw() { state.frozen = false; },
    async stop() {
      state.frozen = false;
      for (const { client, up } of state.pairs) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A TCP proxy that is SLOW and nothing else: every connection on every route
 * waits `delayMs` before a byte moves, then both directions are forwarded
 * untouched for ever.
 *
 * ⚠ Nothing is refused and nothing is blocked, which is the whole point. This is
 * a radio wake, a cold reverse proxy, a tunnel, a VPN re-key — the paths the
 * self-hosters INSTALL.md sends to a proxy actually have. A client that demotes
 * its transport here is reporting the shape of its own timeout.
 */
function slowProxy({ listen, target, delayMs }) {
  const live = [];
  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    client.pause();
    const timer = setTimeout(() => {
      const up = net.connect(target, '127.0.0.1');
      live.push({ client, up });
      up.on('error', () => undefined);
      client.pipe(up);
      up.pipe(client);
      client.resume();
      const bye = () => {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      };
      client.on('close', bye);
      up.on('close', bye);
    }, delayMs);
    client.on('close', () => clearTimeout(timer));
  });
  return {
    async start() {
      await new Promise((resolve) => server.listen(listen, '127.0.0.1', resolve));
      return `ws://127.0.0.1:${listen}`;
    },
    async stop() {
      for (const { client, up } of live) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A TCP proxy that passes the HTTP 101 through untouched and then HOLDS the
 * server's first WebSocket frame for `holdMs`, on the Nth connection only.
 *
 * ⚠ The upgrade SUCCEEDS. The socket is genuinely OPEN, the peer is the real
 * current server, and it has simply not been heard from yet — which is the exact
 * state a ten-second timer used to turn into "your server is older than this
 * plugin", permanently, on a route that had already answered.
 */
function holdFirstFrameProxy({ listen, target, holdMs, onlyNth }) {
  const live = [];
  let seen = 0;
  const server = net.createServer((client) => {
    seen += 1;
    const mine = seen;
    const up = net.connect(target, '127.0.0.1');
    live.push({ client, up });
    client.on('error', () => undefined);
    up.on('error', () => undefined);
    client.on('data', (b) => { try { up.write(b); } catch { /* gone */ } });

    let upgraded = false;
    let holding = false;
    const parked = [];
    const release = () => {
      holding = false;
      for (const chunk of parked.splice(0)) {
        try { client.write(chunk); } catch { /* gone */ }
      }
    };
    up.on('data', (b) => {
      if (!upgraded) {
        const text = b.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (text.startsWith('HTTP/1.1 101') && end >= 0) {
          upgraded = true;
          const headEnd = end + 4;
          try { client.write(b.subarray(0, headEnd)); } catch { /* gone */ }
          if (mine === onlyNth) {
            holding = true;
            if (b.length > headEnd) parked.push(b.subarray(headEnd));
            setTimeout(release, holdMs);
          } else if (b.length > headEnd) {
            try { client.write(b.subarray(headEnd)); } catch { /* gone */ }
          }
          return;
        }
      }
      if (holding) { parked.push(b); return; }
      try { client.write(b); } catch { /* gone */ }
    });
    const bye = () => {
      try { client.destroy(); } catch { /* gone */ }
      try { up.destroy(); } catch { /* gone */ }
    };
    client.on('close', bye);
    up.on('close', bye);
  });
  return {
    async start() {
      await new Promise((resolve) => server.listen(listen, '127.0.0.1', resolve));
      return `ws://127.0.0.1:${listen}`;
    },
    /** One ordinary RST on every live pair: a network cut, not a close handshake. */
    cutAll() {
      for (const { client, up } of live) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      live.length = 0;
    },
    async stop() {
      for (const { client, up } of live) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A TCP proxy that upgrades `/_mux` FOR REAL and is then deaf on it: the HTTP 101
 * is written through untouched, and every byte the server writes after it is
 * swallowed. No FIN, no RST, nothing to observe. Every other path is forwarded.
 *
 * ⚠ THE SHAPE THAT HAD NOTHING SAID ABOUT IT. Measured on the parent branch
 * through exactly this proxy: 70 s gave 3 sockets, 2 idle closures, 18 frames out,
 * 0 in, `dialsFailed` 0, no verdict, no notice, NO PROBE EVER BUILT, the tree
 * unsynced, and the status bar reading "ShadowLink could not reach the workspace"
 * while a control client on the same path synced with the same server. It is what
 * a proxy that upgrades a socket and then forwards nothing on it does, and it is
 * indistinguishable from a working server whose answer is merely late — which is
 * why the client may not guess, and does not.
 */
function deafMuxProxy({ listen, target }) {
  const live = [];
  // Sockets whose TCP handshake completed and which will never be answered. Kept
  // so `stop()` can close them, and COUNTED because "how many half-open sockets
  // has this path produced, and how many has it since served" is the measurement
  // case 80u is about.
  const held = [];
  const counts = { others: 0, othersHeld: 0, othersForwarded: 0 };
  // Mutable, because "the proxy was reloaded" is a real thing that happens to a
  // route that was deaf a moment ago, and it turns this shape into the refused
  // one WITH A HISTORY — which is the ordering no case covered.
  const state = {
    refusing: false, holdingOthers: false, holdingAll: false,
    holdingMux: false, refusalsLeft: 0,
  };
  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    client.once('data', (first) => {
      const head = first.toString('latin1').split('\r\n')[0] ?? '';
      const isMux = head.includes(' /_mux');
      // ⚠ THE PATH GOING DARK, which is a different thing from the path saying no
      // and is the shape five rounds of retractions never covered. Every new TCP
      // connection is accepted and never answered: a firewall DROP rule, a drained
      // load balancer, a dead VPN, a captive portal. Nothing is refused, so no dial
      // reports, so nothing on the link can ever notice.
      if (state.holdingAll) return;
      if (!isMux) counts.others += 1;
      // ⚠ EVERY OTHER ROUTE HELD, and `/_mux` still upgraded and still deaf. It
      // isolates the one retraction that has nothing to do with a refused dial:
      // the per-room probe the sentence rests on stops being able to answer, with
      // the mux route behaving exactly as it did before.
      //
      // ⚠ AND IT IS ALSO THE HALF-OPEN SOCKET ITSELF. The TCP handshake completed
      // — `net.createServer` accepted this connection — and nothing else ever
      // will: no upstream connect, no byte, no FIN, no RST. A `WebSocket` on it
      // stays in CONNECTING for ever, which is the state `y-websocket` has no way
      // to leave. Case 80u heals the path afterwards, to prove something redials.
      if (!isMux && state.holdingOthers) {
        counts.othersHeld += 1;
        held.push(client);
        return;
      }
      if (!isMux) counts.othersForwarded += 1;
      // ⚠ A REFUSAL RUN WITH AN END TO IT. Counted rather than latched, because the
      // shape that stranded a probe is 404-then-black-hole: the run is gathered,
      // the probe is built, and then the path stops refusing without ever opening.
      if (isMux && state.refusalsLeft > 0) {
        state.refusalsLeft -= 1;
        client.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        client.end();
        return;
      }
      if (isMux && state.holdingMux) return;
      if (isMux && state.refusing) {
        client.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        client.end();
        return;
      }
      const up = net.connect(target, '127.0.0.1', () => { up.write(first); });
      live.push({ client, up });
      up.on('error', () => undefined);
      client.on('data', (b) => { try { up.write(b); } catch { /* gone */ } });
      let upgraded = false;
      up.on('data', (b) => {
        if (isMux && upgraded) return;                 // every frame dies here
        const text = b.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (isMux && !upgraded && text.startsWith('HTTP/1.1 101') && end >= 0) {
          upgraded = true;
          try { client.write(b.subarray(0, end + 4)); } catch { /* gone */ }
          return;
        }
        try { client.write(b); } catch { /* gone */ }
      });
      const bye = () => {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      };
      client.on('close', bye);
      up.on('close', bye);
    });
  });
  return {
    /** What this path has done to the per-room route, for the cases that count it. */
    counts,
    async start() {
      await new Promise((resolve) => server.listen(listen, '127.0.0.1', resolve));
      return `ws://127.0.0.1:${listen}`;
    },
    /** From here on, 404 the `/_mux` upgrade instead of upgrading it and going deaf. */
    refuseMux() { state.refusing = true; },
    /** 404 the next `n` `/_mux` upgrades and then stop refusing. */
    refuseMuxTimes(n) { state.refusalsLeft = n; },
    /** From here on, accept every `/_mux` connection and never answer it. */
    holdMux() { state.holdingMux = true; },
    /** From here on, accept every OTHER route's connection and never answer it. */
    holdOthers() { state.holdingOthers = true; },
    /**
     * The per-room route works again — and the sockets already half-open on it are
     * LEFT half-open, because a firewall rule that stops matching does not go back
     * and finish the connections it swallowed. That is the whole difficulty: the
     * client is never told, so only its own bound can notice.
     */
    releaseOthers() { state.holdingOthers = false; },
    /** From here on the path is DARK: every connection accepted, none ever answered. */
    holdAll() { state.holdingAll = true; },
    /** One ordinary RST on every pair the proxy is carrying, `/_mux` included. */
    cutAll() {
      for (const { client, up } of live) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      live.length = 0;
    },
    async stop() {
      for (const client of held) { try { client.destroy(); } catch { /* gone */ } }
      held.length = 0;
      for (const { client, up } of live) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A TCP proxy that 404s `/_mux` and forwards every OTHER route IN FULL, `delayMs`
 * late — a tether, a cold-start backend, a captive portal in front of a reverse
 * proxy that was never told about the multiplexed path.
 *
 * ⚠ IT IS THE ONE SHAPE A CEILING ON THE PROBE'S PATIENCE TURNS FROM SLOW INTO
 * DEAD. Nothing here is broken: every byte of the per-room route arrives, and a
 * plain `LegacyTreeTransport` on this path simply costs `delayMs`. What decides
 * whether the session syncs at all is whether the probe is ever given a dial
 * deadline wide enough to contain that handshake — which is what case 80v asks.
 */
function slowRoomProxy({ listen, target, delayMs }) {
  const live = [];
  const counts = { mux: 0, others: 0, othersOpened: 0 };
  // ⚠ `/_mux` STARTS DEAF RATHER THAN REFUSED, and the ordering is the reason.
  // A route that 404s from the first dial has a refusal run standing the whole
  // time, so the verdict lands in the same turn the replacement probe syncs and
  // the probe is adopted before anything can read the sentence off it — measured
  // as a flake: `dials=4 opened=1 verdict=unreachable` with the sentence never
  // observed. Deaf first (which reports, and so builds a probe, without a refusal
  // run) and refused afterwards, exactly as case 80u sequences it.
  const state = { refusing: false };
  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    client.once('data', (first) => {
      const head = first.toString('latin1').split('\r\n')[0] ?? '';
      const isMux = head.includes(' /_mux');
      if (isMux) {
        counts.mux += 1;
        if (state.refusing) {
          client.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          client.end();
          return;
        }
        const up = net.connect(target, '127.0.0.1', () => { up.write(first); });
        live.push({ client, up });
        up.on('error', () => undefined);
        client.on('data', (b) => { try { up.write(b); } catch { /* gone */ } });
        let upgraded = false;
        up.on('data', (b) => {
          if (upgraded) return;                    // every server frame dies here
          const text = b.toString('latin1');
          const end = text.indexOf('\r\n\r\n');
          if (text.startsWith('HTTP/1.1 101') && end >= 0) {
            upgraded = true;
            try { client.write(b.subarray(0, end + 4)); } catch { /* gone */ }
            return;
          }
          try { client.write(b); } catch { /* gone */ }
        });
        const byeMux = () => {
          try { client.destroy(); } catch { /* gone */ }
          try { up.destroy(); } catch { /* gone */ }
        };
        client.on('close', byeMux);
        up.on('close', byeMux);
        return;
      }
      counts.others += 1;
      // Held rather than dropped: the bytes the client already sent are replayed
      // upstream when the connection is finally made, so the handshake is merely
      // LATE and never damaged.
      const queued = [first];
      let up = null;
      client.on('data', (b) => {
        if (up === null) { queued.push(b); return; }
        try { up.write(b); } catch { /* gone */ }
      });
      const timer = setTimeout(() => {
        up = net.connect(target, '127.0.0.1', () => {
          counts.othersOpened += 1;
          for (const b of queued.splice(0)) { try { up.write(b); } catch { /* gone */ } }
        });
        live.push({ client, up });
        up.on('error', () => undefined);
        up.on('data', (b) => { try { client.write(b); } catch { /* gone */ } });
        const bye = () => {
          try { client.destroy(); } catch { /* gone */ }
          try { up.destroy(); } catch { /* gone */ }
        };
        client.on('close', bye);
        up.on('close', bye);
      }, delayMs);
      client.on('close', () => clearTimeout(timer));
    });
  });
  return {
    counts,
    async start() {
      await new Promise((resolve) => server.listen(listen, '127.0.0.1', resolve));
      return `ws://127.0.0.1:${listen}`;
    },
    /** From here on, 404 the `/_mux` upgrade — the verdict's other half. */
    refuseMux() { state.refusing = true; },
    async stop() {
      for (const { client, up } of live) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A TCP proxy that forwards everything, but takes `delayMs` to connect the
 * `/_mux` route upstream and nothing at all on every other path.
 *
 * ⚠ IT MAKES AN ORDERING DETERMINISTIC THAT IS OTHERWISE A RACE. The defect it
 * exists for needs the bridge's per-room probe to finish its handshake while a
 * mux dial is still in flight and a refusal count gathered during an outage is
 * still standing. Against a plain restart that ordering depends on where
 * y-websocket's own backoff happens to be — measured, deterministic at an 8,000 ms
 * outage and absent at 7,500 and 8,500 — which is a real defect and a terrible
 * regression test. Here the route that has to be slower simply is.
 */
function slowMuxProxy({ listen, target, delayMs }) {
  const live = [];
  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    client.once('data', (first) => {
      const head = first.toString('latin1').split('\r\n')[0] ?? '';
      const wait = head.includes(' /_mux') ? delayMs : 0;
      const queued = [first];
      let up = null;
      client.on('data', (b) => {
        if (up === null) { queued.push(b); return; }
        try { up.write(b); } catch { /* gone */ }
      });
      setTimeout(() => {
        up = net.connect(target, '127.0.0.1', () => {
          for (const b of queued.splice(0)) { try { up.write(b); } catch { /* gone */ } }
        });
        live.push({ client, up });
        up.on('error', () => undefined);
        up.on('data', (b) => { try { client.write(b); } catch { /* gone */ } });
        const bye = () => {
          try { client.destroy(); } catch { /* gone */ }
          try { up.destroy(); } catch { /* gone */ }
        };
        client.on('close', bye);
        up.on('close', bye);
      }, wait);
    });
  });
  return {
    async start() {
      await new Promise((resolve) => server.listen(listen, '127.0.0.1', resolve));
      return `ws://127.0.0.1:${listen}`;
    },
    async stop() {
      for (const { client, up } of live) {
        try { client.destroy(); } catch { /* gone */ }
        try { up.destroy(); } catch { /* gone */ }
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * The bar, exactly as `main.ts` composes it, for a session in this state.
 *
 * ⚠ `compatibility` IS THREE FACTS, not the setting. `main.ts` reads the setting
 * once, when it builds the transport, so `active` is what is carrying the tree,
 * `chosen` is what the setting said when that happened, and `requested` is what it
 * says now — and the last two disagree for the whole of the window in which
 * anybody throws the lever.
 */
function barFor(link, {
  paused = null,
  ready = false,
  witness = null,
  compatibility = { active: false, requested: false, chosen: false },
} = {}) {
  return statusLine({
    paused,
    ready,
    busy: false,
    pending: 0,
    parked: [],
    synced: () => ({ text: 'ShadowLink: synced', tooltip: 'Sharing Shared' }),
    route: factsFor(link, witness),
    compatibility,
  });
}

/**
 * The four facts `main.ts` hands the bar, read at THIS INSTANT.
 *
 * ⚠ `link.routeUnserved` USED TO BE ONE READ, and it was a conclusion the bridge
 * had written onto the link some time earlier. Every case below now recomputes the
 * sentence from the bridge's live probe and the link's own counters, exactly as the
 * status bar does on every poll, because there is no longer anything remembered to
 * read back. A route with no bridge in front of it (the compatibility branch) has
 * nothing to say and gets the all-false shape.
 */
function factsFor(link, witness) {
  if (link === null) {
    return { serverAnswersElsewhere: false, framesIn: 0, framesOut: 0, condemned: false };
  }
  return {
    serverAnswersElsewhere: witness !== null && witness.serverAnswersElsewhere,
    framesIn: link.stats.framesIn,
    framesOut: link.stats.framesOut,
    condemned: link.unsupportedReason !== null,
  };
}

/** The sentence itself, for the cases that poll on it rather than read the bar. */
function saysUnserved(link, witness) {
  return routeUnserved(factsFor(link, witness));
}

export function registerMuxTreeCases(getServer, legacyPort) {
  let legacy = null;
  // Derived rather than plumbed: one env var already names this block, and three
  // more would be three more things to keep in step with the CI invocation.
  const refusePort = legacyPort + 1;
  const swapPort = legacyPort + 2;
  const freezePort = legacyPort + 3;
  const slowPort = legacyPort + 4;
  const holdPort = legacyPort + 5;
  const blockPort = legacyPort + 6;
  const deafPort = legacyPort + 7;
  const holePort = legacyPort + 8;
  const leverPort = legacyPort + 9;
  const killPort = legacyPort + 10;
  const killProxyPort = legacyPort + 11;
  const reloadPort = legacyPort + 12;
  const outagePort = legacyPort + 13;
  const outageProxyPort = legacyPort + 14;
  const holdOtherPort = legacyPort + 15;
  const darkPort = legacyPort + 16;
  const strandPort = legacyPort + 17;
  const wedgePort = legacyPort + 18;
  const slowRoomPort = legacyPort + 19;
  const accruePort = legacyPort + 20;

  test('80a the shipped MuxLink carries _tree over the real server, and converges', async () => {
    const server = getServer();
    const workspace = 'muxtree80a';
    const ann = new Y.Doc();
    const bob = new Y.Doc();
    const a = realLink(server, workspace);
    const b = realLink(server, workspace);
    const annRoom = new MuxRoom(a.link, '_tree', ann);
    const bobRoom = new MuxRoom(b.link, '_tree', bob);
    try {
      a.link.connect();
      b.link.connect();
      assert.equal(await annRoom.whenSynced(5_000), true, 'the mux tree never synced');
      assert.equal(await bobRoom.whenSynced(5_000), true, 'the second client never synced');

      ann.getMap('nodes').set('n1', { k: 'f', p: 'a.md' });
      assert.equal(
        await until(() => bob.getMap('nodes').get('n1')?.p === 'a.md', 5_000), true,
        'the tree edit never crossed the mux',
      );

      // Back the other way, and read off the server with a connection neither
      // client owns — the shipped per-room route, onto the same document.
      bob.getMap('nodes').set('n2', { k: 'd', p: 'folder' });
      assert.equal(
        await until(() => ann.getMap('nodes').get('n2')?.p === 'folder', 5_000), true,
        'the reply never came back',
      );

      const observer = new Y.Doc();
      const link = new DocLink(server.url('_tree', workspace), observer);
      link.connect();
      assert.equal(await link.waitSync(5_000), true, 'the observer never synced');
      assert.equal(observer.getMap('nodes').get('n1')?.p, 'a.md',
        'the server does not hold what the mux client wrote');
      assert.equal(observer.getMap('nodes').get('n2')?.p, 'folder');
      link.destroy();
      observer.destroy();
    } finally {
      annRoom.destroy(); bobRoom.destroy();
      a.link.destroy(); b.link.destroy();
      ann.destroy(); bob.destroy();
    }
  });

  test('80b a flush over the mux is confirmed by DocHub, not by the socket draining', async () => {
    // I17's whole basis, re-hosted. `ProviderAck` writes a SyncStep1 behind the
    // updates it wants acknowledged; only a server that processed them in order
    // can answer it. This is the case that says DocHub really does.
    const server = getServer();
    const workspace = 'muxtree80b';
    const doc = new Y.Doc();
    const { link } = realLink(server, workspace);
    const room = new MuxRoom(link, 'n_AbCdEfGhIjKlMnOpQrStUv', doc);
    try {
      link.connect();
      assert.equal(await room.whenSynced(5_000), true);
      doc.getText('content').insert(0, 'confirmed over one socket');
      assert.equal(await room.flush(5_000), true, 'a real round trip was not confirmed');

      // The confirmation is only worth anything if the bytes are really there.
      const observer = new Y.Doc();
      const check = new DocLink(server.url('n_AbCdEfGhIjKlMnOpQrStUv', workspace), observer);
      check.connect();
      assert.equal(await check.waitSync(5_000), true);
      assert.equal(observer.getText('content').toString(), 'confirmed over one socket',
        'flush confirmed content the server does not hold');
      check.destroy();
      observer.destroy();
    } finally {
      room.destroy(); link.destroy(); doc.destroy();
    }
  });

  test('80c a client whose server predates the mux falls back and still syncs the tree', async () => {
    // ⚠ Against a REAL pre-P3 server process. The finding this case exists for is
    // that such a server ACCEPTS `/_mux` and serves it as an ordinary room, so
    // nothing about the connection succeeding tells the client anything.
    const workspace = 'muxtree80c';
    const tree = new TreeDoc();
    const { link, socketCount } = realLink(legacy, workspace);
    const notices = [];
    const transport = openTreeTransport(
      link,
      tree.doc,
      {
        serverUrl: `ws://127.0.0.1:${legacy.port}`,
        serverKey: legacy.serverKey,
        workspaceId: workspace,
      },
      (reason) => notices.push(reason),
    );
    const peer = new Y.Doc();
    const peerLink = new DocLink(legacy.url('_tree', workspace), peer);
    try {
      transport.connect();

      // The verdict, from the old server's own first message.
      assert.equal(await until(() => notices.length > 0, 8_000), true,
        'a server with no /_mux route was never detected');
      assert.deepEqual(notices, ['not-a-frame'],
        `expected the first-message verdict, got ${JSON.stringify(notices)}`);
      assert.equal(link.unsupportedReason, 'not-a-frame');
      assert.equal(link.connected, false, 'the mux link stayed up on a server that cannot serve it');

      // And the tree works anyway, on today's exact topology.
      assert.equal(await transport.whenSynced(8_000), true,
        'the fallback never synced the tree');
      tree.doc.getMap('nodes').set('n1', { k: 'f', p: 'legacy.md' });

      peerLink.connect();
      assert.equal(await peerLink.waitSync(5_000), true);
      assert.equal(
        await until(() => peer.getMap('nodes').get('n1')?.p === 'legacy.md', 5_000), true,
        'the fallback client never reached the old server',
      );

      // Exactly one mux socket was ever dialled, and it is closed. The fallback
      // does not sit there retrying a route that will never exist.
      assert.equal(socketCount(), 1, `the link kept dialling: ${socketCount()} sockets`);
      await sleep(300);
      assert.equal(socketCount(), 1, 'the link re-dialled a server already known to be old');
    } finally {
      transport.destroy();
      link.destroy();
      peerLink.destroy();
      peer.destroy();
      tree.doc.destroy();
    }
  });

  test('80d one socket carries _tree AND a note room — the count the slice is about', async () => {
    // ⚠ MEASURED, and the number is not the one slice 2's one-line definition of
    // done implies. Slice 2 moves exactly ONE room, so a vault at rest goes from
    // one tree socket to one mux socket: the count is unchanged, and spec §"What
    // this gives up" 2 says so — "one socket only from slice 3 onward".
    //
    // What IS true today, and is what the transport had to deliver, is that the
    // second room costs no second socket. Two rooms over today's topology is two
    // WebSocketProviders and two sockets; here it is two rooms and one socket,
    // with both converging.
    const server = getServer();
    const workspace = 'muxtree80d';
    const tree = new Y.Doc();
    const note = new Y.Doc();
    const { link, socketCount } = realLink(server, workspace);
    const treeRoom = new MuxRoom(link, '_tree', tree);
    const noteRoom = new MuxRoom(link, 'n_AbCdEfGhIjKlMnOpQrStUv', note);
    try {
      link.connect();
      assert.equal(await treeRoom.whenSynced(5_000), true);
      assert.equal(await noteRoom.whenSynced(5_000), true);
      assert.equal(socketCount(), 1, `two rooms opened ${socketCount()} sockets`);
      assert.equal(link.roomCount, 2);

      tree.getMap('nodes').set('n1', { k: 'f', p: 'both.md' });
      note.getText('content').insert(0, 'and the note too');
      assert.equal(await treeRoom.flush(5_000), true);
      assert.equal(await noteRoom.flush(5_000), true);

      for (const [room, read, expected] of [
        ['_tree', (d) => d.getMap('nodes').get('n1')?.p, 'both.md'],
        ['n_AbCdEfGhIjKlMnOpQrStUv', (d) => d.getText('content').toString(), 'and the note too'],
      ]) {
        const observer = new Y.Doc();
        const check = new DocLink(server.url(room, workspace), observer);
        check.connect();
        assert.equal(await check.waitSync(5_000), true, `${room} observer never synced`);
        assert.equal(read(observer), expected, `${room} did not reach the server`);
        check.destroy();
        observer.destroy();
      }
      assert.equal(socketCount(), 1, 'the link opened a second socket while running');
    } finally {
      treeRoom.destroy(); noteRoom.destroy();
      link.destroy(); tree.destroy(); note.destroy();
    }
  });

  test('80e reconnect re-handshakes every room on the one socket, and nothing is lost', async () => {
    const server = getServer();
    const workspace = 'muxtree80e';
    const tree = new Y.Doc();
    const note = new Y.Doc();
    const { link, opened, socketCount } = realLink(server, workspace, {
      backoffMs: [20],
      jitter: 0,
    });
    const treeRoom = new MuxRoom(link, '_tree', tree);
    const noteRoom = new MuxRoom(link, 'n_ZyXwVuTsRqPoNmLkJiHgFe', note);
    try {
      link.connect();
      assert.equal(await treeRoom.whenSynced(5_000), true);
      assert.equal(await noteRoom.whenSynced(5_000), true);

      // The socket dies under both rooms at once, which is the event the mux
      // makes shared: one drop is every room's drop.
      opened[0].terminate();
      // ⚠ Both rooms, from ONE drop. `terminate()` moves `readyState` to CLOSED
      // in this tick while the close EVENT lands on a later one, so the room's
      // `synced` is the conjunction of a completed handshake and a live link —
      // this case is what found that window.
      assert.equal(
        await until(() => !treeRoom.synced && !noteRoom.synced, 3_000), true,
        'a dead socket left a room claiming to be synced',
      );
      assert.equal(link.connected, false, 'the link never noticed');

      // Edits made while it was down go up as real Yjs deltas on reconnect.
      tree.getMap('nodes').set('n1', { k: 'f', p: 'offline.md' });
      note.getText('content').insert(0, 'written while offline');

      assert.equal(await until(() => link.connected, 8_000), true, 'the ladder never reconnected');
      assert.equal(await treeRoom.whenSynced(5_000), true, 'the tree never re-synced');
      assert.equal(await noteRoom.whenSynced(5_000), true, 'the note never re-synced');
      assert.equal(await treeRoom.flush(5_000), true);
      assert.equal(await noteRoom.flush(5_000), true);
      assert.equal(socketCount(), 2, `one reconnect dialled ${socketCount()} sockets in total`);

      const observer = new Y.Doc();
      const check = new DocLink(server.url('n_ZyXwVuTsRqPoNmLkJiHgFe', workspace), observer);
      check.connect();
      assert.equal(await check.waitSync(5_000), true);
      assert.equal(observer.getText('content').toString(), 'written while offline',
        'the offline edit never reached the server after reconnect');
      check.destroy();
      observer.destroy();
    } finally {
      treeRoom.destroy(); noteRoom.destroy();
      link.destroy(); tree.destroy(); note.destroy();
    }
  });


  test('80f a server whose /_mux upgrade is REFUSED still gets a verdict, and the tree', async () => {
    // ⚠ Against a REAL server behind a proxy that answers 404 on `/_mux` and
    // forwards every other path — the canonical reverse-proxy misconfiguration,
    // and INSTALL.md tells self-hosters to put a proxy in front without giving
    // them a config. The finding this case exists for is that NOTHING used to
    // happen: every route into the legacy verdict needs a socket that OPENED, and
    // a refused upgrade never produces one. Measured before the fix:
    // `whenSynced(15000)` false, verdict empty, notice never shown, the link
    // dialling for ever — while a plain per-room client on the SAME path synced.
    const server = getServer();
    const workspace = 'muxtree80f';
    const proxy = hostileProxy({ listen: refusePort, target: server.port, mode: 'refuse' });
    await proxy.start();
    const url = `ws://127.0.0.1:${refusePort}`;
    const tree = new TreeDoc();
    const opened = [];
    const link = new MuxLink({
      serverUrl: url,
      serverKey: server.serverKey,
      workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); opened.push(s); return s; },
    });
    const notices = [];
    const transport = openTreeTransport(
      link, tree.doc,
      { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
      (reason) => notices.push(reason),
    );
    // ⚠ THE ONLY EXIT FROM READ-ONLY, registered exactly where `main.ts` registers
    // it. `Bootstrap.onReconnect` is both the §4.6 reconnect pass and the one
    // thing that clears `_readOnlyReason`, and the adopted probe is by
    // construction already connected when the swap happens — so a bridge that
    // only waits for the next TRANSITION hands the session no way out. Measured
    // before the fix on this very path: verdict at 2,318 ms, `synced` true from
    // then on, and zero fires across 34 s.
    const connects = [];
    transport.onConnected(() => connects.push(Date.now()));
    const peer = new Y.Doc();
    const peerLink = new DocLink(server.url('_tree', workspace), peer);
    try {
      const started = Date.now();
      transport.connect();

      assert.equal(await transport.whenSynced(TREE_SYNC_TIMEOUT_MS), true,
        'a blocked /_mux route left the tree unsynced against a server that works');
      const took = Date.now() - started;
      assert.ok(took < TREE_SYNC_TIMEOUT_MS,
        `the fallback took ${took}ms, past the tree's own ${TREE_SYNC_TIMEOUT_MS}ms deadline`);

      assert.deepEqual(notices, ['unreachable'],
        `expected the route verdict, got ${JSON.stringify(notices)}`);
      assert.equal(link.unsupportedReason, 'unreachable');
      // ⚠ And the sentence must not be the OTHER one: this server is current.
      assert.equal(legacyNoticeFor('unreachable'), MUX_UNREACHABLE_NOTICE);

      tree.doc.getMap('nodes').set('n1', { k: 'f', p: 'blocked-route.md' });
      peerLink.connect();
      assert.equal(await peerLink.waitSync(5_000), true, 'the observer never synced');
      assert.equal(
        await until(() => peer.getMap('nodes').get('n1')?.p === 'blocked-route.md', 5_000), true,
        'the fallback never reached the server through the route that does work',
      );

      assert.equal(connects.length, 1,
        `the swap delivered ${connects.length} connected transitions, so a session that`
        + ' had gone read-only before it has no way back');
      assert.equal(transport.connected, true);

      const dialled = opened.length;
      await sleep(300);
      assert.equal(opened.length, dialled, 'the link kept dialling a route already refused');
    } finally {
      transport.destroy(); link.destroy();
      peerLink.destroy(); peer.destroy(); tree.doc.destroy();
      await proxy.stop();
    }
  });

  test('80g a server rolled back to a pre-P3 build is demoted, and the tree keeps syncing', async () => {
    // ⚠ Against two REAL processes on the same port and the same data dir. The
    // latch that made this a silent permanent stall was link-wide: measured, the
    // ladder reconnected in 180 ms, `unsupportedReason` stayed null, no notice
    // fired, `whenSynced(15000)` was false and the post-swap edit never reached
    // the server — until Obsidian was restarted. The latch is per SOCKET now, so
    // the replacement is examined on what IT says.
    const workspace = 'muxtree80g';
    let current = await startServer({ port: swapPort });
    const dir = current.dir;
    const key = current.serverKey;
    const url = `ws://127.0.0.1:${swapPort}`;
    const tree = new TreeDoc();
    const link = new MuxLink({
      serverUrl: url, serverKey: key, workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
      backoffMs: [50], jitter: 0,
    });
    const notices = [];
    const transport = openTreeTransport(
      link, tree.doc, { serverUrl: url, serverKey: key, workspaceId: workspace },
      (reason) => notices.push(reason),
    );
    let rolled = null;
    const peer = new Y.Doc();
    let peerLink = null;
    try {
      transport.connect();
      assert.equal(await transport.whenSynced(8_000), true, 'the tree never synced on the mux');
      assert.equal(link.unsupportedReason, null);

      await current.stop();
      rolled = await startServer({ port: swapPort, dir, entry: LEGACY_ENTRY });
      assert.equal(rolled.serverKey, key, 'the rolled-back server has a different key');

      assert.equal(await until(() => link.unsupportedReason !== null, 15_000), true,
        'the replacement server was never examined');
      assert.deepEqual(notices, ['not-a-frame'],
        `expected the first-message verdict, got ${JSON.stringify(notices)}`);

      assert.equal(await transport.whenSynced(TREE_SYNC_TIMEOUT_MS), true,
        'the tree never synced against the server it was rolled back to');
      tree.doc.getMap('nodes').set('n1', { k: 'f', p: 'after-rollback.md' });

      peerLink = new DocLink(rolled.url('_tree', workspace), peer);
      peerLink.connect();
      assert.equal(await peerLink.waitSync(5_000), true);
      assert.equal(
        await until(() => peer.getMap('nodes').get('n1')?.p === 'after-rollback.md', 5_000), true,
        'the edit never reached the rolled-back server',
      );
    } finally {
      transport.destroy(); link.destroy();
      peerLink?.destroy(); peer.destroy(); tree.doc.destroy();
      if (rolled !== null) { await rolled.stop(); rolled.cleanup(); }
      else { await current.stop(); current.cleanup(); }
    }
  });

  test('80h a socket that is OPEN and dead is noticed, and the ladder brings the room back', async () => {
    // ⚠ THE PATH IS REALLY FROZEN: a TCP proxy that stops forwarding in both
    // directions with no FIN and no RST, which is what a dropped NAT flow, a
    // slept laptop and a wifi handover all look like. `readyState` never moves,
    // so nothing that reads it can tell. Measured before the watchdog existed:
    // `connected` and `synced` both true for the whole 78 s the probe watched,
    // while a `WebsocketProvider` on the identical frozen path dropped its socket
    // at 30,266 ms.
    //
    // The TIMEOUT here is short so the suite stays fast; the shipped 30 s is
    // pinned by the unit test, and what only a real socket can settle is that a
    // frozen path really does look alive until something asks.
    const server = getServer();
    const workspace = 'muxtree80h';
    const proxy = freezableProxy({ listen: freezePort, target: server.port });
    const url = await proxy.start();
    const doc = new Y.Doc();
    const opened = [];
    const link = new MuxLink({
      serverUrl: url,
      serverKey: server.serverKey,
      workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); opened.push(s); return s; },
      idleTimeoutMs: 1_500,
      backoffMs: [50],
      jitter: 0,
    });
    const room = new MuxRoom(link, '_tree', doc);
    try {
      link.connect();
      assert.equal(await room.whenSynced(5_000), true, 'the room never synced');

      proxy.freeze();
      doc.getMap('nodes').set('n1', { k: 'f', p: 'written-into-the-void.md' });
      // The socket is still OPEN by every measure the platform offers.
      assert.equal(link.rawSocket?.readyState, 1, 'the frozen socket reported itself closed');

      assert.equal(await until(() => !room.synced, 6_000), true,
        'a room on a dead-but-open socket went on reporting itself synced');
      assert.equal(link.stats.idleClosures >= 1, true, 'nothing closed the dead socket');

      proxy.thaw();
      assert.equal(await until(() => link.connected && room.synced, 10_000), true,
        'the ladder never brought the room back once the path recovered');
      assert.equal(await room.flush(5_000), true, 'the recovered room could not confirm a flush');

      const observer = new Y.Doc();
      const check = new DocLink(server.url('_tree', workspace), observer);
      check.connect();
      assert.equal(await check.waitSync(5_000), true);
      assert.equal(observer.getMap('nodes').get('n1')?.p, 'written-into-the-void.md',
        'the edit made while the path was frozen never went up');
      check.destroy();
      observer.destroy();
    } finally {
      room.destroy(); link.destroy(); doc.destroy();
      await proxy.stop();
    }
  });

  test('80i a path that is merely SLOW keeps the mux — a demotion is not a stopwatch', async () => {
    // ⚠ MEASURED, against this exact shape. `MuxLink` bounds a dial, so on any path
    // whose upgrade is slower than the bound the mux could never open at all, and
    // the verdict that followed was a statement about the bound: through a proxy
    // delaying every connection on every route by 4.5 s, against this same shipped
    // server serving `/_mux` normally, the session was demoted at 14,952 ms — past
    // the bootstrap deadline — and shown a sentence blaming a proxy that was
    // forwarding every path.
    //
    // Two things now stop that, and this case holds both. A dial the client
    // abandoned may not condemn anything, so no number of them is a verdict; and
    // the deadline is a PATIENCE LADDER that widens on its own until the path is
    // reachable, then resets on the socket that opens. Neither measures anything.
    //
    // The BOUND here is short and the delay is short so the suite stays fast; what
    // matters is that the first rung is bounded UNDER what the path costs, which is
    // the whole of the failure. The shipped 4 s is pinned by the unit tests.
    const server = getServer();
    const workspace = 'muxtree80i';
    const proxy = slowProxy({ listen: slowPort, target: server.port, delayMs: 1_200 });
    const url = await proxy.start();
    const tree = new TreeDoc();
    const link = new MuxLink({
      serverUrl: url,
      serverKey: server.serverKey,
      workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
      connectTimeoutMs: 500,                      // first rung, well under the path's cost
      unreachableDials: 2,
    });
    const notices = [];
    const transport = openTreeTransport(
      link, tree.doc,
      { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
      (reason) => notices.push(reason),
    );
    const peer = new Y.Doc();
    const peerLink = new DocLink(server.url('_tree', workspace), peer);
    try {
      transport.connect({ immediate: true });

      assert.equal(await transport.whenSynced(TREE_SYNC_TIMEOUT_MS), true,
        'a slow path left the tree unsynced against a server that answers on it');
      assert.deepEqual(notices, [],
        `a slow path demoted a working session: ${JSON.stringify(notices)}`);
      assert.equal(link.unsupportedReason, null, 'the route was condemned for being slow');
      // And it is really the MUX that is carrying it, not the legacy fallback
      // quietly winning: the route served frames on this link.
      assert.equal(link.everServed, true, 'the mux route never opened at all');
      assert.ok(link.stats.framesIn > 0, 'nothing ever came back over /_mux');
      assert.equal(transport.connected, true,
        'the transport cannot say it is in the state its own onConnected announces');
      // Both halves of the ladder, against a real path: the fixed first rung really
      // was too tight here, and the deadline went back to it once a socket opened.
      assert.ok(link.stats.dialsAbandoned >= 1,
        'the first rung was not actually under what this path costs, so this proves nothing');
      assert.equal(link.dialTimeoutMs, 500,
        `the widened deadline outlived the trouble that raised it (${link.dialTimeoutMs}ms)`);
      assert.equal(saysUnserved(link, transport), false,
        'a path that merely took its time was described as delivering nothing');

      tree.doc.getMap('nodes').set('n1', { k: 'f', p: 'slow-path.md' });
      peerLink.connect();
      assert.equal(await peerLink.waitSync(5_000), true, 'the observer never synced');
      assert.equal(
        await until(() => peer.getMap('nodes').get('n1')?.p === 'slow-path.md', 5_000), true,
        'the edit never reached the server over the route that was kept',
      );
    } finally {
      transport.destroy(); link.destroy();
      peerLink.destroy(); peer.destroy(); tree.doc.destroy();
      await proxy.stop();
    }
  });

  test('80j a route that has answered is not condemned by a silence after a cut', async () => {
    // ⚠ SILENCE IS NEVER A VERDICT, produced against a real process. The proxy
    // passes the HTTP 101 through untouched and holds the server's first frame on
    // the SECOND connection only, so the redial after an ordinary RST is open,
    // written to, and quiet. A ten-second timer used to call that "your server is
    // older than this plugin" and mean it for the session: measured, synced over
    // `/_mux` in 11 ms with two frames in, one RST, condemned 11,299 ms later,
    // `connect()` a no-op afterwards and the room never syncing again.
    //
    // The hold is longer than that timer was, deliberately: a shorter one would
    // not notice the timer coming back.
    const server = getServer();
    const workspace = 'muxtree80j';
    const proxy = holdFirstFrameProxy({
      listen: holdPort, target: server.port, holdMs: 12_000, onlyNth: 2,
    });
    const url = await proxy.start();
    const doc = new Y.Doc();
    const link = new MuxLink({
      serverUrl: url,
      serverKey: server.serverKey,
      workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
      backoffMs: [50],
      jitter: 0,
    });
    const notices = [];
    link.onUnsupported((reason) => notices.push(reason));
    const room = new MuxRoom(link, '_tree', doc);
    try {
      link.connect();
      assert.equal(await room.whenSynced(5_000), true, 'the room never synced');
      assert.ok(link.stats.framesIn > 0, 'the route never proved it speaks the protocol');

      const dialsBefore = link.stats.socketsOpened;
      proxy.cutAll();
      doc.getMap('nodes').set('n1', { k: 'f', p: 'held-frame.md' });

      assert.equal(await until(() => link.stats.socketsOpened > dialsBefore, 8_000), true,
        'the ladder never redialled after the cut');
      assert.equal(await until(() => link.connected, 8_000), true,
        'the redial never opened its socket');
      const framesAtRedial = link.stats.framesIn;

      // Eleven seconds of an OPEN socket that has been written to and has said
      // nothing — one second inside the window that used to condemn it.
      await sleep(11_000);
      assert.equal(link.stats.framesIn, framesAtRedial,
        'the proxy released the held frame early, so this proves nothing');
      assert.equal(link.rawSocket?.readyState, 1, 'the quiet socket was not even open');
      assert.equal(room.synced, false, 'the room claimed a handshake it never completed');
      assert.deepEqual(notices, [],
        `a quiet socket on a proven route was condemned: ${JSON.stringify(notices)}`);
      assert.equal(link.unsupportedReason, null);

      assert.equal(await until(() => room.synced && link.connected, 20_000), true,
        'the room never came back once the held frame was released');
      assert.deepEqual(notices, [], 'a verdict landed while the frame was merely late');
      assert.equal(await room.flush(5_000), true, 'the recovered room could not confirm a flush');

      const observer = new Y.Doc();
      const check = new DocLink(server.url('_tree', workspace), observer);
      check.connect();
      assert.equal(await check.waitSync(5_000), true);
      assert.equal(observer.getMap('nodes').get('n1')?.p, 'held-frame.md',
        'the edit written while the answer was held never went up');
      check.destroy();
      observer.destroy();
    } finally {
      room.destroy(); link.destroy(); doc.destroy();
      await proxy.stop();
    }
  });

  test('80k a route blocked AFTER it has served is retried, not condemned', async () => {
    // ⚠ MEASURED, and the other half of "silence is never a verdict". The evidence
    // behind `unreachable` is a run of dials that produced no socket — which is
    // exactly what an outage, a slept radio, a proxy restart or a tunnel re-key
    // produce on a route that works. Before the gate: five to six seconds of
    // `/_mux`-only trouble on an otherwise-working server demoted the session
    // permanently, 3/3, and a flaky path demoted one that had already synced over
    // the mux at 28,115 ms. The parent branch of that round rode out ten cuts on
    // the same path and stayed.
    //
    // Here the proxy forwards `/_mux` until the link has PROVED the route, then
    // 404s it. The ladder is fast so the case is fast; the dials are real.
    const server = getServer();
    const workspace = 'muxtree80k';
    const proxy = hostileProxy({ listen: blockPort, target: server.port, mode: 'forward' });
    await proxy.start();
    const url = `ws://127.0.0.1:${blockPort}`;
    const tree = new TreeDoc();
    const link = new MuxLink({
      serverUrl: url,
      serverKey: server.serverKey,
      workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
      backoffMs: [150],
      jitter: 0,
      unreachableDials: 2,
    });
    const notices = [];
    const transport = openTreeTransport(
      link, tree.doc,
      { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
      (reason) => notices.push(reason),
    );
    try {
      transport.connect({ immediate: true });
      assert.equal(await transport.whenSynced(TREE_SYNC_TIMEOUT_MS), true,
        'the tree never synced over the forwarded /_mux route');
      assert.equal(link.everServed, true, 'the route never proved itself');

      // The route goes away underneath a session that has already used it.
      proxy.setMode('refuse');
      proxy.cutAll();
      const failedBefore = link.stats.dialsFailed;
      assert.equal(await until(() => link.stats.dialsFailed >= failedBefore + 4, 8_000), true,
        'the ladder stopped dialling a route it should be retrying');
      assert.deepEqual(notices, [],
        `a route that had served this link was condemned: ${JSON.stringify(notices)}`);
      assert.equal(link.unsupportedReason, null, 'a blocked route demoted a proven session');

      // And it comes back on its own when the route does.
      proxy.setMode('forward');
      assert.equal(await until(() => link.connected && transport.synced, 10_000), true,
        'the ladder never brought the mux back once the route returned');
      assert.equal(link.unsupportedReason, null);
      assert.deepEqual(notices, []);
    } finally {
      transport.destroy(); link.destroy(); tree.doc.destroy();
      await proxy.stop();
    }
  });

  test('80l a route that upgrades and then says NOTHING is reported, in words, to the user',
    async () => {
      // ⚠ THE HOLE DELETING THE LAST ABSENCE-VERDICT LEFT, against a real process.
      // Measured on the parent branch through this exact proxy: 70 s gave 3
      // sockets, 2 idle closures, 18 frames out, 0 in, no verdict, no notice, NO
      // PROBE EVER BUILT, the tree never synced — and the only thing on screen was
      // "ShadowLink could not reach the workspace", which is the one claim a
      // control client on the same path disproves.
      //
      // Nothing here infers a cause. The probe establishes that the server answers;
      // the link's own counters say nothing has come back; the bar says both and
      // names the setting. The idle timeout is short so the case is fast — the
      // shipped 30 s is pinned by the unit tests.
      const server = getServer();
      const workspace = 'muxtree80l';
      const proxy = deafMuxProxy({ listen: deafPort, target: server.port });
      const url = await proxy.start();
      const tree = new TreeDoc();
      const link = new MuxLink({
        serverUrl: url,
        serverKey: server.serverKey,
        workspaceId: workspace,
        openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
        idleTimeoutMs: 1_500,
        backoffMs: [100],
        jitter: 0,
        unreachableDials: 2,
      });
      const notices = [];
      const transport = openTreeTransport(
        link, tree.doc,
        { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
        (reason) => notices.push(reason),
      );
      const peer = new Y.Doc();
      const peerLink = new DocLink(`${url}/_tree?t=${encodeURIComponent(server.serverKey)}&w=${workspace}`, peer);
      try {
        transport.connect({ immediate: true });

        // The route really is deaf, and really is open: frames go out and the
        // upgrade succeeded.
        assert.equal(await until(() => link.stats.framesOut > 0, 8_000), true,
          'nothing was ever written into the route, so it was never asked anything');
        assert.equal(link.stats.framesIn, 0, 'the proxy let something through, so this proves nothing');

        assert.equal(await until(() => saysUnserved(link, transport), 20_000), true,
          'a route that upgrades and answers nothing produced no statement at all');
        assert.equal(link.unsupportedReason, null,
          'a silence was turned into a verdict about the server');
        assert.deepEqual(notices, [],
          `the user was told something about their server: ${JSON.stringify(notices)}`);
        assert.equal(link.stats.framesIn, 0);
        // ⚠ ON THE FIRST CLOSURE, not the second. The report that builds the probe
        // arrives before the probe has connected, so the decision has to be retaken
        // when the probe can answer rather than waiting for the next one — measured
        // against this shape at the shipped 30 s watchdog, the statement reached the
        // bar at 60,447 ms without that and at 30,267 ms with it.
        assert.equal(link.stats.idleClosures, 1,
          `the statement waited ${link.stats.idleClosures} liveness cycles for evidence that`
          + ' was complete after one');

        // ⚠ WHAT A USER ACTUALLY SEES, composed the way `main.ts` composes it, with
        // the read-only sentence a bootstrap would have produced already up.
        const bar = barFor(link, {
          witness: transport,
          paused: 'ShadowLink could not reach the workspace. Editing locally; sync is paused.',
        });
        assert.equal(bar.text, 'ShadowLink: not syncing');
        assert.match(bar.tooltip, /can reach your server/);
        assert.match(bar.tooltip, /none have come back/);
        assert.match(bar.tooltip, /"Use the compatibility connection"/,
          'the one remedy the user has was not named where they are looking');
        assert.equal(bar.tooltip.includes('could not reach'), false,
          'the bar repeated the claim this case disproves');

        // And the claim is TRUE: the server answers on the route that works.
        peerLink.connect();
        assert.equal(await peerLink.waitSync(8_000), true,
          'the control client could not sync either, so "can reach your server" is false');

        // It is a state, not a latch: the link goes on retrying, and nothing decides.
        const sockets = link.stats.socketsOpened;
        await sleep(2_500);
        assert.ok(link.stats.socketsOpened > sockets, 'the link stopped retrying the route');
        assert.equal(link.unsupportedReason, null);
        assert.equal(saysUnserved(link, transport), true);
        assert.deepEqual(notices, []);
      } finally {
        transport.destroy(); link.destroy();
        peerLink.destroy(); peer.destroy(); tree.doc.destroy();
        await proxy.stop();
      }
    });

  test('80m a black-holed /_mux upgrade says only what is true of it: nothing', async () => {
    // ⚠ A DELIBERATE NARROWING, RECORDED HERE WITH BOTH ITS COSTS, and it has now
    // been narrowed twice. On the parent branch this shape produced `unreachable`
    // at 12,993 ms and the tree synced over the adopted legacy probe; that verdict
    // rested entirely on dials the CLIENT ended, and a variable-latency path
    // serving `/_mux` normally produced dials of exactly the same shape — a
    // permanent false demotion at 14,527 ms. So the verdict went.
    //
    // What replaced it was the honest statement, reached from the same expired
    // deadlines — and that was the same mistake one level down. Measured against a
    // HEALTHY server serving `/_mux` correctly behind a proxy forwarding every
    // byte and merely delaying each connection by 13 s: "ShadowLink can reach your
    // server, but nothing is coming back on its multiplexed connection",
    // permanently, from 26,177 ms, `dialsRefused` 0. A deadline is not an
    // observation about the route in either direction.
    //
    // So this shape now gets no verdict, no statement and no probe. What the user
    // sees is the read-only sentence, which is true: this device could not reach
    // the workspace. The lever is still in Settings under "This device", and 80n
    // proves it works on exactly this shape.
    const server = getServer();
    const workspace = 'muxtree80m';
    const proxy = hostileProxy({ listen: holePort, target: server.port, mode: 'blackhole' });
    await proxy.start();
    const url = `ws://127.0.0.1:${holePort}`;
    const tree = new TreeDoc();
    const link = new MuxLink({
      serverUrl: url,
      serverKey: server.serverKey,
      workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
      connectTimeoutMs: 400,
      backoffMs: [100],
      jitter: 0,
      unreachableDials: 2,
    });
    const notices = [];
    const transport = openTreeTransport(
      link, tree.doc,
      { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
      (reason) => notices.push(reason),
    );
    try {
      transport.connect({ immediate: true });

      // Long enough for four rungs of the ladder on this proxy, which is what used
      // to be enough for the verdict AND for the statement.
      assert.equal(await until(() => link.stats.dialsAbandoned >= 4, 20_000), true,
        'no dial actually ran out of time, so this proves nothing');
      assert.equal(link.stats.dialsRefused, 0, 'the path refused something after all');
      assert.equal(link.routeRefused, false);
      assert.equal(link.unsupportedReason, null,
        'a run of the client\'s own deadlines condemned the route');
      assert.equal(saysUnserved(link, transport), false,
        'a run of the client\'s own deadlines produced a sentence about the route');
      assert.deepEqual(notices, [],
        `the user was told about their server from a stopwatch: ${JSON.stringify(notices)}`);
      assert.equal(link.stats.socketsOpened > 0, true, 'no dial was ever made');
      assert.equal(link.stats.framesOut, 0, 'a socket opened, so this is the wrong shape');

      // And what the user sees is the read-only sentence, unimproved and true.
      const paused = 'ShadowLink could not reach the workspace. Editing locally; sync is paused.';
      const bar = barFor(link, { witness: transport, paused });
      assert.equal(bar.text, 'ShadowLink: paused');
      assert.equal(bar.tooltip, paused);
    } finally {
      transport.destroy(); link.destroy(); tree.doc.destroy();
      await proxy.stop();
    }
  });

  test('80n the compatibility connection syncs the tree on the route that defeated the mux',
    async () => {
      // ⚠ THE LEVER, ON THE SHAPE IT IS FOR, and it is the reason 80l and 80m are
      // allowed to end with an unsynced tree. `main.ts` builds exactly this when
      // `useCompatibilityConnection` is on: the mux is never dialled at all, and
      // the transport is the one the plugin used before slice 2.
      const server = getServer();
      const workspace = 'muxtree80n';
      const proxy = deafMuxProxy({ listen: leverPort, target: server.port });
      const url = await proxy.start();
      const tree = new TreeDoc();
      const transport = new LegacyTreeTransport(
        { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
        tree.doc,
      );
      const peer = new Y.Doc();
      const peerLink = new DocLink(server.url('_tree', workspace), peer);
      try {
        transport.connect();
        assert.equal(await transport.whenSynced(TREE_SYNC_TIMEOUT_MS), true,
          'the one remedy the status bar names does not work on the shape it names it for');
        assert.equal(transport.connected, true);

        tree.doc.getMap('nodes').set('n1', { k: 'f', p: 'compatibility.md' });
        peerLink.connect();
        assert.equal(await peerLink.waitSync(5_000), true, 'the observer never synced');
        assert.equal(
          await until(() => peer.getMap('nodes').get('n1')?.p === 'compatibility.md', 5_000), true,
          'the compatibility connection never reached the server',
        );

        // And it says so, on every state, including this one.
        const bar = barFor(null, {
          ready: true,
          compatibility: { active: true, requested: true, chosen: true },
        });
        assert.equal(bar.text, 'ShadowLink: synced');
        assert.match(bar.tooltip, /using the compatibility connection/);
        assert.match(bar.tooltip, /Turn it off/);

        // ⚠ AND THE INSTANT AFTER THE TOGGLE, THE BAR SAYS WHAT IS ACTUALLY
        // RUNNING. The transport is chosen once, when the plugin loads, so the
        // setting is an intention until the reload — and this session is still on
        // the connection it built, whichever way the toggle has just gone.
        // Measured on the parent's wiring: thrown on at 40,146 ms with no reload,
        // one tooltip told the user to turn the setting on and that it was already
        // in force; turned off at 20,138 ms, the sentence disclosing the cost
        // simply vanished from a session still paying it.
        const justTurnedOff = barFor(null, {
          ready: true,
          compatibility: { active: true, requested: false, chosen: true },
        });
        assert.match(justTurnedOff.tooltip, /still using the compatibility connection/,
          'a session still on the compatibility connection stopped disclosing it');
        assert.match(justTurnedOff.tooltip, /Reload the plugin/);

        const justTurnedOn = barFor(null, {
          ready: true,
          compatibility: { active: false, requested: true, chosen: false },
        });
        assert.match(justTurnedOn.tooltip, /still using the multiplexed connection/,
          'a session still on the mux claimed the fix was already in force');
        assert.match(justTurnedOn.tooltip, /Reload the plugin to apply it/);
      } finally {
        transport.destroy();
        peerLink.destroy(); peer.destroy(); tree.doc.destroy();
        await proxy.stop();
      }
    });

  test('80o the sentence is retracted when the server it claims is reachable dies',
    async () => {
      // ⚠ MEASURED AS A FALSE SENTENCE OF THIS ROUND'S OWN MAKING, and the
      // ordinary case rather than an exotic one: a server restarting, a laptop
      // closing, a Wi-Fi association dropping. Deaf `/_mux`, statement latched at
      // 30,360 ms, the server PROCESS killed at 45,000 ms — and from 45 s to 80 s
      // the bar still read "ShadowLink can reach your server, but nothing is
      // coming back … 11 message(s) have gone out on it", while `dialsRefused`
      // climbed to 11 and a control per-room client could not reach the server at
      // all. It also OUTRANKS `paused`, so it hid the sentence that had just
      // become true. This case owns its own server because it kills it.
      const own = await startServer({ port: killPort });
      const workspace = 'muxtree80o';
      const proxy = deafMuxProxy({ listen: killProxyPort, target: killPort });
      const url = await proxy.start();
      const tree = new TreeDoc();
      const link = new MuxLink({
        serverUrl: url,
        serverKey: own.serverKey,
        workspaceId: workspace,
        openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
        idleTimeoutMs: 1_500,
        backoffMs: [100],
        jitter: 0,
        unreachableDials: 2,
      });
      const notices = [];
      const transport = openTreeTransport(
        link, tree.doc,
        { serverUrl: url, serverKey: own.serverKey, workspaceId: workspace },
        (reason) => notices.push(reason),
      );
      try {
        transport.connect({ immediate: true });
        assert.equal(await until(() => saysUnserved(link, transport), 20_000), true,
          'the deaf route never produced the statement this case is about retracting');

        const paused = 'ShadowLink could not reach the workspace. Editing locally; sync is paused.';
        assert.equal(barFor(link, { witness: transport, paused }).text, 'ShadowLink: not syncing');

        // The server goes away. Nothing about the route changes; what changes is
        // that the claim the sentence rests on has stopped being true.
        await own.stop();

        assert.equal(await until(() => link.stats.dialsRefused > 0, 20_000), true,
          'the dead server produced no refused dial, so this proves nothing');
        assert.equal(await until(() => !saysUnserved(link, transport), 10_000), true,
          'the bar went on claiming a dead server was reachable');
        assert.equal(link.unsupportedReason, null,
          'a server that is merely gone was condemned as a blocked route');
        assert.deepEqual(notices, [],
          `the user was told about their deployment: ${JSON.stringify(notices)}`);

        // And the sentence that IS true is no longer suppressed.
        const bar = barFor(link, { witness: transport, paused });
        assert.equal(bar.text, 'ShadowLink: paused');
        assert.equal(bar.tooltip, paused);
      } finally {
        transport.destroy(); link.destroy(); tree.doc.destroy();
        await proxy.stop();
        await own.stop();
        own.cleanup();
      }
    });

  test('80p a route that went deaf and is THEN refused still reaches the verdict', async () => {
    // ⚠ A REGRESSION AGAINST THE PARENT, MEASURED WITH THE SAME PROBE ON BOTH, and
    // the ordering is what a proxy reload does rather than anything exotic. On the
    // parent the deaf phase produced no report, so the refusal phase reached
    // `unreachable` in 248 ms with the notice and a synced tree; on this branch's
    // first cut the deaf phase's answer latched the bridge shut and 25 s and 368
    // REFUSED dials later `unsupportedReason` was still null with `routeRefused`
    // true the whole time. Nothing may become unreachable for a session because of
    // the order two shapes arrived in.
    const server = getServer();
    const workspace = 'muxtree80p';
    const proxy = deafMuxProxy({ listen: reloadPort, target: server.port });
    const url = await proxy.start();
    const tree = new TreeDoc();
    const link = new MuxLink({
      serverUrl: url,
      serverKey: server.serverKey,
      workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
      idleTimeoutMs: 1_500,
      backoffMs: [100],
      jitter: 0,
      unreachableDials: 2,
    });
    const notices = [];
    const transport = openTreeTransport(
      link, tree.doc,
      { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
      (reason) => notices.push(reason),
    );
    try {
      transport.connect({ immediate: true });
      assert.equal(await until(() => saysUnserved(link, transport), 20_000), true,
        'the deaf phase never reported, so the ordering this case is about never happened');

      // The proxy is reloaded into the OTHER misconfiguration: 404 on `/_mux`,
      // every other path still forwarded, and the live pairs RST.
      proxy.refuseMux();
      proxy.cutAll();

      assert.equal(await until(() => link.unsupportedReason === 'unreachable', 20_000), true,
        'a route the path is now refusing could not be condemned, because an earlier '
        + 'answer had shut the only door to the verdict');
      assert.deepEqual(notices, ['unreachable']);
      assert.ok(link.stats.dialsRefused >= 2, 'the verdict rested on something else');
      assert.equal(await until(() => transport.synced, 20_000), true,
        'the tree never reached the route that works');
      assert.equal(saysUnserved(link, transport), false,
        'a session that had already fallen back was still told nothing was syncing');
      // The third retraction, read where the user reads it: after the fallback the
      // mux is not what carries the tree, so "nothing is syncing" would be false.
      const bar = barFor(link, { witness: transport, ready: true });
      assert.equal(bar.text, 'ShadowLink: synced');
      assert.equal(bar.tooltip.includes('nothing is coming back'), false,
        'a synced session was told its multiplexed connection was delivering nothing');
    } finally {
      transport.destroy(); link.destroy(); tree.doc.destroy();
      await proxy.stop();
    }
  });

  test('80q a server that was down when the client started is not demoted for it', async () => {
    // ⚠ MEASURED AS A NEW PERMANENT FALSE DEMOTION, and it is a plain restart: a
    // real `server/index.js` stopped before the client starts and restarted D ms
    // later, then serving `/_mux` normally for the rest of the run. A false
    // `unreachable` and the proxy-blaming notice on 5 of 12 outage lengths and on
    // 5 of 5 repeats at D = 2,000 ms, where the parent produced 0 of 12 — the
    // notice firing while the dial that was about to succeed was still in flight,
    // on refusals counted entirely while the server was down.
    //
    // A verdict is one sentence about one moment: the server answers AND this path
    // refuses this route. Nothing here ever observes both at once.
    const workspace = 'muxtree80q';
    const first = await startServer({ port: outagePort });
    const { serverKey, dir } = first;
    // The per-room route comes back at once and `/_mux` takes two seconds, which
    // is what makes the ordering the defect needs happen every time rather than
    // when y-websocket's backoff lands right. See `slowMuxProxy`.
    const proxy = slowMuxProxy({ listen: outageProxyPort, target: outagePort, delayMs: 2_000 });
    const url = await proxy.start();
    await first.stop();                          // down before the client starts

    const tree = new TreeDoc();
    const link = new MuxLink({
      serverUrl: url,
      serverKey,
      workspaceId: workspace,
      openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
      backoffMs: [150],
      jitter: 0,
      unreachableDials: 2,
    });
    const notices = [];
    const transport = openTreeTransport(
      link, tree.doc, { serverUrl: url, serverKey, workspaceId: workspace },
      (reason) => notices.push(reason),
    );
    let second = null;
    try {
      transport.connect({ immediate: true });
      assert.equal(await until(() => link.routeRefused, 20_000), true,
        'the outage produced no run of refused dials, so this proves nothing');

      second = await startServer({ port: outagePort, dir });
      // The probe answers first, on a route that is up; the mux dial that is going
      // to succeed is still in flight; and the refusals behind it were all counted
      // while nobody knew whether the server existed. On the parent's rule that is
      // the whole of a verdict.
      assert.equal(await until(() => link.everServed, 30_000), true,
        'the mux never came back on a server that is serving /_mux normally');
      assert.equal(link.unsupportedReason, null,
        'refusals gathered while the server was down were cashed in by its recovery');
      assert.deepEqual(notices, [],
        `the user was told to reconfigure a proxy that is fine: ${JSON.stringify(notices)}`);
      assert.equal(await until(() => transport.synced, 20_000), true,
        'the tree never synced over the route that works');
      assert.equal(saysUnserved(link, transport), false,
        'a working route was described as delivering nothing');
      assert.equal(barFor(link, { witness: transport, ready: true }).text, 'ShadowLink: synced');
    } finally {
      transport.destroy(); link.destroy(); tree.doc.destroy();
      await proxy.stop();
      if (second !== null) await second.stop();
      first.cleanup();
    }
  });

  test('80r the sentence ends when the route it rests on stops answering, refused or not',
    async () => {
      // ⚠ THE SHAPE NO REFUSED DIAL COVERS, isolated. The mux route behaves exactly
      // as it did when the sentence first became true — it still upgrades, it is
      // still deaf, and NOTHING IS REFUSED — while the per-room route the claim
      // "ShadowLink can reach your server" rests on stops answering. There is no
      // retraction to fire: the sentence is computed from the probe's live `synced`,
      // and y-websocket clears that on the close. The plugin simply stops being able
      // to say it.
      //
      // This case used to wait out `TREE_SYNC_TIMEOUT_MS` for a REBUILT probe to
      // fail — 18,337 ms measured — because the answer had been copied onto the
      // link and only a fresh probe could take it back. Nothing is copied now, so
      // the claim ends with the socket rather than a window later.
      const server = getServer();
      const workspace = 'muxtree80r';
      const proxy = deafMuxProxy({ listen: holdOtherPort, target: server.port });
      const url = await proxy.start();
      const tree = new TreeDoc();
      const link = new MuxLink({
        serverUrl: url,
        serverKey: server.serverKey,
        workspaceId: workspace,
        openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
        idleTimeoutMs: 1_500,
        backoffMs: [100],
        jitter: 0,
        unreachableDials: 2,
      });
      const notices = [];
      const transport = openTreeTransport(
        link, tree.doc,
        { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
        (reason) => notices.push(reason),
      );
      const paused = 'ShadowLink could not reach the workspace. Editing locally; sync is paused.';
      try {
        transport.connect({ immediate: true });
        assert.equal(await until(() => saysUnserved(link, transport), 20_000), true,
          'the deaf route never produced the statement this case is about retracting');
        assert.equal(barFor(link, { witness: transport, paused }).text, 'ShadowLink: not syncing');

        const refusedBefore = link.stats.dialsRefused;
        // The per-room route goes dark and the live pairs are RST, which is what a
        // proxy reloaded into a config that has stopped forwarding it does. The mux
        // pair is cut too, but that socket HAD opened, so nothing is refused.
        proxy.holdOthers();
        proxy.cutAll();

        assert.equal(await until(() => !saysUnserved(link, transport), 20_000), true,
          'the bar went on claiming a server that had stopped answering was reachable');
        assert.equal(link.stats.dialsRefused, refusedBefore,
          'the route was refused after all, so this proves a different thing entirely');
        assert.equal(link.unsupportedReason, null, 'a retraction became a verdict');
        assert.deepEqual(notices, []);

        const bar = barFor(link, { witness: transport, paused });
        assert.equal(bar.text, 'ShadowLink: paused');
        assert.equal(bar.tooltip, paused);
      } finally {
        transport.destroy(); link.destroy(); tree.doc.destroy();
        await proxy.stop();
      }
    });

  test('80s a path that goes DARK ends the sentence, with nothing refused and nothing closed',
    async () => {
      // ⚠ THE DEFECT SIX ROUNDS OF THIS BRIDGE HAVE CARRIED, against real
      // processes. The sentence used to be a record on the link, and every one of
      // its four retractions needed the link to still be TALKING: a frame needs a
      // socket, a refused dial needs the path to REJECT, a condemnation needs a
      // verdict, a re-probe needs a report. A path that DROPS does none of those —
      // a firewall DROP rule, a drained load balancer, a dead VPN, a captive
      // portal, a server killed behind any of them.
      //
      // Measured on the previous branch at fully shipped constants: sentence at
      // 45,170 ms, path black-holed and RST at 45,188 ms, a control client unable
      // to reach the server from that instant, and at 105,236 ms the bar still
      // reading "ShadowLink can reach your server … 11 message(s) have gone out"
      // with `dialsRefused` 0 and `idleClosures` frozen at 1. Sixty seconds of a
      // false sentence outranking the true one, with no code path left that could
      // end it.
      //
      // The two counters this case pins are what make it the DARK shape rather
      // than one of the covered ones: no dial was refused (80o's retraction) and
      // no socket was closed by the watchdog (the re-probe's). Only the probe's
      // own liveness is left, and it is enough.
      const server = getServer();
      const workspace = 'muxtree80s';
      const proxy = deafMuxProxy({ listen: darkPort, target: server.port });
      const url = await proxy.start();
      const tree = new TreeDoc();
      const link = new MuxLink({
        serverUrl: url,
        serverKey: server.serverKey,
        workspaceId: workspace,
        openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
        idleTimeoutMs: 1_500,
        backoffMs: [100],
        jitter: 0,
        unreachableDials: 2,
      });
      const notices = [];
      const transport = openTreeTransport(
        link, tree.doc,
        { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
        (reason) => notices.push(reason),
      );
      const paused = 'ShadowLink could not reach the workspace. Editing locally; sync is paused.';
      try {
        transport.connect({ immediate: true });
        assert.equal(await until(() => saysUnserved(link, transport), 20_000), true,
          'the deaf route never produced the sentence this case is about ending');
        assert.equal(barFor(link, { witness: transport, paused }).text, 'ShadowLink: not syncing');

        const refusedBefore = link.stats.dialsRefused;
        const closuresBefore = link.stats.idleClosures;
        proxy.holdAll();                           // every new connection accepted, none answered
        proxy.cutAll();                            // and the live ones dropped

        assert.equal(await until(() => !saysUnserved(link, transport), 20_000), true,
          'the sentence outlived the path it was computed from');
        assert.equal(link.stats.dialsRefused, refusedBefore,
          'a dial was refused, so this is 80o\'s shape rather than the dark one');
        assert.equal(link.unsupportedReason, null, 'a path going quiet became a verdict');
        assert.deepEqual(notices, []);

        // And the one sentence that IS true of a device with no path is the one on
        // the bar, rather than being outranked by a claim nothing can still support.
        const bar = barFor(link, { witness: transport, paused });
        assert.equal(bar.text, 'ShadowLink: paused');
        assert.equal(bar.tooltip, paused);
        assert.equal(bar.tooltip.includes('can reach your server'), false);
        // ⚠ The watchdog is what the OTHER retraction needed, and this case proves
        // it never ran: the mux socket was RST rather than closed for being deaf.
        assert.ok(link.stats.idleClosures <= closuresBefore + 1,
          'the liveness watchdog did the work, so the dark path was never isolated');
      } finally {
        transport.destroy(); link.destroy(); tree.doc.destroy();
        await proxy.stop();
      }
    });

  test('80t a refusal run that breaks with no socket ever opening still says something',
    async () => {
      // ⚠ THE SECOND BLOCKER, AND IT IS A LIFETIME BUG RATHER THAN A BELIEF. A
      // proxy that 404s the first two `/_mux` upgrades and then BLACK-HOLES every
      // one after: a backend that is down when the client starts and then comes up
      // listening but not yet answering upgrades — a proxy mid-reload, a restarting
      // backend, the slow proxy INSTALL.md sends self-hosters to. Every other route
      // is forwarded untouched throughout, so the server is reachable the whole
      // time.
      //
      // Two refusals build the probe; the probe answers; the run is then broken by
      // a dial this client abandoned; and `reportRoute`'s only two callers are a
      // refusal run (never again) and the watchdog on an OPEN socket (never again).
      // Measured on the previous branch at fully shipped constants, 80 s: no
      // verdict, NO SENTENCE OF ANY KIND, `dialsRefused` frozen at 2,
      // `dialsAbandoned` 6, `idleClosures` 0, a bar reading "ShadowLink could not
      // reach the workspace" — and a live, SYNCED provider nobody owned, through
      // which the local edit was reaching the server the whole time. The plugin's
      // own socket disproved its own bar.
      //
      // Nothing has to re-enter any decision now. The probe's lifetime belongs to
      // the question rather than to the report that asked it, so it is still up;
      // and the sentence is computed from it, so it is true while it is true.
      const server = getServer();
      const workspace = 'muxtree80t';
      const proxy = deafMuxProxy({ listen: strandPort, target: server.port });
      const url = await proxy.start();
      proxy.refuseMuxTimes(2);
      proxy.holdMux();
      const tree = new TreeDoc();
      const link = new MuxLink({
        serverUrl: url,
        serverKey: server.serverKey,
        workspaceId: workspace,
        openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
        idleTimeoutMs: 1_500,
        connectTimeoutMs: 700,
        backoffMs: [100],
        jitter: 0,
        unreachableDials: 2,
      });
      const notices = [];
      const transport = openTreeTransport(
        link, tree.doc,
        { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
        (reason) => notices.push(reason),
      );
      const paused = 'ShadowLink could not reach the workspace. Editing locally; sync is paused.';
      try {
        transport.connect({ immediate: true });

        // The run is gathered and then broken by this client's own deadline, with
        // no socket ever having opened.
        assert.equal(await until(() => link.stats.dialsAbandoned >= 2, 20_000), true,
          'the black hole never produced an abandoned dial, so this is another shape');
        assert.equal(link.stats.dialsRefused, 2, 'the refusal run was not what this case needs');
        assert.equal(link.routeRefused, false, 'the abandoned dial did not break the run');
        assert.equal(link.stats.framesOut, 0, 'a socket opened, so this is 80l\'s shape');
        assert.equal(link.stats.idleClosures, 0, 'the watchdog ran, so a report was still possible');

        // ⚠ AND THE SESSION IS NOT STUCK. The sentence is true and it names the one
        // lever this user has, on a shape where the previous branch said nothing at
        // all for as long as the session ran.
        assert.equal(await until(() => saysUnserved(link, transport), 20_000), true,
          'the session was left with no conclusion of any kind');
        assert.equal(link.unsupportedReason, null,
          'a black hole was condemned on refusals gathered before it started');
        assert.deepEqual(notices, []);

        const bar = barFor(link, { witness: transport, paused });
        assert.equal(bar.text, 'ShadowLink: not syncing');
        assert.match(bar.tooltip, /can reach your server/);
        // ⚠ THE ZERO-MESSAGE CLAUSE, REVIVED BY COMPUTING FROM CURRENT FACTS. The
        // previous round flagged it as dead in the shipped wiring and offered to
        // delete it; this is the shape that kills the mutant, and it is the shape a
        // real self-hoster behind a slow proxy is in.
        assert.match(bar.tooltip, /not carried a single message, in either direction/);
        assert.match(bar.tooltip, /"Use the compatibility connection"/,
          'the one remedy the user has was not named where they are looking');
        assert.equal(bar.tooltip.includes('could not reach'), false,
          'the bar repeated the claim the plugin\'s own live provider disproves');
      } finally {
        transport.destroy(); link.destroy(); tree.doc.destroy();
        await proxy.stop();
      }
    });

  test('80u a probe wedged on a half-open socket is replaced, and the session recovers',
    async () => {
      // ⚠ THE LAST OBJECT ON THIS BRANCH WITH NO BOUND ON ITSELF. The probe was
      // made session-long two rounds ago so that the sentence could be computed
      // from it rather than remembered, and it was given neither of the two bounds
      // the LINK had spent two rounds learning it needed on the same path. A
      // per-room socket whose TCP handshake completes and whose upgrade is never
      // answered — a firewall that swallows the SYN-ACK's successor, a proxy
      // mid-reload, a backend listening but not yet serving — sits in CONNECTING
      // for ever: `y-websocket`'s watchdog is guarded by `wsconnected` and its
      // reconnect runs out of `onclose`, so neither can fire, and `setupWS`
      // refuses to run again while `ws` is non-null.
      //
      // Measured on the parent through exactly this proxy at shipped constants,
      // twice, identically: probe built at 1,725 / 1,722 ms onto a half-open
      // socket, the per-room route HEALED in the same millisecond, and across
      // 140 s the proxy saw ONE non-mux connection. `serverAnswersElsewhere` false
      // throughout, 390 / 392 refused `/_mux` dials that could not become a verdict
      // because a verdict needs a SYNCED probe, no notice, and a tree that never
      // synced at all. The sentence and the automatic fallback both went down with
      // the probe, which is the reported harm.
      //
      // On this branch the same run reached the sentence at 5,757 ms — the probe
      // rebuilt at `MUX_CONNECT_TIMEOUT_MS`, 4,021 ms after the wedge — and the
      // verdict, the notice and a synced tree at 7,492 ms.
      const server = getServer();
      const workspace = 'muxtree80u';
      const proxy = deafMuxProxy({ listen: wedgePort, target: server.port });
      const url = await proxy.start();
      // The per-room route is a black hole BEFORE the probe is ever built, so the
      // probe's very first dial is the wedged one.
      proxy.holdOthers();
      const tree = new TreeDoc();
      const link = new MuxLink({
        serverUrl: url,
        serverKey: server.serverKey,
        workspaceId: workspace,
        openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
        idleTimeoutMs: 1_500,
        backoffMs: [100],
        jitter: 0,
        unreachableDials: 2,
      });
      const notices = [];
      const transport = openTreeTransport(
        link, tree.doc,
        { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
        (reason) => notices.push(reason),
        undefined,
        // The probe's dial bound at a tenth of its shipped value, for the same
        // reason every case here shortens the link's: the SHAPE is what is under
        // test, and 80a-80t would take four minutes at shipped constants. The
        // shipped value is what the measurement above ran at.
        { connectTimeoutMs: 700 },
      );
      const paused = 'ShadowLink could not reach the workspace. Editing locally; sync is paused.';
      try {
        transport.connect({ immediate: true });

        // The deaf `/_mux` route reports, the bridge builds its probe, and that
        // probe's socket is accepted and then abandoned by the path.
        assert.equal(await until(() => proxy.counts.othersHeld >= 1, 20_000), true,
          'the probe never dialled the per-room route, so nothing is wedged');
        assert.equal(proxy.counts.othersForwarded, 0,
          'the per-room route answered, so this is not the half-open shape');

        // And now the path is fine again. Nothing tells the client: the wedged
        // socket is still open, still connecting, and still silent.
        proxy.releaseOthers();

        assert.equal(await until(() => saysUnserved(link, transport), 20_000), true,
          'the wedged probe took the sentence down with it for the life of the run');
        assert.ok(proxy.counts.othersForwarded >= 1,
          'the sentence appeared without the probe ever having been replaced');
        assert.equal(link.unsupportedReason, null,
          'a probe that ran out of its own deadline condemned the route');
        assert.deepEqual(notices, [],
          'an absence of evidence was put in front of the user as a verdict');

        const bar = barFor(link, { witness: transport, paused });
        assert.equal(bar.text, 'ShadowLink: not syncing');
        assert.match(bar.tooltip, /can reach your server/);
        assert.match(bar.tooltip, /"Use the compatibility connection"/,
          'the one remedy the user has was not named where they are looking');

        // ⚠ AND THE AUTOMATIC FALLBACK IS ALIVE TOO, which is the other half of
        // the reported harm. The verdict needs a refusal reported while a probe is
        // SYNCED, so a wedged probe made the demotion unreachable for the session
        // — 390 refused dials against a null verdict, measured. The replacement is
        // a probe like any other, and the refusal run lands on it.
        proxy.refuseMux();
        assert.equal(await until(() => link.unsupportedReason !== null, 30_000), true,
          'the demotion this bridge exists to make was still unreachable');
        assert.equal(link.unsupportedReason, 'unreachable');
        assert.deepEqual(notices, ['unreachable']);
        assert.equal(await until(() => transport.synced, 20_000), true,
          'the tree never reached the route that was working the whole time');
        assert.equal(saysUnserved(link, transport), false,
          'a session that had already fallen back was told nothing was syncing');
      } finally {
        transport.destroy(); link.destroy(); tree.doc.destroy();
        await proxy.stop();
      }
    });

  test('80v a per-room handshake slower than the top rung still reaches a synced probe',
    async () => {
      // ⚠ THE SEVENTH ROUND'S FIX, ONE STEP OVER. Bounding the probe's dial closed
      // the wedge; borrowing the LINK's ceiling with it converted slow into dead.
      // `MUX_DIAL_PATIENCE` clamps at its top rung, so at shipped constants a
      // per-room handshake costing more than 12 s could never produce a synced
      // probe — and the sentence, the verdict, the notice and the tree all rest on
      // one that syncs. The link may clamp: a dial it abandons costs it a rung of
      // backoff and the route is still there to dial again. The probe may not: it
      // exists to WITNESS, and a witness that is always interrupted witnesses
      // nothing.
      //
      // Measured on the parent at fully shipped constants, real server behind this
      // proxy at 13 s: seven probe dials on the 4 / 8 / 12 / 12 … ladder, NOT ONE
      // of which ever completed its upstream connection, and across 70 s no
      // sentence, no verdict, no notice and a tree that never synced — verbatim
      // the sentence that made the wedge a blocker. At 25 s, ten dials across
      // 110 s and the same nothing. Pre-slice-2 master on the same 13 s path
      // simply cost 13,022 ms, so it was a regression against master as well.
      //
      // Here, same script and same shipped constants: 13 s path — sentence at
      // 38,580 ms, verdict, notice and a synced tree at 39,615 ms; 25 s path —
      // 74,471 / 75,266 / 75,267 ms. A 6 s path, inside the old ladder, is
      // untouched: 11,247 / 12,053 / 12,054 ms here against 11,245 / 12,435 /
      // 12,436 ms on the parent.
      //
      // This case is that shape at a tenth of the dial bound, the way every case
      // here shortens the link's: 700 ms rungs give a top SHIPPED rung of 2,100 ms,
      // and the path costs 2,600 ms — outside it, and reachable only because the
      // ladder goes on doubling.
      const server = getServer();
      const workspace = 'muxtree80v';
      const proxy = slowRoomProxy({
        listen: slowRoomPort, target: server.port, delayMs: 2_600,
      });
      const url = await proxy.start();
      const tree = new TreeDoc();
      const link = new MuxLink({
        serverUrl: url,
        serverKey: server.serverKey,
        workspaceId: workspace,
        openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
        idleTimeoutMs: 1_500,
        backoffMs: [100],
        jitter: 0,
        unreachableDials: 2,
      });
      const notices = [];
      const transport = openTreeTransport(
        link, tree.doc,
        { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
        (reason) => notices.push(reason),
        undefined,
        { connectTimeoutMs: 700 },
      );
      const paused = 'ShadowLink could not reach the workspace. Editing locally; sync is paused.';
      try {
        transport.connect({ immediate: true });

        assert.equal(await until(() => saysUnserved(link, transport), 40_000), true,
          'a per-room route that answers in 2,600 ms never produced a synced probe — '
          + 'the ceiling clamps the dial bound at 2,100 ms and the session dies slow. '
          + `dials=${proxy.counts.others} opened=${proxy.counts.othersOpened} `
          + `mux404=${proxy.counts.mux} verdict=${link.unsupportedReason}`);
        assert.ok(proxy.counts.othersOpened >= 1,
          'the sentence appeared without the per-room route ever having been served');
        assert.ok(proxy.counts.others >= 4,
          `only ${proxy.counts.others} per-room dials — the ladder never walked past its `
          + 'shipped rungs, so this run did not test the ceiling at all');

        const bar = barFor(link, { witness: transport, paused });
        assert.equal(bar.text, 'ShadowLink: not syncing');
        assert.match(bar.tooltip, /can reach your server/);
        assert.match(bar.tooltip, /"Use the compatibility connection"/,
          'the lever was not named to a user whose only route is the slow one');

        // And the automatic fallback lands on the replacement, exactly as it does
        // for the wedge: the verdict needs a refusal reported while a probe is
        // SYNCED, and until now this path has been deaf rather than refusing.
        proxy.refuseMux();
        assert.equal(await until(() => link.unsupportedReason !== null, 30_000), true,
          'the demotion was unreachable on a path that is merely slow');
        assert.equal(link.unsupportedReason, 'unreachable');
        assert.deepEqual(notices, ['unreachable']);
        assert.equal(await until(() => transport.synced, 20_000), true,
          'the tree never reached the route that was answering all along');
      } finally {
        transport.destroy(); link.destroy(); tree.doc.destroy();
        await proxy.stop();
      }
    });

  test('80w rebuilt probes accrue nothing on the tree doc — one Awareness for the session',
    async () => {
      // ⚠ "EACH IS DESTROYED AS THE NEXT IS BUILT, SO IT IS CHURN AND NOT A LEAK"
      // WAS FALSE. `WebsocketProvider.destroy()` clears its own intervals and
      // listeners and never calls `this.awareness.destroy()`; the `y-protocols`
      // `Awareness` it builds holds a 3-second `setInterval` and a
      // `doc.on('destroy')` listener. Everywhere else in this plugin that is
      // harmless, because every other provider owns its doc and destroys it, which
      // fires the `Awareness`'s own teardown. `LegacyTreeTransport` is the ONE
      // provider teardown handed a doc it does not own — the shared tree doc, which
      // lives for the session — so every probe teardown left both behind. On the
      // sixth round that was one per session; the rebuild loop made it an accrual.
      //
      // Measured through the SHIPPED bridge, 40 rebuilt probes on one doc: the
      // parent went 1 -> 41 `Y.Doc` 'destroy' observers and 1 -> 42 live
      // `Timeout`s, with 41 and 40 still standing after `transport.destroy()`.
      // Here: 1 -> 2 and 1 -> 3, and 2 / 0 after teardown. In isolation, 40 direct
      // build/destroy cycles left 40 of each on the parent and 0 timers here.
      //
      // ⚠ AND DESTROYING ONE PER PROBE ONLY FIXES THE TIMER. y-protocols registers
      // that `doc.on('destroy')` with an anonymous closure it never unregisters, so
      // an `Awareness` BUILT per probe leaves one observer per probe even when it
      // is destroyed. Hence one object for the session, handed to every probe —
      // which is the identity this case checks first.
      const server = getServer();
      const workspace = 'muxtree80w';
      const proxy = deafMuxProxy({ listen: accruePort, target: server.port });
      const url = await proxy.start();
      proxy.holdOthers();                          // the per-room route never answers
      const tree = new TreeDoc();
      // Yjs exposes no observer count, so the leak is read where it lives. The
      // live-`Timeout` count beside it is public API, and is the half a user feels.
      const observers = () => tree.doc._observers?.get('destroy')?.size ?? 0;
      const timers = () => process.getActiveResourcesInfo().filter((h) => h === 'Timeout').length;
      const link = new MuxLink({
        serverUrl: url,
        serverKey: server.serverKey,
        workspaceId: workspace,
        openSocket: (u) => { const s = new WebSocket(u); s.on('error', () => undefined); return s; },
        idleTimeoutMs: 1_500,
        backoffMs: [100],
        jitter: 0,
        unreachableDials: 2,
      });
      const handed = [];
      const beforeTimers = timers();
      const transport = openTreeTransport(
        link, tree.doc,
        { serverUrl: url, serverKey: server.serverKey, workspaceId: workspace },
        () => undefined,
        (config, doc) => { handed.push(config.awareness); return new LegacyTreeTransport(config, doc); },
        { connectTimeoutMs: 300 },
      );
      // Sampled AFTER construction and before any probe: `MuxTreeTransport` builds
      // a `MuxRoom`, which owns an `Awareness` of its own on this doc and adds the
      // observer that goes with it. What this case measures is what the PROBES add
      // on top of that, which must not depend on how many of them there are.
      const beforeObservers = observers();
      try {
        transport.connect({ immediate: true });
        assert.equal(await until(() => handed.length >= 5, 40_000), true,
          `only ${handed.length} probes were built, so nothing accrued to measure`);
        for (const [i, awareness] of handed.entries()) {
          assert.equal(awareness === handed[0], true,
            `probe ${i} was handed an Awareness of its own rather than the session's`);
        }
        assert.equal(observers() - beforeObservers, 1,
          `${handed.length} probes added ${observers() - beforeObservers} 'destroy' observers `
          + 'to a doc that lives for the session — one per probe is the accrual itself');
      } finally {
        transport.destroy(); link.destroy();
      }
      await sleep(500);
      const leakedTimers = timers() - beforeTimers;
      assert.ok(leakedTimers <= 2,
        `${handed.length} rebuilt probes left ${leakedTimers} live Timeouts behind after `
        + 'teardown — the provider was destroyed and the Awareness it built was not');
      assert.equal(observers() - beforeObservers, 1,
        'the session Awareness was not the only thing left on the doc');
      tree.doc.destroy();
      await proxy.stop();
    });

  test('80x the Awareness is released by whoever BUILT it, and by nobody else',
    async () => {
      // ⚠ THE BRANCH 80w CANNOT REACH, and the mutation sweep is what found that
      // out. Through the bridge every probe is handed the session's `Awareness`, so
      // `ownsAwareness` is false on that path and its teardown never runs. The
      // branch is entered where a `LegacyTreeTransport` is built DIRECTLY — which
      // is the compatibility lever in `main.ts`, and case 80n above. One per
      // session rather than one per probe, but a class that only cleans up after
      // itself when somebody else remembers to share an object with it is a class
      // that will leak the moment it is reused.
      //
      // Six real providers, one shared doc, a real server, and the count that is
      // public API. Against the teardown before this round: six extra live
      // `Timeout`s, exactly linear.
      const server = getServer();
      const workspace = 'muxtree80x';
      const tree = new TreeDoc();
      const timers = () => process.getActiveResourcesInfo().filter((h) => h === 'Timeout').length;
      const before = timers();
      try {
        for (let i = 0; i < 6; i += 1) {
          const transport = new LegacyTreeTransport(
            {
              serverUrl: `ws://127.0.0.1:${server.port}`,
              serverKey: server.serverKey,
              workspaceId: workspace,
            },
            tree.doc,
          );
          transport.connect();
          assert.equal(await transport.whenSynced(TREE_SYNC_TIMEOUT_MS), true,
            `provider ${i} never synced, so this run measured nothing`);
          transport.destroy();
        }
        await sleep(500);
        const leaked = timers() - before;
        assert.ok(leaked <= 2,
          `six built-and-destroyed providers left ${leaked} live Timeouts on a doc they do `
          + 'not own — WebsocketProvider.destroy() does not destroy the Awareness it built');

        // ⚠ AND THE OTHER SIDE OF THE SAME FLAG, which the mutation sweep is what
        // asked for: a BORROWED `Awareness` must survive the transport that
        // borrowed it, because on the shipped path it is the session's and the
        // next probe is about to be handed the very same object. Without this,
        // `ownsAwareness = true` survives every suite — the tree does not need
        // awareness to sync, so a probe quietly tearing down the session's one
        // shows up nowhere until something starts using it.
        const shared = new awarenessProtocol.Awareness(tree.doc);
        let released = false;
        shared.on('destroy', () => { released = true; });
        try {
          for (let i = 0; i < 2; i += 1) {
            const borrower = new LegacyTreeTransport(
              {
                serverUrl: `ws://127.0.0.1:${server.port}`,
                serverKey: server.serverKey,
                workspaceId: workspace,
                awareness: shared,
              },
              tree.doc,
            );
            borrower.connect();
            assert.equal(await borrower.whenSynced(TREE_SYNC_TIMEOUT_MS), true,
              `borrower ${i} never synced, so this run measured nothing`);
            borrower.destroy();
            assert.equal(released, false,
              `borrower ${i} destroyed an Awareness it was lent — the next probe would be `
              + 'handed one whose heartbeat has been stopped');
          }
        } finally {
          shared.destroy();
        }
        assert.equal(released, true, 'the owner could not release it either');
      } finally {
        tree.doc.destroy();
      }
    });

  return {
    async start() {
      legacy = await startServer({ port: legacyPort, entry: LEGACY_ENTRY });
      return legacy;
    },
    async stop() {
      if (legacy === null) return;
      await legacy.stop();
      legacy.cleanup();
      legacy = null;
    },
  };
}
