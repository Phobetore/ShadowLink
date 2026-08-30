#!/usr/bin/env node
// server/tools/check-dochub.mjs
// `server/DocHub.js` is byte-identical to the version P3 slice 1 was measured
// against, and this is what says so.
//
// Why it exists. The whole P3 transport claim rests on one measured fact: the
// mux works against an UNMODIFIED DocHub. The prototype's four phases ran the
// shipped class, not a patched one, and the spec (§4) states the change as
// "`server/DocHub.js` changes by ZERO lines, and the diff proves it". A claim
// that nobody re-checks stops being true quietly, so it is checked.
//
// Why a pinned hash and not `git diff`. `git diff` in CI compares the working
// tree to the commit under test, so it is empty by construction and proves
// nothing about whether the commit itself moved DocHub. A pin compares against
// the exact bytes the measurement was taken over, on any checkout, forever, and
// it fails in a developer's own `npm test` rather than only on a pull request.
//
// Why the LINE ENDINGS are normalized first. The working tree is CRLF on
// Windows (`core.autocrlf=true`) and LF on Linux CI, so a hash over the file as
// it sits on disk is two different numbers on two platforms. Normalizing to LF
// and hashing that is exactly the equivalence class git itself stores — the
// value below IS `git rev-parse HEAD:server/DocHub.js`, and this script
// re-derives it without needing a git checkout at all.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = resolve(HERE, '..');
export const DOCHUB_PATH = join(SERVER_DIR, 'DocHub.js');
/** The path git knows the file by, from the repository root. */
export const DOCHUB_REPO_PATH = 'server/DocHub.js';

/**
 * The git blob id of `server/DocHub.js` as P3 slice 1 measured it, at master
 * `fd06a1b`. If you are here because this failed: DocHub is not yours to change
 * on a mux slice. If a later phase genuinely changes it, that phase re-measures
 * the transport claim and updates this line in the same commit.
 */
export const DOCHUB_BLOB_SHA1 = '231c3ff43bbbfa76ab1bd7de4a300059ed097ef6';

/** git's own object id for a blob: sha1 of `blob <len>\0<bytes>`. */
export function gitBlobSha1(bytes) {
  const header = Buffer.from(`blob ${bytes.length}`, 'utf8');
  const nul = Buffer.from([0]);
  return createHash('sha1').update(Buffer.concat([header, nul, bytes])).digest('hex');
}

/** The file's bytes as git stores them: CRLF collapsed to LF. */
export function committedBytes(path) {
  const raw = readFileSync(path);
  return Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

/** Does `server/DocHub.js` still hash to the pinned blob id? No git required. */
export function checkDocHubContent() {
  const actual = gitBlobSha1(committedBytes(DOCHUB_PATH));
  return { ok: actual === DOCHUB_BLOB_SHA1, actual, expected: DOCHUB_BLOB_SHA1 };
}

// ------------------------------------------------------------------ as a script

/**
 * Run git from the REPOSITORY ROOT, not from `server/`. A `--` pathspec is
 * resolved relative to the current directory, so running this from `server/`
 * would silently ask about `server/server/DocHub.js` — a pathspec that matches
 * nothing, an empty diff, and a check that passes by looking at nothing at all.
 */
function git(args) {
  return execFileSync('git', args, { cwd: resolve(SERVER_DIR, '..'), encoding: 'utf8' }).trim();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const failures = [];

  const content = checkDocHubContent();
  console.log(`content blob id: ${content.actual}`);
  if (!content.ok) {
    failures.push(
      `${DOCHUB_REPO_PATH} hashes to ${content.actual}, expected ${content.expected}.`,
    );
  }

  // The same question asked of git, when there is a git to ask. This catches the
  // case the content pin cannot see on its own — a file staged or committed
  // differently from what is on disk — and it is the spec's own sentence.
  try {
    const committed = git(['rev-parse', `HEAD:${DOCHUB_REPO_PATH}`]);
    console.log(`committed blob id: ${committed}`);
    if (committed !== DOCHUB_BLOB_SHA1) {
      failures.push(`HEAD:${DOCHUB_REPO_PATH} is ${committed}, expected ${DOCHUB_BLOB_SHA1}.`);
    }
    const diff = git(['diff', '--stat', 'HEAD', '--', DOCHUB_REPO_PATH]);
    if (diff !== '') failures.push(`git diff --stat ${DOCHUB_REPO_PATH} is not empty:\n${diff}`);
  } catch {
    console.log('committed blob id: (not a git checkout — content pin only)');
  }

  if (failures.length > 0) {
    console.error('\nDocHub is NOT untouched:\n');
    for (const line of failures) console.error(`  - ${line}`);
    console.error(
      '\nP3 spec §4: the mux was measured against an UNMODIFIED DocHub, and the'
      + '\nslice that introduced it ships on that claim. Revert the change, or'
      + '\nre-measure the transport and move the pin in the same commit.\n',
    );
    process.exit(1);
  }
  console.log('\nDocHub is untouched.');
}
