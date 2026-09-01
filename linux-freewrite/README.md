# Freewrite for Linux

A simple, open-source Linux app to [freewrite](https://writingprocess.mit.edu/process/step-1-generate-ideas/instructions/freewriting/).

This is a Linux port of the original macOS app, built with Electron. It follows
the same pattern as the community Windows port: a self-contained app in its own
top-level folder that leaves the original Swift code untouched.

Entries are stored in the **exact same format** as the macOS and Windows
versions, so a single `Freewrite` folder is portable across all three
platforms.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (includes `npm`)
- A Linux desktop environment (X11 or Wayland)

## Run it (dev)

```bash
cd linux-freewrite
npm install
npm start
```

`npm start` launches the Electron app.

## Build / packaging

Packaging as a distributable (`.AppImage` / `.deb` / `.rpm` / Flatpak) is a
planned fast-follow and is **not** set up yet. For now, run it from source with
`npm start` as shown above.

## Where your writing is stored

All entries are plain Markdown files in your Documents folder:

```
~/Documents/Freewrite/
```

(The exact location follows your system's Documents directory, e.g.
`XDG_DOCUMENTS_DIR`.) Each text entry is a UTF-8 `.md` file named
`[UUID]-[YYYY-MM-DD-HH-mm-ss].md` — the same scheme used by the macOS and
Windows apps, so you can sync/copy this folder between machines.

App preferences (theme, font, size) are stored separately in Electron's
per-app data directory and never clutter your writing folder.

## Features

- Distraction-free, frameless writing window
- History sidebar listing all your entries (newest first) with previews
- Continuous auto-save (no save button)
- Automatic new entry per day; welcome guide on first launch
- Delete entries
- Focus timer (click to start/pause, double-click to reset, scroll to adjust in
  5-minute steps)
- Font size (16–26px) and family (Lato, System, Serif, Mono, Random)
- Dark / light mode (remembered across restarts)
- Optional "No Backspace" mode to keep you writing forward
- "Chat" buttons that open your entry in ChatGPT or Claude with a reflection
  prompt (falls back to copying the prompt to your clipboard if the entry is
  very long)
- Export the current entry to PDF

## Known limitations

- **No video recording / speech transcription yet.** The macOS version uses
  Apple's AVFoundation and Speech frameworks, which have no direct Linux
  equivalent. A Linux implementation (likely a webcam capture library plus a
  local speech-to-text engine such as whisper.cpp) is deferred to a follow-up
  PR. See the `TODO` in `main.js`/`renderer.js` scope notes.
- No packaging yet (run via `npm start`).

## License

MIT (same as the rest of the project).
