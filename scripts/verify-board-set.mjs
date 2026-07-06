/**
 * Verify the set-selection stage of searchForMoodboard (pHash dedupe + MMR cohesion +
 * outlier pruning) against a re-embedded library copy (run verify-e2e-search.mjs first).
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/verify-board-set.mjs /tmp/muse-e2e/library.db
 *
 * Mirrors constants/logic in src/main/ai/natural-search.ts selectBoardSet. Skips HyDE
 * (direct embedding only) so runs are fast and deterministic — the set stage is what's
 * under test, and it operates on whatever survivor list it's given.
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const OLLAMA = 'http://127.0.0.1:11434';
const ABS = 0.62;
const WIN = 0.12;
const DEDUPE_MAX_HAMMING = 6;
const COHESION_LAMBDA = 0.3;
const SEED_COUNT = 3;
const OUTLIER_AFFINITY_GAP = 0.12;

async function embed(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'search_query: ' + text }),
  });
  const { embedding } = await res.json();
  let s = 0;
  for (const x of embedding) s += x * x;
  const n = Math.sqrt(s);
  return embedding.map((x) => x / n);
}

const db = new Database(process.argv[2], { readonly: true });
sqliteVec.load(db);

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const normCos = (d) => Math.max(0, Math.min(1, (d + 1) / 2));
const hamming = (a, b) => {
  let x = a ^ b, c = 0;
  while (x !== 0n) { x &= x - 1n; c++; }
  return c;
};

const rows = db
  .prepare(
    `SELECT e.image_id, e.embedding, i.filename, i.alt_text, i.phash FROM image_embeddings e
     INNER JOIN images i ON i.id = e.image_id WHERE i.is_trashed = 0`,
  )
  .all()
  .map((r) => ({
    id: r.image_id,
    alt: (r.alt_text || r.filename).slice(0, 50),
    vec: new Float32Array(Uint8Array.from(r.embedding).buffer),
    phash: r.phash ? Buffer.from(r.phash).readBigUInt64BE(0) : null,
  }));
console.log(`loaded ${rows.length} embedded images`);

// Report existing near-duplicate clusters in the library so dedupe results are interpretable.
let dupPairs = 0;
for (let i = 0; i < rows.length; i++)
  for (let j = i + 1; j < rows.length; j++)
    if (rows[i].phash !== null && rows[j].phash !== null && hamming(rows[i].phash, rows[j].phash) <= DEDUPE_MAX_HAMMING)
      dupPairs++;
console.log(`near-duplicate pairs in library (hamming ≤ ${DEDUPE_MAX_HAMMING}): ${dupPairs}\n`);

// Palette affinity, mirroring symmetricPaletteOverlap in natural-search.ts.
const paletteStmt = db.prepare('SELECT hex_color, percentage FROM image_colors WHERE image_id = ? ORDER BY sort_order LIMIT 14');
const paletteCache = new Map();
const getPalette = (id) => {
  if (!paletteCache.has(id)) paletteCache.set(id, paletteStmt.all(id));
  return paletteCache.get(id);
};
const hexRgb = (h) => {
  const c = h.trim().replace(/^#/, '');
  if (c.length !== 6) return null;
  const n = parseInt(c, 16);
  return Number.isNaN(n) ? null : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const rgbDist = (a, b) => Math.min(1, Math.hypot((a.r - b.r) / 255, (a.g - b.g) / 255, (a.b - b.b) / 255) / Math.sqrt(3));
function dirOverlap(from, to) {
  if (!from.length || !to.length) return null;
  const toRgbs = to.map((r) => ({ rgb: hexRgb(r.hex_color), pct: r.percentage })).filter((x) => x.rgb);
  if (!toRgbs.length) return null;
  let w = 0, tw = 0;
  for (const f of from) {
    const rgb = hexRgb(f.hex_color);
    if (!rgb) continue;
    let best = 0;
    for (const t of toRgbs) best = Math.max(best, 1 - rgbDist(rgb, t.rgb));
    w += best * f.percentage;
    tw += f.percentage;
  }
  return tw > 0 ? w / tw : null;
}
function paletteOverlap(idA, idB) {
  const ab = dirOverlap(getPalette(idA), getPalette(idB));
  const ba = dirOverlap(getPalette(idB), getPalette(idA));
  return ab == null || ba == null ? null : Math.min(ab, ba);
}

function selectBoardSet(survivors, limit) {
  if (survivors.length <= 1) return { picked: survivors.slice(0, limit), dropped: [], deduped: 0 };

  const deduped = [];
  for (const c of survivors) {
    const dup =
      c.phash !== null &&
      deduped.some((k) => k.phash !== null && hamming(c.phash, k.phash) <= DEDUPE_MAX_HAMMING);
    if (!dup) deduped.push(c);
  }
  const dedupedCount = survivors.length - deduped.length;
  if (deduped.length <= SEED_COUNT) return { picked: deduped.slice(0, limit), dropped: [], deduped: dedupedCount };

  const affinity = (a, b) => {
    const sem = normCos(dot(a.vec, b.vec));
    const vis = a.phash !== null && b.phash !== null ? Math.max(0, 1 - hamming(a.phash, b.phash) / 64) : sem;
    const pal = paletteOverlap(a.id, b.id);
    return 0.6 * sem + 0.2 * (pal ?? sem) + 0.2 * vis;
  };

  const picked = deduped.slice(0, SEED_COUNT);
  const rest = deduped.slice(SEED_COUNT);

  const seedAff = new Map(rest.map((c) => [c.id, Math.max(...picked.map((p) => affinity(c, p)))]));
  const sorted = [...seedAff.values()].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const gate = median - OUTLIER_AFFINITY_GAP;
  const dropped = rest.filter((c) => seedAff.get(c.id) < gate);
  const remaining = rest.filter((c) => seedAff.get(c.id) >= gate);

  while (picked.length < limit && remaining.length > 0) {
    let bi = 0, bs = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      let coh = 0;
      for (const p of picked) coh += affinity(remaining[i], p);
      coh /= picked.length;
      const score = remaining[i].semantic + COHESION_LAMBDA * coh;
      if (score > bs) { bs = score; bi = i; }
    }
    picked.push(remaining.splice(bi, 1)[0]);
  }
  return { picked, dropped, deduped: dedupedCount };
}

const PROMPTS = [
  'mobile app user interface design',
  'black and white minimal graphic design',
  'moody sunset landscapes with warm oranges and silhouetted trees',
  'minimal product photography on a plain background',
];

for (const prompt of PROMPTS) {
  const q = await embed(prompt);
  const scored = rows
    .map((r) => ({ ...r, semantic: dot(q, r.vec) }))
    .sort((a, b) => b.semantic - a.semantic);
  const floor = Math.max(ABS, scored[0].semantic - WIN);
  const survivors = scored.filter((c) => c.semantic >= floor);

  const before = survivors.slice(0, 24);
  const { picked, dropped, deduped } = selectBoardSet(survivors, 24);

  const beforeIds = new Set(before.map((c) => c.id));
  const added = picked.filter((c) => !beforeIds.has(c.id));
  const removed = before.filter((c) => !picked.some((p) => p.id === c.id));

  console.log('='.repeat(95));
  console.log(`"${prompt}"`);
  console.log(`  survivors=${survivors.length}  deduped=${deduped}  theme-pruned=${dropped.length}  board=${picked.length}`);
  for (const d of dropped.slice(0, 4)) console.log(`  pruned: ${d.semantic.toFixed(3)}  ${d.alt}`);
  for (const r of removed.filter((c) => !dropped.some((d) => d.id === c.id)).slice(0, 3))
    console.log(`  displaced by cohesion: ${r.semantic.toFixed(3)}  ${r.alt}`);
  for (const a of added.slice(0, 3)) console.log(`  pulled in: ${a.semantic.toFixed(3)}  ${a.alt}`);
  console.log(`  top6: ${picked.slice(0, 6).map((p) => p.alt.slice(0, 30)).join(' | ')}`);
}
