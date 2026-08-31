// src/ui/format.test.ts
// "3 files" and "3 files (218 MB)" are different questions, and only the second
// one can be answered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ParkReason } from '../sync/PublishQueue.ts';
import {
  COMPATIBILITY_FALLBACK_LINE, COMPATIBILITY_LINE, COMPATIBILITY_PENDING_LINE,
  COMPATIBILITY_STALE_LINE, compatibilityLine, formatBytes, nothingToDownload, parkedLine,
  routeUnserved, statusLine, syncedStatus, unservedLine,
  type MuxRouteFacts, type StatusLine,
} from './format.ts';

test('sizes read the way a person reads them', () => {
  assert.equal(formatBytes(0), '0 KB');
  assert.equal(formatBytes(512), '1 KB');
  assert.equal(formatBytes(1024 * 400), '0.4 MB');
  assert.equal(formatBytes(1024 * 80), '80 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 180), '180 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024 * 3), '3.0 GB');
});

// A number that rounds to zero is still a file the user has, and "0 KB" beside a
// filename reads as "this is empty" rather than "this is small".
test('a small non-zero size never reads as nothing', () => {
  assert.equal(formatBytes(1), '1 KB');
  assert.equal(formatBytes(100), '1 KB');
});

// ---------------------------------------------------------------- §7.3

test('a share with nothing outstanding says plain "synced"', () => {
  assert.deepEqual(syncedStatus('Shared', []), {
    text: 'ShadowLink: synced',
    tooltip: 'Sharing Shared',
  });
});

// ⚠ §7.3, and the reason the wording is in a tested function rather than inline
// in a template string. The tree can agree on every peer that a path holds hash H
// while exactly ONE peer holds the bytes, so an indicator that says "synced" while
// twelve attachments were deliberately not downloaded is not shorthand — it is
// false, and false in the direction that stops the user looking for a file that
// really is not there.
test('a share with undownloaded attachments never says just "synced"', () => {
  const line = syncedStatus('Shared', [
    { bytes: 200 * 1024 * 1024 },
    { bytes: 140 * 1024 * 1024 },
  ]);

  assert.match(line.text, /2 attachment\(s\) available/);
  assert.notEqual(line.text, 'ShadowLink: synced');
  // The count is what makes somebody hover; the byte total is what makes the
  // decision, so it has to be there when they do.
  assert.match(line.tooltip, /2 attachment\(s\) not downloaded \(340 MB\)/);
  assert.match(line.tooltip, /Download attachments/);
});

// ---------------------------------------------------------------- §7.5

const MB = 1024 * 1024;

// ⚠ §7.5 verbatim: "the fetch is refused before any request is made, with a
// diagnostic naming the file, its size and the cap". All three have to land
// somewhere a person can read, and this is the surface they already have.
test('an attachment this device cannot hold never reads as just "synced"', () => {
  const line = syncedStatus('Shared', [], [{ path: 'Shared/report.pdf', bytes: 40 * MB }], [],
    32 * MB);

  assert.notEqual(line.text, 'ShadowLink: synced');
  assert.match(line.tooltip, /report\.pdf/, '§7.5: the file');
  assert.match(line.tooltip, /40 MB/, '§7.5: its size');
  assert.match(line.tooltip, /32 MB/, '§7.5: the cap');
  // The download command tests the cap BEFORE an approval, so it cannot fetch
  // this file however many times it is pressed. Naming it here would be the same
  // broken promise the first-sync modal was making.
  assert.doesNotMatch(line.tooltip, /Download attachments/);
});

// §6.5. The one refusal of the three that nothing done on this device can lift:
// a self-hoster ran the orphan sweeper with a short TTL, or the volume lost a
// file. Offering a Download button for it would be a button that can only fail.
test('an attachment the store no longer holds is reported, and never offered as a download', () => {
  const line = syncedStatus('Shared', [], [], [{ path: 'Shared/old.zip', bytes: 5 * MB }]);

  assert.notEqual(line.text, 'ShadowLink: synced');
  assert.match(line.tooltip, /old\.zip/);
  assert.match(line.tooltip, /5\.0 MB/);
  assert.doesNotMatch(line.tooltip, /Download attachments/);
});

