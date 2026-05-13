import { contextBridge, ipcRenderer, webUtils } from 'electron';
import os from 'node:os';

import type { SimilarRefineMode } from '../shared/similar-refine';

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
  searchByText: (query: string) => ipcRenderer.invoke('ai:searchByText', query),
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

  // Ollama model setup
  isOllamaServerRunning: () => ipcRenderer.invoke('ollama:isServerRunning'),
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
