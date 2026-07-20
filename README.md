# Unread Files

An [Obsidian](https://obsidian.md) plugin that adds read/unread tracking to the file explorer. Files that have been created or modified since you last opened them get a visual indicator — a bold filename and a small accent-colored dot — so you can see at a glance what's changed.

## How it works

The plugin tracks the last time you opened each file. If a file's modification time is newer than the last time you opened it, it's "unread."

- **New files** start as unread
- **Modified files** become unread (whether changed by you on another device, by a sync service, by automation, or by another person)
- **Opening a file** marks it as read — the indicator disappears
- **Editing the active file** keeps it read (your own edits don't trigger the indicator)
- **Folders** with unread children show a fainter dot so you can drill down

On first install, all existing files are seeded as "read" so the file explorer doesn't light up. Only changes after installation will trigger indicators.

## Cross-device sync

Read/unread state syncs across devices via Obsidian Sync. The plugin writes a lightweight sync file into the vault that carries read timestamps between machines. When you read a file on one device, it shows as read on all your other devices within about 30 seconds.

**How it works under the hood:**

- Each device maintains a local `data.json` (fast, updates in 2 seconds) and a shared sync file inside the vault (updates every 30 seconds).
- On startup and when the sync file changes, the plugin merges timestamps using a max-wins strategy: for each file, the most recent "last read" time wins. This means two devices can mark different files as read independently and both states converge correctly.
- The sync file only includes paths matching configurable prefixes (by default `notes/` and `personal/`) to keep the file small.

**Requirements for sync:**

1. Obsidian Sync enabled with **"Sync all other types"** turned on (the sync file is JSON)
2. **"Installed community plugins"** toggled on so plugin code propagates to all devices
3. Restart Obsidian on each device after the plugin first syncs

> **⚠️ A note about "Sync all other types":** This setting tells Obsidian Sync to sync every file type in your vault, not just markdown and standard attachments. If your vault contains folders with large files or content you don't want synced (build artifacts, media archives, datasets, etc.), use **Settings → Sync → Excluded folders** to filter them out. The plugin only needs this setting for its JSON sync file — everything else is collateral, so lock it down with exclusions.

## Features

- Accent-colored dot in the file explorer for unread files
- Bold filename text for unread files
- Fainter dot on folders containing unread files
- Cross-device sync via Obsidian Sync
- Right-click context menu: **Mark as read** / **Mark as unread**
- Right-click folders: **Mark folder as read**
- Command palette: **Mark all files as read**
- Handles file renames, deletes, and moves
- Debounced updates for performance

## Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from this repo
2. Create a folder called `unread-files` in your vault's `.obsidian/plugins/` directory
3. Place the three files inside it
4. Restart Obsidian and enable the plugin in **Settings → Community Plugins**

This is not (currently) an official Community Plugin — install is manual, straight from this repo.

## Configuration

The sync file path and folder prefixes are defined as constants at the top of `main.js`:

```javascript
const SYNC_PATH = 'notes/_resources/unread-files-sync.json';
const SYNC_PREFIXES = ['notes/', 'personal/'];
```

Adjust these to match your vault structure if needed.

## How read/unread state is tracked

The plugin stores a JSON map of `{ filePath: lastReadTimestamp }` in its `data.json` file (inside the plugin's directory). When you open a file, the current time is recorded. When the plugin renders the file explorer, it compares each file's filesystem modification time against the stored timestamp. If the file is newer, it's unread.

For cross-device sync, a second copy of this map (filtered to configured prefixes) is written to a JSON file inside the vault where Obsidian Sync can reach it. On load, the plugin merges the local and synced maps, always keeping the most recent timestamp per file.

This means anything that changes a file's modification time — Obsidian Sync, Git, scripts, other plugins, external editors — will cause the file to appear as unread. That's by design.
