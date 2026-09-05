import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = process.env.RSIGNALS_TEST_ASAR
  ? require('@electron/asar').extractFile(process.env.RSIGNALS_TEST_ASAR, 'main.js').toString('utf8')
  : await readFile(new URL('../main.js', import.meta.url), 'utf8');

async function desktop(primary = true) {
  const windows = [], trays = [], handlers = new Map(), opened = [], servers = [];
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, requestSingleInstanceLock: () => primary,
    whenReady: () => Promise.resolve(), setAppUserModelId() {}, getPath: () => '.',
    getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {},
    quit() { app.emit('before-quit'); app.quits++; }, quits: 0
  });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = false; this.minimized = false;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: handler => { this.openHandler = handler; }, send() {} });
      windows.push(this);
    }
    loadURL(url) { this.url = url; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
  }
  class Tray extends EventEmitter {
    constructor() { super(); trays.push(this); }
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
  }
  const context = {
    app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: items => items },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    nativeImage: { createFromPath: path => path }, Notification: { isSupported: () => false },
    shell: { openExternal: async url => opened.push(url) },
    dialog: { showErrorBox: (...args) => { throw new Error(args.join(':')); } },
    safeStorage: { isEncryptionAvailable: () => true }, createProtectedCredentialStore: () => ({}),
    startSignalServer: async () => { const server = { close() {}, closeAllConnections() {} }; servers.push(server); return server; },
    process: { platform: 'win32', env: {}, execPath: 'fixture.exe' },
    randomBytes, dirname, join, URL, setTimeout, console
  };
  vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, '').replace("fileURLToPath(new URL('.', import.meta.url))", "'.'"), context);
  await new Promise(resolve => setImmediate(resolve));
  return { app, windows, trays, handlers, opened, servers };
}

test('secondary desktop launch exits without starting another server', async () => {
  const result = await desktop(false);
  assert.equal(result.app.quits, 1);
  assert.equal(result.servers.length, 0);
  assert.equal(result.windows.length, 0);
});

test('closing to tray and reopening from taskbar restores the existing window', async () => {
  const { app, windows, trays, servers } = await desktop();
  const window = windows[0];
  window.emit('ready-to-show');
  let prevented = false;
  window.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(window.visible, false);
  window.minimized = true;
  app.emit('second-instance');
  assert.equal(window.visible, true);
  assert.equal(window.minimized, false);
  assert.equal(window.focused, true);
  assert.equal(servers.length, 1);
  window.hide(); trays[0].emit('click');
  assert.equal(window.visible, true);
  app.quit();
  prevented = false;
  window.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

test('external publication attachments open in the browser; unsafe schemes and untrusted callers are blocked', async () => {
  const { handlers, windows, opened } = await desktop();
  const invoke = handlers.get('open-external');
  const event = { sender: windows[0].webContents, senderFrame: { url: windows[0].url } };
  assert.equal(await invoke(event, 'https://publication.example/article'), true);
  for (const url of ['file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'http://example.com', 'https://user:password@example.com']) {
    assert.equal(await invoke(event, url), false);
  }
  assert.equal(await invoke({ ...event, sender: {} }, 'https://example.com'), false);
  assert.deepEqual(opened, ['https://publication.example/article']);
});
