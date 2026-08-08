import { app, BrowserWindow, ipcMain, dialog, nativeTheme, protocol, net, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { initDatabase } from './database/connection';
import { registerIpcHandlers } from './ipc-handlers';
import { ensureOllamaServer, stopOllamaServer } from './ai/ollama-server';
import { backfillMissingPalettes } from './color-extractor';
import { upgradeEmbeddingIndexIfNeeded } from './ai/embeddings';
import { checkForUpdate, downloadUpdate, installAndRestart, type UpdateInfo } from './updater';

if (started) app.quit();

protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } },
]);

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a2e' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.webContents.on('will-navigate', (e) => {
    e.preventDefault();
  });
};

function buildAppMenu(): void {
  const sendToRenderer = (channel: string) => () => {
    BrowserWindow.getFocusedWindow()?.webContents.send(channel);
  };

  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'Import Files…',
          accelerator: 'CmdOrCtrl+O',
          click: sendToRenderer('menu:importFiles'),
        },
        { type: 'separator' },
        { label: 'Export Library…', click: sendToRenderer('menu:exportLibrary') },
        { label: 'Import Library…', click: sendToRenderer('menu:importLibrary') },
        { type: 'separator' },
        { label: 'Update AI Model…', click: sendToRenderer('menu:updateModel') },
        { label: 'Check for Updates…', click: sendToRenderer('menu:checkUpdate') },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('ready', async () => {
  protocol.handle('local-file', (request) => {
    const filePath = decodeURIComponent(request.url.replace('local-file://', ''));
    return net.fetch(`file://${filePath}`);
  });

  const db = initDatabase();
  const ipcHooks = registerIpcHandlers(db, ipcMain);
  buildAppMenu();
  createWindow();

  // Start managed Ollama server in background. A failure here is no longer terminal for the
  // session — File → Update AI Model retries through the same path.
  try {
    const start = await ensureOllamaServer();
    if (start.running) {
      console.log('[app] Ollama server ready');

      // Re-caption images produced by an older vision model / prompt generation.
      // Runs through the normal AI queue (progress toast, serial, interruptible) —
      // captions_version is stamped per image, so a quit mid-run resumes next launch.
      setTimeout(() => {
        const queued = ipcHooks.queueCaptionUpgradeIfNeeded();
        if (queued > 0) console.log(`[captions] queued ${queued} images for caption upgrade`);
      }, 10000);
    } else {
      console.error(
        `[app] Ollama server unavailable (${start.reason}): ${start.detail ?? 'no detail'}`,
      );
    }
  } catch (err) {
    console.error('[app] Failed to start Ollama server:', err);
  }

  // Silently backfill missing color palettes so the colors-refine filter has data for
  // older imports without forcing the user to re-analyze. Runs once per launch on a
  // delayed timer so it doesn't compete with the initial render.
  setTimeout(() => {
    backfillMissingPalettes(db)
      .then(({ scanned, backfilled }) => {
        if (scanned > 0) console.log(`[palettes] backfilled ${backfilled}/${scanned} missing rows`);
      })
      .catch((err) => console.warn('[palettes] backfill failed:', err));
  }, 5000);

  // One-time re-embed when the embedding index format changes (e.g. nomic task prefixes).
  // Surfaced through the existing indexing toast; retried next launch if interrupted.
  setTimeout(() => {
    upgradeEmbeddingIndexIfNeeded(db, (current, total) => {
      mainWindow?.webContents.send('embedding:progress', {
        current,
        total,
        status:
          current >= total
            ? 'Search index upgraded'
            : `Upgrading search index ${current} of ${total}...`,
      });
    })
      .then((result) => {
        if (result) console.log(`[embeddings] index upgrade: ${result.reembedded}/${result.total} re-embedded`);
      })
      .catch((err) => console.warn('[embeddings] index upgrade failed:', err));
  }, 8000);

  // Silent update check on launch (packaged builds only — dev runs report app.getVersion() of the
  // dev tree, and there's no installer to swap in). If a newer release exists, tell the renderer so
  // it can prompt; failures stay silent here — the user can still trigger a manual check that does
  // surface errors. Delayed so it never competes with first paint or the Ollama warm-up.
  if (app.isPackaged) {
    setTimeout(() => {
      checkForUpdate()
        .then((result) => {
          if (result.updateAvailable && result.info) {
            mainWindow?.webContents.send('update:available', result.info);
          }
        })
        .catch((err) => console.warn('[update] startup check failed:', err));
    }, 12000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopOllamaServer();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('log', (_, msg) => {
  console.log(msg);
});

ipcMain.on('files-imported', (event) => {
  event.sender.send('files-imported');
});

ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'tiff', 'tif', 'bmp'] },
    ],
  });
  return result.filePaths;
});

ipcMain.handle('dialog:saveLibraryBundle', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog({
    title: 'Export Muse Library',
    defaultPath: `Muse Library ${today}.muse`,
    filters: [{ name: 'Muse Library', extensions: ['muse'] }],
  });
  return result.canceled ? null : result.filePath ?? null;
});

ipcMain.handle('dialog:openLibraryBundle', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import Muse Library',
    properties: ['openFile'],
    filters: [{ name: 'Muse Library', extensions: ['muse'] }],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('app:getDataPath', () => {
  return path.join(app.getPath('userData'), 'library');
});

ipcMain.handle('theme:get', () => {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

nativeTheme.on('updated', () => {
  mainWindow?.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
});

// App auto-update (GitHub Releases → unsigned .pkg → osascript installer → relaunch).
ipcMain.handle('update:check', () => checkForUpdate());

ipcMain.handle('update:download', async (_event, info: UpdateInfo) => {
  const win = BrowserWindow.getAllWindows()[0];
  const pkgPath = await downloadUpdate(info, (p) => {
    win?.webContents.send('update:downloadProgress', p);
  });
  return pkgPath;
});

// Installing quits the app, so this only "returns" if the user cancels the admin prompt or it fails.
ipcMain.handle('update:install', async (_event, pkgPath: string) => {
  await installAndRestart(pkgPath);
  return true;
});
