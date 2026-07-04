import { app, BrowserWindow, ipcMain, dialog, nativeTheme, protocol, net, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { initDatabase } from './database/connection';
import { registerIpcHandlers } from './ipc-handlers';
import { startOllamaServer, stopOllamaServer } from './ai/ollama-server';
import { backfillMissingPalettes } from './color-extractor';
import { upgradeEmbeddingIndexIfNeeded } from './ai/embeddings';

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

  // Start managed Ollama server in background
  try {
    await startOllamaServer();
    console.log('[app] Ollama server ready');

    // Re-caption images produced by an older vision model / prompt generation.
    // Runs through the normal AI queue (progress toast, serial, interruptible) —
    // captions_version is stamped per image, so a quit mid-run resumes next launch.
    setTimeout(() => {
      const queued = ipcHooks.queueCaptionUpgradeIfNeeded();
      if (queued > 0) console.log(`[captions] queued ${queued} images for caption upgrade`);
    }, 10000);
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
