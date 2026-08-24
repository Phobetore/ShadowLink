# ShadowLink

Collaborative editing for [Obsidian](https://obsidian.md), self-hosted.

**Status: P1 — real-time text co-editing *and* structural sync for one shared
folder.** Creating, renaming, moving and deleting a note now propagates to every
member: the folder's structure lives in a Yjs file tree, alongside one Yjs
document per note.

## What P1 does

- **Text.** [Yjs CRDT](https://yjs.dev) over the standard y-protocols sync, with
  live cursors via Yjs awareness — unchanged from P0.
- **Structure.** A shared `_tree` document holds the folder's files and folders.
  Create a note, rename it, drag it into a subfolder, delete it, and every
  member's vault follows. Empty folders sync too, so the shape of the folder is
  shared and not just its contents.
- **Rename and move are not re-creates.** A note's content document is keyed by
  an immutable node id, never by its path. Renaming or moving a note **while it
  is open** keeps the editing session, the leaf and the cursor exactly where they
  were — the rename is invisible to the CodeMirror binding, and no history is
  lost on either side.
- **Scope.** One shared folder per vault. Nothing outside it is ever shared. Two
  folders at the vault root belong to the plugin: `ShadowLink Recovered/`, where
  your copies are rescued to, and `ShadowLink Staging/`, which a rename passes
  through and which is empty the rest of the time.
- **Auth.** The server validates `SERVER_KEY` at the WebSocket upgrade, before
  any data flows.

## Deletion safety

A delete is never destructive on the peers that receive it. Deletions are
**tombstones** in the shared tree, and when your client applies one it decides
per file:

- If the file's content is **provably** the shared document's content — the node
  was published, this device recorded a confirmed hash for it, and the bytes on
  disk still match that hash — the file goes to the **vault-local `.trash`**,
  which you can restore from inside Obsidian on every platform, mobile included.
- **Otherwise** — the note was never published, or you had unsynced edits, or you
  have it open — your copy is **moved aside** into `ShadowLink Recovered/` under
  a name recording who deleted it and when. Nothing is removed on a guess.

Bulk deletions are gated. A batch that would push this device past its deletion
rate window, and **any** batch arriving on a first sync (the "you were offline
while the team reorganized" case), applies nothing until you answer one dialog.
That dialog **defaults to keeping your files** — dismissing it, pressing Escape,
or never seeing it all mean the same thing: keep.

The plugin never calls Obsidian's permanent-delete or system-trash APIs. A test
in the suite reads the shipped source to keep it that way.

## Quick start

### 1. Run the server

Requires Node.js 18+.

```bash
git clone https://github.com/Phobetore/ShadowLink
cd ShadowLink
npm install
npm run server
```

Copy the `SERVER_KEY` from `data/SHADOWLINK_ADMIN_CREDS.txt`.

### 2. Install the plugin

Copy `main.js` and `manifest.json` into each vault's
`.obsidian/plugins/shadowlink/` folder and enable the plugin.

### 3. Configure (every member, identically)

Settings → ShadowLink: the same **Server URL**, **Server key**, **Workspace ID**
and **Shared folder**. Toggle the plugin off and on to apply.

### 4. First sync

On its first join each member is shown exactly one dialog: what will be
downloaded, what local files will be adopted into the shared folder, and what
will be uploaded. Nothing on disk is touched until you accept it, and the
"share my local files" checkbox can be unchecked to keep them on this device.
That is not a one-way door: the command **ShadowLink: Resolve kept files** lists
what you kept back and shares whichever of it you pick, whenever you like.

## Limitations

These are real and current. Read them before you rely on this.

- **Non-markdown files are not synced.** Images, PDFs and every other attachment
  are ignored — they are not uploaded, not downloaded, and not deleted. An
  embedded `![[diagram.png]]` will render as a broken link for everyone who does
  not already have that file in their own vault.
- **A note nobody has open is fetched once, not continuously.** Your client
  writes a note's bytes to disk when it first materializes it and then leaves the
  file alone. Later edits by peers live in the shared document and reach your
  disk only when you open the note — at which point the shared version wins and
  any differing local copy is preserved in `ShadowLink Recovered/`. Until then,
  external tools, scripts and Obsidian's own search read stale bytes.
- **One shared folder per vault.** There is no second folder and no per-folder
  configuration.
- **No invites and no per-member permissions.** Everyone shares a single
  `SERVER_KEY`. Anyone holding it can read and write every workspace on that
  server; there is no way to revoke one person without rotating the key for all.
- **No end-to-end encryption.** The server sees the plaintext of every document.
  Use `wss://` (below) so the network does not, and self-host on a machine you
  trust.
- **`ShadowLink Recovered/` grows without bound.** Nothing prunes it. It is your
  copy of files a peer deleted, and clearing it out is your call.
- **A file deleted while Obsidian was closed comes back.** On start, a note the
  workspace still has and your vault does not is re-downloaded, never read as a
  deletion — there is no evidence telling "the user deleted it externally" apart
  from "we never finished fetching it", and resurrection is reversible where
  deletion is not. Delete it again with Obsidian running and it goes for everyone.
- **The structure document only ever grows.** Renaming a folder rewrites every
  descendant's entry, and the CRDT keeps the superseded ones, so heavy
  reorganization churn inflates the shared `_tree` document permanently. A team
  reshuffling a few thousand notes monthly should expect a multi-megabyte tree
  within a year — large, not broken. There is no compaction yet.
- **Two notes with the same name: which one keeps the plain name is arbitrary.**
  The tree honestly holds both, and your vault shows `Notes.md` and
  `Notes (2).md`. Which is which is decided by internal id order, identically on
  every device, and it will not match anyone's intuition. Renaming one of them
  resolves it for everybody.
- **Keeping your copies of a bulk delete leaves this device out of step on
  purpose.** Those files stay yours and stop being shared, permanently and with
  no re-prompt — including local files you kept back on first sync. The command
  **ShadowLink: Resolve kept files** lists everything in that state and shares
  the ones you pick; nothing else revisits the decision.
- Settings are read at plugin load — toggle the plugin after changing them.

## Server configuration

Environment variables the server actually reads:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP/WebSocket port |
| `PERSISTENCE_DIR` | `./data` | Where credentials and document snapshots are stored |

`ROOM_DEFAULT_TTL` is still validated at startup — an unrecognized value refuses
to boot — but nothing consumes it: rooms are permanent. Earlier versions of this
README also listed `MAX_FILE_SIZE_MB`, `MAX_TOTAL_STORAGE_GB`,
`RATE_LIMIT_OPS_PER_SEC` and `MAX_CONNECTIONS_PER_IP`. The server no longer reads
any of them, and setting them does nothing.

Document snapshots are written to `PERSISTENCE_DIR/yjs/` on a trailing debounce,
via a temp file and a rename, so a reader only ever sees a complete snapshot.

## Encryption in transit

By default the server speaks unencrypted `ws://`. For `wss://`, put a reverse
proxy in front:

- **Nginx**: add a WebSocket proxy to your site config
- **Caddy**: `reverse_proxy localhost:4000`
- **Traefik**: use the `websecure` entrypoint

## Development

```bash
npm run dev                 # watch mode — rebuilds main.js on change
npm run build               # typecheck, then a production main.js
npm test                    # server unit tests, then client unit tests
npm run test:e2e            # text co-editing against a real server process
npm run test:e2e:structural # structural convergence: real clients, real sockets
npm run server              # start the server
```

`test:e2e:structural` runs the whole Group C suite — concurrent renames,
partitions, offline deletes, and twenty seeds of 200 randomized operations across
three clients. It takes about a minute. Useful knobs: `SL_E2E_SEEDS`,
`SL_E2E_OPS`, `SL_E2E_PORT`, `SL_E2E_DEAD_PORT`, and `--only=<substring>` to run
one case.

## License

GPL-3.0-or-later
