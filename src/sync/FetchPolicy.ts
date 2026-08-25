// src/sync/FetchPolicy.ts
// Which attachments this device downloads, and which it does not (spec §7.2) —
// and, at the bottom, which it will offer to the store (§3.2).
//
// The two live together so the ASYMMETRY between them is visible as two type
// signatures rather than as prose: the server's acceptance ceiling is a parameter
// of the publish side and is structurally absent from `FetchLimits`, because
// acceptance governs writing and memory governs both directions.
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

/**
 * Which ceiling refused a publish, and what that ceiling was.
 *
 * The two arms have different remedies (§7.5) — "shrink it" against "ask whoever
 * runs the server to raise `MAX_FILE_SIZE_MB`" — so the caller is told which one
 * bound the bytes rather than re-deriving it from a comparison it already made.
 */
export type PublishRefusal = { refused: 'device' | 'server'; cap: number };

/**
 * Spec §3.2's two sequential size checks before a publish, on settled bytes.
 *
 * THE ASYMMETRY WITH `fetchVerdict` IS THE POINT, and it is stated here as two
 * adjacent signatures rather than as a comment somebody has to remember: the
 * server's per-file ceiling is a PARAMETER of this function and is structurally
 * absent from `FetchLimits`. Acceptance is a POLICY about writing — the operator
 * edits `MAX_FILE_SIZE_MB` and restarts, and every client learns the new number
 * lazily, once, and only if it publishes an attachment — so it may gate exactly
 * one decision, whether to offer bytes to the store. The memory cap is a FACT
 * about the device: pure, synchronous, knowable offline, constant for the life of
 * the process, and it gates every whole-file allocation in BOTH directions.
 * `min()` of the two types the policy as the fact, and the fact is what decides
 * whether a downloaded attachment can be bound, proven, resurrected or kept.
 *
 * The DEVICE arm is tested first, so a phone never needs the network to learn it
 * cannot hold a file — and so the caller never has to await a `/limits` round
 * trip to reach that answer.
 *
 * `serverCap === null` skips the server arm entirely. An unknown ceiling is never
 * a small one (I2): treating "I could not ask" as "no" would tombstone a
 * publishable file because the network blinked, which is the one place I2 is not
 * recoverable by a later pass.
 *
 * Every comparison is `>`, exactly as in `fetchVerdict`: the ceilings are "this
 * much is fine", not "strictly less than this".
 */
export function publishVerdict(
  bytes: number,
  deviceCap: number,
  serverCap: number | null,
): 'ok' | PublishRefusal {
  if (bytes > deviceCap) return { refused: 'device', cap: deviceCap };
  if (serverCap !== null && bytes > serverCap) return { refused: 'server', cap: serverCap };
  return 'ok';
}
