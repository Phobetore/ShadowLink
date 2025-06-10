# ShadowLink – Real-Time Collaborative Editing for Obsidian

ShadowLink is an open-source Obsidian plugin that enables **real-time collaborative editing** on Markdown files. Inspired by **Relay**, it allows multiple users to edit notes simultaneously, with seamless synchronization and no data conflicts.

## Features (Planned)

- **Real-Time Collaboration** – Multiple users can edit the same note simultaneously.
- **Conflict-Free Synchronization** – Built on Yjs (CRDT) to ensure smooth merging of edits.
- **Offline Mode** – Changes are stored locally and synced when reconnected.
- **Shared Folders** – Collaborate across multiple notes within a shared directory.
- **Self-Hostable WebSocket Server** – No reliance on third-party services.
- **Live Cursor Tracking** – View collaborator cursors in real time.
- **User Names & Colors** – Each collaborator chooses a name displayed above their colored cursor.
- **End-to-End Encryption** *(Planned)* – Secure note sharing without exposing data to the server.

## Project Status

ShadowLink is currently in **early prototyping**. The focus is on:
- Implementing basic **synchronization** using Yjs.
- Establishing a **WebSocket-based communication layer**.
- Integrating real-time edits with **Obsidian’s CodeMirror editor**.

## Installation (Not Available Yet)

As the project is in its early stages, no stable release is available. Future installation instructions will be provided once a working version is ready.

## Development

### Tech Stack

- **Language**: TypeScript
- **Editor Integration**: CodeMirror (Obsidian API)
- **Real-Time Engine**: Yjs (CRDT)
- **Networking**: WebSocket (Node.js server)
- **Offline Storage**: IndexedDB

### Building the Plugin

Install dependencies and build the plugin with:

```bash
npm install
npm run build
```

This creates a bundled `main.js` file that Obsidian loads as the plugin.

### Running the Relay Server

The repository includes a minimal WebSocket relay for local testing. Start it with:

```bash
npm run server
```

The plugin connects to `localhost:1234` by default. If your server uses TLS a
secure `wss://` connection is chosen automatically. Documents are persisted on
the server by default in a `yjs_data` directory next to the server script. Set
the `YPERSISTENCE` environment variable to choose a different location or clear
it to disable persistence entirely. Each Obsidian vault is assigned a short
identifier derived from its path so multiple vaults can sync to the same server
without collisions.
Set `WS_AUTH_TOKEN` to require a shared secret; connections without the token
are rejected.

### Standalone Server

If you only need the relay server, a trimmed-down package is provided in the
`server/` directory. Install dependencies and start the server with:

```bash
cd server
npm install
npm start
```

The server listens on port `1234` unless the `PORT` environment variable is set.
For HTTPS, provide your certificate and key via `SSL_CERT` and `SSL_KEY`. When
both variables are present the server uses TLS and announces a `wss://` URL.
By default documents are stored under `server/yjs_data`. Use `YPERSISTENCE` to
specify another directory or leave it empty to disable persistence. The plugin
automatically switches to `wss://` when it detects a TLS-enabled server.
Set `WS_AUTH_TOKEN` to enforce a token for clients just like the main server.

### Roadmap

1. **Prototype Phase**
   - [x] Set up Obsidian plugin structure.
   - [x] Implement Yjs-based text synchronization.
   - [x] Establish a WebSocket relay server.
   - [x] Synchronize simple text edits between two Obsidian instances.

2. **Collaboration Core**
   - [ ] Improve synchronization performance.
   - [ ] Support multiple simultaneous collaborators.
   - [ ] Implement live cursor tracking.

3. **Extended Features**
   - [ ] Shared folder support.
   - [ ] Offline mode with automatic merging.
   - [ ] End-to-end encryption.

## Contributing

By contributing to this project, you agree that your code will be released under the GNU General Public License v3 or later (GPLv3+). Ensure your contributions are compatible with the project's license. If you have questions, open an issue in the repository.

## License

ShadowLink is open-source under the GNU General Public License v3 or later (GPLv3+).

## Contact

For updates and discussions, visit the [GitHub Issues](https://github.com/Phobetore/ShadowLink/issues) section.
