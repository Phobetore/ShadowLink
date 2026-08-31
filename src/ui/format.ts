// src/ui/format.ts
// How ShadowLink says a size, and how it says what has not arrived.
//
// Bytes live here because three different surfaces have to say the same number the
// same way — the first-sync modal, the status bar's tooltip and the download
// button inside a note — and a share that is "3.1 GB" in one place and "3174 MB"
// in another reads as two different facts about the same vault.
//
// The status line lives here because it is the one piece of wording in the plugin
// that is load-bearing rather than cosmetic (§7.3), and a string built inline in
// `main.ts` is a string no test can hold.
//
// THE TRANSPORT'S OWN SENTENCE is here for the same reason and one more. When the
// multiplexed connection delivers nothing while the server answers, the bar has to
// say that and name the setting that fixes it — and every clause of it has to be
// something that was measured rather than inferred, because the three previous
// attempts at this state all inferred, and all of them told somebody their current
// server was old. A sentence that load-bearing does not belong in a file no test
// can import. See `unservedLine` and `COMPATIBILITY_LINE`.
//
// THE WHOLE BAR now, not just the synced half, and that is why `statusLine` and
// `parkedLine` moved here. They were built inline in `main.ts`, `main.ts` imports
// `obsidian`, and the only thing in the suite that could reach them was a guard
// reading the file as TEXT — which is not a test of a sentence, and which had a
// fail-open bug of its own for as long as it existed. Plural forms, the branch
// between the two parked sentences and whether a parked entry reached the tooltip
// at all were unverified by anything, and every one of them is a sentence a user
// acts on.
//
// No `obsidian` import: the status bar's copy of this runs in `main.ts`, the
// button's copy runs inside a markdown post-processor, and neither should have to
// reach into the modal module to get it. `ParkReason` arrives as a TYPE import, so
// nothing of the publish queue is pulled in at runtime.

import type { ParkReason } from '../sync/PublishQueue.ts';

/**
 * A size with one significant decimal where that helps and none where it does
 * not, and never a bare `0` for a file that exists.
 *
 * "0 KB" beside a filename reads as "this file is empty", which for a 300-byte
 * attachment is a different claim from the true one — so anything non-zero
 * rounds up to at least 1 KB.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface StatusLine {
  text: string;
  tooltip: string;
}

/** One attachment the status line has to be able to name. */
export interface NamedAttachment {
  path: string;
  bytes: number;
}

/** Longest sample the tooltip lists before it starts counting instead. */
const MAX_NAMED = 3;

/**
 * Everything the status bar depends on, as data.
 *
 * `synced` is a THUNK rather than a value because building it walks three
 * attachment buckets, and three of the four branches below never look at it —
 * which was true of the inline version too, and is worth keeping true rather
 * than paying for on every poll.
 */
export interface BarState {
  /** Why the plugin has stopped writing, or null. Outranks everything. */
  paused: string | null;
  /** Has the workspace been joined? */
  ready: boolean;
  /** A reconcile pass is running or scheduled. */
  busy: boolean;
  /** Entries the queue will act on by itself. NEVER the parked ones. */
  pending: number;
  /** Entries refused over the state of the user's own file. */
  parked: ReadonlyArray<{ reason: ParkReason }>;
  /** What §7.3 says once a pass has finished and nothing is pending. */
  synced: () => StatusLine;
  /**
   * The server answers, and the multiplexed connection has delivered nothing.
   * Null whenever that is not measurably the case.
   *
   * `framesOut` is the count of messages this session has written into it, and it
   * is here so the sentence can be specific rather than atmospheric.
   */
  unserved: { framesOut: number } | null;
  /** Which connection is actually carrying the tree, and which one was asked for. */
  compatibility: BarCompatibility;
}

