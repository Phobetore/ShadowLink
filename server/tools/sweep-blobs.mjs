// server/tools/sweep-blobs.mjs
// The offline orphan-blob sweeper (spec §6.5). `--dry-run` by default.
//
// THIS IS AN ADMIN TOOL, NOT A SERVER BEHAVIOUR, and the distinction is
// structural rather than stylistic. `DocHub` is a doc-agnostic relay: it moves
// Yjs updates and writes snapshots, and it never interprets what is inside them.
// That boundary is what keeps end-to-end encryption possible and what stops a
// server bug from becoming a data-model bug. Reading a snapshot file from disk in
// a separate, opt-in script that the operator runs deliberately is not the relay
// interpreting document schema at runtime, so the boundary stays intact — and
// there is deliberately no DELETE route, no timer and no automatic collection
// anywhere in the server that could reach this code.
//
// EVERY INTERESTING LINE HERE IS A REFUSAL, because the sweeper decides what to
// remove by reading one file, and every way that file can be wrong produces the
// same wrong answer: "nothing references these bytes", about a workspace that
// references all of them. An absent snapshot, a truncated one, one that decodes
// to zero nodes, one written before the uploads beside it — each of them turns a
// reclamation into an erasure.
//
// The failure behaviour, stated plainly, because a tool like this should not
// pretend to be safer than it is:
//
//  * A self-hoster who NEVER runs it accumulates dead bytes for ever. That is
//    bounded by `MAX_TOTAL_STORAGE_GB`, which is non-zero by default, so the
//    worst case is a store that refuses new uploads until somebody looks.
//  * One who runs it with a SHORT TTL can remove a blob a long-absent peer still
//    needs. The consequence is bounded by design: the fetch fails, I2 makes that
//    a no-op, nothing is written and nothing is deleted on that peer, and the node
//    shows up in its diagnostics as unavailable. A missing file, never a corrupt
//    one, and never a delete.
//  * One who runs it against a tree that was WRONG — restored from a backup, say —
//    condemns live bytes, and the recovery mechanism this design chose is a human
//    noticing. So the unlink pass asks the tree again before it removes anything
//    and reports a hash that has come back to life instead of expiring it. The
//    bytes still have to be moved back by hand: `.attic` is not on the store's
//    read path, so a condemned object is already a 404 for every peer, and this
//    tool putting objects back into the store is not a thing the design describes.
//
// Usage:
//   node server/tools/sweep-blobs.mjs                     # dry run, the default
//   node server/tools/sweep-blobs.mjs --apply             # actually move/unlink
//   node server/tools/sweep-blobs.mjs --dir ./data --ttl-days 90 --workspace ws1
//   node server/tools/sweep-blobs.mjs --json              # machine-readable report

