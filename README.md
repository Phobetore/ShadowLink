# ShadowLink

Real-time collaborative editing plugin for Obsidian using conflict-free document synchronization.

## Project Overview

ShadowLink transforms Obsidian into a collaborative knowledge management platform by enabling multiple users to simultaneously edit notes with real-time synchronization. This open-source solution provides an alternative to expensive proprietary collaboration services while maintaining complete control over your data.

## ⚠️ Current Project Status

**ShadowLink is currently in active development with significant improvements made but several issues still being addressed:**

### ✅ Recently Fixed Issues
- **Cross-document user visibility**: Users can now see each other across different documents
- **Ghost cursor elimination**: Proper cleanup when switching documents
- **Initial sync problems**: No longer requires restarting Obsidian clients
- **Content persistence**: Written content no longer disappears when navigating between notes
- **Basic real-time collaboration**: Core synchronization functionality is working

### 🚧 Known Issues Still Being Fixed
- **Synchronization bugs**: Multiple synchronization edge cases and race conditions remain
- **Live edit stability**: Intermittent issues with live editing consistency between clients
- **Connection reliability**: Occasional connection drops and recovery issues
- **Performance optimization**: System performance with multiple concurrent users needs improvement

### 🧪 Testing Requirements
- **Load testing**: Comprehensive testing with many simultaneous users is still needed
- **Stress testing**: Performance validation under heavy usage scenarios
- **Edge case testing**: Various network conditions and failure scenarios
- **Multi-client testing**: Extensive testing with numerous connected clients

**Note**: While the core functionality works, the plugin is not yet production-ready for critical workflows. Users should expect occasional synchronization issues and should backup their work regularly.

## Development Roadmap

### Immediate Priorities

1. **Synchronization Bug Fixes**
   - Resolve remaining CRDT conflict resolution edge cases
   - Fix intermittent sync failures during rapid edits
   - Improve handling of concurrent file operations
   - Address race conditions in document switching

2. **Live Edit Improvements**
   - Stabilize real-time cursor positioning
   - Fix text insertion/deletion conflicts
   - Improve undo/redo synchronization
   - Enhance conflict resolution for simultaneous edits

3. **Load Testing & Performance**
   - Test with 10+ simultaneous users
   - Validate performance with large documents (>10MB)
   - Stress test file operations with multiple clients
   - Benchmark memory usage and connection stability
   - Test network failure recovery scenarios

### Upcoming Features

- **Enhanced security and authentication**
- **File permission management**
- **Better offline synchronization**
- **Mobile client support**
- **Integration with Obsidian Publish**

### Testing Requirements

Before production use, the following testing scenarios must be completed:

- [ ] **Multi-user stress testing** (20+ concurrent users)
- [ ] **Large vault synchronization** (1000+ files)
- [ ] **Network instability testing** (connection drops, slow networks)
- [ ] **Cross-platform compatibility** (Windows, macOS, Linux)
- [ ] **Extended session testing** (24+ hour continuous use)
- [ ] **Data integrity validation** (no data loss under any conditions)

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

### Currently Working ✅

**Basic Real-time Synchronization**
- Document changes propagate across connected clients
- Automatic conflict resolution using Yjs CRDTs (basic scenarios)
- Cross-document user visibility and presence tracking

**Offline Capability** 
- Local changes stored when disconnected
- Automatic synchronization when connection is restored
- Basic conflict resolution for offline modifications

**Vault Collaboration**
- Share entire vaults with team members
- Basic session management
- Support for multiple concurrent vaults

### Partially Working ⚠️

**Advanced Synchronization**
- Complex conflict resolution has edge cases
- Large file synchronization may be incomplete
- Rapid concurrent edits can cause inconsistencies

**Live Editing**
- Real-time cursors work but may occasionally desync
- Text insertion conflicts under heavy load
- Undo/redo synchronization is inconsistent

**Connection Management**
- Automatic reconnection works in most cases
- Some network conditions cause persistent disconnections
- Server connection pooling needs optimization

### Robust Architecture
- Rate limiting to prevent abuse
- Security validation and authentication
- Protection against rapid file switching
- Comprehensive error handling and recovery

## Installation and Setup

### ⚠️ Development Version Warning

