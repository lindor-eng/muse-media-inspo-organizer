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
import type { ImportStatus } from '../shared/import-status';
import { isVideoFileType } from '../shared/media-type';
import {
  loadSimilarityPrefs,
  saveSimilarityPrefs,
  type SimilarityPrefs,
} from './database/similarity-prefs';
import {
  isModelAvailable,
  pullModel,
  isOllamaServerRunning,
  ensureOllamaServer,
} from './ai/ollama-server';
import { exportLibrary } from './library-export';
import { inspectImport, applyImport, cancelImport } from './library-import';

export interface IpcHooks {
  /** Queue a caption refresh (re-analyze + re-embed) for images captioned by an older
      model/prompt generation. Call after the Ollama server is confirmed up. */
  queueCaptionUpgradeIfNeeded: () => number;
}

/** Non-trashed image count — used to size the "Update AI Model" re-analyze prompt. */
function countAnalyzableImages(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM images WHERE is_trashed = 0').get() as { n: number };
  return row.n;
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
  // Singleton AI pipeline so concurrent imports never run vision jobs in parallel.
  // New images enqueued mid-run extend the in-flight totals instead of starting a second drainer.
  //
  // Two lanes, one drainer. The `user` lane is work someone asked for — an import, a
  // re-analyze — and it is the only work the progress toast counts. The `background` lane is
  // work the app decided to do on its own: the launch-time caption upgrade, which re-queues
  // any row still below CAPTIONS_VERSION on every launch until it succeeds. Mixing the two
  // into one total made the toast lie about imports — drop two clips while two stale ones are
  // still pending and it read "4 items remaining" for a 2-file import. Video made this
  // visible: a clip takes ~20-25s to caption against ~7s for a still, so the lanes now
  // routinely overlap where they used to pass each other unnoticed.
  type Lane = 'user' | 'background';

  const queues: Record<Lane, string[]> = { user: [], background: [] };
  /** Counted per lane, so background work can never inflate the number an import reports. */
  const lanes: Record<Lane, { total: number; completed: number }> = {
    user: { total: 0, completed: 0 },
    background: { total: 0, completed: 0 },
  };
  /** Ids queued for a caption *refresh* (model/prompt upgrade or explicit re-analyze):
      stale auto-tags and the model-written description get replaced, not accumulated. */
  const aiRefreshIds = new Set<string>();
  /** The job the drainer is on right now. Pending-only dedupe would miss it. */
  let aiInFlight: { id: string; lane: Lane } | null = null;
  let aiDraining = false;

  /**
   * Which lane the toast speaks for. User work owns the readout for as long as any exists —
   * including after it finishes, so the run can announce its own completion and dismiss
   * itself rather than handing the toast straight to the background sweep. Counters reset
   * together once the whole pipeline drains, so a later background-only sweep still shows.
   */
  function reportingLane(): Lane {
    return lanes.user.total > 0 ? 'user' : 'background';
  }

  /** "Analyzing item 3 of 7..." for whichever lane currently owns the readout. */
  function progressStatus(kind: 'autotag' | 'embedding'): string {
    const lane = reportingLane();
    const { completed, total } = lanes[lane];
    const n = Math.min(completed + 1, total);
    if (lane === 'background') return `Upgrading captions ${n} of ${total}...`;
    return kind === 'autotag' ? `Analyzing item ${n} of ${total}...` : `Indexing item ${n} of ${total}...`;
  }

  function completionStatus(kind: 'autotag' | 'embedding'): string {
    const { completed, total } = lanes[reportingLane()];
    if (completed >= total) return kind === 'autotag' ? 'Auto-tagging complete' : 'Indexing complete';
    return kind === 'autotag' ? `Analyzed ${completed} of ${total}` : `Indexed ${completed} of ${total}`;
  }

  function broadcastAutotag(status: string): void {
    const win = BrowserWindow.getAllWindows()[0];
    const { completed, total } = lanes[reportingLane()];
    win?.webContents.send('autotag:progress', { current: completed, total, status });
  }

  function broadcastEmbedding(status: string): void {
    const win = BrowserWindow.getAllWindows()[0];
    const { completed, total } = lanes[reportingLane()];
    win?.webContents.send('embedding:progress', { current: completed, total, status });
  }

  /**
   * Adds ids to a lane, skipping anything already pending so one image can't cost two vision
   * passes. An id waiting in the background lane is *promoted* rather than duplicated: the
   * user asking for it outranks the sweep that was going to get to it eventually.
   *
   * Returns how many were actually queued.
   */
  function enqueueAi(ids: string[], lane: Lane, options?: { refresh?: boolean }): number {
    const added: string[] = [];

    for (const id of ids) {
      if (queues[lane].includes(id)) continue;

      if (lane === 'user') {
        const pending = queues.background.indexOf(id);
        if (pending !== -1) {
          queues.background.splice(pending, 1);
          lanes.background.total -= 1;
        }
      } else if (queues.user.includes(id) || aiInFlight?.id === id) {
        // Background work never duplicates something already queued or already running. The
        // user lane deliberately doesn't take this branch: asking to re-analyze an image
        // that happens to be mid-pass means you want a fresh one afterwards.
        continue;
      }

      if (options?.refresh) aiRefreshIds.add(id);
      added.push(id);
    }

    if (added.length === 0) return 0;

    queues[lane].push(...added);
    lanes[lane].total += added.length;
    return added.length;
  }

  /** User work first, always — the counter the toast is showing has to keep moving. */
  function nextJob(): { id: string; lane: Lane } | null {
    const userId = queues.user.shift();
    if (userId !== undefined) return { id: userId, lane: 'user' };
    const backgroundId = queues.background.shift();
    if (backgroundId !== undefined) return { id: backgroundId, lane: 'background' };
    return null;
  }

  async function drainAiQueue(): Promise<void> {
    if (aiDraining) return;
    aiDraining = true;
    try {
      for (let job = nextJob(); job !== null; job = nextJob()) {
        const { id, lane } = job;
        aiInFlight = job;
        // A job only narrates while its own lane owns the readout. Without this, a background
        // job picked up after an import finished would overwrite "Auto-tagging complete" with
        // a stale count and keep re-arming the toast's dismiss timer for the rest of the sweep.
        if (lane === reportingLane()) broadcastAutotag(progressStatus('autotag'));
        try {
          await autoTagImage(db, id, { refresh: aiRefreshIds.has(id) });
        } catch (err) {
          console.error('[ai-queue] auto-tag error:', err);
        } finally {
          aiRefreshIds.delete(id);
        }

        if (lane === reportingLane()) broadcastEmbedding(progressStatus('embedding'));
        const img = imageRepo.getById(id);
        if (img) {
          // The perceptual hash inside this call goes through sharp, which can't open a video
          // container — a video is hashed from its poster frame instead, which is the same
          // pixels the grid and the similarity strip compare against anyway.
          const hashSource = isVideoFileType(img.file_type)
            ? img.thumbnail_path ?? img.original_path
            : img.original_path;
          await generateAndStoreEmbedding(db, id, hashSource).catch((err) =>
            console.warn('[ai-queue] embed failed:', err),
          );
          if (img.thumbnail_path) {
            await extractAndStoreColors(db, id, img.thumbnail_path).catch((err) =>
              console.warn('[ai-queue] color extract failed:', err),
            );
          }
        }

        lanes[lane].completed += 1;

        if (lane === reportingLane()) {
          broadcastAutotag(completionStatus('autotag'));
          broadcastEmbedding(completionStatus('embedding'));
        }
      }
    } finally {
      aiInFlight = null;
      aiDraining = false;
      // Reset once the whole pipeline drains so the next batch starts fresh at 0/N — and so a
      // background-only sweep can take the readout back.
      if (queues.user.length === 0 && queues.background.length === 0) {
        lanes.user = { total: 0, completed: 0 };
        lanes.background = { total: 0, completed: 0 };
      }
    }
  }

  async function enrichImportResults(results: ImportResult[]): Promise<void> {
    // Restored trash rows already have colors/captions/embeddings from their first import —
    // re-enriching them just burns a vision pass, so treat only genuinely-new images as fresh.
    const fresh = results.filter((r) => r.success && !r.restored);

    for (const result of fresh) {
      if (result.thumbnail_path) {
        try {
          await extractAndStoreColors(db, result.id, result.thumbnail_path);
        } catch {
          // Non-critical
        }
      }
    }

    const successfulIds = fresh.map((r) => r.id);
    if (successfulIds.length === 0) return;

    if (enqueueAi(successfulIds, 'user') === 0) return;
    // Surface the new total immediately so the toast ticks up before the worker reaches the new item.
    broadcastAutotag(progressStatus('autotag'));

    if (!aiDraining) {
      setTimeout(() => {
        void drainAiQueue();
      }, 100);
    }
  }

  function broadcastImport(status: ImportStatus): void {
    const win = BrowserWindow.getAllWindows()[0];
    win?.webContents.send('import:progress', status);
  }

  ipcMain.handle('import:files', async (_, filePaths: string[], folderId: string | null) => {
    console.log('[import:files] called with paths:', filePaths);
    const summary = await importFiles(db, filePaths, folderId, broadcastImport);

    // A drop that was nothing but .muse bundles has its own dialog to speak for it — a
    // "nothing to import" banner alongside it would just be noise.
    const bundlesOnly =
      summary.bundles.length > 0 && summary.results.length === 0 && summary.emptySources.length === 0;
    if (!bundlesOnly) {
      broadcastImport({
        phase: 'done',
        imported: summary.imported,
        duplicates: summary.duplicates,
        failed: summary.failed,
        foldersCreated: summary.foldersCreated,
        emptySources: summary.emptySources.length,
      });
    }

    // A dropped .muse bundle isn't a pile of loose images — send it to the library-import
    // dialog so its folders, tags, and captions survive the trip.
    if (summary.bundles.length > 0) {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.send('library:import:dropped', summary.bundles[0]);
    }

    await enrichImportResults(summary.results);
    return summary;
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
    const queued = enqueueAi(imageIds, 'user', { refresh: true });
    const myTarget = lanes.user.completed + queues.user.length;
    if (queued > 0) broadcastAutotag(progressStatus('autotag'));

    if (!aiDraining) {
      void drainAiQueue();
    }

    while (lanes.user.completed < myTarget) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      // The user lane's counters reset to 0 when the whole pipeline drains. If our target was
      // already passed before the reset, the loop above already exited; if not, the reset means
      // everything queued up to and including our slice is done.
      if (!aiDraining && queues.user.length === 0) break;
    }

    return { processed: imageIds.length, total: imageIds.length };
  });

  // Count of images a full re-analysis would touch — the "Update AI Model" dialog shows
  // this before the user confirms the (potentially long) run.
  ipcMain.handle('ai:analyzableCount', () => countAnalyzableImages(db));

  // Re-analyze the ENTIRE non-trashed library with the current vision model/prompt.
  // Fire-and-forget: pushes every image into the shared AI queue as a refresh (stale
  // auto-tags + model-written captions replaced) and returns the queued count immediately
  // so the dialog can close and hand off to the standard progress toast.
  ipcMain.handle('ai:reanalyzeAll', () => {
    const rows = db
      .prepare('SELECT id FROM images WHERE is_trashed = 0')
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return { queued: 0 };

    const queued = enqueueAi(rows.map((r) => r.id), 'user', { refresh: true });
    if (queued > 0) broadcastAutotag(progressStatus('autotag'));
    if (!aiDraining) void drainAiQueue();
    return { queued: rows.length };
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
  // Unlike the probe above, this actually (re)starts the server. The launch-time start is a
  // single attempt, so without this a failure there stranded the user until they relaunched.
  ipcMain.handle('ollama:ensureServer', () => ensureOllamaServer());
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

      // Background lane: this runs because the app decided to, not because anyone asked, so it
      // stays out of the count an import reports. It still shows its own progress when nothing
      // else is competing for the toast.
      const queued = enqueueAi(stale.map((s) => s.id), 'background', { refresh: true });
      if (queued === 0) return 0;
      broadcastAutotag(progressStatus('autotag'));
      if (!aiDraining) void drainAiQueue();
      return queued;
    },
  };
}