/**
 * The compatibility connection, told apart from the setting that asks for it.
 *
 * ⚠ THE BAR USED TO REPORT THE SETTING, WHICH IS AN INTENTION. The transport is
 * chosen once, when the runtime is built, so during the only window in which
 * anybody throws this lever the two disagree — and the disclosure was false in
 * both directions. Measured against a real deaf proxy: the lever thrown at
 * 40,146 ms with no reload put one tooltip in front of the user telling them to
 * turn the setting ON and, two lines later, that it was already in force and
 * they could turn it off — while `MuxLink` was still the transport and still
 * delivering nothing. Reversed, a session started in compatibility mode with the
 * lever turned off at 20,138 ms silently dropped the only sentence that ever
 * disclosed the cost, while `mux.stats.socketsOpened` was still 0.
 *
 * So all three facts travel, and each line below is true of exactly one of the
 * four states they make.
 */
export interface BarCompatibility {
  /** The per-note transport is what is carrying the tree RIGHT NOW. */
  active: boolean;
  /** What the setting says right now. An intention until the plugin reloads. */
  requested: boolean;
  /** What the setting said when the transport was built. */
  chosen: boolean;
}

/**
 * What the bar says while the multiplexed connection is delivering nothing.
 *
 * ⚠ EVERY CLAUSE IS SOMETHING THAT WAS MEASURED, AND NOTHING ELSE IS HERE. The
 * server answering is the bridge's probe having synced on the per-room route; the
 * counts are the link's own; "nothing is syncing" is the tree being unsynced on
 * the transport that is carrying it. There is deliberately no claim about the
 * server's version, its age, or the cause — three rounds tried to infer one from
 * how long an answer took, and each shipped a sentence telling somebody their
 * current server was old.
 *
 * The last line is a CONDITIONAL naming a lever, not a diagnosis. A self-hoster
 * knows whether their deployment carries that route; this client does not, and
 * saying so is what makes the toggle findable at the moment it is wanted.
 *
 * ⚠ ZERO GETS ITS OWN CLAUSE. The two deployments that reach this state differ:
 * one upgrades the socket and swallows every frame, the other never answers the
 * upgrade at all — measured at 12,900 ms with `framesOut` still zero, where
 * "0 message(s) have gone out on it and none have come back" is true and reads
 * as a bug in the sentence.
 */
export function unservedLine(framesOut: number): string {
  const evidence = framesOut > 0
    ? `${framesOut} message(s) have gone out on it and none have come back. `
    : 'it has not carried a single message, in either direction. ';
  return 'ShadowLink can reach your server, but nothing is coming back on its multiplexed '
    + `connection: ${evidence}`
    + 'Nothing is syncing while that is true.\n'
    + 'If your server, or something in front of it, does not carry that connection, turn on '
    + '"Use the compatibility connection" in ShadowLink\'s settings.';
}

/**
 * The line appended whenever the compatibility connection is in force.
 *
 * A lever the user cannot see the effect of is a lever they will forget they
 * pulled, and this one costs continuous sync of unopened notes. It appears on
 * every state, including "synced", for exactly that reason — and it names the way
 * back.
 */
export const COMPATIBILITY_LINE =
  'ShadowLink is using the compatibility connection because "Use the compatibility '
  + 'connection" is on in its settings. Notes you have not opened will stay out of date '
  + 'until you open them. Turn it off, then reload the plugin, to go back.';

/**
 * The lever has been thrown and has not taken effect yet.
 *
 * ⚠ THE MOST IMPORTANT OF THE FOUR, because it is the only one anybody reads
 * while acting. The status bar's own sentence sends a stuck user to this setting;
 * the transport is chosen once, when the plugin loads; so between the toggle and
 * the reload the vault is in exactly the state the user thinks they have just
 * left. Saying so is both true and the one thing they can act on.
 */
export const COMPATIBILITY_PENDING_LINE =
  'ShadowLink is still using the multiplexed connection: "Use the compatibility '
  + 'connection" was turned on after this session started, and the connection is chosen '
  + 'once, when the plugin loads. Reload the plugin to apply it.';

/**
 * The lever was on when the session started and has since been turned off.
 *
 * ⚠ THE DANGEROUS HALF. The cost — unopened notes going stale — is still being
 * paid, and the setting that used to disclose it now says the opposite, so the
 * disclosure cannot come from the setting.
 */
