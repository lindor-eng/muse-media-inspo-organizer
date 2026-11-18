import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getLibraryPath } from './database/connection';
import { getPreferences, onPreferencesChanged, setPreferences } from './preferences';
import { isCaptureServerListening, startCaptureServer, stopCaptureServer, type CaptureImporter } from './capture-server';
import { showInstallBrowserExtension } from './browser-extension';
import { isModelAvailable, isOllamaServerRunning } from './ai/ollama-server';
import { EMBED_MODEL, VISION_MODEL } from './ai/ollama-client';
import { sweepTrash } from './trash-sweeper';
import type { AiStatus, LibraryInfo, Preferences } from '../shared/preferences';

const REPO = 'lindor-eng/muse-media-inspo-organizer';

/** The menu events Settings may fire, to reuse the flows the File menu opens. */
const TRIGGERABLE = new Set(['menu:exportLibrary', 'menu:importLibrary', 'menu:updateModel', 'menu:checkUpdate']);

/** Total size of everything under a folder. */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(full);
    else if (entry.isFile()) total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** IPC behind Settings › General, Library, AI and Browser extension. */
export function registerSettingsIpc(db: Database.Database, importCaptured: CaptureImporter): void {
  ipcMain.handle('prefs:get', () => getPreferences());
  ipcMain.handle('prefs:set', (_, patch: Partial<Preferences>) => setPreferences(patch ?? {}));

  onPreferencesChanged((prefs, changed) => {
    if ('acceptCaptures' in changed) {
      if (prefs.acceptCaptures) startCaptureServer(importCaptured);
      else stopCaptureServer();
    }
    if ('emptyTrashAfterDays' in changed) sweepTrash(db);
  });

  // Settings buttons that open what the File menu opens.
  ipcMain.on('menu:trigger', (event, channel: unknown) => {
    if (typeof channel === 'string' && TRIGGERABLE.has(channel)) event.sender.send(channel);
  });

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
  ipcMain.handle('app:openReleaseNotes', () =>
    shell.openExternal(`https://github.com/${REPO}/releases/tag/v${app.getVersion()}`),
  );

  ipcMain.handle('library:info', async (): Promise<LibraryInfo> => {
    const row = db.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(is_trashed), 0) AS trashed FROM images').get() as { items: number; trashed: number };
    const libraryPath = getLibraryPath();
    return { path: libraryPath, items: row.items - row.trashed, trashed: row.trashed, bytes: await folderBytes(libraryPath) };
  });
  ipcMain.handle('library:showInFinder', () => shell.openPath(getLibraryPath()));

  ipcMain.handle('ai:status', async (): Promise<AiStatus> => {
    const engineRunning = await isOllamaServerRunning().catch(() => false);
    const [visionReady, embedReady] = engineRunning
      ? await Promise.all([isModelAvailable(VISION_MODEL).catch(() => false), isModelAvailable(EMBED_MODEL).catch(() => false)])
      : [false, false];
    return { engineRunning, visionModel: VISION_MODEL, visionReady, embedModel: EMBED_MODEL, embedReady };
  });

  ipcMain.handle('extension:install', (event) => showInstallBrowserExtension(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle('extension:status', () => ({ listening: isCaptureServerListening() }));
}
