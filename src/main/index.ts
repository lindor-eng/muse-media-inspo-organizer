import { app, BrowserWindow, ipcMain, dialog, nativeTheme, protocol, net } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { initDatabase } from './database/connection';
import { registerIpcHandlers } from './ipc-handlers';
import { startOllamaServer, stopOllamaServer } from './ai/ollama-server';
import { backfillMissingPalettes } from './color-extractor';

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

app.on('ready', async () => {
  protocol.handle('local-file', (request) => {
    const filePath = decodeURIComponent(request.url.replace('local-file://', ''));
    return net.fetch(`file://${filePath}`);
  });

  const db = initDatabase();
  registerIpcHandlers(db, ipcMain);
  createWindow();

  // Start managed Ollama server in background
  try {
    await startOllamaServer();
    console.log('[app] Ollama server ready');
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

ipcMain.handle('app:getDataPath', () => {
  return path.join(app.getPath('userData'), 'library');
});

ipcMain.handle('theme:get', () => {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

nativeTheme.on('updated', () => {
  mainWindow?.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
});
