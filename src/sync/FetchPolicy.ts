// src/sync/FetchPolicy.ts
// Which attachments this device downloads, and which it does not (spec §7.2).
//
// This is four lines of arithmetic in its own module for one reason: TWO callers
// have to reach the same answer. `Reconciler.materializeBlob` decides what the
// pass actually fetches, and `Bootstrap.classify` tells the user, before they
// agree to anything, how many attachments will arrive and how many will not. Two
// copies of the rule would agree on the day they were written and diverge on the
// day one of them gained a ceiling — and the failure would be silent, because a
// modal that promises 412 files and a pass that fetches 40 both "work".
//
// TWO GATES, NOT ONE. A per-file ceiling alone is not enough: 4,000 files of one
// megabyte each pass every per-file check that has ever been written and still
// eat a data plan. So there is a persisted per-file approval threshold AND a
// per-session budget that is deliberately not persisted — the first is a
// statement about a file, the second about an afternoon on a phone tether.
//
// No `obsidian` import, no node builtins.

/**
 * What the policy says about one attachment.
 *
 *  - `yes`            fetch it.
 *  - `tooLarge`       this device cannot hold it in memory at all (§7.4). Hard,
 *                     per device, and not something approval can lift.
 *  - `needsApproval`  over the auto-fetch ceiling: PERSISTED as `fetchDeferred`,
 *                     so the user can ask for it later and the UI can offer to.
 *  - `sessionBudget`  this session has fetched enough unattended. NOT persisted,
 *                     and retried from zero next session.
 */
export type FetchVerdict = 'yes' | 'tooLarge' | 'needsApproval' | 'sessionBudget';

export interface FetchLimits {
  /**
   * §7.4's per-device whole-file allocation cap. `createBinary` takes a whole
   * buffer, `requestUrl` buffers a whole response and Web Crypto has no
   * incremental digest, so this is a fact about the device rather than a policy.
   */
  memoryCapBytes: number;
  /** The largest attachment this device fetches without being asked. */
  autofetchMaxBytes: number;
  /** How many bytes one session may fetch unattended, across every attachment. */
  sessionBudgetBytes: number;
}

/**
 * Spec §7.2's decision, on one attachment's byte count.
 *
 * ONE DEVIATION FROM THE PSEUDOCODE, and it is deliberate: §7.2 tests
 * `fetchApproved` first, which would let an approval lift the MEMORY CAP as well
 * as the two policy ceilings. §7.4 states the cap gates every whole-file
 * allocation, and §7.5 says an inbound file above it is refused before any
 * request is made — because the alternative is a phone that dies holding half of
 * a 200 MB video the user just tapped "Download" on. An approval is a statement
 * about wanting the file, never about having the memory for it, so the cap is
 * tested first and `tooLarge` outranks everything.
 *
 * Every comparison is `>`, so a file exactly at a ceiling is allowed: the
 * ceilings are "this much is fine", not "strictly less than this".
 */
export function fetchVerdict(
  bytes: number,
  limits: FetchLimits,
  approved: boolean,
  spentThisSession: number,
): FetchVerdict {
  if (bytes > limits.memoryCapBytes) return 'tooLarge';
  if (approved) return 'yes';
  if (bytes > limits.autofetchMaxBytes) return 'needsApproval';
  if (spentThisSession + bytes > limits.sessionBudgetBytes) return 'sessionBudget';
  return 'yes';
}
