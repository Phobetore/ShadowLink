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

> **Status: early.** The sync engine is finished and heavily tested — 400+
> automated tests, including three simulated clients performing 200 random
> operations each across network partitions. What has *not* had heavy real-world
> use is the plugin inside Obsidian itself. Treat this as a beta, keep backups,
> and please [open an issue](https://github.com/Phobetore/ShadowLink/issues) when
> something misbehaves.

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

**Deletion.** Nothing is ever hard-deleted. A delete writes a tombstone, and each
peer decides what to do with its own copy. It goes to the vault-local `.trash` —
the one you restore from inside Obsidian, on desktop and mobile — but *only* when
the content is provably in the shared document. Otherwise your copy is moved to
`ShadowLink Recovered/`, named with who deleted it and when.

If more than ten deletions arrive within ten minutes, or any arrive on your first
sync after time away, everything stops and one dialog appears. Its default action
is to keep your files. So is pressing Escape.

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

- **Only `.md` files sync.** Images, PDFs and other attachments are ignored, so a
  note containing `![[diagram.png]]` shows a broken link for everybody else. This
  is the biggest gap and the next thing being built.
- **Unopened notes go stale.** A note's content is fetched once, when it appears.
  Until somebody opens it, later edits are not written to that peer's disk — so
  Obsidian search, `git` and any external tool can read out-of-date bytes.
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

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the technical tour: the data
model, the reconciliation pass, and the invariants that each exist because a
specific failure was found without them.
[CONTRIBUTING.md](CONTRIBUTING.md) covers how to get a change accepted.

The full design record lives in [`docs/`](docs/) — the audit that started the
rewrite, the competitive analysis, the design specification, and every
implementation plan, including the bugs found along the way and why the rejected
alternatives were rejected.

<br>

---

<br>

## What is coming

Attachments and images, the gap people will hit first. Continuous content sync,
so unopened notes stop going stale. Invitation links with per-member permissions,
replacing the single shared key. Then opt-in end-to-end encryption, which is
rather the point of having built it self-hosted and open.

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
