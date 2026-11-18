import type Database from 'better-sqlite3';

/**
 * The change log library sync is built on.
 *
 * `sync_rows` holds one entry per synced row: which version of it this library has, which Mac
 * made that version, and `seq`, the order this library came to have it in. A peer asks for
 * everything past the last `seq` it saw and is sent each row as it is now (or a tombstone).
 *
 * Triggers keep it current, so every write path in the app (repositories, the importer, the AI
 * queue, the palette backfill, a `.muse` import) is covered without knowing about sync. While
 * sync itself is writing a peer's change (`sync_state.applying = 1`) they stay quiet: that row
 * keeps the version it came with.
 *
 * Versions are milliseconds since 1970, but never less than the row's last version plus one,
 * so an edit on a Mac whose clock runs behind still beats what it is editing. Ties go to the
 * larger device id. Synced:
 *
 * - `folders`, by id
 * - `images`, by id. The palette (`image_colors`) and caption embedding travel with the image,
 *   so their writes bump it too: palettes through a trigger, embeddings by `markImageChanged`
 *   (sqlite-vec tables can't have triggers).
 * - `image_tags`, by `<image id>|<tag name>`. Tags are known by name, not id: two Macs that each
 *   made a "poster" tag mean the same tag. Tags themselves aren't synced; a link brings its tag
 *   into being, and Muse already clears out tags with nothing left in them.
 */

const SYNC_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sync_rows (
    tbl      TEXT NOT NULL,
    row_key  TEXT NOT NULL,
    version  INTEGER NOT NULL,
    origin   TEXT NOT NULL,
    seq      INTEGER NOT NULL,
    deleted  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tbl, row_key)
);
CREATE INDEX IF NOT EXISTS idx_sync_rows_seq ON sync_rows(seq);

