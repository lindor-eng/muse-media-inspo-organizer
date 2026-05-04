import type Database from 'better-sqlite3';
import type { IpcMain } from 'electron';
import { nativeImage, clipboard } from 'electron';
import { createFolderRepo } from './database/repositories/folders';
import { createImageRepo, type ImageFilter } from './database/repositories/images';
import { createTagRepo } from './database/repositories/tags';
import { importFiles } from './importer';
import { extractAndStoreColors } from './color-extractor';
import { isOllamaRunning } from './ai/ollama-client';
import { autoTagImage } from './ai/auto-tagger';
import { isSidecarRunning, startSidecar, stopSidecar } from './ai/python-sidecar';
import { searchByText, findSimilarImages, generateAndStoreEmbedding, getEmbeddingCount } from './ai/natural-search';

export function registerIpcHandlers(db: Database.Database, ipcMain: IpcMain): void {
  const folderRepo = createFolderRepo(db);
  const imageRepo = createImageRepo(db);
  const tagRepo = createTagRepo(db);

  // Folders
  ipcMain.handle('folders:getAll', () => folderRepo.getAll());
  ipcMain.handle('folders:create', (_, name: string, parentId: string | null) => folderRepo.create(name, parentId));
  ipcMain.handle('folders:update', (_, id: string, data) => folderRepo.update(id, data));
  ipcMain.handle('folders:delete', (_, id: string) => folderRepo.delete(id));

  // Images
  ipcMain.handle('images:query', (_, filter: ImageFilter, limit: number, offset: number) => {
    return imageRepo.query(filter, limit, offset);
  });
  ipcMain.handle('images:getById', (_, id: string) => imageRepo.getById(id));
  ipcMain.handle('images:update', (_, id: string, data) => {
    console.log('[images:update]', id, JSON.stringify(data));
    const result = imageRepo.update(id, data);
    console.log('[images:update] result folder_id:', result.folder_id);
    return result;
  });
  ipcMain.handle('images:trash', (_, id: string) => imageRepo.trash(id));
  ipcMain.handle('images:restore', (_, id: string) => imageRepo.restore(id));
  ipcMain.handle('images:delete', (_, id: string) => imageRepo.deletePermanently(id));
  ipcMain.handle('images:getCounts', () => ({
    total: imageRepo.getTotalCount(),
    uncategorized: imageRepo.getUncategorizedCount(),
    untagged: imageRepo.getUntaggedCount(),
    trashed: imageRepo.getTrashedCount(),
  }));

  // Tags
  ipcMain.handle('tags:getAll', () => tagRepo.getAll());
  ipcMain.handle('tags:create', (_, name: string, color?: string) => tagRepo.create(name, color ?? null));
  ipcMain.handle('tags:delete', (_, id: string) => tagRepo.delete(id));
  ipcMain.handle('tags:addToImage', (_, imageId: string, tagId: string) => tagRepo.addToImage(imageId, tagId));
  ipcMain.handle('tags:removeFromImage', (_, imageId: string, tagId: string) => tagRepo.removeFromImage(imageId, tagId));
  ipcMain.handle('tags:getForImage', (_, imageId: string) => tagRepo.getForImage(imageId));
  ipcMain.handle('tags:getTotalCount', () => tagRepo.getTotalCount());

  // Colors
  ipcMain.handle('colors:getForImage', (_, imageId: string) => {
    return db.prepare('SELECT * FROM image_colors WHERE image_id = ? ORDER BY sort_order').all(imageId);
  });

  // Import
  ipcMain.handle('import:files', async (_, filePaths: string[], folderId: string | null) => {
    console.log('[import:files] called with paths:', filePaths);
    const results = await importFiles(db, filePaths, folderId);
    for (const result of results) {
      if (result.success && result.thumbnail_path) {
        try {
          await extractAndStoreColors(db, result.id, result.thumbnail_path);
        } catch {
          // Non-critical
        }
      }
    }
    // Queue auto-tagging and embedding generation in background (non-blocking)
    setTimeout(async () => {
      for (const result of results) {
        if (result.success) {
          await autoTagImage(db, result.id).catch(() => {});
          const img = imageRepo.getById(result.id);
          if (img) {
            await generateAndStoreEmbedding(db, result.id, img.original_path).catch(() => {});
          }
        }
      }
    }, 100);
    return results;
  });

  // AI
  ipcMain.handle('ai:status', async () => ({
    ollama: await isOllamaRunning(),
    sidecar: isSidecarRunning(),
  }));

  ipcMain.handle('ai:autoTag', async (_, imageId: string) => {
    return autoTagImage(db, imageId);
  });

  ipcMain.handle('ai:startSidecar', () => startSidecar());
  ipcMain.handle('ai:stopSidecar', () => stopSidecar());

  ipcMain.handle('ai:searchByText', async (_, query: string) => {
    return searchByText(db, query);
  });

  ipcMain.handle('ai:findSimilar', async (_, imageId: string) => {
    return findSimilarImages(db, imageId);
  });

  ipcMain.handle('ai:embeddingCount', () => getEmbeddingCount(db));

  ipcMain.handle('ai:generateMissingEmbeddings', async () => {
    const allImages = db.prepare(
      'SELECT id, original_path FROM images WHERE is_trashed = 0 AND id NOT IN (SELECT image_id FROM image_embeddings)'
    ).all() as { id: string; original_path: string }[];

    let generated = 0;
    for (const img of allImages) {
      const ok = await generateAndStoreEmbedding(db, img.id, img.original_path);
      if (ok) generated++;
    }
    return { generated, total: allImages.length };
  });

  // Clipboard
  ipcMain.handle('clipboard:copyImage', (_, filePath: string) => {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
  });
}
