// Electron main process for linux-freewrite.
//
// Responsibilities:
//   - Create the (frameless, distraction-free) application window.
//   - Own ALL filesystem access. The renderer is sandboxed
//     (contextIsolation on, nodeIntegration off) and talks to us only
//     through the small API defined in preload.js via ipcRenderer.invoke.
//
// Entry files are stored in the user's Documents/Freewrite folder using the
// exact same naming/format as the macOS and Windows versions so a single
// writing folder is portable across all three platforms.
//
// TODO (follow-up PR): video entries + local speech transcription. The macOS
// app uses AVFoundation + the Speech framework; a Linux port will need a
// webcam capture path plus a local speech-to-text engine (e.g. whisper.cpp),
// writing to ~/Documents/Freewrite/Videos/[UUID]-[timestamp]/ to stay
// format-compatible. Intentionally out of scope for this MVP.

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

let mainWindow = null;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// The shared, cross-platform writing folder: <Documents>/Freewrite.
// app.getPath('documents') resolves the OS's real Documents directory
// (respecting XDG_DOCUMENTS_DIR on Linux) instead of hardcoding ~/Documents.
function getEntriesDir() {
  return path.join(app.getPath('documents'), 'Freewrite');
}

// Ensure the writing folder exists before we read/write in it.
function ensureEntriesDir() {
  const dir = getEntriesDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// App settings (theme, font, etc.) live in Electron's per-app userData dir,
// deliberately OUTSIDE the Freewrite folder so we never drop stray files
// among the user's portable markdown entries.
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    backgroundColor: '#ffffff',
    frame: false, // immersive, distraction-free (matches the mac/Windows apps)
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require(); harmless with contextIsolation on
    },
  });

  // No application menu — keep the UI minimal.
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On Linux/Windows, quit when the last window closes.
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC: filesystem-backed entry storage
// ---------------------------------------------------------------------------

// List all entries: parse each .md filename, build a sidebar preview, and
// return them newest-first. Content is included so the renderer can cache it
// and reason about "empty entries from today" without extra round-trips.
ipcMain.handle('entries:list', async () => {
  const dir = ensureEntriesDir();
  const files = await fsp.readdir(dir);
  const mdFiles = files.filter((f) => f.endsWith('.md'));

  const entries = [];
  for (const filename of mdFiles) {
    // Filenames look like: [UUID]-[YYYY-MM-DD-HH-mm-ss].md
    // First [...] is the UUID; the bracketed group matching the timestamp
    // shape is the creation date. Two separate regexes keeps intent obvious.
    const uuidMatch = filename.match(/\[(.*?)\]/);
    const dateMatch = filename.match(/\[(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\]/);
    if (!uuidMatch || !dateMatch) continue; // skip anything not in our format

    let content = '';
    try {
      content = await fsp.readFile(path.join(dir, filename), 'utf-8');
    } catch {
      content = '';
    }

    entries.push({
      id: uuidMatch[1],
      filename,
      timestamp: dateMatch[1], // raw "YYYY-MM-DD-HH-mm-ss" for sorting/today checks
      content,
    });
  }

  // Newest first, by the timestamp embedded in the filename.
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return entries;
});

ipcMain.handle('entries:read', async (_event, filename) => {
  const dir = getEntriesDir();
  return fsp.readFile(path.join(dir, filename), 'utf-8');
});

ipcMain.handle('entries:save', async (_event, { filename, content }) => {
  const dir = ensureEntriesDir();
  await fsp.writeFile(path.join(dir, filename), content, 'utf-8');
  return { ok: true, path: path.join(dir, filename) };
});

ipcMain.handle('entries:delete', async (_event, filename) => {
  const dir = getEntriesDir();
  try {
    await fsp.unlink(path.join(dir, filename));
  } catch (err) {
    // Already gone is fine; anything else is a real error.
    if (err.code !== 'ENOENT') throw err;
  }
  return { ok: true };
});

// The onboarding text, adapted for Linux (bundled next to this file).
ipcMain.handle('welcome:get', async () => {
  try {
    return await fsp.readFile(path.join(__dirname, 'default.md'), 'utf-8');
  } catch {
    return '';
  }
});

// ---------------------------------------------------------------------------
// IPC: settings (theme/font persistence)
// ---------------------------------------------------------------------------

ipcMain.handle('settings:get', async () => {
  try {
    const raw = await fsp.readFile(getSettingsPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {}; // no settings yet
  }
});

ipcMain.handle('settings:set', async (_event, settings) => {
  await fsp.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: misc (external links, clipboard, PDF export)
// ---------------------------------------------------------------------------

ipcMain.handle('shell:openExternal', async (_event, url) => {
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('clipboard:write', async (_event, text) => {
  clipboard.writeText(text);
  return { ok: true };
});

// Export the given plain text as a PDF via a native save dialog.
// We render the text in an offscreen window (not the app UI) so the PDF
// contains only the entry, then use webContents.printToPDF.
ipcMain.handle('pdf:export', async (_event, { content, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export entry as PDF',
    defaultPath: suggestedName || 'freewrite-entry.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const pdfWindow = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    // Escape the text and preserve line breaks/whitespace with <pre>.
    const escaped = String(content)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>
        body { margin: 48px; }
        pre { font-family: Georgia, 'Times New Roman', serif; font-size: 14px;
              line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; }
      </style></head><body><pre>${escaped}</pre></body></html>`;

    await pdfWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdfData = await pdfWindow.webContents.printToPDF({ printBackground: true });
    await fsp.writeFile(filePath, pdfData);
    return { ok: true, path: filePath };
  } finally {
    pdfWindow.destroy();
  }
});
