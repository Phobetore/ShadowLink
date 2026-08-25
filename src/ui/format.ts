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
 */
export function syncedStatus(
  shareRoot: string,
  deferred: readonly { bytes: number }[],
): StatusLine {
  if (deferred.length === 0) {
    return { text: 'ShadowLink: synced', tooltip: `Sharing ${shareRoot}` };
  }
  const bytes = deferred.reduce((sum, d) => sum + d.bytes, 0);
  return {
    text: `ShadowLink: synced · ${deferred.length} attachment(s) available`,
    tooltip: `${deferred.length} attachment(s) not downloaded (${formatBytes(bytes)}). `
      + 'Run "ShadowLink: Download attachments" to choose which to fetch.',
  };
}
