import {
    Plugin,
    TFile,
    TFolder,
    TAbstractFile,
    Notice,
    WorkspaceLeaf,
} from 'obsidian';

// ── Types ─────────────────────────────────────────────────────────

interface UnreadFilesData {
    readTimestamps: Record<string, number>;
    initialized: boolean;
}

interface SyncFileData {
    readTimestamps: Record<string, number>;
}

const DEFAULT_DATA: UnreadFilesData = {
    readTimestamps: {},
    initialized: false,
};

const SYNC_PATH = 'notes/_resources/unread-files-sync.json';
const SYNC_PREFIXES = ['notes/', 'personal/'];

// Internal Obsidian API — not in the public type definitions
interface FileExplorerItem {
    el: HTMLElement;
    selfEl: HTMLElement;
    innerEl?: HTMLElement;
    file: TAbstractFile;
}

interface FileExplorerView {
    fileItems: Record<string, FileExplorerItem>;
}

// ── Plugin ────────────────────────────────────────────────────────

export default class UnreadFilesPlugin extends Plugin {
    data: UnreadFilesData = { ...DEFAULT_DATA };
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private syncSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSyncWrite = 0;

    async onload(): Promise<void> {
        const stored = await this.loadData();
        this.data = Object.assign({ ...DEFAULT_DATA }, stored);

        // Merge any synced state from other machines
        await this.loadSyncFile();

        // First run: seed every existing file as "read" so the explorer
        // doesn't light up like a Christmas tree on install.
        if (!this.data.initialized) {
            this.seedAllFiles();
            this.data.initialized = true;
            await this.saveData(this.data);
            await this.saveSyncFile();
        }

        // ── Events ────────────────────────────────────────────

        // File opened → mark as read
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file && file.path !== SYNC_PATH) {
                    this.data.readTimestamps[file.path] = Date.now();
                    this.debouncedSave();
                    this.debouncedRefresh();
                }
            }),
        );

        // File modified → if user is actively editing it, keep it read.
        // Also watch for sync file updates arriving from other machines.
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file.path === SYNC_PATH) {
                    // Ignore our own writes (within 2s of last write)
                    if (Date.now() - this.lastSyncWrite > 2000) {
                        this.loadSyncFile().then(() => {
                            this.debouncedLocalSave();
                            this.debouncedRefresh();
                        });
                    }
                    return;
                }
                const active = this.app.workspace.getActiveFile();
                if (active && active.path === file.path) {
                    this.data.readTimestamps[file.path] = Date.now();
                    this.debouncedSave();
                }
                this.debouncedRefresh();
            }),
        );

        // File created → refresh (new files start as unread)
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file.path !== SYNC_PATH) this.debouncedRefresh();
            }),
        );

        // File deleted → clean up stored timestamp
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file.path === SYNC_PATH) return;
                delete this.data.readTimestamps[file.path];
                this.debouncedSave();
                this.debouncedRefresh();
            }),
        );

        // File renamed → migrate the timestamp to the new path
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file.path === SYNC_PATH) return;
                if (this.data.readTimestamps[oldPath] !== undefined) {
                    this.data.readTimestamps[file.path] =
                        this.data.readTimestamps[oldPath];
                    delete this.data.readTimestamps[oldPath];
                    this.debouncedSave();
                }
                this.debouncedRefresh();
            }),
        );

        // Re-paint whenever the layout changes (sidebar opens, panes move)
        this.registerEvent(
            this.app.workspace.on('layout-change', () =>
                this.debouncedRefresh(),
            ),
        );

        // ── Context menus ─────────────────────────────────────

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, abstractFile) => {
                if (abstractFile instanceof TFile) {
                    if (abstractFile.path === SYNC_PATH) return;
                    if (this.isUnread(abstractFile)) {
                        menu.addItem((item) => {
                            item.setTitle('Mark as read')
                                .setIcon('check')
                                .onClick(() => {
                                    this.data.readTimestamps[
                                        abstractFile.path
                                    ] = Date.now();
                                    this.debouncedSave();
                                    this.debouncedRefresh();
                                });
                        });
                    } else {
                        menu.addItem((item) => {
                            item.setTitle('Mark as unread')
                                .setIcon('circle')
                                .onClick(() => {
                                    this.data.readTimestamps[
                                        abstractFile.path
                                    ] = 0;
                                    this.debouncedSave();
                                    this.debouncedRefresh();
                                });
                        });
                    }
                } else if (abstractFile instanceof TFolder) {
                    if (this.folderHasUnread(abstractFile)) {
                        menu.addItem((item) => {
                            item.setTitle('Mark folder as read')
                                .setIcon('check-circle')
                                .onClick(() =>
                                    this.markFolderRead(abstractFile),
                                );
                        });
                    }
                }
            }),
        );

        // ── Commands ──────────────────────────────────────────

        this.addCommand({
            id: 'mark-all-read',
            name: 'Mark all files as read',
            callback: () => this.markAllRead(),
        });

        // ── Initial paint ─────────────────────────────────────

        this.app.workspace.onLayoutReady(() => this.refreshExplorer());
    }

    // ── Sync file ─────────────────────────────────────────────────

    private async loadSyncFile(): Promise<void> {
        try {
            const exists = await this.app.vault.adapter.exists(SYNC_PATH);
            if (!exists) return;
            const raw = await this.app.vault.adapter.read(SYNC_PATH);
            const synced: SyncFileData = JSON.parse(raw);
            if (synced?.readTimestamps) {
                // Merge: always keep the most recent read timestamp per file
                for (const [path, ts] of Object.entries(
                    synced.readTimestamps,
                )) {
                    if (
                        !this.data.readTimestamps[path] ||
                        ts > this.data.readTimestamps[path]
                    ) {
                        this.data.readTimestamps[path] = ts;
                    }
                }
            }
        } catch (e) {
            console.log('Unread Files: could not load sync file', e);
        }
    }

    private shouldSync(path: string): boolean {
        return SYNC_PREFIXES.some((p) => path.startsWith(p));
    }

    private async saveSyncFile(): Promise<void> {
        try {
            this.lastSyncWrite = Date.now();
            const filtered: Record<string, number> = {};
            for (const [path, ts] of Object.entries(
                this.data.readTimestamps,
            )) {
                if (this.shouldSync(path)) filtered[path] = ts;
            }
            const payload = JSON.stringify({ readTimestamps: filtered });
            await this.app.vault.adapter.write(SYNC_PATH, payload);
        } catch (e) {
            console.log('Unread Files: could not save sync file', e);
        }
    }

    // ── Core logic ────────────────────────────────────────────────

    private seedAllFiles(): void {
        for (const file of this.app.vault.getFiles()) {
            if (file.path !== SYNC_PATH) {
                this.data.readTimestamps[file.path] = file.stat.mtime;
            }
        }
    }

    private isUnread(file: TAbstractFile): boolean {
        if (!(file instanceof TFile)) return false;
        if (file.path === SYNC_PATH) return false;
        const lastRead = this.data.readTimestamps[file.path];
        if (lastRead === undefined) return true; // never seen → unread
        return file.stat.mtime > lastRead;
    }

    private folderHasUnread(folder: TFolder): boolean {
        if (!folder.children) return false;
        for (const child of folder.children) {
            if (child instanceof TFile && this.isUnread(child)) return true;
            if (child instanceof TFolder && this.folderHasUnread(child))
                return true;
        }
        return false;
    }

    private markFolderRead(folder: TFolder): void {
        const now = Date.now();
        const walk = (f: TFolder): void => {
            for (const child of f.children) {
                if (child instanceof TFile && child.path !== SYNC_PATH) {
                    this.data.readTimestamps[child.path] = now;
                } else if (child instanceof TFolder) {
                    walk(child);
                }
            }
        };
        walk(folder);
        this.debouncedSave();
        this.debouncedRefresh();
        new Notice('Folder marked as read');
    }

    private markAllRead(): void {
        const now = Date.now();
        for (const file of this.app.vault.getFiles()) {
            if (file.path !== SYNC_PATH) {
                this.data.readTimestamps[file.path] = now;
            }
        }
        this.debouncedSave();
        this.debouncedRefresh();
        new Notice('All files marked as read');
    }

    // ── Debounced operations ──────────────────────────────────────

    /** Save local data.json only (after receiving remote sync merge) */
    private debouncedLocalSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveData(this.data), 2000);
    }

    /** Save local data.json (2s debounce) + sync file (30s debounce) */
    private debouncedSave(): void {
        this.debouncedLocalSave();
        if (this.syncSaveTimer) clearTimeout(this.syncSaveTimer);
        this.syncSaveTimer = setTimeout(() => this.saveSyncFile(), 30000);
    }

    private debouncedRefresh(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refreshExplorer(), 150);
    }

    // ── Explorer DOM manipulation ─────────────────────────────────

    private refreshExplorer(): void {
        const leaves: WorkspaceLeaf[] =
            this.app.workspace.getLeavesOfType('file-explorer');

        for (const leaf of leaves) {
            const view = leaf.view as unknown as FileExplorerView;
            if (!view?.fileItems) continue;

            const foldersWithUnread = new Set<string>();
            const items = view.fileItems;

            // Pass 1 — files: add/remove .is-unread and collect ancestor folders
            for (const path of Object.keys(items)) {
                const item = items[path];
                const selfEl = item.selfEl || item.el;
                if (!selfEl) continue;

                const abstractFile =
                    this.app.vault.getAbstractFileByPath(path);
                if (!abstractFile || !(abstractFile instanceof TFile))
                    continue;

                if (this.isUnread(abstractFile)) {
                    selfEl.classList.add('is-unread');
                    let parent = abstractFile.parent;
                    while (parent) {
                        if (parent.path !== undefined)
                            foldersWithUnread.add(parent.path);
                        parent = parent.parent;
                    }
                } else {
                    selfEl.classList.remove('is-unread');
                }
            }

            // Pass 2 — folders: add/remove .has-unread
            for (const path of Object.keys(items)) {
                const item = items[path];
                const selfEl = item.selfEl || item.el;
                if (!selfEl) continue;

                const abstractFile =
                    this.app.vault.getAbstractFileByPath(path);
                if (!abstractFile || !(abstractFile instanceof TFolder))
                    continue;

                if (foldersWithUnread.has(path)) {
                    selfEl.classList.add('has-unread');
                } else {
                    selfEl.classList.remove('has-unread');
                }
            }
        }
    }

    // ── Cleanup ───────────────────────────────────────────────────

    onunload(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveData(this.data);
        }
        if (this.syncSaveTimer) {
            clearTimeout(this.syncSaveTimer);
            this.saveSyncFile();
        }
        document
            .querySelectorAll('.is-unread')
            .forEach((el) => el.classList.remove('is-unread'));
        document
            .querySelectorAll('.has-unread')
            .forEach((el) => el.classList.remove('has-unread'));
    }
}
