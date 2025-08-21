const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { setupWSConnection, getPersistence } = require('y-websocket/bin/utils');

const port = process.env.PORT || 1234;
const authToken = process.env.WS_AUTH_TOKEN;
if (!process.env.YPERSISTENCE) {
    process.env.YPERSISTENCE = path.join(__dirname, 'yjs_data');
}

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
const server = http.createServer();
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
    }

    // Wrap the original connection to add rate limiting
    const originalSend = conn.send;
    conn.send = function(...args) {
        if (!vaultManager.checkRateLimit(connectionId)) {
            console.warn(`Rate limit exceeded for connection ${connectionId}`);
            return;
        }
        vaultManager.updateActivity(connectionId);
        return originalSend.apply(this, args);
    };

    conn.on('close', () => {
        vaultManager.cleanupSession(connectionId);
    });

    setupWSConnection(conn, req);
});

server.listen(port, () => {
    const persist = getPersistence() ? `with persistence at ${process.env.YPERSISTENCE}` : 'without persistence';
    console.log(`ShadowLink relay server running on ws://localhost:${port} ${persist}`);
    console.log('Server features: vault management, rate limiting, session tracking');
});
