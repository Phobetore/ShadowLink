# ShadowLink

**Real-Time Collaboration for Obsidian**

ShadowLink brings live collaborative editing to [Obsidian](https://obsidian.md). Multiple users can work on the same notes simultaneously while changes sync automatically through a lightweight WebSocket server. The project is in early development but already provides the core building blocks for conflict‑free collaboration.

## Features

- **Real-time collaboration** powered by [Yjs](https://github.com/yjs/yjs)
- **Conflict-free syncing** using CRDTs
- **Offline support** – unsynced updates are stored in IndexedDB and applied when the server reconnects
- **Minimal storage footprint** – only incremental updates are persisted
- **Self-hostable relay server** included in this repository
- **Live cursors** with user names and colors
- **Planned**: shared folders and end-to-end encryption

## Getting Started

### Build the plugin

1. Install dependencies
   ```bash
   npm install
   ```
2. Build the plugin
   ```bash
   npm run build
   ```
   The build creates `main.js` alongside `manifest.json` and `styles.css`.

### Install into Obsidian

1. Create a folder called `shadowlink` inside your vault's `.obsidian/plugins` directory.
2. Copy `manifest.json`, `main.js` and `styles.css` into that folder.
3. Launch Obsidian and enable **ShadowLink** from *Settings → Community Plugins*.

### Run the relay server

The plugin expects a WebSocket relay at `localhost:1234` by default. You can run the bundled server with:

```bash
npm run server
```

Environment variables:
- `PORT` – change the listening port (defaults to `1234`)
- `YPERSISTENCE` – directory for document storage; leave empty to disable persistence
- `WS_AUTH_TOKEN` – optional token required from all clients
- `SSL_CERT` / `SSL_KEY` – enable TLS with your certificate and key

A trimmed-down standalone server is available in the `server/` folder:

```bash
cd server
npm install
npm start
```

### Using ShadowLink

1. In Obsidian, open *Settings → ShadowLink* to configure:
   - **Server URL** – address of your WebSocket relay
   - **Username** – name shown to collaborators
   - **Auth Token** – required if the server enforces a token
2. Open any Markdown file and start editing. Other users connected to the same document will see your changes in real time.

## How It Works

ShadowLink uses Yjs to represent each note as a Conflict-free Replicated Data Type. Edits are transmitted over the WebSocket server and merged on all clients without conflicts. While offline, updates accumulate in IndexedDB. As soon as the connection is restored, the pending changes sync and the local cache is cleared. Each vault is assigned a unique identifier so multiple vaults can share a single server without collisions.

## Roadmap

- [x] Prototype with basic Yjs synchronization
- [ ] Improve performance and support large numbers of collaborators
- [ ] Live cursor tracking
- [ ] Shared folder synchronization
- [ ] End-to-end encryption

## Contributing

Contributions are welcome! By submitting code, you agree to release it under the [GNU General Public License v3 or later](LICENSE). Please open an issue to discuss any major changes before submitting a pull request.

## License

ShadowLink is distributed under the terms of the [GPL‑3.0-or-later](LICENSE).

## Contact

For help or to follow development, visit the [GitHub Issues](https://github.com/Phobetore/ShadowLink/issues) page.