-- Images that first arrived from another Mac. That Mac describes them; see ai/caption-sweep.ts.
CREATE TABLE IF NOT EXISTS sync_received (
    image_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS sync_state (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    applying  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO sync_state (id, applying) VALUES (1, 0);
`;

/** Bump this when a trigger below changes; the triggers are recreated when it differs. */
const TRIGGERS_VERSION = '1';

/** Synced `images` columns. `original_path`/`thumbnail_path` are where this Mac keeps the files,
    so they aren't compared, and `updated_at` only ever changes alongside something that is. */
export const IMAGE_COLUMNS = [
  'filename', 'title', 'notes', 'alt_text', 'source_url', 'rating', 'width', 'height', 'file_size',
  'file_type', 'hash', 'is_trashed', 'trashed_at', 'folder_id', 'created_at', 'imported_at',
  'file_created_at', 'file_modified_at', 'duration_ms', 'captions_version', 'phash',
  'indexed_chromatic', 'indexed_hue_bucket', 'indexed_hue_strength', 'indexed_hue_degrees',
  'indexed_hue_bucket_2', 'indexed_hue_strength_2',
] as const;

export const FOLDER_COLUMNS = ['name', 'parent_id', 'sort_order', 'color', 'created_at'] as const;

/** SQL for "this row changed here": a fresh version, this Mac as its origin, the next seq. */
export function logChangeSql(table: string, keyExpr: string, deleted: 0 | 1): string {
  return `
    INSERT INTO sync_rows (tbl, row_key, version, origin, seq, deleted)
    VALUES (
      '${table}', ${keyExpr},
      MAX(
        CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER),
        COALESCE((SELECT version FROM sync_rows WHERE tbl = '${table}' AND row_key = ${keyExpr}), 0) + 1
      ),
      (SELECT value FROM settings WHERE key = 'sync_device_id'),
      (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_rows),
      ${deleted}
    )
    ON CONFLICT (tbl, row_key) DO UPDATE SET
      version = excluded.version, origin = excluded.origin, seq = excluded.seq, deleted = excluded.deleted;`;
}

const QUIET = '(SELECT applying FROM sync_state WHERE id = 1) = 0';

function changed(columns: readonly string[]): string {
  return columns.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
}

const LINK_KEY_NEW = `NEW.image_id || '|' || (SELECT name FROM tags WHERE id = NEW.tag_id)`;
const LINK_KEY_OLD = `OLD.image_id || '|' || (SELECT name FROM tags WHERE id = OLD.tag_id)`;

function triggersSql(): string {
  return `
DROP TRIGGER IF EXISTS sync_folders_insert;
DROP TRIGGER IF EXISTS sync_folders_update;
DROP TRIGGER IF EXISTS sync_folders_delete;
DROP TRIGGER IF EXISTS sync_images_insert;
DROP TRIGGER IF EXISTS sync_images_update;
DROP TRIGGER IF EXISTS sync_images_delete;
DROP TRIGGER IF EXISTS sync_colors_insert;
DROP TRIGGER IF EXISTS sync_colors_delete;
DROP TRIGGER IF EXISTS sync_links_insert;
DROP TRIGGER IF EXISTS sync_links_update;
DROP TRIGGER IF EXISTS sync_links_delete;
DROP TRIGGER IF EXISTS sync_tags_delete;

CREATE TRIGGER sync_folders_insert AFTER INSERT ON folders WHEN ${QUIET}
BEGIN ${logChangeSql('folders', 'NEW.id', 0)} END;

CREATE TRIGGER sync_folders_update AFTER UPDATE ON folders WHEN ${QUIET} AND (${changed(FOLDER_COLUMNS)})
BEGIN ${logChangeSql('folders', 'NEW.id', 0)} END;

CREATE TRIGGER sync_folders_delete AFTER DELETE ON folders WHEN ${QUIET}
BEGIN ${logChangeSql('folders', 'OLD.id', 1)} END;

CREATE TRIGGER sync_images_insert AFTER INSERT ON images WHEN ${QUIET}
BEGIN ${logChangeSql('images', 'NEW.id', 0)} END;

CREATE TRIGGER sync_images_update AFTER UPDATE ON images WHEN ${QUIET} AND (${changed(IMAGE_COLUMNS)})
BEGIN ${logChangeSql('images', 'NEW.id', 0)} END;

CREATE TRIGGER sync_images_delete AFTER DELETE ON images WHEN ${QUIET}
BEGIN ${logChangeSql('images', 'OLD.id', 1)} END;

CREATE TRIGGER sync_colors_insert AFTER INSERT ON image_colors
WHEN ${QUIET} AND EXISTS (SELECT 1 FROM images WHERE id = NEW.image_id)
BEGIN ${logChangeSql('images', 'NEW.image_id', 0)} END;

CREATE TRIGGER sync_colors_delete AFTER DELETE ON image_colors
WHEN ${QUIET} AND EXISTS (SELECT 1 FROM images WHERE id = OLD.image_id)
BEGIN ${logChangeSql('images', 'OLD.image_id', 0)} END;

CREATE TRIGGER sync_links_insert AFTER INSERT ON image_tags
WHEN ${QUIET} AND EXISTS (SELECT 1 FROM tags WHERE id = NEW.tag_id)
BEGIN ${logChangeSql('image_tags', LINK_KEY_NEW, 0)} END;

CREATE TRIGGER sync_links_update AFTER UPDATE ON image_tags
WHEN ${QUIET} AND EXISTS (SELECT 1 FROM tags WHERE id = NEW.tag_id)
  AND (OLD.is_auto IS NOT NEW.is_auto OR OLD.confidence IS NOT NEW.confidence)
BEGIN ${logChangeSql('image_tags', LINK_KEY_NEW, 0)} END;

-- A link deleted because its tag was deleted fires after the tag is gone and can't be named
-- here; sync_tags_delete has already logged it.
CREATE TRIGGER sync_links_delete AFTER DELETE ON image_tags
WHEN ${QUIET} AND EXISTS (SELECT 1 FROM tags WHERE id = OLD.tag_id)
BEGIN ${logChangeSql('image_tags', LINK_KEY_OLD, 1)} END;

CREATE TRIGGER sync_tags_delete BEFORE DELETE ON tags WHEN ${QUIET}
BEGIN
  INSERT INTO sync_rows (tbl, row_key, version, origin, seq, deleted)
  SELECT
    'image_tags', it.image_id || '|' || OLD.name,
    MAX(
      CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER),
      COALESCE((SELECT version FROM sync_rows WHERE tbl = 'image_tags' AND row_key = it.image_id || '|' || OLD.name), 0) + 1
    ),
    (SELECT value FROM settings WHERE key = 'sync_device_id'),
    (SELECT COALESCE(MAX(seq), 0) FROM sync_rows) + ROW_NUMBER() OVER (),
    1
  FROM image_tags it WHERE it.tag_id = OLD.id
  ON CONFLICT (tbl, row_key) DO UPDATE SET
    version = excluded.version, origin = excluded.origin, seq = excluded.seq, deleted = excluded.deleted;
