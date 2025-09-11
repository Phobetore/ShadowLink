import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TFile, TAbstractFile, Notice } from 'obsidian';
import { randomUUID } from 'crypto';
import type * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import type { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { keymap, EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * Manages conflict resolution for offline modifications
 */
class ConflictResolver {
    private app: App;
    private settings: ShadowLinkSettings;

    constructor(app: App, settings: ShadowLinkSettings) {
        this.app = app;
        this.settings = settings;
    }

    async resolveConflict(conflict: ConflictInfo): Promise<boolean> {
        const { type, filePath, localVersion, remoteVersion, isResolvable } = conflict;

        if (!isResolvable) {
            return this.handleUnresolvableConflict(conflict);
        }

        switch (this.settings.conflictResolution) {
            case 'auto':
                return this.autoResolveConflict(conflict);
            case 'manual':
                return this.manualResolveConflict(conflict);
            case 'backup':
                return this.backupResolveConflict(conflict);
            default:
                return this.autoResolveConflict(conflict);
        }
    }

    private async autoResolveConflict(conflict: ConflictInfo): Promise<boolean> {
        const { filePath, localVersion, remoteVersion, localTimestamp, remoteTimestamp } = conflict;

        try {
            // Try automatic three-way merge for content conflicts
            if (conflict.type === 'content') {
                const mergedContent = this.threeWayMerge(localVersion, remoteVersion);
                if (mergedContent !== null) {
                    const file = this.app.vault.getAbstractFileByPath(filePath);
                    if (file instanceof TFile) {
                        await this.app.vault.modify(file, mergedContent);
                        new Notice(`Auto-merged conflicts in ${filePath}`);
                        return true;
                    }
                }
            }

            // For structural conflicts, use timestamp-based resolution
            if (remoteTimestamp > localTimestamp) {
                await this.applyRemoteVersion(conflict);
                new Notice(`Applied remote version of ${filePath} (newer)`);
            } else {
                new Notice(`Kept local version of ${filePath} (newer)`);
            }
            return true;
        } catch (error) {
            console.error('Auto-resolution failed:', error);
            return this.handleUnresolvableConflict(conflict);
        }
    }

    private async manualResolveConflict(conflict: ConflictInfo): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new ConflictResolutionModal(this.app, conflict, async (resolution) => {
                try {
                    switch (resolution) {
                        case 'keepLocal':
                            new Notice(`Kept local version of ${conflict.filePath}`);
                            resolve(true);
                            break;
                        case 'keepRemote':
                            await this.applyRemoteVersion(conflict);
                            new Notice(`Applied remote version of ${conflict.filePath}`);
                            resolve(true);
                            break;
                        case 'merge':
                            const merged = this.threeWayMerge(conflict.localVersion, conflict.remoteVersion);
                            if (merged !== null) {
                                const file = this.app.vault.getAbstractFileByPath(conflict.filePath);
                                if (file instanceof TFile) {
                                    await this.app.vault.modify(file, merged);
                                    new Notice(`Merged changes in ${conflict.filePath}`);
                                    resolve(true);
                                } else {
                                    resolve(false);
                                }
                            } else {
                                resolve(false);
                            }
                            break;
                        case 'backup':
                            await this.handleUnresolvableConflict(conflict);
                            resolve(true);
                            break;
                        default:
                            resolve(false);
                    }
                } catch (error) {
                    console.error('Manual resolution failed:', error);
                    resolve(false);
                }
            });
            modal.open();
        });
    }

    private async backupResolveConflict(conflict: ConflictInfo): Promise<boolean> {
        return this.handleUnresolvableConflict(conflict);
    }

    private async handleUnresolvableConflict(conflict: ConflictInfo): Promise<boolean> {
        const { filePath, localVersion, remoteVersion } = conflict;
        
        try {
            // Create backup files for both versions
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const pathParts = filePath.split('.');
            const baseName = pathParts.slice(0, -1).join('.');
            const extension = pathParts[pathParts.length - 1];

            const localBackupPath = `${baseName}.local-${timestamp}.${extension}`;
            const remoteBackupPath = `${baseName}.remote-${timestamp}.${extension}`;

            // Save local version as backup
            await this.app.vault.create(localBackupPath, localVersion);
            
            // Apply remote version to original file
            await this.applyRemoteVersion(conflict);
            
            // Save remote version as backup too for comparison
            await this.app.vault.create(remoteBackupPath, remoteVersion);

            new Notice(
                `Conflict in ${filePath}: Created backups ${localBackupPath} and ${remoteBackupPath}. ` +
                `Applied remote version to original file.`,
                10000
            );

            return true;
        } catch (error) {
            console.error('Failed to create backup files:', error);
            new Notice(`Failed to resolve conflict in ${filePath}: ${error.message}`, 8000);
            return false;
        }
    }

    private async applyRemoteVersion(conflict: ConflictInfo): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(conflict.filePath);
        if (file instanceof TFile) {
            await this.app.vault.modify(file, conflict.remoteVersion);
        }
    }

    private threeWayMerge(local: string, remote: string): string | null {
        // Simple line-based merge algorithm
        const localLines = local.split('\n');
        const remoteLines = remote.split('\n');
        
        // If one version is empty, use the other
        if (localLines.length === 0 || (localLines.length === 1 && localLines[0] === '')) {
            return remote;
        }
        if (remoteLines.length === 0 || (remoteLines.length === 1 && remoteLines[0] === '')) {
            return local;
        }

        // Simple append strategy for Markdown files
        if (this.canSimpleMerge(localLines, remoteLines)) {
            const merged = this.performSimpleMerge(localLines, remoteLines);
            return merged.join('\n');
        }

        return null; // Cannot auto-merge
    }

    private canSimpleMerge(localLines: string[], remoteLines: string[]): boolean {
        // Check if changes are in different sections (simple heuristic)
        const localChanged = this.findChangedLines(localLines);
        const remoteChanged = this.findChangedLines(remoteLines);
        
        // If changes don't overlap, we can merge
        return !this.hasOverlap(localChanged, remoteChanged);
    }

    private findChangedLines(lines: string[]): Set<number> {
        // This is a simplified heuristic - in real implementation,
        // you'd compare against a common base version
        const changed = new Set<number>();
        lines.forEach((line, index) => {
            if (line.trim() !== '') {
                changed.add(index);
            }
        });
        return changed;
    }

    private hasOverlap(set1: Set<number>, set2: Set<number>): boolean {
        for (const item of set1) {
            if (set2.has(item)) return true;
        }
        return false;
    }

    private performSimpleMerge(localLines: string[], remoteLines: string[]): string[] {
        // Simple strategy: combine unique lines while preserving order
        const merged = [...localLines];
        
        remoteLines.forEach(line => {
            if (line.trim() && !merged.includes(line)) {
                merged.push(line);
            }
        });
        
        return merged;
    }
}

/**
 * Manages offline operations queue and synchronization
 */
class OfflineOperationManager {
    private app: App;
    private operationQueue: OfflineOperation[] = [];
    private isOnline = false;
    private queueKey: string;

    constructor(app: App, vaultId: string) {
        this.app = app;
        this.queueKey = `shadowlink-queue-${vaultId}`;
        this.loadQueue();
    }

    setOnlineStatus(online: boolean) {
        const wasOffline = !this.isOnline;
        this.isOnline = online;
        
        if (online && wasOffline && this.operationQueue.length > 0) {
            this.processQueue();
        }
    }

    addOperation(operation: Omit<OfflineOperation, 'id' | 'timestamp'>): void {
        const fullOperation: OfflineOperation = {
            ...operation,
            id: randomUUID(),
            timestamp: Date.now()
        };
        
        this.operationQueue.push(fullOperation);
        this.saveQueue();
        
        if (this.isOnline) {
            this.processQueue();
        }
    }

    private async processQueue(): Promise<void> {
        if (this.operationQueue.length === 0) return;

        console.log(`Processing ${this.operationQueue.length} queued operations`);
        
        // Sort operations by timestamp to maintain order
        this.operationQueue.sort((a, b) => a.timestamp - b.timestamp);
        
        const processed: string[] = [];
        
        for (const operation of this.operationQueue) {
            try {
                const success = await this.processOperation(operation);
                if (success) {
                    processed.push(operation.id);
                } else {
                    // If an operation fails, stop processing to maintain order
                    break;
                }
            } catch (error) {
                console.error('Failed to process operation:', operation, error);
                break;
            }
        }
        
        // Remove successfully processed operations
        this.operationQueue = this.operationQueue.filter(op => !processed.includes(op.id));
        this.saveQueue();
        
        if (processed.length > 0) {
            new Notice(`Synchronized ${processed.length} offline changes`);
        }
    }