import { readdir, readFile, rename, rm, stat, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Y from 'yjs';

import { renameWithRetry } from '../blobStore.js';

/** The same charset `upgradeAuth.js` applies, so `<ws>` is a safe path component. */
const WS_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const FAN_RE = /^[0-9a-f]{2}$/;

/**
 * `<sha>:<bytes>:<parent>`, the same grammar `parseBlobRef` enforces in
 * `src/tree/paths.ts`.
 *
 * Duplicated rather than imported because that module is TypeScript and this
 * script has to run under a bare `node` on a server that has never seen the
 * plugin's build. The duplication is made safe by REFUSING rather than guessing:
 * a `b` field this regex does not match aborts the whole workspace, so a future
 * reference format cannot quietly become a mass deletion of everything using it.
 */
const BLOB_REF_RE = /^([0-9a-f]{64}):([0-9]+):([0-9a-f]{64}|-)$/;

/** How far the newest upload may run ahead of the tree snapshot (spec §6.5). */
const STALENESS_SLACK_MS = 3_600_000;

const DAY_MS = 86_400_000;

const stampOf = (ms) => new Date(ms).toISOString();

function gapOf(ms) {
  if (ms < 2 * 3_600_000) return `${Math.round(ms / 60_000)} minute(s)`;
  if (ms < 2 * DAY_MS) return `${Math.round(ms / 3_600_000)} hour(s)`;
  return `${Math.round(ms / DAY_MS)} day(s)`;
}

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function readdirOrEmpty(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
}

/**
 * Every hash the tree names, INCLUDING FROM TOMBSTONED NODES.
 *
 * That clause is load-bearing for three separate mechanisms and it is the one a
 * reasonable person would optimize away. A dead node's bytes are exactly what a
 * resurrect re-publishes (§3.8), what an undelete from the vault-local `.trash`
 * needs to land on, and what the `proven` probe asks the store about before any
 * peer removes its own local copy (§5.1). Treating a tombstone as permission to
 * discard the bytes makes all three silently impossible — and each of them fails
 * as "your file is gone", months later, with nothing to point at.
 *
 * `parent` is NOT collected. It is causal metadata, not a retention promise, and
 * pinning every ancestor for ever is precisely the unbounded growth that made an
 * in-tree revision log the rejected design (§1.3).
 *
 * @returns {{ live: Set<string> } | { refused: string }}
 */
function liveHashes(doc) {
  const nodes = doc.getMap('nodes');
  if (nodes.size === 0) return { refused: 'the tree snapshot decodes to zero nodes' };

  const live = new Set();
  for (const [id, node] of nodes.entries()) {
    // A node that is not a map at all is a snapshot this build does not
    // understand. Same rule as below: refuse, never guess.
    if (typeof node?.get !== 'function') {
      return { refused: `node ${id} is not a map; this snapshot is not one this build reads` };
    }
    const ref = node.get('b');
    if (ref === undefined || ref === null) continue;
    if (typeof ref !== 'string' || !BLOB_REF_RE.test(ref)) {
      return { refused: `node ${id} carries a blob reference this build cannot parse` };
    }
    live.add(BLOB_REF_RE.exec(ref)[1]);
  }
  return { live };
}

/** Every workspace with a blob store directory, plus every one with a tree. */
async function workspacesIn(dataDir) {
  const found = new Set();
  for (const dir of ['blobs', 'yjs']) {
    for (const entry of await readdirOrEmpty(join(dataDir, dir))) {
      if (entry.isDirectory() && WS_RE.test(entry.name)) found.add(entry.name);
    }
  }
  return [...found].sort();
}

/**
 * Every final object in a workspace's store: `<sha[0:2]>/<sha[2:4]>/<sha>`.
 *
 * Only files that sit at their OWN fanned-out address are objects. A correctly
 * named file in the wrong bucket is unreachable through the store's `finalPath`,
 * so no client can ever fetch it — and `usage.json`, `incoming/` and `.attic/`
 * are not objects at all. The store's own quota accounting draws exactly the same
 * line, and drawing it differently here is how a sweeper starts "reclaiming" the
 * bookkeeping.
 */
async function objectsIn(dataDir, ws) {
  const root = join(dataDir, 'blobs', ws);
  const out = [];
  for (const first of await readdirOrEmpty(root)) {
    if (!first.isDirectory() || !FAN_RE.test(first.name)) continue;
    for (const second of await readdirOrEmpty(join(root, first.name))) {
      if (!second.isDirectory() || !FAN_RE.test(second.name)) continue;
      const folder = join(root, first.name, second.name);
      for (const object of await readdirOrEmpty(folder)) {
        if (!object.isFile() || !SHA_RE.test(object.name)) continue;
        if (!object.name.startsWith(first.name + second.name)) continue;
        const found = await statOrNull(join(folder, object.name));
        if (found !== null) out.push({ sha: object.name, path: join(folder, object.name), stat: found });
      }
    }
  }
  out.sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  return out;
}

/**
 * The staleness guard (spec §6.5): the newest artefact beside the tree snapshot,
 * and WHICH ONE it was, because a refusal nobody can act on is a refusal people
 * learn to ignore.
 *
 * A tree snapshot is written on a two-second debounce, so one that is an HOUR
 * behind the newest thing beside it is not a snapshot of this workspace's current
 * state — it is one that was written before a burst of work, or by a process that
 * died, or onto a volume restored from a backup.
 *
 * The two arms of the walk are evidence about DIFFERENT things, and conflating
 * them is how the refusal message ends up saying something untrue:
 *
 *  * A BLOB newer than the snapshot is direct evidence of a node the scan cannot
 *    see: `s` and `b` are written together only after the upload answers, so a
 *    fresh object with a stale tree means the tree write did not land.
 *  * A DOC SNAPSHOT (`n_*.bin`) is not that. Typing in a note mints no nodes, and
 *    a `k:'b'` node never opens a note room at all. It is a coarse canary — this
 *    workspace kept working after the tree snapshot stopped moving — and it is the
 *    ONLY signal available in the case the blob arm structurally cannot see: a new
 *    node referencing bytes already in the store, where the upload dedupes, no
 *    file is written, and not one mtime moves.
 *
 * So the arm stays, and the message says which file tripped it and what rewrites
 * the tree, rather than implying the operator has lost data.
 *
 * The hour of slack is not politeness: a snapshot and the upload that provoked it
 * are not written in the same instant, and a guard that refused on a second of
 * clock skew would refuse for ever, which is its own kind of broken.
 *
 * @returns {Promise<{ mtimeMs: number, what: string|null }>}
 */
async function newestBeside(dataDir, ws, objects) {
  let newest = { mtimeMs: 0, what: null };
  const consider = (mtimeMs, what) => {
    if (mtimeMs > newest.mtimeMs) newest = { mtimeMs, what };
  };
  for (const entry of await readdirOrEmpty(join(dataDir, 'yjs', ws))) {
    if (!entry.isFile() || !entry.name.endsWith('.bin')) continue;
    if (entry.name === '_tree.bin') continue;
    const found = await statOrNull(join(dataDir, 'yjs', ws, entry.name));
    if (found !== null) consider(found.mtimeMs, `the doc snapshot yjs/${ws}/${entry.name}`);
  }
  for (const object of objects) {
    consider(
      object.stat.mtimeMs,
      `the object blobs/${ws}/${object.sha.slice(0, 2)}/${object.sha.slice(2, 4)}/${object.sha}`,
    );
  }
  return newest;
}

/**
 * Sweep one workspace, or refuse it.
 *
 * A refusal is per workspace and never stops the run: an operator with twelve
 * workspaces and one stale snapshot should still reclaim the other eleven.
 */
async function sweepWorkspace(dataDir, ws, { ttlMs, apply, now, doRename, doUtimes }) {
  const report = {
    workspace: ws,
    refused: null,
    live: 0,
    objects: 0,
    attic: [],
    unlinked: [],
    liveInAttic: [],
    failed: [],
  };

  const treePath = join(dataDir, 'yjs', ws, '_tree.bin');
  const treeStat = await statOrNull(treePath);
  if (treeStat === null || !treeStat.isFile()) {
    report.refused = 'no tree snapshot';
    return report;
  }

  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(await readFile(treePath)));
  } catch (err) {
    report.refused = `the tree snapshot could not be decoded: ${err?.message ?? err}`;
    return report;
  }

  const parsed = liveHashes(doc);
  if (parsed.refused !== undefined) {
    report.refused = parsed.refused;
    return report;
  }

  const objects = await objectsIn(dataDir, ws);
  report.live = parsed.live.size;
  report.objects = objects.length;

  const newest = await newestBeside(dataDir, ws, objects);
  if (newest.mtimeMs > treeStat.mtimeMs + STALENESS_SLACK_MS) {
    report.refused = `${newest.what} (${stampOf(newest.mtimeMs)}) is newer than the tree `
      + `snapshot (${stampOf(treeStat.mtimeMs)}) by ${gapOf(newest.mtimeMs - treeStat.mtimeMs)}; `
      + 'the tree may not describe this workspace\'s current state. Note edits mint no '
      + 'nodes, so a doc snapshot alone often means nothing is wrong — what rewrites the '
      + 'tree snapshot is any structural change (create, rename, move, delete), a server '
      + 'restart, or every peer disconnecting from the workspace.';
    return report;
  }

  const atticDir = join(dataDir, 'blobs', ws, '.attic');
  for (const object of objects) {
    if (parsed.live.has(object.sha)) continue;
    if (now() - object.stat.mtimeMs <= ttlMs) continue;      // still inside the grace period
    if (!apply) {
      report.attic.push(object.sha);
      continue;
    }
    // ONE OBJECT'S BAD DAY IS NOT THE RUN'S. `rename` and `utimes` on this exact
    // path are what Windows and CIFS reject transiently when a scanner or backup
    // agent holds a handle, and an unhandled rejection here unwound out of `main`
    // before a single line was printed — so an operator lost the record of every
    // move the run had already made, in the workspaces it had already finished.
    try {
      await mkdir(atticDir, { recursive: true });
      const condemned = join(atticDir, object.sha);
      // STAMP FIRST, THEN MOVE, and the order is the whole point. `rename`
      // preserves mtime, so an attic entry that never got stamped arrives already
      // older than the TTL and the loop below unlinks it on the very next run —
      // two grace periods collapsed into none, silently. Stamping the object
      // before it moves means there is no instant in which the bytes sit in
      // `.attic` without the clock that says when they were condemned. The cost
      // if the move then fails is that this orphan gets another full TTL in the
      // store, which is the direction a tool like this should fail in.
      const stamp = now() / 1000;
      await doUtimes(object.path, stamp, stamp);
      // A move, not a delete. The gap between the two is the only chance anybody
      // gets to notice that this tool was wrong — an operator reading the report,
      // or a peer that comes back and finds its attachment unavailable.
      //
      // ⚠ `cleanup` MUST be a no-op. `renameWithRetry`'s default is `rm(from)`,
      // which is right for `_finalize`, where the source is a half-written `.part`
      // and an incomplete object is never the file to keep. Here the source is the
      // object itself, so the default would make an exhausted retry delete the
      // very blob this tool had only decided to move.
      await renameWithRetry(object.path, condemned, { rename: doRename, cleanup: () => {} });
      // Recorded only now: a report that claims a move that did not happen is
      // worse than no report, because it is the thing an operator reads instead of
      // looking at the disk.
      report.attic.push(object.sha);
    } catch (err) {
      report.failed.push({ sha: object.sha, stage: 'move', error: String(err?.message ?? err) });
    }
  }

  // …and only bytes that have already served a full TTL in the attic are unlinked,
  // which is a second TTL, deliberately.
  for (const entry of await readdirOrEmpty(atticDir)) {
    if (!entry.isFile() || !SHA_RE.test(entry.name)) continue;
    // ⚠ LOOK AGAIN BEFORE REMOVING. Ageing out of `.attic` is not a decision, it
    // is the expiry of one — and the decision was made by a possibly-wrong earlier
    // run. The case this exists for: an operator sweeps against a `_tree.bin`
    // restored from a stale backup, hundreds of live blobs are condemned, they
    // notice within the hour and put the right snapshot back — and then the cron
    // keeps running. Every later run reads a tree that names those hashes and,
    // without this test, removes them anyway when the second TTL expires. For an
    // attachment no peer ever fetched, the store's copy was the only copy.
    //
    // It is REPORTED, not restored. Renaming bytes back into the store would make
    // this tool the only thing outside `blobStore` that writes objects into it —
    // able to clobber a re-uploaded duplicate and to desync `usage.json`. "An
    // operator notices" is the recovery mechanism this design chose; the fix is to
    // give them something to notice, on the first run rather than the ninetieth.
    if (parsed.live.has(entry.name)) {
      report.liveInAttic.push(entry.name);
      continue;
    }
    const path = join(atticDir, entry.name);
    const found = await statOrNull(path);
    if (found === null || now() - found.mtimeMs <= ttlMs) continue;
    if (!apply) {
      report.unlinked.push(entry.name);
      continue;
    }
    try {
      await rm(path, { force: true });
      report.unlinked.push(entry.name);
    } catch (err) {
      report.failed.push({ sha: entry.name, stage: 'unlink', error: String(err?.message ?? err) });
    }
  }

  report.attic.sort();
  report.unlinked.sort();
  report.liveInAttic.sort();
  report.failed.sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  return report;
}

