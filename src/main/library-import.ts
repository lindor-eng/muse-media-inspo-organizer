import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import extract from 'extract-zip';
import { getLibraryPath } from './database/connection';

export interface DuplicateInfo {
  hash: string;
  filename: string;
  incomingTitle: string;
  incomingFolderName: string | null;
  incomingTagNames: string[];
  incomingIsTrashed: boolean;
  localId: string;
  localTitle: string;
  localFolderName: string | null;
  localTagNames: string[];
  localIsTrashed: boolean;
  /** Both thumbs as data URLs so the dialog can render them without local-file:// path concerns. */
  localThumbDataUrl: string | null;
  incomingThumbDataUrl: string | null;
}

export interface InspectResult {
  sessionId: string;
  totalIncoming: number;
  newCount: number;
  duplicateCount: number;
  duplicates: DuplicateInfo[];
}

export interface ImportProgress {
  phase: 'extract' | 'inspect' | 'apply' | 'finalize';
  current: number;
  total: number;
}

export interface ApplyResult {
  added: number;
  replaced: number;
  kept: number;
}

interface IncomingImage {
  id: string;
  filename: string;
  original_path: string;
  thumbnail_path: string | null;
  title: string;
  notes: string;
  alt_text: string;
  source_url: string;
  width: number | null;
  height: number | null;
  file_size: number | null;
  file_type: string | null;
  hash: string;
  is_trashed: number;
  trashed_at: string | null;
  folder_id: string | null;
  imported_at: string;
  file_created_at: string | null;
  file_modified_at: string | null;
  /** Clip length for video rows; null for stills. Older bundles predate the column. */
  duration_ms: number | null;
  indexed_chromatic: number | null;
  indexed_hue_bucket: number | null;
  indexed_hue_strength: number | null;
  indexed_hue_degrees: number | null;
  indexed_hue_bucket_2: number | null;
  indexed_hue_strength_2: number | null;
  phash: Buffer | null;
}

const sessions = new Map<string, { tempDir: string; createdAt: number }>();

export async function inspectImport(
  liveDb: Database.Database,
  zipPath: string,
  onProgress: (p: ImportProgress) => void,
): Promise<InspectResult> {
  onProgress({ phase: 'extract', current: 0, total: 1 });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-import-'));
  await extract(zipPath, { dir: tempDir });
  onProgress({ phase: 'extract', current: 1, total: 1 });

  const incomingDbPath = path.join(tempDir, 'library.db');
  if (!fs.existsSync(incomingDbPath)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error('Bundle is missing library.db — file may be corrupt or not a Muse export.');
  }

  const incomingDb = new Database(incomingDbPath, { readonly: true });
  sqliteVec.load(incomingDb);

  try {
    const incomingImages = incomingDb.prepare('SELECT * FROM images').all() as IncomingImage[];
    onProgress({ phase: 'inspect', current: 0, total: incomingImages.length });

    const duplicates: DuplicateInfo[] = [];
    let newCount = 0;
    const folderNameById = new Map<string, string>();
    for (const row of incomingDb.prepare('SELECT id, name FROM folders').all() as { id: string; name: string }[]) {
      folderNameById.set(row.id, row.name);
    }
    const localFolderNameById = new Map<string, string>();
    for (const row of liveDb.prepare('SELECT id, name FROM folders').all() as { id: string; name: string }[]) {
      localFolderNameById.set(row.id, row.name);
    }

    const incomingTagsForImage = incomingDb.prepare(`
      SELECT t.name FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id = ? ORDER BY t.name
    `);
    const localTagsForImage = liveDb.prepare(`
      SELECT t.name FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id = ? ORDER BY t.name
    `);

    const localByHash = liveDb.prepare('SELECT * FROM images WHERE hash = ?');

    let scanned = 0;
    for (const incoming of incomingImages) {
      scanned += 1;
      if (scanned % 25 === 0) {
        onProgress({ phase: 'inspect', current: scanned, total: incomingImages.length });
      }
      const local = incoming.hash ? (localByHash.get(incoming.hash) as IncomingImage | undefined) : undefined;
      if (!local) {
        newCount += 1;
        continue;
      }
      const incomingTags = (incomingTagsForImage.all(incoming.id) as { name: string }[]).map((r) => r.name);
      const localTags = (localTagsForImage.all(local.id) as { name: string }[]).map((r) => r.name);

      const incomingThumbName = incoming.thumbnail_path ? path.basename(incoming.thumbnail_path) : null;
      const incomingThumbPath = incomingThumbName ? path.join(tempDir, 'thumbnails', incomingThumbName) : null;

      duplicates.push({
        hash: incoming.hash,
        filename: incoming.filename,
        incomingTitle: incoming.title,
        incomingFolderName: incoming.folder_id ? folderNameById.get(incoming.folder_id) ?? null : null,
        incomingTagNames: incomingTags,
        incomingIsTrashed: incoming.is_trashed === 1,
        localId: local.id,
        localTitle: local.title,
        localFolderName: local.folder_id ? localFolderNameById.get(local.folder_id) ?? null : null,
        localTagNames: localTags,
        localIsTrashed: local.is_trashed === 1,
        localThumbDataUrl: thumbToDataUrl(local.thumbnail_path),
        incomingThumbDataUrl:
          incomingThumbPath && fs.existsSync(incomingThumbPath) ? thumbToDataUrl(incomingThumbPath) : null,
      });
    }

    onProgress({ phase: 'inspect', current: incomingImages.length, total: incomingImages.length });

    const sessionId = path.basename(tempDir);
    sessions.set(sessionId, { tempDir, createdAt: Date.now() });

    return {
      sessionId,
      totalIncoming: incomingImages.length,
      newCount,
      duplicateCount: duplicates.length,
      duplicates,
    };
  } finally {
    incomingDb.close();
  }
}

