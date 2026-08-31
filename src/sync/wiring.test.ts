// src/sync/wiring.test.ts
// The handful of things `main.ts` must get right that a type cannot express.
//
// This file used to be three times as long, because every platform number the
// engine reads was an OPTIONAL constructor argument standing in front of a
// `?? DESKTOP_CONSTANT` fallback. Forgetting one was then invisible in exactly
// the way that matters: production quietly took the desktop value, every test
// stayed green, and a phone got a 100 MB memory cap it cannot honour. The only
// guard available was to read `main.ts` as text and check the argument was
// spelled somewhere inside each `new X({ … })`.
//
// `memoryCapBytes`, `rehashBudgetBytes`, `autofetchMaxBytes` and
// `sessionBudgetBytes` are now REQUIRED on every deps interface that declares
// them, with no fallback behind them, so omitting one is a compile error. Every
// assertion that only checked an argument was PRESENT is therefore gone, and so
// are two others:
//
//  * `Deletions` being handed `blobs`. Its headline claim — that a deletion pass
//    without the store rescues every attachment for ever — was simply untrue:
//    `isProvenBlob` reads `ctx.blobs ?? deps.blobs`, `DeletionContext.blobs` is
//    required, and the reconciler fills it from its own required `blobs`. The
//    compiler already guaranteed it. `PublishQueue` and `Reconciler` declare
//    `blobs` required outright.
//  * the ban on handing a collaborator a server ceiling under a name like
//    `maxFileBytes`. None of these deps interfaces declares such a property, and
//    an unknown property on a fresh object literal is an excess-property error —
//    which TypeScript still reports when the literal also contains a spread.
//
// What survives is the part types cannot reach, and it is all about VALUES,
// CALLS and REGISTRATIONS rather than about arguments existing:
//
//  * `memoryCapBytes: () => (await blobs.limits()).maxFileBytes` type-checks
//    perfectly and is the §7.4 bug wearing a new hat — the memory cap is a fact
//    about the DEVICE and must not move when the network does.
//  * a platform helper that stopped branching on `Platform.isMobile` hands a
//    phone the desktop ceiling, and is still a `() => number`.
//  * a command that is never registered is a feature nobody can find.
//  * an ORDER inside one method: approve, persist, then run a pass.
//  * a method that must be REACHED from `start()`; defining it is not calling it.
//
// All of those read `main.ts` as text, so the reader is the first thing in this
// file and the most carefully tested thing in it. The one it replaces counted
// braces with no idea what a string was, and a stray `}` in a string ended a
// block early while a stray `{` ran it PAST its own end into the next block —
// where, since every constructor passes the same argument names, a deleted
// argument would still have asserted green. A guard that fails closed is noisy.
// A guard that fails open is worse than no guard at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Line endings normalized on the way in: this repository is CRLF, and an anchor
// written with `\n` that silently matches nothing would be a guard that passes
// because it never looked.
const MAIN = readFileSync(fileURLToPath(new URL('../../main.ts', import.meta.url)), 'utf8')
  .replace(/\r\n/g, '\n');

// ============================================================ the reader

interface Views {
  /**
   * Comments blanked, string and template CONTENTS intact.
   *
   * Searched by every assertion that looks for a literal, so a sentence in a
   * comment can never be what satisfies it — the prose in this file mentions
   * most of the identifiers it guards.
   */
  code: string;
  /**
   * Comments blanked AND the contents of strings, template text and regexes
   * blanked with them, so brace balancing sees nothing but code.
   *
   * A template SUBSTITUTION is code and stays code, braces and all.
   */
  skeleton: string;
}

/**
 * Characters after which a `/` opens a regex rather than divides.
 *
 * Deliberately conservative: reading a division as a regex blanks code and ends
 * in an unbalanced-braces throw, which is loud. Reading a regex as a division
 * leaves its braces counted, which is the failure this reader exists to remove.
 */
const BEFORE_REGEX = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '<', '>',
]);

/**
 * `src` twice over, each the same length as the original so an index into one is
 * an index into the other.
 *
 * Blanking rather than deleting is the whole trick: a slice taken at a skeleton
 * offset can be read back out of the real source, comments and strings and all.
 */
