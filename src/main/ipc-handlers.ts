import type Database from 'better-sqlite3';
import type { IpcMain } from 'electron';
import { nativeImage, clipboard, BrowserWindow } from 'electron';
import { createFolderRepo } from './database/repositories/folders';
import { createImageRepo, type ImageFilter } from './database/repositories/images';
import { createTagRepo } from './database/repositories/tags';
import { importFiles, importFromUrl, importFromBuffer, type ImportResult } from './importer';
import { extractAndStoreColors } from './color-extractor';
import { autoTagImage, CAPTIONS_VERSION } from './ai/auto-tagger';
import {
  searchByText,
  searchForMoodboard,
  findSimilarImagesWithPreviews,
  generateAndStoreEmbedding,
} from './ai/natural-search';
import { parseSimilarRefineModes } from '../shared/similar-refine';
import {
  loadSimilarityPrefs,
  saveSimilarityPrefs,
  type SimilarityPrefs,
} from './database/similarity-prefs';
import { isModelAvailable, pullModel, isOllamaServerRunning } from './ai/ollama-server';
import { exportLibrary } from './library-export';
import { inspectImport, applyImport, cancelImport } from './library-import';

export interface IpcHooks {
  /** Queue a caption refresh (re-analyze + re-embed) for images captioned by an older
      model/prompt generation. Call after the Ollama server is confirmed up. */
  queueCaptionUpgradeIfNeeded: () => number;
}

