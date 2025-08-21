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
            
            switch (event.status) {
                case 'connected':
                    this.isOnline = true;
                    this.statusBarItemEl.setText('ShadowLink: connected');
                    break;
                case 'disconnected':
                    this.isOnline = false;
                    this.statusBarItemEl.setText('ShadowLink: disconnected');
                    break;
                default:
                    this.statusBarItemEl.setText('ShadowLink: ' + event.status);
            }
            
            // Update offline manager about connection status
            if (this.offlineManager && wasOnline !== this.isOnline) {
                this.offlineManager.setOnlineStatus(this.isOnline);
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

    private cleanupCurrent() {
        if (this.isCleaningUp) return; // Prevent recursive cleanup
        
        if (this.provider && this.statusHandler) {
            this.provider.off('status', this.statusHandler);
        }
        if (this.provider && this.connectionCloseHandler) {
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

    private cleanupMetadata() {
        this.metadataProvider?.destroy();
        this.metadataDoc?.destroy();
        this.metadataProvider = null;
        this.metadataDoc = null;
    }

    private async connectMetadata(): Promise<void> {
        await this.loadCollabModules();
        const url = this.resolveServerUrl(this.settings.serverUrl);
        this.metadataDoc = new this.Y!.Doc();
        this.metadataProvider = new this.WebsocketProviderClass!(url, this.metadataDocName(), this.metadataDoc, {
            params: { 
                token: this.settings.authToken,
                vaultId: this.vaultId,
                userId: this.settings.userId
            }
        });
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
        
        // Handle conflicts during sync
        const conflicts: ConflictInfo[] = [];
        
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
        
        // Process conflicts
        for (const conflict of conflicts) {
            if (this.conflictResolver) {
                await this.conflictResolver.resolveConflict(conflict);
            }
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
        
        if (this.metadataDoc) {
            const arr = this.metadataDoc.getArray<string>('paths');
            const idx = arr.toArray().indexOf(file.path);
            if (idx >= 0) arr.delete(idx, 1);
        }
        
        // Optionally inform the server about the deletion
        const doc = new this.Y!.Doc();
        const url = this.resolveServerUrl(this.settings.serverUrl);
        const provider = new this.WebsocketProviderClass!(url, this.docNameForFile(file), doc, {
            params: { 
                token: this.settings.authToken,
                vaultId: this.vaultId,
                userId: this.settings.userId
            }
        });
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
        
        if (this.metadataDoc) {
            const arr = this.metadataDoc.getArray<string>('paths');
            if (!arr.toArray().includes(file.path)) {
                arr.push([file.path]);
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
            const provider = new this.WebsocketProviderClass!(url, `${this.vaultId}/${oldPath}`, doc, {
                params: { 
                    token: this.settings.authToken,
                    vaultId: this.vaultId,
                    userId: this.settings.userId
                }
            });
            const text = doc.getText('content');
            provider.once('sync', () => {
                text.delete(0, text.length);
                provider.destroy();
                doc.destroy();
            });
            await this.handleFileOpenDebounced(file);
        }
        if (this.metadataDoc) {
            const arr = this.metadataDoc.getArray<string>('paths');
            const list = arr.toArray();
            const oldIdx = list.indexOf(oldPath);
            if (oldIdx >= 0) arr.delete(oldIdx, 1);
            if (!list.includes(file.path)) arr.push([file.path]);
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
        
        // Sync folder structure to metadata
        if (this.metadataDoc) {
            const foldersArray = this.metadataDoc.getArray<string>('folders');
            if (!foldersArray.toArray().includes(file.path)) {
                foldersArray.push([file.path]);
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
        
        // Remove from metadata
        if (this.metadataDoc) {
            const foldersArray = this.metadataDoc.getArray<string>('folders');
            const idx = foldersArray.toArray().indexOf(file.path);
            if (idx >= 0) foldersArray.delete(idx, 1);
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

    private async handleFileOpenInternal(file: TFile | null) {
        await this.loadCollabModules();
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!file || !view) {
            this.cleanupCurrent();
            return;
        }

        if (this.currentFile && this.currentFile.path === file.path) {
            return;
        }

        this.cleanupCurrent();

        const url = this.resolveServerUrl(this.settings.serverUrl);
        const docName = this.docNameForFile(file);
        this.doc = new this.Y!.Doc();
        this.idb = new this.IndexeddbPersistenceClass!(docName, this.doc);
        await this.idb.whenSynced;
        
        this.provider = new this.WebsocketProviderClass!(url, docName, this.doc, {
            params: { 
                token: this.settings.authToken,
                vaultId: this.vaultId,
                userId: this.settings.userId
            }
        });
        
        // Enhanced sync handling with conflict detection
        this.provider.once('sync', async () => {
            const ytext = this.doc?.getText('content');
            if (!ytext) return;
            
            const remoteContent = ytext.toString();
            
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
            
            await this.idb?.clearData();
        });
        
        this.currentFile = file;

        const clientId = this.provider.awareness.clientID;
        const hue = clientId % 360;
        const color = this.colorFromId(clientId);
        this.provider.awareness.setLocalStateField('user', {
            name: this.settings.username,
            color,
            colorLight: `hsla(${hue}, 80%, 50%, 0.2)`
        });
        
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
            if (ytext.length === 0) {
                const currentContent = view.editor.getValue();
                ytext.insert(0, currentContent);
                // Store initial version
                if (this.currentFile) {
                    this.documentVersions.set(this.currentFile.path, currentContent);
                }
            } else {
                const newValue = ytext.toString();
                const currentEditorValue = view.editor.getValue();
                
                // Don't overwrite content if values are the same
                if (currentEditorValue === newValue) return;
                
                // Prevent overwriting valid content with empty content unless intentional
                if (newValue.trim() === '' && currentEditorValue.trim() !== '') {
                    console.warn('ShadowLink: Preventing empty content overwrite for', this.currentFile?.path);
                    // Instead, update the Yjs document with current content
                    ytext.delete(0, ytext.length);
                    ytext.insert(0, currentEditorValue);
                    if (this.currentFile) {
                        this.documentVersions.set(this.currentFile.path, currentEditorValue);
                    }
                    return;
                }
                
                // Check for conflicts before applying remote changes
                if (this.currentFile && this.conflictResolver) {
                    const conflict = await this.detectContentConflicts(this.currentFile, newValue);
                    if (conflict) {
                        await this.conflictResolver.resolveConflict(conflict);
                        return;
                    }
                }
                
                await this.defer();
                // Enhanced race condition check - ensure we're still on the right file
                if (this.currentText !== ytext || this.currentFile?.path !== file?.path) {
                    console.warn('ShadowLink: Race condition detected, aborting content update');
                    return;
                }
                
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
                if (isSynced && this.currentText === ytext) {
                    await initializeText();
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

        const cm = (view.editor as any).cm as EditorView | undefined;
        if (cm) {
            const newValue = ytext.toString();
            const currentValue = cm.state.doc.toString();
            
            // Only update if content differs and prevent empty content overwrite
            if (currentValue !== newValue && !(newValue.trim() === '' && currentValue.trim() !== '')) {
                await this.defer();
                // Enhanced race condition check
                if (this.currentText !== ytext || this.currentFile?.path !== file?.path) {
                    console.warn('ShadowLink: Race condition detected in final content update, aborting');
                    return;
                }
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
            .setDesc('Enter a vault ID to join someone else\'s vault')
            .addText(text => text
                .setPlaceholder('Enter vault ID...')
                .onChange(async (value) => {
                    if (value && value !== this.plugin.settings.vaultId) {
                        if (!this.plugin.settings.sharedVaults.includes(value)) {
                            this.plugin.settings.sharedVaults.push(value);
                            await this.plugin.saveSettings();
                            this.display(); // Refresh the display
                        }
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
}
