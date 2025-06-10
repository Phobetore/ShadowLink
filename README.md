# ShadowLink – Real-Time Collaborative Editing for Obsidian

ShadowLink is an open-source Obsidian plugin that enables **real-time collaborative editing** on Markdown files. Inspired by **Relay**, it allows multiple users to edit notes simultaneously, with seamless synchronization and no data conflicts.

## Features (Planned)

- **Real-Time Collaboration** – Multiple users can edit the same note simultaneously.
- **Conflict-Free Synchronization** – Built on Yjs (CRDT) to ensure smooth merging of edits.
- **Offline Mode** – Changes are stored locally and synced when reconnected.
- **Shared Folders** – Collaborate across multiple notes within a shared directory.
- **Self-Hostable WebSocket Server** – No reliance on third-party services.
- **Live Cursor Tracking** – View collaborator cursors in real time.
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

### Roadmap

1. **Prototype Phase**
   - [x] Set up Obsidian plugin structure.
   - [ ] Implement Yjs-based text synchronization.
   - [ ] Establish a WebSocket relay server.
   - [ ] Synchronize simple text edits between two Obsidian instances.

2. **Collaboration Core**
   - [ ] Improve synchronization performance.
   - [ ] Support multiple simultaneous collaborators.
   - [ ] Implement live cursor tracking.

3. **Extended Features**
   - [ ] Shared folder support.
   - [ ] Offline mode with automatic merging.
   - [ ] End-to-end encryption.

## Contributing

By contributing to this project, you agree that your code will be released under the GNU General Public License v3 (GPLv3). Ensure your contributions are compatible with the project's license. If you have questions, open an issue in the repository.

## License

ShadowLink is open-source under the MIT License.

## Contact

For updates and discussions, visit the [GitHub Issues](https://github.com/Phobetore/ShadowLink/issues) section.
