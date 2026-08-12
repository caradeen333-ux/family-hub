// main.js — Electron wrapper for Family Hub PWA
// Loads PWA, injects client secret at runtime (never in public code)

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = 'https://caradeen333-ux.github.io/family-hub/';

let mainWindow;

function createWindow() {
  // Read always-on-top preference
  let alwaysOnTop = false;
  try {
    const prefsPath = path.join(app.getPath('userData'), 'prefs.json');
    if (fs.existsSync(prefsPath)) {
      alwaysOnTop = JSON.parse(fs.readFileSync(prefsPath, 'utf8')).alwaysOnTop || false;
    }
  } catch (e) { /* ignore */ }

  mainWindow = new BrowserWindow({
    width: 500,
    height: 720,
    minWidth: 380,
    minHeight: 500,
    frame: true,
    resizable: true,
    alwaysOnTop,
    skipTaskbar: false,
    icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setTitle('Family Hub');

  // Clear HTTP cache then load — ensures fresh content every launch
  mainWindow.webContents.session.clearCache().then(() => {
    mainWindow.loadURL(APP_URL);
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// IPC: toggle always-on-top
ipcMain.on('set-always-on-top', (_event, onTop) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(onTop);
  try {
    const prefsPath = path.join(app.getPath('userData'), 'prefs.json');
    fs.writeFileSync(prefsPath, JSON.stringify({ alwaysOnTop: onTop }));
  } catch (e) { /* ignore */ }
});

app.whenReady().then(() => {
  // Only clear cache on first run after update (version check)
  const ses = require('electron').session.defaultSession;
  const currentVersion = app.getVersion();
  const versionPath = path.join(app.getPath('userData'), 'version.txt');
  const lastVersion = fs.existsSync(versionPath)
    ? fs.readFileSync(versionPath, 'utf8').trim()
    : '';
  if (currentVersion !== lastVersion) {
    ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    fs.writeFileSync(versionPath, currentVersion);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
