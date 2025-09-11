#!/usr/bin/env node

/**
 * ShadowLink Server with integrated monitoring interface
 * Usage: node monitor-server.js
 * Environment variables:
 * - PORT: Server port (default: 1234)
 * - WS_AUTH_TOKEN: Authentication token
 * - YPERSISTENCE: Data persistence directory
 * - SSL_CERT, SSL_KEY: TLS certificate files
 * - MONITOR: Enable/disable monitoring (default: true)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { setupWSConnection, getPersistence } = require('y-websocket/bin/utils');
const ServerMonitor = require('./monitor');

const port = process.env.PORT || 1234;
const authToken = process.env.WS_AUTH_TOKEN;
if (!process.env.YPERSISTENCE) {
    process.env.YPERSISTENCE = path.join(__dirname, 'yjs_data');
}
const useTls = process.env.SSL_KEY && process.env.SSL_CERT;

// Server-side vault and session management
class VaultManager {
    constructor() {
        this.vaults = new Map(); // vaultId -> { owner, members, permissions }
        this.sessions = new Map(); // connectionId -> { vaultId, userId, lastActivity }
        this.connectionRateLimits = new Map(); // connectionId -> { count, lastReset }
    }

    // Rate limiting: max 10 operations per second per connection
    checkRateLimit(connectionId) {
        const now = Date.now();
        const limit = this.connectionRateLimits.get(connectionId);
        
        if (!limit || now - limit.lastReset > 1000) {
            this.connectionRateLimits.set(connectionId, { count: 1, lastReset: now });
            return true;
        }
        
        if (limit.count >= 10) {
            return false;
        }
        
        limit.count++;
        return true;
    }

    registerVault(vaultId, ownerId) {
        if (!this.vaults.has(vaultId)) {
            this.vaults.set(vaultId, {
                owner: ownerId,
                members: new Set([ownerId]),
                permissions: new Map([[ownerId, 'owner']])
            });
        }
    }

    addMember(vaultId, userId, permission = 'member') {
        const vault = this.vaults.get(vaultId);
        if (vault) {
            vault.members.add(userId);
            vault.permissions.set(userId, permission);
        }
    }

    hasAccess(vaultId, userId) {
        const vault = this.vaults.get(vaultId);
        return vault && vault.members.has(userId);
    }

    getPermission(vaultId, userId) {
        const vault = this.vaults.get(vaultId);
        return vault ? vault.permissions.get(userId) : null;
    }

    registerSession(connectionId, vaultId, userId) {
        this.sessions.set(connectionId, {
            vaultId,
            userId,
            lastActivity: Date.now()
        });
    }

    cleanupSession(connectionId) {
        this.sessions.delete(connectionId);
        this.connectionRateLimits.delete(connectionId);
    }

    updateActivity(connectionId) {
        const session = this.sessions.get(connectionId);
        if (session) {
            session.lastActivity = Date.now();
        }
    }
}

const vaultManager = new VaultManager();
const monitor = new ServerMonitor(vaultManager);

// Enable monitoring by default, disable with MONITOR=false
const enableMonitoring = process.env.MONITOR !== 'false';

let server;
if (useTls) {
    const options = {
        key: fs.readFileSync(process.env.SSL_KEY),
        cert: fs.readFileSync(process.env.SSL_CERT)
    };
    server = https.createServer(options);
} else {
    server = http.createServer();
}

const wss = new WebSocket.Server({ server });

wss.on('connection', (conn, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = req.headers['authorization'] || url.searchParams.get('token');
    const vaultId = url.searchParams.get('vaultId');
    const userId = url.searchParams.get('userId') || 'anonymous';
    
    if (authToken && token !== authToken) {
        conn.close(1008, 'Invalid token');
        return;
    }

    // Generate connection ID for rate limiting
    const connectionId = Math.random().toString(36).substring(7);
    
    // Register vault and session
    if (vaultId) {
        vaultManager.registerVault(vaultId, userId);
        vaultManager.registerSession(connectionId, vaultId, userId);
        
        // Record connection for monitoring
        if (enableMonitoring) {
            monitor.recordConnection(connectionId, vaultId, userId);
        }
    }

    // Wrap the original connection to add rate limiting
    const originalSend = conn.send;
    conn.send = function(...args) {
        if (!vaultManager.checkRateLimit(connectionId)) {
            console.warn(`Rate limit exceeded for connection ${connectionId}`);
            if (enableMonitoring) {
                monitor.recordRateLimitHit();
            }
            return;
        }
        vaultManager.updateActivity(connectionId);
        if (enableMonitoring) {
            monitor.recordMessage();
        }
        return originalSend.apply(this, args);
    };

    conn.on('close', () => {
        vaultManager.cleanupSession(connectionId);
        if (enableMonitoring) {
            monitor.recordDisconnection(connectionId);
        }
    });

    setupWSConnection(conn, req);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\nShutting down server...');
    if (enableMonitoring) {
        monitor.stop();
    }
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n\nShutting down server...');
    if (enableMonitoring) {
        monitor.stop();
    }
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});

server.listen(port, () => {
    const protocol = useTls ? 'wss' : 'ws';
    const persist = getPersistence()
        ? `with persistence at ${process.env.YPERSISTENCE}`
        : 'without persistence';
    
    console.log(`\n🚀 ShadowLink relay server starting...`);
    console.log(`📡 Server: ${protocol}://localhost:${port}`);
    console.log(`💾 Storage: ${persist}`);
    console.log(`🔐 Auth: ${authToken ? 'enabled' : 'disabled'}`);
    console.log(`📊 Monitoring: ${enableMonitoring ? 'enabled' : 'disabled'}`);
    console.log(`✨ Features: vault management, rate limiting, session tracking`);
    
    // Start monitoring interface if enabled
    if (enableMonitoring) {
        console.log('\n📈 Starting server monitor in 2 seconds...');
        console.log('💡 Use MONITOR=false to disable monitoring interface');
        
        setTimeout(() => {
            try {
                monitor.start();
            } catch (error) {
                console.warn('\n⚠️  Failed to start terminal interface, falling back to console output:', error.message);
                console.log('📝 Console monitoring will update every 5 seconds. Press Ctrl+C to exit.\n');
                
                // Fallback to simple console monitoring
                setInterval(() => {
                    monitor.printConsoleStatus();
                }, 5000);
            }
        }, 2000);
    } else {
        console.log('\n✅ Server ready! Press Ctrl+C to stop.');
    }
});