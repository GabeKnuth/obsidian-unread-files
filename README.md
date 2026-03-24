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

## Features

- Accent-colored dot in the file explorer for unread files
- Bold filename text for unread files
- Fainter dot on folders containing unread files
- Right-click context menu: **Mark as read** / **Mark as unread**
- Right-click folders: **Mark folder as read**
- Command palette: **Mark all files as read**
- Handles file renames, deletes, and moves
- Debounced updates for performance

## Installation

### From Obsidian Community Plugins

1. Open **Settings → Community Plugins**
2. Search for "Unread Files"
3. Click **Install**, then **Enable**

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/gabeknuth/obsidian-unread-files/releases)
2. Create a folder called `unread-files` in your vault's `.obsidian/plugins/` directory
3. Place the three files inside it
4. Restart Obsidian and enable the plugin in **Settings → Community Plugins**

### With BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) if you don't have it
2. In BRAT settings, click **Add Beta Plugin**
3. Enter: `gabeknuth/obsidian-unread-files`

## Building from source

```bash
npm install
npm run build
```

This outputs `main.js` in the project root. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/unread-files/` directory.

## How read/unread state is tracked

The plugin stores a JSON map of `{ filePath: lastReadTimestamp }` in its `data.json` file (inside the plugin's directory). When you open a file, the current time is recorded. When the plugin renders the file explorer, it compares each file's filesystem modification time against the stored timestamp. If the file is newer, it's unread.

This means anything that changes a file's modification time — Obsidian Sync, Git, scripts, other plugins, external editors — will cause the file to appear as unread. That's by design.
