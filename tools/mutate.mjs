#!/usr/bin/env node
// tools/mutate.mjs
// The loud mutation probe. Break the code on purpose, watch the test fail, put
// the code back — without any of the four ways this project has watched that go
// wrong.
//
// A mutation probe is only evidence if the mutation was actually applied. Every
// failure mode below has happened here, and each one reads as "the test caught
// it" when nothing of the sort occurred:
//
//  1. THE PROBE MATCHED NOTHING. `sed`, an editor macro or a one-line script
//     silently changes zero bytes, the suite passes, and that is written down as
//     "the test bites". The most recent instance was line endings: the working
//     tree is CRLF (`core.autocrlf=true`), a needle pasted with LF matched
//     nowhere, and the run was recorded as a survivor of a mutation that never
//     existed. So: the needle is matched in BOTH line-ending forms, an exact
//     expected hit count is REQUIRED, and any other number refuses to run.
//  2. THE PROBE MATCHED TOO MUCH. One needle intended for a single call site
//     rewrote six, the suite exploded everywhere, and the result said nothing
//     about the site under test. Same fix: the count is declared up front.
//  3. THE REPLACEMENT WAS A NO-OP. A replacement equal to the needle, or one
//     differing only in line endings, applies "successfully" and changes nothing.
//     Refused.
//  4. THE RESTORE DESTROYED WORK. A probe here was once put back with
//     `git checkout -- <file>`, which reverts the whole file to HEAD and throws
//     away every uncommitted edit in it. NOTHING in this tool consults git. The
//     original bytes are copied to a backup first, the restore copies them back,
//     and the result is compared to the backup byte for byte before the backup is
//     removed. If they ever disagree the backup STAYS, and the tool says so.
//
// Usage — one line, from any shell:
//
//   node tools/mutate.mjs probe src/sync/FetchPolicy.ts \
//     --find "bytes > limits.memoryCapBytes" \
//     --replace "bytes >= limits.memoryCapBytes" \
//     --count 1 -- node --test --experimental-transform-types src/sync/FetchPolicy.test.ts
//
// `probe` applies, runs, restores and reports. It exits 0 when the command FAILS
// (the mutant was killed, which is what you want) and non-zero when the command
// passes (the mutant survived — the test does not bite). `--expect survived`
// inverts that for a probe you expect nothing to catch.
//
//   node tools/mutate.mjs apply   <file> --find … --replace … --count N
//   node tools/mutate.mjs restore <file>
//   node tools/mutate.mjs sweep   [dir]
//
// `apply` leaves the mutation and the backup in place for a hand-driven session;
// `restore` puts it back; `sweep` reports backups anything left behind. Every
// command reports leftovers before it exits, so a forgotten mutation cannot sit
// in the tree unnoticed.
//
// Escapes: `\n`, `\r`, `\t` and `\\` are interpreted in --find/--replace, so a
// multi-line needle fits on one command line. Pass --raw to take them literally,
// or --find-file/--replace-file to read either side from a file.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

/** Repo-relative with POSIX separators, so a message reads the same on every platform. */
const shortPath = (file) => (relative(REPO_ROOT, file) || file).split('\\').join('/');
const BACKUP_SUFFIX = '.mutation-backup';

/** Refusals exit 2, so a caller can tell "the probe was rejected" from "it survived". */
const EXIT_REFUSED = 2;
const EXIT_UNEXPECTED = 1;

// ------------------------------------------------------------------ reporting

function say(...parts) {
  process.stderr.write(`${parts.join(' ')}\n`);
}

function rule() {
  say('-'.repeat(72));
}

/** A refusal, always loud and always fatal. Nothing is half-applied past here. */
function refuse(headline, ...detail) {
  rule();
  say(`mutate: REFUSED — ${headline}`);
  for (const line of detail) say(`  ${line}`);
  rule();
  process.exit(EXIT_REFUSED);
}

// ------------------------------------------------------- line-ending handling

const toLF = (s) => s.replace(/\r\n/g, '\n');
const toCRLF = (s) => toLF(s).replace(/\n/g, '\r\n');

/**
 * Which ending this file mostly uses, for a replacement whose needle carried no
 * newline of its own to copy.
 */
function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const total = (text.match(/\n/g) ?? []).length;
  return crlf >= total - crlf ? '\r\n' : '\n';
}

/**
 * The needle and its replacement in every line-ending form the file could hold.
 *
 * A needle spanning lines is searched as BOTH `\n` and `\r\n`, and the two can
 * never match at the same offset — `a\nb` requires `a` immediately before the
 * newline, which `a\r\nb` does not have — so the counts simply add up. Each form
 * carries the matching form of the replacement, which is what keeps a probe from
 * quietly converting part of a CRLF file to LF.
 */
