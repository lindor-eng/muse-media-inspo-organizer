import type Database from 'better-sqlite3';
import type { IpcMain } from 'electron';
import { nativeImage, clipboard, BrowserWindow } from 'electron';
import { createFolderRepo } from './database/repositories/folders';
import { createImageRepo, type ImageFilter } from './database/repositories/images';
import { createTagRepo } from './database/repositories/tags';
import { importFiles } from './importer';
import { extractAndStoreColors, reindexAllThumbColorIndex } from './color-extractor';
import { isOllamaRunning } from './ai/ollama-client';
import { autoTagImage } from './ai/auto-tagger';
import { searchByText, findSimilarImagesWithPreviews, generateAndStoreEmbedding, getEmbeddingCount } from './ai/natural-search';
import { parseSimilarRefineModes } from '../shared/similar-refine';
import {
  loadSimilarityPrefs,
  saveSimilarityPrefs,
  type SimilarityPrefs,
} from './database/similarity-prefs';
import { isModelAvailable, pullModel, isOllamaServerRunning } from './ai/ollama-server';

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
  ipcMain.handle('images:restoreAll', () => {
    const trashed = db.prepare('SELECT id FROM images WHERE is_trashed = 1').all() as { id: string }[];
    for (const row of trashed) imageRepo.restore(row.id);
    return trashed.length;
  });
  ipcMain.handle('images:emptyTrash', () => {
    const trashed = db.prepare('SELECT id FROM images WHERE is_trashed = 1').all() as { id: string }[];
    for (const row of trashed) imageRepo.deletePermanently(row.id);
    return trashed.length;
  });
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
  ipcMain.handle('colors:reindexChromaticFlags', async () => {
    const r = await reindexAllThumbColorIndex(db);
    return { scanned: r.scanned, updated: r.chromaticWritten };
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
    // Queue AI tasks in background: LLaVA caption → caption embedding + pHash
    setTimeout(async () => {
      const win = BrowserWindow.getAllWindows()[0];
      const successful = results.filter((r) => r.success);
      const total = successful.length;
      if (total === 0) return;

      // Phase 1: LLaVA caption (writes alt_text, notes, tags)
      for (let i = 0; i < successful.length; i++) {
        win?.webContents.send('autotag:progress', {
          current: i,
          total,
          status: `Analyzing image ${i + 1} of ${total}...`,
        });
        await autoTagImage(db, successful[i].id).catch((err) => console.error('[import] auto-tag error:', err));
      }
      win?.webContents.send('autotag:progress', { current: total, total, status: 'Auto-tagging complete' });

      // Phase 2: Caption embedding + perceptual hash
      for (let i = 0; i < successful.length; i++) {
        win?.webContents.send('embedding:progress', {
          current: i,
          total,
          status: `Indexing image ${i + 1} of ${total}...`,
        });
        const img = imageRepo.getById(successful[i].id);
        if (img) {
          await generateAndStoreEmbedding(db, successful[i].id, img.original_path).catch((err) => console.warn('[embed] failed:', err));
        }
      }
      win?.webContents.send('embedding:progress', { current: total, total, status: 'Indexing complete' });
    }, 100);
    return results;
  });

  // AI
  ipcMain.handle('ai:status', async () => ({
    ollama: await isOllamaRunning(),
  }));

  ipcMain.handle('ai:autoTag', async (_, imageId: string) => {
    return autoTagImage(db, imageId);
  });

  ipcMain.handle('ai:reanalyzeImages', async (_, imageIds: string[]) => {
    const win = BrowserWindow.getAllWindows()[0];
    const total = imageIds.length;
    let processed = 0;
    for (let i = 0; i < imageIds.length; i++) {
      win?.webContents.send('autotag:progress', {
        current: i,
        total,
        status: total > 1 ? `Re-analyzing ${i + 1} of ${total}...` : 'Re-analyzing image...',
      });
      try {
        await autoTagImage(db, imageIds[i]);
        const img = imageRepo.getById(imageIds[i]);
        if (img) {
          await generateAndStoreEmbedding(db, imageIds[i], img.original_path).catch((err) => console.warn('[embed] failed:', err));
        }
        processed++;
      } catch (err) {
        console.error('[reanalyze] error for', imageIds[i], err);
      }
    }
    win?.webContents.send('autotag:progress', {
      current: total,
      total,
      status: 'Re-analysis complete',
    });
    return { processed, total };
  });

  ipcMain.handle('ai:searchByText', async (_, query: string) => {
    return searchByText(db, query);
  });

  ipcMain.handle('ai:findSimilar', async (_, imageId: string, opts?: unknown) => {
    const refineModes = parseSimilarRefineModes(
      opts && typeof opts === 'object' && opts !== null && 'refineModes' in opts
        ? (opts as { refineModes?: unknown }).refineModes
        : [],
    );
    return findSimilarImagesWithPreviews(db, imageId, { refineModes });
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

  ipcMain.handle('embeddings:hasForImage', (_, imageId: string) => {
    const row = db.prepare('SELECT 1 FROM image_embeddings WHERE image_id = ?').get(imageId);
    return Boolean(row);
  });

  ipcMain.handle('settings:getSimilarityPrefs', () => loadSimilarityPrefs(db));
  ipcMain.handle('settings:setSimilarityPrefs', (_, prefs: Partial<SimilarityPrefs>) => saveSimilarityPrefs(db, prefs));


  // Clipboard
  ipcMain.handle('clipboard:copyImage', (_, filePath: string) => {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
  });

  // Ollama model setup
  ipcMain.handle('ollama:isServerRunning', () => isOllamaServerRunning());
  ipcMain.handle('ollama:isModelReady', (_, model: string) => isModelAvailable(model));

  ipcMain.handle('ollama:pullModel', async (_, model: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    await pullModel(model, (progress) => {
      win?.webContents.send('ollama:pullProgress', {
        model,
        status: progress.status,
        total: progress.total ?? 0,
        completed: progress.completed ?? 0,
      });
    });
    return true;
  });
}