function readable(src: string): Views {
  const code = [...src];
  const skeleton = [...src];
  const blank = (target: string[], at: number): void => {
    const ch = src[at];
    if (ch !== '\n' && ch !== '\r') target[at] = ' ';
  };
  const blankBoth = (at: number): void => { blank(code, at); blank(skeleton, at); };

  // 'brace' is an ordinary block; 'subst' is a `${` inside a template, and
  // popping one is what returns the scanner to template text.
  const opened: Array<'brace' | 'subst'> = [];
  let mode: 'code' | 'template' = 'code';
  let previous = '';
  let i = 0;

  while (i < src.length) {
    if (mode === 'template') {
      if (src[i] === '\\') { blank(skeleton, i); blank(skeleton, i + 1); i += 2; continue; }
      if (src[i] === '`') { i += 1; mode = 'code'; previous = '`'; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        opened.push('subst');
        i += 2;
        mode = 'code';
        previous = '{';
        continue;
      }
      blank(skeleton, i);
      i += 1;
      continue;
    }

    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { blankBoth(i); i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      blankBoth(i); blankBoth(i + 1); i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { blankBoth(i); i += 1; }
      blankBoth(i); blankBoth(i + 1); i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i += 1;                                       // the quotes themselves stay
      while (i < src.length && src[i] !== ch) {
        const escape = src[i] === '\\';
        blank(skeleton, i); i += 1;
        if (escape && i < src.length) { blank(skeleton, i); i += 1; }
      }
      i += 1;
      previous = 'x';
      continue;
    }
    if (ch === '`') { mode = 'template'; i += 1; continue; }
    if (ch === '/' && BEFORE_REGEX.has(previous)) {
      i += 1;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { blank(skeleton, i); blank(skeleton, i + 1); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        blank(skeleton, i); i += 1;
      }
      i += 1;
      previous = 'x';
      continue;
    }
    if (ch === '{') { opened.push('brace'); previous = '{'; i += 1; continue; }
    if (ch === '}') {
      i += 1;
      previous = '}';
      if (opened.pop() === 'subst') mode = 'template';
      continue;
    }
    if (!/\s/.test(ch)) previous = ch;
    i += 1;
  }

  return { code: code.join(''), skeleton: skeleton.join('') };
}

/**
 * The block `anchor` opens — from the anchor to the `}` that closes its first
 * `{` — with the source's own strings and comments still in it.
 *
 * The anchor is required to be UNIQUE, because `indexOf` silently preferring the
 * first of two matches is how a guard ends up asserting about the wrong method:
 * `downloadAttachments` is declared twice in `main.ts`, once on the runtime and
 * once on the plugin that forwards to it.
 */