export function registerIpcHandlers(db: Database.Database, ipcMain: IpcMain): IpcHooks {
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

  // Import
  // Singleton AI pipeline so concurrent imports never run LLaVA / Ollama in parallel.
  // New images enqueued mid-run extend the in-flight totals instead of starting a second drainer.
  const aiQueue: string[] = [];
  /** Ids queued for a caption *refresh* (model/prompt upgrade or explicit re-analyze):
      stale auto-tags and the model-written description get replaced, not accumulated. */
  const aiRefreshIds = new Set<string>();
  let aiTotal = 0;
  let aiCompleted = 0;
  let aiDraining = false;

  function broadcastAutotag(status: string): void {
    const win = BrowserWindow.getAllWindows()[0];
    win?.webContents.send('autotag:progress', { current: aiCompleted, total: aiTotal, status });
  }

  function broadcastEmbedding(status: string): void {
    const win = BrowserWindow.getAllWindows()[0];
    win?.webContents.send('embedding:progress', { current: aiCompleted, total: aiTotal, status });
  }

  async function drainAiQueue(): Promise<void> {
    if (aiDraining) return;
    aiDraining = true;
    try {
      while (aiQueue.length > 0) {
        const id = aiQueue.shift()!;
        const idx = aiCompleted + 1;
        broadcastAutotag(`Analyzing image ${idx} of ${aiTotal}...`);
        try {
          await autoTagImage(db, id, { refresh: aiRefreshIds.has(id) });
        } catch (err) {
          console.error('[ai-queue] auto-tag error:', err);
        } finally {
          aiRefreshIds.delete(id);
        }

        broadcastEmbedding(`Indexing image ${idx} of ${aiTotal}...`);
        const img = imageRepo.getById(id);
        if (img) {
          await generateAndStoreEmbedding(db, id, img.original_path).catch((err) =>
            console.warn('[ai-queue] embed failed:', err),
          );
          if (img.thumbnail_path) {
            await extractAndStoreColors(db, id, img.thumbnail_path).catch((err) =>
              console.warn('[ai-queue] color extract failed:', err),
            );
          }
        }

        aiCompleted++;
        broadcastAutotag(aiCompleted >= aiTotal ? 'Auto-tagging complete' : `Analyzed ${aiCompleted} of ${aiTotal}`);
        broadcastEmbedding(aiCompleted >= aiTotal ? 'Indexing complete' : `Indexed ${aiCompleted} of ${aiTotal}`);
      }
    } finally {
      aiDraining = false;
      // Reset counters once the queue fully drains so the next batch starts fresh at 0/N.
      if (aiQueue.length === 0) {
        aiTotal = 0;
        aiCompleted = 0;
      }
    }
  }

  async function enrichImportResults(results: ImportResult[]): Promise<void> {
    for (const result of results) {
      if (result.success && result.thumbnail_path) {
        try {
          await extractAndStoreColors(db, result.id, result.thumbnail_path);
        } catch {
          // Non-critical
        }
      }
    }

    const successfulIds = results.filter((r) => r.success).map((r) => r.id);
    if (successfulIds.length === 0) return;

    aiQueue.push(...successfulIds);
    aiTotal += successfulIds.length;
    // Surface the new total immediately so the toast ticks up before the worker reaches the new item.
    broadcastAutotag(`Analyzing image ${Math.min(aiCompleted + 1, aiTotal)} of ${aiTotal}...`);

    if (!aiDraining) {
      setTimeout(() => {
        void drainAiQueue();
      }, 100);
    }
  }

  ipcMain.handle('import:files', async (_, filePaths: string[], folderId: string | null) => {
    console.log('[import:files] called with paths:', filePaths);
    const results = await importFiles(db, filePaths, folderId);
    await enrichImportResults(results);
    return results;
  });

  ipcMain.handle('import:url', async (_, url: string, folderId: string | null) => {
    console.log('[import:url] called with url:', url);
    const result = await importFromUrl(db, url, folderId);
    await enrichImportResults([result]);
    return result;
  });

  ipcMain.handle(
    'import:buffer',
    async (_, payload: { bytes: ArrayBuffer | Uint8Array; filename: string }, folderId: string | null) => {
      const bytes = payload.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(payload.bytes);
      const buffer = Buffer.from(bytes);
      console.log('[import:buffer] called with', payload.filename, buffer.length, 'bytes');
      const result = await importFromBuffer(db, buffer, payload.filename, folderId);
      await enrichImportResults([result]);
      return result;
    },
  );

  // AI
  ipcMain.handle('ai:reanalyzeImages', async (_, imageIds: string[]) => {
    if (imageIds.length === 0) return { processed: 0, total: 0 };

    // Re-analysis shares the singleton queue; we capture our slice's "done" target so the
    // renderer can await fresh metadata before it refreshes the detail panel.
    const myTarget = aiCompleted + (aiQueue.length + imageIds.length);
    for (const id of imageIds) aiRefreshIds.add(id);
    aiQueue.push(...imageIds);
    aiTotal += imageIds.length;
    broadcastAutotag(`Re-analyzing image ${Math.min(aiCompleted + 1, aiTotal)} of ${aiTotal}...`);

    if (!aiDraining) {
      void drainAiQueue();
    }

    while (aiCompleted < myTarget) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      // aiCompleted resets to 0 when the queue fully drains. If our target was already passed
      // before the reset, the loop above already exited; if not, the reset means everything queued
      // up to and including our slice is done.
      if (!aiDraining && aiQueue.length === 0) break;
    }

    return { processed: imageIds.length, total: imageIds.length };
  });

  ipcMain.handle('ai:searchByText', async (_, query: string, limit?: number, opts?: unknown) => {
    const clamped = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.min(500, Math.floor(limit)))
      : undefined;
    const applySimilarityFloor = Boolean(
      opts && typeof opts === 'object' && (opts as { applySimilarityFloor?: unknown }).applySimilarityFloor,
    );
    return searchByText(db, query, clamped, { applySimilarityFloor });
  });

  ipcMain.handle('ai:searchForMoodboard', async (event, prompt: string, limit?: number, opts?: unknown) => {
    const clamped = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.min(500, Math.floor(limit)))
      : undefined;
    const visionRerank = Boolean(
      opts && typeof opts === 'object' && (opts as { visionRerank?: unknown }).visionRerank,
    );
    return searchForMoodboard(db, prompt, clamped, {
      visionRerank,
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) event.sender.send('moodboard:progress', p);
      },
    });
  });

  ipcMain.handle('ai:findSimilar', async (_, imageId: string, opts?: unknown) => {
    const refineModes = parseSimilarRefineModes(
      opts && typeof opts === 'object' && opts !== null && 'refineModes' in opts
        ? (opts as { refineModes?: unknown }).refineModes
        : [],
    );
    return findSimilarImagesWithPreviews(db, imageId, { refineModes });
  });

  ipcMain.handle('embeddings:hasForImage', (_, imageId: string) => {
    const row = db.prepare('SELECT 1 FROM image_embeddings WHERE image_id = ?').get(imageId);
    return Boolean(row);
  });

  ipcMain.handle('settings:getSimilarityPrefs', () => loadSimilarityPrefs(db));
  ipcMain.handle('settings:setSimilarityPrefs', (_, prefs: Partial<SimilarityPrefs>) => saveSimilarityPrefs(db, prefs));


  // Clipboard
  ipcMain.handle('clipboard:copyImage', async (_, filePath: string) => {
    // Try the native loader first (PNG/JPEG/GIF/BMP). It returns an empty image for formats
    // Electron doesn't decode (notably WebP), in which case fall back to sharp → PNG bytes.
    let img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) {
      try {
        const sharp = (await import('sharp')).default;
        const pngBuffer = await sharp(filePath).png().toBuffer();
        img = nativeImage.createFromBuffer(pngBuffer);
      } catch (err) {
        console.warn('[clipboard:copyImage] sharp fallback failed:', err);
        return false;
      }
    }
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
  });

  // Library export / import
  function broadcastLibraryProgress(channel: string, payload: unknown): void {
    const win = BrowserWindow.getAllWindows()[0];
    win?.webContents.send(channel, payload);
  }

  ipcMain.handle('library:export', async (_, destZipPath: string) => {
    return exportLibrary(db, destZipPath, (p) => {
      broadcastLibraryProgress('library:export:progress', p);
    });
  });

  ipcMain.handle('library:inspectImport', async (_, zipPath: string) => {
    return inspectImport(db, zipPath, (p) => {
      broadcastLibraryProgress('library:import:progress', p);
    });
  });

  ipcMain.handle(
    'library:applyImport',
    async (_, args: { sessionId: string; decisions: Record<string, 'replace' | 'keep'> }) => {
      return applyImport(db, args, (p) => {
        broadcastLibraryProgress('library:import:progress', p);
      });
    },
  );

  ipcMain.handle('library:cancelImport', (_, sessionId: string) => {
    cancelImport(sessionId);
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

  return {
    queueCaptionUpgradeIfNeeded(): number {
      const stale = db
        .prepare(
          'SELECT id FROM images WHERE is_trashed = 0 AND COALESCE(captions_version, 1) < ?',
        )
        .all(CAPTIONS_VERSION) as Array<{ id: string }>;
      if (stale.length === 0) return 0;

      for (const { id } of stale) aiRefreshIds.add(id);
      aiQueue.push(...stale.map((s) => s.id));
      aiTotal += stale.length;
      broadcastAutotag(`Upgrading captions ${Math.min(aiCompleted + 1, aiTotal)} of ${aiTotal}...`);
      if (!aiDraining) void drainAiQueue();
      return stale.length;
    },
  };
}
