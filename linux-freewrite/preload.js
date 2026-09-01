// Preload script: the ONLY bridge between the sandboxed renderer and Node.
//
// With contextIsolation on, the renderer cannot touch Node/Electron directly.
// We expose a small, explicit API on window.freewrite; each method just
// forwards to a matching ipcMain.handle(...) in main.js. Keeping this surface
// tiny is what makes the app safe to run with nodeIntegration disabled.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freewrite', {
  // Entries (filesystem-backed markdown files in <Documents>/Freewrite)
  listEntries: () => ipcRenderer.invoke('entries:list'),
  readEntry: (filename) => ipcRenderer.invoke('entries:read', filename),
  saveEntry: (filename, content) => ipcRenderer.invoke('entries:save', { filename, content }),
  deleteEntry: (filename) => ipcRenderer.invoke('entries:delete', filename),
  getWelcomeText: () => ipcRenderer.invoke('welcome:get'),

  // Settings (theme/font persistence in the app's userData dir)
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  // Misc
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  exportPdf: (content, suggestedName) =>
    ipcRenderer.invoke('pdf:export', { content, suggestedName }),
});
