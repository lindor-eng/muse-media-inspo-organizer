/**
 * End-to-end check of the upgraded search pipeline against a WRITABLE copy of the library:
 *   1. orphaned-embedding sweep (mirrors cleanupOrphanedEmbeddings)
 *   2. re-embed with search_document: prefix (mirrors upgradeEmbeddingIndexIfNeeded)
 *   3. searchByText with search_query: prefix + dead-row over-fetch + similarity floor
 *
 *   cp "…/library.db"* /tmp/muse-e2e/ && ELECTRON_RUN_AS_NODE=1 npx electron scripts/verify-e2e-search.mjs /tmp/muse-e2e/library.db
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const OLLAMA = 'http://127.0.0.1:11434';
const ABS = 0.62;
const WIN = 0.1;

async function embed(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
  });
  const { embedding } = await res.json();
  let s = 0;
  for (const x of embedding) s += x * x;
  const n = Math.sqrt(s);
  return embedding.map((x) => x / n);
}

const db = new Database(process.argv[2]);
sqliteVec.load(db);

// 1. orphan sweep
const orphans = db
  .prepare(
    `SELECT e.image_id AS id FROM image_embeddings e LEFT JOIN images i ON i.id = e.image_id WHERE i.id IS NULL`,
  )
  .all();
const del = db.prepare('DELETE FROM image_embeddings WHERE image_id = ?');
for (const o of orphans) del.run(o.id);
console.log(`swept ${orphans.length} orphaned embeddings`);

// 2. re-embed with document prefix
const rows = db
  .prepare(
    `SELECT i.id, i.filename, i.alt_text, i.notes FROM image_embeddings e INNER JOIN images i ON i.id = e.image_id`,
  )
  .all();
const tagStmt = db.prepare(`SELECT t.name FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id = ?`);
const upDel = db.prepare('DELETE FROM image_embeddings WHERE image_id = ?');
const upIns = db.prepare('INSERT INTO image_embeddings (image_id, embedding) VALUES (?, ?)');
for (const r of rows) {
  const tags = tagStmt.all(r.id).map((t) => t.name);
  const parts = [];
  if (r.alt_text?.trim()) parts.push(r.alt_text.trim());
  if (r.notes?.trim()) parts.push(r.notes.trim());
  if (tags.length) parts.push(`Tags: ${tags.join(', ')}`);
  if (!parts.length) parts.push(r.filename);
  const vec = await embed('search_document: ' + parts.join('\n'));
  const f32 = new Float32Array(vec);
  upDel.run(r.id);
  upIns.run(r.id, Buffer.from(f32.buffer));
}
console.log(`re-embedded ${rows.length} images with document prefix`);

// 3. searchByText mirror
async function searchByText(query, limit) {
  const q = await embed('search_query: ' + query);
  const deadRows = db
    .prepare(
      `SELECT COUNT(*) AS c FROM image_embeddings e LEFT JOIN images i ON i.id = e.image_id
       WHERE i.id IS NULL OR i.is_trashed != 0`,
    )
    .get().c;
  const knn = db
    .prepare(`SELECT image_id, distance FROM image_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
    .all(JSON.stringify(q), limit + deadRows);
  const getImg = db.prepare('SELECT filename, alt_text, is_trashed FROM images WHERE id = ?');
  const out = [];
  for (const row of knn) {
    const img = getImg.get(row.image_id);
    if (!img || img.is_trashed !== 0) continue;
    const d = Number(row.distance);
    out.push({ id: row.image_id, filename: img.filename, alt: (img.alt_text || '').slice(0, 55), cosine: 1 - (d * d) / 2 });
    if (out.length >= limit) break;
  }
  const floor = out.length ? Math.max(ABS, out[0].cosine - WIN) : 0;
  return { deadRows, kept: out.filter((h) => h.cosine >= floor), fetched: out.length };
}

for (const prompt of [
  'moody sunset landscapes with warm oranges and silhouetted trees',
  'mobile app user interface design',
  'blue ocean and water scenes',
]) {
  const { deadRows, kept, fetched } = await searchByText(prompt, 24);
  console.log(`\n"${prompt}"  deadRows=${deadRows}  fetched=${fetched}  kept=${kept.length}`);
  for (const k of kept.slice(0, 6)) console.log(`  ${k.cosine.toFixed(3)}  ${k.alt}`);
}
