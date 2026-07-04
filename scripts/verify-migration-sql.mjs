/** Sanity-check the SQL used by upgradeEmbeddingIndexIfNeeded + searchByEmbedding dead-row count. */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const db = new Database(process.argv[2], { readonly: true });
sqliteVec.load(db);

const ids = db
  .prepare('SELECT e.image_id AS id FROM image_embeddings e INNER JOIN images i ON i.id = e.image_id')
  .all();
console.log('re-embed candidates:', ids.length);

const dead = db
  .prepare(
    `SELECT COUNT(*) AS c FROM image_embeddings e LEFT JOIN images i ON i.id = e.image_id
     WHERE i.id IS NULL OR i.is_trashed != 0`,
  )
  .get();
console.log('dead embedding rows:', dead.c);

const ver = db.prepare('SELECT value FROM settings WHERE key = ?').get('embedding_index_version');
console.log('embedding_index_version:', ver?.value ?? '(unset — migration will run)');
