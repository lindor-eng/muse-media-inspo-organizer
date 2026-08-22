/**
 * End-to-end check of searchForMoodboard (HyDE expansion + similarity floor + color re-rank)
 * against a copy of the library that has ALREADY been re-embedded with document prefixes
 * (run verify-e2e-search.mjs on the copy first, or point at a post-migration library).
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/verify-moodboard.mjs /tmp/muse-e2e/library.db
 *
 * Mirrors the constants and logic in src/main/ai/natural-search.ts searchForMoodboard.
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const OLLAMA = 'http://127.0.0.1:11434';
const ABS = 0.62;
const WIN = 0.12;
const W_DIRECT = 0.65;
const W_HYDE = 0.35;
const COLOR_W = 0.16;

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

async function hyde(brief, count = 3) {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3-vl:8b-instruct',
      prompt: `You write alt-text captions for images in a design library.
A user is building a moodboard described as: "${brief}"

Write ${count} captions, each describing a DIFFERENT image that would fit this moodboard perfectly. Write in plain alt-text style: 1-2 sentences naming concrete subjects, setting, colors, and lighting. No preamble.

Respond with exactly ${count} lines, numbered like "1. ..."`,
      stream: false,
      options: { temperature: 0.7, num_predict: 260 },
    }),
  });
  const data = await res.json();
  return (data.response || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, '').trim())
    .filter((l) => l.length >= 20 && l.length <= 400)
    .slice(0, count);
}

// Minimal mirror of prompt-color.ts
const LEX = [
  { names: ['red', 'crimson', 'scarlet'], rgb: [220, 40, 40] },
  { names: ['orange', 'tangerine', 'amber', 'terracotta'], rgb: [240, 130, 40] },
  { names: ['yellow', 'golden', 'gold', 'mustard'], rgb: [235, 200, 50] },
  { names: ['green', 'emerald', 'olive', 'sage', 'mint'], rgb: [70, 160, 80] },
  { names: ['teal', 'turquoise', 'aqua', 'cyan'], rgb: [50, 180, 180] },
  { names: ['blue', 'navy', 'cobalt', 'azure', 'indigo'], rgb: [50, 100, 210] },
  { names: ['purple', 'violet', 'lavender', 'lilac'], rgb: [140, 80, 200] },
  { names: ['pink', 'rose', 'magenta', 'fuchsia', 'blush'], rgb: [230, 100, 170] },
  { names: ['brown', 'tan', 'beige', 'sepia', 'earthy'], rgb: [150, 105, 70] },
  { names: ['black'], rgb: [25, 25, 25] },
  { names: ['white', 'cream', 'ivory'], rgb: [240, 238, 232] },
  { names: ['gray', 'grey', 'silver'], rgb: [128, 128, 128] },
  { names: ['warm'], rgb: [230, 140, 60] },
  { names: ['cool'], rgb: [80, 120, 200] },
];
const MONO_RE = /\b(black[\s-]?and[\s-]?white|b&w|monochromes?|monochromatic|gr[ae]yscale)\b/gi;

function intentOf(prompt) {
  const mono = MONO_RE.test(prompt);
  MONO_RE.lastIndex = 0;
  const stripped = prompt.replace(MONO_RE, ' ');
  const targets = [];
  for (const e of LEX) {
    if (e.names.some((n) => new RegExp(`\\b${n}(?:s|es)?\\b`, 'i').test(stripped))) {
      targets.push({ rgb: { r: e.rgb[0], g: e.rgb[1], b: e.rgb[2] } });
    }
  }
  return { targets, mono };
}
const hexRgb = (h) => {
  const c = h.trim().replace(/^#/, '');
  if (c.length !== 6) return null;
  const n = parseInt(c, 16);
  return Number.isNaN(n) ? null : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const sim = (a, b) =>
  1 - Math.min(1, Math.hypot((a.r - b.r) / 255, (a.g - b.g) / 255, (a.b - b.b) / 255) / Math.sqrt(3));
function colorScore(intent, palette) {
  if (!palette.length) return null;
  if (intent.mono) {
    let ch = 0, w = 0;
    for (const p of palette) {
      const rgb = hexRgb(p.hex_color);
      if (!rgb) continue;
      const mx = Math.max(rgb.r, rgb.g, rgb.b), mn = Math.min(rgb.r, rgb.g, rgb.b);
      ch += (mx === 0 ? 0 : (mx - mn) / mx) * p.percentage;
      w += p.percentage;
    }
    if (w <= 0) return null;
    return 1 - Math.min(1, Math.max(0, (ch / w - 0.08) / 0.22));
  }
  if (!intent.targets.length) return null;
  let sum = 0;
  for (const t of intent.targets) {
    let cov = 0, tot = 0;
    for (const p of palette) {
      const rgb = hexRgb(p.hex_color);
      if (!rgb) continue;
      cov += Math.max(0, (sim(t.rgb, rgb) - 0.55) / 0.45) * p.percentage;
      tot += p.percentage;
    }
    sum += tot > 0 ? Math.min(1, cov / tot) : 0;
  }
  return sum / intent.targets.length;
}

const db = new Database(process.argv[2], { readonly: true });
sqliteVec.load(db);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const allEmb = db
  .prepare(
    `SELECT e.image_id, e.embedding, i.filename, i.alt_text FROM image_embeddings e
     INNER JOIN images i ON i.id = e.image_id WHERE i.is_trashed = 0`,
  )
  .all()
  .map((r) => {
    const bytes = Uint8Array.from(r.embedding);
    return { id: r.image_id, alt: (r.alt_text || '').slice(0, 55), vec: new Float32Array(bytes.buffer) };
  });
const paletteStmt = db.prepare(
  'SELECT hex_color, percentage FROM image_colors WHERE image_id = ? ORDER BY sort_order LIMIT 14',
);

const PROMPTS = [
  'moody sunset landscapes with warm oranges and silhouetted trees',
  'black and white minimal graphic design',
  'blue user interface designs',
  'mobile app user interface design',
];

for (const prompt of PROMPTS) {
  const t0 = Date.now();
  const direct = await embed(prompt);
  const caps = await hyde(prompt, 3);
  const capVecs = [];
  for (const c of caps) capVecs.push(await embed(c));

  const cands = allEmb.map((d) => {
    const dc = dot(direct, d.vec);
    let best = -1;
    for (const cv of capVecs) best = Math.max(best, dot(cv, d.vec));
    const semantic = capVecs.length && best > -1 ? W_DIRECT * dc + W_HYDE * best : dc;
    return { ...d, dc, semantic };
  }).sort((a, b) => b.semantic - a.semantic);

  const floor = Math.max(ABS, cands[0].semantic - WIN);
  let surv = cands.filter((c) => c.semantic >= floor);

  const intent = intentOf(prompt);
  const colorActive = intent.mono || intent.targets.length > 0;
  if (colorActive) {
    surv = surv
      .map((c) => {
        const cs = colorScore(intent, paletteStmt.all(c.id));
        return { ...c, semantic: c.semantic + (cs == null ? 0 : COLOR_W * (cs - 0.5)), cs };
      })
      .sort((a, b) => b.semantic - a.semantic);
  }

  console.log('='.repeat(90));
  console.log(`"${prompt}"  (${Date.now() - t0}ms, colorIntent=${colorActive ? (intent.mono ? 'mono' : intent.targets.length + ' targets') : 'none'})`);
  console.log(`  HyDE captions: ${caps.length ? '' : '(none — fell back to direct)'}`);
  for (const c of caps) console.log(`    • ${c.slice(0, 100)}`);
  console.log(`  kept ${surv.length} of 24 requested; top 8:`);
  for (const s of surv.slice(0, 8)) {
    console.log(
      `    sem=${s.semantic.toFixed(3)} direct=${s.dc.toFixed(3)}${s.cs != null ? ' color=' + s.cs.toFixed(2) : ''}  ${s.alt}`,
    );
  }
}