export async function applyImport(
  liveDb: Database.Database,
  args: { sessionId: string; decisions: Record<string, 'replace' | 'keep'> },
  onProgress: (p: ImportProgress) => void,
): Promise<ApplyResult> {
  const session = sessions.get(args.sessionId);
  if (!session) throw new Error('Import session expired or already applied. Re-open the bundle.');

  const tempDir = session.tempDir;
  const incomingDbPath = path.join(tempDir, 'library.db');
  const incomingDb = new Database(incomingDbPath, { readonly: true });
  sqliteVec.load(incomingDb);

  const libraryPath = getLibraryPath();

  try {
    const incomingImages = incomingDb.prepare('SELECT * FROM images').all() as IncomingImage[];
    const incomingFolders = incomingDb
      .prepare('SELECT id, name, parent_id, sort_order, color FROM folders')
      .all() as { id: string; name: string; parent_id: string | null; sort_order: number; color: string | null }[];
    const incomingTags = incomingDb.prepare('SELECT id, name, color FROM tags').all() as {
      id: string;
      name: string;
      color: string | null;
    }[];

    const total = incomingImages.length;
    onProgress({ phase: 'apply', current: 0, total });

    let added = 0;
    let replaced = 0;
    let kept = 0;

    // Stage all file copies into <libraryPath>/originals|thumbnails as a separate step before the
    // DB transaction. If a copy fails, abort before any rows change. Replacements use a temp name
    // and are renamed after the transaction commits to keep the swap atomic-ish.
    const fileOps: Array<{ from: string; to: string; rename?: string }> = [];

    const localByHash = liveDb.prepare('SELECT * FROM images WHERE hash = ?');
    const localFolderById = liveDb.prepare('SELECT id FROM folders WHERE id = ?');
    const localTagByName = liveDb.prepare('SELECT id FROM tags WHERE name = ?');

    // Pre-compute work plan per incoming image.
    interface Plan {
      action: 'add' | 'replace' | 'keep';
      incoming: IncomingImage;
      localId: string | null;
      newOriginalPath: string;
      newThumbPath: string | null;
    }
    const plans: Plan[] = [];

    for (const incoming of incomingImages) {
      const local = incoming.hash ? (localByHash.get(incoming.hash) as { id: string } | undefined) : undefined;

      const originalBase = path.basename(incoming.original_path);
      const thumbBase = incoming.thumbnail_path ? path.basename(incoming.thumbnail_path) : null;

      const newOriginalPath = path.join(libraryPath, 'originals', originalBase);
      const newThumbPath = thumbBase ? path.join(libraryPath, 'thumbnails', thumbBase) : null;

      if (local) {
        const decision = args.decisions[incoming.hash] ?? 'keep';
        if (decision === 'keep') {
          plans.push({ action: 'keep', incoming, localId: local.id, newOriginalPath, newThumbPath });
          continue;
        }
        plans.push({ action: 'replace', incoming, localId: local.id, newOriginalPath, newThumbPath });
      } else {
        plans.push({ action: 'add', incoming, localId: null, newOriginalPath, newThumbPath });
      }

      const fromOriginal = path.join(tempDir, 'originals', originalBase);
      if (!fs.existsSync(fromOriginal)) {
        throw new Error(`Bundle is missing original file ${originalBase}`);
      }
      // For replacements we stage copies under .new and rename them after the transaction commits.
      const stagedOriginal = local ? `${newOriginalPath}.new` : newOriginalPath;
      fileOps.push({ from: fromOriginal, to: stagedOriginal, rename: local ? newOriginalPath : undefined });

      if (thumbBase && newThumbPath) {
        const fromThumb = path.join(tempDir, 'thumbnails', thumbBase);
        if (fs.existsSync(fromThumb)) {
          const stagedThumb = local ? `${newThumbPath}.new` : newThumbPath;
          fileOps.push({ from: fromThumb, to: stagedThumb, rename: local ? newThumbPath : undefined });
        }
      }
    }

    // Stage 1: copy files into staging locations.
    for (const op of fileOps) {
      // For "add" action where the file is the same hash and we already have it, copyFile is fine —
      // it just overwrites the existing file with an identical-by-hash copy. Cheap.
      fs.copyFileSync(op.from, op.to);
    }

    // Stage 2: DB transaction.
    const apply = liveDb.transaction(() => {
      // Folders: insert any whose id isn't present locally. Disable FK so we can insert
      // children before parents in the row order; FK is restored at the end of the txn.
      liveDb.pragma('foreign_keys = OFF');
      const insertFolder = liveDb.prepare(
        'INSERT OR IGNORE INTO folders (id, name, parent_id, sort_order, color) VALUES (?, ?, ?, ?, ?)',
      );
      for (const f of incomingFolders) {
        const exists = localFolderById.get(f.id) as { id: string } | undefined;
        if (!exists) insertFolder.run(f.id, f.name, f.parent_id, f.sort_order, f.color);
      }
      liveDb.pragma('foreign_keys = ON');

      // Tags: name is UNIQUE. Build incoming-id → local-id remap by name.
      const tagIdRemap = new Map<string, string>();
      const insertTag = liveDb.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)');
      for (const t of incomingTags) {
        const local = localTagByName.get(t.name) as { id: string } | undefined;
        if (local) {
          tagIdRemap.set(t.id, local.id);
        } else {
          insertTag.run(t.id, t.name, t.color);
          tagIdRemap.set(t.id, t.id);
        }
      }

      const insertImage = liveDb.prepare(`
        INSERT INTO images (
          id, filename, original_path, thumbnail_path, title, notes, alt_text, source_url,
          width, height, file_size, file_type, hash,
          is_trashed, trashed_at, folder_id,
          imported_at, file_created_at, file_modified_at, duration_ms,
          indexed_chromatic, indexed_hue_bucket, indexed_hue_strength, indexed_hue_degrees,
          indexed_hue_bucket_2, indexed_hue_strength_2, phash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateImage = liveDb.prepare(`
        UPDATE images SET
          filename = ?, original_path = ?, thumbnail_path = ?, title = ?, notes = ?,
          alt_text = ?, source_url = ?, width = ?, height = ?, file_size = ?, file_type = ?,
          is_trashed = ?, trashed_at = ?, folder_id = ?, file_created_at = ?, file_modified_at = ?,
          duration_ms = ?, indexed_chromatic = ?, indexed_hue_bucket = ?, indexed_hue_strength = ?, indexed_hue_degrees = ?,
          indexed_hue_bucket_2 = ?, indexed_hue_strength_2 = ?, phash = ?, updated_at = datetime('now')
        WHERE id = ?
      `);

      const insertColor = liveDb.prepare(
        'INSERT INTO image_colors (id, image_id, hex_color, percentage, sort_order) VALUES (?, ?, ?, ?, ?)',
      );
      const deleteColors = liveDb.prepare('DELETE FROM image_colors WHERE image_id = ?');
      const insertImageTag = liveDb.prepare(
        'INSERT OR IGNORE INTO image_tags (image_id, tag_id, is_auto, confidence) VALUES (?, ?, ?, ?)',
      );
      const deleteImageTags = liveDb.prepare('DELETE FROM image_tags WHERE image_id = ?');
      const deleteEmbedding = liveDb.prepare('DELETE FROM image_embeddings WHERE image_id = ?');
      const insertEmbedding = liveDb.prepare(
        'INSERT INTO image_embeddings (image_id, embedding) VALUES (?, ?)',
      );

      const incomingColorsForImage = incomingDb.prepare(
        'SELECT id, hex_color, percentage, sort_order FROM image_colors WHERE image_id = ? ORDER BY sort_order',
      );
      const incomingTagsForImage = incomingDb.prepare(
        'SELECT tag_id, is_auto, confidence FROM image_tags WHERE image_id = ?',
      );
      const incomingEmbeddingForImage = incomingDb.prepare(
        'SELECT embedding FROM image_embeddings WHERE image_id = ?',
      );

      let processed = 0;
      for (const plan of plans) {
        processed += 1;
        if (processed % 10 === 0) {
          onProgress({ phase: 'apply', current: processed, total });
        }
        if (plan.action === 'keep') {
          kept += 1;
          continue;
        }

        const incoming = plan.incoming;
        const targetId = plan.action === 'replace' ? plan.localId! : incoming.id;

        if (plan.action === 'add') {
          insertImage.run(
            targetId,
            incoming.filename,
            plan.newOriginalPath,
            plan.newThumbPath,
            incoming.title,
            incoming.notes,
            incoming.alt_text ?? '',
            incoming.source_url,
            incoming.width,
            incoming.height,
            incoming.file_size,
            incoming.file_type,
            incoming.hash,
            incoming.is_trashed,
            incoming.trashed_at,
            incoming.folder_id,
            incoming.imported_at,
            incoming.file_created_at,
            incoming.file_modified_at,
            // Bundles written before video support carry no such column; SELECT * yields
            // undefined, which better-sqlite3 refuses to bind.
            incoming.duration_ms ?? null,
            incoming.indexed_chromatic,
            incoming.indexed_hue_bucket,
            incoming.indexed_hue_strength,
            incoming.indexed_hue_degrees,
            incoming.indexed_hue_bucket_2,
            incoming.indexed_hue_strength_2,
            incoming.phash,
          );
          added += 1;
        } else {
          updateImage.run(
            incoming.filename,
            plan.newOriginalPath,
            plan.newThumbPath,
            incoming.title,
            incoming.notes,
            incoming.alt_text ?? '',
            incoming.source_url,
            incoming.width,
            incoming.height,
            incoming.file_size,
            incoming.file_type,
            incoming.is_trashed,
            incoming.trashed_at,
            incoming.folder_id,
            incoming.file_created_at,
            incoming.file_modified_at,
            incoming.duration_ms ?? null,
            incoming.indexed_chromatic,
            incoming.indexed_hue_bucket,
            incoming.indexed_hue_strength,
            incoming.indexed_hue_degrees,
            incoming.indexed_hue_bucket_2,
            incoming.indexed_hue_strength_2,
            incoming.phash,
            targetId,
          );
          deleteColors.run(targetId);
          deleteImageTags.run(targetId);
          deleteEmbedding.run(targetId);
          replaced += 1;
        }

        // Re-insert child rows (colors, tags, embedding) in both add and replace cases.
        const colors = incomingColorsForImage.all(incoming.id) as {
          id: string;
          hex_color: string;
          percentage: number | null;
          sort_order: number;
        }[];
        for (const c of colors) {
          insertColor.run(c.id, targetId, c.hex_color, c.percentage, c.sort_order);
        }

        const tagLinks = incomingTagsForImage.all(incoming.id) as {
          tag_id: string;
          is_auto: number;
          confidence: number | null;
        }[];
        for (const link of tagLinks) {
          const remappedTagId = tagIdRemap.get(link.tag_id) ?? link.tag_id;
          insertImageTag.run(targetId, remappedTagId, link.is_auto, link.confidence);
        }

        const emb = incomingEmbeddingForImage.get(incoming.id) as { embedding: Buffer } | undefined;
        if (emb) insertEmbedding.run(targetId, emb.embedding);
      }
    });

    apply();

    // Stage 3: rename .new files into place after the txn committed successfully.
    onProgress({ phase: 'finalize', current: 0, total: 1 });
    for (const op of fileOps) {
      if (op.rename) {
        try {
          fs.renameSync(op.to, op.rename);
        } catch (err) {
          console.warn('[library-import] rename failed', op.to, '→', op.rename, err);
        }
      }
    }
    onProgress({ phase: 'finalize', current: 1, total: 1 });

    return { added, replaced, kept };
  } finally {
    incomingDb.close();
    cancelImport(args.sessionId);
  }
}

export function cancelImport(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  try {
    fs.rmSync(session.tempDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[library-import] failed to clean session', sessionId, err);
  }
}

/** Stale temp-dir reaper, called on app start so cancelled or crashed sessions don't leak. */
export function reapStaleSessions(): void {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > ONE_HOUR) {
      cancelImport(id);
    }
  }
}

function thumbToDataUrl(thumbPath: string | null): string | null {
  if (!thumbPath) return null;
  if (!fs.existsSync(thumbPath)) return null;
  try {
    const buf = fs.readFileSync(thumbPath);
    const ext = path.extname(thumbPath).toLowerCase();
    const mime = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}
