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

CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
    title, notes, tags_text, content=images, content_rowid=rowid
);
`;

/**
 * Caption-text embeddings from Ollama's nomic-embed-text model (768-dim).
 * Replaces the previous 512-dim CLIP image embeddings.
 */
const VECTOR_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS image_embeddings USING vec0(
    image_id TEXT PRIMARY KEY,
    embedding float[768]
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

/**
 * sqlite-vec virtual tables don't expose their declared dim via PRAGMA, so we probe by inserting a zero
 * vector of the new size and rolling back. If insertion fails, the existing table has a different dim
 * and we drop & recreate it.
 */
function ensureEmbeddingTableDim(db: Database.Database, expectedDim: number): void {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_embeddings'")
    .get();
  if (!tableExists) return;

  const probeId = `__dim_probe__${Date.now()}`;
  const zeros = new Array(expectedDim).fill(0);
  try {
    db.exec('BEGIN');
    db.prepare('INSERT INTO image_embeddings (image_id, embedding) VALUES (?, ?)').run(
      probeId,
      JSON.stringify(zeros),
    );
    db.prepare('DELETE FROM image_embeddings WHERE image_id = ?').run(probeId);
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    console.log('[schema] Embedding table dim mismatch — dropping and recreating for', expectedDim, 'dims');
    db.exec('DROP TABLE image_embeddings');
  }
}

function ensureImagesPhashColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(images)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'phash')) {
    db.exec('ALTER TABLE images ADD COLUMN phash BLOB');
  }
}

/**
 * Historically deletePermanently didn't remove the image's vector (vec0 ignores CASCADE),
 * so long-lived libraries carry orphaned embeddings that waste KNN slots. One-shot sweep;
 * deletes go one-by-one because vec0 doesn't support subquery WHEREs reliably.
 */
function cleanupOrphanedEmbeddings(db: Database.Database): void {
  try {
    const orphans = db
      .prepare(
        `SELECT e.image_id AS id FROM image_embeddings e
         LEFT JOIN images i ON i.id = e.image_id WHERE i.id IS NULL`,
      )
      .all() as Array<{ id: string }>;
    if (orphans.length === 0) return;
    const del = db.prepare('DELETE FROM image_embeddings WHERE image_id = ?');
    for (const o of orphans) del.run(o.id);
    console.log(`[schema] removed ${orphans.length} orphaned embedding rows`);
  } catch (err) {
    console.warn('[schema] orphaned embedding sweep failed:', err);
  }
}

const MIGRATIONS = [
  `ALTER TABLE images ADD COLUMN alt_text TEXT DEFAULT ''`,
  // Which caption model/prompt generation produced this image's alt/notes/tags.
  // 1 = LLaVA-era, 2 = Qwen3-VL + enriched design prompt. Rows below the current
  // version get re-analyzed by the startup migration in ipc-handlers.
  `ALTER TABLE images ADD COLUMN captions_version INTEGER DEFAULT 1`,
];

export function runMigrations(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  ensureEmbeddingTableDim(db, 768);
  db.exec(VECTOR_TABLE_SQL);
  ensureImagesIndexedChromatic(db);
  ensureImagesHueIndex(db);
  ensureImagesHueBucketIndex(db);
  ensureImagesPhashColumn(db);
  cleanupOrphanedEmbeddings(db);

  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Column/table already exists
    }
  }
}
