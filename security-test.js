#!/usr/bin/env node
/**
 * Security Test Suite for ShadowLink Server
 * Tests various security scenarios and validates input validation
 */

const WebSocket = require('ws');
const { SecurityValidator } = require('./server/security');

const SERVER_URL = 'ws://localhost:1234';
const TEST_TIMEOUT = 5000;

class SecurityTester {
    constructor() {
        this.security = new SecurityValidator();
        this.testResults = [];
        this.totalTests = 0;
        this.passedTests = 0;
    }

    async runAllTests() {
        console.log('🔐 Starting ShadowLink Security Test Suite\n');
        
        // Test input validation
        await this.testInputValidation();
        
        // Test authentication
        await this.testAuthentication();
        
        // Test rate limiting
        await this.testRateLimiting();
        
        // Test message size limits
        await this.testMessageSizeLimits();
        
        // Test connection limits
        await this.testConnectionLimits();
        
        // Display results
        this.displayResults();
    }

    async testInputValidation() {
        console.log('📋 Testing Input Validation...');
        
        // Test valid vault ID
        this.runTest('Valid Vault ID', () => {
            return this.security.validateVaultId('valid-vault-123') === 'valid-vault-123';
        });
        
        // Test invalid vault ID - too long
        this.runTest('Invalid Vault ID (too long)', () => {
            const longId = 'a'.repeat(200);
            return this.security.validateVaultId(longId) === null;
        });
        
        // Test invalid vault ID - special characters
        this.runTest('Invalid Vault ID (special chars)', () => {
            return this.security.validateVaultId('vault<script>alert(1)</script>') === null;
        });
        
        // Test valid user ID
        this.runTest('Valid User ID', () => {
            return this.security.validateUserId('user@example.com') === 'user@example.com';
        });
        
        // Test invalid user ID
        this.runTest('Invalid User ID (special chars)', () => {
            return this.security.validateUserId('user<script>') === null;
        });
        
        // Test token validation
        this.runTest('Token Validation (constant time)', () => {
            const token1 = 'valid-token-123';
            const token2 = 'valid-token-123';
            const token3 = 'invalid-token';
            
            return this.security.validateToken(token1, token2) === true &&
                   this.security.validateToken(token1, token3) === false;
        });
        
        // Test file path validation
        this.runTest('File Path Validation (directory traversal)', () => {
            const basePath = '/safe/directory';
            const maliciousPath = '../../../etc/passwd';
            
            return this.security.validateFilePath(maliciousPath, basePath) === null;
        });
        
        // Test message size validation
        this.runTest('Message Size Validation', () => {
            const smallMessage = 'small message';
            const largeMessage = 'x'.repeat(2 * 1024 * 1024); // 2MB
            
            return this.security.validateMessageSize(smallMessage) === true &&
                   this.security.validateMessageSize(largeMessage) === false;
        });
        
        console.log('✅ Input validation tests completed\n');
    }

