import { contextBridge, ipcRenderer, webUtils } from 'electron';
import os from 'node:os';

import type { SimilarRefineMode } from '../shared/similar-refine';
import type { OllamaStartResult } from '../shared/ollama-status';
import type { ImportStatus } from '../shared/import-status';

/** Update metadata surfaced to the renderer — mirrors UpdateInfo in main/updater.ts. Declared
    locally so the preload bundle never imports the main process (which pulls in electron's app). */
interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  pkgUrl: string;
  size: number;
  filename: string;
}

let currentFolderId: string | null = null;

/** Cache the username at preload time — it doesn't change while the app is running. */
const localUsername = (() => {
  try { return os.userInfo().username; } catch { return ''; }
})();

const api = {
  // Folders
  getFolders: () => ipcRenderer.invoke('folders:getAll'),
  createFolder: (name: string, parentId: string | null) => ipcRenderer.invoke('folders:create', name, parentId),
  updateFolder: (id: string, data: unknown) => ipcRenderer.invoke('folders:update', id, data),
  deleteFolder: (id: string) => ipcRenderer.invoke('folders:delete', id),

  // Images
  queryImages: (filter: unknown, limit?: number, offset?: number) =>
    ipcRenderer.invoke('images:query', filter, limit ?? 100, offset ?? 0),
  getImage: (id: string) => ipcRenderer.invoke('images:getById', id),
  updateImage: (id: string, data: unknown) => ipcRenderer.invoke('images:update', id, data),
  trashImage: (id: string) => ipcRenderer.invoke('images:trash', id),
  restoreImage: (id: string) => ipcRenderer.invoke('images:restore', id),
  deleteImage: (id: string) => ipcRenderer.invoke('images:delete', id),
  restoreAllTrashed: () => ipcRenderer.invoke('images:restoreAll'),
  emptyTrash: () => ipcRenderer.invoke('images:emptyTrash'),
  getImageCounts: () => ipcRenderer.invoke('images:getCounts'),

  // Tags
  getTags: () => ipcRenderer.invoke('tags:getAll'),
  createTag: (name: string, color?: string) => ipcRenderer.invoke('tags:create', name, color),
  deleteTag: (id: string) => ipcRenderer.invoke('tags:delete', id),
  addTagToImage: (imageId: string, tagId: string) => ipcRenderer.invoke('tags:addToImage', imageId, tagId),
  removeTagFromImage: (imageId: string, tagId: string) => ipcRenderer.invoke('tags:removeFromImage', imageId, tagId),
  getTagsForImage: (imageId: string) => ipcRenderer.invoke('tags:getForImage', imageId),

  // Colors
  getColorsForImage: (imageId: string) => ipcRenderer.invoke('colors:getForImage', imageId),

  // Import
  importFiles: (filePaths: string[], folderId: string | null) =>
    ipcRenderer.invoke('import:files', filePaths, folderId),
  importUrl: (url: string, folderId: string | null) =>
    ipcRenderer.invoke('import:url', url, folderId),
  importBuffer: (bytes: ArrayBuffer, filename: string, folderId: string | null) =>
    ipcRenderer.invoke('import:buffer', { bytes, filename }, folderId),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFiles'),

  // Theme
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChange: (callback: (theme: string) => void) => {
    const handler = (_: unknown, theme: string) => callback(theme);
    ipcRenderer.on('theme:changed', handler);
    return () => ipcRenderer.removeListener('theme:changed', handler);
  },

  // AI
  reanalyzeImages: (imageIds: string[]) => ipcRenderer.invoke('ai:reanalyzeImages', imageIds),
  getAnalyzableCount: () => ipcRenderer.invoke('ai:analyzableCount') as Promise<number>,
  reanalyzeAll: () => ipcRenderer.invoke('ai:reanalyzeAll') as Promise<{ queued: number }>,
  searchByText: (query: string, limit?: number, opts?: { applySimilarityFloor?: boolean }) =>
    ipcRenderer.invoke('ai:searchByText', query, limit, opts),
  searchForMoodboard: (prompt: string, limit?: number, opts?: { visionRerank?: boolean }) =>
    ipcRenderer.invoke('ai:searchForMoodboard', prompt, limit, opts),
  onMoodboardProgress: (
    callback: (p: { stage: 'analyzing' | 'searching' | 'verifying'; current?: number; total?: number }) => void,
  ) => {
    const handler = (
      _: unknown,
      p: { stage: 'analyzing' | 'searching' | 'verifying'; current?: number; total?: number },
    ) => callback(p);
    ipcRenderer.on('moodboard:progress', handler);
    return () => { ipcRenderer.removeListener('moodboard:progress', handler); };
  },
  getSimilarImages: (imageId: string, opts?: { refineModes?: SimilarRefineMode[] }) =>
    ipcRenderer.invoke('ai:findSimilar', imageId, opts ?? {}),

  embeddingsHasForImage: (imageId: string) => ipcRenderer.invoke('embeddings:hasForImage', imageId),
  getSimilarityPrefs: () => ipcRenderer.invoke('settings:getSimilarityPrefs'),
  setSimilarityPrefs: (prefs: unknown) => ipcRenderer.invoke('settings:setSimilarityPrefs', prefs),

  // AI progress events
  onEmbeddingProgress: (callback: (data: { current: number; total: number; status: string }) => void) => {
    const handler = (_: unknown, data: { current: number; total: number; status: string }) => callback(data);
    ipcRenderer.on('embedding:progress', handler);
    return () => ipcRenderer.removeListener('embedding:progress', handler);
  },
  onAutotagProgress: (callback: (data: { current: number; total: number; status: string }) => void) => {
    const handler = (_: unknown, data: { current: number; total: number; status: string }) => callback(data);
    ipcRenderer.on('autotag:progress', handler);
    return () => ipcRenderer.removeListener('autotag:progress', handler);
  },

  // App auto-update (GitHub Releases → .pkg installer)
  checkForUpdate: () =>
    ipcRenderer.invoke('update:check') as Promise<{
      updateAvailable: boolean;
      info?: UpdateInfo;
      error?: string;
    }>,
  downloadUpdate: (info: UpdateInfo) => ipcRenderer.invoke('update:download', info) as Promise<string>,
  installUpdate: (pkgPath: string) => ipcRenderer.invoke('update:install', pkgPath) as Promise<boolean>,
  onUpdateProgress: (callback: (p: { completed: number; total: number }) => void) => {
    const handler = (_: unknown, p: { completed: number; total: number }) => callback(p);
    ipcRenderer.on('update:downloadProgress', handler);
    return () => { ipcRenderer.removeListener('update:downloadProgress', handler); };
  },
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => {
    const handler = (_: unknown, info: UpdateInfo) => callback(info);
    ipcRenderer.on('update:available', handler);
    return () => { ipcRenderer.removeListener('update:available', handler); };
  },

  // Ollama model setup
  isOllamaServerRunning: () => ipcRenderer.invoke('ollama:isServerRunning'),
  /** Starts the server if it's down and reports why if it can't — use this over the plain
      probe anywhere the user is waiting on the AI engine. */
  ensureOllamaServer: () => ipcRenderer.invoke('ollama:ensureServer') as Promise<OllamaStartResult>,
  isModelReady: (model: string) => ipcRenderer.invoke('ollama:isModelReady', model),
  pullModel: (model: string) => ipcRenderer.invoke('ollama:pullModel', model),
  onPullProgress: (callback: (data: { model: string; status: string; total: number; completed: number }) => void) => {
    const handler = (_: unknown, data: { model: string; status: string; total: number; completed: number }) => callback(data);
    ipcRenderer.on('ollama:pullProgress', handler);
    return () => ipcRenderer.removeListener('ollama:pullProgress', handler);
  },

  // Get native file path from a dropped File object
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Listen for drop-import completion from preload
  onFilesImported: (callback: () => void) => {
    ipcRenderer.on('files-imported', callback);
    return () => ipcRenderer.removeListener('files-imported', callback);
  },

  /** Scan → per-image → summary ticks for path imports (drops and the file picker). */
  onImportProgress: (callback: (status: ImportStatus) => void) => {
    const handler = (_: unknown, status: ImportStatus) => callback(status);
    ipcRenderer.on('import:progress', handler);
    return () => { ipcRenderer.removeListener('import:progress', handler); };
  },

  /** A dropped `.muse` bundle, routed here instead of through the image importer. */
  onLibraryImportDropped: (callback: (zipPath: string) => void) => {
    const handler = (_: unknown, zipPath: string) => callback(zipPath);
    ipcRenderer.on('library:import:dropped', handler);
    return () => { ipcRenderer.removeListener('library:import:dropped', handler); };
  },

  // Clipboard
  copyImageToClipboard: (filePath: string) => ipcRenderer.invoke('clipboard:copyImage', filePath),

  // Current folder for drop imports
  setCurrentFolder: (folderId: string | null) => { currentFolderId = folderId; },

  // Debug
  log: (msg: string) => ipcRenderer.send('log', msg),

  /** Local macOS account name (e.g. "brian.lin"). Used as a personalized app title. */
  getLocalUsername: () => localUsername,

  // File protocol for displaying local images
  getFileUrl: (filePath: string) => `local-file://${filePath}`,

  // Native menu events ("File → …") forwarded from the main process to the renderer.
  onMenuEvent: (
    channel: 'menu:importFiles' | 'menu:exportLibrary' | 'menu:importLibrary' | 'menu:updateModel' | 'menu:checkUpdate',
    callback: () => void,
  ) => {
    const handler = () => callback();
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  },

  // Library export / import dialogs and IPC.
  chooseSaveLibraryBundle: () => ipcRenderer.invoke('dialog:saveLibraryBundle') as Promise<string | null>,
  chooseOpenLibraryBundle: () => ipcRenderer.invoke('dialog:openLibraryBundle') as Promise<string | null>,
  exportLibrary: (destZipPath: string) =>
    ipcRenderer.invoke('library:export', destZipPath) as Promise<{
      originalsCount: number;
      thumbnailsCount: number;
      bytes: number;
    }>,
  inspectImportLibrary: (zipPath: string) => ipcRenderer.invoke('library:inspectImport', zipPath),
  applyImportLibrary: (sessionId: string, decisions: Record<string, 'replace' | 'keep'>) =>
    ipcRenderer.invoke('library:applyImport', { sessionId, decisions }) as Promise<{
      added: number;
      replaced: number;
      kept: number;
    }>,
  cancelImportLibrary: (sessionId: string) => ipcRenderer.invoke('library:cancelImport', sessionId) as Promise<void>,
  onLibraryExportProgress: (
    callback: (p: { phase: 'snapshot' | 'archive' | 'finalize'; current: number; total: number }) => void,
  ) => {
    const handler = (_: unknown, p: { phase: 'snapshot' | 'archive' | 'finalize'; current: number; total: number }) =>
      callback(p);
    ipcRenderer.on('library:export:progress', handler);
    return () => { ipcRenderer.removeListener('library:export:progress', handler); };
  },
  onLibraryImportProgress: (
    callback: (p: { phase: 'extract' | 'inspect' | 'apply' | 'finalize'; current: number; total: number }) => void,
  ) => {
    const handler = (
      _: unknown,
      p: { phase: 'extract' | 'inspect' | 'apply' | 'finalize'; current: number; total: number },
    ) => callback(p);
    ipcRenderer.on('library:import:progress', handler);
    return () => { ipcRenderer.removeListener('library:import:progress', handler); };
  },
};

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);