function eolForms(needle, replacement, fileEol) {
  const needleLF = toLF(needle);
  const needleCRLF = toCRLF(needle);
  const replacementLF = toLF(replacement);
  const replacementCRLF = toCRLF(replacement);

  if (needleLF === needleCRLF) {
    // No newline in the needle: nothing to copy from, so follow the file.
    return [{
      needle: needleLF,
      replacement: fileEol === '\r\n' ? replacementCRLF : replacementLF,
    }];
  }
  return [
    { needle: needleLF, replacement: replacementLF },
    { needle: needleCRLF, replacement: replacementCRLF },
  ];
}

/** Left-to-right scan, longest needle first on a tie. Returns the new text and the hits. */
function applyForms(text, forms) {
  let out = '';
  let cursor = 0;
  let hits = 0;

  for (;;) {
    let at = -1;
    let chosen = null;
    for (const form of forms) {
      const found = text.indexOf(form.needle, cursor);
      if (found === -1) continue;
      if (at === -1 || found < at || (found === at && form.needle.length > chosen.needle.length)) {
        at = found;
        chosen = form;
      }
    }
    if (at === -1) break;
    out += text.slice(cursor, at) + chosen.replacement;
    cursor = at + chosen.needle.length;
    hits += 1;
  }
  return { text: out + text.slice(cursor), hits };
}

// ---------------------------------------------------------------- diagnostics

/**
 * Why a needle that "obviously" is in the file matched nothing.
 *
 * This is the whole reason the tool exists rather than a `sed` one-liner: a probe
 * that matches zero times has to say so in a way that cannot be mistaken for a
 * passing test, and then say what is actually different about the text.
 */
function explainNoMatch(text, needle, file) {
  const detail = [];
  const eol = dominantEol(text);
  detail.push(`the file is ${eol === '\r\n' ? 'CRLF' : 'LF'} and both forms were tried`);

  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  if (squash(text).includes(squash(needle)) && squash(needle) !== '') {
    detail.push('it DOES match once whitespace is ignored — the indentation or the internal');
    detail.push('spacing differs. Copy the needle out of the file rather than retyping it.');
  }

  const anchor = toLF(needle).split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (anchor !== undefined && anchor.length >= 4) {
    const lines = toLF(text).split('\n');
    const found = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(anchor)) found.push(i + 1);
    }
    if (found.length === 0) {
      detail.push(`its first line is not in the file at all: ${JSON.stringify(anchor)}`);
    } else {
      const where = found.slice(0, 5).join(', ') + (found.length > 5 ? ', …' : '');
      detail.push(`its first line IS present, at ${shortPath(file)}:${where}`);
      detail.push('so the mismatch is somewhere after it — check the rest of the needle.');
    }
  }
  return detail;
}

// --------------------------------------------------------------------- backup

function backupPathFor(file) {
  return `${file}${BACKUP_SUFFIX}`;
}

function readTarget(file) {
  if (!existsSync(file)) refuse(`no such file: ${file}`);
  if (statSync(file).isDirectory()) refuse(`${file} is a directory`);
  return readFileSync(file);
}

/**
 * Copy the ORIGINAL bytes aside before a single byte of the file is written.
 *
 * Refusing when a backup already exists is not tidiness: it means the last run
 * did not finish, so the file on disk may already be mutated, and backing THAT up
 * would make the mutation the thing we restore to.
 */
function makeBackup(file, original) {
  const backup = backupPathFor(file);
  if (existsSync(backup)) {
    refuse(
      'a backup from an earlier run is still here',
      backup,
      'That run did not finish, so this file may already hold a mutation.',
      `Put it back with:  node tools/mutate.mjs restore ${shortPath(file)}`,
      'Do NOT use git checkout — it would discard every uncommitted edit in the file.',
    );
  }
  writeFileSync(backup, original, { flag: 'wx' });
  return backup;
}

/**
 * Restore from the BACKUP — never from git — and prove it worked.
 *
 * The comparison is the point. A restore that half-wrote, or wrote through a
 * transform, leaves a file that looks restored and is not; this reads the file
 * back and compares it to the bytes the backup holds. On any disagreement the
 * backup survives and the tool says loudly what is where.
 */
function restoreFromBackup(file) {
  const backup = backupPathFor(file);
  if (!existsSync(backup)) {
    refuse(
      `nothing to restore: ${backup} does not exist`,
      'If the file is mutated, its original bytes are not recoverable from this tool.',
    );
  }
  const original = readFileSync(backup);
  writeFileSync(file, original);

  const now = readFileSync(file);
  if (!now.equals(original)) {
    rule();
    say('mutate: RESTORE FAILED — the file does not match its backup.');
    say(`  file:   ${file} (${now.length} bytes)`);
    say(`  backup: ${backup} (${original.length} bytes)`);
    say('  The backup is being LEFT IN PLACE. Copy it over the file by hand.');
    rule();
    process.exit(EXIT_REFUSED);
  }
  unlinkSync(backup);
  say(`mutate: restored ${shortPath(file)} (${original.length} bytes, verified)`);
}

