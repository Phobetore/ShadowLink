# ShadowLink

**Share one folder of your Obsidian vault with other people, live, on a server you run yourself.**

ShadowLink is an Obsidian plugin and a small Node server one of you starts. You
nominate a folder. From then on, two people can type in the same note and watch
each other's cursors, and creating, renaming, moving or deleting a file inside
that folder shows up for everybody. Nothing outside the folder is read, hashed or
sent anywhere.

I built it because the alternatives each wanted something I did not want to give:
the whole vault, an account, a subscription, or trust in a service that gets to
decide later what my notes are worth. This one asks for a folder. No account, no
telemetry, no seat count, no hosted version — GPL-3.0-or-later, self-hosted from
the first minute.

> **Before you install it.** The engine has been under test for months; the plugin
> was first opened inside a real Obsidian this week, and that session found three
> bugs. [Where it is today](#where-it-is-today) names all three, what they can
> still do to you, and what they could not reach. Read it before you decide.

---

## One folder, and the rest is not reachable

The question worth asking before installing a collaboration plugin into a decade of
private notes is what, exactly, the other person can see. One folder — and it stays
one folder because the rest of the vault is not reachable from inside the plugin.

```
my vault/
├── Journal/                    never read, never hashed, never sent
├── Finances/                   never read, never hashed, never sent
├── Half-written/               never read, never hashed, never sent
│
├── Team Notes/            <──  the share. This, and only this, syncs
│   ├── roadmap.md              text: merges while you both type
│   ├── burndown.png            bytes: uploaded once, under their hash
│   ├── Drafts/                 folders too, empty ones included
│   └── .git/                   dot-folders stay local, even in here
│
├── ShadowLink Recovered/       your copy, when a delete could not be proven safe
├── ShadowLink Staging/         a waypoint a rename passes through
└── .obsidian/                  your settings, and this plugin's own state
```

The three folders at the top are not excluded by a filter you could misconfigure.
The engine's picture of your vault is built share-first: the one function that
inventories your files takes the share root and returns nothing else, and the
reconciler, the publisher and the deletion pass are all built on that list. It is
the whole of what they know. Obsidian's own file events are filtered the same way
before any handler runs.

Writes are guarded from the other side. Every vault mutation — create, rename,
trash, rescue — passes one containment check that admits the share and refuses
`..`, backslashes, empty segments and anything outside it. Most of the plugin could
not reach your vault in any case: only the entry point, the settings and dialog
code, and three small adapter files may import Obsidian's API, and a test fails the
build if a fourth tries.

The two `ShadowLink` folders sit at the vault root, outside the share, and both are
visible on purpose. `ShadowLink Recovered/` holds your copy of something somebody
else deleted — inside the share it would be handed straight back to the person who
deleted it. `ShadowLink Staging/` is a waypoint a rename passes through. Hiding
transient state in a dot-folder turns a crash into an orphan nobody can see.

Because the boundary is a folder, moving a file into it is how you share it, with
no second step and no confirmation. Moving one back out unshares it for everybody,
so that one does ask, and the default answer is to put it back where it was.

## What crosses

**Notes.** Every `.md` file in the share is a [Yjs](https://yjs.dev) document. Two
people in the same paragraph is a solved problem there: edits merge, nobody
overwrites anybody, and each cursor carries the name and colour its owner chose.

**Structure.** The folder's shape is a shared document too, so creates, renames,
moves and deletes converge for everybody, empty folders included. What makes that
hold up is that a note is not its path: each one is minted an identifier once,
never changed, its content lives under that identifier, and the path is *derived*
from a parent folder and a name. Two things follow, and they are why the plugin is
built this way rather than the obvious way:

- Renaming or moving a note while somebody is editing it does nothing to their
  session. Same tab, same cursor, same undo history, no reconnection. A design
  keyed on paths has to tear the session down at exactly that moment.
- Two people moving folders into each other cannot make a loop. A path is computed
  from a parent and a name, never from a pointer to another node, so the cycle that
  breaks tree-shaped designs cannot be written down.

**Attachments.** Anything that is not a note — an image, a PDF, a `.canvas` —
skips Yjs entirely. Its bytes go to a content-addressed store on the server: hash
the file, ask the server whether it already holds that hash, upload only if it does
not. Publishing a file the server has seen before uploads nothing, and answering
"is my copy current?" for two thousand attachments costs two thousand `stat`s and
no network. Large ones wait to be asked for rather than arriving while you are not
looking; the ceilings are [below](#what-it-does-not-do).

**And some things never cross at all**, better known now than found later:
dot-files and dot-folders inside the share, files with no extension or an extension
over 16 characters, and executables — `.exe`, `.dll`, `.so`, `.dylib`, `.msi`,
`.bat`, `.cmd`, `.com`, `.scr`, `.ps1`, `.vbs`, `.jar`, `.app`, `.lnk`. A shared
folder is a folder somebody else can write into, and while Obsidian will not run
what lands there, Explorer and Finder will. Those files stay local, silently.

## When somebody deletes something

Nothing in ShadowLink is ever hard-deleted. A delete writes a tombstone into the
shared document, and every peer decides what to do about its own copy.

Your file goes to the vault-local `.trash` — the one Obsidian restores from, on
desktop and on mobile — **only** when ShadowLink can prove the content is
recoverable from the workspace. For a note that means the creator published it,
this device confirmed the hash of what it wrote, and the file on disk still matches
that hash. For an attachment the proof is stronger: the digest rides in the shared
document where every peer can see it, and the server is asked, at that moment,
whether it still holds exactly those bytes.

Anything else is not removed. A file this device never confirmed, one that has
changed since, one too large for this device to hash, one you have open in a tab —
your copy is moved into `ShadowLink Recovered/` and renamed to say what happened:

```
burndown.png (deleted by Ann 2026-08-24).png
```

Ignorance always resolves to keeping your file.

On top of that sits a circuit breaker. If more than ten deletions arrive within ten
minutes, if one batch adds up to more than 100 MB, or if any arrive on the first
pass after Obsidian starts, everything stops and one dialog appears. The byte
condition exists because one 200 MB video is at least as consequential as eleven
notes, and a count alone waves it straight through. The first-pass condition is
unconditional because a week of somebody else's reorganising, arriving while you
were away, is exactly what you cannot undo by hand. The dialog's default action is
to keep your files; so is Escape, and so is closing the window. A file you chose to
keep stays kept.

The same instinct runs the other way. A file that is missing, a document that will
not sync, a folder that cannot be listed, a request that failed — none of those is
evidence of a deletion, and none removes anything. It is why a file deleted outside
Obsidian while Obsidian was closed comes back when you reopen it: resurrection is
reversible and deletion is not. And when something outside Obsidian removes files
in bulk — a `git checkout`, a sync client with opinions — a local batch of more
than 25 asks first, defaulting to decline, after which the next pass puts them back.

## When two of you change the same thing

Notes merge, so the question is only ever about attachments, and an attachment
cannot merge. If two people replace the same one at once, or if ShadowLink cannot
establish whose version came first, the copy that lands last in the shared document
keeps the name and the other is renamed where it stands:

```
burndown (conflicted copy — Ann, a71c4013).png
```

That renamed file is shared with everybody, so both versions exist for everyone and
you can see whose is whose. Nobody's bytes are lost, and nobody gets one merged
file either. This catches people out with `.canvas`, which Obsidian stores as a
single JSON file and ShadowLink therefore treats as an attachment: two people
rearranging one canvas at the same time fork it. When two files end up claiming the
same name, one keeps it and the other gains a ` (2)` suffix — arbitrarily, and
identically for everybody.

There is one moment a note is not merged: when the copy on your disk differs from
the shared document, most often the first time you join. The workspace version wins
on disk, and yours is saved whole into `ShadowLink Recovered/` rather than
concatenated with it. Otherwise, coming back after a week away needs nothing from
you — what changed while you were gone arrives, what you did meanwhile is shared,
and a note somebody renamed is where they left it.

## Why any of this should be believed

Everything above is a claim about code you have not read, made by the person who
wrote it. Here is what stands behind it.

The engine is built against eighteen numbered invariants. The first two set the
tone:

> **I1 — No irreversible destruction, ever.**
> **I2 — Absence of evidence is never a delete.**

They are not aspirations at the top of a design document. Each exists because a
specific failure was found without it, several of them in products that had already
shipped, and the load-bearing ones are enforced rather than intended:

- **The ban on hard deletion is a test that reads the shipped source.** It catches
  the call written through an alias and the one written on the low-level file
  adapter, and it is default-deny: every destructive call in the codebase must name
  a receiver on an allowlist holding nothing but in-memory bookkeeping.
- **The engine runs without Obsidian at all.** Everything touching the vault, the
  network or the Obsidian API goes through a port with an in-memory fake, which is
  what makes the next line possible.
- **879 automated tests** — 123 for the server, 756 for the client — plus **50
  end-to-end scenarios** against the real server process over real WebSockets.
  Twenty of those drive three simulated clients through 200 random operations across
  two network partitions, on a different seed each time, then assert that all three
  hold the same files, with the same bytes, in the same folders. `npm test` and
  `npm run test:e2e:structural` print the counts; do not take mine.
  [![tests](https://img.shields.io/github/actions/workflow/status/Phobetore/ShadowLink/ci.yml?branch=master&label=tests&style=flat-square)](https://github.com/Phobetore/ShadowLink/actions/workflows/ci.yml)
- **The tests are checked by breaking the code on purpose.** A change is probed by
  mutating one line and confirming a test dies. Every slice of this project found at
  least one test that was testing nothing.

That last habit is also how I know what the number above is worth, which is the
next section.

## Where it is today

All of that testing runs headless, deliberately. It also means that until this week
the plugin itself had never been opened inside a real Obsidian.

Then two vaults, two windows, twenty minutes. It found three bugs. The first is
worth writing out in full, because it is the honest answer to "how much do 879
tests actually prove?"

One vault sat quietly displaying an earlier revision of a note both people had
open — 166 characters on screen where the shared document held 184. Every remote
keystroke after that addressed a position that did not exist, and the console
filled with `RangeError: Invalid position 184 in document of length 166`. A note in
that state is not showing you what the share holds.

The cause was one wrong assumption about the editor library. Binding a shared
document into a live editor does not make the editor *show* that document — the
caller is expected to have replaced the text already, and ShadowLink had not. The
headless test double had the same assumption baked into it: it modelled the bind as
"returns true", with no document in it to be wrong about. "Bound a 184-character
document into an editor showing 166 characters" and "bound correctly" were the same
assertion, so 879 tests could not tell them apart. That is the shape of gap worth
watching for in any suite — not a case nobody wrote, but a fake with the bug
already inside it.

The same twenty minutes turned up two more. Obsidian's *New note* is a 0-byte file,
and the publisher announced each one as published the moment it appeared, so every
peer obediently created a 0-byte file of its own — which looks enough like a note
somebody emptied that people delete it, and that deletion is a tombstone that
travels. Separately, each device recorded the *other* device's copy as its watermark
for what it held locally, and that watermark is what the deletion path consults when
choosing between the vault trash and a rescue.

As of this commit: all three are diagnosed to the line and written up, and none of
the three fixes is in the tree yet. The editor bind is being moved out of the
"cannot be tested without a GUI" category, where it never belonged, so the next
version of this bug fails a test instead of a share.

And the part I would want to know if I were installing it. The first bug can leave
you looking at a stale note. The second can put an empty file on your disk. The
third can send a deleted file to the vault trash when it should have gone to
`ShadowLink Recovered/`. What none of the three did, and none could reach, is
destroy a file with nothing left behind: every removal path in the source resolves
to the vault trash or to a rescue, and that is enforced on shipped code rather than
promised. Everything in that session came back.

So: treat it as a beta, keep the backups you would keep anyway, and please
[open an issue](https://github.com/Phobetore/ShadowLink/issues) when something
misbehaves. Three bugs turned up in twenty minutes of one person looking, so there
is a fourth.

## What it does not do

Real limitations of the current release, not hypothetical ones.

**Things that will not cross the boundary**

- **Past a hard ceiling, an attachment is not shared at all.** 100 MB on a desktop,
  **32 MB on a phone** — a screen recording made on that phone is over it
  immediately. No button lifts it: the whole file has to fit in memory to be hashed
  and verified, in both directions. Your server has a second ceiling
  (`MAX_FILE_SIZE_MB`, 100 MB by default) and the lower of the two decides. Nothing
  is destroyed: the file stays where you put it, unshared, and you are told once. If
  it was already shared, only the new bytes are refused. The device figures are
  compiled in; no setting raises them.
- **A file already in the share that is past the ceiling is the quiet version of the
  same thing.** Everybody who has it keeps it, but this device cannot hash it, so it
  cannot tell whether you have changed it — and a change it cannot see is a change
  it does not share. The status bar's tooltip lists those files. Nothing is missing,
  so there is nothing to press: open them on a machine with more memory.
- **Large attachments do not arrive on their own.** Over about 10 MB — 2 MB on a
  phone — an attachment waits to be asked for, and so does anything past a
  per-session download budget of 512 MB, or 20 MB on a phone. The file stays in the
  shared folder for everybody, a **Download** button appears where the embed would
  be, the status bar counts what is waiting and its tooltip gives the total, and the
  *ShadowLink: Download attachments* command lists them with their sizes.
- **New attachments can land outside the shared folder.** Obsidian's *Default
  location for new attachments* is a vault-wide setting whose default is the vault
  root. If yours points outside the share, an image you drag into a shared note is
  saved where nobody else will see it. ShadowLink says so at startup and names the
  exact setting and value to choose, until you fix it or dismiss it, but it cannot
  change it for you.
- **Some files are never shared and nothing says so** — the dot-files, missing or
  overlong extensions, and executables listed above.

**Things that cross imperfectly**

- **Unopened notes go stale.** A note's content is written to disk once, when the
  note first appears. Until somebody opens it, later edits are not written to that
  peer's disk, so Obsidian search, `git` and any external tool can read out-of-date
  bytes. Opening the note is meant to be the cure, and the first bug in
  [Where it is today](#where-it-is-today) is that today it is not. Attachments are
  unaffected: every pass checks whether each one is current, though on a cold share
  that re-hashing is spread over several passes.
- **Two people replacing one attachment produce two files, not one**, as described
  above — including two people editing one `.canvas` at the same time.
- **`ShadowLink Recovered/` is never pruned.** It is an ordinary folder in your
  vault, and yours to manage.
- **One shared folder per vault.**

**Things about the server**

- **One shared key per server.** Anyone holding it can join any workspace on that
  server, read everything in it and write to it. No invitations, no per-member
  permissions, no read-only members, and no way to revoke one person short of
  rotating the key for everybody. Treat it like a shared password.
- **No end-to-end encryption yet.** The server stores and relays notes in plaintext,
  so treat it as trusted, and put a reverse proxy in front of it for `wss://` if it
  is reachable from the open internet. E2E is planned and the storage layer was
  designed to keep it possible. [SECURITY.md](SECURITY.md) has the threat model, and
  it is short.
- **The server keeps attachment bytes nothing references any more.** Deliberately:
  that is what makes undelete work at all. Reclaiming the space is a tool a
  self-hoster runs by hand (`server/tools/sweep-blobs.mjs`), never something the
  server decides on its own, and it takes two runs a grace period apart because the
  first only moves the bytes aside.
- **The shared document grows** as you reorganise. A team churning through a large
  share for a year will notice. Compaction is planned.

## Getting it running

One person runs `npm run server` on a machine everybody can reach — an old laptop,
a Raspberry Pi or a €4 VPS is plenty. Everybody, that person included, copies two
files into `.obsidian/plugins/shadowlink/` and enables the plugin. Then four
settings that everyone types identically: server URL, server key, workspace ID, and
the folder — which is local to you, so your `Shared` can be their `Team/Notes`. The
first time a vault joins, one dialog says in counts and sizes what is about to be
adopted, downloaded, held back and uploaded, before anything is touched.

**[INSTALL.md](INSTALL.md)** is the whole thing, written for somebody who does not
code. Node.js 18 or newer, Windows, macOS or Linux, about twenty minutes.

## For developers

The engine is deliberately testable without Obsidian: everything touching the
vault, the network or the Obsidian API goes through a port with an in-memory fake,
so the whole reconciler runs headless.

```bash
npm test                    # unit and integration tests
npm run test:e2e            # real server, two real Yjs clients
npm run test:e2e:structural # three clients, 200 random ops, partitions, 20 seeds
npm run build               # type-check, then bundle main.js
npm run server              # start the server
```

- **`src/tree/`** — the shared data model. One Yjs document per workspace: a flat
  map of nodes, each holding its parent directory and its name.
- **`src/sync/`** — the engine. `Reconciler` brings the disk to what the tree
  describes, in one idempotent pass that recomputes rather than patches.
  `VaultWatcher` goes the other way, with handlers written as "make the tree match
  reality" so replaying one is free. `Deletions` decides, per file, between the
  vault trash and a rescue.
- **`server/`** — two halves in one process behind one key. `DocHub.js` relays the
  standard Yjs protocol over WebSocket, with the key checked at the upgrade before
  any data flows. `blobStore.js` is the content-addressed attachment store:
  write-once objects, resumable uploads, and a re-hash of what was assembled before
  anything is published. There is no delete route.

Every module under `src/tree/` and `src/sync/` opens with a comment saying what it
is for and which failure the odd-looking parts prevent. Those comments are the
design record.

[CONTRIBUTING.md](CONTRIBUTING.md) covers how to get a change accepted and the
rules that are not negotiable. [SECURITY.md](SECURITY.md) is how to report a
vulnerability privately — a way to make ShadowLink destroy content irrecoverably is
the most serious report you can send. Setup questions belong in
[Discussions](https://github.com/Phobetore/ShadowLink/discussions), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies to all of it.

## What is next

The three bugs above, first. Then continuous content sync, so unopened notes stop
going stale; invitation links with per-member permissions, replacing the single
shared key; then opt-in end-to-end encryption, which is rather the point of having
built it self-hosted and open in the first place.

## Licence

[GPL-3.0-or-later](LICENSE). Run it, change it and share it freely. A modified
version you distribute stays open source under the same licence.

---

Sharing a project should cost you one folder, not your whole vault.