/**
 * Sweep every workspace under `dataDir`.
 *
 * `apply` defaults to FALSE. An admin tool whose first run deletes things is a
 * tool people run once, by accident, on the wrong directory.
 *
 * `rename` and `utimes` are seams, for the same reason `now` is one: the failure
 * they exist to prove — a rejecting filesystem call halfway through a move — is a
 * Windows/CIFS one that cannot be provoked from a temp directory. `rename` is
 * handed to `renameWithRetry`, so a test that injects a transient rejection
 * exercises the retry ladder and the cleanup path rather than short-circuiting it.
 *
 * @param {{ dataDir: string, ttlDays?: number, apply?: boolean,
 *           workspace?: string|null, now?: () => number,
 *           rename?: Function, utimes?: Function }} options
 */
export async function sweep(options) {
  const {
    dataDir,
    ttlDays = 90,
    apply = false,
    workspace = null,
    now = () => Date.now(),
    rename: doRename = rename,
    utimes: doUtimes = utimes,
  } = options;

  const all = await workspacesIn(dataDir);
  const wanted = workspace === null ? all : all.filter((ws) => ws === workspace);
  const workspaces = [];
  for (const ws of wanted) {
    workspaces.push(await sweepWorkspace(dataDir, ws, {
      ttlMs: ttlDays * DAY_MS, apply, now, doRename, doUtimes,
    }));
  }
  return { dataDir, ttlDays, apply, workspaces };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { dataDir: process.env.PERSISTENCE_DIR ?? './data', apply: false, json: false };
  const ttl = process.env.BLOB_ORPHAN_TTL_DAYS;
  if (ttl !== undefined && /^[0-9]+$/.test(ttl)) out.ttlDays = Number(ttl);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--dry-run') out.apply = false;
    else if (arg === '--json') out.json = true;
    else if (arg === '--dir') out.dataDir = argv[++i];
    else if (arg === '--workspace') out.workspace = argv[++i];
    else if (arg === '--ttl-days') out.ttlDays = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') out.help = true;
    else out.unknown = arg;
  }
  return out;
}

