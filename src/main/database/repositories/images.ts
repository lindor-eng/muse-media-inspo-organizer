import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export interface ImageRecord {
  id: string;
  filename: string;
  original_path: string;
  thumbnail_path: string | null;
  title: string;
  notes: string;
  source_url: string;
  rating: number;
  width: number | null;
  height: number | null;
  file_size: number | null;
  file_type: string | null;
  hash: string | null;
  is_trashed: number;
  trashed_at: string | null;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
  imported_at: string;
  file_created_at: string | null;
  file_modified_at: string | null;
  /** 0 grayscale-dominant, 1 visibly chromatic, null not classified (legacy / failed decode). */
  indexed_chromatic: number | null;
  /** Dominant 30° hue bin 0–11 when color is concentrated (e.g. mostly blue). */
  indexed_hue_bucket: number | null;
  /** Share of lit thumb pixels in the dominant bin — “how much of the image is this hue”. */
  indexed_hue_strength: number | null;
  /** Mean hue (°) within dominant bin; ties to `indexed_hue_bucket`. */
  indexed_hue_degrees: number | null;
  /** Second dominant hue bin (orange next to cobalt, etc.). */
  indexed_hue_bucket_2: number | null;
  indexed_hue_strength_2: number | null;
}

export interface ImageFilter {
  folder_id?: string | null;
  is_trashed?: boolean;
  rating_min?: number;
  file_type?: string;
  search?: string;
  tag_ids?: string[];
}

export function createImageRepo(db: Database.Database) {
  const getByIdStmt = db.prepare('SELECT * FROM images WHERE id = ?');
  const getByHashStmt = db.prepare('SELECT * FROM images WHERE hash = ?');

  const insertStmt = db.prepare(`
    INSERT INTO images (id, filename, original_path, thumbnail_path, title, width, height, file_size, file_type, hash, folder_id, file_created_at, file_modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateStmt = db.prepare(`
    UPDATE images SET title = ?, notes = ?, source_url = ?, rating = ?, folder_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const trashStmt = db.prepare(`
    UPDATE images SET is_trashed = 1, trashed_at = datetime('now') WHERE id = ?
  `);

  const restoreStmt = db.prepare(`
    UPDATE images SET is_trashed = 0, trashed_at = NULL WHERE id = ?
  `);

  const deleteStmt = db.prepare('DELETE FROM images WHERE id = ?');

  return {
    getById(id: string): ImageRecord | undefined {
      return getByIdStmt.get(id) as ImageRecord | undefined;
    },

    getByHash(hash: string): ImageRecord | undefined {
      return getByHashStmt.get(hash) as ImageRecord | undefined;
    },

    query(filter: ImageFilter, limit = 100, offset = 0): { images: ImageRecord[]; total: number } {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filter.is_trashed !== undefined) {
        conditions.push('i.is_trashed = ?');
        params.push(filter.is_trashed ? 1 : 0);
      } else {
        conditions.push('i.is_trashed = 0');
      }

      if (filter.folder_id !== undefined) {
        if (filter.folder_id === null) {
          conditions.push('i.folder_id IS NULL');
        } else {
          conditions.push('i.folder_id = ?');
          params.push(filter.folder_id);
        }
      }

      if (filter.rating_min !== undefined) {
        conditions.push('i.rating >= ?');
        params.push(filter.rating_min);
      }

      if (filter.file_type) {
        conditions.push('i.file_type = ?');
        params.push(filter.file_type);
      }

      if (filter.tag_ids && filter.tag_ids.length > 0) {
        const placeholders = filter.tag_ids.map(() => '?').join(',');
        conditions.push(`i.id IN (SELECT image_id FROM image_tags WHERE tag_id IN (${placeholders}))`);
        params.push(...filter.tag_ids);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = db.prepare(`SELECT COUNT(*) as total FROM images i ${where}`).get(...params) as { total: number };

      const images = db.prepare(
        `SELECT i.* FROM images i ${where} ORDER BY i.imported_at DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset) as ImageRecord[];

      return { images, total: countResult.total };
    },

    create(data: {
      filename: string;
      original_path: string;
      thumbnail_path: string | null;
      title: string;
      width: number | null;
      height: number | null;
      file_size: number | null;
      file_type: string | null;
      hash: string | null;
      folder_id: string | null;
      file_created_at: string | null;
      file_modified_at: string | null;
    }): ImageRecord {
      const id = uuid();
      insertStmt.run(
        id, data.filename, data.original_path, data.thumbnail_path,
        data.title, data.width, data.height, data.file_size, data.file_type,
        data.hash, data.folder_id, data.file_created_at, data.file_modified_at
      );
      return getByIdStmt.get(id) as ImageRecord;
    },

    update(id: string, data: Partial<Pick<ImageRecord, 'title' | 'notes' | 'source_url' | 'rating' | 'folder_id'>>): ImageRecord {
      const existing = getByIdStmt.get(id) as ImageRecord;
      updateStmt.run(
        data.title ?? existing.title,
        data.notes ?? existing.notes,
        data.source_url ?? existing.source_url,
        data.rating ?? existing.rating,
        data.folder_id !== undefined ? data.folder_id : existing.folder_id,
        id
      );
      return getByIdStmt.get(id) as ImageRecord;
    },

    trash(id: string): void {
      trashStmt.run(id);
    },

    restore(id: string): void {
      restoreStmt.run(id);
    },

    deletePermanently(id: string): void {
      deleteStmt.run(id);
    },

    getTotalCount(): number {
      const result = db.prepare('SELECT COUNT(*) as total FROM images WHERE is_trashed = 0').get() as { total: number };
      return result.total;
    },

    getUncategorizedCount(): number {
      const result = db.prepare('SELECT COUNT(*) as total FROM images WHERE is_trashed = 0 AND folder_id IS NULL').get() as { total: number };
      return result.total;
    },

    getUntaggedCount(): number {
      const result = db.prepare(`
        SELECT COUNT(*) as total FROM images i
        WHERE i.is_trashed = 0 AND i.id NOT IN (SELECT image_id FROM image_tags)
      `).get() as { total: number };
      return result.total;
    },

    getTrashedCount(): number {
      const result = db.prepare('SELECT COUNT(*) as total FROM images WHERE is_trashed = 1').get() as { total: number };
      return result.total;
    },
  };
}