END;
`;
}

/** Entries for rows that predate sync, versioned by when they were last changed. Run once. */
const BACKFILL_SQL = `
INSERT OR IGNORE INTO sync_rows (tbl, row_key, version, origin, seq, deleted)
SELECT 'folders', id, COALESCE(CAST((julianday(updated_at) - 2440587.5) * 86400000.0 AS INTEGER), 0),
       (SELECT value FROM settings WHERE key = 'sync_device_id'),
       (SELECT COALESCE(MAX(seq), 0) FROM sync_rows) + ROW_NUMBER() OVER (ORDER BY created_at), 0
FROM folders WHERE true;

INSERT OR IGNORE INTO sync_rows (tbl, row_key, version, origin, seq, deleted)
SELECT 'images', id, COALESCE(CAST((julianday(updated_at) - 2440587.5) * 86400000.0 AS INTEGER), 0),
       (SELECT value FROM settings WHERE key = 'sync_device_id'),
       (SELECT COALESCE(MAX(seq), 0) FROM sync_rows) + ROW_NUMBER() OVER (ORDER BY imported_at), 0
FROM images WHERE true;

INSERT OR IGNORE INTO sync_rows (tbl, row_key, version, origin, seq, deleted)
SELECT 'image_tags', it.image_id || '|' || t.name, 0,
       (SELECT value FROM settings WHERE key = 'sync_device_id'),
       (SELECT COALESCE(MAX(seq), 0) FROM sync_rows) + ROW_NUMBER() OVER (), 0
FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE true;
`;

function setting(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

/** Creates the change log and its triggers, and logs every row that predates them. */
export function installSyncSchema(db: Database.Database): void {
  db.exec(SYNC_TABLES_SQL);
  // A crash can't leave this set (it's only ever set inside a transaction), but be certain.
  db.prepare('UPDATE sync_state SET applying = 0 WHERE id = 1').run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('sync_device_id', lower(hex(randomblob(16))))").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('sync_epoch', lower(hex(randomblob(16))))").run();

  if (setting(db, 'sync_triggers_version') !== TRIGGERS_VERSION) {
    db.transaction(() => {
      db.exec(triggersSql());
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync_triggers_version', ?)").run(TRIGGERS_VERSION);
    })();
  }
  if (setting(db, 'sync_backfilled') !== '1') {
    db.transaction(() => {
      db.exec(BACKFILL_SQL);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync_backfilled', '1')").run();
    })();
  }
}

/**
 * Gives this library a new device id and log when it turns up on a different Mac (a Migration
 * Assistant copy, say). Two Macs sharing an id would each ignore the other.
 */
export function claimDeviceIdentity(db: Database.Database, machineId: string | null): void {
  if (!machineId) return;
  const known = setting(db, 'sync_machine_id');
  if (known && known !== machineId) {
    db.prepare("UPDATE settings SET value = lower(hex(randomblob(16))) WHERE key IN ('sync_device_id', 'sync_epoch')").run();
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync_machine_id', ?)").run(machineId);
}

export function deviceId(db: Database.Database): string {
  return setting(db, 'sync_device_id') ?? '';
}

export function logEpoch(db: Database.Database): string {
  return setting(db, 'sync_epoch') ?? '';
}

/** Records that an image changed in a way no trigger sees: its caption embedding. */
export function markImageChanged(db: Database.Database, imageId: string): void {
  const state = db.prepare('SELECT applying FROM sync_state WHERE id = 1').get() as { applying: number } | undefined;
  if (!state || state.applying !== 0) return;
  if (!db.prepare('SELECT 1 FROM images WHERE id = ?').get(imageId)) return;
  db.prepare(logChangeSql('images', '@id', 0)).run({ id: imageId });
}
