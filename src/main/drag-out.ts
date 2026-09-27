import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, nativeImage, type NativeImage, type WebContents } from 'electron';
import sharp from 'sharp';
import type { ImageRecord } from './database/repositories/images';
import { isVideoFileType } from '../shared/media-type';

/**
 * Dragging media out of Muse into Finder (or any app that accepts file drops).
 *
 * Originals are stored as `<hash>.<ext>`, so dragging them directly would hand Finder a file
 * named after its SHA-256. There's a worse problem too: a Finder drop on the same volume moves
 * the file by default, which would pull the original out of the library.
 *
 * So each drag stages copies under the temp directory, named after the item's display
 * filename, and drags those. The copies are APFS clones (`COPYFILE_FICLONE`), which makes them
 * instant and free of extra disk space even for long videos. Unlike a hard link, a clone is
 * copy-on-write, so an app that edits the dropped file in place can't change the library.
 */

function stagingRoot(): string {
  return path.join(app.getPath('temp'), 'Muse Drag');
}

/** Staged drags older than this are pruned when the next one starts. A Finder copy of a
    large file can outlast the drag gesture, so a drag's files aren't removed right away. */
const STAGING_TTL_MS = 60 * 60 * 1000;

/** Drag image size in points (rendered at 2x for Retina). */
const ICON_POINTS = 128;

/** Remove every staged drag. Called at launch, when nothing can still be reading them. */
export function clearDragStaging(): void {
  fs.rmSync(stagingRoot(), { recursive: true, force: true });
}

/** True for a file that came from a Muse drag, so dropping it back into Muse isn't an import. */
export function isStagedDragPath(filePath: string): boolean {
  const rel = path.relative(stagingRoot(), path.resolve(filePath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function pruneOldDrags(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(stagingRoot());
  } catch {
    return;
  }
  const cutoff = Date.now() - STAGING_TTL_MS;
  for (const entry of entries) {
    const dir = path.join(stagingRoot(), entry);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Already gone, or still being read; the next launch clears it.
    }
  }
}

/**
 * The name Finder will show: the display filename, made safe for a path, with the extension
 * the stored bytes actually have. Display names can disagree with storage (a URL import
 * called "image", a capture renamed from .avif to .png), and Finder picks the opening app by
 * extension.
 */
function exportName(image: ImageRecord): string {
  const storedExt = path.extname(image.original_path).toLowerCase();
  // `:` shows as `/` in Finder; control characters and leading dots make hidden or broken names.
  // eslint-disable-next-line no-control-regex
  let base = path.basename(image.filename || 'Muse').replace(/[/\\:\x00-\x1f]+/g, '_').replace(/^\.+/, '');
  const nameExt = path.extname(base);
  if (nameExt.toLowerCase() !== storedExt) {
    // "photo.avif" becomes "photo.png"; "image" becomes "image.webp".
    base = /^\.[a-z0-9]{2,5}$/i.test(nameExt) ? base.slice(0, -nameExt.length) : base;
    base = `${base}${storedExt}`;
  }
  const stem = base.slice(0, base.length - storedExt.length).slice(0, 200) || 'Muse';
  return `${stem}${storedExt}`;
}

/** "photo.jpg", "photo 2.jpg", … — Finder's own convention for a clash within one drop. */
function uniqueName(name: string, taken: Set<string>): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} ${n}${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

function stageFiles(images: ImageRecord[]): string[] {
  pruneOldDrags();
  const dir = path.join(stagingRoot(), crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });

  const taken = new Set<string>();
  const staged: string[] = [];
  for (const image of images) {
    const dest = path.join(dir, uniqueName(exportName(image), taken));
    try {
      // Falls back to a byte copy on volumes without clone support.
      fs.copyFileSync(image.original_path, dest, fs.constants.COPYFILE_FICLONE);
    } catch (err) {
      console.warn('[drag-out] could not stage', image.original_path, err);
      continue;
    }
    // A clone gets a fresh modification date; give the copy the one the original file had.
    const modified = image.file_modified_at ? new Date(image.file_modified_at) : null;
    if (modified && !Number.isNaN(modified.getTime())) {
      try {
        fs.utimesSync(dest, modified, modified);
      } catch {
        // Cosmetic only.
      }
    }
    staged.push(dest);
  }
  return staged;
}

function iconFromPng(png: Buffer): NativeImage {
  return nativeImage.createFromBuffer(png, { scaleFactor: 2 });
}

/**
 * The first item's thumbnail (a poster frame for video). macOS refuses a drag with no image.
 * Everything goes through sharp: thumbnails are WebP, which nativeImage can't decode.
 * (`app.getFileIcon` would be the obvious fallback, but it crashed Electron 41's main process in testing.)
 */
async function dragIcon(image: ImageRecord): Promise<NativeImage> {
  const sources = [image.thumbnail_path, isVideoFileType(image.file_type) ? null : image.original_path];
  for (const source of sources) {
    if (!source) continue;
    try {
      const png = await sharp(source, { animated: false })
        .resize(ICON_POINTS * 2, ICON_POINTS * 2, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      const icon = iconFromPng(png);
      if (!icon.isEmpty()) return icon;
    } catch (err) {
      console.warn('[drag-out] could not render drag image from', source, err);
    }
  }
  const tile = await sharp({
    create: { width: ICON_POINTS, height: ICON_POINTS, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 0.6 } },
  })
    .png()
    .toBuffer();
  return iconFromPng(tile);
}

/**
 * Starts a native file drag of the given library items from `sender`. Must be called while the
 * mouse button that began the drag is still down.
 *
 * On macOS `startDrag` runs the drag in a nested loop and returns only once it has ended, so
 * the promise this returns settles when the user lets go.
 */
export async function startDragOut(sender: WebContents, images: ImageRecord[]): Promise<void> {
  const live = images.filter((image) => fs.existsSync(image.original_path));
  if (live.length === 0) return;
  const files = stageFiles(live);
  if (files.length === 0) return;
  const icon = await dragIcon(live[0]);
  sender.startDrag({ file: files[0], files, icon });
}