// The three refusals are three different user-actionable states (§7.2, §7.4,
// §6.5) and exactly one of them has a remedy on this device. Collapsing them into
// one count would send the user to a command that cannot help for two of them.
test('the three refusals are counted apart, and only the fetchable one names the command', () => {
  const line = syncedStatus(
    'Shared',
    [{ bytes: 8 * MB }],
    [{ path: 'Shared/clip.mov', bytes: 400 * MB }],
    [{ path: 'Shared/old.zip', bytes: 5 * MB }],
    32 * MB,
  );

  assert.match(line.text, /1 attachment\(s\) available/);
  assert.match(line.tooltip, /1 attachment\(s\) not downloaded \(8\.0 MB\)/);
  assert.match(line.tooltip, /clip\.mov/);
  assert.match(line.tooltip, /old\.zip/);
  // One remedy, named once, against the one bucket it works for.
  assert.equal(line.tooltip.match(/Download attachments/g)?.length, 1);
});

// A long list is a tooltip nobody can read. It still has to be honest about how
// much it is not showing.
test('a long oversized list is sampled, and says how much it left out', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ path: `Shared/v${i}.mov`, bytes: 400 * MB }));
  const line = syncedStatus('Shared', [], many, [], 32 * MB);

  assert.match(line.text, /9/);
  assert.match(line.tooltip, /v0\.mov/);
  assert.match(line.tooltip, /more/, 'the ones it did not list are still accounted for');
});

// ------------------------------------------- §7.3, the download commands' answer

test('a command with nothing outstanding at all may say "already downloaded"', () => {
  assert.match(nothingToDownload('Shared', 'this workspace', [], []), /already downloaded/);
  assert.match(nothingToDownload('Shared', 'this note', [], []), /this note/);
});

// ⚠ The other half of the §7.3 wording rule. The download command tests the
// memory cap BEFORE it consults an approval, so an oversized attachment is one it
// can never fetch — and answering "every attachment here is already downloaded"
// is the same false statement the status bar was just stopped from making, said
// by the very command the first-sync modal sends the user to.
test('a command that cannot fetch an oversized attachment never calls it downloaded', () => {
  const line = nothingToDownload('Shared', 'this note',
    [{ path: 'Shared/clip.mov', bytes: 400 * MB }], [], 32 * MB);

  assert.doesNotMatch(line, /already downloaded/);
  assert.match(line, /this note/);
  assert.match(line, /clip\.mov/, '§7.5: the file');
  assert.match(line, /400 MB/, '§7.5: its size');
  assert.match(line, /32 MB/, '§7.5: the cap');
});

test('a command that cannot fetch a missing blob says so instead of claiming success', () => {
  const line = nothingToDownload('Shared', 'this workspace', [],
    [{ path: 'Shared/old.zip', bytes: 5 * MB }]);

  assert.doesNotMatch(line, /already downloaded/);
  assert.match(line, /old\.zip/);
});

// ------------------------------------------------- the wiring these strings need

// ⚠ Both functions above are only honest if their CALLER hands them everything,
// and the caller is `main.ts` — which imports `obsidian` and so cannot be loaded
// here. Both take their extra buckets as optional parameters, so forgetting one is
// not a type error and not a test failure: it is a status bar that says "synced"
// beside a file that is not on the disk, which is the defect this whole section
// exists to have ended.
const MAIN = readFileSync(fileURLToPath(new URL('../../main.ts', import.meta.url)), 'utf8');

test('the status bar is handed all three buckets, not just the fetchable one', () => {
  const start = MAIN.indexOf('syncedStatus(');
  assert.notEqual(start, -1, 'main.ts no longer calls syncedStatus');
  const args = MAIN.slice(start, MAIN.indexOf(');', start));

  assert.match(args, /deferredAttachments/);
  assert.match(args, /tooLargeAttachments/, '§7.5 would otherwise reach no surface at all');
  assert.match(args, /unavailableAttachments/, '§6.5 likewise');
  assert.match(args, /blobMemoryCap\(\)/, '§7.5 names the cap, so the cap has to be passed');
});

