import { contextBridge, ipcRenderer, webUtils } from 'electron';

let currentFolderId: string | null = null;

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
  openFileDialog: () => ipcRenderer.invoke('dialog:openFiles'),

  // Theme
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChange: (callback: (theme: string) => void) => {
    const handler = (_: unknown, theme: string) => callback(theme);
    ipcRenderer.on('theme:changed', handler);
    return () => ipcRenderer.removeListener('theme:changed', handler);
  },

  // AI
  getAIStatus: () => ipcRenderer.invoke('ai:status'),
  autoTag: (imageId: string) => ipcRenderer.invoke('ai:autoTag', imageId),
  searchByText: (query: string) => ipcRenderer.invoke('ai:searchByText', query),
  findSimilar: (imageId: string) => ipcRenderer.invoke('ai:findSimilar', imageId),
  getEmbeddingCount: () => ipcRenderer.invoke('ai:embeddingCount'),
  generateMissingEmbeddings: () => ipcRenderer.invoke('ai:generateMissingEmbeddings'),

  // Embedding progress
  onEmbeddingProgress: (callback: (data: { current: number; total: number; status: string }) => void) => {
    const handler = (_: unknown, data: { current: number; total: number; status: string }) => callback(data);
    ipcRenderer.on('embedding:progress', handler);
    return () => ipcRenderer.removeListener('embedding:progress', handler);
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

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const p = webUtils.getPathForFile(files[i]);
        if (p) paths.push(p);
      } catch (err) {
        ipcRenderer.send('log', `[preload-drop] getPathForFile error: ${err}`);
      }
    }

    ipcRenderer.send('log', `[preload-drop] paths: ${JSON.stringify(paths)}, folder: ${currentFolderId}`);
    if (paths.length > 0) {
      ipcRenderer.invoke('import:files', paths, currentFolderId).then(() => {
        ipcRenderer.send('log', '[preload-drop] import complete');
        ipcRenderer.send('files-imported');
      });
    }
  });
});
