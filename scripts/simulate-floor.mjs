/**
 * Simulate similarity-floor candidates for moodboard search against the real library,
 * and verify the vec0 L2-distance → cosine conversion used in searchByEmbedding.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/simulate-floor.mjs /tmp/muse-verify/library.db
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'nomic-embed-text';
const dbPath = process.argv[2];

// prompt + a human judgment of how many library images should plausibly match
const PROMPTS = [
  ['moody sunset landscapes with warm oranges and silhouetted trees', 'few (1-3 sunset/nature shots)'],
  ['minimal product photography on a plain background', 'many (design library)'],
  ['people portraits with soft natural lighting', 'one (single person photo)'],
  ['bold typography and graphic design posters', 'handful (3-5 graphics)'],
  ['blue ocean and water scenes', 'none'],
  ['mobile app user interface design', 'many (dominant content)'],
];

const CANDIDATES = [
  { abs: 0.45, win: 0.12 }, // shipped guess
  { abs: 0.60, win: 0.10 },
  { abs: 0.62, win: 0.10 },
  { abs: 0.62, win: 0.12 },
  { abs: 0.64, win: 0.08 },
];

async function embed(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  const { embedding } = await res.json();
  let s = 0;
  for (const x of embedding) s += x * x;
  const n = Math.sqrt(s);
  return embedding.map((x) => x / n);
}

const db = new Database(dbPath, { readonly: true });
sqliteVec.load(db);

const images = db.prepare(`SELECT id, filename, alt_text, notes FROM images WHERE is_trashed = 0`).all();
const tagStmt = db.prepare(`SELECT t.name FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id = ?`);

const docs = [];
for (const img of images) {
  const tags = tagStmt.all(img.id).map((r) => r.name);
  const parts = [];
  if (img.alt_text?.trim()) parts.push(img.alt_text.trim());
  if (img.notes?.trim()) parts.push(img.notes.trim());
  if (tags.length) parts.push(`Tags: ${tags.join(', ')}`);
  if (!parts.length) parts.push(img.filename);
  docs.push({ id: img.id, filename: img.filename, alt: (img.alt_text || '').slice(0, 60), vec: await embed('search_document: ' + parts.join('\n')) });
}
console.log(`embedded ${docs.length} docs (prefixed)`);

// --- vec0 metric check: insert prefixed vectors into a scratch vec0 table, compare
// its reported distance for one query against brute cosine via d² = 2 - 2cos.
const mem = new Database(':memory:');
sqliteVec.load(mem);
mem.exec('CREATE VIRTUAL TABLE t USING vec0(image_id TEXT PRIMARY KEY, embedding float[768])');
const ins = mem.prepare('INSERT INTO t (image_id, embedding) VALUES (?, ?)');
for (const d of docs) ins.run(d.id, JSON.stringify(d.vec));

const q0 = await embed('search_query: ' + PROMPTS[0][0]);
const knn = mem.prepare('SELECT image_id, distance FROM t WHERE embedding MATCH ? ORDER BY distance LIMIT 5').all(JSON.stringify(q0));
console.log('\nvec0 metric check (top 5):');
for (const r of knn) {
  const doc = docs.find((d) => d.id === r.image_id);
  const brute = doc.vec.reduce((s, x, i) => s + x * q0[i], 0);
  const fromD = 1 - (r.distance * r.distance) / 2;
  console.log(`  d=${r.distance.toFixed(4)}  cos_from_d=${fromD.toFixed(4)}  brute_cos=${brute.toFixed(4)}  1-d=${(1 - r.distance).toFixed(4)}`);
}

console.log('\nfloor simulation (requested count = 24):');
for (const [prompt, expectation] of PROMPTS) {
  const q = await embed('search_query: ' + prompt);
  const ranked = docs
    .map((d) => ({ ...d, cos: d.vec.reduce((s, x, i) => s + x * q[i], 0) }))
    .sort((a, b) => b.cos - a.cos)
    .slice(0, 24);
  const top = ranked[0].cos;
  const line = CANDIDATES.map(({ abs, win }) => {
    const floor = Math.max(abs, top - win);
    return `abs${abs}/w${win}→${ranked.filter((r) => r.cos >= floor).length}`;
  }).join('  ');
  console.log(`\n"${prompt}"  [expect: ${expectation}]  top=${top.toFixed(3)}`);
  console.log(`  ${line}`);
  console.log(`  top6: ${ranked.slice(0, 6).map((r) => r.cos.toFixed(3) + ' ' + r.alt.slice(0, 32)).join(' | ')}`);
}
