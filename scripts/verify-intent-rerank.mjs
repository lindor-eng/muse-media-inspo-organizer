/**
 * End-to-end verify of intent parsing + facet round-robin + exclusion filter + vision
 * rerank against a re-embedded library copy (run verify-e2e-search.mjs on it first).
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/verify-intent-rerank.mjs /tmp/muse-e2e/library.db
 *
 * Mirrors src/main/ai/{ollama-client,natural-search}.ts production prompts/constants.
 * Vision rerank runs on a reduced band (5 calls) to keep the run short.
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import sharp from 'sharp';

const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'qwen3-vl:8b-instruct';
const ABS = 0.62;
const WIN = 0.12;

const db = new Database(process.argv[2], { readonly: true });
sqliteVec.load(db);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function embed(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'search_query: ' + text }),
  });
  const { embedding } = await res.json();
  let s = 0; for (const x of embedding) s += x * x; const n = Math.sqrt(s);
  return embedding.map((x) => x / n);
}

async function parseIntent(brief) {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: `You parse moodboard briefs for a design-library image search.
Brief: "${brief}"

Decompose it. Rules:
- facets: 1-3 DISTINCT visual themes the user WANTS, each a self-contained positive search phrase. Never put a negation ("no X", "without X") in facets. Only split when the brief genuinely asks for different kinds of images; a single coherent theme = 1 facet.
- exclusions: anything the brief says to AVOID — subjects ("people", "text") AND visual styles ("black and white", "screenshots") — as short lowercase phrases, one concept each. Empty if none.
- colors: named colors ONLY if the brief expresses color intent; each with a representative hex. monochrome=true only for black-and-white/grayscale briefs.`,
      stream: false,
      format: {
        type: 'object',
        properties: {
          facets: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          exclusions: { type: 'array', items: { type: 'string' } },
          colors: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, hex: { type: 'string' } }, required: ['name', 'hex'] } },
          monochrome: { type: 'boolean' },
        },
        required: ['facets', 'exclusions', 'colors', 'monochrome'],
      },
      options: { temperature: 0.2, num_predict: 300 },
    }),
  });
  const data = await res.json();
  return JSON.parse(data.response);
}

async function scoreFit(imagePath, brief, exclusions) {
  const buf = await sharp(imagePath).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  const excludeLine = exclusions.length ? `\nMust NOT contain: ${exclusions.join(', ')}` : '';
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: `You are judging whether an image belongs on a moodboard.
Moodboard brief: "${brief}"${excludeLine}

Score how well THIS image fits the brief, 0-10 (10 = perfect fit, 0 = unrelated or contains excluded content). Reason must be ONE short sentence, under 15 words.`,
      images: [buf.toString('base64')],
      stream: false,
      format: { type: 'object', properties: { score: { type: 'integer', minimum: 0, maximum: 10 }, reason: { type: 'string', maxLength: 120 } }, required: ['score', 'reason'] },
      options: { temperature: 0.1, num_predict: 220 },
    }),
  });
  const data = await res.json();
  try {
    return JSON.parse(data.response);
  } catch {
    const m = data.response.match(/"score"\s*:\s*(\d+)/);
    return { score: m ? Number(m[1]) : null, reason: '(truncated)' };
  }
}

const rows = db
  .prepare(`SELECT e.image_id, e.embedding, i.alt_text, i.filename, i.thumbnail_path, i.original_path FROM image_embeddings e INNER JOIN images i ON i.id = e.image_id WHERE i.is_trashed = 0`)
  .all()
  .map((r) => ({ id: r.image_id, alt: (r.alt_text || r.filename).slice(0, 55), path: r.thumbnail_path || r.original_path, vec: new Float32Array(Uint8Array.from(r.embedding).buffer) }));
const textStmt = db.prepare(`
  SELECT i.alt_text || ' ' || i.notes || ' ' ||
    COALESCE((SELECT group_concat(t.name, ' ') FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id = i.id), '') AS txt
  FROM images i WHERE i.id = ?
`);

async function facetSearch(facet, limit) {
  const q = await embed(facet);
  const scored = rows.map((r) => ({ ...r, semantic: dot(q, r.vec) })).sort((a, b) => b.semantic - a.semantic);
  const floor = Math.max(ABS, scored[0].semantic - WIN);
  return scored.filter((c) => c.semantic >= floor).slice(0, limit);
}

// ---- Test 1: multi-facet brief with exclusions ----
{
  const brief = 'user interface screenshots and nature landscape photography, no black and white images';
  console.log('='.repeat(95));
  console.log(`BRIEF: ${brief}`);
  const intent = await parseIntent(brief);
  console.log('intent:', JSON.stringify(intent));
  const facets = intent.facets?.length ? intent.facets : [brief];
  const perFacet = facets.length > 1 ? Math.ceil((24 * 1.5) / facets.length) : 24;
  const lists = [];
  for (const f of facets) lists.push(await facetSearch(f, perFacet));
  console.log(`facet result sizes: ${lists.map((l) => l.length).join(', ')}`);

  const seen = new Set();
  const merged = [];
  for (let i = 0; ; i++) {
    let any = false;
    for (const list of lists) if (i < list.length) { any = true; const c = list[i]; if (!seen.has(c.id)) { seen.add(c.id); merged.push(c); } }
    if (!any) break;
  }
  const exclusions = intent.exclusions ?? [];
  const filtered = merged.filter((c) => {
    const txt = (textStmt.get(c.id)?.txt || '').toLowerCase();
    return !exclusions.some((ex) => new RegExp(`\\b${ex.replace(/[^\w\s-]/g, '')}`, 'i').test(txt));
  });
  console.log(`merged=${merged.length} after-exclusions=${filtered.length} (removed ${merged.length - filtered.length})`);
  console.log('board top 10 (interleaved):');
  for (const c of filtered.slice(0, 10)) console.log(`  ${c.semantic.toFixed(3)}  ${c.alt}`);
}

// ---- Test 2: vision rerank drops a planted off-theme image ----
{
  const brief = 'mobile app user interface design';
  console.log('='.repeat(95));
  console.log(`VISION RERANK: "${brief}" — band of 4 weakest + 1 planted photo`);
  const survivors = await facetSearch(brief, 24);
  // Plant the guitarist photo (clearly off-theme) as if it had sneaked past the floor.
  const guitarist = rows.find((r) => /guitar/i.test(r.alt) && r.path);
  if (!guitarist) throw new Error('no guitarist image found to plant');
  const band = [...survivors.slice(-4), { ...guitarist, semantic: 0.63 }];
  for (const c of band) {
    const t0 = Date.now();
    const { score, reason } = await scoreFit(c.path, brief, []);
    console.log(`  score=${score} (${((Date.now() - t0) / 1000).toFixed(1)}s) keep=${score >= 5} ${c.alt}`);
    if (score < 5) console.log(`    reason: ${reason.slice(0, 100)}`);
  }
}
