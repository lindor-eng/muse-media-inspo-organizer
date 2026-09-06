import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import type Database from 'better-sqlite3';
import { createImageRepo } from './database/repositories/images';
import { createFolderRepo } from './database/repositories/folders';
import { getLibraryPath } from './database/connection';
import { MIME_TO_EXT, SUPPORTED_EXTENSIONS, VIDEO_EXTENSIONS, isSupported } from './image-formats';
import { scanDropSources } from './import-scan';
import { extractPoster, isVideoDecoderAvailable, probeDurationMs } from './video';

export interface ImportResult {
  id: string;
  filename: string;
  thumbnail_path: string;
  success: boolean;
  error?: string;
  duplicate?: boolean;
  /** Set when a re-imported file matched a row that was in the Trash and got restored. */
  restored?: boolean;
}

/** Outcome of one `importFiles` run — drives the progress banner and the library-import handoff. */
export interface ImportSummary {
  results: ImportResult[];
  /** Images newly stored (or restored from Trash). */
  imported: number;
  /** Images already in the library, skipped by hash. */
  duplicates: number;
  failed: number;
  /** Muse folders created to mirror dropped directory/zip structure. */
  foldersCreated: number;
  /** Dropped `.muse` bundles, handed back for the library-import flow. */
  bundles: string[];
  /** Dropped sources that held nothing importable. */
  emptySources: string[];
}

export type ImportProgressFn = (p: { phase: 'scan' | 'import'; current: number; total: number }) => void;

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Streaming hash, so importing a file never depends on holding it in memory. Videos are the
 * reason: a screen recording can be hundreds of megabytes, where reading the whole thing just
 * to digest it would spike the main process for no benefit.
 */
async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function getImageDimensions(filePath: string): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await sharp(filePath).metadata();
    if (metadata.width && metadata.height) {
      return { width: metadata.width, height: metadata.height };
    }
  } catch {
    // SVG or unsupported format
  }
  return null;
}

const THUMB_SIZE = 400;

async function generateThumbnail(sourcePath: string, destPath: string): Promise<void> {
  await sharp(sourcePath)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(destPath);
}

interface MediaMetadata {
  width: number | null;
  height: number | null;
  /** Videos only. */
  durationMs: number | null;
  /** Whether a thumbnail was actually written to the path handed in. */
  hasThumbnail: boolean;
}

/**
 * A video's thumbnail is a poster frame pulled from the middle of the clip, and its stored
 * dimensions are that frame's — the video's real display size, after ffmpeg has applied any
 * rotation the container declares. Doing both from one decoded frame keeps import to a single
 * ffmpeg pass plus the duration probe.
 *
 * Throws when the clip can't be decoded at all: unlike a still, a video with no poster has
 * nothing to render in the grid, so it's better surfaced as a failed import than stored as an
 * invisible row.
 */
async function describeVideo(sourcePath: string, thumbPath: string): Promise<MediaMetadata> {
  if (!isVideoDecoderAvailable()) {
    throw new Error('video decoder unavailable — run `npm run fetch:ffmpeg`');
  }

  const durationMs = await probeDurationMs(sourcePath);
  const poster = await extractPoster(sourcePath, durationMs);

  await sharp(poster.png)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(thumbPath);

  return {
    width: poster.width || null,
    height: poster.height || null,
    durationMs,
    hasThumbnail: true,
  };
}

/** Thumbnail + dimensions for a still. Both are best-effort: SVGs and exotic formats fall
    back to rendering the original directly. */
async function describeImage(sourcePath: string, thumbPath: string): Promise<MediaMetadata> {
  let hasThumbnail = false;
  try {
    await generateThumbnail(sourcePath, thumbPath);
    hasThumbnail = true;
  } catch {
    // SVGs and exotic formats just use the original.
  }

  const dimensions = await getImageDimensions(sourcePath);
  return {
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    durationMs: null,
    hasThumbnail,
  };
}

/**
 * Where the bytes for an import come from. Path sources stream — hashed and copied without
 * ever being held whole — while buffer sources (URL fetches, clipboard, data: URLs) already
 * have the bytes in hand.
 */
type PersistSource =
  | { kind: 'buffer'; buffer: Buffer }
  | { kind: 'file'; path: string; size: number };

/**
 * Shared write path for every import: dedups by content hash, copies the bytes into the
 * library, derives a thumbnail (a poster frame for videos, a resize for stills), and inserts
 * the row.
 */
