# Contributing to ShadowLink

Thanks for being here. This covers how to get a change accepted, and what the
project will and will not take.

ShadowLink is maintained by one person, so expect replies in days rather than
hours. Nothing is being ignored on purpose.

## Before you write code

For anything larger than a bug fix, open an issue first and say what you want to
do. Five minutes there can save you a weekend — particularly around the
reconciler, the deletion path or the tree model, where the current shape exists
because specific alternatives were tried and broke, and that is not visible from
the code alone.

Small and obvious fixes need no ceremony. Open the pull request.

## Getting set up

```bash
git clone https://github.com/Phobetore/ShadowLink
cd ShadowLink
npm install
npm test
```

You do **not** need Obsidian to work on most of this. Everything that touches the
vault or the network goes through a port with an in-memory fake, so the sync
engine — the reconciler, the watcher, deletions, publication, bootstrap — runs
headless under `node --test`. That is the point of the port layer; please keep it
that way.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the technical tour. Read the
sections on the data model and the invariants before changing anything under
`src/tree/` or `src/sync/`.

## What has to pass

```bash
npm run build               # type-checks every source AND test file, then bundles
npm test                    # unit and integration
npm run test:e2e            # real server, two real clients
npm run test:e2e:structural # three clients, 200 random ops, partitions, 20 seeds
```

CI runs all four on Linux and Windows. The structural suite takes about a minute;
run it locally before pushing anything that touches sync.

## The rules that are not negotiable

These are enforced, several of them by tests that grep the source. A change that
breaks one will be sent back even if it is otherwise good.

1. **Nothing is ever hard-deleted.** No `vault.delete`, no system trash. Removal
   means the vault-local `.trash` (recoverable inside Obsidian) or a move into
   `ShadowLink Recovered/`. A test enforces this on shipped source, including
   aliased receivers and the low-level data adapter.
2. **Absence of evidence is never a delete.** A missing file, an unreadable
   folder, a failed sync, a stale index — every one of them is a no-op.
3. **Never create a file you do not yet have the content for.** A 0-byte file at
   the correct path looks right, so people delete it. Fetch first, write once.
4. **Never advance a watermark before the write is confirmed.** Marking a note as
   published before the round trip is acknowledged loses its content permanently,
   because nothing will ever offer it again.
5. **Handlers are idempotent, not muted.** "Make the tree match reality", never
   "apply this delta". Tickets and transaction origins are optimisations;
   idempotence is the correctness mechanism.
6. **Only `main.ts`, `src/ui/**` and `src/sync/Obsidian*Port.ts` may import
   `obsidian`.** Everything else stays headless and testable.

If you think one of these is wrong, that is a conversation worth having — open an
issue and argue it. Just do not route around it quietly.

## Tests

New behaviour needs a test. Beyond that, three habits are expected here because
each one has caught real bugs in this codebase:

**Write the failing test first.** Then make it pass. Several defects in this
project were found because the test was written before the implementation
existed to accommodate it.

**Check that your test actually bites.** Break the code you just wrote on purpose
and confirm the suite fails. Every slice of this project found at least one test
that tested nothing this way, including one guarding an invariant that would
otherwise have shipped unenforced.

**Prefer a property over an example** when the thing you are testing is
order-dependent. "The same operations in 50 different orders converge to the same
disk" found a bug that would have wedged the plugin permanently, on one seed out
of fifty.

Do not weaken an existing test to make a change pass. If a test genuinely encodes
the wrong expectation, say so in the pull request and explain why — that is a
legitimate change, and a silent one is not.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `build:`, `refactor:`).
Write the subject so it says what changed for a user or a maintainer, not which
file you touched.

**Do not add AI-attribution trailers** (`Co-Authored-By: …`, "Generated with …")
of any kind. This applies whatever tooling you used — that is a project
preference, not a judgement about the tooling.

## What this project declines

- **Telemetry, analytics, crash reporting, or any outbound call the user did not
  ask for.** Not opt-in, not anonymised, not "just to count installs".
- **A hosted service, or anything that depends on one.** Self-hosting is not a
  fallback here; it is the design.
- **Syncing outside the shared folder.** The one-folder boundary is the promise
  the project is built on.
- **A faster reconciler bought with incremental patch application.** Full
  recomputation is the deliberate choice; if you can make it faster while
  remaining a pure function of state, that is very welcome.

## Security

Do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md)
explains how to report it privately.
