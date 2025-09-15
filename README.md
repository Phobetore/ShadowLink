# ShadowLink

Real-time collaborative editing plugin for Obsidian using conflict-free document synchronization.

## Project Overview

ShadowLink transforms Obsidian into a collaborative knowledge management platform by enabling multiple users to simultaneously edit notes with real-time synchronization. This open-source solution provides an alternative to expensive proprietary collaboration services while maintaining complete control over your data.

## Motivation

Existing collaborative note-taking solutions often come with significant limitations:

- **High costs**: Services like Relay charge substantial fees for team collaboration
- **Privacy concerns**: Sensitive information stored on external platforms
- **Limited customization**: Restricted ability to modify or extend functionality

ShadowLink addresses these issues by providing a fully open-source, self-hostable solution that integrates directly with Obsidian's powerful knowledge management features.

## Technical Architecture

### Design Philosophy

The architecture follows a distributed approach with conflict-free synchronization at its core:

**Client-Side Components:**
- Obsidian plugin that integrates with CodeMirror editor
- Yjs-based Conflict-free Replicated Data Types (CRDTs) for document state
- IndexedDB persistence for offline operation
- WebSocket client for real-time communication

**Server-Side Components:**
- Lightweight WebSocket relay server for message broadcasting
- Vault management system with session tracking
- Rate limiting and security validation
- Optional persistence layer for document storage

### Why This Approach

**Yjs and CRDTs**: Traditional operational transformation approaches require complex server-side logic to resolve conflicts. Yjs CRDTs enable automatic conflict resolution without requiring a central authority, making the system more robust and scalable.

**WebSocket Relay**: Rather than implementing complex server-side document management, the server acts as a simple message relay. This keeps the server lightweight while pushing intelligence to the clients, improving scalability and reducing server complexity.

**Plugin Architecture**: By building as an Obsidian plugin, we leverage Obsidian's mature file management, editor integration, and plugin ecosystem while adding collaboration capabilities.

## Key Features

**Real-time Synchronization**
- Instant propagation of changes across connected clients
- Automatic conflict resolution using Yjs CRDTs
- No data loss during concurrent editing

**Offline Capability**
- Local changes stored in IndexedDB when disconnected
- Automatic synchronization when connection is restored
- Comprehensive conflict resolution for offline modifications

**Vault Collaboration**
- Share entire vaults with team members
- Granular access control and session management
- Support for multiple concurrent vaults

**Robust Architecture**
- Rate limiting to prevent abuse
- Security validation and authentication
- Protection against rapid file switching
- Comprehensive error handling and recovery

## Installation and Setup

### Prerequisites

- Obsidian desktop application
- Node.js (version 16 or later) for building the plugin
- Network access for collaboration features

### Building the Plugin

1. Clone the repository:
   ```bash
   git clone https://github.com/Phobetore/ShadowLink.git
   cd ShadowLink
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the plugin:
   ```bash
   npm run build
   ```

### Installing in Obsidian

1. Navigate to your Obsidian vault directory
2. Create the plugin directory:
   ```bash
   mkdir -p .obsidian/plugins/shadowlink
   ```

3. Copy the built files:
   ```bash
   cp manifest.json main.js styles.css .obsidian/plugins/shadowlink/
   ```

4. Launch Obsidian and enable ShadowLink:
   - Open Settings → Community Plugins
   - Enable "ShadowLink" from the installed plugins list

### Server Deployment

#### Quick Start (Development)

For local testing and development:

```bash
npm run server
```

The server will start on `localhost:1234` by default.

#### Production Deployment

1. Use the standalone server for production:
   ```bash
   cd server
   npm install
   npm start
   ```

2. Configure environment variables:
   ```bash
   export PORT=8080                    # Server port
   export WS_AUTH_TOKEN=your_token     # Authentication token
   export YPERSISTENCE=/data/yjs       # Document storage directory
   export SSL_CERT=/path/to/cert.pem   # TLS certificate
   export SSL_KEY=/path/to/key.pem     # TLS private key
   ```

3. For monitoring and diagnostics:
   ```bash
   npm run monitor
   ```

#### Docker Deployment

Create a `docker-compose.yml`:

```yaml
version: '3.8'
services:
  shadowlink:
    build: ./server
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - WS_AUTH_TOKEN=your_secure_token
      - YPERSISTENCE=/data
    volumes:
      - ./data:/data
```

Deploy with:
```bash
docker-compose up -d
```

### Client Configuration

1. Open Obsidian Settings → ShadowLink

2. Configure connection settings:
   - **Server URL**: `ws://your-server:port` (or `wss://` for TLS)
   - **Username**: Display name for collaborators
   - **Auth Token**: Match the server's WS_AUTH_TOKEN (if configured)

3. Vault identification will be generated automatically

### Sharing and Collaboration

#### Sharing Your Vault

1. Open ShadowLink settings in Obsidian
2. Copy your Vault ID from the configuration panel
3. Share this ID with collaborators via secure communication

#### Joining a Shared Vault

1. Obtain a Vault ID from the vault owner
2. Open ShadowLink settings
3. Enter the Vault ID in the "Join Vault" field
4. Click "Join" to connect to the shared vault

#### Managing Collaborators

Vault owners can:
- View connected users in real-time
- Monitor connection status and activity
- Remove access to shared vaults when needed

### Connection Verification

To verify your setup is working:

1. Open a note in Obsidian
2. Check the status bar for connection indicator
3. Make edits and verify they appear in real-time for other connected users
4. Test offline functionality by disconnecting and reconnecting

## Usage Guidelines

**File Management**: All standard Obsidian file operations (create, delete, rename, move) are automatically synchronized across collaborators.

**Conflict Resolution**: The system handles conflicts automatically using CRDTs. Manual intervention is only required for structural conflicts (e.g., file deleted on one side, modified on another).

**Performance**: The system includes rate limiting and debouncing to maintain stability during intensive editing sessions.

**Security**: Use TLS encryption and authentication tokens for production deployments. Consider network-level security for sensitive environments.

## Development and Contributing

We encourage community involvement in improving ShadowLink. The project is designed to be extensible and welcomes contributions in several areas:

**Core Development**:
- Performance optimizations
- Feature enhancements
- Bug fixes and stability improvements

**Documentation**:
- Installation guides for specific platforms
- Integration tutorials
- Best practices documentation

**Testing**:
- Cross-platform compatibility testing
- Performance benchmarking
- Security auditing

**Feature Requests**:
- End-to-end encryption implementation
- Advanced permission systems
- Mobile platform support

### Reporting Issues

When reporting bugs or issues:

1. Check existing issues first to avoid duplicates
2. Provide detailed reproduction steps
3. Include system information (OS, Obsidian version, plugin version)
4. Attach relevant log files when possible

Use the [GitHub Issues](https://github.com/Phobetore/ShadowLink/issues) page for all bug reports and feature requests.

### Development Environment

For local development:

1. Fork the repository
2. Create a feature branch
3. Make changes and test thoroughly
4. Submit a pull request with detailed description

The project uses TypeScript and follows standard Node.js development practices. Ensure all tests pass before submitting contributions.

## License

ShadowLink is distributed under the GNU General Public License v3.0 or later. This ensures the project remains open source and that improvements benefit the entire community.

## Support

For technical support and community discussion:

- **Issues**: [GitHub Issues](https://github.com/Phobetore/ShadowLink/issues)
- **Documentation**: Check the repository's documentation files
- **Community**: Engage with other users and developers through GitHub Discussions

Professional support and custom deployment assistance may be available upon request.

