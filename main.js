const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const chokidar = require('chokidar');
const axios = require('axios');
const FormData = require('form-data');
const Store = require('electron-store');
const os = require('os');

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = 'https://soundbridg-backend.onrender.com';
const ALLOWED_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.aiff', '.m4a', '.flp']);
const BLACKLIST_EXTENSIONS = new Set(['.rss', '.ds_store', '.tmp', '.part']);
const BLACKLIST_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const DEBOUNCE_MS = 3000;
const RETRY_DELAYS = [5000, 15000, 45000];

const DEFAULT_WATCH_DIRS = [
  path.join(os.homedir(), 'Documents', 'Image-Line', 'FL Studio'),
  path.join(os.homedir(), 'Documents', 'Image-Line', 'FL Studio 2025', 'Audio'),
];

const WATCHER_DELAY_MS = 5000;

const INTERVAL_OPTIONS = [
  { label: 'Always (instant)', value: 0 },
  { label: 'Every 1 min', value: 60000 },
  { label: 'Every 5 min', value: 300000 },
  { label: 'Every 30 min', value: 1800000 },
  { label: 'Every hour', value: 3600000 },
  { label: 'Every 2 hours', value: 7200000 },
];

// ─── State ───────────────────────────────────────────────────────────────────

const store = new Store({
  name: 'soundbridg-config',
  defaults: {
    token: null,
    userEmail: null,
    syncInterval: 0,
    uploadedHashes: {},
    watchFolders: null,
    autoSync: true,
    notifications: true,
    launchAtStartup: false,
  },
});

let mainWindow = null;
let tray = null;
let watcher = null;
let watcherDelayTimer = null;
let syncTimer = null;
let uploadQueue = [];
let isUploading = false;
let syncState = 'idle';
let lastSyncTime = null;
let watchersInitialized = false;

// ─── Single Instance Lock ────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.on('ready', () => {
  createTray();
  createWindow();
  if (store.get('token')) {
    startSyncEngine();
  }
});

app.on('window-all-closed', () => {});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopSyncEngine();
});

