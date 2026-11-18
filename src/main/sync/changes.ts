import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { IMAGE_COLUMNS, logEpoch } from './schema';
import type {
  ChangeRow,
  ChangesPage,
  ColorData,
  FolderData,
  ImageData,
  LinkData,
  RowRef,
  SyncTable,
} from './protocol';

interface LogEntry {
  tbl: SyncTable;
  row_key: string;
  version: number;
  origin: string;
  seq: number;
  deleted: number;
}

// MARK: - Reading

/** The rows this library has changed since `since`, each as it is now. */
export function readChanges(db: Database.Database, since: number, limit: number): ChangesPage {
  const entries = db
    .prepare('SELECT * FROM sync_rows WHERE seq > ? ORDER BY seq LIMIT ?')
    .all(since, limit + 1) as LogEntry[];
  const more = entries.length > limit;
  const page = more ? entries.slice(0, limit) : entries;
  const latest = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM sync_rows').get() as { s: number }).s;
  return {
    epoch: logEpoch(db),
    rows: page.map((e) => serialize(db, e)),
    next: page.length ? page[page.length - 1].seq : since,
    latest,
    more,
  };
}

/**
 * The original files behind every image changed since `since`, for the countdown: the puller
 * counts the ones it doesn't have yet, which is how many files it's about to receive.
 */
export function pendingFiles(db: Database.Database, since: number): string[] {
  const rows = db
    .prepare(`SELECT i.original_path AS p FROM sync_rows s JOIN images i ON i.id = s.row_key
              WHERE s.tbl = 'images' AND s.deleted = 0 AND s.seq > ?`)
    .all(since) as Array<{ p: string }>;
  return [...new Set(rows.map((r) => path.basename(r.p)))];
}

/** Specific rows as they are now, for a peer that's missing something a change refers to. */
export function readRows(db: Database.Database, refs: RowRef[]): ChangeRow[] {
  const get = db.prepare('SELECT * FROM sync_rows WHERE tbl = ? AND row_key = ?');
  const rows: ChangeRow[] = [];
  for (const ref of refs) {
    const entry = get.get(ref.tbl, ref.key) as LogEntry | undefined;
    if (entry) rows.push(serialize(db, entry));
  }
  return rows;
}

function serialize(db: Database.Database, e: LogEntry): ChangeRow {
  const base = { tbl: e.tbl, key: e.row_key, version: e.version, origin: e.origin };
  if (e.deleted) return { ...base, deleted: true };
  const data = readData(db, e.tbl, e.row_key);
  // Gone without a tombstone of its own: a cascade from applying a peer's delete, which that
  // peer logged itself. Pass it on as deleted.
  return data ? { ...base, deleted: false, data } : { ...base, deleted: true };
}

function readData(db: Database.Database, tbl: SyncTable, key: string): ChangeRow['data'] | null {
  if (tbl === 'folders') {
    return (db.prepare('SELECT id, name, parent_id, sort_order, color, created_at, updated_at FROM folders WHERE id = ?').get(key) as FolderData | undefined) ?? null;
  }
  if (tbl === 'images') {
    const row = db.prepare('SELECT * FROM images WHERE id = ?').get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    const colors = db
      .prepare('SELECT hex_color, percentage, sort_order FROM image_colors WHERE image_id = ? ORDER BY sort_order')
      .all(key) as ColorData[];
    const embedding = db.prepare('SELECT embedding FROM image_embeddings WHERE image_id = ?').get(key) as { embedding: Buffer } | undefined;
    const data: Record<string, unknown> = { id: row.id, updated_at: row.updated_at };
    for (const c of IMAGE_COLUMNS) data[c] = row[c] ?? null;
    data.phash = row.phash ? (row.phash as Buffer).toString('base64') : null;
    data.rating = (row.rating as number | null) ?? 0;
    data.original = path.basename(String(row.original_path));
    data.thumbnail = row.thumbnail_path ? path.basename(String(row.thumbnail_path)) : null;
    data.colors = colors;
    data.embedding = embedding ? Buffer.from(embedding.embedding).toString('base64') : null;
    return data as unknown as ImageData;
  }
  const { imageId, tag } = splitLinkKey(key);
  const link = db
    .prepare(`SELECT it.is_auto, it.confidence, t.color FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ? AND t.name = ?`)
    .get(imageId, tag) as { is_auto: number; confidence: number | null; color: string | null } | undefined;
  if (!link) return null;
  return { image_id: imageId, tag, tag_color: link.color, is_auto: link.is_auto, confidence: link.confidence } satisfies LinkData;
}

