# Security policy

## Reporting something

Report privately, through
[GitHub's private advisory form](https://github.com/Phobetore/ShadowLink/security/advisories/new).
It reaches the maintainer without the report being public first. Please do not
open a normal issue for a vulnerability.

Tell me what you found, how to reproduce it, and what an attacker gets out of it.
A working proof of concept is welcome but not required.

ShadowLink is maintained by one person. Expect an acknowledgement within a week,
and a fix released when it is written and tested rather than on a schedule I would
end up missing. You will be credited unless you would rather not be.

## Which versions get fixes

The newest release, and nothing else. The project is young enough that there is
no sensible support window to promise.

## What the threat model actually is

Read this before deciding where to run a server. These are properties of the
current release, not oversights I am unaware of.

**One key guards the whole server.** `SERVER_KEY` is checked at the WebSocket
upgrade, before any document data flows. That is the only authentication there
is. Anyone holding it can join **any** workspace on that server, read everything
in it, and write to it. There are no accounts, no per-member permissions, no
read-only members, and no invitations. Treat the key exactly like a shared
password: send it through a password manager or a private channel, never a public
repository or a shared document.

**Rotating the key locks everyone out.** Delete the server's `data/tokens.json`
and restart — the server mints a new key, and every member has to be given it.
There is no way to revoke one member.

**The server is trusted.** Documents are stored and relayed in plaintext. Anyone
with access to the server process or its `PERSISTENCE_DIR` can read every shared
note. End-to-end encryption is planned, and the storage layer was designed to
keep it possible, but it does not exist yet. Do not put anything on a server you
do not control that you would not hand to whoever controls it.

**Transport is unencrypted by default.** The server speaks plain `ws://`, which
is fine inside a home network or a VPN. Across the open internet, put a reverse
proxy in front of it (Caddy, Nginx or Traefik) so members connect over `wss://`.
Without that, the key and every keystroke cross the network in the clear.

**A member is trusted once they are in.** There is no server-side validation of
what a client writes into the shared documents. A hostile member can tombstone
everything in a workspace, or fill it with rename churn. Client-side limits
contain the blast radius — every path is validated before it touches a
filesystem, nothing outside the shared folder can be written, nothing is ever
hard-deleted, and a bulk deletion has to be confirmed by each recipient — but the
shared document itself has no guard. Only share a key with people you would give
write access to a shared drive.

**Data loss is bounded on purpose.** This is the part the design spends most of
its effort on. Removal is never destructive: a deletion is a tombstone, your copy
goes to Obsidian's own trash only when the content is provably in the shared
document, and otherwise into `ShadowLink Recovered/`. More than ten deletions in
ten minutes stops and asks, defaulting to keeping your files. A file the plugin
cannot prove is safe is never destroyed.

## What is in scope

- Anything that lets a client read or write a workspace without the server key.
- Any path a remote peer can use to write outside the configured shared folder,
  or to make the plugin delete something without the documented confirmation.
- Any way to make the plugin destroy content irrecoverably — that is the
  project's central promise, and a break in it is the most serious report you can
  send.
- Anything that leaks the server key or a note's content to a third party.

## What is out of scope

- The absence of end-to-end encryption, of per-member permissions, and of
  server-side validation. Those are documented above and on the roadmap.
- Denial of service against a server you were given the key to.
- Anything requiring an attacker who already has the server key, unless it
  crosses a boundary the key is not supposed to open.
