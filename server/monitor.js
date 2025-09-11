const blessed = require('blessed');
const Table = require('cli-table3');

// Handle chalk import for different versions
let chalk;
try {
    chalk = require('chalk');
    // Test if it's the newer ESM version
    if (typeof chalk.cyan !== 'function') {
        chalk = chalk.default || chalk;
    }
} catch (error) {
    // Fallback to simple colors if chalk fails
    chalk = {
        cyan: (text) => `\x1b[36m${text}\x1b[0m`,
        green: (text) => `\x1b[32m${text}\x1b[0m`,
        yellow: (text) => `\x1b[33m${text}\x1b[0m`,
        red: (text) => `\x1b[31m${text}\x1b[0m`,
        blue: (text) => `\x1b[34m${text}\x1b[0m`,
        magenta: (text) => `\x1b[35m${text}\x1b[0m`,
        gray: (text) => `\x1b[90m${text}\x1b[0m`,
        bold: (text) => `\x1b[1m${text}\x1b[0m`
    };
}

class ServerMonitor {
    constructor(vaultManager) {
        this.vaultManager = vaultManager;
        this.startTime = Date.now();
        this.connectionHistory = [];
        this.screen = null;
        this.updateInterval = null;
        this.isRunning = false;
        
        // Statistics
        this.stats = {
            totalConnections: 0,
            currentConnections: 0,
            totalVaults: 0,
            activeVaults: 0,
            rateLimitHits: 0,
            messagesProcessed: 0
        };
    }

    // Record connection events
    recordConnection(connectionId, vaultId, userId) {
        this.stats.totalConnections++;
        this.stats.currentConnections++;
        this.connectionHistory.push({
            type: 'connect',
            connectionId,
            vaultId,
            userId,
            timestamp: new Date().toISOString()
        });
        
        // Keep only last 100 events
        if (this.connectionHistory.length > 100) {
            this.connectionHistory = this.connectionHistory.slice(-100);
        }
    }

    recordDisconnection(connectionId) {
        this.stats.currentConnections = Math.max(0, this.stats.currentConnections - 1);
        this.connectionHistory.push({
            type: 'disconnect',
            connectionId,
            timestamp: new Date().toISOString()
        });
    }

    recordRateLimitHit() {
        this.stats.rateLimitHits++;
    }

    recordMessage() {
        this.stats.messagesProcessed++;
    }

