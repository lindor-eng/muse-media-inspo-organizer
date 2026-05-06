import type Database from 'better-sqlite3';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
    sort_order  INTEGER DEFAULT 0,
    color       TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

CREATE TABLE IF NOT EXISTS tags (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    color       TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS images (
    id              TEXT PRIMARY KEY,
    filename        TEXT NOT NULL,
    original_path   TEXT NOT NULL,
    thumbnail_path  TEXT,
    title           TEXT DEFAULT '',
    notes           TEXT DEFAULT '',
    source_url      TEXT DEFAULT '',
    rating          INTEGER DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
    width           INTEGER,
    height          INTEGER,
    file_size       INTEGER,
    file_type       TEXT,
    hash            TEXT,
    is_trashed      INTEGER DEFAULT 0,
    trashed_at      TEXT,
    folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    imported_at     TEXT DEFAULT (datetime('now')),
    file_created_at TEXT,
    file_modified_at TEXT,
    indexed_chromatic INTEGER,
    indexed_hue_bucket INTEGER,
    indexed_hue_strength REAL,
    indexed_hue_degrees REAL,
    indexed_hue_bucket_2 INTEGER,
    indexed_hue_strength_2 REAL
);
CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder_id);
CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash);
CREATE INDEX IF NOT EXISTS idx_images_trashed ON images(is_trashed);

CREATE TABLE IF NOT EXISTS image_colors (
    id          TEXT PRIMARY KEY,
    image_id    TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    hex_color   TEXT NOT NULL,
    percentage  REAL,
    sort_order  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_image_colors_image ON image_colors(image_id);

CREATE TABLE IF NOT EXISTS image_tags (
    image_id    TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    is_auto     INTEGER DEFAULT 0,
    confidence  REAL,
    PRIMARY KEY (image_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag_id);

CREATE TABLE IF NOT EXISTS smart_folders (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    query_json  TEXT NOT NULL,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_queue (
    id          TEXT PRIMARY KEY,
    image_id    TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    task_type   TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    attempts    INTEGER DEFAULT 0,
    error_msg   TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_queue_status ON ai_queue(status, task_type);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS image_embeddings (
    image_id    TEXT PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
    embedding   BLOB NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
    title, notes, tags_text, content=images, content_rowid=rowid
);
`;

const VECTOR_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS image_embeddings USING vec0(
    image_id TEXT PRIMARY KEY,
    embedding float[512]
);
`;

function ensureImagesIndexedChromatic(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(images)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'indexed_chromatic')) {
    db.exec('ALTER TABLE images ADD COLUMN indexed_chromatic INTEGER');
  }
}

function ensureImagesHueIndex(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(images)').all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('indexed_hue_bucket')) {
    db.exec('ALTER TABLE images ADD COLUMN indexed_hue_bucket INTEGER');
  }
  if (!names.has('indexed_hue_strength')) {
    db.exec('ALTER TABLE images ADD COLUMN indexed_hue_strength REAL');
  }
  if (!names.has('indexed_hue_degrees')) {
    db.exec('ALTER TABLE images ADD COLUMN indexed_hue_degrees REAL');
  }
  if (!names.has('indexed_hue_bucket_2')) {
    db.exec('ALTER TABLE images ADD COLUMN indexed_hue_bucket_2 INTEGER');
  }
  if (!names.has('indexed_hue_strength_2')) {
    db.exec('ALTER TABLE images ADD COLUMN indexed_hue_strength_2 REAL');
  }
}

function ensureImagesHueBucketIndex(db: Database.Database): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_images_dominant_hue ON images(indexed_hue_bucket)');
}

const MIGRATIONS = [
  `ALTER TABLE images ADD COLUMN alt_text TEXT DEFAULT ''`,
];

export function runMigrations(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  db.exec(VECTOR_TABLE_SQL);
  ensureImagesIndexedChromatic(db);
  ensureImagesHueIndex(db);
  ensureImagesHueBucketIndex(db);

  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Column/table already exists
    }
  }
}
