# ShadowLink Security Configuration Guide

This document outlines the security features implemented in ShadowLink and how to configure them properly to prevent common security vulnerabilities.

## Security Features Overview

### 1. Input Validation & Sanitization
- **Vault ID Validation**: Only alphanumeric characters, hyphens, and underscores allowed (max 128 chars)
- **User ID Validation**: Alphanumeric, hyphens, underscores, dots, and @ symbols allowed (max 64 chars)
- **Token Validation**: Constant-time comparison to prevent timing attacks
- **Message Size Limits**: Maximum 1MB per WebSocket message to prevent memory exhaustion
- **File Path Validation**: Prevents directory traversal attacks on persistence paths

### 2. Authentication & Authorization
- **Token-based Authentication**: Optional WS_AUTH_TOKEN environment variable
- **Constant-time Token Comparison**: Prevents timing attack vulnerabilities
- **Session Management**: Secure session tracking with automatic cleanup
- **Origin Validation**: Configurable origin checking to prevent CSRF attacks

### 3. Rate Limiting & DoS Protection
- **Multi-level Rate Limiting**:
  - Connection: 5 connections per minute per IP
  - Messages: 100 messages per minute per connection
  - Authentication: 3 auth attempts per minute per IP
- **Exponential Backoff**: Increasing penalties for repeat violators
- **Connection Limits**: Maximum 50 concurrent connections per IP
- **Automatic Cleanup**: Old sessions and rate limit data are periodically cleaned

### 4. Error Handling & Information Disclosure Prevention
- **Sanitized Error Messages**: Removes sensitive information from error responses
- **Secure Logging**: Prevents sensitive data leakage in logs
- **Graceful Connection Termination**: Proper cleanup on errors and disconnections

## Environment Variables Configuration

### Required Security Settings

```bash
# Authentication token (strongly recommended in production)
WS_AUTH_TOKEN=your-secure-random-token-here

# Enable TLS (required for production)
SSL_CERT=/path/to/your/certificate.pem
SSL_KEY=/path/to/your/private-key.pem

# Allowed origins for CORS (comma-separated)
ALLOWED_ORIGINS=https://your-domain.com,https://app.your-domain.com

# Enable/disable origin validation (default: true)
VALIDATE_ORIGIN=true

# Server port (default: 1234)
PORT=1234

# Persistence directory (optional, will be validated)
YPERSISTENCE=/secure/path/to/yjs_data

# Maximum concurrent connections (default: 1000)
MAX_CONNECTIONS=1000
```

### Optional Security Settings

```bash
# Disable monitoring interface for production
MONITOR=false
```

## Security Best Practices

### 1. Authentication Configuration

**Development Environment:**
```bash
# Minimal security for local development
WS_AUTH_TOKEN=dev-token-123
VALIDATE_ORIGIN=false
```

**Production Environment:**
```bash
# Strong security for production
WS_AUTH_TOKEN=generated-secure-random-token-with-sufficient-entropy
VALIDATE_ORIGIN=true
ALLOWED_ORIGINS=https://yourdomain.com
SSL_CERT=/etc/ssl/certs/your-cert.pem
SSL_KEY=/etc/ssl/private/your-key.pem
```

### 2. Token Generation

Generate secure tokens using cryptographically secure random number generators:

```bash
# Generate a secure token (Linux/macOS)
openssl rand -hex 32

# Or using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. TLS Configuration

Always use TLS in production:
- Use strong cipher suites
- Keep certificates up to date
- Consider using Let's Encrypt for free certificates

### 4. Firewall Configuration

Configure your firewall to:
- Only allow necessary ports (typically 443 for HTTPS/WSS)
- Block direct access to HTTP/WS ports in production
- Use a reverse proxy (nginx, Apache) for additional security layers

### 5. Monitoring and Logging

- Enable server monitoring to detect unusual patterns
- Monitor rate limit violations
- Log authentication failures
- Set up alerts for security events

## Security Checklist

### Pre-deployment Security Checklist

- [ ] **Authentication enabled** with strong token
- [ ] **TLS configured** with valid certificates
- [ ] **Origin validation enabled** with proper allowed origins list
- [ ] **Rate limiting configured** appropriately for your use case
- [ ] **Persistence directory** is secure and properly validated
- [ ] **Firewall rules** are in place
- [ ] **Monitoring enabled** and alerts configured
- [ ] **Security tests passed** (run `node security-test.js`)

### Regular Security Maintenance

- [ ] **Rotate authentication tokens** regularly
- [ ] **Update TLS certificates** before expiration
- [ ] **Review access logs** for suspicious activity
- [ ] **Update dependencies** regularly (`npm audit`)
- [ ] **Monitor rate limit violations** and adjust limits if needed
- [ ] **Review and update allowed origins** as needed

## Common Vulnerabilities Addressed

### 1. Injection Attacks
- **Prevention**: Strict input validation and sanitization
- **Implementation**: All user inputs are validated against secure regex patterns

### 2. Buffer Overflow
- **Prevention**: Message size limits and input length restrictions
- **Implementation**: 1MB message limit, 128-char vault ID limit, 64-char user ID limit

### 3. Denial of Service (DoS)
- **Prevention**: Rate limiting, connection limits, and exponential backoff
- **Implementation**: Multi-tier rate limiting with increasing penalties for violations

### 4. Cross-Site Request Forgery (CSRF)
- **Prevention**: Origin validation and proper authentication
- **Implementation**: Configurable origin whitelist with secure defaults

### 5. Timing Attacks
- **Prevention**: Constant-time token comparison
- **Implementation**: Uses `crypto.timingSafeEqual()` for all token comparisons

### 6. Information Disclosure
- **Prevention**: Error message sanitization and secure logging
- **Implementation**: Removes sensitive data from error messages and logs

### 7. Session Hijacking
- **Prevention**: Secure session management and automatic cleanup
- **Implementation**: Secure random session IDs with automatic expiration

## Testing Security

Run the included security test suite:

```bash
# Start the server first
npm run server

# In another terminal, run security tests
node security-test.js
```

The test suite validates:
- Input validation functions
- Authentication mechanisms
- Rate limiting behavior
- Message size restrictions
- Connection limits

## Security Updates and Patches

This security implementation addresses the following security requirements:
1. ✅ Input validation and sanitization for all user inputs
2. ✅ Protection against buffer overflow attacks
3. ✅ Rate limiting and DoS protection
4. ✅ Secure authentication and session management
5. ✅ Prevention of directory traversal and path injection
6. ✅ Protection against timing attacks
7. ✅ Secure error handling and information disclosure prevention
8. ✅ CSRF protection through origin validation
9. ✅ WebSocket-specific security measures

## Getting Help

If you discover security vulnerabilities:
1. Do NOT open a public issue
2. Contact the maintainers privately
3. Provide detailed information about the vulnerability
4. Allow time for the issue to be addressed before public disclosure

For security configuration questions, check the GitHub Issues page or refer to this documentation.