**This is a development version with known bugs. Please:**
- **Backup your vault** before testing
- Use on **non-critical vaults** only
- Expect **synchronization issues** and **data conflicts**
- Report bugs through [GitHub Issues](https://github.com/Phobetore/ShadowLink/issues)

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

### Current Limitations ⚠️

**Recommended Usage:**
- **Small teams** (2-3 users maximum for stable experience)
- **Small to medium vaults** (<500 files recommended)
- **Non-critical workflows** (always backup important work)
- **Testing and development** environments

**File Management**: Most standard Obsidian file operations are synchronized, but edge cases may cause inconsistencies.

**Conflict Resolution**: The system handles basic conflicts automatically, but complex scenarios may require manual intervention.

**Performance**: Rate limiting and debouncing help maintain stability, but performance degrades with multiple heavy users.

**Security**: Use TLS encryption and authentication tokens for any networked deployment. The current security model is basic.

### Best Practices for Current Version

1. **Start small**: Begin with 2 users before scaling up
2. **Backup regularly**: Sync bugs can occasionally cause data issues  
3. **Monitor connections**: Watch for disconnect warnings in the status bar
4. **Avoid rapid edits**: Wait for changes to sync before making more edits
5. **Test thoroughly**: Validate sync is working before important sessions
6. **Keep sessions short**: Restart Obsidian if issues occur

### Production Readiness

**ShadowLink is NOT recommended for production use** until the following issues are resolved:
- Synchronization stability under load
- Data integrity guarantees  
- Comprehensive testing with many users
- Performance optimization
- Enhanced error recovery

### Reporting Issues

When reporting bugs or issues:

1. Check existing issues first to avoid duplicates
2. Provide detailed reproduction steps
3. Include system information (OS, Obsidian version, plugin version)
4. Attach relevant log files when possible

Use the [GitHub Issues](https://github.com/Phobetore/ShadowLink/issues) page for all bug reports and feature requests.

### Known Issues & Workarounds

**Synchronization Problems:**
- If sync breaks, try disconnecting and reconnecting all clients
- For persistent issues, restart Obsidian on all clients
- Large files (>1MB) may sync slowly or incompletely

**Live Edit Issues:**
- Cursors may occasionally become misaligned
- Rapid typing can cause text conflicts
- Undo/redo operations may not sync properly

**Connection Issues:**
- Plugin may not reconnect automatically after network changes
- Server connection timeout may occur with poor network conditions
- Multiple vault sharing may cause connection instability

**Performance Issues:**
- Memory usage increases with session length
- Large vaults (500+ files) may experience slow initial sync
- Multiple concurrent users may cause server overload

### Development Environment

For local development:

1. Fork the repository
2. Create a feature branch
3. Make changes and test thoroughly
4. Submit a pull request with detailed description

The project uses TypeScript and follows standard Node.js development practices. Ensure all tests pass before submitting contributions.

## Testing & Quality Assurance

### Current Testing Status

**Completed Tests:**
- ✅ Basic two-client synchronization
- ✅ User awareness and presence tracking  
- ✅ Document switching without ghost cursors
- ✅ Basic conflict resolution
- ✅ Offline operation and reconnection

**Tests in Progress:**
- 🔄 Multi-user scenarios (3-5 users)
- 🔄 Large document handling
- 🔄 Extended session stability
- 🔄 Network failure recovery

**Tests Required:**
- ❌ **High-load testing** (10+ simultaneous users)
- ❌ **Stress testing** with rapid edits
- ❌ **Large vault synchronization** (1000+ files)
- ❌ **Cross-platform compatibility** testing
- ❌ **Data integrity** under extreme conditions
- ❌ **Memory leak** and performance regression testing
- ❌ **Security** and access control validation

### Running Tests

Basic collaboration test:
```bash
node test-collaboration.js
```

Security validation:
```bash
node security-test.js
```

**Note:** Comprehensive test suite is under development. Current tests cover basic functionality only.

### Testing Contributions

The project welcomes testing contributions, especially:
- **Load testing scripts** for many users
- **Performance benchmarks** 
- **Edge case testing scenarios**
- **Cross-platform validation**
- **Data integrity verification**

## License

ShadowLink is distributed under the GNU General Public License v3.0 or later. This ensures the project remains open source and that improvements benefit the entire community.