    // Get server status
    getServerStatus() {
        const uptime = Date.now() - this.startTime;
        const uptimeSeconds = Math.floor(uptime / 1000);
        const hours = Math.floor(uptimeSeconds / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const seconds = uptimeSeconds % 60;

        return {
            status: 'online',
            uptime: `${hours}h ${minutes}m ${seconds}s`,
            uptimeMs: uptime,
            startTime: new Date(this.startTime).toISOString()
        };
    }

    // Get active sessions
    getActiveSessions() {
        const sessions = [];
        const now = Date.now();
        
        for (const [connectionId, session] of this.vaultManager.sessions) {
            const lastActivityAgo = now - session.lastActivity;
            sessions.push({
                connectionId,
                vaultId: session.vaultId,
                userId: session.userId,
                lastActivity: new Date(session.lastActivity).toISOString(),
                lastActivityAgo: Math.floor(lastActivityAgo / 1000) + 's ago',
                isActive: lastActivityAgo < 30000 // Active if last activity within 30 seconds
            });
        }
        
        return sessions;
    }

    // Get vault statistics
    getVaultStats() {
        const vaults = [];
        const now = Date.now();
        
        for (const [vaultId, vault] of this.vaultManager.vaults) {
            // Check if vault is active (has recent activity)
            const activeSessions = Array.from(this.vaultManager.sessions.values())
                .filter(session => session.vaultId === vaultId && (now - session.lastActivity) < 300000); // 5 minutes
            
            vaults.push({
                vaultId,
                owner: vault.owner,
                memberCount: vault.members.size,
                activeSessions: activeSessions.length,
                isActive: activeSessions.length > 0,
                members: Array.from(vault.members)
            });
        }
        
        this.stats.totalVaults = vaults.length;
        this.stats.activeVaults = vaults.filter(v => v.isActive).length;
        
        return vaults;
    }

    // Initialize terminal interface
    initTerminalInterface() {
        this.screen = blessed.screen({
            smartCSR: true,
            title: 'ShadowLink Server Monitor'
        });

        // Server status box
        this.statusBox = blessed.box({
            top: 0,
            left: 0,
            width: '50%',
            height: 8,
            content: '',
            tags: true,
            border: {
                type: 'line'
            },
            style: {
                fg: 'white',
                border: {
                    fg: 'cyan'
                }
            },
            label: ' Server Status '
        });

        // Statistics box
        this.statsBox = blessed.box({
            top: 0,
            left: '50%',
            width: '50%',
            height: 8,
            content: '',
            tags: true,
            border: {
                type: 'line'
            },
            style: {
                fg: 'white',
                border: {
                    fg: 'green'
                }
            },
            label: ' Statistics '
        });

        // Active sessions box
        this.sessionsBox = blessed.box({
            top: 8,
            left: 0,
            width: '100%',
            height: 12,
            content: '',
            tags: true,
            border: {
                type: 'line'
            },
            style: {
                fg: 'white',
                border: {
                    fg: 'yellow'
                }
            },
            label: ' Active Sessions ',
            scrollable: true,
            alwaysScroll: true,
            mouse: true
        });

        // Vaults box
        this.vaultsBox = blessed.box({
            top: 20,
            left: 0,
            width: '100%',
            height: 12,
            content: '',
            tags: true,
            border: {
                type: 'line'
            },
            style: {
                fg: 'white',
                border: {
                    fg: 'magenta'
                }
            },
            label: ' Vaults Status ',
            scrollable: true,
            alwaysScroll: true,
            mouse: true
        });

        // Instructions box
        this.instructionsBox = blessed.box({
            bottom: 0,
            left: 0,
            width: '100%',
            height: 3,
            content: '{center}Press {bold}q{/bold} to quit | {bold}r{/bold} to refresh | {bold}c{/bold} to clear history{/center}',
            tags: true,
            border: {
                type: 'line'
            },
            style: {
                fg: 'white',
                border: {
                    fg: 'blue'
                }
            }
        });

        // Add boxes to screen
        this.screen.append(this.statusBox);
        this.screen.append(this.statsBox);
        this.screen.append(this.sessionsBox);
        this.screen.append(this.vaultsBox);
        this.screen.append(this.instructionsBox);

        // Quit on Escape, q, or Control-C
        this.screen.key(['escape', 'q', 'C-c'], () => {
            this.stop();
            process.exit(0);
        });

        // Refresh on 'r'
        this.screen.key(['r'], () => {
            this.updateDisplay();
        });

        // Clear history on 'c'
        this.screen.key(['c'], () => {
            this.connectionHistory = [];
            this.updateDisplay();
        });

        this.screen.render();
    }

    // Update display content
    updateDisplay() {
        if (!this.screen) return;

        const serverStatus = this.getServerStatus();
        const sessions = this.getActiveSessions();
        const vaults = this.getVaultStats();

        // Update server status
        this.statusBox.setContent(`
{bold}Status:{/bold} {green-fg}${serverStatus.status.toUpperCase()}{/}
{bold}Uptime:{/bold} ${serverStatus.uptime}
{bold}Started:{/bold} ${new Date(this.startTime).toLocaleString()}
{bold}PID:{/bold} ${process.pid}
{bold}Memory:{/bold} ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
        `);

        // Update statistics
        this.statsBox.setContent(`
{bold}Total Connections:{/bold} ${this.stats.totalConnections}
{bold}Current Connections:{/bold} {yellow-fg}${this.stats.currentConnections}{/}
{bold}Total Vaults:{/bold} ${this.stats.totalVaults}
{bold}Active Vaults:{/bold} {green-fg}${this.stats.activeVaults}{/}
{bold}Rate Limit Hits:{/bold} {red-fg}${this.stats.rateLimitHits}{/}
{bold}Messages Processed:{/bold} ${this.stats.messagesProcessed}
        `);

        // Update sessions table
        let sessionsContent = '{bold}Active Sessions:{/bold}\n\n';
        if (sessions.length === 0) {
            sessionsContent += '{gray-fg}No active sessions{/}';
        } else {
            const table = new Table({
                head: ['Connection ID', 'User ID', 'Vault ID', 'Last Activity', 'Status'],
                style: { head: [], border: [] },
                colWidths: [15, 15, 20, 20, 10]
            });

            sessions.forEach(session => {
                table.push([
                    session.connectionId,
                    session.userId,
                    session.vaultId || 'N/A',
                    session.lastActivityAgo,
                    session.isActive ? 'Active' : 'Idle'
                ]);
            });

            sessionsContent += table.toString();
        }
        this.sessionsBox.setContent(sessionsContent);

        // Update vaults table
        let vaultsContent = '{bold}Vaults Status:{/bold}\n\n';
        if (vaults.length === 0) {
            vaultsContent += '{gray-fg}No vaults registered{/}';
        } else {
            const table = new Table({
                head: ['Vault ID', 'Owner', 'Members', 'Active Sessions', 'Status'],
                style: { head: [], border: [] },
                colWidths: [25, 15, 10, 15, 10]
            });

            vaults.forEach(vault => {
                table.push([
                    vault.vaultId,
                    vault.owner,
                    vault.memberCount.toString(),
                    vault.activeSessions.toString(),
                    vault.isActive ? 'Active' : 'Inactive'
                ]);
            });

            vaultsContent += table.toString();
        }
        this.vaultsBox.setContent(vaultsContent);

        this.screen.render();
    }

    // Start monitoring
    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.initTerminalInterface();
        
        // Update display every 2 seconds
        this.updateInterval = setInterval(() => {
            this.updateDisplay();
        }, 2000);
        
        // Initial display
        this.updateDisplay();
        
        console.log('Server monitoring started. Press q to quit.');
    }

