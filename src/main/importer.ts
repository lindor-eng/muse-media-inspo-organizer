import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import type Database from 'better-sqlite3';
import { createImageRepo } from './database/repositories/images';
import { getLibraryPath } from './database/connection';

export interface ImportResult {
  id: string;
  filename: string;
  thumbnail_path: string;
  success: boolean;
  error?: string;
  duplicate?: boolean;
}

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.tiff', '.tif', '.bmp',
]);

/** MIME → extension fallback for buffer/URL imports where the source path is unreliable. */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'image/bmp': '.bmp',
};

export function isSupported(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function computeHash(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return hashBuffer(buffer);
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

async function generateThumbnail(sourcePath: string, destPath: string): Promise<void> {
  await sharp(sourcePath)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(destPath);
}

/** Shared write path: persists buffer-on-disk, generates thumb, dedups, inserts row. */
async function persistImage(
  db: Database.Database,
  args: {
    buffer: Buffer;
    /** Source-derived filename for display; not used for storage. */
    displayFilename: string;
    /** File extension (lower-case, with dot) used for the storage filename. */
    ext: string;
    folderId: string | null;
    sourceUrl?: string;
    /** When importing from a real file, preserve original timestamps. */
    fileCreatedAt?: string | null;
    fileModifiedAt?: string | null;
  }
): Promise<ImportResult> {
  const { buffer, displayFilename, ext, folderId, sourceUrl, fileCreatedAt, fileModifiedAt } = args;

  const hash = hashBuffer(buffer);
  const imageRepo = createImageRepo(db);
  const existing = imageRepo.getByHash(hash);

  if (existing) {
    return { id: existing.id, filename: displayFilename, thumbnail_path: '', success: false, duplicate: true };
  }

  const libraryPath = getLibraryPath();
  const destFilename = `${hash}${ext}`;
  const destPath = path.join(libraryPath, 'originals', destFilename);

  if (!fs.existsSync(destPath)) {
    fs.writeFileSync(destPath, buffer);
  }

  const thumbFilename = `${hash}.webp`;
  const thumbPath = path.join(libraryPath, 'thumbnails', thumbFilename);

  try {
    await generateThumbnail(destPath, thumbPath);
  } catch {
    // SVGs and exotic formats just use the original.
  }

  const dimensions = await getImageDimensions(destPath);
  const fileType = ext.replace('.', '').toLowerCase();
  const titleBase = path.basename(displayFilename, path.extname(displayFilename)) || displayFilename;

  const image = imageRepo.create({
    filename: displayFilename,
    original_path: destPath,
    thumbnail_path: fs.existsSync(thumbPath) ? thumbPath : null,
    title: titleBase,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    file_size: buffer.length,
    file_type: fileType,
    hash,
    folder_id: folderId,
    file_created_at: fileCreatedAt ?? null,
    file_modified_at: fileModifiedAt ?? null,
  });

  if (sourceUrl) {
    imageRepo.update(image.id, { source_url: sourceUrl });
  }

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
    const buffer = fs.readFileSync(filePath);
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return await persistImage(db, {
      buffer,
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

export async function importFiles(
  db: Database.Database,
  filePaths: string[],
  folderId: string | null = null
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  for (const filePath of filePaths) {
    const result = await importFile(db, filePath, folderId);
    results.push(result);
  }
  return results;
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
        buffer,
        displayFilename: `clipboard${ext}`,
        ext,
        folderId,
        sourceUrl: '',
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
      buffer,
      displayFilename: filename,
      ext,
      folderId,
      sourceUrl: trimmed,
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
  sourceUrl?: string
): Promise<ImportResult> {
  const extFromName = path.extname(filename).toLowerCase();
  const ext = SUPPORTED_EXTENSIONS.has(extFromName) ? extFromName : '.png';
  const safeName = extFromName ? filename : `${filename}${ext}`;
  return persistImage(db, {
    buffer,
    displayFilename: safeName,
    ext,
    folderId,
    sourceUrl,
  });
}
