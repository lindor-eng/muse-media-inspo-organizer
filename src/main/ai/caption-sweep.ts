import type Database from 'better-sqlite3';

/**
 * Images the launch-time caption upgrade should re-describe: captioned by an older model or
 * prompt (or never), and not received from another Mac by library sync. The Mac that imported
 * an image describes it and sync brings the result; describing it here as well would double
 * the work on every Mac.
 */
export function imagesNeedingCaptionUpgrade(db: Database.Database, captionsVersion: number): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM images WHERE is_trashed = 0 AND COALESCE(captions_version, 1) < ?
         AND id NOT IN (SELECT image_id FROM sync_received)`,
    )
    .all(captionsVersion) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