function blockOf(src: string, anchor: string, missing: string): string {
  const { code, skeleton } = readable(src);
  const start = code.indexOf(anchor);
  assert.notEqual(start, -1, missing);
  assert.equal(code.indexOf(anchor, start + 1), -1, `"${anchor.trim()}" is not unique in main.ts`);
  // THE FAIL-OPEN SHAPE, REFUSED RATHER THAN TRUSTED. A `{` inside the anchor —
  // an object-literal return type, a destructured parameter — means the first
  // brace after `start` belongs to that and its match ends the "block" before
  // the body has begun, so every assertion about the body passes by looking at
  // nothing. `bodyOf` is the reader for those. Fixing the one anchor somebody
  // noticed left the SHAPE accepted, and a guard that fails open is worse than
  // no guard at all.
  const inner = anchor.indexOf('{');
  assert.ok(
    inner === -1 || inner === anchor.length - 1,
    `"${anchor.trim()}" carries a brace before its end — use bodyOf, not blockOf`,
  );

  let depth = 0;
  for (let i = skeleton.indexOf('{', start); i < skeleton.length; i += 1) {
    if (skeleton[i] === '{') depth += 1;
    else if (skeleton[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after "${anchor.trim()}"`);
}

const CODE = readable(MAIN).code;

/** A block in `main.ts`. */
function block(anchor: string, missing: string): string {
  return blockOf(MAIN, anchor, missing);
}

/** `blockOf` over a fixture, with the message this file would use. */
function fixtureBlock(src: string, anchor: string): string {
  return blockOf(src, anchor, `no such block: ${anchor}`);
}

/**
 * The block whose opening brace is the LAST character of `anchor`.
 *
 * `blockOf` starts at the first `{` after the anchor, which is right whenever
 * that brace opens the body — and wrong for a signature whose RETURN TYPE is an
 * object literal, because there the first brace belongs to the type and its
 * match ends the "block" before the method has begun. A guard reading an empty
 * body would then assert green about a method it never looked at, which is
 * exactly the failure this file's reader exists to rule out.
 */
function bodyOf(src: string, anchor: string, missing: string): string {
  const { code, skeleton } = readable(src);
  const start = code.indexOf(anchor);
  assert.notEqual(start, -1, missing);
  assert.equal(code.indexOf(anchor, start + 1), -1, `"${anchor.trim()}" is not unique in main.ts`);
  assert.equal(anchor[anchor.length - 1], '{', 'the anchor must END at the body\'s brace');

  let depth = 0;
  for (let i = start + anchor.length - 1; i < skeleton.length; i += 1) {
    if (skeleton[i] === '{') depth += 1;
    else if (skeleton[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after "${anchor.trim()}"`);
}

/** A method body in `main.ts`, for a signature carrying braces of its own. */
function body(anchor: string, missing: string): string {
  return bodyOf(MAIN, anchor, missing);
}

// ============================================================ the reader's own tests

// Every assertion below rests on this, so it is checked against a source built
// to break the previous reader in both directions at once.
const FIXTURE = `
function withBraces() {
  const closing = '}';                    // a brace that ended the block early
  const opening = "{";                    /* and one that ran it past the end */
  const template = \`\${ { nested: 1 } } and a bare } in template text\`;
  const pattern = /^[{}]+$/;
  return closing + opening + template + String(pattern);
}

function next() {
  return 'the block above must stop before this';
}
`;

test('the source reader is not fooled by a brace in a string, a comment or a regex', () => {
  const found = fixtureBlock(FIXTURE, 'function withBraces() {');

  assert.ok(
    found.includes('return closing'),
    'a `}` inside a string ended the block early — the old reader stopped here',
  );
  assert.equal(
    found.includes('function next'), false,
    'a `{` inside a string ran the block past its own end and spliced in the next one',
  );
  assert.ok(found.endsWith('}'));
  assert.ok(found.includes('/^[{}]+$/'), 'the source is returned intact, not the skeleton');
});

test('a signature whose return type carries braces is read to the end of its BODY', () => {
  // `blockOf` starts at the first `{` after the anchor. For `status(): { text:
  // string; tooltip: string } {` that brace is the TYPE's, and its match ends
  // the "block" before the method has begun — so every assertion about the body
  // would pass by looking at nothing at all. That is the fail-open shape this
  // whole reader exists to rule out.
  const src = '\nfunction shaped(): { a: string; b: string } {\n  return { a: BODY, b: \'x\' };\n}\n';
  const anchor = '\nfunction shaped(): { a: string; b: string } {';

  // And the SHAPE is refused, not merely handled where somebody remembered to.
  // Fixing the one anchor that had it left every future one free to reintroduce
  // it silently, which is the same fail-open one layer up.
  assert.throws(
    () => fixtureBlock(src, anchor),
    /use bodyOf, not blockOf/,
    'blockOf would stop at the return type, so it refuses the anchor instead',
  );
  assert.ok(
    bodyOf(src, anchor, 'no such block').includes('BODY'),
    'bodyOf starts at the anchor\'s own final brace and reads the body',
  );
  assert.throws(
    () => bodyOf(src, '\nfunction shaped(): ', 'no such block'),
    /must END at the body/,
    'an anchor that does not end at a brace is a guard about to read the wrong span',
  );
});

test('the source reader refuses an anchor it cannot find, or one that is not unique', () => {
  assert.throws(
    () => fixtureBlock(FIXTURE, 'function absent() {'),
    /no such block/,
    'a renamed function must fail the guard, not skip it',
  );
  assert.throws(
    () => fixtureBlock(`${FIXTURE}\nfunction next() {\n  return 2;\n}\n`, 'function next() {'),
    /is not unique/,
    'two matches means the guard is about to assert on whichever came first',
  );
});

test('a comment can never be what satisfies a search', () => {
  const { code } = readable("// id: 'download-all-attachments'\nconst real = 'kept';\n");
  assert.equal(code.includes('download-all-attachments'), false, 'comment text is blanked');
  assert.ok(code.includes('kept'), 'but string contents are not');
});

// ============================================================ §7.4 / §7.2: the values

// The four numbers are required arguments now, so this is no longer about
// whether they are passed. It is about WHAT is passed: `main.ts` is the only file
// that holds both the platform test and the ports, so it is the only place the
// device's memory cap and the SERVER's per-file ceiling could be joined. Four of
// the five collaborators must never see a server limit at all — a reconciler, a
// deletion pass, a watcher or a bootstrap classifier that knew `MAX_FILE_SIZE_MB`
// would refuse to hash, bind, prove, resurrect or download bytes the store serves
// happily, since `GET /blob/<ws>/<sha>` enforces no size limit and only the PATCH
// ingress does. `PublishQueue` is the exception on purpose, and it reaches the
// server ceiling through `blobs.limits()` rather than through this argument.
const PLATFORM_ARGUMENTS: ReadonlyArray<readonly [string, string]> = [
  ['memoryCapBytes', 'blobMemoryCap'],
  ['rehashBudgetBytes', 'blobRehashBudget'],
  ['autofetchMaxBytes', 'blobAutofetchMax'],
  ['sessionBudgetBytes', 'blobSessionBudget'],
];

test('every platform number main.ts passes is the platform helper itself (§7.4)', () => {
  for (const [key, helper] of PLATFORM_ARGUMENTS) {
    const passed = [...CODE.matchAll(new RegExp(`(?:^|[\\s,{])${key}\\s*:([^\\n]*)`, 'gm'))];
    assert.ok(passed.length > 0, `main.ts no longer passes ${key} to anything`);
    for (const use of passed) {
      assert.equal(
        use[1].trim().replace(/,$/, ''), `() => ${helper}()`,
        `${key} must be the platform helper and nothing else. A value derived from the `
        + 'server\'s ceiling type-checks perfectly and is the §7.4 bug in a new place: the '
        + 'memory cap is a property of the device and must not move when the network does.',
      );
    }
  }
});

// §7.4, the other half. The helpers are where the platform test lives, and one
// that stopped branching is still a `() => number` — so the compiler is content
// and a phone gets the desktop ceiling.
test('every platform number is chosen by a mobile test, in main.ts (§7.4)', () => {
  for (const [, helper] of PLATFORM_ARGUMENTS) {
    assert.ok(
      block(`function ${helper}(): number {`, `main.ts no longer defines ${helper}`)
        .includes('Platform.isMobile'),
      `${helper} must choose on Platform.isMobile — a phone silently given the desktop `
      + 'number is the failure §7.4 exists to prevent.',
    );
  }
});

// §7.5. The one argument in this family the compiler still cannot reach:
// `sessionSpentBytes` is optional and defaults to zero, which is RIGHT on a first
// join and wrong the moment the classifier is asked a second time in one session.
// Its value is the other module's own tally or the two disagree about a pass that
// has already spent part of the budget.
test("the first-sync classifier reads the reconciler's own spend (§7.5)", () => {
  assert.ok(
    CODE.includes('sessionSpentBytes: () => this.reconciler.fetchedThisSession'),
    'Bootstrap must be given the reconciler\'s session spend; a default of zero makes the '
    + 'modal describe a pass with the whole budget still to play with.',
  );
});

// ============================================================ §7.3: reachability

// Three commands and a markdown post-processor, all of them reachable only
// through Obsidian's own registries. A command that is never registered is a
// feature nobody can find, and the whole point of the deferral policy is that the
// user has a way to say "yes, fetch that one".
test('the three download commands and the embed post-processor are registered (§7.3)', () => {
  for (const id of [
    'download-attachments-in-note', 'download-all-attachments', 'download-attachments',
  ]) {
    assert.ok(
      CODE.includes(`id: '${id}'`),
      `main.ts must register the "${id}" command; a deferral the user cannot lift is a `
      + 'file they simply do not have.',
    );
  }
  assert.ok(
    /registerMarkdownPostProcessor\(\s*deferredEmbedProcessor\(/.test(CODE),
    'main.ts must register the deferred-embed post-processor',
  );
});

// ============================================================ §4: the lever

// The compatibility connection is the ONE remedy for a route that accepts the
// multiplexed upgrade and carries nothing on it — a state the client can measure
// and must not diagnose. A lever nobody can find is the same as no lever, and the
// status bar's own sentence sends the user looking for it, so both doors have to
// exist and both have to be reachable with no runtime at all.
test('the compatibility connection has a command as well as a setting (§4)', () => {
  assert.ok(
    CODE.includes("id: 'toggle-compatibility-connection'"),
    'main.ts must register the compatibility command; the status bar tells a user to '
    + 'reach for this at the moment their vault has stopped syncing',
  );
  const onload = block('\n  async onload(): Promise<void> {', 'main.ts no longer defines onload');
  assert.ok(
    onload.includes("id: 'toggle-compatibility-connection'"),
    'it must be registered in onload, beside the download commands — a command that '
    + 'only exists once a share is configured is missing exactly when it is wanted',
  );
});

// ⚠ THE MUX IS NOT DIALLED AT ALL when the user has said their deployment does
// not carry it. Constructing the bridge and letting it measure would put the
// client back in the business of second-guessing a decision the person who owns
// the deployment has already made.
test('the compatibility setting picks the transport, ahead of any measurement (§4)', () => {
  const ctor = block(
    '\n  constructor(private readonly plugin: ShadowLinkPlugin, deviceId: string) {',
    'main.ts no longer defines the runtime constructor',
  );
  const choice = ctor.indexOf('this.compatibilityChosen =');
  assert.ok(choice >= 0, 'main.ts no longer records which connection it is about to build');
  const decision = ctor.slice(choice, choice + 400);
  assert.ok(
    decision.includes('useCompatibilityConnection'),
    'the transport must be chosen from the persisted setting',
  );
  assert.ok(
    decision.includes('if (this.compatibilityChosen) {'),
    'and it must branch on the value it recorded, so the bar and the transport can '
    + 'never disagree about which connection was built',
  );
  assert.ok(
    decision.includes('this.routeWitness = null'),
    'and the compatibility branch has no bridge, so it must say so rather than leave '
    + 'the bar reading a probe that does not exist',
  );
  assert.ok(
    decision.includes('new LegacyTreeTransport('),
    'and the compatibility branch must be the legacy transport itself, not the bridge '
    + 'measuring its way back to it',
  );
});

// ⚠ THE STATE THE LEVER ANSWERS IS COMPUTED FROM CURRENT FACTS, NEVER READ BACK
// FROM A RECORD. `this.mux.routeUnserved` used to be asked here — a conclusion the
// bridge had written onto the link earlier, which five rounds tried and failed to
// give a complete set of retractions, because every one of them needed the link to
// still be talking and a path that goes dark says nothing. Measured on the previous
// branch: earned at 45,170 ms, path black-holed and RST at 45,188 ms, still on the
// bar at 105,236 ms with `dialsRefused` 0.
test('the status bar computes the route\'s sentence from live facts (§4)', () => {
  const status = body(
    '\n  status(): { text: string; tooltip: string } {',
    'main.ts no longer defines status()',
  );
  assert.equal(
    status.includes('routeUnserved'), false,
    'the bar must not read a conclusion the link holds; there is no such conclusion, '
    + 'and every version of one has outlived its evidence',
  );
  assert.ok(
    status.includes('serverAnswersElsewhere: this.routeWitness?.serverAnswersElsewhere'),
    'it must ask the bridge\'s probe whether the server is answering RIGHT NOW — a '
    + 'live read is the only thing that cannot go stale',
  );
  for (const fact of ['this.mux.stats.framesIn', 'this.mux.stats.framesOut',
    'this.mux.unsupportedReason !== null']) {
    assert.ok(
      status.includes(fact),
      `and it must pass the current ${fact} rather than anything derived from it`,
    );
  }
  assert.ok(
    status.includes('useCompatibilityConnection'),
    'and it must say when the compatibility connection is in force — a lever whose '
    + 'effect is invisible is one the user forgets they pulled',
  );
});

// ⚠ AND WHAT IT SAYS ABOUT THE LEVER MUST BE ABOUT THE TRANSPORT, NOT THE SETTING.
// The transport is chosen once, in the runtime constructor, so the setting is an
// intention from the moment it is touched until the plugin reloads — which is
// exactly the window in which somebody throws it. Measured against a real deaf
// proxy: thrown ON at 40,146 ms with no reload, the tooltip told the user both to
// turn the setting on and that it was already in force while `MuxLink` was still
// the transport; turned OFF at 20,138 ms, the only sentence disclosing that
// unopened notes were going stale vanished while the mux had opened zero sockets.
test('the bar is told which connection was BUILT, not only which one is set (§4)', () => {
  const status = body(
    '\n  status(): { text: string; tooltip: string } {',
    'main.ts no longer defines status()',
  );
  const at = status.indexOf('compatibility:');
  assert.ok(at >= 0, 'main.ts no longer tells the bar anything about the compatibility state');
  const passed = status.slice(at, at + 260);
  assert.ok(
    passed.includes('this.compatibilityChosen'),
    'the bar must be told what the runtime actually constructed; the setting alone is an '
    + 'intention for the whole of the window in which the lever is thrown',
  );
  assert.ok(
    passed.includes('this.compatibilityFellBack'),
    'and whether the plugin fell back on its own — that session pays the identical cost '
    + 'and used to get a fifteen-second Notice and no persistent marker at all',
  );
  // And the fallback has to actually record it, or the field is a decoration.
  const ctor = block(
    '\n  constructor(private readonly plugin: ShadowLinkPlugin, deviceId: string) {',
    'main.ts no longer defines the runtime constructor',
  );
  assert.ok(
    ctor.includes('this.compatibilityFellBack = true;'),
    'nothing sets the fallback flag, so an automatic demotion is never disclosed',
  );
});

// §7.3. Every one of those four paths must go through the SAME mechanism —
// approve, persist, then run a pass — because the pass owns every rule about what
// may be written where. A command that fetched bytes itself would be a second
// writer with none of them.
test('downloading an attachment approves it, persists that, and then runs a pass (§7.3)', () => {
  const body = block(
    '\n  async downloadAttachments(ids: readonly string[]): Promise<void> {',
    'main.ts no longer defines the runtime\'s downloadAttachments',
  );

  const approve = body.indexOf('fetchApproved[id] = true');
  const persist = body.indexOf('state.flush()');
  const pass = body.indexOf('reconcile(');
  assert.ok(approve !== -1, 'the approval is what lifts the policy (§7.2)');
  assert.ok(
    persist > approve,
    'the approval is persisted BEFORE the pass: a fetch that fails must not make the '
    + 'user press the button again',
  );
  assert.ok(pass > persist, 'and only then is a pass asked for');
  assert.equal(
    /blobs\.get\(/.test(body), false,
    'a command must never fetch bytes itself — the pass owns every rule about writing them',
  );
});

// §7.5. The check is one line and the string is one paragraph, and without both
// this feature does not work on a default Obsidian install: the vault-global
// "Default location for new attachments" points at the vault root, so the first
// image dragged into a shared note lands outside the share and every peer sees a
// broken embed. Nothing in the sync engine can fix that — the file genuinely is
// not in the shared folder — so being told is the entire remedy.
test('the attachment-folder warning is actually reachable on start (§7.5)', () => {
  assert.ok(
    block('\n  async start(): Promise<void> {', 'main.ts no longer defines start()')
      .includes('this.warnIfAttachmentsLandOutside()'),
    'the check must be CALLED from start(); defining it is not reaching it',
  );

  const warn = block(
    '\n  private async warnIfAttachmentsLandOutside(): Promise<void> {',
    'main.ts no longer defines warnIfAttachmentsLandOutside',
  );
  assert.ok(warn.includes('attachmentsLandInsideShare('), 'it must run the location check');
  assert.ok(warn.includes('warnAttachmentFolder('), 'and show the warning when that fails');
  // Dismissible, and the dismissal has to survive a restart — otherwise it is not
  // a dismissal, it is a delay.
  assert.ok(
    warn.includes('attachmentFolderWarningDismissed = true') && warn.includes('saveSettings()'),
    'dismissing must be persisted',
  );
});

// §6.2. THE ONLY PERIODIC DRAIN IN THE PLUGIN, and it has to ask two questions.
//
// `VaultWatcher.onModify` returns early for a note by design (I7), so nothing
// but this interval ever re-offers one. `pendingCount()` deliberately EXCLUDES
// the entries the queue parked — an empty note, a `.md` file that is not text —
// because no upload is owed for them and no waiting changes that; the last round
// narrowed that number without widening this interval, and an empty note that
// can never publish again is not a status-bar bug.
//
// Both halves are pinned here because this is a two-line method somebody will
// try to simplify back into one.
test('the retry interval asks about parked entries as well as pending ones (§6.2)', () => {
  const timer = block(
    '\n    this.retryTimer = setInterval(',
    'main.ts no longer installs the publish retry interval',
  );
  assert.ok(timer.includes('drainTick()'), 'the interval must reach the drain tick');

  const tick = block(
    '\n  private async drainTick(): Promise<void> {',
    'main.ts no longer defines drainTick',
  );
  assert.ok(
    tick.includes('queue.pendingCount()'),
    'the tick must still ask whether an upload is owed',
  );
  assert.ok(
    tick.includes('queue.repark()'),
    'and it MUST ask whether a parked entry\'s file has moved — nothing else ever will',
  );
  assert.equal(
    (tick.match(/scheduleReconcile\(/g) ?? []).length, 2,
    'each question that answers yes asks for a pass',
  );
});

test('the status bar reads the count that excludes parked entries (§6.2)', () => {
  // `body`, not `block`: this signature's return type is an object literal, so
  // the first brace after the anchor is the TYPE's and its match would end the
  // block before the method started.
  const status = body(
    '\n  status(): { text: string; tooltip: string } {',
    'main.ts no longer defines status()',
  );
  assert.ok(
    status.includes('this.queue.pendingCount()'),
    '"N file(s) waiting to upload" is the count of work, not of entries',
  );
  assert.ok(
    status.includes('this.queue.parked()'),
    'and a parked entry still reaches the tooltip: a bare "synced" beside a note that '
    + 'is not being shared is false in the direction that stops the user looking',
  );
  // THE WORDING IS NOT HERE ANY MORE, and this half is what makes the assertions
  // above worth having. A text-reading guard can check that a method mentions a
  // call; it cannot check a sentence, and these sentences — the plural forms,
  // the branch between the two parked reasons — went unverified for as long as
  // they lived in a file that imports `obsidian`. They are in
  // `src/ui/format.ts` now, and `src/ui/format.test.ts` reads them for real.
  assert.ok(
    status.includes('statusLine({'),
    'main.ts must state the bar rather than compose it',
  );
  assert.equal(
    /['`][^'`]*file\(s\) waiting to upload/.test(status), false,
    'a string built here is a string no test can hold',
  );
  assert.equal(
    MAIN.includes('function parkedLine('), false,
    'the parked sentences moved to format.ts, where the suite can read them',
  );
});

// §6.2's other handoff. `publishOne` defers on a node the session holds open,
// and both ends of that deferral have to be told when it lifts: the session
// publishes a note it holds (so the entry must be closed), and a note that
// CLOSES stops being deferred (so a pass is owed now rather than up to 30
// seconds from now).
test('both ends of the I7 publish deferral are wired to the session (§6.2)', () => {
  const session = block(
    '\n    this.session = new WorkspaceSession({',
    'main.ts no longer constructs the WorkspaceSession',
  );
  assert.ok(
    /markPublished:[^,]*queue\.markPublished\(/.test(session),
    'the session is the one writer of `s` that is not the queue, so it must tell the queue',
  );
  assert.ok(
    /scheduleReconcile:[^,]*scheduleReconcile\(/.test(session),
    'and closing a note must ask for the pass that publishes it',
  );
});
