// main.js — Electron wrapper for Family Hub PWA
// Minimal shell: loads the PWA, auto-starts with Windows, frameless widget window

const { app, BrowserWindow, shell, ipcMain, nativeTheme } = require('electron');
const path = require('path');

const APP_URL = 'https://caradeen333-ux.github.io/family-hub/';

// Auto-start with Windows
app.setLoginItemSettings({ openAtLogin: true });

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 600,
    minWidth: 320,
    minHeight: 420,
    frame: true, // Framed for title bar drag; PWA header has its own drag region too
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setTitle('Family Hub');
  mainWindow.loadURL(APP_URL);

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  // Only clear cache on first run after update (version check)
  const ses = require('electron').session.defaultSession;
  const currentVersion = app.getVersion();
  const lastVersion = require('fs').existsSync(
    require('path').join(app.getPath('userData'), 'version.txt'))
    ? require('fs').readFileSync(
        require('path').join(app.getPath('userData'), 'version.txt'), 'utf8').trim()
    : '';
  if (currentVersion !== lastVersion) {
    ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    require('fs').writeFileSync(
      require('path').join(app.getPath('userData'), 'version.txt'), currentVersion);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