export function splitLinkKey(key: string): { imageId: string; tag: string } {
  const bar = key.indexOf('|');
  return { imageId: key.slice(0, bar), tag: key.slice(bar + 1) };
}

// MARK: - Deciding

/** Newer version wins; on a tie, the larger device id. */
export function isNewer(incoming: { version: number; origin: string }, local: { version: number; origin: string } | undefined): boolean {
  if (!local) return true;
  if (incoming.version !== local.version) return incoming.version > local.version;
  return incoming.origin > local.origin;
}

/** The rows of a page this library would take: newer than what it has. */
export function wanted(db: Database.Database, rows: ChangeRow[]): ChangeRow[] {
  const get = db.prepare('SELECT version, origin FROM sync_rows WHERE tbl = ? AND row_key = ?');
  return rows.filter((r) => isNewer(r, get.get(r.tbl, r.key) as LogEntry | undefined));
}

/**
 * Rows the page refers to that this library has never had and the page doesn't bring: a folder's
 * parent, an image's folder, a tag's image. Ordering by seq doesn't guarantee they come first
 * (renaming a folder after filling it gives it a later seq than its images), so the puller asks
 * for them by key before applying.
 */
export function missingReferences(db: Database.Database, rows: ChangeRow[]): RowRef[] {
  const known = db.prepare('SELECT deleted FROM sync_rows WHERE tbl = ? AND row_key = ?');
  const inPage = new Set(rows.filter((r) => !r.deleted).map((r) => `${r.tbl}:${r.key}`));
  const out = new Map<string, RowRef>();
  const need = (tbl: SyncTable, key: string | null | undefined) => {
    if (!key || inPage.has(`${tbl}:${key}`)) return;
    if (known.get(tbl, key)) return; // here, or deleted here: either way, nothing to fetch
    out.set(`${tbl}:${key}`, { tbl, key });
  };
  for (const r of rows) {
    if (r.deleted || !r.data) continue;
    if (r.tbl === 'folders') need('folders', (r.data as FolderData).parent_id);
    if (r.tbl === 'images') need('folders', (r.data as ImageData).folder_id);
    if (r.tbl === 'image_tags') need('images', (r.data as LinkData).image_id);
  }
  return [...out.values()];
}

/** Files an image row needs that aren't in this library yet. */
export function missingFiles(libraryPath: string, rows: ChangeRow[]): Array<{ kind: 'originals' | 'thumbnails'; name: string; hash: string | null }> {
  const out = new Map<string, { kind: 'originals' | 'thumbnails'; name: string; hash: string | null }>();
  for (const r of rows) {
    if (r.tbl !== 'images' || r.deleted || !r.data) continue;
    const d = r.data as ImageData;
    if (!fs.existsSync(path.join(libraryPath, 'originals', d.original))) {
      out.set(`o:${d.original}`, { kind: 'originals', name: d.original, hash: d.hash });
    }
    if (d.thumbnail && !fs.existsSync(path.join(libraryPath, 'thumbnails', d.thumbnail))) {
      out.set(`t:${d.thumbnail}`, { kind: 'thumbnails', name: d.thumbnail, hash: null });
    }
  }
  return [...out.values()];
}

// MARK: - Applying

export interface ApplyResult {
  applied: number;
  skipped: number;
  /** For the toast: images and videos that weren't here before, */
  added: number;
  /** ones moved to the Trash or deleted, */
  removed: number;
  /** and images, videos and boards someone edited: titles, notes, sources, ratings, boards,
      restoring from the Trash, tags added by hand. What Muse works out for itself (palettes,
      AI descriptions and tags, search data) isn't counted: it isn't news. */
  changed: number;
}

