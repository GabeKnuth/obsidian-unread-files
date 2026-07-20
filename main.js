'use strict';

const obsidian = require('obsidian');

const SYNC_PATH = 'notes/_resources/unread-files-sync.json';
const SYNC_PREFIXES = ['notes/', 'personal/'];

class UnreadFilesPlugin extends obsidian.Plugin {

    async onload() {
        this.data = Object.assign(
            { readTimestamps: {}, initialized: false },
            await this.loadData()
        );

        this._refreshTimer = null;
        this._saveTimer = null;
        this._syncSaveTimer = null;
        this._lastSyncWrite = 0;

        // Merge any synced state from other machines
        await this._loadSyncFile();

        // First run: seed every existing file as "read" so the explorer
        // doesn't light up like a Christmas tree on install.
        if (!this.data.initialized) {
            this._seedAllFiles();
            this.data.initialized = true;
            await this.saveData(this.data);
            await this._saveSyncFile();
        }

        // ── Events ────────────────────────────────────────────────

        // File opened → mark as read
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file && file.path !== SYNC_PATH) {
                    this.data.readTimestamps[file.path] = Date.now();
                    this._debouncedSave();
                    this._debouncedRefresh();
                }
            })
        );

        // File modified → if user is actively editing it, keep it read.
        // Also watch for sync file updates arriving from other machines.
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file.path === SYNC_PATH) {
                    // Ignore our own writes (within 2s of last write)
                    if (Date.now() - this._lastSyncWrite > 2000) {
                        this._loadSyncFile().then(() => {
                            this._debouncedLocalSave();
                            this._debouncedRefresh();
                        });
                    }
                    return;
                }
                const active = this.app.workspace.getActiveFile();
                if (active && active.path === file.path) {
                    this.data.readTimestamps[file.path] = Date.now();
                    this._debouncedSave();
                }
                this._debouncedRefresh();
            })
        );

        // File created → refresh (new files start as unread)
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file.path !== SYNC_PATH) this._debouncedRefresh();
            })
        );

        // File deleted → clean up stored timestamp
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file.path === SYNC_PATH) return;
                delete this.data.readTimestamps[file.path];
                this._debouncedSave();
                this._debouncedRefresh();
            })
        );

        // File renamed → migrate the timestamp to the new path
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file.path === SYNC_PATH) return;
                if (this.data.readTimestamps[oldPath] !== undefined) {
                    this.data.readTimestamps[file.path] =
                        this.data.readTimestamps[oldPath];
                    delete this.data.readTimestamps[oldPath];
                    this._debouncedSave();
                }
                this._debouncedRefresh();
            })
        );

        // Re-paint whenever the layout changes (sidebar opens, panes move, etc.)
        this.registerEvent(
            this.app.workspace.on('layout-change', () => this._debouncedRefresh())
        );

        // ── Context menus ─────────────────────────────────────────

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, abstractFile) => {
                if (abstractFile instanceof obsidian.TFile) {
                    if (abstractFile.path === SYNC_PATH) return;
                    if (this._isUnread(abstractFile)) {
                        menu.addItem((item) => {
                            item.setTitle('Mark as read')
                                .setIcon('check')
                                .onClick(() => {
                                    this.data.readTimestamps[abstractFile.path] =
                                        Date.now();
                                    this._debouncedSave();
                                    this._debouncedRefresh();
                                });
                        });
                    } else {
                        menu.addItem((item) => {
                            item.setTitle('Mark as unread')
                                .setIcon('circle')
                                .onClick(() => {
                                    this.data.readTimestamps[abstractFile.path] =
                                        -Date.now();
                                    this._debouncedSave();
                                    this._debouncedRefresh();
                                });
                        });
                    }
                } else if (abstractFile instanceof obsidian.TFolder) {
                    if (this._folderHasUnread(abstractFile)) {
                        menu.addItem((item) => {
                            item.setTitle('Mark folder as read')
                                .setIcon('check-circle')
                                .onClick(() =>
                                    this._markFolderRead(abstractFile)
                                );
                        });
                    }
                }
            })
        );

        // ── Commands ──────────────────────────────────────────────

        this.addCommand({
            id: 'mark-all-read',
            name: 'Mark all files as read',
            callback: () => this._markAllRead(),
        });

        // ── Initial paint ─────────────────────────────────────────

        this.app.workspace.onLayoutReady(() => this._refreshExplorer());
    }

    // ── Sync file ─────────────────────────────────────────────────

    async _loadSyncFile() {
        try {
            const exists = await this.app.vault.adapter.exists(SYNC_PATH);
            if (!exists) return;
            const raw = await this.app.vault.adapter.read(SYNC_PATH);
            const synced = JSON.parse(raw);
            if (synced && synced.readTimestamps) {
                // Merge: keep the most recent action per file.
                // Positive = read at that time, negative = marked unread at abs(time).
                for (const [path, ts] of Object.entries(synced.readTimestamps)) {
                    const local = this.data.readTimestamps[path];
                    if (local === undefined) {
                        this.data.readTimestamps[path] = ts;
                    } else {
                        const localTime = Math.abs(local);
                        const remoteTime = Math.abs(ts);
                        if (remoteTime > localTime) {
                            this.data.readTimestamps[path] = ts;
                        }
                    }
                }
            }
        } catch (e) {
            console.log('Unread Files: could not load sync file', e);
        }
    }

    _shouldSync(path) {
        return SYNC_PREFIXES.some((p) => path.startsWith(p));
    }

    async _saveSyncFile() {
        try {
            // Sorted keys → byte-identical payloads across machines for the
            // same logical state. Required for the idempotency check below.
            const filtered = {};
            for (const path of Object.keys(this.data.readTimestamps).sort()) {
                if (this._shouldSync(path))
                    filtered[path] = this.data.readTimestamps[path];
            }
            const payload = JSON.stringify({ readTimestamps: filtered });
            // Idempotent write: if the on-disk content is already identical,
            // don't write. Without this, two machines ping-pong through
            // Obsidian Sync forever (write → sync → remote merge → remote
            // write → sync back → ...) at a ~40s cycle, and every write
            // fires the file-watcher LaunchAgent. Found 2026-07-20.
            const exists = await this.app.vault.adapter.exists(SYNC_PATH);
            if (exists) {
                const current = await this.app.vault.adapter.read(SYNC_PATH);
                if (current === payload) return;
            }
            this._lastSyncWrite = Date.now();
            await this.app.vault.adapter.write(SYNC_PATH, payload);
        } catch (e) {
            console.log('Unread Files: could not save sync file', e);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────

    _seedAllFiles() {
        for (const file of this.app.vault.getFiles()) {
            if (file.path !== SYNC_PATH) {
                this.data.readTimestamps[file.path] = file.stat.mtime;
            }
        }
    }

    _isUnread(file) {
        if (!(file instanceof obsidian.TFile)) return false;
        if (file.path === SYNC_PATH) return false;
        const lastRead = this.data.readTimestamps[file.path];
        if (lastRead === undefined) return true; // never seen → unread
        if (lastRead < 0) return true; // explicitly marked unread
        return file.stat.mtime > lastRead;
    }

    _folderHasUnread(folder) {
        if (!folder.children) return false;
        for (const child of folder.children) {
            if (child instanceof obsidian.TFile && this._isUnread(child))
                return true;
            if (
                child instanceof obsidian.TFolder &&
                this._folderHasUnread(child)
            )
                return true;
        }
        return false;
    }

    _markFolderRead(folder) {
        const now = Date.now();
        const walk = (f) => {
            if (!f.children) return;
            for (const child of f.children) {
                if (child instanceof obsidian.TFile && child.path !== SYNC_PATH) {
                    this.data.readTimestamps[child.path] = now;
                } else if (child instanceof obsidian.TFolder) {
                    walk(child);
                }
            }
        };
        walk(folder);
        this._debouncedSave();
        this._debouncedRefresh();
        new obsidian.Notice('Folder marked as read');
    }

    _markAllRead() {
        const now = Date.now();
        for (const file of this.app.vault.getFiles()) {
            if (file.path !== SYNC_PATH) {
                this.data.readTimestamps[file.path] = now;
            }
        }
        this._debouncedSave();
        this._debouncedRefresh();
        new obsidian.Notice('All files marked as read');
    }

    // ── Debounced operations ──────────────────────────────────────

    /** Save local data.json only (after receiving remote sync merge) */
    _debouncedLocalSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.saveData(this.data), 2000);
    }

    /** Save local data.json (2s debounce) + sync file (30s debounce) */
    _debouncedSave() {
        this._debouncedLocalSave();
        if (this._syncSaveTimer) clearTimeout(this._syncSaveTimer);
        this._syncSaveTimer = setTimeout(() => this._saveSyncFile(), 30000);
    }

    _debouncedRefresh() {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => this._refreshExplorer(), 150);
    }

    // ── Explorer DOM manipulation ─────────────────────────────────

    _refreshExplorer() {
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');

        for (const leaf of leaves) {
            const view = leaf.view;
            if (!view || !view.fileItems) continue;

            const foldersWithUnread = new Set();
            const items = view.fileItems;

            // Pass 1 — files
            for (const path of Object.keys(items)) {
                const item = items[path];
                const selfEl = item.selfEl || item.el;
                if (!selfEl) continue;

                const abstractFile =
                    this.app.vault.getAbstractFileByPath(path);
                if (!abstractFile || !(abstractFile instanceof obsidian.TFile))
                    continue;

                if (this._isUnread(abstractFile)) {
                    selfEl.classList.add('is-unread');
                    // Bubble up: flag every ancestor folder
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

            // Pass 2 — folders
            for (const path of Object.keys(items)) {
                const item = items[path];
                const selfEl = item.selfEl || item.el;
                if (!selfEl) continue;

                const abstractFile =
                    this.app.vault.getAbstractFileByPath(path);
                if (
                    !abstractFile ||
                    !(abstractFile instanceof obsidian.TFolder)
                )
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

    onunload() {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this.saveData(this.data);
        }
        if (this._syncSaveTimer) {
            clearTimeout(this._syncSaveTimer);
            this._saveSyncFile();
        }
        document
            .querySelectorAll('.is-unread')
            .forEach((el) => el.classList.remove('is-unread'));
        document
            .querySelectorAll('.has-unread')
            .forEach((el) => el.classList.remove('has-unread'));
    }
}

module.exports = UnreadFilesPlugin;
