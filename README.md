# ShadowLink

Real-time collaborative editing for [Obsidian](https://obsidian.md). **Status: P0 —
real-time text co-editing of notes inside a single shared folder.** Structural sync
(create/rename/move/delete), invites, images, and the member panel are on the roadmap
(see `docs/review/2026-06-25-redesign-recommendation.md`).

## How it works (P0)

- **Text**: [Yjs CRDT](https://yjs.dev) over the standard y-protocols sync; live cursors via Yjs awareness.
- **Scope**: only notes inside the configured shared folder sync; the rest of the vault stays local.
- **Auth**: the server validates `SERVER_KEY` at the WebSocket upgrade before any data flows.

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

Copy `main.js`, `styles.css`, and `manifest.json` into each vault's
`.obsidian/plugins/shadowlink/` folder and enable the plugin.

### 3. Configure (every member, identically)

Settings → ShadowLink: same **Server URL**, **Server key**, **Workspace ID**, and
**Shared folder** name. Toggle the plugin off/on to apply.

### 4. Collaborate

Create a note at the same path inside the shared folder in each vault, open it in both,
and edit — changes and cursors sync live.

### P0 limitations

- A note must exist at the same path in every member's vault (no structural sync yet).
- Only notes inside the shared folder sync.
- Settings are read at plugin load — toggle the plugin after changing them.
- The shared document is the source of truth once connected; opening a note with content
  that differs from the shared version will show the shared version.

## Server configuration

Set via environment variables or a `.env` file:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | WebSocket server port |
| `MAX_FILE_SIZE_MB` | `700` | Max binary file size |
| `MAX_TOTAL_STORAGE_GB` | `0` | Total storage cap (0 = unlimited) |
| `ROOM_DEFAULT_TTL` | `permanent` | Default room lifetime: `session` \| `24h` \| `7d` \| `30d` \| `permanent` |
| `PERSISTENCE_DIR` | `./data` | Where to store vault data |
| `RATE_LIMIT_OPS_PER_SEC` | `10` | Max WebSocket messages per second per connection |
| `MAX_CONNECTIONS_PER_IP` | `50` | Max simultaneous connections per IP |

## Encryption

By default the server uses unencrypted `ws://`. For encrypted `wss://`, put a reverse proxy in front:

- **Nginx**: add a WebSocket proxy to your site config
- **Caddy**: `reverse_proxy localhost:4000`
- **Traefik**: use the `websecure` entrypoint

## Development

```bash
npm run dev    # watch mode — rebuilds main.js on change
npm test       # run server unit tests
npm run server # start the server
```

## License

GPL-3.0-or-later