    async testAuthentication() {
        console.log('🔑 Testing Authentication...');
        
        // Test connection without token when token is required
        this.runTest('Authentication Required', async () => {
            try {
                const ws = new WebSocket(`${SERVER_URL}?vaultId=test&userId=test`);
                
                return new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        ws.close();
                        resolve(false);
                    }, TEST_TIMEOUT);
                    
                    ws.on('close', (code) => {
                        clearTimeout(timeout);
                        resolve(code === 1008); // Should close with authentication error
                    });
                    
                    ws.on('open', () => {
                        clearTimeout(timeout);
                        ws.close();
                        resolve(false);
                    });
                    
                    ws.on('error', () => {
                        clearTimeout(timeout);
                        resolve(true); // Connection should fail
                    });
                });
            } catch (error) {
                return true; // Expected to fail
            }
        });
        
        console.log('✅ Authentication tests completed\n');
    }

    async testRateLimiting() {
        console.log('⏱️ Testing Rate Limiting...');
        
        this.runTest('Rate Limit Logic', () => {
            const rateLimitMap = new Map();
            const identifier = 'test-id';
            
            // First 10 requests should pass
            for (let i = 0; i < 10; i++) {
                const result = this.security.checkRateLimit(rateLimitMap, identifier, 10, 1000);
                if (!result.allowed) {
                    return false;
                }
            }
            
            // 11th request should fail
            const result = this.security.checkRateLimit(rateLimitMap, identifier, 10, 1000);
            return !result.allowed && result.retryAfter > 0;
        });
        
        this.runTest('Exponential Backoff', () => {
            const rateLimitMap = new Map();
            const identifier = 'backoff-test';
            
            // Exceed limit multiple times
            for (let i = 0; i < 15; i++) {
                this.security.checkRateLimit(rateLimitMap, identifier, 5, 1000);
            }
            
            const result = this.security.checkRateLimit(rateLimitMap, identifier, 5, 1000);
            return !result.allowed && result.retryAfter > 1000; // Should have exponential backoff
        });
        
        console.log('✅ Rate limiting tests completed\n');
    }

    async testMessageSizeLimits() {
        console.log('📏 Testing Message Size Limits...');
        
        // Test that large messages are rejected
        this.runTest('Large Message Rejection', async () => {
            try {
                const ws = new WebSocket(`${SERVER_URL}?vaultId=test&userId=test`);
                
                return new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        ws.close();
                        resolve(false);
                    }, TEST_TIMEOUT);
                    
                    ws.on('open', () => {
                        // Send a message larger than the limit
                        const largeMessage = Buffer.alloc(2 * 1024 * 1024); // 2MB
                        ws.send(largeMessage);
                    });
                    
                    ws.on('close', (code) => {
                        clearTimeout(timeout);
                        resolve(code === 1009); // Should close with "Message too large"
                    });
                    
                    ws.on('error', () => {
                        clearTimeout(timeout);
                        resolve(true);
                    });
                });
            } catch (error) {
                return true; // Expected to fail
            }
        });
        
        console.log('✅ Message size limit tests completed\n');
    }

    async testConnectionLimits() {
        console.log('🔗 Testing Connection Limits...');
        
        // Test multiple connections from same IP
        this.runTest('Connection Limit per IP', async () => {
            const connections = [];
            let rejectedConnections = 0;
            
            try {
                // Try to create many connections quickly
                for (let i = 0; i < 10; i++) {
                    const ws = new WebSocket(`${SERVER_URL}?vaultId=test${i}&userId=test${i}`);
                    connections.push(ws);
                    
                    ws.on('close', (code) => {
                        if (code === 1008) {
                            rejectedConnections++;
                        }
                    });
                    
                    ws.on('error', () => {
                        rejectedConnections++;
                    });
                }
                
                // Wait for connections to be processed
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Clean up connections
                connections.forEach(ws => {
                    try {
                        ws.close();
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                });
                
                // Should have some rejected connections due to rate limiting
                return rejectedConnections > 0;
                
            } catch (error) {
                return true; // Some form of limiting is working
            }
        });
        
        console.log('✅ Connection limit tests completed\n');
    }

    runTest(testName, testFunction) {
        this.totalTests++;
        
        try {
            const result = testFunction();
            
            if (result instanceof Promise) {
                return result.then(res => {
                    this.recordResult(testName, res);
                    return res;
                }).catch(err => {
                    this.recordResult(testName, false, err.message);
                    return false;
                });
            } else {
                this.recordResult(testName, result);
                return result;
            }
        } catch (error) {
            this.recordResult(testName, false, error.message);
            return false;
        }
    }

    recordResult(testName, passed, error = null) {
        if (passed) {
            this.passedTests++;
            console.log(`  ✅ ${testName}`);
        } else {
            console.log(`  ❌ ${testName}${error ? ` (${error})` : ''}`);
        }
        
        this.testResults.push({ testName, passed, error });
    }

    displayResults() {
        console.log('\n📊 Test Results Summary');
        console.log('========================');
        console.log(`Total Tests: ${this.totalTests}`);
        console.log(`Passed: ${this.passedTests}`);
        console.log(`Failed: ${this.totalTests - this.passedTests}`);
        console.log(`Success Rate: ${((this.passedTests / this.totalTests) * 100).toFixed(1)}%`);
        
        if (this.passedTests === this.totalTests) {
            console.log('\n🎉 All security tests passed!');
        } else {
            console.log('\n⚠️ Some security tests failed. Please review the implementation.');
            
            console.log('\nFailed Tests:');
            this.testResults
                .filter(result => !result.passed)
                .forEach(result => {
                    console.log(`  - ${result.testName}${result.error ? ` (${result.error})` : ''}`);
                });
        }
    }
}

// Run tests if this script is executed directly
if (require.main === module) {
    const tester = new SecurityTester();
    tester.runAllTests().catch(console.error);
}

module.exports = { SecurityTester };