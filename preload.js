const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundbridg', {
  // Auth
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),
  logout: () => ipcRenderer.invoke('logout'),
  getAuthState: () => ipcRenderer.invoke('get-auth-state'),

  // Sync
  getSyncState: () => ipcRenderer.invoke('get-sync-state'),
  setSyncInterval: (interval) => ipcRenderer.invoke('set-sync-interval', interval),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  getStats: () => ipcRenderer.invoke('get-stats'),

  // Folders
  getWatchFolders: () => ipcRenderer.invoke('get-watch-folders'),
  addWatchFolder: (folderPath) => ipcRenderer.invoke('add-watch-folder', folderPath),
  removeWatchFolder: (folderPath) => ipcRenderer.invoke('remove-watch-folder', folderPath),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  checkFlStudio: () => ipcRenderer.invoke('check-fl-studio'),
  clearSyncHistory: () => ipcRenderer.invoke('clear-sync-history'),

  // Events
  onAuthState: (cb) => ipcRenderer.on('auth-state', (e, d) => cb(d)),
  onSyncState: (cb) => ipcRenderer.on('sync-state', (e, d) => cb(d)),
  onStatsUpdate: (cb) => ipcRenderer.on('stats-update', (e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('log', (e, m) => cb(m)),
});
