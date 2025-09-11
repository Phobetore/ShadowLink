const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { setupWSConnection, getPersistence } = require('y-websocket/bin/utils');
const ServerMonitor = require('./monitor');
const { SecurityValidator } = require('./security');

const port = process.env.PORT || 1234;
const authToken = process.env.WS_AUTH_TOKEN;
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
const maxConnections = parseInt(process.env.MAX_CONNECTIONS) || 1000;
const enableOriginValidation = process.env.VALIDATE_ORIGIN !== 'false';

if (!process.env.YPERSISTENCE) {
    process.env.YPERSISTENCE = path.join(__dirname, 'yjs_data');
}
const useTls = process.env.SSL_KEY && process.env.SSL_CERT;

// Initialize security validator
const security = new SecurityValidator();

// Server-side vault and session management
class VaultManager {
    constructor() {
        this.vaults = new Map(); // vaultId -> { owner, members, permissions }
        this.sessions = new Map(); // connectionId -> { vaultId, userId, lastActivity, ipAddress }
        this.connectionRateLimits = new Map(); // connectionId -> rate limit data
        this.ipRateLimits = new Map(); // IP -> rate limit data
        this.connectionCount = new Map(); // IP -> connection count
        this.security = security;
    }

    // Enhanced rate limiting with different limits for different operations
    checkRateLimit(identifier, type = 'default') {
        const limits = {
            'default': { maxRequests: 10, windowMs: 1000 },
            'connection': { maxRequests: 5, windowMs: 60000 }, // 5 connections per minute
            'message': { maxRequests: 100, windowMs: 60000 }, // 100 messages per minute
            'auth': { maxRequests: 3, windowMs: 60000 } // 3 auth attempts per minute
        };
        
        const limit = limits[type] || limits['default'];
        const rateLimitMap = type === 'connection' ? this.ipRateLimits : this.connectionRateLimits;
        
        return this.security.checkRateLimit(
            rateLimitMap, 
            identifier, 
            limit.maxRequests, 
            limit.windowMs
        );
    }

    // Check connection limits per IP
    checkConnectionLimit(ipAddress) {
        const currentConnections = this.connectionCount.get(ipAddress) || 0;
        return currentConnections < 50; // Max 50 connections per IP
    }

    incrementConnectionCount(ipAddress) {
        const current = this.connectionCount.get(ipAddress) || 0;
        this.connectionCount.set(ipAddress, current + 1);
    }

    decrementConnectionCount(ipAddress) {
        const current = this.connectionCount.get(ipAddress) || 0;
        if (current > 0) {
            this.connectionCount.set(ipAddress, current - 1);
        }
    }

    registerVault(vaultId, ownerId) {
        const validVaultId = this.security.validateVaultId(vaultId);
        const validOwnerId = this.security.validateUserId(ownerId);
        
        if (!validVaultId || !validOwnerId) {
            return false;
        }
        
        if (!this.vaults.has(validVaultId)) {
            this.vaults.set(validVaultId, {
                owner: validOwnerId,
                members: new Set([validOwnerId]),
                permissions: new Map([[validOwnerId, 'owner']]),
                createdAt: Date.now()
            });
        }
        return true;
    }

    addMember(vaultId, userId, permission = 'member') {
        const validVaultId = this.security.validateVaultId(vaultId);
        const validUserId = this.security.validateUserId(userId);
        
        if (!validVaultId || !validUserId) {
            return false;
        }
        
        const vault = this.vaults.get(validVaultId);
        if (vault) {
            vault.members.add(validUserId);
            vault.permissions.set(validUserId, permission);
            return true;
        }
        return false;
    }

    hasAccess(vaultId, userId) {
        const validVaultId = this.security.validateVaultId(vaultId);
        const validUserId = this.security.validateUserId(userId);
        
        if (!validVaultId || !validUserId) {
            return false;
        }
        
        const vault = this.vaults.get(validVaultId);
        return vault && vault.members.has(validUserId);
    }

    getPermission(vaultId, userId) {
        const validVaultId = this.security.validateVaultId(vaultId);
        const validUserId = this.security.validateUserId(userId);
        
        if (!validVaultId || !validUserId) {
            return null;
        }
        
        const vault = this.vaults.get(validVaultId);
        return vault ? vault.permissions.get(validUserId) : null;
    }

    registerSession(connectionId, vaultId, userId, ipAddress) {
        const validVaultId = this.security.validateVaultId(vaultId);
        const validUserId = this.security.validateUserId(userId);
        
        if (!validVaultId || !validUserId) {
            return false;
        }
        
        this.sessions.set(connectionId, {
            vaultId: validVaultId,
            userId: validUserId,
            lastActivity: Date.now(),
            ipAddress: ipAddress,
            createdAt: Date.now()
        });
        return true;
    }