// ─── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 700,
    minWidth: 420,
    minHeight: 560,
    show: false,
    frame: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0A0A0F',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('ready-to-show', () => {
    const token = store.get('token');
    if (token) {
      mainWindow.webContents.send('auth-state', {
        loggedIn: true,
        email: store.get('userEmail'),
      });
      mainWindow.webContents.send('sync-state', {
        state: syncState,
        lastSync: lastSyncTime,
        interval: store.get('syncInterval'),
      });
    }
    mainWindow.show();
  });
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'iconTemplate.png');
  let trayIcon;
  try {
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath);
      if (trayIcon.isEmpty()) {
        // Fallback: create a simple 18x18 icon programmatically
        trayIcon = nativeImage.createFromBuffer(Buffer.alloc(18 * 18 * 4, 0), { width: 18, height: 18 });
      }
      trayIcon.setTemplateImage(true);
    } else {
      trayIcon = nativeImage.createFromBuffer(Buffer.alloc(18 * 18 * 4, 0), { width: 18, height: 18 });
      trayIcon.setTemplateImage(true);
    }
  } catch (err) {
    trayIcon = nativeImage.createFromBuffer(Buffer.alloc(18 * 18 * 4, 0), { width: 18, height: 18 });
    trayIcon.setTemplateImage(true);
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('SoundBridg');
  updateTrayMenu();
  tray.on('click', () => {
    if (mainWindow) mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

function updateTrayMenu() {
  const statusLabel = syncState === 'syncing' ? '🔄 Syncing...'
    : syncState === 'error' ? '🔴 Error' : '🟢 Idle';
  const lastSyncLabel = lastSyncTime
    ? 'Last sync: ' + new Date(lastSyncTime).toLocaleTimeString()
    : 'Last sync: Never';
  const currentInterval = store.get('syncInterval');

  const contextMenu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { label: lastSyncLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Sync Interval',
      submenu: INTERVAL_OPTIONS.map((i) => ({
        label: i.label,
        type: 'radio',
        checked: currentInterval === i.value,
        click: () => {
          store.set('syncInterval', i.value);
          restartSyncTimer();
          sendStateUpdate();
        },
      })),
    },
    { type: 'separator' },
    { label: 'Sync Now', click: () => runSync() },
    { label: 'Open Dashboard', click: () => shell.openExternal('https://soundbridg.com/dashboard') },
    { label: 'Show SoundBridg', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

// ─── Auth IPC ────────────────────────────────────────────────────────────────

ipcMain.handle('login', async (event, { email, password }) => {
  try {
    const res = await axios.post(API_BASE + '/api/auth/login', { email, password });
    const { token, user } = res.data;
    store.set('token', token);
    store.set('userEmail', user.email || email);
    startSyncEngine();
    return { success: true, email: user.email || email };
  } catch (err) {
    const msg = err.response?.data?.error || err.response?.data?.message || err.message;
    return { success: false, error: msg };
  }
});

ipcMain.handle('logout', async () => {
  stopSyncEngine();
  store.set('token', null);
  store.set('userEmail', null);
  return { success: true };
});

ipcMain.handle('get-auth-state', () => {
  return { loggedIn: !!store.get('token'), email: store.get('userEmail') };
});

// ─── Sync IPC ────────────────────────────────────────────────────────────────

ipcMain.handle('get-sync-state', () => {
  return { state: syncState, lastSync: lastSyncTime, interval: store.get('syncInterval') };
});

ipcMain.handle('set-sync-interval', (event, interval) => {
  store.set('syncInterval', interval);
  restartSyncTimer();
  updateTrayMenu();
  return { success: true };
});

ipcMain.handle('sync-now', async () => {
  await runSync();
  return { success: true };
});

ipcMain.handle('get-stats', () => {
  const hashes = store.get('uploadedHashes') || {};
  return {
    syncCount: Object.keys(hashes).length,
    folderCount: getActiveWatchDirs().length,
  };
});

// ─── Folder IPC ──────────────────────────────────────────────────────────────

ipcMain.handle('get-watch-folders', () => {
  return getActiveWatchDirs();
});

ipcMain.handle('add-watch-folder', async (event, folderPath) => {
  const dirs = getActiveWatchDirs();
  const resolved = path.resolve(folderPath);
  if (dirs.includes(resolved)) return { success: false, error: 'Folder already in list' };
  dirs.push(resolved);
  store.set('watchFolders', dirs);
  if (watchersInitialized) startWatcher();
  sendStateUpdate();
  return { success: true, folders: dirs };
});

ipcMain.handle('remove-watch-folder', (event, folderPath) => {
  const dirs = getActiveWatchDirs();
  const resolved = path.resolve(folderPath);
  const filtered = dirs.filter((d) => d !== resolved);
  store.set('watchFolders', filtered);
  if (watchersInitialized) startWatcher();
  sendStateUpdate();
  return { success: true, folders: filtered };
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Watch Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

// ─── Settings IPC ────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => {
  return {
    autoSync: store.get('autoSync'),
    notifications: store.get('notifications'),
    launchAtStartup: store.get('launchAtStartup'),
    syncInterval: store.get('syncInterval'),
  };
});

ipcMain.handle('set-setting', (event, key, value) => {
  if (key === 'autoSync') {
    store.set('autoSync', value);
  } else if (key === 'notifications') {
    store.set('notifications', value);
  } else if (key === 'launchAtStartup') {
    store.set('launchAtStartup', value);
    app.setLoginItemSettings({ openAtLogin: value });
  } else if (key === 'syncInterval') {
    store.set('syncInterval', value);
    restartSyncTimer();
    updateTrayMenu();
  }
  return { success: true };
});

ipcMain.handle('check-fl-studio', () => {
  const paths = [
    '/Applications/FL Studio 2025.app/Contents/MacOS/FL Studio',
    '/Applications/FL Studio.app/Contents/MacOS/FL Studio',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return { found: true, path: p.replace(/\/Contents\/MacOS\/FL Studio$/, '') };
  }
  return { found: false, path: '/Applications/FL Studio 2025.app' };
});

ipcMain.handle('clear-sync-history', async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Clear History'],
    defaultId: 0,
    cancelId: 0,
    title: 'Clear Sync History',
    message: 'Clear all sync history?',
    detail: 'This clears the local record of uploaded files. Files already in the cloud will not be deleted. Previously synced files may be re-uploaded on next scan.',
  });
  if (result.response === 1) {
    store.set('uploadedHashes', {});
    sendLog('Sync history cleared');
    return { success: true };
  }
  return { success: false };
});

// ─── File Filter ────────────────────────────────────────────────────────────

function isAllowedFile(filePath) {
  const basename = path.basename(filePath).toLowerCase();
  if (BLACKLIST_NAMES.has(basename)) return false;
  const ext = path.extname(basename);
  if (BLACKLIST_EXTENSIONS.has(ext)) return false;
  return ALLOWED_EXTENSIONS.has(ext);
}

// ─── Sync Engine ─────────────────────────────────────────────────────────────

function getActiveWatchDirs() {
  const stored = store.get('watchFolders');
  return stored ? stored.slice() : DEFAULT_WATCH_DIRS.slice();
}

function startSyncEngine() {
  restartSyncTimer();
  sendLog('Sync engine started');
  if (!watchersInitialized) {
    if (watcherDelayTimer) clearTimeout(watcherDelayTimer);
    watcherDelayTimer = setTimeout(() => {
      watcherDelayTimer = null;
      watchersInitialized = true;
      startWatcher();
    }, WATCHER_DELAY_MS);
  }
}

function stopSyncEngine() {
  if (watcherDelayTimer) { clearTimeout(watcherDelayTimer); watcherDelayTimer = null; }
  if (watcher) { watcher.close(); watcher = null; }
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  watchersInitialized = false;
}

function startWatcher() {
  if (watcher) watcher.close();
  const dirs = getActiveWatchDirs();
  const existingDirs = dirs.filter((d) => {
    try { return fs.existsSync(d) && fs.statSync(d).isDirectory(); }
    catch { return false; }
  });
  if (existingDirs.length === 0) {
    sendLog('No watch directories found — add a folder to start syncing');
    return;
  }
  try {
    watcher = chokidar.watch(existingDirs, {
      ignoreInitial: true,
      persistent: true,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: DEBOUNCE_MS, pollInterval: 500 },
      ignored: (filePath, stats) => {
        const basename = path.basename(filePath);
        if (basename.startsWith('.')) return true;
        if (stats && stats.isFile()) return !isAllowedFile(filePath);
        return false;
      },
    });
    watcher.on('add', (filePath) => {
      sendLog('Detected: ' + path.basename(filePath));
      enqueueUpload(filePath);
    });
    watcher.on('change', (filePath) => {
      sendLog('Changed: ' + path.basename(filePath));
      enqueueUpload(filePath);
    });
    watcher.on('error', (err) => sendLog('Watcher error: ' + err.message));
    sendLog('Watching ' + existingDirs.length + ' folder' + (existingDirs.length === 1 ? '' : 's'));
  } catch (err) {
    sendLog('Failed to start watcher: ' + err.message);
  }
}

function restartSyncTimer() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  const interval = store.get('syncInterval');
  // 0 = instant (chokidar handles real-time), no timer needed
  if (interval > 0) {
    syncTimer = setInterval(() => runSync(), interval);
  }
}

