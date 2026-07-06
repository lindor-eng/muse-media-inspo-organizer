import type Database from 'better-sqlite3';
import { createImageRepo, type ImageRecord as DbImageRecord } from '../database/repositories/images';
import { blobToFloat32Vector, ensureImageEmbedding, embedAndStoreForImage, l2Normalize } from './embeddings';
import {
  embedQuery,
  generateHypotheticalCaptions,
  isOllamaRunning,
  parseMoodboardIntent,
  scoreImageFit,
} from './ollama-client';
import { colorIntentFromParsed, extractColorIntent, paletteIntentScore } from './prompt-color';
import { phashSimilarity, phashHamming, blobToPhash, computePHash, phashToBlob } from './phash';
import { likenessDisplayPercentRounded } from '../../shared/visual-similarity';
import { dominantHueAxisMultiplier, dualDominantHueBoost, hueBinRingSteps } from '../../shared/image-color-index';
import { persistThumbColorIndex, extractAndStoreColors } from '../color-extractor';
import type { SimilarRefineMode } from '../../shared/similar-refine';
import {
  loadSimilarityPrefs,
  MATCH_STRENGTH_TO_MIN_COSINE,
  type MatchStrengthTier,
} from '../database/similarity-prefs';

export interface SimilarResult {
  image_id: string;
  distance: number;
}

export interface VisualSimilarItem {
  similarity: number;
  image: {
    id: string;
    filename: string;
    original_path: string;
    thumbnail_path: string | null;
    title: string;
    notes: string;
    source_url: string;
    width: number | null;
    height: number | null;
    file_size: number | null;
    file_type: string | null;
    is_trashed: number;
    folder_id: string | null;
    imported_at: string;
  };
}

export interface SimilarMatchesResponse {
  matches: VisualSimilarItem[];
  emptyHint?: 'ollama_unavailable' | 'embedding_failed' | 'needs_other_indexed_images' | 'similarity_below_threshold';
  meta?: {
    sourceHadEmbeddingBefore: boolean;
    peerCandidatesWithEmbedding: number;
    similarityFloor: MatchStrengthTier | null;
    minCosine: number;
    maxResultsRequested: number;
    refineModesApplied?: SimilarRefineMode[];
  };
}

export interface FindSimilarOptions {
  refineModes?: SimilarRefineMode[];
}

/** Score weights when combining caption embedding cosine, pHash similarity, and palette overlap. */
const W_CAPTION = 0.6;
const W_PHASH = 0.15;
const W_COLOR_BASELINE = 0.25;
/** When refine=colors is active, palette dominates. */
const W_COLOR_REFINE = 0.7;
const W_CAPTION_REFINE = 0.25;
const W_PHASH_REFINE = 0.05;

/** Min symmetric palette overlap to keep when refine=colors. */
const PALETTE_COMPOSITION_GATE = 0.42;
const FOCAL_MONOCHROME_MAX_CHROMA = 0.11;
const REFINE_POOL_CAP = 520;

type PaletteRow = { hex_color: string; percentage: number };