    cleanupSession(connectionId) {
        const session = this.sessions.get(connectionId);
        if (session && session.ipAddress) {
            this.decrementConnectionCount(session.ipAddress);
        }
        
        this.sessions.delete(connectionId);
        this.connectionRateLimits.delete(connectionId);
    }

    updateActivity(connectionId) {
        const session = this.sessions.get(connectionId);
        if (session) {
            session.lastActivity = Date.now();
        }
    }

    // Cleanup old sessions and rate limit data
    cleanup() {
        const now = Date.now();
        const sessionTimeout = 24 * 60 * 60 * 1000; // 24 hours
        const rateLimitTimeout = 60 * 60 * 1000; // 1 hour
        
        // Clean up old sessions
        for (const [connectionId, session] of this.sessions.entries()) {
            if (now - session.lastActivity > sessionTimeout) {
                this.cleanupSession(connectionId);
            }
        }
        
        // Clean up old rate limit entries
        for (const [id, data] of this.connectionRateLimits.entries()) {
            if (now - data.resetTime > rateLimitTimeout) {
                this.connectionRateLimits.delete(id);
            }
        }
        
        for (const [id, data] of this.ipRateLimits.entries()) {
            if (now - data.resetTime > rateLimitTimeout) {
                this.ipRateLimits.delete(id);
            }
        }
    }
}

const vaultManager = new VaultManager();
const monitor = new ServerMonitor(vaultManager);

// Enable monitoring if MONITOR environment variable is set
const enableMonitoring = process.env.MONITOR !== 'false';

// Cleanup interval for old sessions and rate limits
setInterval(() => {
    vaultManager.cleanup();
}, 5 * 60 * 1000); // Every 5 minutes

