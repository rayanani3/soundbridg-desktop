const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundbridg', {
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),
  logout: () => ipcRenderer.invoke('logout'),
  getAuthState: () => ipcRenderer.invoke('get-auth-state'),
  getSyncState: () => ipcRenderer.invoke('get-sync-state'),
  setSyncInterval: (interval) => ipcRenderer.invoke('set-sync-interval', interval),
  syncNow: () => ipcRenderer.invoke('sync-now'),

  onAuthState: (callback) => {
    ipcRenderer.on('auth-state', (event, data) => callback(data));
  },
  onSyncState: (callback) => {
    ipcRenderer.on('sync-state', (event, data) => callback(data));
  },
  onLog: (callback) => {
    ipcRenderer.on('log', (event, message) => callback(message));
  },
});