export const COMPATIBILITY_STALE_LINE =
  'ShadowLink is still using the compatibility connection: "Use the compatibility '
  + 'connection" was turned off after this session started, and the connection is chosen '
  + 'once, when the plugin loads. Notes you have not opened will stay out of date until '
  + 'you open them. Reload the plugin to go back to the multiplexed one.';

/**
 * The plugin fell back on its own, and the setting was never involved.
 *
 * ⚠ THE SOFTWARE-THROWN LEVER GETS THE SAME DISCLOSURE AS THE USER-THROWN ONE.
 * The session pays an identical cost either way; before this it got a
 * fifteen-second Notice and then no persistent marker at all, because the bar
 * read the setting rather than the transport. It names no cause, because the
 * verdict that produced it already named one in its own Notice and this line
 * outlives that Notice.
 */
export const COMPATIBILITY_FALLBACK_LINE =
  'ShadowLink is using the compatibility connection for this session, because the '
  + 'multiplexed one could not be used. Notes you have not opened will stay out of date '
  + 'until you open them.';

/**
 * Which of the four sentences, if any, belongs under whatever the bar says.
 *
 * The order is the design: what is IN FORCE is what the user is living with, so
 * it is decided first; the setting only picks which of the two in-force sentences
 * — and, when nothing is in force, whether there is a pending one to report.
 */
export function compatibilityLine(state: BarCompatibility): string | null {
  if (state.active) {
    if (state.requested) return COMPATIBILITY_LINE;
    return state.chosen ? COMPATIBILITY_STALE_LINE : COMPATIBILITY_FALLBACK_LINE;
  }
  return state.requested ? COMPATIBILITY_PENDING_LINE : null;
}

/**
 * What the status bar should say right now.
 *
 * Five states in order, and the order is the design: a transport that is
 * measurably delivering nothing says the specific thing first; a share that has
 * stopped writing says so next; one that has not joined yet is not "synced"; work
 * owed is named as a count; and only then does §7.3's wording get a say. The
 * compatibility line is appended to whichever of the five wins, because it is
 * true of all of them.
 *
 * ⚠ `unserved` OUTRANKS `paused`, and that is not a cosmetic ordering. In that
 * state the pause reads "ShadowLink could not reach the workspace", which is the
 * one thing measurement has ruled out: the server answered the probe. True but
 * thin beats false, and specific beats both — the user's actual complaint is
 * "nothing is syncing", and that sentence is available without inferring
 * anything.
 *
 * `pending` EXCLUDES parked entries, and that exclusion is the whole of §6.2.6:
 * an empty note and a `.md` file that is not text are refused over the state of
 * the user's own file, no amount of waiting changes either, and counting them
 * pinned this bar on "syncing…" for the lifetime of a vault. They reach the
 * tooltip instead — a bare "synced" beside a note that is not being shared is
 * false in the direction that stops the user looking.
 */
export function statusLine(state: BarState): StatusLine {
  const line = barState(state);
  const compatibility = compatibilityLine(state.compatibility);
  if (compatibility === null) return line;
  return { text: line.text, tooltip: `${line.tooltip}\n${compatibility}` };
}

function barState(state: BarState): StatusLine {
  if (state.unserved !== null) {
    return {
      text: 'ShadowLink: not syncing',
      tooltip: unservedLine(state.unserved.framesOut),
    };
  }
  if (state.paused !== null) return { text: 'ShadowLink: paused', tooltip: state.paused };
  if (!state.ready) {
    return { text: 'ShadowLink: starting…', tooltip: 'ShadowLink is joining the workspace.' };
  }
  if (state.busy || state.pending > 0) {
    return {
      text: 'ShadowLink: syncing…',
      tooltip: state.pending > 0
        ? `${state.pending} file(s) waiting to upload`
        : 'Reconciling the vault',
    };
  }
  const synced = state.synced();
  if (state.parked.length === 0) return synced;
  return { text: synced.text, tooltip: `${synced.tooltip}\n${parkedLine(state.parked)}` };
}

