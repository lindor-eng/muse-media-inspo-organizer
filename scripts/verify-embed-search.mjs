/**
 * Empirically verify the nomic-embed task-prefix change and ground the moodboard
 * similarity-floor constants against the real library.
 *
 * Run with the Electron runtime so better-sqlite3's native module loads:
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/verify-embed-search.mjs /tmp/muse-verify/library.db
 *
 * For each test prompt, ranks the library two ways:
 *   A (current): raw query embedding  vs raw document embeddings
 *   B (new):     search_query: prefix vs search_document: prefix
 * and prints top matches + cosine distributions so the floor values in
 * natural-search.ts can be sanity-checked rather than guessed.
 */
import Database from 'better-sqlite3';

const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'nomic-embed-text';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: verify-embed-search.mjs <library.db>');
  process.exit(1);
}

const PROMPTS = [
  'moody sunset landscapes with warm oranges and silhouetted trees',
  'minimal product photography on a plain background',
  'people portraits with soft natural lighting',
  'bold typography and graphic design posters',
  'blue ocean and water scenes',
];

async function embed(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status}`);
  const { embedding } = await res.json();
  return l2(embedding);
}

function l2(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return v.map((x) => x / n);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function composeText(row, tags) {
  const parts = [];
  if (row.alt_text?.trim()) parts.push(row.alt_text.trim());
  if (row.notes?.trim()) parts.push(row.notes.trim());
  if (tags.length) parts.push(`Tags: ${tags.join(', ')}`);
  if (!parts.length && row.filename) parts.push(row.filename);
  return parts.join('\n');
}

const db = new Database(dbPath, { readonly: true });
const images = db
  .prepare(`SELECT id, filename, alt_text, notes FROM images WHERE is_trashed = 0`)
  .all();
const tagStmt = db.prepare(
  `SELECT t.name FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id = ?`,
);

console.log(`Embedding ${images.length} documents twice (raw + prefixed)…`);
const docs = [];
for (const img of images) {
  const tags = tagStmt.all(img.id).map((r) => r.name);
  const text = composeText(img, tags);
  if (!text.trim()) continue;
  const [raw, prefixed] = [await embed(text), await embed('search_document: ' + text)];
  docs.push({ id: img.id, filename: img.filename, alt: (img.alt_text || '').slice(0, 70), raw, prefixed });
}
console.log(`Embedded ${docs.length} documents.\n`);

function rank(queryVec, key) {
  return docs
    .map((d) => ({ ...d, cos: dot(queryVec, d[key]) }))
    .sort((a, b) => b.cos - a.cos);
}

function stats(ranked) {
  const cs = ranked.map((r) => r.cos);
  return {
    top: cs[0].toFixed(3),
    p10: cs[Math.floor(cs.length * 0.1)].toFixed(3),
    median: cs[Math.floor(cs.length / 2)].toFixed(3),
    bottom: cs[cs.length - 1].toFixed(3),
  };
}

for (const prompt of PROMPTS) {
  const [qRaw, qPre] = [await embed(prompt), await embed('search_query: ' + prompt)];
  const A = rank(qRaw, 'raw');
  const B = rank(qPre, 'prefixed');

  console.log('='.repeat(90));
  console.log(`PROMPT: ${prompt}`);
  console.log(`  A raw:      ${JSON.stringify(stats(A))}`);
  console.log(`  B prefixed: ${JSON.stringify(stats(B))}`);
  const overlap = new Set(A.slice(0, 10).map((r) => r.id));
  const shared = B.slice(0, 10).filter((r) => overlap.has(r.id)).length;
  console.log(`  top-10 overlap A∩B: ${shared}/10`);
  console.log(`  B top 8:`);
  for (const r of B.slice(0, 8)) console.log(`    ${r.cos.toFixed(3)}  ${r.filename}  | ${r.alt}`);
  console.log(`  B ranks 20-24 (weak tail):`);
  for (const r of B.slice(19, 24)) console.log(`    ${r.cos.toFixed(3)}  ${r.filename}  | ${r.alt}`);
}