// ------------------------------------------------------------------- leftovers

function walkForBackups(dir, out) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of names) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkForBackups(full, out);
    else if (entry.name.endsWith(BACKUP_SUFFIX)) out.push(full);
  }
  return out;
}

/** Called before every exit: a forgotten mutation must never sit in the tree quietly. */
function reportLeftovers(root = REPO_ROOT) {
  const found = walkForBackups(root, []);
  if (found.length === 0) return 0;
  rule();
  say(`mutate: ${found.length} backup(s) LEFT BEHIND — a mutation may still be applied:`);
  for (const backup of found) {
    const file = backup.slice(0, -BACKUP_SUFFIX.length);
    say(`  ${shortPath(file)}   (restore: node tools/mutate.mjs restore "${shortPath(file)}")`);
  }
  rule();
  return found.length;
}

// --------------------------------------------------------------------- mutate

function mutate({ file, needle, replacement, expected }) {
  const original = readTarget(file);
  const text = original.toString('utf8');
  const forms = eolForms(needle, replacement, dominantEol(text));
  const { text: mutated, hits } = applyForms(text, forms);
  const shown = shortPath(file);

  if (hits === 0) {
    refuse(
      `the needle matched 0 times in ${shown} (${expected} expected)`,
      ...explainNoMatch(text, needle, file),
    );
  }
  if (hits !== expected) {
    refuse(
      `the needle matched ${hits} times in ${shown}, not the ${expected} declared`,
      hits > expected
        ? 'Narrow the needle, or raise --count if every site is meant to change.'
        : 'Some sites differ from the needle. Lower --count, or widen the needle.',
    );
  }
  if (mutated === text) {
    refuse(
      'the replacement is a no-op — the file is byte-identical after it',
      'A probe that changes nothing always "survives". Check that --replace really',
      'differs from --find by something other than line endings.',
    );
  }

  const backup = makeBackup(file, original);
  writeFileSync(file, Buffer.from(mutated, 'utf8'));
  say(`mutate: applied ${hits} change(s) to ${shown}`);
  say(`mutate: backup at ${shortPath(backup)}`);
  return backup;
}

// -------------------------------------------------------------- running a cmd

/**
 * Quote one argument for the platform shell.
 *
 * `shell: true` hands the shell `file + ' ' + args.join(' ')` with no quoting of
 * its own, so an unquoted path with a space silently becomes two arguments — the
 * same class of silent failure this whole tool exists to prevent. `--cmd` takes a
 * raw string for anything this cannot express.
 */