/**
 * The tooltip line for entries the publish queue parked.
 *
 * ONE LINE PER REASON, never a merged count, because the four ask the user for
 * different things: one ends when they type, one when something writes bytes
 * into a file, one when they rename it, one when the file turns up on this
 * device at all. "4 files are not being shared" would tell them to do none of
 * it, and "waiting to upload" would be false for all four.
 *
 * An empty ATTACHMENT gets its own sentence rather than the note's. "It will be
 * shared as soon as you type" is an instruction, and typing is not what puts
 * bytes in a `.png`.
 *
 * `'unbound'` gets one for the same reason, one step further out: it is a file
 * this device has no copy of, so every other sentence here asks for something
 * that cannot be done. It is the only line that asks for nothing, and the only
 * one that PROMISES nothing either.
 *
 * That second part is load-bearing. `PublishQueue.parked()` reports ANY parked
 * entry with no materialized path as `'unbound'`, whatever parked it, so a
 * `.md` that is not text and an empty attachment both arrive here once their
 * file leaves the vault behind Obsidian's back. "It will be shared once the file
 * is back" was true for one of the three: for the other two the file coming back
 * re-parks the entry under its own reason and shares nothing. A sentence that
 * names an outcome the named event will not produce is worse than a short one.
 */
export function parkedLine(parked: ReadonlyArray<{ reason: ParkReason }>): string {
  const count = (reason: ParkReason): number => parked.filter((p) => p.reason === reason).length;
  const empty = count('empty');
  const emptyBlob = count('empty-attachment');
  const notText = count('not-text');
  const unbound = count('unbound');
  const lines: string[] = [];
  if (empty > 0) {
    lines.push(
      `${empty} ${empty === 1 ? 'note is' : 'notes are'} empty and ${empty === 1 ? 'has' : 'have'} `
      + `not been shared yet — ${empty === 1 ? 'it' : 'they'} will be shared as soon as you type.`,
    );
  }
  if (emptyBlob > 0) {
    lines.push(
      `${emptyBlob} ${emptyBlob === 1 ? 'attachment is' : 'attachments are'} empty and `
      + `${emptyBlob === 1 ? 'has' : 'have'} not been shared yet — `
      + `${emptyBlob === 1 ? 'it' : 'they'} will be shared once `
      + `${emptyBlob === 1 ? 'the file has' : 'the files have'} something in `
      + `${emptyBlob === 1 ? 'it' : 'them'}.`,
    );
  }
  if (notText > 0) {
    lines.push(
      `${notText} ${notText === 1 ? 'file is' : 'files are'} named .md but `
      + `${notText === 1 ? 'is' : 'are'} not text — rename `
      + `${notText === 1 ? 'it' : 'them'} to share ${notText === 1 ? 'it' : 'them'}.`,
    );
  }
  if (unbound > 0) {
    lines.push(
      `${unbound} ${unbound === 1 ? 'file in the share is' : 'files in the share are'} not on `
      + `this device — nothing is being shared for `
      + `${unbound === 1 ? 'it' : 'them'} from here.`,
    );
  }
  return lines.join('\n');
}