async function runSync() {
  if (syncState === 'syncing') return;
  setSyncState('syncing');
  sendLog('Scanning for new files...');
  let filesFound = 0;
  for (const dir of getActiveWatchDirs()) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = scanDirectory(dir);
      for (const filePath of files) {
        enqueueUpload(filePath);
        filesFound++;
      }
    } catch (err) {
      sendLog('Error scanning ' + dir + ': ' + err.message);
    }
  }
  if (filesFound === 0) sendLog('All files synced');
  else sendLog('Found ' + filesFound + ' file' + (filesFound === 1 ? '' : 's') + ' to check');
  // Force process queue even if autoSync is off (this is manual sync)
  await drainQueue(true);
  lastSyncTime = Date.now();
  setSyncState('idle');
  updateTrayMenu();
}

function scanDirectory(dir, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 3) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) results.push.apply(results, scanDirectory(fullPath, depth + 1));
      else if (entry.isFile() && isAllowedFile(fullPath)) results.push(fullPath);
    }
  } catch { /* skip unreadable */ }
  return results;
}

// ─── Upload Queue ────────────────────────────────────────────────────────────

function enqueueUpload(filePath) {
  if (!uploadQueue.includes(filePath)) uploadQueue.push(filePath);
  // Only auto-process if autoSync is on
  if (store.get('autoSync')) processQueue();
}

