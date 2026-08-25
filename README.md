<div align="center">

# ShadowLink

### Write in the same Obsidian folder, at the same time.

**Your vault stays yours. You share the one folder you meant to share.**

[**Get started**](INSTALL.md) &nbsp;·&nbsp; [How it works](#how-it-works) &nbsp;·&nbsp; [What it does not do](#what-it-does-not-do-yet) &nbsp;·&nbsp; [Licence](LICENSE)

<a href="https://github.com/Phobetore/ShadowLink/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Phobetore/ShadowLink/ci.yml?branch=master&label=tests&style=flat-square&labelColor=1f1a29" alt="Tests"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/licence-GPL--3.0-2496ed?style=flat-square&labelColor=1f1a29" alt="Licence GPL-3.0"></a>
<img src="https://img.shields.io/badge/self--hosted-no%20account-2496ed?style=flat-square&labelColor=1f1a29" alt="Self-hosted, no account">

</div>

<br>

ShadowLink is an Obsidian plugin and a small server you run yourself. Point a few
people at it, agree on one folder, and that folder becomes shared: two of you can
type in the same note and watch each other's cursors, and creating, renaming,
moving or deleting a file shows up for everyone.

Everything outside that folder never leaves your machine. There is no account to
make, nobody in the middle, and no copy of your notes on any server but the one
you started yourself.

I built it because the alternatives each wanted something I did not want to give:
the whole vault, an account, a subscription, or trust in a service that could
decide later what my notes are worth. This one asks for a folder.

<br>

> **Status: early.** The sync engine is finished and heavily tested — over 850
> automated tests, including three simulated clients performing 200 random
> operations across network partitions; `npm test` and
> `npm run test:e2e:structural` print the exact counts. What has *not* had heavy
> real-world use is the plugin inside Obsidian itself. Treat this as a beta, keep
> backups, and please
> [open an issue](https://github.com/Phobetore/ShadowLink/issues) when something
> misbehaves.

<br>

---

<br>

## What makes it different

<table>
<tr>
<td width="33%" valign="top">

### One folder, not your vault

You nominate a folder. That is the share. Your journal, your finances and the
half-written things you have no intention of showing anybody stay exactly where
they are — unsynced, unread, untouched. Sharing a project should not mean handing
over a decade of private notes.

</td>
<td width="33%" valign="top">

### It refuses to lose your work

A collaborator's delete does not delete your copy. Unless ShadowLink can *prove*
the content is safe in the shared document, your file is moved aside into
`ShadowLink Recovered/` instead. Bulk deletions stop and ask, and the default
answer is always to keep your files.

</td>
<td width="33%" valign="top">

### Nobody's server but yours

One `node server/index.js`, on a machine you control. No account, no telemetry,
no plan, no seat count. GPL and self-hosted from the first minute — the hosted
version does not exist and is not the plan.

</td>
</tr>
</table>

<br>

---

<br>

## How it works

**Text.** Every note in the share is a [Yjs](https://yjs.dev) CRDT document. Two
people typing in the same paragraph is a solved problem: edits merge, nobody
overwrites anybody, and you watch the other cursor move.

**Structure.** The folder's shape is itself a shared document. Create a note,
rename a folder, drag something into a subfolder, and everyone converges on the
same layout — empty folders included.

The interesting part is what a note *is*. Each one carries an identifier minted
once and never changed, and its content lives under that identifier rather than
under its path. Two things follow, and they are why the plugin is built this way:

- **Renaming or moving a note while somebody is editing it does nothing to their
  session.** Same tab, same cursor, same undo history, no reconnection. A design
  keyed on paths orphans the note's history at exactly that moment.
- **Two people moving folders into each other cannot create a loop.** A path is
  derived from a parent name and a file name, never from a pointer to another
  node, so the cycle that breaks tree-shaped designs is not representable.

**Attachments.** Anything that is not a `.md` note — an image, a PDF, a
`.canvas` — does not go through Yjs at all. Its bytes are uploaded once to a
content-addressed store on the server, and the tree records the hash, so deciding
"is my copy current?" for two thousand attachments costs two thousand `stat`s and
no network.

The consequence worth knowing up front is that attachments do not *merge*. If two
people replace the same attachment at once — or if ShadowLink cannot tell whose
version came first — the one that lands last in the tree keeps the name, and the
other person's copy is renamed beside it to
`diagram (conflicted copy — Ann, a71c4013).png` and shared under that name.
Everybody ends up with both files and nobody loses bytes, but nobody gets one
merged file either. This catches people out with `.canvas`, which Obsidian stores
as a single JSON file and ShadowLink therefore treats as an attachment: two people
rearranging one canvas at the same time fork it.

**Deletion.** Nothing is ever hard-deleted. A delete writes a tombstone, and each
peer decides what to do with its own copy. It goes to the vault-local `.trash` —
the one you restore from inside Obsidian, on desktop and mobile — but *only* when
the content is provably in the shared document. Otherwise your copy is moved to
`ShadowLink Recovered/`, named with who deleted it and when.

If more than ten deletions arrive within ten minutes, if the attachments in one
batch add up to more than 100 MB, or if any arrive on the first sync after
Obsidian starts, everything stops and one dialog appears. The byte condition is
there because one 200 MB video is at least as consequential as eleven notes, and a
count alone waves it straight through. The dialog's default action is to keep your
files. So is pressing Escape.

**Two folders belong to the plugin.** `ShadowLink Recovered/` holds rescued
copies. `ShadowLink Staging/` is a waypoint a rename passes through and is empty
the rest of the time. Both sit at the vault root, both are visible on purpose:
hiding transient state in a dotfolder turns a crash into an invisible orphan.

<br>

---

<br>

## What you get

Live cursors with names and colours. Notes that merge instead of fighting.
Folders that stay in step. Deletions that ask before they act. A share that
reconciles itself after you have been offline, without you doing anything.

And some things that are less visible but are the reason the rest holds up: a
file it cannot prove is safe is never destroyed; a note whose content has not
finished uploading is never materialised as an empty file on anyone else's disk;
a failed network request is never mistaken for a deletion.

<br>

---

<br>

## What it does not do yet

This section is honest on purpose. These are real limitations of the current
release, not hypothetical ones.

- **Large attachments are not downloaded on their own.** Notes, images, PDFs,
  canvases and other attachments all sync now. But an attachment over about 10 MB
  — 2 MB on a phone — is held back rather than pulled down in the background, and
  so is anything past a per-session download budget of 512 MB, or 20 MB on a phone.
  Nothing is missing and nothing is broken: the file stays in the shared folder for
  everybody, the status bar counts how many are waiting and its tooltip gives the
  total, and a **Download** button appears where the embed would be. The
  *ShadowLink: Download attachments* command lists them with their sizes.
- **Past a hard ceiling, an attachment is not shared at all.** 100 MB on a desktop,
  and **32 MB on a phone** — a screen recording made on that phone is over it
  immediately. This is not the deferral above and no button lifts it: the whole
  file has to fit in memory to be hashed and verified, in both directions, so a
  device will neither publish nor download anything past its own ceiling. Sharing
  has a second ceiling on top of that — your server's `MAX_FILE_SIZE_MB`, 100 MB by
  default — and the lower of the two decides what can be published. Nothing is
  destroyed when this happens — the file stays
  exactly where you put it, it is simply not shared, and you get one notice saying
  so. If that attachment was already shared, only the new bytes are refused and the
  version everybody has stays shared. The 100 MB and 32 MB figures are compiled in;
  there is no setting for them.

  A file already sitting in the shared folder that is past the ceiling is the
  quiet version of the same thing. It stays where it is and everybody who has it
  keeps it, but this device cannot hash it, so it cannot tell whether you have
  changed it — and a change it cannot see is a change it does not share. The
  status bar's tooltip lists those files. There is no notice and nothing to press,
  because nothing is missing: open them on a device with more memory.
- **Some files are never shared, and nothing says so.** A file with no extension,
  one whose extension runs past 16 characters, and anything ending `.exe`, `.dll`,
  `.so`, `.dylib`, `.msi`, `.bat`, `.cmd`, `.com`, `.scr`, `.ps1`, `.vbs`, `.jar`,
  `.app` or `.lnk`. A shared folder is a folder somebody else can write into, and
  while Obsidian will not run what lands there, Explorer and Finder will. Nothing
  is deleted and nothing is moved — the file just stays local, silently.
- **New attachments can land outside the shared folder.** ShadowLink shares one
  folder; Obsidian's *Default location for new attachments* is a vault-wide setting
  whose default is the vault root. If yours points outside the shared folder, an
  image you drag into a shared note is saved somewhere nobody else will see it.
  ShadowLink warns about this once on startup and names the setting to change,
  but it cannot change it for you.
- **Unopened notes go stale.** A *note's* content is fetched once, when it appears.
  Until somebody opens it, later edits are not written to that peer's disk — so
  Obsidian search, `git` and any external tool can read out-of-date bytes.
  Attachments are not affected: every pass checks whether each one is still
  current, though on a cold share the re-hashing that needs is spread over several
  passes rather than done all at once.
- **The server keeps attachment bytes nothing references any more.** Deleting a
  file never deletes its bytes from the server, deliberately — that is what makes
  undelete and restore work at all. Reclaiming that space is a tool a self-hoster
  runs by hand (`server/tools/sweep-blobs.mjs`), never something the server decides
  on its own — and it takes two runs a grace period apart, because the first only
  moves the bytes aside.
- **One shared folder per vault.**
- **One shared key per server.** Anyone holding it can join any workspace on that
  server. No invitations, no per-member permissions, no read-only members yet.
- **No end-to-end encryption yet.** Put a reverse proxy in front for `wss://`, and
  treat the server as trusted. E2E is planned, and the storage layer was designed
  to keep it possible.
- **A file deleted outside Obsidian while Obsidian was closed comes back.**
  Startup never infers a deletion from a file being missing; resurrection is
  reversible, deletion is not.
- **`ShadowLink Recovered/` is never pruned.** It is an ordinary folder in your
  vault, and yours to manage.
- **When two notes end up with the same name**, one keeps it and the other gains a
  ` (2)` suffix. Which one wins is arbitrary — but identical for everybody.
- **Two people replacing one attachment produce two files, not one.** Notes merge;
  attachments do not. The version that lands last in the tree keeps the name, and
  the loser's copy is renamed to
  `diagram (conflicted copy — Ann, a71c4013).png` and shared under that name, so
  everybody ends up with both and can see whose is whose. Because `.canvas` is a
  single file rather than a note, this is also what two people editing one canvas
  at the same time get.
- **The shared document grows** as you reorganise. A team churning through a large
  share for a year will notice. Compaction is planned.

<br>

---

<br>

<div align="center">

## Get started

A server, a plugin folder, and four settings everyone types the same.

### [Read the installation guide](INSTALL.md)

<sub>Windows, macOS and Linux &nbsp;·&nbsp; Node.js 18+ &nbsp;·&nbsp; no account, no cloud</sub>

</div>

<br>

---

<br>

## For developers

The sync engine is deliberately testable without Obsidian: everything touching
the vault or the network goes through a port with an in-memory fake, so the whole
reconciler runs headless.

```bash
npm test                    # unit and integration tests
npm run test:e2e            # real server, two real Yjs clients
npm run test:e2e:structural # three clients, 200 random ops, partitions, 20 seeds
npm run build               # type-check, then bundle main.js
npm run server              # start the server
```

A short tour of how it fits together:

- **`src/tree/`** — the shared data model. The folder's structure is one Yjs
  document per workspace: a flat map of nodes, each holding its parent directory
  and its name. A path is *derived* from those two, never stored, which is why
  two people moving folders into each other cannot create a loop.
- **`src/sync/`** — the engine. `Reconciler` brings the disk to what the tree
  describes, in one idempotent pass that recomputes rather than patches.
  `VaultWatcher` goes the other way, with handlers written as "make the tree
  match reality" so they are safe to replay. `Deletions` decides, per file,
  between the vault trash and a rescue. Everything reaches the outside world
  through a port with an in-memory fake.
- **`server/`** — two halves sharing one process and one key. `DocHub.js` relays
  the standard Yjs protocol over WebSocket, with the shared key checked at the
  upgrade (`upgradeAuth.js`) before any data flows. Attachments take the other
  half: `blobRoutes.js` serves `HEAD`/`GET`/`PATCH` on a content hash plus a
  `limits` probe, behind a bearer check (`httpAuth.js`), and `blobStore.js` is the
  content-addressed store underneath — write-once objects at a fanned-out path,
  resumable partial uploads, a re-hash of what was assembled before anything is
  published, and usage accounting against a whole-store quota. `server/tools/sweep-blobs.mjs` is
  the offline sweeper; the server itself has no delete route and never removes an
  attachment on its own.

[CONTRIBUTING.md](CONTRIBUTING.md) covers how to get a change accepted, and the
rules that are not negotiable — chiefly that nothing is ever hard-deleted, and
that a failure is never allowed to look like a deletion.

<br>

---

<br>

## What is coming

Continuous content sync, so unopened notes stop going stale. Invitation links with
per-member permissions, replacing the single shared key. Then opt-in end-to-end
encryption, which is rather the point of having built it self-hosted and open.

Contributions are welcome — [CONTRIBUTING.md](CONTRIBUTING.md) explains how, and
what this project declines. Security reports go through
[SECURITY.md](SECURITY.md), privately. Questions about setting it up belong in
[Discussions](https://github.com/Phobetore/ShadowLink/discussions).

If ShadowLink turns out to be useful to you, starring it is the thing that puts
it in front of the next person looking for the same thing.

<br>

## Licence

[GPL-3.0-or-later](LICENSE). Run it, change it and share it freely. A modified
version you distribute stays open source under the same licence.

<br>

<div align="center">
<sub>Sharing a project should cost you one folder, not your whole vault.</sub>
</div>