async function persistImage(
  db: Database.Database,
  args: {
    source: PersistSource;
    /** Source-derived filename for display; not used for storage. */
    displayFilename: string;
    /** File extension (lower-case, with dot) used for the storage filename. */
    ext: string;
    folderId: string | null;
    /** When importing from a real file, preserve original timestamps. */
    fileCreatedAt?: string | null;
    fileModifiedAt?: string | null;
  }
): Promise<ImportResult> {
  const { source, displayFilename, ext, folderId, fileCreatedAt, fileModifiedAt } = args;

  const hash = source.kind === 'buffer' ? hashBuffer(source.buffer) : await hashFile(source.path);
  const fileSize = source.kind === 'buffer' ? source.buffer.length : source.size;
  const imageRepo = createImageRepo(db);
  const existing = imageRepo.getByHash(hash);

  if (existing) {
    // A live duplicate is a genuine no-op. But if the match is sitting in the Trash,
    // re-importing the same file is the user's clear intent to bring it back — restore it
    // (and re-home it to the drop target if one was given) so it reappears in "All" instead
    // of staying invisibly trashed. Without this, a trashed image can never be re-added.
    if (existing.is_trashed) {
      imageRepo.restore(existing.id);
      if (folderId) imageRepo.update(existing.id, { folder_id: folderId });
      return {
        id: existing.id,
        filename: displayFilename,
        thumbnail_path: existing.thumbnail_path ?? '',
        success: true,
        restored: true,
      };
    }
    return { id: existing.id, filename: displayFilename, thumbnail_path: '', success: false, duplicate: true };
  }

  const libraryPath = getLibraryPath();
  const destFilename = `${hash}${ext}`;
  const destPath = path.join(libraryPath, 'originals', destFilename);

  if (!fs.existsSync(destPath)) {
    if (source.kind === 'buffer') {
      fs.writeFileSync(destPath, source.buffer);
    } else {
      fs.copyFileSync(source.path, destPath);
    }
  }

  const thumbFilename = `${hash}.webp`;
  const thumbPath = path.join(libraryPath, 'thumbnails', thumbFilename);
  const isVideo = VIDEO_EXTENSIONS.has(ext);

  let metadata: MediaMetadata;
  try {
    metadata = isVideo
      ? await describeVideo(destPath, thumbPath)
      : await describeImage(destPath, thumbPath);
  } catch (err) {
    // Only videos reach here — describeImage swallows its own failures. Don't leave the
    // original behind: with no poster there'd be nothing to show for it, and keeping the
    // bytes would make a retry look like a duplicate and skip itself. The thumbnail goes too,
    // in case the failure landed after a partial write.
    fs.rmSync(destPath, { force: true });
    fs.rmSync(thumbPath, { force: true });
    console.error('[importer] video import failed for', displayFilename, err);
    return {
      id: '',
      filename: displayFilename,
      thumbnail_path: '',
      success: false,
      error: `Could not read video: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const fileType = ext.replace('.', '').toLowerCase();
  const titleBase = path.basename(displayFilename, path.extname(displayFilename)) || displayFilename;

  const image = imageRepo.create({
    filename: displayFilename,
    original_path: destPath,
    thumbnail_path: metadata.hasThumbnail && fs.existsSync(thumbPath) ? thumbPath : null,
    title: titleBase,
    width: metadata.width,
    height: metadata.height,
    file_size: fileSize,
    file_type: fileType,
    hash,
    folder_id: folderId,
    file_created_at: fileCreatedAt ?? null,
    file_modified_at: fileModifiedAt ?? null,
    duration_ms: metadata.durationMs,
  });

  return { id: image.id, filename: displayFilename, thumbnail_path: thumbPath, success: true };
}

export async function importFile(
  db: Database.Database,
  filePath: string,
  folderId: string | null = null
): Promise<ImportResult> {
  const filename = path.basename(filePath);

  if (!isSupported(filePath)) {
    return { id: '', filename, thumbnail_path: '', success: false, error: 'Unsupported file type' };
  }

  try {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return await persistImage(db, {
      source: { kind: 'file', path: filePath, size: stats.size },
      displayFilename: filename,
      ext,
      folderId,
      fileCreatedAt: stats.birthtime.toISOString(),
      fileModifiedAt: stats.mtime.toISOString(),
    });
  } catch (err) {
    return { id: '', filename, thumbnail_path: '', success: false, error: String(err) };
  }
}

function folderKey(parentId: string | null, name: string): string {
  return `${parentId ?? 'root'}::${name.trim().toLowerCase()}`;
}

/**
 * Mirrors a scanned source tree into Muse folders: each level is created on demand under the
 * drop target, reusing a folder that already exists with that name and parent (matched
 * case-insensitively, like the filesystem the paths came from). Folders that end up empty —
 * every image under them turned out to be a duplicate, say — are pruned by `discardEmpty`.
 */
function createFolderMirror(db: Database.Database, rootFolderId: string | null) {
  const folderRepo = createFolderRepo(db);
  const idByKey = new Map<string, string>();
  for (const folder of folderRepo.getAll()) {
    idByKey.set(folderKey(folder.parent_id, folder.name), folder.id);
  }

  /** Created this run, parents before children — so reverse order prunes leaves first. */
  const created: string[] = [];
  const countImages = db.prepare('SELECT COUNT(*) AS n FROM images WHERE folder_id = ?');
  const countChildren = db.prepare('SELECT COUNT(*) AS n FROM folders WHERE parent_id = ?');

  return {
    resolve(folderPath: string[]): string | null {
      let parentId = rootFolderId;
      for (const rawName of folderPath) {
        const name = rawName.trim() || 'Untitled';
        const key = folderKey(parentId, name);
        let id = idByKey.get(key);
        if (!id) {
          id = folderRepo.create(name, parentId).id;
          idByKey.set(key, id);
          created.push(id);
        }
        parentId = id;
      }
      return parentId;
    },

    discardEmpty(): void {
      for (const id of [...created].reverse()) {
        const images = (countImages.get(id) as { n: number }).n;
        const children = (countChildren.get(id) as { n: number }).n;
        if (images === 0 && children === 0) {
          folderRepo.delete(id);
          created.splice(created.indexOf(id), 1);
        }
      }
    },

    get createdCount(): number {
      return created.length;
    },
  };
}

/**
 * The one entry point for path-based imports (drops and the file picker alike). Accepts loose
 * files, folders, and zips; folders and zips are walked recursively and their structure is
 * mirrored into Muse folders under `folderId`.
 */
export async function importFiles(
  db: Database.Database,
  sourcePaths: string[],
  folderId: string | null = null,
  onProgress?: ImportProgressFn,
): Promise<ImportSummary> {
  onProgress?.({ phase: 'scan', current: 0, total: 0 });
  const scan = await scanDropSources(sourcePaths);
  const mirror = createFolderMirror(db, folderId);
  const results: ImportResult[] = [];

  try {
    const total = scan.images.length;
    onProgress?.({ phase: 'import', current: 0, total });

    for (const image of scan.images) {
      const target = image.folderPath.length > 0 ? mirror.resolve(image.folderPath) : folderId;
      results.push(await importFile(db, image.path, target));
      onProgress?.({ phase: 'import', current: results.length, total });
    }
  } finally {
    // Zip temp dirs are only needed until the bytes are copied into the library.
    scan.cleanup();
    mirror.discardEmpty();
  }

  return {
    results,
    imported: results.filter((r) => r.success).length,
    duplicates: results.filter((r) => r.duplicate).length,
    failed: results.filter((r) => !r.success && !r.duplicate).length,
    foldersCreated: mirror.createdCount,
    bundles: scan.bundles,
    emptySources: scan.emptySources,
  };
}

/** Best-effort filename inference from a URL — falls back to "image" if the path has none. */
function deriveFilenameFromUrl(url: string, ext: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(path.basename(u.pathname));
    if (last && /\.[a-z0-9]+$/i.test(last)) return last;
    if (last) return `${last}${ext}`;
    return `image${ext}`;
  } catch {
    return `image${ext}`;
  }
}

function extFromContentType(ct: string | null | undefined): string | null {
  if (!ct) return null;
  const base = ct.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? null;
}

export async function importFromUrl(
  db: Database.Database,
  url: string,
  folderId: string | null = null
): Promise<ImportResult> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('data:')) {
    return { id: '', filename: trimmed, thumbnail_path: '', success: false, error: 'Unsupported URL scheme' };
  }

  try {
    if (trimmed.startsWith('data:')) {
      const match = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(trimmed);
      if (!match) return { id: '', filename: 'image', thumbnail_path: '', success: false, error: 'Invalid data URL' };
      const mime = match[1];
      const isBase64 = Boolean(match[2]);
      const payload = match[3];
      const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf-8');
      const ext = MIME_TO_EXT[mime.toLowerCase()] ?? '.png';
      return await persistImage(db, {
        source: { kind: 'buffer', buffer },
        displayFilename: `clipboard${ext}`,
        ext,
        folderId,
      });
    }

    const res = await fetch(trimmed);
    if (!res.ok) {
      return { id: '', filename: trimmed, thumbnail_path: '', success: false, error: `Fetch failed: ${res.status}` };
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const ctExt = extFromContentType(res.headers.get('content-type'));
    const urlExt = path.extname(new URL(trimmed).pathname).toLowerCase();
    const ext = (urlExt && SUPPORTED_EXTENSIONS.has(urlExt) ? urlExt : null) ?? ctExt ?? null;

    if (!ext) {
      return { id: '', filename: trimmed, thumbnail_path: '', success: false, error: 'Unrecognized image type' };
    }

    const filename = deriveFilenameFromUrl(trimmed, ext);
    return await persistImage(db, {
      source: { kind: 'buffer', buffer },
      displayFilename: filename,
      ext,
      folderId,
    });
  } catch (err) {
    return { id: '', filename: trimmed, thumbnail_path: '', success: false, error: String(err) };
  }
}

export async function importFromBuffer(
  db: Database.Database,
  buffer: Buffer,
  filename: string,
  folderId: string | null = null,
): Promise<ImportResult> {
  const extFromName = path.extname(filename).toLowerCase();
  const ext = SUPPORTED_EXTENSIONS.has(extFromName) ? extFromName : '.png';
  const safeName = extFromName ? filename : `${filename}${ext}`;
  return persistImage(db, {
    source: { kind: 'buffer', buffer },
    displayFilename: safeName,
    ext,
    folderId,
  });
}
