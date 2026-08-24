# Installing ShadowLink

This guide assumes you are not a developer. You do not need to know how to code.
Set aside about twenty minutes, follow the steps in order, and at the end a
folder in your vault will be shared with the people you chose.

If you get stuck, jump to [If something goes wrong](#if-something-goes-wrong).

---

## First, the one thing to understand

ShadowLink has two halves.

1. **The server.** One small program, running on one machine. It stores the
   shared folder and passes changes between everybody. It does not need to be
   powerful — an old laptop, a Raspberry Pi or a €4 VPS is plenty.
2. **The plugin.** Installed in each person's Obsidian, in each vault that takes
   part.

Exactly one person sets up the server. Everybody, including that person, installs
the plugin.

There is no account anywhere. What identifies a share is four settings that
everyone types identically, plus a key the server generates for you.

---

## Step 1: run the server

Do this once, on the machine that will host the share.

### What you need

[Node.js](https://nodejs.org) version 18 or newer. To check what you have, open a
terminal — PowerShell on Windows, Terminal on macOS or Linux — and run:

```bash
node --version
```

If it prints something lower than `v18`, or an error, install the LTS version
from [nodejs.org](https://nodejs.org) and try again.

### Get it running

```bash
git clone https://github.com/Phobetore/ShadowLink
cd ShadowLink
npm install
npm run server
```

You should see something like:

```
========================================
  SHADOWLINK SERVER
========================================
  Port:       4000
  Creds file: ./data/SHADOWLINK_ADMIN_CREDS.txt
========================================

ShadowLink server listening on ws://0.0.0.0:4000
```

Leave that terminal open. Closing it stops the server.

### Get your server key

On the very first start, the server writes a file called
`data/SHADOWLINK_ADMIN_CREDS.txt`. Open it and find the line beginning with
`SERVER_KEY=`. It looks like `sk_` followed by a long string of characters.

**That key is the password to your server.** Anyone who has it can join. Send it
to your collaborators the way you would send a password — a password manager, a
private message, anything that is not a public channel. Do not put it in a public
repository or a shared document.

### Let the others reach it

If everyone is on the same home or office network, your address is the machine's
local IP: something like `ws://192.168.1.20:4000`. On Windows `ipconfig` will
tell you; on macOS and Linux, `ip addr` or `ifconfig`.

If people need to connect from elsewhere, you have the usual options: a port
forward on your router, a VPN such as [Tailscale](https://tailscale.com), or a
small VPS. A VPN is the easiest thing that is also safe.

> **Encryption.** By default the server speaks plain `ws://`, which is fine on a
> home network or inside a VPN. Across the open internet, put a reverse proxy in
> front of it (Caddy, Nginx or Traefik) so people connect over `wss://` instead,
> and use that `wss://` address in the plugin. ShadowLink does not yet encrypt
> your notes from the server itself — see [SECURITY.md](SECURITY.md).

### Keeping it running

When you close the terminal, the server stops. To keep it alive, the usual
approaches all work: `systemd` on Linux, a scheduled task on Windows, `pm2`, or
`screen`/`tmux`. Anything that restarts it on boot is enough — the server picks
up its state from the `data/` folder.

---

## Step 2: install the plugin

Every person doing this, in every vault that takes part.

### Build it

On the same machine as the repository:

```bash
npm run build
```

That produces `main.js` in the project folder.

### Copy it in

Find your vault's folder. Inside it there is a hidden `.obsidian` folder. Create
this path:

```
<your vault>/.obsidian/plugins/shadowlink/
```

Copy two files into it:

- `main.js` (the one you just built)
- `manifest.json` (from the project folder)

> Sharing with someone who is not going to clone a repository? Send them those two
> files. That is the whole plugin.

### Turn it on

In Obsidian: **Settings → Community plugins**. If Restricted mode is on, turn it
off. Then find **ShadowLink** in the installed list and enable it.

---

## Step 3: agree on four settings

Open **Settings → ShadowLink**. There are two groups.

**Identity** — yours alone, nobody has to match:

| Setting | What it is |
|---|---|
| Display name | The name your collaborators see beside your cursor |
| Cursor colour | A hex colour such as `#7c6af7` |

**Shared workspace** — **everybody must type these identically**:

| Setting | What it is | Example |
|---|---|---|
| Server URL | Where the server is | `ws://192.168.1.20:4000` |
| Server key | The `sk_…` from the creds file | `sk_7f3a9c…` |
| Workspace ID | A name you agree on, letters/digits/`-`/`_` | `team-notes` |
| Shared folder | The folder in *your* vault that is shared | `Shared` |

Two things worth knowing:

- **The workspace ID is what pairs you up.** Same ID plus same server means the
  same share. A typo makes a second, empty workspace rather than an error.
- **The shared folder is local to you.** Your `Shared` can be their `Team/Notes`
  if you both prefer. The contents sync; the mount point does not have to match.

Create the folder in your vault if it does not exist, then **turn the plugin off
and on again** so it picks up the settings.

---

## Step 4: the first sync

The first time a vault joins a workspace, ShadowLink shows one dialog before
touching anything. It tells you what is about to happen:

- **adopt** — files you already have that the workspace also has
- **download** — files the workspace has and you do not
- **upload** — files you have that the workspace does not

The upload box is ticked by default. Untick it to keep those files local, and
share them later with the **ShadowLink: Resolve kept files** command from the
command palette.

Press **Start**. Pressing Escape or Cancel does nothing at all — the safe answer
is always the default.

If your copy of a file differs from the workspace's, the workspace version wins on
disk and *your* version is saved into `ShadowLink Recovered/`. Nothing is thrown
away without a copy.

---

## Step 5: check that it works

With two people connected:

1. Both open the same note inside the shared folder. Type in one. It should
   appear in the other within a fraction of a second, with a coloured cursor.
2. Create a note in the shared folder on one side. It should appear on the other.
3. Rename it. The rename should follow — and if somebody had it open, their
   cursor should not move.
4. Put something *outside* the shared folder. It should stay put and never appear
   anywhere else.

The status bar at the bottom of Obsidian shows the current state. `paused` with a
reason means sync has stopped on purpose; hover for why.

---

## If something goes wrong

**Nothing syncs, and the status bar says `paused`.**
Hover it. "The shared folder no longer exists" means the folder name in settings
does not match the folder in your vault. Most pauses clear by themselves once the
cause is gone; a few need the plugin toggled off and on.

**Nothing syncs, and there is no error.**
Check the server terminal is still running, and that the Server URL is reachable
from this machine. `ws://` for a plain server, `wss://` behind a proxy — mixing
them up fails silently.

**"Nothing happens" for one person only.**
Nine times out of ten it is a mismatch in the four settings. Compare them
character by character, especially the workspace ID and the key.

**A note appeared empty on my side.**
That should not happen — ShadowLink refuses to create a file before it has the
content. If you see it, please
[open an issue](https://github.com/Phobetore/ShadowLink/issues), because it means
a guarantee was broken.

**Someone deleted a file and mine went missing.**
Look in `ShadowLink Recovered/` first, then in Obsidian's own trash
(**Settings → Files & Links → Deleted files**). ShadowLink never hard-deletes
anything, so it is in one of the two.

**An image is a broken link.**
Expected, for now. Attachments do not sync yet — see
[What it does not do yet](README.md#what-it-does-not-do-yet).

**I changed a setting and nothing changed.**
Settings are read when the plugin loads. Toggle it off and on.

**I want to start over.**
Stop the server, delete its `data/` folder, and start it again. That is a fresh
server with a new key — every member will need the new one. Your notes are not
touched: they are ordinary files in your vault.

---

## Server settings

Environment variables, all optional:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | Port to listen on |
| `PERSISTENCE_DIR` | `./data` | Where the shared documents and the key file live |

To use them:

```bash
PORT=5000 PERSISTENCE_DIR=/var/lib/shadowlink npm run server
```

Back up `PERSISTENCE_DIR`. It holds the server's copy of the share and the key
file. Everyone's vault also holds a full copy of every note, so losing it is
recoverable — but it is not nothing.
