import type Database from 'better-sqlite3';
import { createImageRepo, type ImageRecord as DbImageRecord } from '../database/repositories/images';
import { blobToFloat32Vector, ensureImageEmbedding, embedAndStoreForImage, l2Normalize } from './embeddings';
import { embedText, isOllamaRunning } from './ollama-client';
import { phashSimilarity, phashHamming, blobToPhash, computePHash, phashToBlob } from './phash';
import { likenessDisplayPercentRounded } from '../../shared/visual-similarity';
import { dominantHueAxisMultiplier, dualDominantHueBoost, hueBinRingSteps } from '../../shared/image-color-index';
import { persistThumbColorIndex } from '../color-extractor';
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
): Promise<SimilarResult[]> {
  const queryVec = Float32Array.from(embedding);

  try {
    const results = db
      .prepare(
        `
      SELECT image_id, distance
      FROM image_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `,
      )
      .all(JSON.stringify(embedding), limit) as SimilarResult[];
    const imageRepo = createImageRepo(db);
    return results.filter((row) => {
      const img = imageRepo.getById(row.image_id);
      return img && img.is_trashed === 0;
    });
  } catch {
    const ranked = await rankByEmbeddingBrute(db, queryVec, limit, null);
    return ranked.map(({ image_id, similarity }) => ({ image_id, distance: 1 - similarity }));
  }
}

export async function searchByText(db: Database.Database, query: string, limit = 20): Promise<SimilarResult[]> {
  if (!(await isOllamaRunning())) return [];
  const embedding = await embedText(query);
  if (!embedding?.length) return [];
  return searchByEmbedding(db, l2Normalize(embedding), limit);
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
  const srcPalette = paletteStmt.all(imageId) as PaletteRow[];

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

export function warmImageEmbedding(db: Database.Database, imageId: string): void {
  setImmediate(() => {
    ensureImageEmbedding(db, imageId).catch(() => undefined);
  });
}

export async function findSimilarImages(db: Database.Database, imageId: string, limit = 20): Promise<SimilarResult[]> {
  const row = db.prepare('SELECT embedding FROM image_embeddings WHERE image_id = ?').get(imageId) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return [];
  const floats = blobToFloat32Vector(Buffer.from(row.embedding));
  try {
    return db
      .prepare(
        `SELECT image_id, distance FROM image_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(JSON.stringify(Array.from(floats)), limit) as SimilarResult[];
  } catch {
    return [];
  }
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

export function getEmbeddingCount(db: Database.Database): number {
  const row = db.prepare('SELECT count(*) as cnt FROM image_embeddings').get() as { cnt: number };
  return row.cnt;
}
