import type Database from 'better-sqlite3';
import { BrowserWindow } from 'electron';
import { createImageRepo } from './database/repositories/images';
import { getPreferences } from './preferences';

const EVERY_MS = 6 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Settings › Library › Empty the Trash automatically: deletes for good anything that has been in
 * the Trash longer than the chosen number of days. Deleting is the same as emptying the Trash by
 * hand, so with sync on the other Macs delete them too.
 */
export function sweepTrash(db: Database.Database): number {
  const days = getPreferences().emptyTrashAfterDays;
  if (!days) return 0;
  const old = db
    .prepare(`SELECT id FROM images WHERE is_trashed = 1 AND trashed_at IS NOT NULL AND trashed_at < datetime('now', ?)`)
    .all(`-${days} days`) as { id: string }[];
  if (!old.length) return 0;
  const repo = createImageRepo(db);
  db.transaction(() => {
    for (const { id } of old) repo.deletePermanently(id);
  })();
  console.log(`[trash] emptied ${old.length} item${old.length === 1 ? '' : 's'} older than ${days} days`);
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('files-imported');
  return old.length;
}

/** Sweeps shortly after launch, then every six hours. */
export function startTrashSweeper(db: Database.Database): void {
  if (timer) return;
  setTimeout(() => sweepTrash(db), 15_000);
  timer = setInterval(() => sweepTrash(db), EVERY_MS);
}