function shellQuote(arg) {
  if (process.platform === 'win32') {
    if (arg === '') return '""';
    if (!/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  }
  if (arg === '') return "''";
  if (!/[^A-Za-z0-9_@%+=:,./-]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function runCommand(argv, raw) {
  const line = raw ?? argv.map(shellQuote).join(' ');
  say(`mutate: running  ${line}`);
  rule();
  const result = spawnSync(line, { stdio: 'inherit', shell: true });
  rule();
  if (result.error) {
    say(`mutate: the command could not be started: ${result.error.message}`);
    return 127;
  }
  if (result.signal) {
    say(`mutate: the command was killed by ${result.signal}`);
    return 128;
  }
  return result.status ?? 1;
}

// ------------------------------------------------------------------- cli

const USAGE = `
mutate — apply one mutation, run a command against it, put the file back.

  node tools/mutate.mjs probe   <file> --find <s> --replace <s> --count <n> -- <command...>
  node tools/mutate.mjs apply   <file> --find <s> --replace <s> --count <n>
  node tools/mutate.mjs restore <file>
  node tools/mutate.mjs sweep   [dir]

  --find, -f <s>        text to replace. \\n \\r \\t \\\\ are interpreted (see --raw)
  --replace, -r <s>     what to put there. Must not be a no-op
  --count, -n <n>       how many times the needle MUST match. Any other number refuses
  --find-file <path>    read the needle from a file instead
  --replace-file <path> read the replacement from a file instead
  --raw                 take --find/--replace literally, no escape handling
  --cmd "<line>"        run this raw shell line instead of a trailing -- command
  --expect killed|survived   what the command should do. Default: killed

probe exits 0 when the command fails (the mutant was killed) and 1 when it
passes (the mutant survived — that test does not bite). Refusals exit 2.

Line endings are handled in both directions, so a needle typed with \\n still
matches a CRLF working tree. Nothing here ever runs git.
`.trim();

function parse(argv) {
  const options = { positional: [], expect: 'killed', raw: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      options.command = argv.slice(i + 1);
      break;
    }
    const take = (name) => {
      const eq = arg.indexOf('=');
      if (arg.startsWith('--') && eq !== -1) return arg.slice(eq + 1);
      const next = argv[i + 1];
      if (next === undefined) refuse(`${name} needs a value`);
      i += 1;
      return next;
    };
    const bare = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;

    switch (bare) {
      case '-h': case '--help': options.help = true; break;
      case '-f': case '--find': options.find = take(bare); break;
      case '-r': case '--replace': options.replace = take(bare); break;
      case '-n': case '--count': options.count = take(bare); break;
      case '--find-file': options.findFile = take(bare); break;
      case '--replace-file': options.replaceFile = take(bare); break;
      case '--cmd': options.cmd = take(bare); break;
      case '--expect': options.expect = take(bare); break;
      case '--raw': options.raw = true; break;
      default:
        if (bare.startsWith('-') && bare !== '-') refuse(`unknown option ${bare}`, USAGE);
        options.positional.push(arg);
    }
    i += 1;
  }
  return options;
}

function unescape(s) {
  return s.replace(/\\(.)/g, (whole, c) => (
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === '\\' ? '\\' : whole
  ));
}

function sideOf(literal, fromFile, raw, which) {
  if (fromFile !== undefined) {
    if (!existsSync(fromFile)) refuse(`--${which}-file: no such file: ${fromFile}`);
    return readFileSync(fromFile, 'utf8');
  }
  if (literal === undefined) refuse(`--${which} is required`, USAGE);
  return raw ? literal : unescape(literal);
}

function requireCount(raw) {
  if (raw === undefined) {
    refuse(
      '--count is required',
      'Declaring how many times the needle must match is what stops a probe that',
      'matched nothing from being written down as a test that caught something.',
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) refuse(`--count must be a positive integer, got ${raw}`);
  return n;
}

function main() {
  const options = parse(process.argv.slice(2));
  if (options.help || options.positional.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(options.help ? 0 : EXIT_REFUSED);
  }

  const [command, target] = options.positional;

  if (command === 'sweep') {
    const root = target === undefined ? REPO_ROOT : resolve(target);
    const left = reportLeftovers(root);
    if (left === 0) say('mutate: no backups left behind.');
    process.exit(0);
  }

  if (target === undefined) refuse(`${command}: a file is required`, USAGE);
  const file = resolve(target);

  if (command === 'restore') {
    restoreFromBackup(file);
    reportLeftovers();
    process.exit(0);
  }

  if (command !== 'apply' && command !== 'probe') {
    refuse(`unknown command "${command}"`, USAGE);
  }

  const needle = sideOf(options.find, options.findFile, options.raw, 'find');
  const replacement = sideOf(options.replace, options.replaceFile, options.raw, 'replace');
  const expected = requireCount(options.count);
  if (options.expect !== 'killed' && options.expect !== 'survived') {
    refuse(`--expect must be "killed" or "survived", got ${options.expect}`);
  }

  if (command === 'apply') {
    mutate({ file, needle, replacement, expected });
    say('mutate: the mutation is APPLIED and still in place.');
    say(`mutate: put it back with  node tools/mutate.mjs restore ${target}`);
    reportLeftovers();
    process.exit(0);
  }

  const hasCommand = options.cmd !== undefined || (options.command?.length ?? 0) > 0;
  if (!hasCommand) refuse('probe needs a command: put it after -- , or pass --cmd', USAGE);

  mutate({ file, needle, replacement, expected });

  // The restore runs whatever happens — a failing command, a throw, or a Ctrl-C.
  // A probe that left the tree mutated would be worse than no probe at all.
  let restored = false;
  const putBack = () => {
    if (restored) return;
    restored = true;
    restoreFromBackup(file);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      say(`mutate: ${signal} — restoring before exit.`);
      putBack();
      process.exit(EXIT_REFUSED);
    });
  }

  let status;
  try {
    status = runCommand(options.command ?? [], options.cmd);
  } finally {
    putBack();
  }

  const killed = status !== 0;
  const wanted = options.expect === 'killed';
  rule();
  if (killed) say(`mutate: MUTANT KILLED — the command failed (exit ${status}), as a probe should.`);
  else say('mutate: MUTANT SURVIVED — the command passed. Nothing tests this mutation.');
  rule();

  const leftovers = reportLeftovers();
  if (killed !== wanted) {
    say(`mutate: this run expected the mutant to be ${options.expect}.`);
    process.exit(EXIT_UNEXPECTED);
  }
  process.exit(leftovers === 0 ? 0 : EXIT_REFUSED);
}

main();