// Validate persistence directory
const persistenceDir = process.env.YPERSISTENCE;
if (persistenceDir) {
    const validatedPath = security.validateFilePath(persistenceDir, __dirname);
    if (!validatedPath) {
        console.error('Invalid persistence directory path');
        process.exit(1);
    }
    process.env.YPERSISTENCE = validatedPath;
}

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
    try {
        // Get client IP address
        const clientIP = req.headers['x-forwarded-for'] || 
                        req.headers['x-real-ip'] || 
                        req.connection.remoteAddress || 
                        req.socket.remoteAddress ||
                        'unknown';
        
        // Check connection limit per IP
        if (!vaultManager.checkConnectionLimit(clientIP)) {
            console.warn(`Connection limit exceeded for IP: ${clientIP}`);
            conn.close(1008, 'Too many connections from this IP');
            return;
        }
        
        // Check connection rate limit
        const connectionRateLimit = vaultManager.checkRateLimit(clientIP, 'connection');
        if (!connectionRateLimit.allowed) {
            console.warn(`Connection rate limit exceeded for IP: ${clientIP}`);
            conn.close(1008, `Rate limit exceeded. Retry after ${connectionRateLimit.retryAfter}ms`);
            return;
        }
        
        // Validate Origin header if enabled
        const origin = req.headers.origin;
        if (enableOriginValidation && !security.validateOrigin(origin, allowedOrigins)) {
            console.warn(`Invalid origin: ${origin} from IP: ${clientIP}`);
            conn.close(1008, 'Invalid origin');
            return;
        }
        
        // Parse and validate URL parameters
        const url = new URL(req.url, 'http://localhost');
        const params = security.validateUrlParams(url);
        
        // Validate auth token if required
        const providedToken = req.headers['authorization'] || params.token;
        if (authToken) {
            const authRateLimit = vaultManager.checkRateLimit(clientIP, 'auth');
            if (!authRateLimit.allowed) {
                console.warn(`Auth rate limit exceeded for IP: ${clientIP}`);
                conn.close(1008, `Auth rate limit exceeded. Retry after ${authRateLimit.retryAfter}ms`);
                return;
            }
            
            if (!security.validateToken(providedToken, authToken)) {
                console.warn(`Invalid token from IP: ${clientIP}`);
                conn.close(1008, 'Invalid token');
                return;
            }
        }
        
        // Validate required parameters
        if (!params.vaultId) {
            console.warn(`Invalid vaultId from IP: ${clientIP}`);
            conn.close(1008, 'Invalid vault ID');
            return;
        }
        
        if (!params.userId) {
            console.warn(`Invalid userId from IP: ${clientIP}`);
            conn.close(1008, 'Invalid user ID');
            return;
        }
        
        // Generate secure connection ID
        const connectionId = security.generateSecureId();
        
        // Register vault and session
        if (!vaultManager.registerVault(params.vaultId, params.userId)) {
            console.warn(`Failed to register vault for IP: ${clientIP}`);
            conn.close(1008, 'Invalid vault or user parameters');
            return;
        }
        
        if (!vaultManager.registerSession(connectionId, params.vaultId, params.userId, clientIP)) {
            console.warn(`Failed to register session for IP: ${clientIP}`);
            conn.close(1008, 'Failed to create session');
            return;
        }
        
        // Increment connection count for this IP
        vaultManager.incrementConnectionCount(clientIP);
        
        // Record connection for monitoring
        if (enableMonitoring) {
            monitor.recordConnection(connectionId, params.vaultId, params.userId);
        }
        
        // Store connection metadata for cleanup
        conn.connectionId = connectionId;
        conn.clientIP = clientIP;
        conn.maxMessageSize = security.MAX_MESSAGE_SIZE;
        
        // Wrap the original connection to add security checks
        const originalSend = conn.send;
        conn.send = function(data, options, callback) {
            try {
                // Validate message size
                if (!security.validateMessageSize(data)) {
                    console.warn(`Message too large from connection ${connectionId}`);
                    conn.close(1009, 'Message too large');
                    return;
                }
                
                // Check message rate limit
                const messageRateLimit = vaultManager.checkRateLimit(connectionId, 'message');
                if (!messageRateLimit.allowed) {
                    console.warn(`Message rate limit exceeded for connection ${connectionId}`);
                    if (enableMonitoring) {
                        monitor.recordRateLimitHit();
                    }
                    return;
                }
                
                vaultManager.updateActivity(connectionId);
                if (enableMonitoring) {
                    monitor.recordMessage();
                }
                
                return originalSend.call(this, data, options, callback);
            } catch (error) {
                console.error(`Error sending message: ${security.sanitizeErrorMessage(error.message)}`);
                conn.close(1011, 'Internal error');
            }
        };
        
        // Handle incoming messages with size validation
        conn.on('message', (message) => {
            try {
                if (!security.validateMessageSize(message)) {
                    console.warn(`Received oversized message from connection ${connectionId}`);
                    conn.close(1009, 'Message too large');
                    return;
                }
                
                const messageRateLimit = vaultManager.checkRateLimit(connectionId, 'message');
                if (!messageRateLimit.allowed) {
                    console.warn(`Message rate limit exceeded for connection ${connectionId}`);
                    if (enableMonitoring) {
                        monitor.recordRateLimitHit();
                    }
                    return;
                }
                
                vaultManager.updateActivity(connectionId);
            } catch (error) {
                console.error(`Error processing message: ${security.sanitizeErrorMessage(error.message)}`);
                conn.close(1011, 'Internal error');
            }
        });
        
        conn.on('close', (code, reason) => {
            try {
                vaultManager.cleanupSession(connectionId);
                if (enableMonitoring) {
                    monitor.recordDisconnection(connectionId);
                }
            } catch (error) {
                console.error(`Error during connection cleanup: ${security.sanitizeErrorMessage(error.message)}`);
            }
        });
        
        conn.on('error', (error) => {
            console.error(`WebSocket error for connection ${connectionId}: ${security.sanitizeErrorMessage(error.message)}`);
            try {
                vaultManager.cleanupSession(connectionId);
                if (enableMonitoring) {
                    monitor.recordDisconnection(connectionId);
                }
            } catch (cleanupError) {
                console.error(`Error during error cleanup: ${security.sanitizeErrorMessage(cleanupError.message)}`);
            }
        });
        
        setupWSConnection(conn, req);
        
    } catch (error) {
        console.error(`Connection setup error: ${security.sanitizeErrorMessage(error.message)}`);
        try {
            conn.close(1011, 'Setup error');
        } catch (closeError) {
            // Connection might already be closed
        }
    }
});

server.listen(port, () => {
    const protocol = useTls ? 'wss' : 'ws';
    const persist = getPersistence()
        ? `with persistence at ${process.env.YPERSISTENCE}`
        : 'without persistence';
    console.log(`ShadowLink relay server running on ${protocol}://localhost:${port} ${persist}`);
    console.log('Server features: vault management, rate limiting, session tracking');
    
    // Start monitoring interface if enabled
    if (enableMonitoring) {
        console.log('\nStarting server monitor...');
        setTimeout(() => {
            try {
                monitor.start();
            } catch (error) {
                console.warn('Failed to start terminal interface, falling back to console output:', error.message);
                // Fallback to simple console monitoring
                setInterval(() => {
                    monitor.printConsoleStatus();
                }, 5000);
            }
        }, 1000);
    }
});
