/**
 * Security utilities for ShadowLink server
 * Provides input validation, sanitization, and security hardening functions
 */

const crypto = require('crypto');
const path = require('path');

class SecurityValidator {
    constructor() {
        // Maximum lengths to prevent buffer overflows
        this.MAX_VAULT_ID_LENGTH = 128;
        this.MAX_USER_ID_LENGTH = 64;
        this.MAX_TOKEN_LENGTH = 256;
        this.MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB max message size
        this.MAX_PATH_LENGTH = 4096;
        
        // Regular expressions for validation
        this.VAULT_ID_REGEX = /^[a-zA-Z0-9\-_]{1,128}$/;
        this.USER_ID_REGEX = /^[a-zA-Z0-9\-_\.@]{1,64}$/;
        this.TOKEN_REGEX = /^[a-zA-Z0-9\-_\.]{1,256}$/;
        this.SAFE_PATH_REGEX = /^[a-zA-Z0-9\-_\/\.]{1,4096}$/;
    }

    /**
     * Validates and sanitizes vault ID
     * @param {string} vaultId - The vault ID to validate
     * @returns {string|null} - Sanitized vault ID or null if invalid
     */
    validateVaultId(vaultId) {
        if (!vaultId || typeof vaultId !== 'string') {
            return null;
        }
        
        // Check length
        if (vaultId.length > this.MAX_VAULT_ID_LENGTH) {
            return null;
        }
        
        // Check format - only alphanumeric, hyphens, and underscores
        if (!this.VAULT_ID_REGEX.test(vaultId)) {
            return null;
        }
        
        // Sanitize by trimming and removing any potentially dangerous characters
        return vaultId.trim().replace(/[^a-zA-Z0-9\-_]/g, '');
    }

    /**
     * Validates and sanitizes user ID
     * @param {string} userId - The user ID to validate
     * @returns {string|null} - Sanitized user ID or null if invalid
     */
    validateUserId(userId) {
        if (!userId || typeof userId !== 'string') {
            return 'anonymous'; // Default fallback
        }
        
        // Check length
        if (userId.length > this.MAX_USER_ID_LENGTH) {
            return null;
        }
        
        // Check format - alphanumeric, hyphens, underscores, dots, and @ symbols
        if (!this.USER_ID_REGEX.test(userId)) {
            return null;
        }
        
        // Sanitize
        return userId.trim().replace(/[^a-zA-Z0-9\-_\.@]/g, '');
    }

    /**
     * Validates authentication token using constant-time comparison
     * @param {string} providedToken - Token provided by client
     * @param {string} expectedToken - Expected token from server
     * @returns {boolean} - True if tokens match
     */
    validateToken(providedToken, expectedToken) {
        if (!providedToken || !expectedToken || 
            typeof providedToken !== 'string' || 
            typeof expectedToken !== 'string') {
            return false;
        }
        
        // Check length limits
        if (providedToken.length > this.MAX_TOKEN_LENGTH || 
            expectedToken.length > this.MAX_TOKEN_LENGTH) {
            return false;
        }
        
        // Check format
        if (!this.TOKEN_REGEX.test(providedToken) || 
            !this.TOKEN_REGEX.test(expectedToken)) {
            return false;
        }
        
        // Pad tokens to same length for constant-time comparison
        const maxLength = Math.max(providedToken.length, expectedToken.length);
        const paddedProvided = providedToken.padEnd(maxLength, '\0');
        const paddedExpected = expectedToken.padEnd(maxLength, '\0');
        
        try {
            // Constant-time comparison to prevent timing attacks
            return crypto.timingSafeEqual(
                Buffer.from(paddedProvided, 'utf8'),
                Buffer.from(paddedExpected, 'utf8')
            );
        } catch (error) {
            return false;
        }
    }

    /**
     * Validates WebSocket message size
     * @param {Buffer|string} message - The message to validate
     * @returns {boolean} - True if message size is acceptable
     */
    validateMessageSize(message) {
        if (!message) return true;
        
        const size = Buffer.isBuffer(message) ? message.length : Buffer.byteLength(message, 'utf8');
        return size <= this.MAX_MESSAGE_SIZE;
    }

