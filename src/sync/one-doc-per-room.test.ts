// src/sync/one-doc-per-room.test.ts
// P3 slice 3's definition of done: "a test asserts two docs for one room is
// UNCONSTRUCTIBLE" — the S10 defect class, named in the spec at §1.1 and §5.2.
//
// ⚠ ABSENT AND UNCONSTRUCTIBLE ARE DIFFERENT CLAIMS, and only the second is worth
// making. "No caller builds a second document today" is a fact about today, and
// the way it stops being true is not malice: it is somebody adding a consumer that
// needs a note's text, writing the two obvious lines — `new Y.Doc()`, connect it to
// `n_<id>` — and shipping something that works perfectly in every test, because
// each document is internally consistent and the two only disagree about what a
// PEER would receive. That is exactly how the split got here.
//
// So the claim is held by four locks, each of which fails on its own:
//
//  1. NO SHIPPED CONSUMER CAN BUILD ONE. `new Y.Doc()` appears in shipped source
//     in two places, both allowlisted below with what they are.
//  2. NO SHIPPED CONSUMER CAN BUILD A CONNECTION EITHER, so "bypass the registry
//     and talk to the server directly" is also default-denied.
//  3. NO PORT ACCEPTS A DOCUMENT. Both consumer-facing entry points take a room
//     NAME and nothing else, so there is no expressible call that introduces a
//     second one — this is the lock that would have caught the shape the session
//     used to have, where the caller supplied the document.
//  4. AND THE SHIPPED TRANSPORT REFUSES ANYWAY. `MuxLink.subscribe` throws on a
//     room that is already subscribed, so a second document for a live room could
//     not be connected even if the three locks above were picked.
//
// Plus the behaviour the locks exist to protect, driven over the real registry,
// the real ports and the real `MuxLink`/`MuxRoom` against `FakeMux`: the two
// consumers hold one document, one subscription and one socket, and a write
// through either is a write the other can see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';

import { FakeMux } from './fakes.ts';
import { MuxLink } from './MuxLink.ts';
import { MuxRoomTransport } from './MuxRoomTransport.ts';
import { RegistryDocPort, RegistryProviderPort, RoomRegistry } from './RoomRegistry.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Files compiled into the plugin. Tests are not, and are excluded. */
function shippedSources(): string[] {
  const out: string[] = [join(REPO_ROOT, 'main.ts')];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts')) continue;
      if (name.endsWith('.test.ts')) continue;
      out.push(full);
    }
  };
  walk(join(REPO_ROOT, 'src'));
  return out;
}

function relativeTo(file: string): string {
  return file.slice(REPO_ROOT.length).replace(/\\/g, '/');
}

/**
 * Source with its comments and string literals blanked out, so the two scans
 * below are about CODE.
 *
 * `banned-calls.test.ts` solves the same problem the other way, by assembling its
 * needles from fragments and never spelling them in prose. That works for a needle
 * nobody needs to write down; it does not work here, because the whole subject of
 * this slice is a construction the comments have to be able to NAME — the sentence
 * "it used to be `new Y.Doc()` two lines above the connect" is the most useful
 * thing in `WorkspaceSession.ts`'s header and a scan that tripped on it would
 * simply be deleted by the next person.
 *
 * Characters are replaced with spaces rather than removed, so an offset in the
 * result is an offset in the file.
 */
function code(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    }
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      blank(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) break;
        j += 1;
      }
      blank(i, Math.min(j + 1, source.length));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// ================================================================ lock 1

/**
 * Where a `Y.Doc` may be constructed in shipped source, and what each one is.
 *
 * Default-deny, on `banned-calls.test.ts`'s own precedent: a new entry has to be
 * justified here, in the file whose whole subject is why a second document for one
 * room is a content-loss bug, rather than merely not resembling anything anybody
 * thought to ban.
 */