test('no download command claims an attachment is downloaded on its own authority', () => {
  assert.equal(
    MAIN.includes("'ShadowLink: every attachment"), false,
    'that claim belongs to nothingToDownload, which can see the buckets a command cannot',
  );
  assert.match(MAIN, /nothingToDownload\(/, 'and main.ts has to actually call it');
});

// -------------------------------------------- §7.5: "on this disk, but unchecked"

const UNCHECKABLE = [{ path: 'Shared/clip.mov', bytes: 220 * 1024 * 1024 }];

/**
 * ⚠ THE FOURTH BUCKET, and the one rule that makes it different from the other
 * three: the bytes ARE here.
 *
 * Every other refusal on this page means "this version is not on this disk", so
 * they belong in the visible count and in the download command's answer. This one
 * means "the file is here and this device cannot look at it", which has three
 * consequences for the wording and each of them is a separate way to get it wrong:
 *
 *  - It must NOT claim the file changed. The branch never computed a hash, and it
 *    fires just as readily for a file nobody has touched since it arrived.
 *  - It must NOT send the user to the download command. There is nothing to
 *    download, and a command that answers "already downloaded" would be right.
 *  - It must say what the actual consequence is, which no other bucket has: a
 *    change made here cannot be detected, so it would not be shared.
 */
test('an unchecked local attachment is a tooltip line and never a visible count', () => {
  const line = syncedStatus('Shared', [], [], [], 100 * 1024 * 1024, UNCHECKABLE);

  assert.equal(
    line.text, 'ShadowLink: synced',
    'the count is already three segments long and this bucket is rarer than all three',
  );
  assert.match(line.tooltip, /clip\.mov/);
  assert.match(line.tooltip, /too large for this device to check/);
  assert.match(line.tooltip, /limit 100 MB/);
  assert.match(line.tooltip, /on this disk/);
  assert.match(line.tooltip, /nothing is missing for anybody else/);
  assert.match(line.tooltip, /would not be shared/);
  assert.doesNotMatch(
    line.tooltip, /changed/,
    'the branch never computed a hash: it cannot know whether anything changed',
  );
  assert.doesNotMatch(
    line.tooltip, /Download attachments/,
    'the file is here — a download command has nothing to fetch and would say so',
  );
});

// It rides alongside the other three rather than replacing any of them: a share
// can easily be in all four states at once, and each has a different remedy.
test('the unchecked bucket is added to the tooltip without disturbing the three counts', () => {
  const line = syncedStatus(
    'Shared',
    [{ bytes: 1024 }],
    [{ path: 'Shared/big.mov', bytes: 300 * 1024 * 1024 }],
    [{ path: 'Shared/gone.png', bytes: 2048 }],
    100 * 1024 * 1024,
    UNCHECKABLE,
  );

  assert.equal(
    line.text,
    'ShadowLink: synced · 1 attachment(s) available · 1 too large for this device · 1 unavailable',
  );
  assert.match(line.tooltip, /clip\.mov/, 'and the fourth still reaches the tooltip');
  assert.match(line.tooltip, /big\.mov/);
  assert.match(line.tooltip, /gone\.png/);
});

/**
 * ⚠ And the reason this bucket is NOT folded into `unfetchableLines`.
 *
 * "Nothing in this note can be downloaded here" would be false: everything in it
 * already is. The honest answer is the one the command has always given, with the
 * consequence the user cannot otherwise learn appended to it.
 */
test('a download command with only unchecked attachments still says everything is downloaded', () => {
  const answer = nothingToDownload('Shared', 'this note', [], [], 100 * 1024 * 1024, UNCHECKABLE);

  assert.match(answer, /every attachment in this note is already downloaded/);
  assert.match(answer, /clip\.mov/);
  assert.match(answer, /too large for this device to check/);
  assert.doesNotMatch(answer, /nothing in this note can be downloaded/);
  assert.doesNotMatch(answer, /changed/);
});

test('a download command that really can fetch nothing still reports the unchecked ones', () => {
  const answer = nothingToDownload(
    'Shared', 'this workspace',
    [{ path: 'Shared/big.mov', bytes: 300 * 1024 * 1024 }],
    [],
    100 * 1024 * 1024,
    UNCHECKABLE,
  );

  assert.match(answer, /nothing in this workspace can be downloaded here/);
  assert.match(answer, /big\.mov/);
  assert.match(answer, /clip\.mov/);
});

// The whole bucket is optional at the type level, exactly like the other two, so
// forgetting to pass it is not a type error — it is a silence that reads as
// "everything here is fine". Same failure, same guard.
test('main.ts hands the unchecked bucket to both surfaces', () => {
  const start = MAIN.indexOf('syncedStatus(');
  assert.notEqual(start, -1, 'main.ts no longer calls syncedStatus');
  assert.match(
    MAIN.slice(start, MAIN.indexOf(');', start)), /uncheckableAttachments/,
    '§7.5\'s local half would otherwise reach no surface at all',
  );
  assert.match(MAIN, /uncheckableAttachments/, 'and the reconciler getter has to be read');
});

// ---------------------------------------------------------------- §6.2.6, the bar
//
// This wording had NO test at all until it moved here, and the reason is on
// record: it lived in `main.ts`, `main.ts` imports `obsidian`, and so the only
// thing that could check it was a guard that reads the file as text. That guard
// had a fail-open bug of its own. Plural forms, the branch between the two
// parked sentences, and whether a parked entry reaches the tooltip at all were
// all invisible — and every one of them is a sentence a user acts on.

test('a parked note asks for the thing that would actually end it', () => {
  assert.equal(
    parkedLine([{ reason: 'empty' }]),
    '1 note is empty and has not been shared yet — it will be shared as soon as you type.',
  );
  assert.equal(
    parkedLine([{ reason: 'not-text' }]),
    '1 file is named .md but is not text — rename it to share it.',
  );
});

test('the parked line counts, and agrees with itself in the plural', () => {
  assert.equal(
    parkedLine([{ reason: 'empty' }, { reason: 'empty' }]),
    '2 notes are empty and have not been shared yet — they will be shared as soon as you type.',
  );
  assert.equal(
    parkedLine([{ reason: 'not-text' }, { reason: 'not-text' }]),
    '2 files are named .md but are not text — rename them to share them.',
  );
});

test('the parked reasons are one line each, never one merged count', () => {
  // They ask the user for different things, so a single "3 files are not being
  // shared" would tell them to do neither.
  const line = parkedLine([{ reason: 'not-text' }, { reason: 'empty' }, { reason: 'empty' }]);
  assert.equal(line.split('\n').length, 2);
  assert.match(line, /^2 notes are empty/, 'the empty case comes first, in either order');
  assert.match(line, /\n1 file is named \.md/);
});

test('an empty attachment is not told to type into it', () => {
  // I6 reaches the tooltip on the attachment arm too, and it asks for the thing
  // that would actually end it. "It will be shared as soon as you type" is an
  // instruction, and typing is not what puts bytes in a .png.
  assert.equal(
    parkedLine([{ reason: 'empty-attachment' }]),
    '1 attachment is empty and has not been shared yet — it will be shared once the file '
    + 'has something in it.',
  );
  assert.equal(
    parkedLine([{ reason: 'empty-attachment' }, { reason: 'empty-attachment' }]),
    '2 attachments are empty and have not been shared yet — they will be shared once the '
    + 'files have something in them.',
  );
});

test('a note with no file on this device is not asked for a keystroke', () => {
  // Every other sentence here names something about a file on this device, and
  // for a parked entry whose binding has gone there is no such file — the node
  // is still live, so the park stays and the file may yet come back, but "it
  // will be shared as soon as you type" is an instruction pointing at nothing.
  assert.equal(
    parkedLine([{ reason: 'unbound' }]),
    '1 file in the share is not on this device — nothing is being shared for it from here.',
  );
  assert.equal(
    parkedLine([{ reason: 'unbound' }, { reason: 'unbound' }]),
    '2 files in the share are not on this device — nothing is being shared for them from here.',
  );
});

test('the four parked reasons are four lines, in one fixed order', () => {
  const line = parkedLine([
    { reason: 'unbound' }, { reason: 'not-text' }, { reason: 'empty-attachment' },
    { reason: 'empty' },
  ]);
  const lines = line.split('\n');
  assert.equal(lines.length, 4, 'one instruction per reason, never a merged count');
  assert.match(lines[0], /^1 note is empty/);
  assert.match(lines[1], /^1 attachment is empty/);
  assert.match(lines[2], /^1 file is named \.md/);
  assert.match(lines[3], /^1 file in the share is not on this device/);
});

test('nothing parked is no line at all', () => {
  assert.equal(parkedLine([]), '');
});

// ---------------------------------------------------------------- the whole line

const SYNCED: StatusLine = { text: 'ShadowLink: synced', tooltip: 'Sharing Shared' };
const bar = {
  paused: null as string | null,
  ready: true,
  busy: false,
  pending: 0,
  parked: [] as ReadonlyArray<{ reason: ParkReason }>,
  synced: (): StatusLine => SYNCED,
  route: {
    serverAnswersElsewhere: false,
    framesIn: 0,
    framesOut: 0,
    condemned: false,
  } as MuxRouteFacts,
  compatibility: { active: false, requested: false, chosen: false },
};

/** The four facts that make the unserved sentence true, with `framesOut` free. */
const DELIVERING_NOTHING = (framesOut: number): MuxRouteFacts => ({
  serverAnswersElsewhere: true,
  framesIn: 0,
  framesOut,
  condemned: false,
});

/** The lever on, in force, and nothing having changed since the plugin loaded. */
const LEVER_ON = { active: true, requested: true, chosen: true };

test('a paused share says so and says why, before anything else', () => {
  assert.deepEqual(
    statusLine({ ...bar, paused: 'the workspace id changed', busy: true, pending: 4 }),
    { text: 'ShadowLink: paused', tooltip: 'the workspace id changed' },
  );
});

test('a share that has not joined yet says starting, not synced', () => {
  assert.deepEqual(statusLine({ ...bar, ready: false }), {
    text: 'ShadowLink: starting…',
    tooltip: 'ShadowLink is joining the workspace.',
  });
});

test('work owed reads as work owed, and names the count', () => {
  assert.deepEqual(statusLine({ ...bar, pending: 3 }), {
    text: 'ShadowLink: syncing…',
    tooltip: '3 file(s) waiting to upload',
  });
});

test('a pass in flight with nothing owed says what it is doing', () => {
  assert.deepEqual(statusLine({ ...bar, busy: true }), {
    text: 'ShadowLink: syncing…',
    tooltip: 'Reconciling the vault',
  });
});

test('a parked entry never reads as waiting to upload', () => {
  // §6.2.6. Waiting is not what fixes either park, so neither may be counted —
  // and a bare "synced" beside a note that is not being shared is false in the
  // direction that stops the user looking. It reaches the tooltip and stops.
  const line = statusLine({ ...bar, parked: [{ reason: 'empty' }] });
  assert.equal(line.text, 'ShadowLink: synced', 'the count is untouched');
  assert.equal(
    line.tooltip,
    'Sharing Shared\n1 note is empty and has not been shared yet — '
    + 'it will be shared as soon as you type.',
  );
});

test('a parked entry stays out of the count while a real upload is owed', () => {
  assert.deepEqual(statusLine({ ...bar, pending: 1, parked: [{ reason: 'empty' }] }), {
    text: 'ShadowLink: syncing…',
    tooltip: '1 file(s) waiting to upload',
  });
});

test('nothing parked leaves the synced line exactly as it was', () => {
  assert.deepEqual(statusLine(bar), SYNCED);
});

test('the synced line is not built unless it is going to be shown', () => {
  // It walks three attachment buckets. A paused or syncing bar has no use for it
  // and never asked for it before this moved; the thunk keeps that true.
  let built = 0;
  const synced = (): StatusLine => { built += 1; return SYNCED; };
  statusLine({ ...bar, paused: 'stopped', synced });
  statusLine({ ...bar, ready: false, synced });
  statusLine({ ...bar, pending: 2, synced });
  assert.equal(built, 0);
  statusLine({ ...bar, synced });
  assert.equal(built, 1);
});

// ------------------------------------------- the transport's own sentence (§4)

test('a route delivering nothing says THAT, not "could not reach the workspace"', () => {
  // ⚠ THE STATE THE PREVIOUS ROUND LEFT WITH NOTHING TO SAY. Measured on the
  // parent branch through a proxy that upgrades `/_mux` for real and drops every
  // server frame: 70 s, 3 sockets, 2 idle closures, 18 frames out, 0 in, no
  // verdict, no notice, and this bar reading "ShadowLink could not reach the
  // workspace" while a control client synced with that same server on the
  // per-room route. The pause is the one claim measurement has ruled out, so the
  // specific line outranks it.
  const line = statusLine({
    ...bar,
    paused: 'ShadowLink could not reach the workspace. Editing locally; sync is paused.',
    ready: false,
    route: DELIVERING_NOTHING(18),
  });
  assert.equal(line.text, 'ShadowLink: not syncing');
  assert.equal(line.tooltip, unservedLine(18));
  assert.equal(
    line.tooltip.includes('could not reach'), false,
    'the bar repeated the one thing the probe disproved',
  );
});

test('the sentence claims only what was measured, and names the lever', () => {
  const line = unservedLine(18);
  assert.match(line, /can reach your server/);
  assert.match(line, /18 message\(s\) have gone out on it and none have come back/);
  assert.match(line, /Nothing is syncing/);
  assert.match(line, /"Use the compatibility connection"/,
    'a state with no automatic remedy must name the one the user has');
  // ⚠ NOT A DIAGNOSIS, and this half is the whole round. Three previous versions
  // of this state inferred a cause from how long an answer took, and every one of
  // them told somebody their current server was old.
  for (const forbidden of [/older/, /out of date server/, /update the server/i, /version/]) {
    assert.equal(forbidden.test(line), false,
      `the honest line made a claim about the server: ${String(forbidden)}`);
  }
  assert.equal(/is misconfigured|is broken|is blocking/.test(line), false,
    'the honest line diagnosed the deployment it cannot see');
});

test('the count in the sentence is the link\'s own, not a fixed phrase', () => {
  assert.match(unservedLine(1), /1 message\(s\)/);
  assert.match(unservedLine(184), /184 message\(s\)/);
});

test('a route that never opened at all does not report "0 messages"', () => {
  // ⚠ TWO DEPLOYMENTS REACH THIS STATE. One upgrades the socket and swallows
  // every frame; the other never answers the upgrade, so nothing was ever
  // written. Measured on the second at 12,900 ms with `framesOut` still zero,
  // where the counted sentence is true and reads as a bug.
  const line = unservedLine(0);
  assert.equal(/0 message\(s\)/.test(line), false);
  assert.match(line, /not carried a single message, in either direction/);
  assert.match(line, /can reach your server/);
  assert.match(line, /"Use the compatibility connection"/);
});

test('no unserved state leaves every other line exactly as it was', () => {
  assert.deepEqual(statusLine({ ...bar }), SYNCED);
  assert.equal(statusLine({ ...bar, paused: 'stopped' }).text, 'ShadowLink: paused');
});

test('the sentence is a function of four current facts and holds no memory', () => {
  // ⚠ THE ROUND, IN ONE TEST. Five rounds gave this sentence a stored home and
  // then tried to enumerate every moment it had to be taken back; each round found
  // a real retraction, shipped it, and left the same defect in a new fork, because
  // every retraction needed the link to still be TALKING. A path that goes dark
  // talks to nobody: measured on the previous branch, statement at 45,170 ms, path
  // black-holed and RST at 45,188 ms, still on the bar at 105,236 ms with
  // `dialsRefused` 0 and the watchdog frozen at one closure.
  //
  // There is nothing to retract here. Each fact is read where the bar is drawn,
  // and flipping any one of them ends the sentence in the same statement that
  // produced it.
  const live = DELIVERING_NOTHING(11);
  assert.equal(routeUnserved(live), true);

  // The probe stops answering — a killed server, a dropped association, a DROP
  // rule. No mechanism runs; the value is simply different on the next poll.
  assert.equal(routeUnserved({ ...live, serverAnswersElsewhere: false }), false,
    'the claim survived the evidence for it going away');
  // A frame arrives: the clause that made it worth saying stops being true.
  assert.equal(routeUnserved({ ...live, framesIn: 1 }), false,
    'a route that delivered something still read as delivering nothing');
  // A verdict: the fallback owns the tree, and its own line is the one that fits.
  assert.equal(routeUnserved({ ...live, condemned: true }), false,
    'a session that had already fallen back was told nothing was syncing');
});

test('a probe that is not answering cannot suppress the sentence that is true', () => {
  // ⚠ THE PRECEDENCE FAILURE, AND WHY THE ORDERING IS SAFE AGAIN. `routeUnserved`
  // outranks `paused`, so while it was a stored record it could hide "ShadowLink
  // could not reach the workspace" using evidence that had expired a minute
  // earlier — measured, 60 s of it over a path that was dark the whole time. A
  // claim that stops being computable the instant the probe stops answering cannot
  // hide anything it can no longer support.
  const paused = 'ShadowLink could not reach the workspace. Editing locally; sync is paused.';
  const dark = statusLine({
    ...bar,
    paused,
    ready: false,
    route: { ...DELIVERING_NOTHING(11), serverAnswersElsewhere: false },
  });
  assert.equal(dark.text, 'ShadowLink: paused');
  assert.equal(dark.tooltip, paused);
});

// ------------------------------------------------------- the lever, made visible

test('the compatibility connection is visible on every state, and says how to undo it', () => {
  // A lever whose effect is invisible is a lever the user forgets they pulled,
  // and this one costs continuous sync of unopened notes for the whole session.
  for (const state of [
    { ...bar },
    { ...bar, paused: 'stopped' },
    { ...bar, ready: false },
    { ...bar, pending: 2 },
  ]) {
    const line = statusLine({ ...state, compatibility: LEVER_ON });
    assert.ok(line.tooltip.endsWith(COMPATIBILITY_LINE),
      `the compatibility line is missing from "${line.text}"`);
  }
  assert.match(COMPATIBILITY_LINE, /Turn it off/, 'the way back has to be in the sentence');
  assert.match(COMPATIBILITY_LINE, /stay out of date until you open them/,
    'and so does what it costs');
});

test('compatibility off adds nothing at all', () => {
  assert.deepEqual(
    statusLine({ ...bar, compatibility: { active: false, requested: false, chosen: false } }),
    SYNCED,
  );
});

// ------------------------------------ the lever, reported as what it actually did

test('the bar reports the transport that was built, never the setting alone', () => {
  // ⚠ MEASURED IN BOTH DIRECTIONS, against a real deaf proxy. The transport is
  // chosen once, when the plugin loads, so from the moment the toggle is touched
  // until the reload the setting is an INTENTION and the bar was reading it as a
  // fact. Thrown ON at 40,146 ms with no reload, one tooltip told the user to
  // turn the setting on and, two lines later, that it was already in force and
  // they could turn it off — while `MuxLink` was still the transport and still
  // delivering nothing, so a user who believed "is using" never reloaded. Turned
  // OFF at 20,138 ms in a session that started in compatibility mode, the only
  // sentence disclosing that unopened notes were going stale simply vanished,
  // while `mux.stats.socketsOpened` was still 0.
  assert.equal(
    compatibilityLine({ active: false, requested: true, chosen: false }),
    COMPATIBILITY_PENDING_LINE,
    'a lever that has been thrown and has not taken effect said nothing at all',
  );
  assert.equal(
    compatibilityLine({ active: true, requested: false, chosen: true }),
    COMPATIBILITY_STALE_LINE,
    'a cost still being paid lost the only sentence that disclosed it',
  );
  assert.equal(
    compatibilityLine({ active: true, requested: true, chosen: true }), COMPATIBILITY_LINE,
  );
  assert.equal(
    compatibilityLine({ active: false, requested: false, chosen: false }), null,
  );
});

test('every compatibility sentence names what to do, and none contradicts another', () => {
  // The two that describe a disagreement between the setting and the transport
  // must both say the same thing about how to end it, because that is the whole
  // of what the user can do about it.
  for (const line of [COMPATIBILITY_PENDING_LINE, COMPATIBILITY_STALE_LINE]) {
    assert.match(line, /Reload the plugin/, 'a line about a stale choice named no way out');
    assert.match(line, /chosen\s*once, when the plugin loads/,
      'it never says WHY the setting has not taken effect');
  }
  // …and neither of them may claim the state the other one describes.
  assert.equal(/is using the compatibility connection/.test(COMPATIBILITY_PENDING_LINE), false,
    'the pending line claims a fix is already in force');
  assert.equal(/still using the multiplexed/.test(COMPATIBILITY_STALE_LINE), false,
    'the stale line claims the mux is carrying a session that is not on it');
  // The cost is named wherever it is being paid, and only there.
  for (const line of [COMPATIBILITY_LINE, COMPATIBILITY_STALE_LINE, COMPATIBILITY_FALLBACK_LINE]) {
    assert.match(line, /stay out of date until you open them/,
      'a session paying the compatibility cost was not told what it costs');
  }
  assert.equal(/stay out of date/.test(COMPATIBILITY_PENDING_LINE), false,
    'a session still on the mux was told it was paying the fallback\'s cost');
});

test('the fallback the software threw is disclosed like the one the user threw', () => {
  // ⚠ THE SESSION PAYS THE IDENTICAL COST EITHER WAY. Before this the automatic
  // fallback got a fifteen-second Notice and then no persistent marker at all,
  // because the bar read the setting — which is false for a fallback nobody asked
  // for. It names no cause: the verdict's own Notice already named one, and this
  // line outlives it.
  const line = statusLine({
    ...bar, compatibility: { active: true, requested: false, chosen: false },
  });
  assert.equal(line.tooltip, `${SYNCED.tooltip}\n${COMPATIBILITY_FALLBACK_LINE}`);
  for (const forbidden of [/older/, /update the server/i, /proxy/, /version/]) {
    assert.equal(forbidden.test(COMPATIBILITY_FALLBACK_LINE), false,
      `a persistent line diagnosed the deployment: ${String(forbidden)}`);
  }
});

test('the pending line rides the unserved sentence, which is where it is wanted', () => {
  // The state a user is in the instant after they follow the bar's own advice:
  // the route is still delivering nothing, and the toggle they just flipped has
  // not done anything yet. Both sentences are true and both are needed.
  const line = statusLine({
    ...bar,
    route: DELIVERING_NOTHING(12),
    compatibility: { active: false, requested: true, chosen: false },
  });
  assert.equal(line.text, 'ShadowLink: not syncing');
  assert.equal(line.tooltip, `${unservedLine(12)}\n${COMPATIBILITY_PENDING_LINE}`);
});

test('main.ts states the bar rather than composing it', () => {
  // The point of the move: the strings are gone from the file no test can load.
  assert.match(MAIN, /statusLine\(/, 'main.ts must call the tested function');
  assert.equal(
    MAIN.includes('none have come back'), false,
    'the transport sentence lives where the suite can read it',
  );
  assert.equal(
    MAIN.includes('file(s) waiting to upload'), false,
    'the wording lives where the suite can read it',
  );
  assert.equal(
    MAIN.includes('has not been shared yet'), false,
    'and so does the parked sentence',
  );
});