    private async processOperation(operation: OfflineOperation): Promise<boolean> {
        try {
            switch (operation.type) {
                case 'create':
                    return this.processCreateOperation(operation);
                case 'delete':
                    return this.processDeleteOperation(operation);
                case 'rename':
                    return this.processRenameOperation(operation);
                case 'move':
                    return this.processMoveOperation(operation);
                case 'createFolder':
                    return this.processCreateFolderOperation(operation);
                case 'deleteFolder':
                    return this.processDeleteFolderOperation(operation);
                default:
                    console.warn('Unknown operation type:', operation.type);
                    return true; // Skip unknown operations
            }
        } catch (error) {
            console.error('Operation processing failed:', error);
            return false;
        }
    }

    private async processCreateOperation(operation: OfflineOperation): Promise<boolean> {
        const existingFile = this.app.vault.getAbstractFileByPath(operation.path);
        if (existingFile) {
            // File already exists, this might be a conflict
            return true; // Skip, assume already synchronized
        }
        
        await this.app.vault.create(operation.path, operation.content || '');
        return true;
    }

    private async processDeleteOperation(operation: OfflineOperation): Promise<boolean> {
        const file = this.app.vault.getAbstractFileByPath(operation.path);
        if (file instanceof TFile) {
            await this.app.vault.delete(file);
        }
        return true;
    }

    private async processRenameOperation(operation: OfflineOperation): Promise<boolean> {
        if (!operation.newPath) return false;
        
        const file = this.app.vault.getAbstractFileByPath(operation.path);
        if (file instanceof TFile) {
            await this.app.vault.rename(file, operation.newPath);
        }
        return true;
    }

    private async processMoveOperation(operation: OfflineOperation): Promise<boolean> {
        if (!operation.newPath) return false;
        
        const file = this.app.vault.getAbstractFileByPath(operation.path);
        if (file instanceof TFile) {
            await this.app.vault.rename(file, operation.newPath);
        }
        return true;
    }

    private async processCreateFolderOperation(operation: OfflineOperation): Promise<boolean> {
        const existingFolder = this.app.vault.getAbstractFileByPath(operation.path);
        if (!existingFolder) {
            await this.app.vault.createFolder(operation.path);
        }
        return true;
    }

    private async processDeleteFolderOperation(operation: OfflineOperation): Promise<boolean> {
        const folder = this.app.vault.getAbstractFileByPath(operation.path);
        if (folder) {
            await this.app.vault.delete(folder);
        }
        return true;
    }

    private saveQueue(): void {
        localStorage.setItem(this.queueKey, JSON.stringify(this.operationQueue));
    }

    private loadQueue(): void {
        try {
            const stored = localStorage.getItem(this.queueKey);
            if (stored) {
                this.operationQueue = JSON.parse(stored);
            }
        } catch (error) {
            console.error('Failed to load operation queue:', error);
            this.operationQueue = [];
        }
    }

    getQueueSize(): number {
        return this.operationQueue.length;
    }

    clearQueue(): void {
        this.operationQueue = [];
        this.saveQueue();
    }
}

/**
 * Modal for manual conflict resolution
 */
class ConflictResolutionModal extends PluginSettingTab {
    private conflict: ConflictInfo;
    private onResolve: (resolution: string) => void;

    constructor(app: App, conflict: ConflictInfo, onResolve: (resolution: string) => void) {
        super(app, null as any);
        this.conflict = conflict;
        this.onResolve = onResolve;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Conflict Resolution Required' });
        containerEl.createEl('p', { 
            text: `Conflict detected in file: ${this.conflict.filePath}` 
        });
        containerEl.createEl('p', { 
            text: `Conflict type: ${this.conflict.type}` 
        });

        const buttonContainer = containerEl.createDiv({ cls: 'conflict-buttons' });

        // Keep Local button
        const keepLocalBtn = buttonContainer.createEl('button', { 
            text: 'Keep Local Version',
            cls: 'mod-cta'
        });
        keepLocalBtn.onclick = () => {
            this.close();
            this.onResolve('keepLocal');
        };

        // Keep Remote button
        const keepRemoteBtn = buttonContainer.createEl('button', { 
            text: 'Keep Remote Version'
        });
        keepRemoteBtn.onclick = () => {
            this.close();
            this.onResolve('keepRemote');
        };

        // Try Merge button
        if (this.conflict.type === 'content') {
            const mergeBtn = buttonContainer.createEl('button', { 
                text: 'Try Auto-Merge'
            });
            mergeBtn.onclick = () => {
                this.close();
                this.onResolve('merge');
            };
        }

        // Create Backup button
        const backupBtn = buttonContainer.createEl('button', { 
            text: 'Create Backup Files'
        });
        backupBtn.onclick = () => {
            this.close();
            this.onResolve('backup');
        };
    }

    open(): void {
        const modal = this.app.workspace.containerEl.createDiv({ cls: 'modal-container' });
        modal.innerHTML = '<div class="modal"><div class="modal-content"></div></div>';
        const content = modal.querySelector('.modal-content') as HTMLElement;
        this.containerEl = content;
        this.display();
        
        // Add close handler
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.close();
                this.onResolve('keepLocal'); // Default to keeping local
            }
        });
    }

    close(): void {
        const modal = this.containerEl.closest('.modal-container');
        if (modal) {
            modal.remove();
        }
    }
}

interface ShadowLinkSettings {
    /**
     * Server address. May include ws:// or wss:// but the scheme is optional.
     */
    serverUrl: string;
    username: string;
    authToken: string;
    vaultId: string;
    sharedVaults: string[]; // List of vault IDs this user has access to
    userId: string; // Unique user identifier for collaboration
    conflictResolution: 'auto' | 'manual' | 'backup'; // How to handle conflicts
    backupConflicts: boolean; // Whether to create backup files for conflicts
}

interface OfflineOperation {
    id: string;
    type: 'create' | 'delete' | 'rename' | 'move' | 'modify' | 'createFolder' | 'deleteFolder';
    timestamp: number;
    path: string;
    newPath?: string;
    content?: string;
    metadata?: any;
    userId: string;
}

interface ConflictInfo {
    type: 'content' | 'structure' | 'concurrent';
    filePath: string;
    localVersion: string;
    remoteVersion: string;
    localTimestamp: number;
    remoteTimestamp: number;
    isResolvable: boolean;
    suggestedResolution?: 'keepLocal' | 'keepRemote' | 'merge' | 'backup';
}

const DEFAULT_SETTINGS: ShadowLinkSettings = {
    // Default without protocol so the plugin can decide between ws:// and wss://
    serverUrl: 'localhost:1234',
    username: 'Anonymous',
    authToken: '',
    vaultId: '',
    sharedVaults: [],
    userId: '',
    conflictResolution: 'auto',
    backupConflicts: true
};

export default class ShadowLinkPlugin extends Plugin {
    settings: ShadowLinkSettings;
    doc: Y.Doc | null = null;
    provider: WebsocketProvider | null = null;
    currentFile: TFile | null = null;
    vaultId = '';
    metadataDoc: Y.Doc | null = null;
    metadataProvider: WebsocketProvider | null = null;
    collabExtensions: Extension[] = [];
    statusBarItemEl: HTMLElement | null = null;
    statusHandler?: (event: { status: string }) => void;
    connectionCloseHandler?: (event: CloseEvent) => void;
    pendingSyncHandler?: (isSynced: boolean) => void;
    currentText: Y.Text | null = null;
    private Y?: typeof import('yjs');
    private WebsocketProviderClass?: typeof import('y-websocket').WebsocketProvider;
    private yCollab?: typeof import('y-codemirror.next').yCollab;
    private yUndoManagerKeymap?: typeof import('y-codemirror.next').yUndoManagerKeymap;
    private cmKeymap?: typeof import('@codemirror/view').keymap;
    private IndexeddbPersistenceClass?: typeof import('y-indexeddb').IndexeddbPersistence;
    private idb: import('y-indexeddb').IndexeddbPersistence | null = null;
    private modulesPromise: Promise<void> | null = null;
    
    // Race condition prevention
    private fileOpenQueue: Promise<void> = Promise.resolve();
    private currentFileOpenRequest: string | null = null;
    private debounceTimeout: NodeJS.Timeout | null = null;
    private isCleaningUp = false;
    