    /**
     * Validates and sanitizes file paths to prevent directory traversal
     * @param {string} filePath - The file path to validate
     * @param {string} basePath - The base directory path
     * @returns {string|null} - Sanitized path or null if invalid
     */
    validateFilePath(filePath, basePath) {
        if (!filePath || typeof filePath !== 'string' || 
            !basePath || typeof basePath !== 'string') {
            return null;
        }
        
        // Check length
        if (filePath.length > this.MAX_PATH_LENGTH) {
            return null;
        }
        
        // Basic format check
        if (!this.SAFE_PATH_REGEX.test(filePath)) {
            return null;
        }
        
        try {
            // Resolve the path and ensure it's within the base directory
            const resolvedPath = path.resolve(basePath, filePath);
            const resolvedBase = path.resolve(basePath);
            
            // Check if the resolved path is within the base directory
            if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
                return null;
            }
            
            return resolvedPath;
        } catch (error) {
            return null;
        }
    }

    /**
     * Validates URL parameters from WebSocket request
     * @param {URL} url - The URL object to validate
     * @returns {Object} - Object with validated parameters
     */
    validateUrlParams(url) {
        const params = {
            vaultId: null,
            userId: null,
            token: null
        };
        
        if (!url) return params;
        
        // Validate vaultId
        const vaultId = url.searchParams.get('vaultId');
        params.vaultId = this.validateVaultId(vaultId);
        
        // Validate userId
        const userId = url.searchParams.get('userId');
        params.userId = this.validateUserId(userId);
        
        // Validate token
        const token = url.searchParams.get('token');
        if (token && typeof token === 'string' && token.length <= this.MAX_TOKEN_LENGTH) {
            params.token = token.trim();
        }
        
        return params;
    }

    /**
     * Sanitizes error messages to prevent information disclosure
     * @param {string} errorMessage - The original error message
     * @returns {string} - Sanitized error message
     */
    sanitizeErrorMessage(errorMessage) {
        if (!errorMessage || typeof errorMessage !== 'string') {
            return 'An error occurred';
        }
        
        // Remove potentially sensitive information
        const sanitized = errorMessage
            .replace(/\/[a-zA-Z0-9\/\-_\.]+/g, '[PATH]') // Remove file paths
            .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]') // Remove IP addresses
            .replace(/[a-zA-Z0-9\-_]{20,}/g, '[TOKEN]') // Remove long tokens/hashes
            .substring(0, 200); // Limit length
        
        return sanitized || 'An error occurred';
    }

    /**
     * Validates WebSocket origin to prevent CSRF attacks
     * @param {string} origin - The origin header value
     * @param {Array<string>} allowedOrigins - List of allowed origins
     * @returns {boolean} - True if origin is allowed
     */
    validateOrigin(origin, allowedOrigins = []) {
        if (!origin || typeof origin !== 'string') {
            return false;
        }
        
        // If no allowed origins specified, allow localhost for development
        if (allowedOrigins.length === 0) {
            return origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) !== null;
        }
        
        return allowedOrigins.includes(origin);
    }

    /**
     * Generates a secure random connection ID
     * @returns {string} - Secure random ID
     */
    generateSecureId() {
        return crypto.randomBytes(16).toString('hex');
    }

    /**
     * Rate limiting with exponential backoff
     * @param {Map} rateLimitMap - Map to store rate limit data
     * @param {string} identifier - Unique identifier (IP, connection ID, etc.)
     * @param {number} maxRequests - Maximum requests allowed
     * @param {number} windowMs - Time window in milliseconds
     * @returns {Object} - Rate limit result with allowed flag and retry after
     */
    checkRateLimit(rateLimitMap, identifier, maxRequests = 10, windowMs = 1000) {
        const now = Date.now();
        const record = rateLimitMap.get(identifier) || {
            count: 0,
            resetTime: now + windowMs,
            violations: 0
        };
        
        // Reset window if expired
        if (now >= record.resetTime) {
            record.count = 0;
            record.resetTime = now + windowMs;
            // Reduce violations gradually
            record.violations = Math.max(0, record.violations - 1);
        }
        
        // Check if limit exceeded
        if (record.count >= maxRequests) {
            record.violations++;
            
            // Exponential backoff for repeat violators
            const backoffMultiplier = Math.min(Math.pow(2, record.violations), 32);
            const retryAfter = windowMs * backoffMultiplier;
            
            rateLimitMap.set(identifier, record);
            
            return {
                allowed: false,
                retryAfter: retryAfter,
                violations: record.violations
            };
        }
        
        record.count++;
        rateLimitMap.set(identifier, record);
        
        return {
            allowed: true,
            remaining: maxRequests - record.count,
            resetTime: record.resetTime
        };
    }
}

module.exports = { SecurityValidator };