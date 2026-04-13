const api = window.soundbridg;

// ─── DOM Elements ────────────────────────────────────────────────────────────

const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const loginForm = document.getElementById('login-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const registerLink = document.getElementById('register-link');

// Dashboard
const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');
const statusDot = document.getElementById('status-dot');
const syncBadge = document.getElementById('sync-badge');
const syncStatusLabel = document.getElementById('sync-status-label');
const folderCountLabel = document.getElementById('folder-count-label');
const statUploaded = document.getElementById('stat-uploaded');
const statWatching = document.getElementById('stat-watching');
const recentActivity = document.getElementById('recent-activity');
const addFolderBtnFiles = document.getElementById('add-folder-btn-files');
const openDashboardBtn = document.getElementById('open-dashboard-btn');

// Sync tab
const folderList = document.getElementById('folder-list');
const addFolderBtn = document.getElementById('add-folder-btn');
const syncNowBtn = document.getElementById('sync-now-btn');

// Log tab
const activityLog = document.getElementById('activity-log');
const logCount = document.getElementById('log-count');

// Settings tab
const userEmail = document.getElementById('user-email');
const intervalSelect = document.getElementById('interval-select');
const toggleAutoSync = document.getElementById('toggle-autosync');
const toggleNotifications = document.getElementById('toggle-notifications');
const toggleStartup = document.getElementById('toggle-startup');
const flStatus = document.getElementById('fl-status');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const logoutBtn = document.getElementById('logout-btn');

let logEntryCount = 0;
const recentMessages = [];

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const auth = await api.getAuthState();
  if (auth.loggedIn) {
    showDashboard(auth.email);
  } else {
    showLogin();
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function showLogin() {
  loginScreen.classList.remove('hidden');
  dashboardScreen.classList.add('hidden');
  loginError.textContent = '';
  emailInput.value = '';
  passwordInput.value = '';
}

async function showDashboard(email) {
  loginScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');
  userEmail.textContent = email;

  // Load initial data
  const [sync, settings, stats] = await Promise.all([
    api.getSyncState(),
    api.getSettings(),
    api.getStats(),
  ]);

  updateSyncUI(sync);
  applySettings(settings);
  updateStats(stats);
  loadFolders();
  checkFlStudio();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in...';
  loginError.textContent = '';

  const result = await api.login(emailInput.value, passwordInput.value);

  if (result.success) {
    showDashboard(result.email);
  } else {
    loginError.textContent = result.error;
  }

  loginBtn.disabled = false;
  loginBtn.textContent = 'Sign In';
});

registerLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.open('https://soundbridg.com');
});

logoutBtn.addEventListener('click', async () => {
  await api.logout();
  showLogin();
});

// ─── Tabs ────────────────────────────────────────────────────────────────────

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    tabContents.forEach((tc) => tc.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ─── Sync Controls ───────────────────────────────────────────────────────────

intervalSelect.addEventListener('change', () => {
  const val = Number(intervalSelect.value);
  api.setSyncInterval(val);
  api.setSetting('syncInterval', val);
});

syncNowBtn.addEventListener('click', () => {
  api.syncNow();
});

// ─── Settings Toggles ───────────────────────────────────────────────────────

toggleAutoSync.addEventListener('change', () => {
  api.setSetting('autoSync', toggleAutoSync.checked);
});

toggleNotifications.addEventListener('change', () => {
  api.setSetting('notifications', toggleNotifications.checked);
});

toggleStartup.addEventListener('change', () => {
  api.setSetting('launchAtStartup', toggleStartup.checked);
});

// ─── Watch Folders ───────────────────────────────────────────────────────────

async function loadFolders() {
  const folders = await api.getWatchFolders();
  renderFolders(folders);
  folderCountLabel.textContent = folders.length + ' folder' + (folders.length !== 1 ? 's' : '') + ' monitored';
}

function renderFolders(folders) {
  folderList.innerHTML = '';
  if (folders.length === 0) {
    folderList.innerHTML = '<div class="folder-empty">No folders added yet</div>';
    return;
  }
  for (const f of folders) {
    const row = document.createElement('div');
    row.className = 'folder-row';

    const label = document.createElement('span');
    label.className = 'folder-path';
    label.textContent = f.replace(/^\/Users\/[^/]+/, '~');
    label.title = f;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'folder-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.addEventListener('click', async () => {
      await api.removeWatchFolder(f);
      loadFolders();
    });

    row.appendChild(label);
    row.appendChild(removeBtn);
    folderList.appendChild(row);
  }
}