/**
 * What the status bar says once a pass has finished and nothing is pending.
 *
 * §7.3: THE WORDING HAD TO CHANGE, and this function is why it is testable. The
 * tree can agree on every peer that a path holds hash H while exactly one peer
 * holds the bytes — so "synced", said while twelve attachments were deliberately
 * not downloaded, is not shorthand. It is false, and false in the direction that
 * stops the user looking for a file that is genuinely not there.
 *
 * The count goes in the visible text and the byte total in the tooltip, because
 * the count is what makes somebody hover and the total is what makes the decision.
 *
 * THREE BUCKETS, NEVER ONE. §7.2, §7.4 and §6.5 are three different states and
 * only the FIRST has a remedy on this device, so only the first names the download
 * command. An oversized file is refused by the cap before an approval is even
 * consulted, and an unavailable one is bytes the store has answered 404 for — a
 * Download button offered for either is a button that can only fail, which is the
 * same broken promise the bare word "synced" was making.
 *
 * @param tooLarge  refused by this device's memory cap ON THE WAY IN (§7.4/§7.5).
 *                  NOT the local-file cases: a file this device cannot re-hash is
 *                  on disk and complete, and reporting it here would tell the user
 *                  a downloaded attachment is missing.
 * @param unavailable  bytes the workspace store no longer holds (§6.5).
 * @param memoryCapBytes  the cap `tooLarge` was measured against, so §7.5's
 *                  "naming the file, its size and the cap" can be honoured.
 * @param uncheckable  local files this device cannot hash (§7.4's other half).
 *                  TOOLTIP ONLY, and deliberately absent from the visible count:
 *                  the count is already three segments long and this bucket is
 *                  rarer than all three. It is also the one bucket where nothing
 *                  is missing, so a count would overstate it.
 */
export function syncedStatus(
  shareRoot: string,
  deferred: readonly { bytes: number }[],
  tooLarge: readonly NamedAttachment[] = [],
  unavailable: readonly NamedAttachment[] = [],
  memoryCapBytes?: number,
  uncheckable: readonly NamedAttachment[] = [],
): StatusLine {
  if (deferred.length === 0 && tooLarge.length === 0
      && unavailable.length === 0 && uncheckable.length === 0) {
    return { text: 'ShadowLink: synced', tooltip: `Sharing ${shareRoot}` };
  }

  const counts: string[] = [];
  const lines: string[] = [];

  if (deferred.length > 0) {
    const bytes = deferred.reduce((sum, d) => sum + d.bytes, 0);
    counts.push(`${deferred.length} attachment(s) available`);
    lines.push(
      `${deferred.length} attachment(s) not downloaded (${formatBytes(bytes)}). `
      + 'Run "ShadowLink: Download attachments" to choose which to fetch.',
    );
  }
  if (tooLarge.length > 0) counts.push(`${tooLarge.length} too large for this device`);
  if (unavailable.length > 0) counts.push(`${unavailable.length} unavailable`);
  lines.push(...unfetchableLines(shareRoot, tooLarge, unavailable, memoryCapBytes));
  const local = uncheckableLine(shareRoot, uncheckable, memoryCapBytes);
  if (local !== null) lines.push(local);

  // No count segment for `uncheckable`, so a share where it is the only thing
  // outstanding reads as plainly synced — which it is. Nothing is missing there.
  const text = counts.length === 0
    ? 'ShadowLink: synced'
    : `ShadowLink: synced · ${counts.join(' · ')}`;
  return { text, tooltip: lines.join('\n') };
}

/**
 * What a download command answers when it has nothing left to fetch (§7.3).
 *
 * "Every attachment here is already downloaded" is a claim, and it is only true
 * when NOTHING is outstanding. Said while an oversized or unavailable attachment
 * is missing, it is the same falsehood a bare "synced" was, made worse by where it
 * appears: the first-sync modal sends the user to this exact command, so the two
 * shipped surfaces contradict each other and the user follows the wrong one.
 *
 * Neither remaining bucket can be fetched by pressing anything — `fetchVerdict`
 * tests the memory cap before it consults an approval, and an unavailable object
 * is one the store has answered 404 for — so this says what IS true and stops.
 *
 * @param where  the scope the caller searched, as a phrase: "this note",
 *               "this workspace". It is the caller's, because only the caller
 *               knows which of the two it just looked through.
 */