const TABLE_ORDER: Record<SyncTable, number> = { folders: 0, images: 1, image_tags: 2 };

/** Parents before children, things before what refers to them; deletions after, in reverse. */
function applyOrder(rows: ChangeRow[]): ChangeRow[] {
  const live = rows.filter((r) => !r.deleted).sort((a, b) => TABLE_ORDER[a.tbl] - TABLE_ORDER[b.tbl]);
  const folders = live.filter((r) => r.tbl === 'folders');
  const rest = live.filter((r) => r.tbl !== 'folders');
  const sortedFolders: ChangeRow[] = [];
  const pending = new Map(folders.map((r) => [r.key, r]));
  while (pending.size) {
    let progressed = false;
    for (const [key, r] of pending) {
      const parent = (r.data as FolderData).parent_id;
      if (!parent || !pending.has(parent)) {
        sortedFolders.push(r);
        pending.delete(key);
        progressed = true;
      }
    }
    if (!progressed) {
      sortedFolders.push(...pending.values()); // a cycle; the cycle guard below breaks it
      break;
    }
  }
  const dead = rows.filter((r) => r.deleted).sort((a, b) => TABLE_ORDER[b.tbl] - TABLE_ORDER[a.tbl]);
  return [...sortedFolders, ...rest, ...dead];
}

/**
 * Applies a peer's rows in one transaction. Rows that aren't newer than what this library has
 * are skipped. Every file a live image row names must already be in the library (the puller
 * downloads them first).
 *
 * The peer's own changes are written quietly, keeping the version they came with. Anything this
 * library then does about them is its own change and is logged as one: when an image arrives
 * that this library already has under another id (both Macs imported the same file before they
 * were paired), the copy with the smaller id is kept everywhere, and the other's tags and folder
 * are folded into it.
 */