    // Stop monitoring
    stop() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        
        if (this.screen) {
            this.screen.destroy();
            this.screen = null;
        }
    }

    // Print simple console status (fallback if terminal interface fails)
    printConsoleStatus() {
        const serverStatus = this.getServerStatus();
        const sessions = this.getActiveSessions();
        const vaults = this.getVaultStats();

        console.clear();
        console.log(chalk.cyan('═'.repeat(80)));
        console.log(chalk.cyan(chalk.bold('              ShadowLink Server Monitor')));
        console.log(chalk.cyan('═'.repeat(80)));
        
        console.log(chalk.green(chalk.bold('\n📊 Server Status:')));
        console.log(`   Status: ${chalk.green(serverStatus.status.toUpperCase())}`);
        console.log(`   Uptime: ${serverStatus.uptime}`);
        console.log(`   Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
        
        console.log(chalk.yellow(chalk.bold('\n📈 Statistics:')));
        console.log(`   Current Connections: ${chalk.yellow(this.stats.currentConnections)}`);
        console.log(`   Total Connections: ${this.stats.totalConnections}`);
        console.log(`   Active Vaults: ${chalk.green(this.stats.activeVaults)}/${this.stats.totalVaults}`);
        console.log(`   Rate Limit Hits: ${chalk.red(this.stats.rateLimitHits)}`);
        
        console.log(chalk.blue(chalk.bold('\n👥 Active Sessions:')));
        if (sessions.length === 0) {
            console.log(chalk.gray('   No active sessions'));
        } else {
            sessions.forEach(session => {
                const status = session.isActive ? chalk.green('●') : chalk.gray('○');
                console.log(`   ${status} ${session.userId} (${session.connectionId}) - ${session.lastActivityAgo}`);
            });
        }
        
        console.log(chalk.magenta(chalk.bold('\n🏦 Vaults:')));
        if (vaults.length === 0) {
            console.log(chalk.gray('   No vaults registered'));
        } else {
            vaults.forEach(vault => {
                const status = vault.isActive ? chalk.green('●') : chalk.gray('○');
                console.log(`   ${status} ${vault.vaultId.substring(0, 20)}... (${vault.memberCount} members, ${vault.activeSessions} active)`);
            });
        }
        
        console.log(chalk.cyan('\n' + '═'.repeat(80)));
        console.log(chalk.gray('Press Ctrl+C to exit'));
    }
}

module.exports = ServerMonitor;