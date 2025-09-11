# ShadowLink Server Monitoring

This document describes the server-side monitoring system for ShadowLink that provides real-time tracking of connections, vault activity, and server statistics through a beautiful terminal interface.

## Features

🔍 **Real-time Monitoring:**
- Server uptime and status
- Memory usage and process information
- Connection statistics (current/total connections)
- Vault activity tracking (active/inactive vaults)
- Rate limiting statistics
- Message processing metrics

👥 **Session Tracking:**
- Active user sessions with last activity timestamps
- Connection IDs and user identification
- Vault membership tracking
- Session activity indicators

🏦 **Vault Management:**
- Vault ownership and member counts
- Active/inactive vault status
- Real-time session counts per vault
- Vault activity monitoring

🎨 **Beautiful Interface:**
- Terminal-based dashboard using blessed
- Color-coded status indicators
- Real-time updates every 2 seconds
- Interactive controls (refresh, clear history, quit)
- Fallback console output for environments without terminal support

## Usage

### Option 1: Enhanced Server with Monitoring (Recommended)

Start the server with built-in monitoring interface:

```bash
cd server
npm run monitor
```

or

```bash
cd server
node monitor-server.js
```

### Option 2: Regular Server with Monitoring

Enable monitoring on the regular server:

```bash
cd server
MONITOR=true npm start
```

### Option 3: Disable Monitoring

Run without monitoring interface:

```bash
cd server
MONITOR=false npm start
```

## Environment Variables

All standard ShadowLink server environment variables are supported:

- `PORT` - Server port (default: 1234)
- `WS_AUTH_TOKEN` - Authentication token
- `YPERSISTENCE` - Data persistence directory
- `SSL_CERT` / `SSL_KEY` - TLS certificate files
- `MONITOR` - Enable/disable monitoring (default: true)

## Terminal Interface

The monitoring interface consists of several panels:

### Server Status Panel
- Shows online/offline status
- Server uptime
- Start time
- Process ID and memory usage

### Statistics Panel
- Total and current connection counts
- Vault statistics (total/active)
- Rate limiting hits
- Messages processed

### Active Sessions Panel
- Real-time list of connected users
- Connection IDs and user names
- Last activity timestamps
- Activity status indicators (● active, ○ idle)

### Vaults Status Panel
- List of all registered vaults
- Vault ownership information
- Member counts
- Active session counts per vault

### Controls
- `q` - Quit the monitoring interface
- `r` - Refresh display immediately
- `c` - Clear connection history
- `Ctrl+C` - Graceful server shutdown

## Console Fallback

If the terminal interface cannot be initialized (e.g., in headless environments), the system automatically falls back to console output that updates every 5 seconds.

## Integration

The monitoring system integrates seamlessly with the existing server without affecting performance:

- Minimal overhead tracking
- Non-blocking updates
- Graceful degradation
- No impact on WebSocket connections

## Technical Details

### Architecture
- `ServerMonitor` class handles all monitoring logic
- Event-driven updates from VaultManager
- Blessed.js for terminal interface
- Chalk for colored console output
- CLI-table3 for formatted tables

### Data Tracking
- Connection events (connect/disconnect)
- Rate limiting violations
- Message processing counts
- Session activity timestamps
- Vault membership changes

### Performance
- Efficient Map-based data structures
- Circular buffer for connection history (max 100 events)
- 2-second update intervals for real-time feel
- Automatic cleanup of stale data

## Screenshots

The monitoring interface provides a clean, professional dashboard:

```
┌─ Server Status ──────────────┐┌─ Statistics ─────────────────┐
│                              ││                              │
│ Status: ONLINE               ││ Current Connections: 5       │
│ Uptime: 2h 15m 30s          ││ Total Connections: 23        │
│ Started: 11/9/2025, 10:48 AM││ Active Vaults: 3/5           │
│ PID: 3545                    ││ Rate Limit Hits: 2           │
│ Memory: 45MB                 ││ Messages Processed: 1,247    │
│                              ││                              │
└──────────────────────────────┘└──────────────────────────────┘
┌─ Active Sessions ────────────────────────────────────────────┐
│                                                              │
│ ● user1 (abc123) vault-abc - 2s ago                        │
│ ● user2 (def456) vault-abc - 5s ago                        │
│ ○ user3 (ghi789) vault-def - 45s ago                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
┌─ Vaults Status ──────────────────────────────────────────────┐
│                                                              │
│ ● vault-abc (user1, 3 members, 2 active)                   │
│ ● vault-def (user3, 2 members, 1 active)                   │
│ ○ vault-ghi (user5, 1 members, 0 active)                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

This monitoring system provides administrators with comprehensive visibility into their ShadowLink server's operation, making it easy to track usage, diagnose issues, and ensure optimal performance.