async function pickAndAddFolder() {
  const result = await api.pickFolder();
  if (result.canceled) return;
  await api.addWatchFolder(result.path);
  loadFolders();
}

addFolderBtn.addEventListener('click', pickAndAddFolder);
addFolderBtnFiles.addEventListener('click', pickAndAddFolder);

// ─── Open Dashboard ──────────────────────────────────────────────────────────

openDashboardBtn.addEventListener('click', () => {
  window.open('https://soundbridg.com/dashboard');
});

// ─── FL Studio Detection ─────────────────────────────────────────────────────

async function checkFlStudio() {
  const result = await api.checkFlStudio();
  if (result.found) {
    flStatus.textContent = 'Detected';
    flStatus.style.color = '#4CAF50';
  } else {
    flStatus.textContent = 'Not found';
    flStatus.style.color = '#9ca3af';
  }
}

// ─── Clear History ───────────────────────────────────────────────────────────

clearHistoryBtn.addEventListener('click', async () => {
  await api.clearSyncHistory();
});

// ─── IPC Listeners ───────────────────────────────────────────────────────────

api.onAuthState((data) => {
  if (data.loggedIn) showDashboard(data.email);
  else showLogin();
});

api.onSyncState((data) => {
  updateSyncUI(data);
});

api.onStatsUpdate((data) => {
  updateStats(data);
});

api.onLog((message) => {
  addLogEntry(message);
  addRecentEntry(message);
});

// ─── UI Updates ──────────────────────────────────────────────────────────────

function applySettings(settings) {
  toggleAutoSync.checked = settings.autoSync !== false;
  toggleNotifications.checked = settings.notifications !== false;
  toggleStartup.checked = settings.launchAtStartup === true;
  if (settings.syncInterval !== undefined) {
    intervalSelect.value = String(settings.syncInterval);
  }
}

function updateStats(data) {
  if (data.uploaded !== undefined) statUploaded.textContent = data.uploaded;
  if (data.watching !== undefined) statWatching.textContent = data.watching;
}

function updateSyncUI(data) {
  const { state, lastSync, interval } = data;

  statusDot.className = 'status-dot';
  if (state === 'syncing') statusDot.classList.add('syncing');
  else if (state === 'error') statusDot.classList.add('error');

  syncBadge.className = 'sync-badge';
  if (state === 'syncing') {
    syncBadge.classList.add('syncing');
    syncBadge.textContent = 'Syncing';
    syncStatusLabel.textContent = 'Syncing your mixes...';
  } else if (state === 'error') {
    syncBadge.classList.add('error');
    syncBadge.textContent = 'Error';
    syncStatusLabel.textContent = 'Sync error occurred';
  } else {
    syncBadge.textContent = 'Idle';
    syncStatusLabel.textContent = 'Watching for new mixes';
  }

  if (interval !== undefined) {
    intervalSelect.value = String(interval);
  }
}

function addLogEntry(message) {
  // Remove empty state
  const empty = activityLog.querySelector('.empty-state');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry';

  if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
    entry.classList.add('error');
  } else if (message.toLowerCase().includes('uploaded')) {
    entry.classList.add('upload');
  }

  const time = new Date().toLocaleTimeString();
  entry.textContent = '[' + time + '] ' + message;
  activityLog.appendChild(entry);
  activityLog.scrollTop = activityLog.scrollHeight;

  logEntryCount++;
  logCount.textContent = logEntryCount + ' event' + (logEntryCount !== 1 ? 's' : '');

  while (activityLog.children.length > 200) {
    activityLog.removeChild(activityLog.firstChild);
  }
}

function addRecentEntry(message) {
  // Remove empty state
  const empty = recentActivity.querySelector('.empty-state');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry';

  if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
    entry.classList.add('error');
  } else if (message.toLowerCase().includes('uploaded')) {
    entry.classList.add('upload');
  }

  const time = new Date().toLocaleTimeString();
  entry.textContent = '[' + time + '] ' + message;
  recentActivity.appendChild(entry);
  recentActivity.scrollTop = recentActivity.scrollHeight;

  // Keep only last 20 in recent
  while (recentActivity.children.length > 20) {
    recentActivity.removeChild(recentActivity.firstChild);
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

init();