// Handle file drops in the preload world where webUtils.getPathForFile works
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;

    const files = dt.files;
    const localPaths: string[] = [];
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        try {
          const p = webUtils.getPathForFile(files[i]);
          if (p) localPaths.push(p);
        } catch (err) {
          ipcRenderer.send('log', `[preload-drop] getPathForFile error: ${err}`);
        }
      }
    }

    if (localPaths.length > 0) {
      ipcRenderer.send('log', `[preload-drop] paths: ${JSON.stringify(localPaths)}, folder: ${currentFolderId}`);
      await ipcRenderer.invoke('import:files', localPaths, currentFolderId);
      ipcRenderer.send('log', '[preload-drop] file import complete');
      ipcRenderer.send('files-imported');
      return;
    }

    // Browser drag: no local file path, look for URL payloads.
    const urls = collectDroppedUrls(dt);
    if (urls.length === 0) {
      ipcRenderer.send('log', '[preload-drop] drop had no files or URLs');
      return;
    }

    ipcRenderer.send('log', `[preload-drop] urls: ${JSON.stringify(urls)}, folder: ${currentFolderId}`);
    for (const url of urls) {
      try {
        await ipcRenderer.invoke('import:url', url, currentFolderId);
      } catch (err) {
        ipcRenderer.send('log', `[preload-drop] url import error: ${err}`);
      }
    }
    ipcRenderer.send('files-imported');
  });
});

/** Pull image URLs out of a browser drag — checks uri-list, x-moz-url, then HTML <img src>. */
function collectDroppedUrls(dt: DataTransfer): string[] {
  const out: string[] = [];

  const uriList = dt.getData('text/uri-list');
  if (uriList) {
    for (const line of uriList.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) out.push(trimmed);
    }
  }

  if (out.length === 0) {
    const mozUrl = dt.getData('text/x-moz-url');
    if (mozUrl) {
      // Firefox emits "<url>\n<title>" pairs; we only want the URLs.
      const lines = mozUrl.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 2) {
        const trimmed = lines[i].trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }

  if (out.length === 0) {
    const html = dt.getData('text/html');
    if (html) {
      const re = /<img[^>]+src=["']([^"']+)["']/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) out.push(m[1]);
    }
  }

  if (out.length === 0) {
    const text = dt.getData('text/plain').trim();
    if (/^https?:\/\//i.test(text) || text.startsWith('data:')) out.push(text);
  }

  return out.filter((u) => /^https?:\/\//i.test(u) || u.startsWith('data:'));
}