function hexToRgb(hexRaw: string): { r: number; g: number; b: number } | null {
  const cleaned = hexRaw.trim().replace(/^#/, '').replace(/^0x/i, '');
  if (cleaned.length !== 6) return null;
  const n = parseInt(cleaned, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbDistNorm(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const dr = (a.r - b.r) / 255;
  const dg = (a.g - b.g) / 255;
  const db = (a.b - b.b) / 255;
  const dist = Math.sqrt(dr * dr + dg * dg + db * db);
  return Math.min(1, dist / Math.sqrt(3));
}

function directionalPaletteOverlap(from: PaletteRow[], to: PaletteRow[]): number | null {
  if (from.length === 0 || to.length === 0) return null;
  const toRgbs = to.map((r) => ({ rgb: hexToRgb(r.hex_color), pct: r.percentage })).filter((x): x is { rgb: { r: number; g: number; b: number }; pct: number } => x.rgb !== null);
  if (toRgbs.length === 0) return null;
  let weighted = 0;
  let totalWeight = 0;
  for (const f of from) {
    const fromRgb = hexToRgb(f.hex_color);
    if (!fromRgb) continue;
    let bestMatch = 0;
    for (const t of toRgbs) {
      const sim = 1 - rgbDistNorm(fromRgb, t.rgb);
      if (sim > bestMatch) bestMatch = sim;
    }
    weighted += bestMatch * f.percentage;
    totalWeight += f.percentage;
  }
  if (totalWeight <= 0) return null;
  return weighted / totalWeight;
}

function symmetricPaletteOverlap(a: PaletteRow[], b: PaletteRow[]): number | null {
  const ab = directionalPaletteOverlap(a, b);
  const ba = directionalPaletteOverlap(b, a);
  if (ab == null || ba == null) return null;
  return Math.min(ab, ba);
}

function rgbChromaticity(rgb: { r: number; g: number; b: number }): number {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  if (max === 0) return 0;
  return (max - min) / max;
}

function weightedPaletteChroma(rows: PaletteRow[]): number | null {
  if (rows.length === 0) return null;
  let chrom = 0;
  let weight = 0;
  for (const r of rows) {
    const rgb = hexToRgb(r.hex_color);
    if (!rgb) continue;
    chrom += rgbChromaticity(rgb) * r.percentage;
    weight += r.percentage;
  }
  if (weight <= 0) return null;
  return chrom / weight;
}

/** Cosine similarity of L2-normalized vectors equals dot product. */
function dotNormalized(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  if (b.length !== n) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** Map dot product on normalized vectors (-1..1) → 0..1 likeness. */
function normCosine(dot: number): number {
  return Math.max(0, Math.min(1, (dot + 1) / 2));
}

function previewFromRecord(r: DbImageRecord | undefined): VisualSimilarItem['image'] | null {
  if (!r) return null;
  return {
    id: r.id,
    filename: r.filename,
    original_path: r.original_path,
    thumbnail_path: r.thumbnail_path,
    title: r.title,
    notes: r.notes,
    source_url: r.source_url,
    width: r.width,
    height: r.height,
    file_size: r.file_size,
    file_type: r.file_type,
    is_trashed: r.is_trashed,
    folder_id: r.folder_id,
    imported_at: r.imported_at,
  };
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function rankByEmbeddingBrute(
  db: Database.Database,
  queryVec: Float32Array,
  limit: number,
  excludeImageId: string | null,
): Promise<Array<{ image_id: string; similarity: number }>> {
  const stmt = excludeImageId
    ? `
      SELECT e.image_id, e.embedding
      FROM image_embeddings e
      INNER JOIN images i ON i.id = e.image_id
      WHERE i.is_trashed = 0 AND e.image_id != ?
    `
    : `
      SELECT e.image_id, e.embedding
      FROM image_embeddings e
      INNER JOIN images i ON i.id = e.image_id
      WHERE i.is_trashed = 0
    `;

  const rows = (
    excludeImageId
      ? db.prepare(stmt).all(excludeImageId)
      : db.prepare(stmt).all()
  ) as Array<{ image_id: string; embedding: Buffer }>;

  const hits: Array<{ image_id: string; similarity: number }> = [];
  let processed = 0;

  for (const r of rows) {
    const v = blobToFloat32Vector(Buffer.from(r.embedding));
    const sim = dotNormalized(queryVec, v);
    processed++;
    if (!Number.isFinite(sim)) continue;
    hits.push({ image_id: r.image_id, similarity: sim });
    if (processed % 96 === 0) await yieldToEventLoop();
  }

  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, limit);
}

async function searchByEmbedding(
  db: Database.Database,
  embedding: number[],
  limit: number,
): Promise<Array<{ image_id: string; cosine: number }>> {
  const queryVec = Float32Array.from(embedding);

  try {
    // The vec0 KNN can't join against images, so trashed/orphaned embedding rows would
    // consume result slots — over-fetch by exactly that many, filter, then cut to `limit`.
    const deadRows = (
      db
        .prepare(
          `
      SELECT COUNT(*) AS c
      FROM image_embeddings e
      LEFT JOIN images i ON i.id = e.image_id
      WHERE i.id IS NULL OR i.is_trashed != 0
    `,
        )
        .get() as { c: number }
    ).c;

    const knn = db
      .prepare(
        `
      SELECT image_id, distance
      FROM image_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `,
      )
      .all(JSON.stringify(embedding), limit + deadRows) as Array<{ image_id: string; distance: number }>;

    const imageRepo = createImageRepo(db);
    const out: Array<{ image_id: string; cosine: number }> = [];
    for (const row of knn) {
      const img = imageRepo.getById(row.image_id);
      if (!img || img.is_trashed !== 0) continue;
      // vec0 reports L2 distance; on unit vectors d² = 2 − 2·cos.
      const d = Number(row.distance);
      out.push({ image_id: row.image_id, cosine: 1 - (d * d) / 2 });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    const ranked = await rankByEmbeddingBrute(db, queryVec, limit, null);
    return ranked.map(({ image_id, similarity }) => ({ image_id, cosine: similarity }));
  }
}

/**
 * Floors for prompt→library search in curated mode (moodboard). The absolute floor rejects
 * matches that are semantically unrelated outright; the relative window trims the weak tail
 * once the prompt has strong matches. On prefixed nomic-embed-text vectors, unrelated
 * caption text sits around cosine 0.5–0.6 and genuine matches at 0.65+. Calibrated against
 * a real library — see scripts/simulate-floor.mjs.
 */
const TEXT_SEARCH_ABS_MIN_COSINE = 0.62;
const TEXT_SEARCH_RELATIVE_WINDOW = 0.1;

export interface TextSearchOptions {
  /** Curated mode: drop weak-tail matches instead of padding out to `limit`. */
  applySimilarityFloor?: boolean;
}

export async function searchByText(
  db: Database.Database,
  query: string,
  limit = 20,
  options?: TextSearchOptions,
): Promise<SimilarResult[]> {
  if (!(await isOllamaRunning())) return [];
  const embedding = await embedQuery(query);
  if (!embedding?.length) return [];
  let hits = await searchByEmbedding(db, l2Normalize(embedding), limit);
  if (options?.applySimilarityFloor && hits.length > 0) {
    const floor = Math.max(TEXT_SEARCH_ABS_MIN_COSINE, hits[0].cosine - TEXT_SEARCH_RELATIVE_WINDOW);
    hits = hits.filter((h) => h.cosine >= floor);
  }
  return hits.map((h) => ({ image_id: h.image_id, distance: 1 - h.cosine }));
}

/** Blend weights for moodboard semantic scoring: the user's literal prompt stays dominant;
    hypothetical captions bridge the brief→caption vocabulary gap. */
const MOODBOARD_W_DIRECT = 0.65;
const MOODBOARD_W_HYDE = 0.35;
/** Palette agreement can shift ranking by ±half this weight around the 0.5 neutral point. */
const MOODBOARD_COLOR_WEIGHT = 0.16;
/** Slightly wider than the plain-search window: the HyDE blend lifts top scores, which would
    otherwise drag the relative floor up and cut marginal-but-on-theme matches. */
const MOODBOARD_RELATIVE_WINDOW = 0.12;

export interface MoodboardSearchOptions {
  /** High-accuracy mode: vision model visually verifies borderline candidates (~3-5s each). */
  visionRerank?: boolean;
  /** Progress callback for the long-running vision pass. */
  onProgress?: (p: { stage: 'analyzing' | 'searching' | 'verifying'; current?: number; total?: number }) => void;
}

/** Vision rerank keeps: score ≥ this stays on the board. */
const VISION_KEEP_SCORE = 5;
/** Cap on vision calls per moodboard — bounds worst-case latency to ~1-2 min. */
const VISION_MAX_CALLS = 20;
/** Fraction of the final board (from the bottom) treated as the uncertainty band. */
const VISION_BAND_FRACTION = 0.5;

/**
 * Prompt→library search tuned for moodboard curation:
 *  1. Parse the brief into intent (facets / exclusions / colors) via structured LLM output;
 *     fall back to whole-brief + regex color detection when parsing fails.
 *  2. Per facet: embed directly + HyDE captions, union KNN pools, blend cosines.
 *     Multi-facet briefs interleave facets round-robin so each theme gets board share.
 *  3. Floor the weak tail (calibrated absolute + relative floor, per facet).
 *  4. Exclusion keyword filter against captions/tags, then color re-rank vs stored palettes.
 *  5. Set selection: pHash dedupe + MMR cohesion + outlier pruning (selectBoardSet).
 *  6. Optional vision rerank: the model looks at borderline thumbnails and drops misfits.
 */
export async function searchForMoodboard(
  db: Database.Database,
  prompt: string,
  limit = 24,
  options?: MoodboardSearchOptions,
): Promise<SimilarResult[]> {
  if (!(await isOllamaRunning())) return [];
  const onProgress = options?.onProgress ?? (() => {});

  onProgress({ stage: 'analyzing' });
  const intent = await parseMoodboardIntent(prompt);

  // Guard against intent hallucination: facet-splitting is only trustworthy when the brief
  // actually enumerates multiple themes; exclusions only when it actually negates something.
  // A hallucinated facet split dilutes retrieval; hallucinated exclusions can gut the board.
  const briefEnumerates = /(\band\b|\bor\b|,|\+|\/)/i.test(prompt);
  const briefNegates = /\b(no|not|without|avoid|except|exclude|excluding)\b/i.test(prompt);
  const facets = intent?.facets?.length && briefEnumerates ? intent.facets : [prompt];
  const exclusions = briefNegates ? intent?.exclusions ?? [] : [];

  onProgress({ stage: 'searching' });
  const perFacetLimit = facets.length > 1 ? Math.ceil((limit * 1.5) / facets.length) : limit;
  const facetResults: BoardCandidate[][] = [];
  for (const facet of facets) {
    facetResults.push(await searchFacet(db, facet, perFacetLimit));
  }

  // Round-robin interleave so "brutalist posters AND landscape photography" fills the board
  // with both themes instead of whichever facet scores higher cosines.
  const seen = new Set<string>();
  let survivors: BoardCandidate[] = [];
  for (let i = 0; ; i++) {
    let any = false;
    for (const list of facetResults) {
      if (i < list.length) {
        any = true;
        if (!seen.has(list[i].image_id)) {
          seen.add(list[i].image_id);
          survivors.push(list[i]);
        }
      }
    }
    if (!any) break;
  }
  if (survivors.length === 0) return [];

  // Lexical exclusion filter: cheap first line of defense; the vision pass catches the rest.
  // Matches alt text + tags only — the verbose notes mention nearly everything ("text",
  // "screenshot"…) and would wipe out whole boards on incidental vocabulary.
  if (exclusions.length > 0) {
    const textStmt = db.prepare(`
      SELECT i.alt_text || ' ' ||
        COALESCE((SELECT group_concat(t.name, ' ') FROM tags t
                  JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id = i.id), '') AS txt
      FROM images i WHERE i.id = ?
    `);
    survivors = survivors.filter((c) => {
      const row = textStmt.get(c.image_id) as { txt: string } | undefined;
      if (!row?.txt) return true;
      const txt = row.txt.toLowerCase();
      return !exclusions.some((ex) => new RegExp(`\\b${ex.replace(/[^\w\s-]/g, '')}`, 'i').test(txt));
    });
  }

  // Color re-rank vs stored palettes. LLM-parsed colors handle "pastel"/"dusty pink"/etc.;
  // regex lexicon remains the fallback when intent parsing failed.
  const colorIntent = intent
    ? colorIntentFromParsed(intent.colors, intent.monochrome)
    : extractColorIntent(prompt);
  if (colorIntent.wantsMonochrome || colorIntent.targets.length > 0) {
    const paletteStmt = db.prepare(
      'SELECT hex_color, percentage FROM image_colors WHERE image_id = ? ORDER BY sort_order LIMIT 14',
    );
    survivors = survivors
      .map((c) => {
        const palette = paletteStmt.all(c.image_id) as Array<{ hex_color: string; percentage: number }>;
        const colorScore = paletteIntentScore(colorIntent, palette);
        const adjust = colorScore == null ? 0 : MOODBOARD_COLOR_WEIGHT * (colorScore - 0.5);
        return { ...c, semantic: c.semantic + adjust };
      })
      .sort((a, b) => b.semantic - a.semantic);
  } else if (facets.length === 1) {
    survivors.sort((a, b) => b.semantic - a.semantic);
  }
  // Multi-facet without color intent keeps the interleaved order (board share per theme).

  let board = selectBoardSet(db, survivors, limit);

  // Vision rerank: eyeball the uncertainty band (weakest semantic scores on the board),
  // drop misfits, backfill from unpicked survivors — all within a hard call budget.
  if (options?.visionRerank && board.length > 0) {
    board = await visionRerankBoard(db, board, survivors, prompt, exclusions, limit, onProgress);
  }

  return board.map((c) => ({ image_id: c.image_id, distance: 1 - c.semantic }));
}

/** Single-facet retrieval: direct + HyDE embeddings → union KNN → blended cosine → floor. */
async function searchFacet(
  db: Database.Database,
  facet: string,
  limit: number,
): Promise<BoardCandidate[]> {
  const directRaw = await embedQuery(facet);
  if (!directRaw?.length) return [];
  const direct = Float32Array.from(l2Normalize(directRaw));

  const captions = await generateHypotheticalCaptions(facet, 3);
  const capVecs: Float32Array[] = [];
  for (const cap of captions) {
    const v = await embedQuery(cap);
    if (v?.length === directRaw.length) capVecs.push(Float32Array.from(l2Normalize(v)));
  }

  // Union of per-vector KNN pools; over-fetch so the blend can reorder freely.
  const poolSize = Math.min(200, Math.max(limit * 3, limit + 16));
  const pool = new Set<string>();
  for (const vec of [direct, ...capVecs]) {
    const hits = await searchByEmbedding(db, Array.from(vec), poolSize);
    for (const h of hits) pool.add(h.image_id);
  }
  if (pool.size === 0) return [];

  // Exact cosines for every union member against every query vector, from stored blobs.
  // Doc vectors are retained on the candidate for the set-selection cohesion pass.
  const embStmt = db.prepare('SELECT embedding FROM image_embeddings WHERE image_id = ?');
  const cands: BoardCandidate[] = [];
  for (const id of pool) {
    const row = embStmt.get(id) as { embedding: Buffer } | undefined;
    if (!row) continue;
    const docVec = blobToFloat32Vector(Buffer.from(row.embedding));
    const directCos = dotNormalized(direct, docVec);
    if (!Number.isFinite(directCos)) continue;
    let bestCap = -1;
    for (const cv of capVecs) {
      const c = dotNormalized(cv, docVec);
      if (Number.isFinite(c) && c > bestCap) bestCap = c;
    }
    const semantic =
      capVecs.length > 0 && bestCap > -1
        ? MOODBOARD_W_DIRECT * directCos + MOODBOARD_W_HYDE * bestCap
        : directCos;
    cands.push({ image_id: id, semantic, vec: docVec });
  }
  if (cands.length === 0) return [];

  cands.sort((a, b) => b.semantic - a.semantic);
  const floor = Math.max(TEXT_SEARCH_ABS_MIN_COSINE, cands[0].semantic - MOODBOARD_RELATIVE_WINDOW);
  return cands.filter((c) => c.semantic >= floor);
}

/**
 * Visually verify the board's uncertainty band: the top of the board is trusted, the
 * weakest-scoring picks get shown to the vision model. Failures are replaced from the
 * unpicked survivor pool (each replacement verified too). Fail-open — a scoring error
 * keeps the image rather than shrinking the board on infrastructure hiccups.
 */
async function visionRerankBoard(
  db: Database.Database,
  board: BoardCandidate[],
  survivors: BoardCandidate[],
  prompt: string,
  exclusions: string[],
  limit: number,
  onProgress: NonNullable<MoodboardSearchOptions['onProgress']>,
): Promise<BoardCandidate[]> {
  const pathStmt = db.prepare('SELECT thumbnail_path, original_path FROM images WHERE id = ?');
  const imagePathOf = (id: string): string | null => {
    const row = pathStmt.get(id) as { thumbnail_path: string | null; original_path: string } | undefined;
    return row ? row.thumbnail_path || row.original_path : null;
  };

  const byScore = [...board].sort((a, b) => b.semantic - a.semantic);
  const bandSize = Math.min(Math.ceil(board.length * VISION_BAND_FRACTION), VISION_MAX_CALLS);
  const trusted = byScore.slice(0, board.length - bandSize);
  const band = byScore.slice(board.length - bandSize);

  const onBoard = new Set(board.map((c) => c.image_id));
  const backfillQueue = survivors.filter((c) => !onBoard.has(c.image_id));

  const kept: BoardCandidate[] = [...trusted];
  let calls = 0;
  const total = band.length;
  let done = 0;

  const verify = async (cand: BoardCandidate): Promise<boolean> => {
    const p = imagePathOf(cand.image_id);
    if (!p) return false;
    calls++;
    const score = await scoreImageFit(p, prompt, exclusions);
    return score === null || score >= VISION_KEEP_SCORE;
  };

  for (const cand of band) {
    onProgress({ stage: 'verifying', current: ++done, total });
    if (calls >= VISION_MAX_CALLS) {
      kept.push(cand); // budget exhausted — keep unverified rather than shrink the board
      continue;
    }
    if (await verify(cand)) {
      kept.push(cand);
      continue;
    }
    // Dropped — try to backfill with the next unpicked survivor that passes.
    while (calls < VISION_MAX_CALLS && backfillQueue.length > 0 && kept.length < limit) {
      const next = backfillQueue.shift()!;
      if (await verify(next)) {
        kept.push(next);
        break;
      }
    }
  }

  return kept.slice(0, limit);
}

interface BoardCandidate {
  image_id: string;
  semantic: number;
  /** Stored caption embedding (unit-norm) — reused for candidate↔candidate cohesion. */
  vec: Float32Array;
}

/** pHash Hamming distance at or below this = same shot for board purposes (near-duplicate). */
const DEDUPE_MAX_HAMMING = 6;
/** Board selection = relevance-heavy MMR: score + λ·cohesion-with-picked-so-far. */
const COHESION_LAMBDA = 0.3;
/** Seed the board with the top matches before cohesion starts steering picks. */
const SEED_COUNT = 3;
/** An image whose best affinity to the seeds is this far below the pool's median doesn't
    belong to the theme — prune it even though it passed the semantic floor. */
const OUTLIER_AFFINITY_GAP = 0.12;

/**
 * Pick the final board as a SET instead of the top-N independent matches:
 *  1. Near-duplicate dedupe — cluster by pHash Hamming distance, keep the best-scoring
 *     representative so five takes of one shot don't fill five slots.
 *  2. Greedy MMR-style growth — seed with the strongest matches, then repeatedly add the
 *     candidate with the best (semantic score + cohesion with the board so far), where
 *     cohesion blends caption-embedding cosine with pHash visual similarity.
 *  3. Outlier pruning — candidates whose affinity to the seed theme falls far below the
 *     pool median get dropped: they matched the words but not the board.
 * Pure in-memory math over stored vectors/hashes — no model calls, O(n²) on ≤~200 rows.
 */
function selectBoardSet(
  db: Database.Database,
  survivors: BoardCandidate[],
  limit: number,
): BoardCandidate[] {
  if (survivors.length <= 1) return survivors.slice(0, limit);

  const phashStmt = db.prepare('SELECT phash FROM images WHERE id = ?');
  const hashes = new Map<string, bigint | null>();
  for (const c of survivors) {
    const row = phashStmt.get(c.image_id) as { phash: Buffer | null } | undefined;
    hashes.set(c.image_id, row?.phash ? blobToPhash(Buffer.from(row.phash)) : null);
  }

  const boardPaletteStmt = db.prepare(
    'SELECT hex_color, percentage FROM image_colors WHERE image_id = ? ORDER BY sort_order LIMIT 14',
  );
  const palettes = new Map<string, PaletteRow[]>();
  for (const c of survivors) {
    palettes.set(c.image_id, boardPaletteStmt.all(c.image_id) as PaletteRow[]);
  }

  // 1. Dedupe near-identical shots. Survivors are score-ordered, so the first member of
  // each cluster is its best representative.
  const deduped: BoardCandidate[] = [];
  for (const c of survivors) {
    const h = hashes.get(c.image_id) ?? null;
    const dup =
      h !== null &&
      deduped.some((kept) => {
        const kh = hashes.get(kept.image_id) ?? null;
        return kh !== null && phashHamming(h, kh) <= DEDUPE_MAX_HAMMING;
      });
    if (!dup) deduped.push(c);
  }
  if (deduped.length <= SEED_COUNT) return deduped.slice(0, limit);

  // Pairwise affinity: semantic (do the captions describe the same world?), palette (do
  // they share a color story? — the signal humans judge board coherence by first), and a
  // small pHash nudge (near-identical layout). Missing signals fall back to semantic so a
  // palette-less pair degrades to the old 80/20 blend instead of being penalized.
  const affinity = (a: BoardCandidate, b: BoardCandidate): number => {
    const sem = normCosine(dotNormalized(a.vec, b.vec));
    const ha = hashes.get(a.image_id) ?? null;
    const hb = hashes.get(b.image_id) ?? null;
    const vis = ha !== null && hb !== null ? phashSimilarity(phashHamming(ha, hb)) : sem;
    const pal = symmetricPaletteOverlap(palettes.get(a.image_id) ?? [], palettes.get(b.image_id) ?? []);
    return 0.6 * sem + 0.2 * (pal ?? sem) + 0.2 * vis;
  };

  // 2. Greedy growth from the strongest seeds.
  const picked = deduped.slice(0, SEED_COUNT);
  const rest = deduped.slice(SEED_COUNT);

  // 3. Theme gate, relative to the pool itself: how well does each remaining candidate
  // attach to the seeds, compared to what's typical for this prompt?
  const seedAffinity = new Map<string, number>();
  for (const c of rest) {
    seedAffinity.set(c.image_id, Math.max(...picked.map((p) => affinity(c, p))));
  }
  const sortedAff = [...seedAffinity.values()].sort((a, b) => a - b);
  const medianAff = sortedAff[Math.floor(sortedAff.length / 2)] ?? 0;
  const themeGate = medianAff - OUTLIER_AFFINITY_GAP;

  const remaining = rest.filter((c) => (seedAffinity.get(c.image_id) ?? 0) >= themeGate);

  while (picked.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let coh = 0;
      for (const p of picked) coh += affinity(c, p);
      coh /= picked.length;
      const score = c.semantic + COHESION_LAMBDA * coh;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    picked.push(remaining.splice(bestIdx, 1)[0]);
  }

  return picked;
}

/**
 * Find visually/semantically similar images for a given image.
 * Combines:
 *  - caption-text embedding cosine (semantic)
 *  - pHash Hamming similarity (visual)
 *  - palette overlap + hue agreement (chromatic)
 */
export async function findSimilarImagesWithPreviews(
  db: Database.Database,
  imageId: string,
  options?: FindSimilarOptions,
): Promise<SimilarMatchesResponse> {
  const refineModes = options?.refineModes?.filter((m) => m === 'colors') ?? [];
  const prefs = loadSimilarityPrefs(db);
  const limit = prefs.maxResults;
  const hadEmbeddingAlready = Boolean(db.prepare('SELECT 1 FROM image_embeddings WHERE image_id = ?').get(imageId));

  if (!(await isOllamaRunning())) {
    return { matches: [], emptyHint: 'ollama_unavailable' };
  }

  const ensured = await ensureImageEmbedding(db, imageId).catch(() => false);
  if (!ensured) {
    return { matches: [], emptyHint: 'embedding_failed' };
  }

  const row = db.prepare('SELECT embedding FROM image_embeddings WHERE image_id = ?').get(imageId) as
    | { embedding: Buffer }
    | undefined;
  if (!row) {
    return { matches: [], emptyHint: 'embedding_failed' };
  }

  const peerRow = db
    .prepare(
      `
    SELECT COUNT(*) as c FROM image_embeddings e
    INNER JOIN images i ON i.id = e.image_id
    WHERE i.is_trashed = 0 AND e.image_id != ?
  `,
    )
    .get(imageId) as { c: number };

  const refineModesSole = refineModes.slice(0, 1);
  const colorsRefine = refineModesSole[0] === 'colors';

  const metaPayload = {
    sourceHadEmbeddingBefore: hadEmbeddingAlready,
    peerCandidatesWithEmbedding: peerRow?.c ?? 0,
    similarityFloor: prefs.similarityFloor,
    minCosine: prefs.minCosine,
    maxResultsRequested: limit,
    ...(refineModesSole.length > 0 ? { refineModesApplied: [...refineModesSole] } : {}),
  } satisfies SimilarMatchesResponse['meta'];

  if (!peerRow || peerRow.c < 1) {
    return { matches: [], emptyHint: 'needs_other_indexed_images', meta: metaPayload };
  }

  const queryVec = blobToFloat32Vector(Buffer.from(row.embedding));

  const neighborPrefetchCap = colorsRefine
    ? Math.min(Math.max(peerRow.c + 200, REFINE_POOL_CAP), 4000)
    : prefs.similarityFloor !== null
      ? Math.min(800, Math.max(limit + 64, limit * 12))
      : Math.max(limit * 6, limit + 32);

  let ranked: Array<{ image_id: string; similarity: number }> = [];
  try {
    const knn = db
      .prepare(
        `
      SELECT image_id, distance
      FROM image_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `,
      )
      .all(JSON.stringify(Array.from(queryVec)), neighborPrefetchCap) as Array<{ image_id: string; distance: number }>;
    ranked = knn
      .filter((r) => r.image_id !== imageId)
      .map((r) => ({ image_id: r.image_id, similarity: Math.max(-1, 1 - Number(r.distance)) }));
    if (ranked.length === 0) throw new Error('knn-empty');
  } catch {
    ranked = await rankByEmbeddingBrute(db, queryVec, neighborPrefetchCap, imageId);
  }

  const imageRepo = createImageRepo(db);
  const floorForDisplay =
    prefs.similarityFloor !== null ? MATCH_STRENGTH_TO_MIN_COSINE[prefs.similarityFloor] : null;

  const srcRecord = imageRepo.getById(imageId);
  if (!srcRecord) {
    return { matches: [], emptyHint: 'embedding_failed', meta: metaPayload };
  }

  const srcPhash: bigint | null = srcRecord.phash ? blobToPhash(Buffer.from(srcRecord.phash)) : null;

  const paletteStmt = db.prepare(
    'SELECT hex_color, percentage FROM image_colors WHERE image_id = ? ORDER BY sort_order LIMIT 14',
  );
  let srcPalette = paletteStmt.all(imageId) as PaletteRow[];
  // Lazy-backfill the focal image's palette so colors-refine has something to compare against.
  // Without this, libraries imported pre-colors-feature silently degrade to caption-only ranking.
  if (colorsRefine && srcPalette.length === 0 && srcRecord.thumbnail_path) {
    try {
      await extractAndStoreColors(db, imageId, srcRecord.thumbnail_path);
      srcPalette = paletteStmt.all(imageId) as PaletteRow[];
    } catch {
      // Non-critical; fall through with empty palette and the colors-refine block becomes a no-op.
    }
  }

  let focalHueBucket: number | null =
    typeof srcRecord.indexed_hue_bucket === 'number' ? srcRecord.indexed_hue_bucket : null;
  let focalHueStrength: number | null =
    typeof srcRecord.indexed_hue_strength === 'number' ? srcRecord.indexed_hue_strength : null;
  let focalHueBucket2: number | null =
    typeof srcRecord.indexed_hue_bucket_2 === 'number' ? srcRecord.indexed_hue_bucket_2 : null;
  let focalHueStrength2: number | null =
    typeof srcRecord.indexed_hue_strength_2 === 'number' ? srcRecord.indexed_hue_strength_2 : null;

  if (
    colorsRefine &&
    srcRecord.thumbnail_path &&
    (focalHueBucket === null || focalHueStrength == null)
  ) {
    const ix = await persistThumbColorIndex(db, imageId, srcRecord.thumbnail_path);
    if (ix) {
      focalHueBucket = ix.hueBucket;
      focalHueStrength = ix.hueStrength;
      focalHueBucket2 = ix.hueBucketSecondary ?? null;
      focalHueStrength2 = ix.hueStrengthSecondary ?? null;
    }
  }

  const focalChroma = weightedPaletteChroma(srcPalette);
  const focalIsAchromatic = focalChroma != null && focalChroma <= FOCAL_MONOCHROME_MAX_CHROMA;

  type Scored = {
    id: string;
    captionSim: number;
    phashSim: number;
    paletteSim: number | null;
    fused: number;
    record: DbImageRecord;
    preview: VisualSimilarItem['image'];
  };
  const scored: Scored[] = [];

  let proc = 0;
  for (const hit of ranked) {
    if (hit.image_id === imageId) continue;
    if (
      prefs.similarityFloor !== null &&
      hit.similarity < MATCH_STRENGTH_TO_MIN_COSINE[prefs.similarityFloor]
    ) {
      continue;
    }
    if (likenessDisplayPercentRounded(hit.similarity, floorForDisplay) === 0) continue;

    const rec = imageRepo.getById(hit.image_id);
    if (!rec || rec.is_trashed !== 0) continue;
    const preview = previewFromRecord(rec);
    if (!preview) continue;

    const captionSim = normCosine(hit.similarity);

    let phashSim = 0;
    if (srcPhash !== null && rec.phash) {
      const candPhash = blobToPhash(Buffer.from(rec.phash));
      phashSim = phashSimilarity(phashHamming(srcPhash, candPhash));
    }

    let paletteSim: number | null = null;
    if (colorsRefine || srcPalette.length > 0) {
      const cp = paletteStmt.all(hit.image_id) as PaletteRow[];
      const overlap = symmetricPaletteOverlap(srcPalette, cp);
      if (overlap !== null) {
        let s = overlap;
        if (focalHueBucket != null && focalHueStrength != null) {
          const focalDual =
            focalHueStrength >= 0.17 &&
            typeof focalHueBucket2 === 'number' &&
            focalHueStrength2 != null &&
            focalHueStrength2 >= 0.036 &&
            hueBinRingSteps(focalHueBucket, focalHueBucket2) >= 3;
          const candDual =
            typeof rec.indexed_hue_bucket === 'number' &&
            rec.indexed_hue_strength != null &&
            rec.indexed_hue_strength >= 0.17 &&
            typeof rec.indexed_hue_bucket_2 === 'number' &&
            rec.indexed_hue_strength_2 != null &&
            rec.indexed_hue_strength_2 >= 0.036 &&
            hueBinRingSteps(rec.indexed_hue_bucket, rec.indexed_hue_bucket_2) >= 3;
          if (focalDual && candDual) {
            s *= dualDominantHueBoost(
              focalHueBucket,
              focalHueStrength,
              focalHueBucket2,
              focalHueStrength2,
              rec.indexed_hue_bucket,
              rec.indexed_hue_strength,
              rec.indexed_hue_bucket_2,
              rec.indexed_hue_strength_2,
            );
          } else {
            s *= dominantHueAxisMultiplier(
              focalHueBucket,
              focalHueStrength,
              rec.indexed_hue_bucket,
              rec.indexed_hue_strength,
            );
          }
        }
        // Penalize achromatic source matched against saturated candidates and vice versa.
        const candChroma = weightedPaletteChroma(cp);
        if (focalIsAchromatic && candChroma != null && candChroma > 0.2) {
          s *= 0.55;
        }
        paletteSim = Math.max(0, Math.min(1, s));
      }
    }

    if (colorsRefine && paletteSim !== null && paletteSim < PALETTE_COMPOSITION_GATE) {
      continue;
    }

    let fused: number;
    if (colorsRefine && paletteSim !== null) {
      fused =
        W_COLOR_REFINE * paletteSim +
        W_CAPTION_REFINE * captionSim +
        W_PHASH_REFINE * phashSim;
    } else if (paletteSim !== null) {
      fused =
        W_CAPTION * captionSim +
        W_PHASH * phashSim +
        W_COLOR_BASELINE * paletteSim;
    } else {
      // No palette signal — redistribute color weight to caption.
      fused = (W_CAPTION + W_COLOR_BASELINE) * captionSim + W_PHASH * phashSim;
    }

    scored.push({ id: hit.image_id, captionSim, phashSim, paletteSim, fused, record: rec, preview });

    if (scored.length >= REFINE_POOL_CAP * 2) break;

    proc++;
    if (proc % 64 === 0) await yieldToEventLoop();
  }

  scored.sort((a, b) => b.fused - a.fused);

  const out = scored.slice(0, limit).map((s) => ({
    image: s.preview,
    similarity: s.captionSim,
  }));

  if (out.length === 0 && prefs.similarityFloor !== null && ranked.length > 0) {
    return { matches: [], emptyHint: 'similarity_below_threshold', meta: metaPayload };
  }

  return { matches: out, meta: metaPayload };
}

/** Generate and store the caption embedding + pHash for an image. Used during import and re-analysis. */
export async function generateAndStoreEmbedding(
  db: Database.Database,
  imageId: string,
  imagePath: string,
): Promise<boolean> {
  const imageRepo = createImageRepo(db);
  const existing = imageRepo.getById(imageId);
  if (!existing) return false;

  if (!existing.phash) {
    try {
      const ph = await computePHash(imagePath);
      if (ph !== null) imageRepo.setPhash(imageId, phashToBlob(ph));
    } catch {
      // Non-critical
    }
  }

  return embedAndStoreForImage(db, imageId);
}

