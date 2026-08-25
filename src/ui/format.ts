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
// No `obsidian` import: the status bar's copy of this runs in `main.ts`, the
// button's copy runs inside a markdown post-processor, and neither should have to
// reach into the modal module to get it.

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