const MAY_BUILD_A_DOC: Record<string, string> = {
  // The registry itself. This is the ONE document a room ever has, and the
  // refcount is what decides when it goes.
  'src/sync/RoomRegistry.ts': 'the one document per room',
  // The STRUCTURAL document, which is not a room's content document at all: it is
  // `_tree`, it holds no note text, and it is handed to the tree's transport by
  // the plugin rather than acquired per room.
  'src/tree/TreeDoc.ts': 'the structural tree document, which holds no note text',
  // The test doubles, which this scan sees because they live under `src/` and are
  // not named `.test.ts` — the same reason `banned-calls.test.ts` has an entry for
  // them. `FakeMux`'s documents are the SERVER's copy of a room, which is the one
  // thing that is supposed to be a second document.
  'src/sync/fakes.ts': 'the fake SERVER\'s own copy of a room',
};

test('only the registry may construct a room\'s document (S10, unconstructible)', () => {
  let checked = 0;
  for (const file of shippedSources()) {
    const rel = relativeTo(file);
    const source = code(readFileSync(file, 'utf8'));
    const hits = [...source.matchAll(/new\s+Y\.Doc\s*\(/g)];
    if (hits.length === 0) continue;
    checked += hits.length;
    assert.ok(
      MAY_BUILD_A_DOC[rel] !== undefined,
      `${rel} constructs a Yjs document. If it is a ROOM's content document it must `
      + 'come from RoomRegistry.acquire, or one client ends up holding two documents '
      + 'for one room and neither can see the other (the S10 defect class). If it is '
      + 'genuinely not a room, add it to MAY_BUILD_A_DOC with what it is.',
    );
  }
  // A scan that stopped matching would pass every assertion above.
  assert.ok(checked >= 2, `expected the two allowed constructions, matched ${checked}`);
});

test('the allowlist names only files that are actually shipped', () => {
  const shipped = new Set(shippedSources().map(relativeTo));
  for (const rel of Object.keys(MAY_BUILD_A_DOC)) {
    assert.ok(shipped.has(rel), `${rel} is on the allowlist but is not shipped source`);
  }
});

// ================================================================ lock 2

/**
 * Where a room's CONNECTION may be constructed, and what each one is.
 *
 * Lock 1 alone is not enough: a consumer that reached the registry for its
 * document and then opened its own second connection to the same room would have
 * one document and two handshakes, which is a different bug with the same cause —
 * a consumer doing its own networking.
 */
const MAY_BUILD_A_CONNECTION: Record<string, string> = {
  'src/sync/MuxRoomTransport.ts': 'the registry\'s mux route',
  'src/sync/ObsidianDocPort.ts': 'the registry\'s compatibility route',
  'src/sync/TreeTransport.ts': 'the structural document\'s room, which is not a note',
  'src/sync/LegacyTreeTransport.ts': 'the removal-scheduled bridge and its probe',
};

test('only a RoomTransport may open a room (S10, unconstructible)', () => {
  let checked = 0;
  for (const file of shippedSources()) {
    const rel = relativeTo(file);
    const source = code(readFileSync(file, 'utf8'));
    const hits = [...source.matchAll(/new\s+(MuxRoom|WebsocketProvider)\s*\(/g)];
    if (hits.length === 0) continue;
    checked += hits.length;
    assert.ok(
      MAY_BUILD_A_CONNECTION[rel] !== undefined,
      `${rel} opens a room connection of its own. A consumer that wants a note's `
      + 'text asks RoomRegistry for it; a second connection to a room this client '
      + 'already holds is the S10 split with one document instead of two. If this '
      + 'really is a transport, add it to MAY_BUILD_A_CONNECTION with what it is.',
    );
  }
  assert.ok(checked >= 4, `expected the transports' constructions, matched ${checked}`);
});

// ================================================================ lock 3

test('neither consumer port can be HANDED a document', () => {
  // The shape, at runtime, on the shipped objects. This is the lock that names
  // the defect's actual mechanism: the session used to build the document and pass
  // it in, so a second one was one line of ordinary-looking code away.
  const registry = new RoomRegistry(new MuxRoomTransport(new MuxLink({
    serverUrl: 'ws://host:1234', serverKey: 'sk', workspaceId: 'ws-1',
    openSocket: new FakeMux().openSocket,
  })));

  assert.equal(
    new RegistryProviderPort(registry).connect.length, 1,
    'ProviderPort.connect takes a room NAME and nothing else',
  );
  assert.equal(
    new RegistryDocPort(registry).openHeadless.length, 1,
    'DocPort.openHeadless takes a room NAME and nothing else',
  );
  assert.equal(registry.acquire.length, 1, 'and so does the registry itself');

  // And the same claim about the CONTRACTS rather than one implementation, since
  // an interface is what the next implementation will be written against.
  const contracts = code(
    readFileSync(join(REPO_ROOT, 'src/sync/DocPort.ts'), 'utf8')
    + readFileSync(join(REPO_ROOT, 'src/sync/WorkspaceSession.ts'), 'utf8'),
  );
  for (const member of ['connect', 'openHeadless', 'acquire']) {
    const declaration = new RegExp(`\\b${member}\\(room: string,[^)]*\\bY\\.Doc`);
    assert.ok(
      !declaration.test(contracts),
      `${member} must not take a room's document as a parameter: that is the shape `
      + 'the session had, and a caller that can supply one can supply a second one',
    );
  }

  registry.destroy();
});

// ================================================================ lock 4

test('the shipped link REFUSES a second subscription for a room', () => {
  // Belt and braces, and it is the shipped guard rather than one written for this
  // test: even with a second document in hand, connecting it to a room this client
  // already holds throws. `MuxLink.subscribe` has always done this; what slice 3
  // changes is that note rooms are now on that link, so it now guards them.
  const mux = new FakeMux();
  const link = new MuxLink({
    serverUrl: 'ws://host:1234', serverKey: 'sk', workspaceId: 'ws-1',
    openSocket: mux.openSocket,
  });
  const transport = new MuxRoomTransport(link);
  const registry = new RoomRegistry(transport);
  link.connect();

  const lease = registry.acquire('n_aaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(link.roomNames().includes('n_aaaaaaaaaaaaaaaaaaaaaa'), true);

  assert.throws(
    () => transport.open('n_aaaaaaaaaaaaaaaaaaaaaa', new Y.Doc(), lease.awareness),
    /already subscribed/,
    'a second connection for a live room cannot be opened at all',
  );

  registry.destroy();
  link.destroy();
});

// ================================================================ the behaviour

/**
 * The whole stack minus the socket: real registry, real ports, real
 * `MuxRoomTransport`, real `MuxLink` and `MuxRoom`, over `FakeMux`'s bidirectional
 * relay.
 */
function stack(): {
  mux: FakeMux;
  link: MuxLink;
  registry: RoomRegistry;
  docs: RegistryDocPort;
  providers: RegistryProviderPort;
  destroy(): void;
} {
  const mux = new FakeMux();
  const link = new MuxLink({
    serverUrl: 'ws://host:1234', serverKey: 'sk', workspaceId: 'ws-1',
    openSocket: mux.openSocket,
  });
  const registry = new RoomRegistry(new MuxRoomTransport(link));
  const docs = new RegistryDocPort(registry, { syncTimeoutMs: 200 });
  const providers = new RegistryProviderPort(registry);
  link.connect();
  return {
    mux,
    link,
    registry,
    docs,
    providers,
    destroy: () => { registry.destroy(); link.destroy(); },
  };
}

test('the session and the queue hold ONE document, ONE room and ONE socket', async () => {
  const room = 'n_aaaaaaaaaaaaaaaaaaaaaa';
  const s = stack();
  try {
    // The editor's side.
    const bound = s.providers.connect(room);
    // The headless side, in the same instant — the state that used to be two
    // documents, two sockets and two handshakes.
    const opened = await s.docs.openHeadless(room);

    const third = s.registry.acquire(room);
    assert.equal(bound.doc, third.doc, 'one document for the room');
    third.release();
    assert.equal(s.registry.liveDocs(room), 1);
    assert.equal(s.registry.docsBuilt(room), 1, 'and only ever one was built');
    assert.deepEqual(s.link.roomNames(), [room], 'one subscription');
    assert.equal(s.mux.liveSockets.length, 1, 'one socket');

    // A write through the headless port reaches the document the editor is bound
    // through, and the server, with nothing relaying between two copies.
    assert.equal(opened.synced, true, 'the room handshaked over the link');
    assert.equal(await s.docs.insertIfEmpty(opened.handle, 'seeded from the file'), true);
    assert.equal(bound.doc.getText('content').toString(), 'seeded from the file');
    assert.equal(s.mux.text(room), 'seeded from the file', 'and it reached the server');

    // And the reverse: I5's guard, asked of the one document that exists.
    assert.equal(await s.docs.insertIfEmpty(opened.handle, 'and again'), false);
    assert.equal(bound.doc.getText('content').toString(), 'seeded from the file',
      'nothing was concatenated');

    s.docs.close(opened.handle);
    bound.provider.destroy();
  } finally {
    s.destroy();
  }
});

test('the cursor the session sets goes out on the room the registry opened', async () => {
  // ⚠ THE AWARENESS HAS TO BE THE REGISTRY'S TOO, and a registry that owned the
  // document while the transport built its own `Awareness` would look perfectly
  // healthy: `lease.awareness` exists, `setLocalStateField` succeeds, and the
  // object it wrote into is one nothing sends. The session hands exactly this
  // object to `yCollab`, so the failure is "every remote cursor disappears", with
  // no error anywhere.
  //
  // It is also what makes the transport swap survivable: `MuxRoom` and
  // `WebsocketProvider` both destroy neither a document nor an `Awareness` they
  // were handed, which is only safe because the registry built both.
  const room = 'n_eeeeeeeeeeeeeeeeeeeeee';
  const s = stack();
  try {
    const { provider } = s.providers.connect(room);
    const before = s.mux.sockets[0].sent.filter((f) => f.room === room).length;

    provider.awareness.setLocalStateField('user', { name: 'Ada', color: '#f00' });

    const frames = s.mux.sockets[0].sent.filter((f) => f.room === room);
    assert.ok(frames.length > before, 'setting a cursor wrote nothing to the room');
    // Tag 1 is `MESSAGE_AWARENESS`, the same tag y-websocket writes.
    assert.equal(frames.at(-1)!.payload[0], 1, 'the last frame was not an awareness update');

    provider.destroy();
  } finally {
    s.destroy();
  }
});

test('the census never exceeds one, through an adversarial interleaving', async () => {
  // Sixty acquires and releases across the two ports, in an order chosen to cross
  // every boundary the refcount has: both up, one down, both down, re-acquire,
  // re-acquire while one is held. `liveDocs` is asserted after every single step,
  // because "it ended at one" is compatible with having been two in the middle,
  // and two in the middle is where a peer's bytes go missing.
  const room = 'n_cccccccccccccccccccccc';
  const s = stack();
  try {
    const holders: Array<() => void> = [];
    let builds = 0;

    const take = async (kind: 'bound' | 'headless'): Promise<void> => {
      const before = s.registry.liveDocs(room);
      if (kind === 'bound') {
        const { provider } = s.providers.connect(room);
        holders.push(() => { provider.destroy(); });
      } else {
        const opened = await s.docs.openHeadless(room);
        holders.push(() => { s.docs.close(opened.handle); });
      }
      if (before === 0) builds += 1;
      assert.equal(s.registry.liveDocs(room), 1, 'a room in use is exactly one document');
      assert.equal(s.registry.docsBuilt(room), builds, 'and no document was built twice');
      assert.ok(s.link.roomNames().filter((r) => r === room).length <= 1, 'one subscription');
    };

    const give = (): void => {
      holders.shift()?.();
      assert.ok(s.registry.liveDocs(room) <= 1, 'and never more than one, ever');
    };

    const script: Array<'bound' | 'headless' | 'release'> = [
      'bound', 'headless', 'release', 'headless', 'bound', 'release', 'release',
      'release', 'bound', 'release', 'headless', 'headless', 'release', 'bound',
      'release', 'release', 'bound', 'headless', 'bound', 'release',
    ];
    for (const step of script) {
      if (step === 'release') give();
      else await take(step);
    }
    while (holders.length > 0) give();

    assert.equal(s.registry.liveDocs(room), 0, 'and it is gone when nobody holds it');
    assert.deepEqual(s.link.roomNames(), [], 'with its subscription');
    assert.equal(s.mux.liveSockets.length, 1, 'on the same one socket throughout');
  } finally {
    s.destroy();
  }
});

test('a room the session closes and reopens is one document at a time', async () => {
  // The commonest event in the product — a leaf switch — and the one the split
  // used to be reachable through: the session releasing while the queue is still
  // publishing, then coming back.
  const room = 'n_dddddddddddddddddddddd';
  const s = stack();
  try {
    const first = s.providers.connect(room);
    const opened = await s.docs.openHeadless(room);
    first.doc.getText('content').insert(0, 'what the user typed');

    first.provider.destroy();                       // the leaf closed
    assert.equal(s.registry.liveDocs(room), 1, 'the queue is still holding it');

    const second = s.providers.connect(room);       // and it came back
    assert.equal(second.doc, first.doc, 'the same document, never a second one');
    assert.equal(second.doc.getText('content').toString(), 'what the user typed');
    assert.equal(s.registry.docsBuilt(room), 1);
    assert.deepEqual(s.link.roomNames(), [room]);

    second.provider.destroy();
    s.docs.close(opened.handle);
    assert.equal(s.registry.liveDocs(room), 0);
  } finally {
    s.destroy();
  }
});

test('a room the last borrower releases stops being relayed to this client', async () => {
  // ⚠ THE FAN-OUT LEAK, pinned. `MuxLink.unsubscribe()` used to delete a
  // client-side map entry and put nothing on the wire, so the server kept this
  // client registered in every room it had ever opened for the life of the vault
  // socket. Measured against a real server before the leave existed: 20 frames
  // arriving for a departed room after 20 peer edits, silently dropped
  // client-side and counted NOWHERE — `droppedInbound` read 0 throughout, because
  // a straggler for a room we once subscribed is deliberately not evidence of
  // anything. It grows with every note opened in a session.
  const room = 'n_eeeeeeeeeeeeeeeeeeeeee';
  const keep = 'n_ffffffffffffffffffffff';
  const s = stack();
  try {
    // A second room, so the vault socket lives on exactly as it does in a vault
    // whose tree is synced — the leak's own precondition.
    const tree = s.providers.connect(keep);
    const bound = s.providers.connect(room);
    const socket = s.mux.liveSockets[0]!;
    assert.equal(socket.hasRoom(room), true, 'the server never opened the room');

    // A peer edit reaches this client while it holds the room.
    s.mux.doc(room).getText('content').insert(0, 'from a peer');
    assert.equal(bound.doc.getText('content').toString(), 'from a peer');

    bound.provider.destroy();                       // the leaf closed
    assert.equal(s.registry.liveDocs(room), 0);
    assert.equal(socket.hasRoom(room), false,
      'the server still holds a virtual connection for a room this client has left');
    assert.equal(s.link.stats.leavesSent, 1, 'nothing went on the wire');

    const framesBefore = s.link.stats.framesIn;
    const droppedBefore = s.link.stats.droppedInbound;
    for (let i = 0; i < 20; i++) {
      const text = s.mux.doc(room).getText('content');
      text.insert(text.length, `edit ${i}\n`);
    }

    assert.equal(s.link.stats.framesIn, framesBefore,
      'frames are still arriving for a room this client left');
    assert.equal(s.link.stats.droppedInbound, droppedBefore,
      'and they were not counted anywhere either');

    // The room that is still held is unaffected: a leave is one room's business.
    s.mux.doc(keep).getText('content').insert(0, 'the tree moved');
    assert.equal(tree.doc.getText('content').toString(), 'the tree moved',
      'leaving one room stopped another');
    assert.equal(s.mux.liveSockets.length, 1, 'the leave took the vault socket with it');

    tree.provider.destroy();
  } finally {
    s.destroy();
  }
});