const USAGE = `
sweep-blobs — move unreferenced attachment blobs out of the store (spec §6.5)

  --dir <path>        data directory (default $PERSISTENCE_DIR or ./data)
  --workspace <id>    only this workspace
  --ttl-days <n>      grace period before a blob is moved, and again before it is
                      unlinked from .attic (default $BLOB_ORPHAN_TTL_DAYS or 90)
  --apply             actually move and unlink. WITHOUT THIS NOTHING CHANGES.
  --json              print the report as JSON
  --help

Blobs are moved to blobs/<ws>/.attic/ first and unlinked only after a further
full TTL — and never at all if the tree names them again by then. A workspace is
refused whole, and nothing in it is touched, when its tree snapshot is absent,
unreadable, decodes to zero nodes, carries a reference this build cannot parse,
or is more than an hour older than the newest doc snapshot or blob beside it.
That last one clears on any structural change, a server restart, or every peer
disconnecting from the workspace; note edits alone do not rewrite the tree.

A move that the filesystem rejects is reported per object and the run carries on;
the exit status is 1 if anything failed.
`.trim();

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help === true) {
    console.log(USAGE);
    return 0;
  }
  if (args.unknown !== undefined) {
    console.error(`sweep-blobs: unknown argument "${args.unknown}"\n\n${USAGE}`);
    return 2;
  }
  if (args.ttlDays !== undefined && (!Number.isInteger(args.ttlDays) || args.ttlDays < 0)) {
    console.error('sweep-blobs: --ttl-days must be a whole number of days');
    return 2;
  }

  const report = await sweep(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.workspaces.some((w) => w.failed.length > 0) ? 1 : 0;
  }

  console.log(
    `sweep-blobs: ${args.apply ? 'APPLYING' : 'dry run — nothing will change'} `
    + `in ${report.dataDir}, TTL ${report.ttlDays} day(s)`,
  );
  for (const ws of report.workspaces) {
    if (ws.refused !== null) {
      console.log(`  ${ws.workspace}: REFUSED — ${ws.refused}`);
      continue;
    }
    console.log(
      `  ${ws.workspace}: ${ws.objects} object(s), ${ws.live} referenced, `
      + `${ws.attic.length} to .attic, ${ws.unlinked.length} unlinked`,
    );
    for (const sha of ws.attic) console.log(`    -> .attic  ${sha}`);
    for (const sha of ws.unlinked) console.log(`    unlink     ${sha}`);
    for (const sha of ws.liveInAttic) {
      console.log(
        `    WARNING    ${sha} is in .attic, and the tree names it again. An earlier run\n`
        + '               condemned bytes that are live; this one declined to remove them.\n'
        + '               They are a 404 for every peer until you move the file back into\n'
        + `               blobs/${ws.workspace}/${sha.slice(0, 2)}/${sha.slice(2, 4)}/ by hand.`,
      );
    }
    for (const failure of ws.failed) {
      console.log(`    FAILED ${failure.stage}  ${failure.sha}: ${failure.error}`);
    }
  }
  if (!args.apply && report.workspaces.some((w) => w.attic.length + w.unlinked.length > 0)) {
    console.log('\nRe-run with --apply to carry this out.');
  }
  // A run that could not finish everything it set out to do still exits non-zero,
  // the way the unhandled rejection used to — but now the report is printed first.
  return report.workspaces.some((w) => w.failed.length > 0) ? 1 : 0;
}

// Only when RUN, never when imported by a test.
if (process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]).href)).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(`sweep-blobs: ${err?.stack ?? err}`);
      process.exitCode = 1;
    },
  );
}