export function applyRows(db: Database.Database, libraryPath: string, rows: ChangeRow[]): ApplyResult {
  const getLog = db.prepare('SELECT version, origin FROM sync_rows WHERE tbl = ? AND row_key = ?');
  const record = db.prepare(`
    INSERT INTO sync_rows (tbl, row_key, version, origin, seq, deleted)
    VALUES (@tbl, @key, @version, @origin, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_rows), @deleted)
    ON CONFLICT (tbl, row_key) DO UPDATE SET
      version = excluded.version, origin = excluded.origin, seq = excluded.seq, deleted = excluded.deleted`);
  const setApplying = db.prepare('UPDATE sync_state SET applying = ? WHERE id = 1');

  const folderExists = db.prepare('SELECT parent_id FROM folders WHERE id = ?');
  const upsertFolder = db.prepare(`
    INSERT INTO folders (id, name, parent_id, sort_order, color, created_at, updated_at)
    VALUES (@id, @name, @parent_id, @sort_order, @color, @created_at, @updated_at)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, parent_id = excluded.parent_id, sort_order = excluded.sort_order,
      color = excluded.color, created_at = excluded.created_at, updated_at = excluded.updated_at`);
  const deleteFolder = db.prepare('DELETE FROM folders WHERE id = ?');

  const imageById = db.prepare('SELECT id, folder_id, is_trashed FROM images WHERE id = ?');
  const imageBefore = db.prepare('SELECT title, notes, source_url, rating, folder_id, is_trashed, captions_version FROM images WHERE id = ?');
  const linkIsManual = db.prepare('SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ? AND t.name = ? AND it.is_auto = 0');
  const imageByHash = db.prepare('SELECT id, folder_id FROM images WHERE hash = ? AND id != ?');
  const imageCols = ['id', ...IMAGE_COLUMNS, 'updated_at', 'original_path', 'thumbnail_path'];
  const upsertImage = db.prepare(`
    INSERT INTO images (${imageCols.join(', ')}) VALUES (${imageCols.map((c) => `@${c}`).join(', ')})
    ON CONFLICT (id) DO UPDATE SET ${imageCols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`);
  const deleteImage = db.prepare('DELETE FROM images WHERE id = ?');
  const markReceived = db.prepare('INSERT OR IGNORE INTO sync_received (image_id) VALUES (?)');
  const deleteColors = db.prepare('DELETE FROM image_colors WHERE image_id = ?');
  const insertColor = db.prepare('INSERT INTO image_colors (id, image_id, hex_color, percentage, sort_order) VALUES (?, ?, ?, ?, ?)');
  const deleteEmbedding = db.prepare('DELETE FROM image_embeddings WHERE image_id = ?');
  const insertEmbedding = db.prepare('INSERT INTO image_embeddings (image_id, embedding) VALUES (?, ?)');

  const tagByName = db.prepare('SELECT id FROM tags WHERE name = ?');
  const insertTag = db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)');
  const upsertLink = db.prepare(`
    INSERT INTO image_tags (image_id, tag_id, is_auto, confidence) VALUES (?, ?, ?, ?)
    ON CONFLICT (image_id, tag_id) DO UPDATE SET is_auto = excluded.is_auto, confidence = excluded.confidence`);
  const deleteLink = db.prepare('DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?');
  const linkCount = db.prepare('SELECT COUNT(*) AS n FROM image_tags WHERE tag_id = ?');
  const deleteTag = db.prepare('DELETE FROM tags WHERE id = ?');
  const linksOf = db.prepare('SELECT t.name, t.color, it.is_auto, it.confidence FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ?');

  /** Would putting `id` under `parent` make a folder its own ancestor? */
  const makesCycle = (id: string, parent: string): boolean => {
    let at: string | null = parent;
    for (let hops = 0; at && hops < 1000; hops += 1) {
      if (at === id) return true;
      at = (folderExists.get(at) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
    return false;
  };

  const tagId = (name: string, color: string | null): string => {
    const found = tagByName.get(name) as { id: string } | undefined;
    if (found) return found.id;
    const id = crypto.randomUUID();
    insertTag.run(id, name, color);
    return id;
  };

  const result: ApplyResult = { applied: 0, skipped: 0, added: 0, removed: 0, changed: 0 };
  const addedIds = new Set<string>();
  const changedIds = new Set<string>();
  let changedFolders = 0;
  /** Duplicates to fold together once the peer's rows are in, as this library's own changes. */
  const merges: Array<{ keep: string; drop: string }> = [];

  const run = db.transaction(() => {
    setApplying.run(1);
    for (const row of applyOrder(rows)) {
      if (!isNewer(row, getLog.get(row.tbl, row.key) as LogEntry | undefined)) {
        result.skipped += 1;
        continue;
      }
      let take = true;

      if (row.tbl === 'folders') {
        // A board renamed, moved or deleted is a change; a new one isn't news worth a count.
        if (folderExists.get(row.key)) changedFolders += 1;
        if (row.deleted) {
          deleteFolder.run(row.key);
        } else {
          const d = row.data as FolderData;
          let parent = d.parent_id;
          if (parent && (!folderExists.get(parent) || makesCycle(d.id, parent))) parent = null;
          upsertFolder.run({ ...d, parent_id: parent });
        }
      } else if (row.tbl === 'images') {
        if (row.deleted) {
          // As emptying the Trash does: the row goes, the files stay.
          const gone = imageById.get(row.key) as { is_trashed: number } | undefined;
          if (gone && !gone.is_trashed) result.removed += 1;
          deleteImage.run(row.key);
          deleteEmbedding.run(row.key);
        } else {
          const d = row.data as ImageData;
          const twin = !imageById.get(d.id) && d.hash ? (imageByHash.get(d.hash, d.id) as { id: string } | undefined) : undefined;
          if (twin && twin.id < d.id) {
            take = false; // this library's copy is the one everyone keeps
          } else {
            const before = imageBefore.get(d.id) as
              | { title: string; notes: string; source_url: string; rating: number; folder_id: string | null; is_trashed: number; captions_version: number | null }
              | undefined;
            if (!before) {
              markReceived.run(d.id);
              if (!d.is_trashed) {
                result.added += 1;
                addedIds.add(d.id);
              }
            } else if (!before.is_trashed && d.is_trashed) {
              result.removed += 1;
            } else if (
              before.title !== d.title ||
              before.source_url !== d.source_url ||
              (before.rating ?? 0) !== (d.rating ?? 0) ||
              before.folder_id !== d.folder_id ||
              (before.is_trashed && !d.is_trashed) ||
              // Notes rewritten by an AI pass come with a new captions version; edits by hand don't.
              (before.notes !== d.notes && before.captions_version === d.captions_version)
            ) {
              changedIds.add(d.id);
            }
            const folder = d.folder_id && folderExists.get(d.folder_id) ? d.folder_id : null;
            const values: Record<string, unknown> = { id: d.id, updated_at: d.updated_at };
            for (const c of IMAGE_COLUMNS) values[c] = (d as unknown as Record<string, unknown>)[c] ?? null;
            values.rating = d.rating ?? 0;
            values.folder_id = folder;
            values.phash = d.phash ? Buffer.from(d.phash, 'base64') : null;
            values.original_path = path.join(libraryPath, 'originals', d.original);
            values.thumbnail_path = d.thumbnail ? path.join(libraryPath, 'thumbnails', d.thumbnail) : null;
            upsertImage.run(values);
            deleteColors.run(d.id);
            for (const c of d.colors) insertColor.run(crypto.randomUUID(), d.id, c.hex_color, c.percentage, c.sort_order);
            deleteEmbedding.run(d.id);
            if (d.embedding) insertEmbedding.run(d.id, Buffer.from(d.embedding, 'base64'));
            if (twin) merges.push({ keep: d.id, drop: twin.id });
          }
        }
      } else {
        const { imageId, tag } = splitLinkKey(row.key);
        const existingTag = tagByName.get(tag) as { id: string } | undefined;
        // Tags added or removed by hand count; the AI's own tags don't.
        const manual = row.deleted ? !!linkIsManual.get(imageId, tag) : (row.data as LinkData).is_auto === 0;
        if (manual && imageById.get(imageId)) changedIds.add(imageId);
        if (row.deleted) {
          if (existingTag) {
            deleteLink.run(imageId, existingTag.id);
            if ((linkCount.get(existingTag.id) as { n: number }).n === 0) deleteTag.run(existingTag.id);
          }
        } else if (imageById.get(imageId)) {
          const d = row.data as LinkData;
          upsertLink.run(imageId, tagId(tag, d.tag_color), d.is_auto, d.confidence);
        } else {
          take = false; // its image isn't here and isn't coming
        }
      }

      if (take) {
        record.run({ tbl: row.tbl, key: row.key, version: row.version, origin: row.origin, deleted: row.deleted ? 1 : 0 });
        result.applied += 1;
      } else {
        result.skipped += 1;
      }
    }
    setApplying.run(0);

    for (const { keep, drop } of merges) {
      const kept = imageById.get(keep) as { folder_id: string | null } | undefined;
      const dropped = imageById.get(drop) as { folder_id: string | null } | undefined;
      if (!kept || !dropped) continue;
      for (const link of linksOf.all(drop) as Array<{ name: string; color: string | null; is_auto: number; confidence: number | null }>) {
        const id = tagId(link.name, link.color);
        db.prepare('INSERT OR IGNORE INTO image_tags (image_id, tag_id, is_auto, confidence) VALUES (?, ?, ?, ?)').run(keep, id, link.is_auto, link.confidence);
      }
      if (!kept.folder_id && dropped.folder_id) {
        db.prepare("UPDATE images SET folder_id = ?, updated_at = datetime('now') WHERE id = ?").run(dropped.folder_id, keep);
      }
      deleteImage.run(drop);
      deleteEmbedding.run(drop);
    }
  });
  run();
  for (const id of addedIds) changedIds.delete(id);
  result.changed = changedIds.size + changedFolders;
  return result;
}