export function nothingToDownload(
  shareRoot: string,
  where: string,
  tooLarge: readonly NamedAttachment[],
  unavailable: readonly NamedAttachment[],
  memoryCapBytes?: number,
  uncheckable: readonly NamedAttachment[] = [],
): string {
  const lines = unfetchableLines(shareRoot, tooLarge, unavailable, memoryCapBytes);
  // NOT one of the lines above, and this is the whole reason it is a separate
  // function. Those two are "this version is not on this disk", so they turn the
  // answer into "nothing here can be downloaded". This one is a file that IS
  // here — "already downloaded" stays true, and the consequence the user cannot
  // otherwise learn is appended to it rather than contradicting it.
  const local = uncheckableLine(shareRoot, uncheckable, memoryCapBytes);
  if (lines.length === 0) {
    const head = `ShadowLink: every attachment in ${where} is already downloaded.`;
    return local === null ? head : `${head} ${local}`;
  }
  if (local !== null) lines.push(local);
  return `ShadowLink: nothing in ${where} can be downloaded here. ${lines.join(' ')}`;
}

/**
 * The two buckets nothing on this device can act on, as sentences.
 *
 * Shared by the status bar's tooltip and by the download commands' answer so the
 * two cannot drift: a user who hovers the status bar and then runs the command is
 * asking the same question twice, and getting two different answers is how a
 * feature stops being believed.
 */
function unfetchableLines(
  shareRoot: string,
  tooLarge: readonly NamedAttachment[],
  unavailable: readonly NamedAttachment[],
  memoryCapBytes?: number,
): string[] {
  const out: string[] = [];
  if (tooLarge.length > 0) {
    const cap = memoryCapBytes === undefined ? '' : ` (limit ${formatBytes(memoryCapBytes)})`;
    out.push(
      `${tooLarge.length} attachment(s) are larger than this device will load${cap}: `
      + `${sample(shareRoot, tooLarge)}. They are still in the workspace and nothing is `
      + 'missing for anybody else — open them on a device with more memory.',
    );
  }
  if (unavailable.length > 0) {
    out.push(
      `${unavailable.length} attachment(s) are no longer held by the workspace store: `
      + `${sample(shareRoot, unavailable)}. Nothing on this device can fetch them; ask `
      + 'whoever still has a copy to add it again.',
    );
  }
  return out;
}

/**
 * The bucket where the bytes ARE here, as one sentence (§7.4, §7.5).
 *
 * Separate from the two above because it is the opposite claim, and three things
 * about the wording are load-bearing rather than stylistic:
 *
 *  - It must not say the file CHANGED. The branch it reports never computed a
 *    hash — that is the entire condition — and it fires just as readily for a file
 *    nobody has touched since it arrived.
 *  - It must not send the user to the download command. The file is on the disk;
 *    that command would correctly answer "already downloaded" and read as a
 *    contradiction.
 *  - It must say the consequence, because nothing else on any surface does: an
 *    edit made here cannot be detected, so it would not be shared.
 *
 * `bytes` is the size on THIS disk, which is what the stated limit is about.
 */
function uncheckableLine(
  shareRoot: string,
  uncheckable: readonly NamedAttachment[],
  memoryCapBytes?: number,
): string | null {
  if (uncheckable.length === 0) return null;
  const cap = memoryCapBytes === undefined ? '' : ` (limit ${formatBytes(memoryCapBytes)})`;
  return `${uncheckable.length} attachment(s) here are too large for this device to `
    + `check${cap}: ${sample(shareRoot, uncheckable)}. They are on this disk and nothing `
    + 'is missing for anybody else, but a change to one cannot be detected here, so it '
    + 'would not be shared.';
}

/**
 * A few names with their sizes, and an honest count of the rest.
 *
 * Share-relative, because a status-bar tooltip listing `Shared/img/diagram.png`
 * three times over is a wall the user reads none of — and because two files called
 * `diagram.png` in different folders are two different files, so the bare basename
 * would not do either.
 */
function sample(shareRoot: string, items: readonly NamedAttachment[]): string {
  const shown = items
    .slice(0, MAX_NAMED)
    .map((e) => `${relativeTo(shareRoot, e.path)} (${formatBytes(e.bytes)})`);
  if (items.length > MAX_NAMED) shown.push(`and ${items.length - MAX_NAMED} more`);
  return shown.join(', ');
}

function relativeTo(shareRoot: string, path: string): string {
  const prefix = `${shareRoot.replace(/\/+$/, '')}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
