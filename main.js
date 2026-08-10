import { app, BrowserWindow, ipcMain, Menu, Notification, shell, Tray, nativeImage, dialog } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSignalServer } from './server.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = 31877;
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
    notification.show();
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('open-external', (_event, url) =>
  typeof url === 'string' && /^https:\/\/(?:www\.)?(?:x|twitter|linkedin|reddit|youtube|tiktok|substack)\.com\//i.test(url)
    ? shell.openExternal(url)
    : false
);
ipcMain.handle('set-startup', (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('get-startup', () => app.getLoginItemSettings().openAtLogin);

app.setAppUserModelId('com.signal.scanner');
app.whenReady().then(async () => {
  process.env.SIGNAL_DATA_DIR = app.getPath('userData');
  try {
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
