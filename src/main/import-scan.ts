import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import extract from 'extract-zip';
import { isSupported } from './image-formats';

/** One importable image found under a dropped source. */
export interface ScannedImage {
  /** Absolute path to read — inside a temp dir when the image came out of a zip. */
  path: string;
  /** Folder names, outermost first, mirroring the source tree relative to the drop target.
      Empty for a loose file dropped on its own. */
  folderPath: string[];
}

export interface ScanResult {
  images: ScannedImage[];
  /** Dropped `.muse` bundles — these belong to the library-import flow, not the image importer. */
  bundles: string[];
  /** Sources that held nothing importable (empty folder, zip without images, odd file type). */
  emptySources: string[];
  /** Removes the temp dirs created for extracted zips. Call once every image has been read. */
  cleanup(): void;
}

/** Depth guard for pathological trees and nested-zip chains. Deeper levels are ignored. */
const MAX_DEPTH = 24;

const BUNDLE_EXT = '.muse';
const ZIP_EXT = '.zip';

/** Dotfiles (`.DS_Store`, AppleDouble `._foo.jpg`) and the `__MACOSX` sidecar zips carry. */
function isJunk(name: string): boolean {
  return name.startsWith('.') || name === '__MACOSX';
}

function stripExt(name: string): string {
  return path.basename(name, path.extname(name)) || name;
}

/**
 * Expands whatever was dropped — loose files, folders, zips — into a flat list of images, each
 * tagged with the folder path it should be mirrored into. Nested zips are extracted in place;
 * symlinks are skipped so a looped link can't turn the walk into an infinite descent.
 */
export async function scanDropSources(sourcePaths: string[]): Promise<ScanResult> {
  const images: ScannedImage[] = [];
  const bundles: string[] = [];
  const emptySources: string[] = [];
  const tempDirs: string[] = [];

  for (const source of sourcePaths) {
    const found = images.length;
    const name = path.basename(source);
    const ext = path.extname(source).toLowerCase();

    let stats: fs.Stats;
    try {
      stats = fs.statSync(source);
    } catch (err) {
      console.error('[import-scan] cannot stat', source, err);
      emptySources.push(source);
      continue;
    }

    if (ext === BUNDLE_EXT && stats.isFile()) {
      // A .muse export is a zip, but unpacking it here would strip the tags, folders, and
      // captions it carries. Hand it to the library-import flow instead.
      bundles.push(source);
      continue;
    }

    if (stats.isDirectory()) {
      await collectDirectory(source, [name], images, tempDirs, 0);
    } else if (ext === ZIP_EXT) {
      await collectZip(source, [stripExt(name)], images, tempDirs, 0);
    } else if (isSupported(source)) {
      images.push({ path: source, folderPath: [] });
    }

    if (images.length === found) emptySources.push(source);
  }

  return {
    images,
    bundles,
    emptySources,
    cleanup() {
      for (const dir of tempDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.error('[import-scan] temp cleanup failed', dir, err);
        }
      }
      tempDirs.length = 0;
    },
  };
}

async function collectDirectory(
  dir: string,
  folderPath: string[],
  images: ScannedImage[],
  tempDirs: string[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error('[import-scan] cannot read', dir, err);
    return;
  }

  for (const entry of entries) {
    if (isJunk(entry.name)) continue;
    const full = path.join(dir, entry.name);

    // isDirectory()/isFile() are both false for symlinks here, so links are skipped outright.
    if (entry.isDirectory()) {
      await collectDirectory(full, [...folderPath, entry.name], images, tempDirs, depth + 1);
    } else if (entry.isFile()) {
      if (path.extname(entry.name).toLowerCase() === ZIP_EXT) {
        await collectZip(full, [...folderPath, stripExt(entry.name)], images, tempDirs, depth + 1);
      } else if (isSupported(full)) {
        images.push({ path: full, folderPath });
      }
    }
  }
}

async function collectZip(
  zipPath: string,
  folderPath: string[],
  images: ScannedImage[],
  tempDirs: string[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let tempDir: string;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-drop-'));
  } catch (err) {
    console.error('[import-scan] cannot create temp dir for', zipPath, err);
    return;
  }
  tempDirs.push(tempDir);

  try {
    // extract-zip refuses entries that resolve outside `dir`, so a zip-slip archive can't
    // scatter files across the disk.
    await extract(zipPath, { dir: tempDir });
  } catch (err) {
    console.error('[import-scan] cannot extract', zipPath, err);
    return;
  }

  await collectDirectory(unwrapSingleDirectory(tempDir), folderPath, images, tempDirs, depth + 1);
}

/**
 * Most archives wrap their contents in one top-level directory. Descending through it keeps the
 * mirrored tree from gaining a redundant "Refs ▸ Refs" level — the archive's own name is the one
 * the user recognizes, so that's the name the folder keeps.
 */
function unwrapSingleDirectory(dir: string): string {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !isJunk(e.name));
    if (entries.length === 1 && entries[0].isDirectory()) return path.join(dir, entries[0].name);
  } catch {
    // Fall through and scan the directory as given.
  }
  return dir;
}