    // Enhanced offline and conflict resolution
    private conflictResolver: ConflictResolver | null = null;
    offlineManager: OfflineOperationManager | null = null; // Made public for settings access
    private lastSyncTimestamps: Map<string, number> = new Map();
    private documentVersions: Map<string, string> = new Map();
    private isOnline = false;
    
    // Connection retry logic
    private connectionRetries = 0;
    private maxRetries = 5;
    private retryDelay = 1000; // Start with 1 second
    private retryTimeout: NodeJS.Timeout | null = null;
    private connectionStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected';

    async onload() {
        await this.loadSettings();

        if (!this.settings.vaultId) {
            this.settings.vaultId = randomUUID();
            await this.saveSettings();
        }
        if (!this.settings.userId) {
            this.settings.userId = randomUUID();
            await this.saveSettings();
        }
        this.vaultId = this.settings.vaultId;

        // Initialize conflict resolution and offline management
        this.conflictResolver = new ConflictResolver(this.app, this.settings);
        this.offlineManager = new OfflineOperationManager(this.app, this.vaultId);

        const url = this.resolveServerUrl(this.settings.serverUrl);

        this.statusBarItemEl = this.addStatusBarItem();
        this.statusBarItemEl.setText('ShadowLink: connecting');
        
        this.statusHandler = (event: { status: string }) => {
            if (!this.statusBarItemEl) return;
            const wasOnline = this.isOnline;
            const previousStatus = this.connectionStatus;
            
            console.log('ShadowLink: Status change from', previousStatus, 'to', event.status);
            
            switch (event.status) {
                case 'connected':
                    this.connectionStatus = 'connected';
                    this.isOnline = true;
                    this.connectionRetries = 0; // Reset retry count on successful connection
                    if (this.retryTimeout) {
                        clearTimeout(this.retryTimeout);
                        this.retryTimeout = null;
                    }
                    this.statusBarItemEl.setText('ShadowLink: connected');
                    // Trigger immediate sync check when connection is established
                    if (!wasOnline) {
                        this.scheduleImmediateSync();
                    }
                    break;
                case 'disconnected':
                    if (this.connectionStatus !== 'disconnected') {
                        this.connectionStatus = 'disconnected';
                        this.isOnline = false;
                        this.statusBarItemEl.setText('ShadowLink: disconnected');
                        // Only start retry if we were previously connected or connecting
                        if (previousStatus === 'connected' || previousStatus === 'connecting') {
                            this.scheduleReconnect();
                        }
                    }
                    break;
                case 'connecting':
                    if (this.connectionStatus !== 'connecting') {
                        this.connectionStatus = 'connecting';
                        this.isOnline = false;
                        this.statusBarItemEl.setText('ShadowLink: connecting...');
                    }
                    break;
                default:
                    // Handle other statuses without changing connection state
                    this.statusBarItemEl.setText('ShadowLink: ' + event.status);
            }
            
            // Update offline manager about connection status with immediate sync
            if (this.offlineManager && wasOnline !== this.isOnline) {
                this.offlineManager.setOnlineStatus(this.isOnline);
                
                // If coming back online, trigger immediate metadata sync
                if (this.isOnline && !wasOnline) {
                    setTimeout(() => {
                        this.performPeriodicSyncCheck();
                    }, 1000); // Small delay to let connection stabilize
                }
            }
            
            // Update status bar with queue info when offline
            if (!this.isOnline && this.offlineManager) {
                const queueSize = this.offlineManager.getQueueSize();
                if (queueSize > 0) {
                    this.statusBarItemEl.setText(`ShadowLink: offline (${queueSize} queued)`);
                }
            }
        };
        
        this.connectionCloseHandler = (event: CloseEvent) => {
            if (!this.statusBarItemEl) return;
            this.isOnline = false;
            const reason = event?.reason ? `: ${event.reason}` : '';
            this.statusBarItemEl.setText(`ShadowLink: disconnected${reason}`);
            
            if (this.offlineManager) {
                this.offlineManager.setOnlineStatus(false);
            }
        };
        
        await this.connectMetadata();
        this.registerEditorExtension(this.collabExtensions);
        this.registerEvent(this.app.workspace.on('file-open', (file) => { void this.handleFileOpenDebounced(file); }));
        this.registerEvent(this.app.vault.on('delete', this.handleFileDelete.bind(this)));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { void this.handleFileRename(file, oldPath); }));
        this.registerEvent(this.app.vault.on('create', (file) => { void this.handleFileCreate(file); }));
        
        // Enhanced folder operations
        this.registerEvent(this.app.vault.on('create', (file) => { void this.handleFolderCreate(file); }));
        this.registerEvent(this.app.vault.on('delete', this.handleFolderDelete.bind(this)));
        
        // Initialize with the currently active file if any
        void this.handleFileOpenDebounced(this.app.workspace.getActiveFile());

        this.addSettingTab(new ShadowLinkSettingTab(this.app, this));
        console.log('ShadowLink: ready, server', url);
    }

    onunload() {
        this.isCleaningUp = true;
        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
        }
        this.cleanupCurrent();
        this.cleanupMetadata();
        this.statusBarItemEl?.remove();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Resolve the final WebSocket URL. If the provided value includes a
     * protocol it is used as-is. Otherwise the scheme is selected based on the
     * current page (wss for https, ws otherwise).
     */
    private resolveServerUrl(url: string): string {
        if (/^wss?:\/\//.test(url)) {
            return url;
        }
        if (/^https?:\/\//.test(url)) {
            const rest = url.replace(/^https?:\/\//, '');
            return url.startsWith('https://') ? `wss://${rest}` : `ws://${rest}`;
        }
        const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        if (url.startsWith('//')) {
            return scheme + url.slice(2);
        }
        return scheme + url;
    }

    /**
     * Schedule a reconnection attempt with exponential backoff
     */
    /**
     * Schedule immediate sync when connection is re-established
     */
    private scheduleImmediateSync() {
        console.log('ShadowLink: Scheduling immediate sync after reconnection');
        
        // Trigger sync with a small delay to let connection stabilize
        setTimeout(() => {
            if (this.isOnline && this.metadataDoc) {
                this.performPeriodicSyncCheck();
            }
        }, 2000);
        
        // Ensure awareness is set up immediately for all providers
        this.ensureAwarenessState();
    }
    
    /**
     * Ensure awareness state is properly set for all active providers
     */
    private ensureAwarenessState() {
        const userState = {
            name: this.settings.username,
            color: this.getUserColor(),
            colorLight: this.getUserColor(true),
            userId: this.settings.userId,
            vaultId: this.vaultId,
            timestamp: Date.now(),
            currentFile: this.currentFile?.path || null
        };
        
        // Set awareness for document provider if available
        if (this.provider && this.provider.awareness) {
            console.log('ShadowLink: Setting document awareness for', this.settings.username, 'on file:', this.currentFile?.path);
            this.provider.awareness.setLocalStateField('user', userState);
        }
        
        // Set awareness for metadata provider if available
        if (this.metadataProvider && this.metadataProvider.awareness) {
            console.log('ShadowLink: Setting metadata awareness for', this.settings.username);
            this.metadataProvider.awareness.setLocalStateField('user', userState);
        }
    }

    /**
     * Get user color for awareness/presence
     */
    private getUserColor(light = false): string {
        const userId = this.settings.userId;
        const hue = userId ? parseInt(userId.substring(0, 8), 16) % 360 : Math.random() * 360;
        return light ? `hsla(${hue}, 80%, 50%, 0.2)` : `hsl(${hue}, 80%, 50%)`;
    }

    private scheduleReconnect(): void {
        if (this.isCleaningUp || this.connectionRetries >= this.maxRetries) {
            if (this.connectionRetries >= this.maxRetries) {
                console.warn('ShadowLink: Max reconnection attempts reached');
                if (this.statusBarItemEl) {
                    this.statusBarItemEl.setText('ShadowLink: connection failed');
                }
            }
            return;
        }

        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
        }

        const delay = this.retryDelay * Math.pow(2, this.connectionRetries);
        this.connectionRetries++;
        
        console.log(`ShadowLink: Scheduling reconnect attempt ${this.connectionRetries}/${this.maxRetries} in ${delay}ms`);
        
        if (this.statusBarItemEl) {
            this.statusBarItemEl.setText(`ShadowLink: reconnecting (${this.connectionRetries}/${this.maxRetries})`);
        }

        this.retryTimeout = setTimeout(() => {
            if (!this.isCleaningUp) {
                console.log('ShadowLink: Attempting reconnection...');
                this.reconnect();
            }
        }, delay);
    }

    /**
     * Attempt to reconnect by recreating metadata connection
     */
    private async reconnect(): Promise<void> {
        try {
            console.log('ShadowLink: Reconnecting...');
            this.cleanupMetadata();
            await this.connectMetadata();
            
            // If we have a current file, reconnect to it as well
            if (this.currentFile) {
                await this.handleFileOpenInternal(this.currentFile);
            }
        } catch (error) {
            console.error('ShadowLink: Reconnection failed:', error);
            this.scheduleReconnect();
        }
    }

    private colorFromId(id: number): string {
        const hue = id % 360;
        return `hsl(${hue}, 80%, 50%)`;
    }

    /**
     * Yield to the event loop to keep the UI responsive.
     */
    private defer(): Promise<void> {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    private async loadCollabModules(): Promise<void> {
        if (!this.modulesPromise) {
            const viewPromise = typeof require !== 'undefined'
                ? Promise.resolve(require('@codemirror/view'))
                : import('@codemirror/view');
            this.modulesPromise = Promise.all([
                import('yjs'),
                import('y-websocket'),
                import('y-codemirror.next'),
                viewPromise,
                import('y-indexeddb')
            ]).then(([Y, yws, ycm, view, yidb]) => {
                this.Y = Y as typeof import('yjs');
                this.WebsocketProviderClass = yws.WebsocketProvider;
                this.yCollab = ycm.yCollab;
                this.yUndoManagerKeymap = ycm.yUndoManagerKeymap;
                this.cmKeymap = (view as typeof import('@codemirror/view')).keymap;
                this.IndexeddbPersistenceClass = yidb.IndexeddbPersistence;
            });
        }
        await this.modulesPromise;
    }

    private docNameForFile(file: TFile): string {
        return `${this.vaultId}/${file.path}`;
    }

    private metadataDocName(): string {
        return `${this.vaultId}/vault-metadata`;
    }

    cleanupCurrent() {
        if (this.isCleaningUp) return; // Prevent recursive cleanup
        
        // Don't remove shared status handlers during file switching as they're also used by metadataProvider
        // Only remove handlers if we're doing a complete cleanup (onunload)
        if (this.provider && this.statusHandler && this.isCleaningUp) {
            this.provider.off('status', this.statusHandler);
        }
        if (this.provider && this.connectionCloseHandler && this.isCleaningUp) {
            this.provider.off('connection-close', this.connectionCloseHandler);
        }
        this.provider?.destroy();
        this.idb?.destroy();
        this.doc?.destroy();
        this.provider = null;
        this.idb = null;
        this.doc = null;
        this.currentText = null;
        this.currentFile = null;
    }

    cleanupMetadata() {
        this.metadataProvider?.destroy();
        this.metadataDoc?.destroy();
        this.metadataProvider = null;
        this.metadataDoc = null;
    }

    async connectMetadata(): Promise<void> {
        await this.loadCollabModules();
        const url = this.resolveServerUrl(this.settings.serverUrl);
        this.metadataDoc = new this.Y!.Doc();
        
        // Fix empty token parameter issue
        const params: Record<string, string> = { 
            vaultId: this.vaultId,
            userId: this.settings.userId
        };
        
        // Only add token if it's not empty
        if (this.settings.authToken && this.settings.authToken.trim() !== '') {
            params.token = this.settings.authToken;
        }
        
        this.metadataProvider = new this.WebsocketProviderClass!(url, this.metadataDocName(), this.metadataDoc, {
            params
        });
        
        // Add connection status tracking for metadata provider
        if (this.statusHandler) {
            this.metadataProvider.on('status', this.statusHandler);
        }
        if (this.connectionCloseHandler) {
            this.metadataProvider.on('connection-close', this.connectionCloseHandler);
        }
        
        const onSync = async (synced: boolean) => {
            if (synced) {
                await this.syncLocalWithMetadata();
                this.metadataProvider?.off('sync', onSync);
            }
        };
        if (this.metadataProvider.synced) {
            await this.syncLocalWithMetadata();
        } else {
            this.metadataProvider.on('sync', onSync);
        }
    }

    private async syncLocalWithMetadata() {
        if (!this.metadataDoc) return;
        const arr = this.metadataDoc.getArray<string>('paths');
        const remote = new Set(arr.toArray());
        const localFiles = this.app.vault.getFiles();
        const localSet = new Set(localFiles.map(f => f.path));
        
        console.log('ShadowLink: Syncing vault - Local files:', localSet.size, 'Remote files:', remote.size);
        
        // Handle conflicts during sync
        const conflicts: ConflictInfo[] = [];
        
        // Check if we're connecting to a vault that has content and we also have local content
        const hasRemoteContent = remote.size > 0;
        const hasLocalContent = localSet.size > 0;
        
        // Force immediate visibility of changes by triggering a sync notification
        if (hasRemoteContent || hasLocalContent) {
            console.log('ShadowLink: Content detected, ensuring immediate sync visibility');
            new Notice(`ShadowLink: Synchronizing vault (${Math.max(localSet.size, remote.size)} files)`, 3000);
        }
        
        if (hasRemoteContent && hasLocalContent) {
            console.log('ShadowLink: Both local and remote content found, merging...');
            await this.mergeVaultContents(localSet, remote, conflicts);
        } else if (hasLocalContent && !hasRemoteContent) {
            // Local content exists but remote is empty - push local to remote
            console.log('ShadowLink: Pushing local content to remote vault...');
            for (const path of localSet) {
                arr.push([path]);
            }
            new Notice(`ShadowLink: Shared ${localSet.size} local files to vault`, 4000);
        } else if (hasRemoteContent && !hasLocalContent) {
            // Remote content exists but local is empty - pull remote to local
            console.log('ShadowLink: Pulling remote content to local vault...');
            for (const path of remote) {
                try {
                    await this.app.vault.create(path, '');
                } catch (error) {
                    console.warn('ShadowLink: Failed to create file:', path, error);
                }
            }
            new Notice(`ShadowLink: Downloaded ${remote.size} files from shared vault`, 4000);
        } else {
            // Standard sync logic for when there's no conflict
            for (const p of remote) {
                if (!localSet.has(p)) {
                    // Check if this was recently deleted locally
                    const lastDeleteTime = this.lastSyncTimestamps.get(`delete:${p}`);
                    if (lastDeleteTime && Date.now() - lastDeleteTime < 60000) { // 1 minute threshold
                        // Potential conflict: file was deleted locally but exists remotely
                        conflicts.push({
                            type: 'structure',
                            filePath: p,
                            localVersion: '',
                            remoteVersion: 'exists',
                            localTimestamp: lastDeleteTime,
                            remoteTimestamp: Date.now(),
                            isResolvable: true,
                            suggestedResolution: 'keepRemote'
                        });
                    } else {
                        await this.app.vault.create(p, '');
                    }
                }
            }
            
            for (const p of localSet) {
                if (!remote.has(p)) {
                    // Check if this was recently created locally
                    const file = this.app.vault.getAbstractFileByPath(p);
                    if (file instanceof TFile) {
                        const stat = await this.app.vault.adapter.stat(p);
                        if (stat && Date.now() - stat.ctime < 60000) { // 1 minute threshold
                            // Recently created locally, add to remote
                            arr.push([p]);
                        } else {
                            // File exists locally but not remotely - potential conflict
                            conflicts.push({
                                type: 'structure',
                                filePath: p,
                                localVersion: 'exists',
                                remoteVersion: '',
                                localTimestamp: stat?.mtime || Date.now(),
                                remoteTimestamp: 0,
                                isResolvable: true,
                                suggestedResolution: 'keepLocal'
                            });
                        }
                    }
                }
            }
        }
        
        // Process conflicts
        for (const conflict of conflicts) {
            if (this.conflictResolver) {
                await this.conflictResolver.resolveConflict(conflict);
            }
        }
        
        // Set up continuous monitoring for metadata changes
        this.setupMetadataChangeMonitoring();
        
        // Trigger immediate awareness setup for live collaboration
        setTimeout(() => {
            this.ensureAwarenessState();
        }, 1000);
        
        console.log('ShadowLink: Vault sync completed');
    }

    /**
     * Merge local and remote vault contents when both have files
     */
    private async mergeVaultContents(localSet: Set<string>, remote: Set<string>, conflicts: ConflictInfo[]): Promise<void> {
        if (!this.metadataDoc) return;
        const arr = this.metadataDoc.getArray<string>('paths');
        
        // Files that exist in both local and remote
        const commonFiles = new Set([...localSet].filter(f => remote.has(f)));
        
        // Files only in local
        const localOnlyFiles = new Set([...localSet].filter(f => !remote.has(f)));
        
        // Files only in remote
        const remoteOnlyFiles = new Set([...remote].filter(f => !localSet.has(f)));
        
        console.log('ShadowLink: Merge analysis - Common:', commonFiles.size, 'Local only:', localOnlyFiles.size, 'Remote only:', remoteOnlyFiles.size);
        
        // For common files, we'll let the document-level sync handle conflicts
        // For local-only files, add them to remote
        for (const path of localOnlyFiles) {
            console.log('ShadowLink: Adding local file to remote:', path);
            arr.push([path]);
        }
        
        // For remote-only files, create them locally
        for (const path of remoteOnlyFiles) {
            try {
                console.log('ShadowLink: Creating remote file locally:', path);
                await this.app.vault.create(path, '');
            } catch (error) {
                console.warn('ShadowLink: Failed to create file locally:', path, error);
            }
        }
        
        // Show notification about merge
        if (localOnlyFiles.size > 0 || remoteOnlyFiles.size > 0) {
            new Notice(`ShadowLink: Merged vault contents - Added ${localOnlyFiles.size} local files to server, ${remoteOnlyFiles.size} remote files to local`, 8000);
        }
    }

    /**
     * Set up continuous monitoring for metadata changes to ensure real-time sync
     */
    private setupMetadataChangeMonitoring() {
        if (!this.metadataDoc) return;

        const pathsArray = this.metadataDoc.getArray<string>('paths');
        
        // Monitor path changes for file operations
        pathsArray.observe((event) => {
            this.handleRemotePathChanges(event);
        });

        // Also monitor folder-specific metadata if we extend to track folders separately
        const foldersArray = this.metadataDoc.getArray<string>('folders');
        if (foldersArray) {
            foldersArray.observe((event) => {
                this.handleRemoteFolderChanges(event);
            });
        }

        // Set up periodic sync check to catch any missed changes
        this.setupPeriodicSyncCheck();
    }

    /**
     * Handle remote path changes (file create/delete operations)
     */
    private async handleRemotePathChanges(event: Y.YArrayEvent<string>) {
        console.log('ShadowLink: Remote path changes detected', event);
        
        for (const delta of event.changes.delta) {
            if (delta.insert) {
                // New file(s) added remotely
                const newPaths = Array.isArray(delta.insert) ? delta.insert : [delta.insert];
                for (const path of newPaths) {
                    const existingFile = this.app.vault.getAbstractFileByPath(path);
                    if (!existingFile) {
                        try {
                            // Check if this isn't a recent local operation to avoid loops
                            const recentCreate = this.lastSyncTimestamps.get(`create:${path}`);
                            if (!recentCreate || Date.now() - recentCreate > 5000) { // 5 second threshold
                                await this.app.vault.create(path, '');
                                new Notice(`Created shared file: ${path}`, 3000);
                            }
                        } catch (error) {
                            console.error('Failed to create file from remote change:', path, error);
                        }
                    }
                }
            }
            
            if (delta.delete && event.path.length > 0) {
                // File(s) deleted remotely - need to reconcile
                await this.reconcileRemoteFileDeletions();
            }
        }
    }

    /**
     * Handle remote folder changes
     */
    private async handleRemoteFolderChanges(event: Y.YArrayEvent<string>) {
        console.log('ShadowLink: Remote folder changes detected', event);
        
        for (const delta of event.changes.delta) {
            if (delta.insert) {
                // New folder(s) added remotely
                const newFolders = Array.isArray(delta.insert) ? delta.insert : [delta.insert];
                for (const folderPath of newFolders) {
                    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
                        try {
                            // Check if this isn't a recent local operation
                            const recentCreate = this.lastSyncTimestamps.get(`createFolder:${folderPath}`);
                            if (!recentCreate || Date.now() - recentCreate > 5000) {
                                await this.app.vault.createFolder(folderPath);
                                new Notice(`Created shared folder: ${folderPath}`, 3000);
                            }
                        } catch (error) {
                            console.error('Failed to create folder from remote change:', folderPath, error);
                        }
                    }
                }
            }
            
            if (delta.delete) {
                // Folder(s) deleted remotely
                await this.reconcileRemoteFolderDeletions();
            }
        }
    }

    /**
     * Reconcile remote file deletions by comparing current metadata with local state
     */
    private async reconcileRemoteFileDeletions() {
        if (!this.metadataDoc) return;
        
        const pathsArray = this.metadataDoc.getArray<string>('paths');
        const remotePaths = new Set(pathsArray.toArray());
        const localFiles = this.app.vault.getFiles();
        
        for (const localFile of localFiles) {
            if (!remotePaths.has(localFile.path)) {
                // File exists locally but not in remote metadata
                const recentDelete = this.lastSyncTimestamps.get(`delete:${localFile.path}`);
                if (!recentDelete || Date.now() - recentDelete > 5000) {
                    try {
                        await this.app.vault.delete(localFile);
                        new Notice(`Removed shared file: ${localFile.path}`, 3000);
                    } catch (error) {
                        console.error('Failed to delete file from remote change:', localFile.path, error);
                    }
                }
            }
        }
    }

    /**
     * Reconcile remote folder deletions
     */
    private async reconcileRemoteFolderDeletions() {
        if (!this.metadataDoc) return;
        
        const foldersArray = this.metadataDoc.getArray<string>('folders');
        const remoteFolders = new Set(foldersArray.toArray());
        const localFolders = new Set<string>();
        
        // Get current local folders
        this.app.vault.getAllLoadedFiles().forEach(file => {
            if (!(file instanceof TFile)) {
                localFolders.add(file.path);
            }
        });
        
        // Find folders that exist locally but not in remote metadata
        for (const localFolder of localFolders) {
            if (!remoteFolders.has(localFolder)) {
                const recentDelete = this.lastSyncTimestamps.get(`deleteFolder:${localFolder}`);
                if (!recentDelete || Date.now() - recentDelete > 5000) {
                    const folder = this.app.vault.getAbstractFileByPath(localFolder);
                    if (folder) {
                        try {
                            await this.app.vault.delete(folder);
                            new Notice(`Removed shared folder: ${localFolder}`, 3000);
                        } catch (error) {
                            console.error('Failed to delete folder from remote change:', localFolder, error);
                        }
                    }
                }
            }
        }
    }

    /**
     * Set up periodic sync check to catch any missed changes
     */
    private setupPeriodicSyncCheck() {
        // Check for missed changes every 30 seconds
        const interval = setInterval(() => {
            if (this.isOnline && this.metadataDoc) {
                this.performPeriodicSyncCheck();
            }
        }, 30000);
        
        this.register(() => clearInterval(interval));
    }

    /**
     * Perform a periodic sync check to catch any missed changes
     */
    private async performPeriodicSyncCheck() {
        if (!this.metadataDoc) return;
        
        const pathsArray = this.metadataDoc.getArray<string>('paths');
        const remotePaths = new Set(pathsArray.toArray());
        const localFiles = this.app.vault.getFiles();
        const localPaths = new Set(localFiles.map(f => f.path));
        
        // Find any discrepancies and reconcile them
        let hasChanges = false;
        
        // Check for local files not in remote
        for (const localPath of localPaths) {
            if (!remotePaths.has(localPath)) {
                const recentOp = this.lastSyncTimestamps.get(`create:${localPath}`) ||
                               this.lastSyncTimestamps.get(`rename:${localPath}`);
                if (!recentOp || Date.now() - recentOp > 10000) { // 10 second threshold
                    console.log('ShadowLink: Adding missing local file to remote:', localPath);
                    pathsArray.push([localPath]);
                    hasChanges = true;
                }
            }
        }
        
        // Check for remote files not in local
        for (const remotePath of remotePaths) {
            if (!localPaths.has(remotePath)) {
                const recentDelete = this.lastSyncTimestamps.get(`delete:${remotePath}`);
                if (!recentDelete || Date.now() - recentDelete > 10000) {
                    console.log('ShadowLink: Creating missing remote file locally:', remotePath);
                    try {
                        await this.app.vault.create(remotePath, '');
                        hasChanges = true;
                    } catch (error) {
                        console.error('Failed to create missing file:', remotePath, error);
                    }
                }
            }
        }
        
        if (hasChanges) {
            console.log('ShadowLink: Periodic sync check found and resolved discrepancies');
        }
    }

    private async detectContentConflicts(file: TFile, remoteContent: string): Promise<ConflictInfo | null> {
        try {
            const localContent = await this.app.vault.read(file);
            const localVersion = this.documentVersions.get(file.path);
            
            if (localContent !== remoteContent && localVersion && localVersion !== remoteContent) {
                const stat = await this.app.vault.adapter.stat(file.path);
                return {
                    type: 'content',
                    filePath: file.path,
                    localVersion: localContent,
                    remoteVersion: remoteContent,
                    localTimestamp: stat?.mtime || Date.now(),
                    remoteTimestamp: Date.now(),
                    isResolvable: true,
                    suggestedResolution: 'merge'
                };
            }
        } catch (error) {
            console.error('Error detecting content conflicts:', error);
        }
        return null;
    }
    private async handleFileDelete(file: TFile) {
        await this.loadCollabModules();
        
        // Track deletion timestamp for conflict resolution
        this.lastSyncTimestamps.set(`delete:${file.path}`, Date.now());
        
        if (this.currentFile && file.path === this.currentFile.path) {
            this.cleanupCurrent();
        }
        
        // Queue operation if offline
        if (!this.isOnline && this.offlineManager) {
            this.offlineManager.addOperation({
                type: 'delete',
                path: file.path,
                userId: this.settings.userId
            });
            return;
        }
        
        // Immediately broadcast deletion to metadata
        if (this.metadataDoc) {
            const arr = this.metadataDoc.getArray<string>('paths');
            const idx = arr.toArray().indexOf(file.path);
            if (idx >= 0) {
                arr.delete(idx, 1);
                console.log('ShadowLink: Broadcasted file deletion:', file.path);
            }
        }
        
        // Optionally inform the server about the deletion
        const doc = new this.Y!.Doc();
        const url = this.resolveServerUrl(this.settings.serverUrl);
        
        const params: Record<string, string> = { 
            vaultId: this.vaultId,
            userId: this.settings.userId
        };
        
        if (this.settings.authToken && this.settings.authToken.trim() !== '') {
            params.token = this.settings.authToken;
        }
        
        const provider = new this.WebsocketProviderClass!(url, this.docNameForFile(file), doc, { params });
        const text = doc.getText('content');
        provider.once('sync', () => {
            text.delete(0, text.length);
            provider.destroy();
            doc.destroy();
        });
    }

    private async handleFileCreate(file: TAbstractFile) {
        if (!(file instanceof TFile)) return;
        
        // Track creation timestamp  
        this.lastSyncTimestamps.set(`create:${file.path}`, Date.now());
        
        // Queue operation if offline
        if (!this.isOnline && this.offlineManager) {
            this.offlineManager.addOperation({
                type: 'create',
                path: file.path,
                content: '',
                userId: this.settings.userId
            });
            return;
        }
        
        // Immediately broadcast creation to metadata
        if (this.metadataDoc) {
            const arr = this.metadataDoc.getArray<string>('paths');
            if (!arr.toArray().includes(file.path)) {
                arr.push([file.path]);
                console.log('ShadowLink: Broadcasted file creation:', file.path);
            }
        }
    }

    private async handleFileRename(file: TAbstractFile, oldPath: string) {
        if (!(file instanceof TFile)) return;
        
        // Track rename timestamp
        this.lastSyncTimestamps.set(`rename:${oldPath}`, Date.now());
        
        // Queue operation if offline
        if (!this.isOnline && this.offlineManager) {
            this.offlineManager.addOperation({
                type: 'rename',
                path: oldPath,
                newPath: file.path,
                userId: this.settings.userId
            });
            return;
        }
        
        if (this.currentFile && oldPath === this.currentFile.path) {
            this.cleanupCurrent();
            const doc = new this.Y!.Doc();
            const url = this.resolveServerUrl(this.settings.serverUrl);
            
            const params: Record<string, string> = { 
                vaultId: this.vaultId,
                userId: this.settings.userId
            };
            
            if (this.settings.authToken && this.settings.authToken.trim() !== '') {
                params.token = this.settings.authToken;
            }
            
            const provider = new this.WebsocketProviderClass!(url, `${this.vaultId}/${oldPath}`, doc, { params });
            const text = doc.getText('content');
            provider.once('sync', () => {
                text.delete(0, text.length);
                provider.destroy();
                doc.destroy();
            });
            await this.handleFileOpenDebounced(file);
        }
        // Immediately broadcast rename to metadata
        if (this.metadataDoc) {
            const arr = this.metadataDoc.getArray<string>('paths');
            const list = arr.toArray();
            const oldIdx = list.indexOf(oldPath);
            if (oldIdx >= 0) {
                arr.delete(oldIdx, 1);
                console.log('ShadowLink: Broadcasted file deletion (rename):', oldPath);
            }
            if (!list.includes(file.path)) {
                arr.push([file.path]);
                console.log('ShadowLink: Broadcasted file creation (rename):', file.path);
            }
        }
    }

    private async handleFolderCreate(file: TAbstractFile) {
        if (file instanceof TFile) return; // Only handle folders
        
        // Track folder creation
        this.lastSyncTimestamps.set(`createFolder:${file.path}`, Date.now());
        
        // Queue operation if offline
        if (!this.isOnline && this.offlineManager) {
            this.offlineManager.addOperation({
                type: 'createFolder',
                path: file.path,
                userId: this.settings.userId
            });
            return;
        }
        
        // Immediately broadcast folder creation to metadata
        if (this.metadataDoc) {
            const foldersArray = this.metadataDoc.getArray<string>('folders');
            if (!foldersArray.toArray().includes(file.path)) {
                foldersArray.push([file.path]);
                console.log('ShadowLink: Broadcasted folder creation:', file.path);
            }
        }
    }

    private async handleFolderDelete(file: TAbstractFile) {
        if (file instanceof TFile) return; // Only handle folders
        
        // Track folder deletion
        this.lastSyncTimestamps.set(`deleteFolder:${file.path}`, Date.now());
        
        // Queue operation if offline
        if (!this.isOnline && this.offlineManager) {
            this.offlineManager.addOperation({
                type: 'deleteFolder',
                path: file.path,
                userId: this.settings.userId
            });
            return;
        }
        
        // Immediately broadcast folder deletion to metadata
        if (this.metadataDoc) {
            const foldersArray = this.metadataDoc.getArray<string>('folders');
            const idx = foldersArray.toArray().indexOf(file.path);
            if (idx >= 0) {
                foldersArray.delete(idx, 1);
                console.log('ShadowLink: Broadcasted folder deletion:', file.path);
            }
        }
    }

    /**
     * Debounced file opening to prevent race conditions when switching files rapidly
     */
    private handleFileOpenDebounced(file: TFile | null) {
        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }
        
        this.debounceTimeout = setTimeout(() => {
            void this.handleFileOpen(file);
        }, 100); // 100ms debounce
    }

    private async handleFileOpen(file: TFile | null) {
        // Create a unique request ID to track this specific file open request
        const requestId = file ? file.path : 'null';
        this.currentFileOpenRequest = requestId;

        // Queue the file open operation to prevent concurrent execution
        this.fileOpenQueue = this.fileOpenQueue.then(async () => {
            // Check if this request is still current (user hasn't switched to another file)
            if (this.currentFileOpenRequest !== requestId || this.isCleaningUp) {
                return;
            }

            try {
                await this.handleFileOpenInternal(file);
            } catch (error) {
                console.error('ShadowLink: Error opening file', error);
            }
        });

        return this.fileOpenQueue;
    }

    async handleFileOpenInternal(file: TFile | null) {
        await this.loadCollabModules();
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!file || !view) {
            this.cleanupCurrent();
            return;
        }

        if (this.currentFile && this.currentFile.path === file.path) {
            return;
        }

        // Store current awareness state before cleanup to preserve it
        let preservedAwarenessState: any = null;
        if (this.provider && this.provider.awareness) {
            preservedAwarenessState = this.provider.awareness.getLocalState();
        }

        this.cleanupCurrent();

        const url = this.resolveServerUrl(this.settings.serverUrl);
        const docName = this.docNameForFile(file);
        this.doc = new this.Y!.Doc();
        this.idb = new this.IndexeddbPersistenceClass!(docName, this.doc);
        await this.idb.whenSynced;
        
        this.provider = new this.WebsocketProviderClass!(url, docName, this.doc, {
            params: (() => {
                const params: Record<string, string> = { 
                    vaultId: this.vaultId,
                    userId: this.settings.userId
                };
                
                // Only add token if it's not empty
                if (this.settings.authToken && this.settings.authToken.trim() !== '') {
                    params.token = this.settings.authToken;
                }
                
                return params;
            })()
        });
        
        // Enhanced sync handling with conflict detection
        this.provider.once('sync', async () => {
            const ytext = this.doc?.getText('content');
            if (!ytext) return;
            
            const remoteContent = ytext.toString();
            console.log('ShadowLink: Initial sync completed for', file.path, 'content length:', remoteContent.length);
            
            // Check for conflicts
            if (this.conflictResolver) {
                const conflict = await this.detectContentConflicts(file, remoteContent);
                if (conflict) {
                    const resolved = await this.conflictResolver.resolveConflict(conflict);
                    if (!resolved) {
                        new Notice(`Failed to resolve conflict in ${file.path}`, 5000);
                    }
                } else {
                    // Store the current version for future conflict detection
                    this.documentVersions.set(file.path, remoteContent);
                }
            }
            
            // Only clear IndexedDB data after successful sync, not the document data itself
            // This prevents content loss when navigating between files
            if (this.idb) {
                try {
                    // Clear only the update data, not the document itself
                    await this.idb.clearData();
                } catch (error) {
                    console.warn('ShadowLink: Failed to clear IndexedDB update data:', error);
                }
            }
        });
        
        this.currentFile = file;

        // Enhanced awareness setup for better live collaboration - set up immediately
        const clientId = this.provider.awareness.clientID;
        const userColor = this.getUserColor();
        const userColorLight = this.getUserColor(true);
        
        // Create the awareness state with preserved data if available
        const awarenessState = {
            name: this.settings.username,
            color: userColor,
            colorLight: userColorLight,
            userId: this.settings.userId,
            vaultId: this.vaultId,
            timestamp: Date.now(),
            ...(preservedAwarenessState?.user || {}) // Merge any preserved state
        };
        
        // Set awareness state immediately when connection is established
        this.provider.awareness.setLocalStateField('user', awarenessState);
        
        // Also set it again when connected to ensure it's always available
        this.provider.on('status', (event: { status: string }) => {
            if (event.status === 'connected') {
                console.log('ShadowLink: Setting awareness on connection for', this.settings.username, 'file:', file.path);
                this.provider!.awareness.setLocalStateField('user', {
                    name: this.settings.username,
                    color: userColor,
                    colorLight: userColorLight,
                    userId: this.settings.userId,
                    vaultId: this.vaultId,
                    timestamp: Date.now(),
                    currentFile: file.path // Add current file info for better tracking
                });
            }
        });
        
        // Set up awareness state monitoring for better presence tracking
        this.provider.awareness.on('change', ({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }) => {
            const states = this.provider!.awareness.getStates();
            console.log('ShadowLink: Awareness changed for', file.path, '-', 
                'Total users:', states.size, 
                'Added:', added.length, 
                'Updated:', updated.length, 
                'Removed:', removed.length
            );
            
            // Update status bar with current user count only if we're the active connection
            if (this.statusBarItemEl && this.isOnline && this.currentFile?.path === file.path) {
                const userCount = states.size;
                this.statusBarItemEl.setText(`ShadowLink: connected (${userCount} user${userCount !== 1 ? 's' : ''})`);
            }
        });
        
        // Add status handlers for this provider - but don't remove them in cleanup to preserve metadata connection
        if (this.statusHandler) {
            this.provider.on('status', this.statusHandler);
        }
        if (this.connectionCloseHandler) {
            this.provider.on('connection-close', this.connectionCloseHandler);
        }
        if (this.pendingSyncHandler) {
            this.provider.off('sync', this.pendingSyncHandler);
            this.pendingSyncHandler = undefined;
        }

        const ytext = this.doc.getText('content');
        this.currentText = ytext;
        
        // Track document changes for conflict detection
        ytext.observe(() => {
            if (this.currentFile) {
                this.documentVersions.set(this.currentFile.path, ytext.toString());
            }
        });

        const initializeText = async () => {
            console.log('ShadowLink: Initializing text for', file.path, 'Yjs length:', ytext.length);
            
            if (ytext.length === 0) {
                const currentContent = view.editor.getValue();
                console.log('ShadowLink: Empty Yjs doc, inserting current content, length:', currentContent.length);
                ytext.insert(0, currentContent);
                // Store initial version
                if (this.currentFile) {
                    this.documentVersions.set(this.currentFile.path, currentContent);
                }
            } else {
                const newValue = ytext.toString();
                const currentEditorValue = view.editor.getValue();
                
                console.log('ShadowLink: Comparing content - Editor:', currentEditorValue.length, 'Yjs:', newValue.length);
                
                // Don't overwrite content if values are the same
                if (currentEditorValue === newValue) {
                    console.log('ShadowLink: Content already synchronized');
                    return;
                }
                
                // Prevent overwriting valid content with empty content unless intentional
                if (newValue.trim() === '' && currentEditorValue.trim() !== '') {
                    console.warn('ShadowLink: Preventing empty content overwrite for', this.currentFile?.path);
                    // Instead, update the Yjs document with current content to preserve local changes
                    ytext.delete(0, ytext.length);
                    ytext.insert(0, currentEditorValue);
                    if (this.currentFile) {
                        this.documentVersions.set(this.currentFile.path, currentEditorValue);
                    }
                    return;
                }
                
                // Also prevent overwriting new content with old empty content
                if (currentEditorValue.trim() === '' && newValue.trim() !== '') {
                    console.log('ShadowLink: Applying remote content to empty editor');
                } else if (currentEditorValue.trim() !== '' && newValue.trim() !== '') {
                    console.log('ShadowLink: Both editor and Yjs have content, checking for conflicts');
                    // Check for conflicts before applying remote changes
                    if (this.currentFile && this.conflictResolver) {
                        const conflict = await this.detectContentConflicts(this.currentFile, newValue);
                        if (conflict) {
                            console.log('ShadowLink: Conflict detected, resolving...');
                            await this.conflictResolver.resolveConflict(conflict);
                            return;
                        }
                    }
                }
                
                await this.defer();
                // Enhanced race condition check - ensure we're still on the right file
                if (this.currentText !== ytext || this.currentFile?.path !== file?.path) {
                    console.warn('ShadowLink: Race condition detected, aborting content update');
                    return;
                }
                
                console.log('ShadowLink: Applying remote content to editor for', file.path);
                view.editor.setValue(newValue);
                
                // Store the new version
                if (this.currentFile) {
                    this.documentVersions.set(this.currentFile.path, newValue);
                }
            }
        };

        if (this.provider.synced) {
            await initializeText();
        } else {
            this.pendingSyncHandler = async (isSynced: boolean) => {
                // Additional check to ensure we're still on the same file when sync completes
                if (isSynced && this.currentText === ytext && this.currentFile?.path === file?.path) {
                    await initializeText();
                    this.provider?.off('sync', this.pendingSyncHandler!);
                    this.pendingSyncHandler = undefined;
                } else if (isSynced) {
                    console.warn('ShadowLink: Sync completed but file changed, skipping initialization');
                    this.provider?.off('sync', this.pendingSyncHandler!);
                    this.pendingSyncHandler = undefined;
                }
            };
            this.provider.on('sync', this.pendingSyncHandler);
        }

        this.collabExtensions.length = 0;
        this.collabExtensions.push(
            this.yCollab!(ytext, this.provider.awareness),
            this.cmKeymap!.of(this.yUndoManagerKeymap!)
        );
        this.app.workspace.updateOptions();

        // Ensure awareness state is set after collaboration extensions are loaded
        this.ensureAwarenessState();

        // Final content synchronization using CodeMirror
        // This ensures the editor state is fully synchronized after the collaboration setup
        const cm = (view.editor as any).cm as EditorView | undefined;
        if (cm) {
            // Add a small delay to ensure the collaboration extensions are properly initialized
            await this.defer();
            
            const newValue = ytext.toString();
            const currentValue = cm.state.doc.toString();
            
            // Only update if content differs and prevent empty content overwrite
            if (currentValue !== newValue && !(newValue.trim() === '' && currentValue.trim() !== '')) {
                // Final race condition check before applying changes
                if (this.currentText !== ytext || this.currentFile?.path !== file?.path) {
                    console.warn('ShadowLink: Race condition detected in final content sync, aborting');
                    return;
                }
                
                console.log('ShadowLink: Final content synchronization for', file.path);
                cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: newValue } });
            }
        }
    }
}

