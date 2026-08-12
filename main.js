import { app, BrowserWindow, ipcMain, Menu, Notification, shell, Tray, nativeImage, dialog } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSignalServer } from './server.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = 31877;
const appUserModelId = 'com.signal.scanner';
const toastActivatorClsid = '{86609B8D-0E0C-4A2B-9038-63F71A196E23}';
let mainWindow;
let tray;
let embeddedServer;
let quitting = false;
const activeNotifications = new Set();

function assetPath(filename) {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'assets', filename)
    : join(root, 'assets', filename);
}

function appIcon() {
  return nativeImage.createFromPath(assetPath('icon.ico'));
}

function trayIcon() {
  return nativeImage.createFromPath(assetPath('tray.png'));
}

function registerWindowsNotifications() {
  if (process.platform !== 'win32' || !app.isPackaged) return true;
  const shortcutPath = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'RSignals.lnk');
  return shell.writeShortcutLink(shortcutPath, 'create', {
    target: process.execPath,
    cwd: dirname(process.execPath),
    description: 'RSignals opportunity scanner',
    icon: process.execPath,
    iconIndex: 0,
    appUserModelId,
    toastActivatorClsid: app.toastActivatorCLSID
  });
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 650,
    title: 'RSignals',
    icon: appIcon(),
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('RSignals — Opportunity scanner');
  const rebuildMenu = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open RSignals', click: showWindow },
    { label: 'Scan now', click: () => { showWindow(); mainWindow?.webContents.send('trigger-scan'); } },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => { app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }); rebuildMenu(); }
    },
    { type: 'separator' },
    { label: 'Quit RSignals', click: () => { quitting = true; app.quit(); } }
  ]));
  rebuildMenu();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

ipcMain.handle('notify', (_event, payload) => {
  if (!Notification.isSupported()) return false;
  try {
    const notification = new Notification({
      title: payload?.title || 'RSignals',
      body: payload?.body || 'Fresh opportunities found.',
      icon: appIcon()
    });
    activeNotifications.add(notification);
    notification.on('close', () => activeNotifications.delete(notification));
    notification.on('click', () => {
      showWindow();
      if (payload?.url) shell.openExternal(payload.url);
    });
    return new Promise(resolve => {
      let settled = false;
      const finish = result => { if (!settled) { settled = true; resolve(result); } };
      notification.once('show', () => finish(true));
      notification.once('failed', () => { activeNotifications.delete(notification); finish(false); });
      notification.show();
      setTimeout(() => finish(false), 5000);
    });
  } catch {
    return false;
  }
});

ipcMain.handle('open-external', (_event, url) =>
  typeof url === 'string' && /^https:\/\/(?:www\.)?(?:(?:x|twitter|linkedin|reddit|youtube|tiktok|substack)\.com|getanyapi\.com)\//i.test(url)
    ? shell.openExternal(url)
    : false
);
ipcMain.handle('set-startup', (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('get-startup', () => app.getLoginItemSettings().openAtLogin);

app.setAppUserModelId(appUserModelId);
if (process.platform === 'win32' && typeof app.setToastActivatorCLSID === 'function') app.setToastActivatorCLSID(toastActivatorClsid);
app.whenReady().then(async () => {
  process.env.SIGNAL_DATA_DIR = app.getPath('userData');
  try {
    registerWindowsNotifications();
    embeddedServer = await startSignalServer({ port });
    createWindow();
    createTray();
  } catch (error) {
    dialog.showErrorBox('RSignals could not start', error?.message || String(error));
    quitting = true;
    app.quit();
  }
});

app.on('activate', showWindow);
app.on('window-all-closed', event => event.preventDefault());
app.on('before-quit', () => {
  quitting = true;
  if (embeddedServer) embeddedServer.close();
});
