const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, safeStorage } = require('electron');
const { join, dirname } = require('node:path');
const { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync, realpathSync, openSync, closeSync } = require('node:fs');
const { execFile, spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');

app.setName('Linubot');
if (process.env.LINUBOT_DESKTOP_PROFILE) app.setPath('userData', process.env.LINUBOT_DESKTOP_PROFILE);
const data = process.env.LINUBOT_DATA || join(process.env.XDG_DATA_HOME || join(app.getPath('home'), '.local', 'share'), 'linubot');
process.env.LINUBOT_DATA = data;
mkdirSync(data, { recursive: true, mode: 0o700 });
const settingsFile = join(data, 'desktop.json');
let settings = { background: false };
try { settings = { ...settings, ...JSON.parse(readFileSync(settingsFile, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') console.error('Unable to read desktop preferences:', error.message); }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window, tray, backend, origin;
  let quitting = false;
  let closed = false;
  const token = randomBytes(32).toString('hex');
  const icon = join(__dirname, 'icon.png');
  const show = () => { if (window && !window.isDestroyed()) { window.show(); if (window.isMinimized()) window.restore(); window.focus(); } };
  app.on('second-instance', show);
  app.on('activate', show);
  app.on('window-all-closed', () => { if (!settings.background) app.quit(); });
  app.on('before-quit', (event) => {
    if (closed || !backend) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void backend.close().catch((error) => console.error(error)).finally(() => { closed = true; tray?.destroy(); app.quit(); });
  });

  app.whenReady().then(async () => {
    const workspace = app.isPackaged ? join(process.resourcesPath, 'workspace', 'agent-workspace-linux') : process.env.LINUBOT_WORKSPACE_BIN;
    if (workspace && existsSync(workspace)) process.env.LINUBOT_WORKSPACE_BIN = workspace;
    process.env.LINUBOT_BROWSER_WRAPPER = app.isPackaged ? join(process.resourcesPath, 'linubot-chrome.sh') : join(__dirname, 'linubot-chrome.sh');
    if (app.isPackaged && existsSync(join(process.resourcesPath, 'runners', 'uvx'))) process.env.LINUBOT_UVX_BIN = join(process.resourcesPath, 'runners', 'uvx');
    const xai = await import(pathToFileURL(join(__dirname, '..', 'dist', 'auth', 'xai.js')).href);
    const store = await import(pathToFileURL(join(__dirname, '..', 'dist', 'auth', 'store.js')).href);
    if (safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() !== 'basic_text') {
      const oauthFile = join(data, 'xai-oauth.enc');
      xai.setXaiVault({
        load() { return existsSync(oauthFile) ? JSON.parse(safeStorage.decryptString(readFileSync(oauthFile))) : undefined; },
        save(tokens) {
          if (!tokens) { rmSync(oauthFile, { force: true }); return; }
          writeFileSync(`${oauthFile}.tmp`, safeStorage.encryptString(JSON.stringify(tokens)), { mode: 0o600 });
          renameSync(`${oauthFile}.tmp`, oauthFile);
        },
      });
      const path = join(data, 'provider-key.enc');
      store.setCredentialStorage({
        load(endpoint) {
          if (!existsSync(path)) return '';
          const saved = JSON.parse(safeStorage.decryptString(readFileSync(path)));
          return saved.version === 2 ? saved.keys?.[endpoint] || '' : saved.endpoint === endpoint ? saved.key : '';
        },
        save(endpoint, key) {
          const saved = existsSync(path) ? JSON.parse(safeStorage.decryptString(readFileSync(path))) : {};
          const keys = saved.version === 2 ? { ...saved.keys } : saved.endpoint && saved.key ? { [saved.endpoint]: saved.key } : {};
          if (key) keys[endpoint] = key; else delete keys[endpoint];
          if (!Object.keys(keys).length) { rmSync(path, { force: true }); return; }
          const tmp = `${path}.tmp`;
          writeFileSync(tmp, safeStorage.encryptString(JSON.stringify({ version: 2, keys })), { mode: 0o600 });
          renameSync(tmp, path);
        },
      });
    }
    const { createApp } = await import(pathToFileURL(join(__dirname, '..', 'dist', 'server.js')).href);
    const { createUpdates, managedUpdateInstaller } = await import(pathToFileURL(join(__dirname, '..', 'dist', 'updates.js')).href);
    const installRoot = join(app.getPath('home'), '.local', 'opt');
    const launcher = join(installRoot, 'linubot', 'linubot');
    const managedInstall = app.isPackaged && existsSync(launcher) && realpathSync(launcher) === realpathSync(app.getPath('exe')) && !existsSync(join(dirname(realpathSync(app.getPath('exe'))), '.linubot-source-build'));
    const updates = createUpdates({
      enabled: process.env.LINUBOT_UPDATE_CHECK !== '0',
      ...(managedInstall ? { install: managedUpdateInstaller({
        hasActiveWork: () => backend.hasActiveWork(),
        stage: async (release) => {
          const installer = join(process.resourcesPath, 'install.sh');
          await new Promise((resolve, reject) => execFile('/bin/bash', [installer, '--version', release.version, '--stage-only'], { timeout: 630000, maxBuffer: 32768, env: { ...process.env, LINUBOT_INSTALL_ROOT: installRoot } }, (error) => {
            if (error) reject(new Error('The update could not be downloaded or verified. Your installed version is unchanged.')); else resolve();
          }));
        },
        freeze: () => backend.freezeForUpdate(),
        activateAfterExit: async (release) => {
          // Use the verified new payload's installer. A separate unit survives
          // teardown of both linubot.service and the old transient desktop unit.
          const installer = join(installRoot, `linubot-${release.version}`, 'resources', 'install.sh');
          const script = 'for ((i=0; i<120; i++)); do if ! kill -0 "$1" 2>/dev/null; then exec /bin/bash "$2" --version "$3" --activate-only; fi; sleep 1; done; echo "Linubot did not exit; update remains staged." >&2; exit 1';
          const args = ['-c', script, 'linubot-update', String(process.pid), installer, release.version];
          const env = { ...process.env, LINUBOT_INSTALL_ROOT: installRoot }; delete env.ELECTRON_RUN_AS_NODE;
          if (spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5000 }).status === 0) {
            await new Promise((resolve, reject) => execFile('systemd-run', ['--user', '--collect', `--unit=linubot-update-${process.pid}`, '--property=Type=exec', '/bin/bash', ...args], { env, timeout: 15000 }, (error) => error ? reject(error) : resolve()));
          } else {
            const log = openSync(join(data, 'update-install.log'), 'a', 0o600);
            try {
              await new Promise((resolve, reject) => {
                const child = spawn('/bin/bash', args, { env, detached: true, stdio: ['ignore', log, log] });
                child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
              });
            } finally { closeSync(log); }
          }
        },
        quit: () => setImmediate(() => app.quit()),
      }) } : {}),
    });
    backend = createApp({ accessToken: token, onProviderConnected: show, updates, chooseImportFolder: async () => { const result = await dialog.showOpenDialog(window, { title: "Choose an exported bot folder", properties: ["openDirectory"] }); return result.canceled ? undefined : result.filePaths[0]; } });
    await new Promise((resolve, reject) => { backend.server.once('error', reject); backend.server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${backend.server.address().port}`;
    window = new BrowserWindow({ width: 1400, height: 940, minWidth: 880, minHeight: 600, title: 'Linubot', icon, show: false, backgroundColor: '#f5f3ed',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition: 'persist:linubot' } });
    window.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, 'x-linubot-token': token } });
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`${origin}/api/`)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:linubot' } } };
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); if (/^https?:\/\//.test(url)) void shell.openExternal(url); } });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.on('close', (event) => { if (!quitting) { event.preventDefault(); if (settings.background) window.hide(); else app.quit(); } });
    window.once('ready-to-show', show);
    const persistSettings = () => writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });
    const menu = [
      { label: 'Linubot', submenu: [{ label: 'Show team', click: show }, { label: 'Keep running in background', type: 'checkbox', checked: settings.background, click: (item) => { settings.background = item.checked; persistSettings(); } }, { type: 'separator' }, { label: 'Open data folder', click: () => shell.openPath(data) }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
    tray = new Tray(nativeImage.createFromPath(icon)); tray.setToolTip('Linubot');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Linubot', click: show }, { label: 'Quit Linubot', click: () => app.quit() }]));
    tray.on('click', show);
    await window.loadURL(origin);
    console.log(`Linubot desktop ready (${app.getVersion()})`);
  }).catch((error) => { console.error(error); dialog.showErrorBox('Linubot could not start', error.message); app.quit(); });
}
