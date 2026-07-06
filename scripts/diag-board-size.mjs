/**
 * Stage-by-stage instrumentation of searchForMoodboard to find where board size collapses.
 * Mirrors production constants/logic exactly, printing counts after every stage.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/diag-board-size.mjs /tmp/muse-diag/library.db "prompt here"
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'qwen3-vl:8b-instruct';
const ABS = 0.62;
const WIN = 0.12;
const W_DIRECT = 0.65;
const W_HYDE = 0.35;
const LIMIT = 24;

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

async function hyde(brief, count = 3) {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: `You write alt-text captions for images in a design library.
A user is building a moodboard described as: "${brief}"

Write ${count} captions, each describing a DIFFERENT image that would fit this moodboard perfectly. Write in plain alt-text style: 1-2 sentences naming concrete subjects, setting, colors, and lighting. No preamble.

Respond with exactly ${count} lines, numbered like "1. ..."`,
      stream: false,
      options: { temperature: 0.7, num_predict: 260 },
    }),
  });
  const data = await res.json();
  return (data.response || '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, '').trim())
    .filter((l) => l.length >= 20 && l.length <= 400).slice(0, count);
}

async function parseIntent(brief) {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: `You parse moodboard briefs for a design-library image search.
Brief: "${brief}"

Decompose it. Rules:
- facets: the DISTINCT visual themes the user EXPLICITLY asks for, each a self-contained positive search phrase. Split ONLY on an explicit conjunction of different subjects ("X and Y", "X, Y"). A single theme = exactly 1 facet equal to the brief. NEVER invent variations or paraphrases of one theme. Never put a negation in facets.
- exclusions: the X from every explicit negation in the brief — "no X", "without X", "avoid X" — as short lowercase phrases (e.g. brief ends "..., no people" → exclusions ["people"]). Extract every negated X, but NEVER add anything the brief doesn't negate; no negations → empty array.
- colors: ONLY colors the brief itself mentions, each with a representative hex. No color words in the brief → empty array. monochrome=true only for black-and-white/grayscale briefs.`,
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

const rows = db
  .prepare(`SELECT e.image_id, e.embedding, i.alt_text, i.filename FROM image_embeddings e INNER JOIN images i ON i.id = e.image_id WHERE i.is_trashed = 0`)
  .all()
  .map((r) => ({ id: r.image_id, alt: (r.alt_text || r.filename).slice(0, 60), vec: new Float32Array(Uint8Array.from(r.embedding).buffer) }));

const textStmt = db.prepare(`
  SELECT i.alt_text || ' ' ||
    COALESCE((SELECT group_concat(t.name, ' ') FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id = i.id), '') AS txt
  FROM images i WHERE i.id = ?
`);

const prompt = process.argv[3] ?? 'mobile app user interface design';
console.log(`PROMPT: "${prompt}"  (library: ${rows.length} embedded)`);

const intent = await parseIntent(prompt);
console.log(`\n[intent] facets=${JSON.stringify(intent.facets)} exclusions=${JSON.stringify(intent.exclusions)} colors=${intent.colors?.length ?? 0} mono=${intent.monochrome}`);

const briefEnumerates = /(\band\b|\bor\b|,|\+|\/)/i.test(prompt);
const briefNegates = /\b(no|not|without|avoid|except|exclude|excluding)\b/i.test(prompt);
const facets = intent.facets?.length && briefEnumerates ? intent.facets : [prompt];
intent.exclusions = briefNegates ? intent.exclusions ?? [] : [];
console.log(`[guards] enumerates=${briefEnumerates} negates=${briefNegates} → facets=${facets.length} exclusions=${JSON.stringify(intent.exclusions)}`);
const perFacetLimit = facets.length > 1 ? Math.ceil((LIMIT * 1.5) / facets.length) : LIMIT;

const facetLists = [];
for (const facet of facets) {
  const direct = await embed(facet);
  const caps = await hyde(facet, 3);
  const capVecs = [];
  for (const c of caps) capVecs.push(await embed(c));

  const directScored = rows.map((r) => ({ ...r, dc: dot(direct, r.vec) })).sort((a, b) => b.dc - a.dc);
  console.log(`\n[facet "${facet}"]`);
  console.log(`  direct-only: top=${directScored[0].dc.toFixed(3)}  floor=${Math.max(ABS, directScored[0].dc - WIN).toFixed(3)}  pass=${directScored.filter((c) => c.dc >= Math.max(ABS, directScored[0].dc - WIN)).length}`);

  const blended = rows.map((r) => {
    const dc = dot(direct, r.vec);
    let best = -1;
    for (const cv of capVecs) best = Math.max(best, dot(cv, r.vec));
    return { ...r, semantic: capVecs.length && best > -1 ? W_DIRECT * dc + W_HYDE * best : dc };
  }).sort((a, b) => b.semantic - a.semantic);
  const floor = Math.max(ABS, blended[0].semantic - WIN);
  const pass = blended.filter((c) => c.semantic >= floor);
  console.log(`  HyDE-blended: top=${blended[0].semantic.toFixed(3)}  floor=${floor.toFixed(3)}  pass=${pass.length}  (perFacetLimit=${perFacetLimit})`);
  console.log(`  blended ranks 20-28: ${blended.slice(19, 28).map((c) => c.semantic.toFixed(3)).join(' ')}`);
  facetLists.push(pass.slice(0, perFacetLimit));
}

// round-robin merge
const seen = new Set();
let merged = [];
for (let i = 0; ; i++) {
  let any = false;
  for (const list of facetLists) if (i < list.length) { any = true; const c = list[i]; if (!seen.has(c.id)) { seen.add(c.id); merged.push(c); } }
  if (!any) break;
}
console.log(`\n[merge] ${merged.length}`);

const exclusions = intent.exclusions ?? [];
if (exclusions.length) {
  const before = merged.length;
  merged = merged.filter((c) => {
    const txt = (textStmt.get(c.id)?.txt || '').toLowerCase();
    return !exclusions.some((ex) => new RegExp(`\\b${ex.replace(/[^\w\s-]/g, '')}`, 'i').test(txt));
  });
  console.log(`[exclusions ${JSON.stringify(exclusions)}] ${before} -> ${merged.length}`);
}
console.log(`\nFINAL (pre set-selection): ${merged.length} of ${LIMIT} requested`);
