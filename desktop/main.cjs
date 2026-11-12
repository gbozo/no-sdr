// Electron shell for NO(DE)-SDR.
//
// The Rust server remains the single source of truth. This process only
// prepares a per-user config/state directory, starts a bundled serverrs on a
// loopback port chosen at launch, and points a Chromium window at it.
//
// Keeping the server as a child process means the desktop build uses exactly
// the same REST/WebSocket protocol, DSP pipeline and hardware drivers as the
// standalone binaries.

const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const APP_NAME = 'NO(DE)-SDR';
const DEV_ROOT = path.resolve(__dirname, '..');
const SERVER_BINARY = process.platform === 'win32' ? 'serverrs.exe' : 'serverrs';
const MAX_LOG_BYTES = 5 * 1024 * 1024;

let mainWindow = null;
let serverProcess = null;
let serverPort = 0;
let serverExited = false;
let quitting = false;
let logStream = null;

app.setName(APP_NAME);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(startDesktopApp);
}

function resourcePath(...parts) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...parts)
    : path.join(DEV_ROOT, ...parts);
}

function serverBinaryPath() {
  if (process.env.SERVERRS_BIN) return path.resolve(process.env.SERVERRS_BIN);
  return app.isPackaged
    ? resourcePath('runtime', SERVER_BINARY)
    : path.join(DEV_ROOT, 'serverrs', 'target', 'release', SERVER_BINARY);
}

function clientDir() {
  return app.isPackaged
    ? resourcePath('client')
    : path.join(DEV_ROOT, 'client', 'dist');
}

function configTemplatePath() {
  return app.isPackaged
    ? resourcePath('config', 'config.yaml')
    : path.join(DEV_ROOT, 'config', 'config.yaml');
}

function bookmarksTemplateDir() {
  return app.isPackaged
    ? resourcePath('bookmarks-default')
    : path.join(DEV_ROOT, 'bookmarks');
}

function userPaths() {
  const userData = app.getPath('userData');
  return {
    userData,
    config: path.join(userData, 'config', 'config.yaml'),
    bookmarks: path.join(userData, 'bookmarks'),
    log: path.join(userData, 'server.log'),
    port: path.join(userData, 'port'),
  };
}

function ensureUserData() {
  const paths = userPaths();
  fs.mkdirSync(path.dirname(paths.config), { recursive: true });
  fs.mkdirSync(paths.bookmarks, { recursive: true });

  if (!fs.existsSync(paths.config)) {
    const template = configTemplatePath();
    if (!fs.existsSync(template)) {
      throw new Error(`configuration template missing: ${template}`);
    }
    fs.copyFileSync(template, paths.config);
  }

  const bookmarksTemplate = bookmarksTemplateDir();
  if (
    fs.existsSync(bookmarksTemplate) &&
    fs.readdirSync(paths.bookmarks).length === 0
  ) {
    fs.cpSync(bookmarksTemplate, paths.bookmarks, { recursive: true });
  }
  return paths;
}

function openLog(paths) {
  try {
    if (fs.existsSync(paths.log) && fs.statSync(paths.log).size > MAX_LOG_BYTES) {
      fs.renameSync(paths.log, `${paths.log}.old`);
    }
  } catch {
    // A log rotation failure must not stop the receiver.
  }
  logStream = fs.createWriteStream(paths.log, { flags: 'a' });
}

function appendLog(chunk) {
  if (!logStream) return;
  logStream.write(chunk);
  if (!app.isPackaged) process.stdout.write(chunk);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * Prefer the port this installation used last time. Keeping it stable matters
 * because the client's localStorage (UI preferences and saved state) is keyed
 * by origin; falling back to a new free port is only for the case where
 * something else has taken it.
 */
async function choosePort(paths) {
  try {
    const saved = Number.parseInt(fs.readFileSync(paths.port, 'utf8'), 10);
    if (saved > 0 && saved < 65536 && (await portAvailable(saved))) return saved;
  } catch {
    // No saved port yet.
  }
  const port = await findFreePort();
  try {
    fs.writeFileSync(paths.port, `${port}\n`);
  } catch {
    // A read-only user-data directory is a bigger problem, but not this one.
  }
  return port;
}

function startServer(port, paths) {
  const binary = serverBinaryPath();
  if (!fs.existsSync(binary)) {
    throw new Error(
      `server binary missing: ${binary}\n\nBuild it with ` +
        `cargo build --release --all-features --manifest-path serverrs/Cargo.toml`
    );
  }
  const staticDir = clientDir();
  if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
    throw new Error(
      `web client missing: ${staticDir}\n\nBuild it with npm run build:client`
    );
  }

  serverExited = false;
  serverPort = port;
  const env = {
    ...process.env,
    CONFIG_PATH: paths.config,
    STATIC_DIR: staticDir,
    BOOKMARKS_DIR: paths.bookmarks,
    HOST: '127.0.0.1',
    PORT: String(port),
  };

  appendLog(`\n[desktop] starting ${binary} on 127.0.0.1:${port}\n`);
  serverProcess = spawn(binary, [], {
    cwd: path.dirname(binary),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProcess.stdout.on('data', (chunk) => appendLog(chunk));
  serverProcess.stderr.on('data', (chunk) => appendLog(chunk));
  serverProcess.on('error', (error) => {
    appendLog(`[desktop] server spawn failed: ${error.message}\n`);
  });
  serverProcess.on('exit', (code, signal) => {
    serverExited = true;
    serverProcess = null;
    appendLog(`[desktop] server exited code=${code} signal=${signal}\n`);
    if (!quitting && mainWindow) {
      dialog.showErrorBox(
        'NO(DE)-SDR server stopped',
        `The receiver server exited unexpectedly.\n\nSee ${paths.log} for details.`
      );
      app.quit();
    }
  });
}

function probeServer(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: 1200 },
      (res) => {
        res.resume();
        resolve(Boolean(res.statusCode && res.statusCode < 500));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(port, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (serverExited) {
      throw new Error('the receiver server exited before becoming ready');
    }
    if (await probeServer(port)) return;
    await delay(250);
  }
  throw new Error(`the receiver server did not answer on 127.0.0.1:${port}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#07090e',
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  return mainWindow;
}

async function startDesktopApp() {
  app.setAppUserModelId('org.nosdr.desktop');
  createWindow();

  let paths;
  try {
    paths = ensureUserData();
    openLog(paths);
    const port = await choosePort(paths);
    startServer(port, paths);
    await waitForServer(port);
    if (!mainWindow) return;
    await mainWindow.loadURL(`http://127.0.0.1:${port}`);
    mainWindow.setTitle(APP_NAME);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendLog(`[desktop] startup failed: ${detail}\n`);
    dialog.showErrorBox('NO(DE)-SDR could not start', detail);
    app.quit();
  }
}

function stopServer() {
  const child = serverProcess;
  serverProcess = null;
  if (!child || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    // The process may already have gone.
  }
  setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }, 3000).unref();
}

app.on('before-quit', () => {
  quitting = true;
  stopServer();
  try {
    logStream?.end();
  } catch {
    // Nothing useful to do while shutting down.
  }
});

app.on('window-all-closed', () => {
  if (!quitting) app.quit();
});

app.on('activate', () => {
  if (!mainWindow && serverPort) {
    createWindow();
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  }
});
