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

const userEmail = document.getElementById('user-email');
const statusDot = document.getElementById('status-dot');
const syncBadge = document.getElementById('sync-badge');
const syncStatusText = document.getElementById('sync-status-text');
const lastSyncText = document.getElementById('last-sync-text');
const intervalSelect = document.getElementById('interval-select');
const syncNowBtn = document.getElementById('sync-now-btn');
const activityLog = document.getElementById('activity-log');
const logoutBtn = document.getElementById('logout-btn');
const folderList = document.getElementById('folder-list');
const addFolderBtn = document.getElementById('add-folder-btn');

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const auth = await api.getAuthState();
  if (auth.loggedIn) {
    showDashboard(auth.email);
    const sync = await api.getSyncState();
    updateSyncUI(sync);
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

function showDashboard(email) {
  loginScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');
  userEmail.textContent = email;
  activityLog.innerHTML = '<p class="log-empty">Waiting for activity...</p>';
  loadFolders();
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

// ─── Sync Controls ───────────────────────────────────────────────────────────

intervalSelect.addEventListener('change', () => {
  api.setSyncInterval(Number(intervalSelect.value));
});

syncNowBtn.addEventListener('click', () => {
  api.syncNow();
});

// ─── Watch Folders ───────────────────────────────────────────────────────────

async function loadFolders() {
  const folders = await api.getWatchFolders();
  renderFolders(folders);
}

function renderFolders(folders) {
  folderList.innerHTML = '';
  if (folders.length === 0) {
    folderList.innerHTML = '<div class="folder-empty">No folders — click Add Folder</div>';
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

addFolderBtn.addEventListener('click', async () => {
  const result = await api.pickFolder();
  if (result.canceled) return;
  await api.addWatchFolder(result.path);
  loadFolders();
});

// ─── IPC Listeners ───────────────────────────────────────────────────────────

api.onAuthState((data) => {
  if (data.loggedIn) showDashboard(data.email);
  else showLogin();
});

api.onSyncState((data) => {
  updateSyncUI(data);
});

api.onLog((message) => {
  addLogEntry(message);
});

// ─── UI Updates ──────────────────────────────────────────────────────────────

function updateSyncUI(data) {
  const { state, lastSync, interval } = data;

  statusDot.className = 'status-dot';
  if (state === 'syncing') statusDot.classList.add('syncing');
  else if (state === 'error') statusDot.classList.add('error');

  syncBadge.className = 'sync-badge';
  if (state === 'syncing') {
    syncBadge.classList.add('syncing');
    syncBadge.textContent = 'Syncing';
  } else if (state === 'error') {
    syncBadge.classList.add('error');
    syncBadge.textContent = 'Error';
  } else {
    syncBadge.textContent = 'Idle';
  }

  const stateLabels = { idle: 'Idle', syncing: 'Syncing...', error: 'Error' };
  syncStatusText.textContent = stateLabels[state] || 'Idle';

  if (lastSync) {
    lastSyncText.textContent = new Date(lastSync).toLocaleTimeString();
  }

  if (interval) {
    intervalSelect.value = String(interval);
  }
}

function addLogEntry(message) {
  const empty = activityLog.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry';

  if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
    entry.classList.add('error');
  } else if (message.toLowerCase().includes('uploaded')) {
    entry.classList.add('upload');
  }

  entry.textContent = message;
  activityLog.appendChild(entry);
  activityLog.scrollTop = activityLog.scrollHeight;

  while (activityLog.children.length > 200) {
    activityLog.removeChild(activityLog.firstChild);
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

init();