async function processQueue() {
  if (isUploading || uploadQueue.length === 0) return;
  isUploading = true;
  while (uploadQueue.length > 0) {
    const filePath = uploadQueue.shift();
    await uploadFile(filePath);
  }
  isUploading = false;
}

async function drainQueue(force) {
  if (force && uploadQueue.length > 0 && !isUploading) await processQueue();
  else if (uploadQueue.length > 0 && !isUploading && store.get('autoSync')) await processQueue();
  while (isUploading) await new Promise((r) => setTimeout(r, 500));
}

async function uploadFile(filePath, retryCount) {
  if (retryCount === undefined) retryCount = 0;
  // Safety net: never upload disallowed files
  if (!isAllowedFile(filePath)) return;
  const token = store.get('token');
  if (!token) return;
  try {
    if (!fs.existsSync(filePath)) return;
    const hash = await computeHash(filePath);
    const hashes = store.get('uploadedHashes') || {};
    if (hashes[hash]) return;
    const stat = fs.statSync(filePath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    const filename = path.basename(filePath);
    sendLog('Uploading ' + filename + ' (' + sizeMB + ' MB)...');
    setSyncState('syncing');
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('title', path.parse(filePath).name);
    form.append('source', 'desktop');
    const res = await axios.post(API_BASE + '/api/tracks/upload', form, {
      headers: Object.assign({}, form.getHeaders(), { Authorization: 'Bearer ' + token }),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 300000,
    });
    hashes[hash] = { file: filename, time: Date.now(), id: res.data.id };
    store.set('uploadedHashes', hashes);
    sendLog('Uploaded ' + filename + ' (' + sizeMB + ' MB)');
    // Notification
    if (store.get('notifications') && Notification.isSupported()) {
      new Notification({ title: 'SoundBridg', body: 'Uploaded ' + filename }).show();
    }
    // Update stats in renderer
    sendStatsUpdate();
  } catch (err) {
    const filename = path.basename(filePath);
    if (retryCount < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[retryCount];
      sendLog('Error uploading ' + filename + ' — retrying in ' + (delay / 1000) + 's');
      setSyncState('error');
      await new Promise((r) => setTimeout(r, delay));
      return uploadFile(filePath, retryCount + 1);
    }
    sendLog('Failed to upload ' + filename + ': ' + err.message);
    setSyncState('error');
  }
}

function computeHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setSyncState(state) {
  syncState = state;
  sendStateUpdate();
  updateTrayMenu();
}

function sendStateUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-state', {
      state: syncState,
      lastSync: lastSyncTime,
      interval: store.get('syncInterval'),
    });
  }
}

function sendStatsUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const hashes = store.get('uploadedHashes') || {};
    mainWindow.webContents.send('stats-update', {
      syncCount: Object.keys(hashes).length,
      folderCount: getActiveWatchDirs().length,
    });
  }
}

function sendLog(message) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = '[' + timestamp + '] ' + message;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log', entry);
}
