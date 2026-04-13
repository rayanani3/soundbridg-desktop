const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
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
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.aiff', '.m4a']);
const DEBOUNCE_MS = 3000;
const RETRY_DELAYS = [5000, 15000, 45000];

const WATCH_DIRS = [
  path.join(os.homedir(), 'Documents', 'Image-Line', 'FL Studio', 'Audio'),
  path.join(os.homedir(), 'Documents', 'Image-Line', 'FL Studio 2025', 'Audio'),
  path.join(os.homedir(), 'Music'),
  path.join(os.homedir(), 'Desktop'),
];

// ─── State ───────────────────────────────────────────────────────────────────

const store = new Store({
  name: 'soundbridg-config',
  defaults: {
    token: null,
    userEmail: null,
    syncInterval: 300000,
    uploadedHashes: {},
  },
});

let mainWindow = null;
let tray = null;
let watcher = null;
let syncTimer = null;
let uploadQueue = [];
let isUploading = false;
let syncState = 'idle';
let lastSyncTime = null;

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

app.on('window-all-closed', () => {
  // Do NOT quit on macOS — keep running in tray
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopSyncEngine();
});

// ─── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 400,
    minHeight: 500,
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
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    trayIcon.setTemplateImage(true);
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('SoundBridg');
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

function updateTrayMenu() {
  const statusLabel = syncState === 'syncing' ? '🔄 Syncing...'
    : syncState === 'error' ? '🔴 Error'
    : '🟢 Idle';

  const lastSyncLabel = lastSyncTime
    ? 'Last sync: ' + new Date(lastSyncTime).toLocaleTimeString()
    : 'Last sync: Never';

  const currentInterval = store.get('syncInterval');
  const intervals = [
    { label: '1 minute', value: 60000 },
    { label: '5 minutes', value: 300000 },
    { label: '15 minutes', value: 900000 },
    { label: '30 minutes', value: 1800000 },
    { label: '1 hour', value: 3600000 },
    { label: '3 hours', value: 10800000 },
  ];

  const contextMenu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { label: lastSyncLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Sync Interval',
      submenu: intervals.map((i) => ({
        label: i.label,
        type: 'radio',
        checked: currentInterval === i.value,
        click: () => {
          store.set('syncInterval', i.value);
          restartSyncTimer();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('sync-state', {
              state: syncState,
              lastSync: lastSyncTime,
              interval: i.value,
            });
          }
        },
      })),
    },
    { type: 'separator' },
    { label: 'Sync Now', click: () => runSync() },
    { label: 'Open Dashboard', click: () => shell.openExternal('https://soundbridg.com') },
    {
      label: 'Show SoundBridg',
      click: () => { if (mainWindow) mainWindow.show(); },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
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
  const token = store.get('token');
  return { loggedIn: !!token, email: store.get('userEmail') };
});

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

// ─── Sync Engine ─────────────────────────────────────────────────────────────

function startSyncEngine() {
  startWatcher();
  startSyncTimer();
  sendLog('Sync engine started');
}

function stopSyncEngine() {
  if (watcher) { watcher.close(); watcher = null; }
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

function startWatcher() {
  if (watcher) watcher.close();

  const existingDirs = WATCH_DIRS.filter((d) => {
    try { return fs.existsSync(d) && fs.statSync(d).isDirectory(); }
    catch { return false; }
  });

  if (existingDirs.length === 0) {
    sendLog('No watch directories found — will scan on interval');
    return;
  }

  watcher = chokidar.watch(existingDirs, {
    ignoreInitial: true,
    persistent: true,
    depth: 3,
    awaitWriteFinish: { stabilityThreshold: DEBOUNCE_MS, pollInterval: 500 },
    ignored: (filePath, stats) => {
      const basename = path.basename(filePath);
      if (basename.startsWith('.')) return true;
      if (stats && stats.isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        return !AUDIO_EXTENSIONS.has(ext);
      }
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

  sendLog('Watching ' + existingDirs.length + ' director' + (existingDirs.length === 1 ? 'y' : 'ies'));
}

function startSyncTimer() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => runSync(), store.get('syncInterval'));
}

function restartSyncTimer() {
  startSyncTimer();
}

async function runSync() {
  if (syncState === 'syncing') return;
  setSyncState('syncing');
  sendLog('Scanning for new files...');

  let filesFound = 0;
  for (const dir of WATCH_DIRS) {
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

  if (filesFound === 0) {
    sendLog('All files synced');
  } else {
    sendLog('Found ' + filesFound + ' file' + (filesFound === 1 ? '' : 's') + ' to check');
  }

  await drainQueue();
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
      if (entry.isDirectory() && depth < 3) {
        results.push.apply(results, scanDirectory(fullPath, depth + 1));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) results.push(fullPath);
      }
    }
  } catch { /* skip unreadable */ }
  return results;
}

// ─── Upload Queue ────────────────────────────────────────────────────────────

function enqueueUpload(filePath) {
  if (!uploadQueue.includes(filePath)) {
    uploadQueue.push(filePath);
  }
  processQueue();
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

async function drainQueue() {
  // Force process and wait
  if (uploadQueue.length > 0 && !isUploading) {
    await processQueue();
  }
  // Wait for current uploads to finish
  while (isUploading) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function uploadFile(filePath, retryCount) {
  if (retryCount === undefined) retryCount = 0;
  const token = store.get('token');
  if (!token) return;

  try {
    if (!fs.existsSync(filePath)) return;

    const hash = await computeHash(filePath);
    const hashes = store.get('uploadedHashes') || {};
    if (hashes[hash]) return; // already uploaded

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
      headers: Object.assign({}, form.getHeaders(), {
        Authorization: 'Bearer ' + token,
      }),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 300000,
    });

    hashes[hash] = { file: filename, time: Date.now(), id: res.data.id };
    store.set('uploadedHashes', hashes);
    sendLog('Uploaded ' + filename + ' (' + sizeMB + ' MB)');
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-state', {
      state: syncState,
      lastSync: lastSyncTime,
      interval: store.get('syncInterval'),
    });
  }
  updateTrayMenu();
}

function sendLog(message) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = '[' + timestamp + '] ' + message;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', entry);
  }
}