class ShadowLinkSettingTab extends PluginSettingTab {
    plugin: ShadowLinkPlugin;

    constructor(app: App, plugin: ShadowLinkPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('WebSocket server used for collaboration')
            .addText(text => text
                .setPlaceholder('localhost:1234')
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (value) => {
                    this.plugin.settings.serverUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Username')
            .setDesc('Displayed to collaborators')
            .addText(text => text
                .setPlaceholder('Anonymous')
                .setValue(this.plugin.settings.username)
                .onChange(async (value) => {
                    this.plugin.settings.username = value;
                    await this.plugin.saveSettings();
                    if (this.plugin.provider) {
                        const current = this.plugin.provider.awareness.getLocalState() || {};
                        this.plugin.provider.awareness.setLocalStateField('user', {
                            ...current.user,
                            name: value
                        });
                    }
                }));

        new Setting(containerEl)
            .setName('Auth Token')
            .setDesc('Shared secret required by the server')
            .addText(text => text
                .setPlaceholder('optional')
                .setValue(this.plugin.settings.authToken)
                .onChange(async (value) => {
                    this.plugin.settings.authToken = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Vault ID')
            .setDesc('Identifier for this vault (share this with collaborators)')
            .addText(text => text
                .setPlaceholder('auto')
                .setValue(this.plugin.settings.vaultId)
                .onChange(async (value) => {
                    this.plugin.settings.vaultId = value;
                    this.plugin.vaultId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('User ID')
            .setDesc('Your unique identifier for collaboration')
            .addText(text => text
                .setPlaceholder('auto')
                .setValue(this.plugin.settings.userId)
                .setDisabled(true)); // Read-only display

        // Conflict Resolution section
        containerEl.createEl('h3', { text: 'Conflict Resolution' });
        
        new Setting(containerEl)
            .setName('Conflict Resolution Strategy')
            .setDesc('How to handle conflicts when files are modified offline')
            .addDropdown(dropdown => dropdown
                .addOption('auto', 'Automatic (try to merge, fallback to timestamp)')
                .addOption('manual', 'Manual (always ask user)')
                .addOption('backup', 'Always create backup files')
                .setValue(this.plugin.settings.conflictResolution)
                .onChange(async (value: 'auto' | 'manual' | 'backup') => {
                    this.plugin.settings.conflictResolution = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Create Backup Files')
            .setDesc('Create backup files for conflicts even in auto mode')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.backupConflicts)
                .onChange(async (value) => {
                    this.plugin.settings.backupConflicts = value;
                    await this.plugin.saveSettings();
                }));

        // Offline Operations section
        containerEl.createEl('h3', { text: 'Offline Operations' });
        
        const queueSize = this.plugin.offlineManager?.getQueueSize() || 0;
        const queueStatusEl = containerEl.createEl('p');
        queueStatusEl.textContent = `Queued operations: ${queueSize}`;
        
        if (queueSize > 0) {
            new Setting(containerEl)
                .setName('Clear Offline Queue')
                .setDesc('Remove all queued offline operations (use with caution)')
                .addButton(button => button
                    .setButtonText('Clear Queue')
                    .setWarning()
                    .onClick(() => {
                        this.plugin.offlineManager?.clearQueue();
                        this.display(); // Refresh the display
                        new Notice('Offline queue cleared');
                    }));
        }

        // Vault collaboration section
        containerEl.createEl('h3', { text: 'Vault Collaboration' });
        
        new Setting(containerEl)
            .setName('Share Vault')
            .setDesc('Share your vault ID with others to invite them to collaborate')
            .addButton(button => button
                .setButtonText('Copy Vault ID')
                .onClick(() => {
                    navigator.clipboard.writeText(this.plugin.settings.vaultId);
                    button.setButtonText('Copied!');
                    setTimeout(() => button.setButtonText('Copy Vault ID'), 2000);
                }));

        new Setting(containerEl)
            .setName('Join Vault')
            .setDesc('Enter a vault ID to join someone else\'s vault. This will merge your current vault content with the target vault.')
            .addText(text => text
                .setPlaceholder('Enter vault ID...')
                .onChange(async (value) => {
                    // Store the text value for the button
                    (text.inputEl as any)._pendingVaultId = value;
                }))
            .addButton(button => button
                .setButtonText('Join Vault')
                .onClick(async () => {
                    const textInput = containerEl.querySelector('input[placeholder="Enter vault ID..."]') as HTMLInputElement;
                    const targetVaultId = textInput?.value?.trim();
                    
                    if (targetVaultId && targetVaultId !== this.plugin.settings.vaultId) {
                        await this.joinVault(targetVaultId);
                        if (textInput) textInput.value = ''; // Clear the input
                    } else if (targetVaultId === this.plugin.settings.vaultId) {
                        new Notice('Cannot join your own vault');
                    } else {
                        new Notice('Please enter a valid vault ID');
                    }
                }));

        if (this.plugin.settings.sharedVaults.length > 0) {
            containerEl.createEl('h4', { text: 'Shared Vaults' });
            
            this.plugin.settings.sharedVaults.forEach((vaultId, index) => {
                new Setting(containerEl)
                    .setName(`Shared Vault ${index + 1}`)
                    .setDesc(`Vault ID: ${vaultId}`)
                    .addButton(button => button
                        .setButtonText('Remove')
                        .setWarning()
                        .onClick(async () => {
                            this.plugin.settings.sharedVaults.splice(index, 1);
                            await this.plugin.saveSettings();
                            this.display(); // Refresh the display
                        }));
            });
        }

        // Connection status
        containerEl.createEl('h3', { text: 'Connection Status' });
        const statusEl = containerEl.createEl('p');
        const updateStatus = () => {
            if (this.plugin.provider) {
                const status = this.plugin.provider.wsconnected ? 'Connected' : 'Disconnected';
                const userCount = this.plugin.provider.awareness.getStates().size;
                statusEl.textContent = `${status} - ${userCount} user(s) online`;
            } else {
                statusEl.textContent = 'Not connected';
            }
        };
        updateStatus();
        // Update status every 2 seconds
        const statusInterval = setInterval(updateStatus, 2000);
        // Clean up interval when settings are closed
        this.plugin.register(() => clearInterval(statusInterval));
    }

    /**
     * Join an existing vault by changing the vault ID and reconnecting
     */
    private async joinVault(targetVaultId: string): Promise<void> {
        try {
            // Confirm the action
            const confirmed = await new Promise<boolean>((resolve) => {
                const modal = this.app.workspace.containerEl.createDiv({ cls: 'modal-container' });
                modal.innerHTML = `
                    <div class="modal">
                        <div class="modal-content">
                            <h2>Join Vault</h2>
                            <p>This will merge your current vault content with vault <code>${targetVaultId}</code>.</p>
                            <p>Your current vault content will be preserved and synchronized with the target vault.</p>
                            <p><strong>Continue?</strong></p>
                            <div style="display: flex; gap: 10px; margin-top: 20px;">
                                <button class="mod-cta" data-action="confirm">Join Vault</button>
                                <button data-action="cancel">Cancel</button>
                            </div>
                        </div>
                    </div>
                `;
                
                modal.addEventListener('click', (e) => {
                    const action = (e.target as HTMLElement).getAttribute('data-action');
                    if (action === 'confirm') {
                        resolve(true);
                    } else if (action === 'cancel' || e.target === modal) {
                        resolve(false);
                    }
                    modal.remove();
                });
            });

            if (!confirmed) {
                return;
            }

            // Store the old vault ID for cleanup
            const oldVaultId = this.plugin.settings.vaultId;
            
            // Update the vault ID
            this.plugin.settings.vaultId = targetVaultId;
            this.plugin.vaultId = targetVaultId;
            await this.plugin.saveSettings();

            // Add the old vault to shared vaults list for reference
            if (!this.plugin.settings.sharedVaults.includes(oldVaultId)) {
                this.plugin.settings.sharedVaults.push(oldVaultId);
                await this.plugin.saveSettings();
            }

            // Disconnect current connections
            this.plugin.cleanupCurrent();
            this.plugin.cleanupMetadata();

            // Create new offline manager for the new vault
            this.plugin.offlineManager = new OfflineOperationManager(this.app, targetVaultId);

            // Reconnect with new vault ID
            await this.plugin.connectMetadata();

            // If there's an active file, reconnect to it
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                await this.plugin.handleFileOpenInternal(activeFile);
            }

            new Notice(`Successfully joined vault ${targetVaultId}. Your content will be merged.`, 5000);
            this.display(); // Refresh the settings display

        } catch (error) {
            console.error('Failed to join vault:', error);
            new Notice(`Failed to join vault: ${error.message}`, 5000);
        }
    }
}
