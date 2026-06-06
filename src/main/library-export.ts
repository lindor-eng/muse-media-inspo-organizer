import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import archiver from 'archiver';
import type Database from 'better-sqlite3';
import { getLibraryPath } from './database/connection';

export interface ExportProgress {
  phase: 'snapshot' | 'archive' | 'finalize';
  current: number;
  total: number;
}

export interface ExportResult {
  originalsCount: number;
  thumbnailsCount: number;
  bytes: number;
}

interface Manifest {
  version: 1;
  exportedAt: string;
  museVersion: string;
  originalsCount: number;
  thumbnailsCount: number;
  imageCount: number;
}

export async function exportLibrary(
  db: Database.Database,
  destZipPath: string,
  onProgress: (p: ExportProgress) => void,
): Promise<ExportResult> {
  const libraryPath = getLibraryPath();
  const originalsDir = path.join(libraryPath, 'originals');
  const thumbsDir = path.join(libraryPath, 'thumbnails');

  // Snapshot DB to a tempfile we can stream into the zip without locking the live DB.
  // VACUUM INTO yields a consistent point-in-time copy that includes virtual-table data
  // (FTS, vec0).
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-export-'));
  const dbSnapshotPath = path.join(tempDir, 'library.db');

  try {
    onProgress({ phase: 'snapshot', current: 0, total: 1 });
    db.exec(`VACUUM INTO '${dbSnapshotPath.replace(/'/g, "''")}'`);
    onProgress({ phase: 'snapshot', current: 1, total: 1 });

    const originalEntries = listFilesSafe(originalsDir);
    const thumbEntries = listFilesSafe(thumbsDir);
    const totalFiles = 1 /* db */ + originalEntries.length + thumbEntries.length + 1 /* manifest */;

    const imageCount = (db.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number }).c;

    const manifest: Manifest = {
      version: 1,
      exportedAt: new Date().toISOString(),
      museVersion: app.getVersion(),
      originalsCount: originalEntries.length,
      thumbnailsCount: thumbEntries.length,
      imageCount,
    };

    const archive = archiver('zip', { zlib: { level: 1 } });
    const output = fs.createWriteStream(destZipPath);

    let written = 0;
    archive.on('entry', () => {
      written += 1;
      onProgress({ phase: 'archive', current: Math.min(written, totalFiles), total: totalFiles });
    });

    const finished = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      output.on('error', reject);
      archive.on('error', reject);
      archive.on('warning', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          console.warn('[library-export] archive warning:', err);
        } else {
          reject(err);
        }
      });
    });

    archive.pipe(output);

    archive.file(dbSnapshotPath, { name: 'library.db' });
    for (const entry of originalEntries) {
      archive.file(entry.fullPath, { name: `originals/${entry.relName}` });
    }
    for (const entry of thumbEntries) {
      archive.file(entry.fullPath, { name: `thumbnails/${entry.relName}` });
    }
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    onProgress({ phase: 'finalize', current: 0, total: 1 });
    await archive.finalize();
    await finished;
    onProgress({ phase: 'finalize', current: 1, total: 1 });

    const stats = fs.statSync(destZipPath);
    return {
      originalsCount: originalEntries.length,
      thumbnailsCount: thumbEntries.length,
      bytes: stats.size,
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      console.warn('[library-export] failed to clean temp dir', tempDir, err);
    }
  }
}

interface FileEntry {
  fullPath: string;
  relName: string;
}

function listFilesSafe(dir: string): FileEntry[] {
  if (!fs.existsSync(dir)) return [];
  const out: FileEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) out.push({ fullPath: full, relName: name });
    } catch (err) {
      console.warn('[library-export] skip unreadable entry', full, err);
    }
  }
  return out;
}
