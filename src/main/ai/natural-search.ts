import type Database from 'better-sqlite3';
import { BrowserWindow } from 'electron';
import { getTextEmbedding, getImageEmbedding, isSidecarRunning, startSidecar, clipArtifactsPresent } from './python-sidecar';
import { createImageRepo, type ImageRecord as DbImageRecord } from '../database/repositories/images';
import { blobToFloat32Vector, ensureImageEmbedding, upsertImageEmbedding } from './embeddings';
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
    rating: number;
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
  emptyHint?: 'python_venv_missing' | 'clip_embed_failed' | 'needs_other_indexed_images' | 'similarity_below_threshold';
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

const CLIP_PROMPT_LAYOUT =
  'similar photographic composition framing and layout viewpoint';
const CLIP_PROMPT_FORMAT =
  'same graphic format product screenshot poster webpage typography';
/** Saturated hue / vivid palette text cue (weighted down when focal is near-grayscale). */
const CLIP_PROMPT_COLORS_VIVID =
  'harmonious color palette matching dominant hues saturation vividness and overall chromatic mood';

/** Matches muted, grayscale, or low-chroma aesthetics so B&W focal images are not dragged toward saturated neighbors. */
const CLIP_PROMPT_COLORS_NEUTRAL =
  'black and white photograph flat graphic typography minimal color monochrome gray tones no rainbow hues';

const CLIP_PROMPT_COLORS_ACHROME =
  'absence of saturated color photographic grayscale line art schematic flat achromatic imagery';

/** Image–image CLIP likeness stays as `similarity` on outputs; fused score only selects order. */
const W_FUSE_IMG = 1;
const W_FUSE_MODE = 0.62;
/**
 * Palette effective chroma at or below this ⇒ treat focal as monochrome: almost no vivid text probe,
 * and Vibrant-distance is down-weighted toward saturated neighbours (they often still share blacks/grays).
 */
const FOCAL_MONOCHROME_MAX_CHROMA = 0.11;

/** Max NN candidates inspected when fusion is active */
const REFINE_POOL_CAP = 520;

/** Min symmetric palette similarity to keep when “Similar colors” is on (measurable palette only). */
const PALETTE_COMPOSITION_GATE = 0.42;
/**
 * If symmetric Vibrant score is below the gate but the embedding is still this close (CLIP dot, −1…1),
 * keep the candidate — common for two-panel posters where one-way swatch overlap is high and the other isn’t.
 */
const SIMILAR_COLORS_PALETTE_GATE_BYPASS_EMBED_MIN = 0.59;
/** When only Similar colors + we have palettes: likeness rank is dominated by palette (not structural CLIP similarity). */
const PALETTE_DOMINANT_CLIP = 0.18;
const PALETTE_DOMINANT_PAL = 0.82;

type PaletteRow = { hex_color: string; percentage: number };

function hexToRgb(hexRaw: string): { r: number; g: number; b: number } | null {
  const cleaned = hexRaw.trim().replace(/^#/, '').replace(/^0x/i, '');
  const hex = cleaned.length >= 8 ? cleaned.slice(0, 6) : cleaned.slice(0, 6).padEnd(6, '0');
  if (hex.length !== 6 || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** Normalized Euclidean distance squared in [0, 1]: 0 identical, ~1 extremes on opposite corners. */
function rgbDistNorm(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const dr = (a.r - b.r) / 255;
  const dg = (a.g - b.g) / 255;
  const db = (a.b - b.b) / 255;
  return (dr * dr + dg * dg + db * db) / 3;
}

/** Normalize rows to weighted LAB-like distance proxy in [0,1] per swatch. */
function directionalPaletteOverlap(from: PaletteRow[], to: PaletteRow[]): number | null {
  type W = { rgb: { r: number; g: number; b: number }; w: number };

  const parse = (rows: PaletteRow[]): W[] => {
    const parsed: W[] = [];
    let sum = 0;
    for (const row of rows.slice(0, 16)) {
      const rgb = hexToRgb(row.hex_color);
      if (!rgb) continue;
      const w = Math.max(1e-4, Number(row.percentage));
      parsed.push({ rgb, w });
      sum += w;
    }
    if (parsed.length === 0 || sum <= 0) return [];
    return parsed.map((p) => ({ rgb: p.rgb, w: p.w / sum }));
  };

  const a = parse(from);
  const b = parse(to);
  if (a.length === 0 || b.length === 0) return null;

  let agg = 0;
  let wsum = 0;
  for (const pa of a) {
    let best = 1;
    for (const pb of b) {
      best = Math.min(best, rgbDistNorm(pa.rgb, pb.rgb));
    }
    agg += pa.w * best;
    wsum += pa.w;
  }
  if (wsum <= 0) return null;
  /** Penalise mean distance; sqrt keeps mid-range discriminative vs black/blue vs beige. */
  return Math.max(0, Math.min(1, 1 - Math.min(1, Math.sqrt((agg / wsum) * 2))));
}

/** Both directions averaged — “overall palette composition” vs biasing dominant source hues only. */
function paletteCompositionForSimilarColors(
  swA: PaletteRow[],
  swB: PaletteRow[],
): { symmetric: number | null; boosted: number | null; ab: number | null; ba: number | null } {
  const ab = directionalPaletteOverlap(swA, swB);
  const ba = directionalPaletteOverlap(swB, swA);
  if (ab == null || ba == null) {
    const single = ab ?? ba ?? null;
    return { symmetric: single, boosted: single, ab, ba };
  }
  const mean = (ab + ba) / 2;
  const hi = Math.max(ab, ba);
  const lo = Math.min(ab, ba);
  if (lo < 0.31 && hi > 0.44) return { symmetric: mean, boosted: Math.max(mean, hi * 0.94), ab, ba };
  return { symmetric: mean, boosted: mean, ab, ba };
}

/** Simple RGB chroma proxy in ~[0,1] aligned with perceptual saturation of a flat swatch. */
function rgbChromaticity(rgb: { r: number; g: number; b: number }): number {
  const mx = Math.max(rgb.r, rgb.g, rgb.b);
  const mn = Math.min(rgb.r, rgb.g, rgb.b);
  return (mx - mn) / 255;
}

/** Weighted mean chromaticity across Vibrant swatches; `null` if no usable rows. */
function weightedPaletteChroma(rows: PaletteRow[]): number | null {
  let wsum = 0;
  let acc = 0;
  for (const row of rows.slice(0, 16)) {
    const rgb = hexToRgb(row.hex_color);
    if (!rgb) continue;
    const w = Math.max(1e-4, Number(row.percentage));
    wsum += w;
    acc += w * rgbChromaticity(rgb);
  }
  if (wsum <= 0) return null;
  return Math.max(0, Math.min(1, acc / wsum));
}

/** Robust to Vibrant outliers: weighted median chromaticity (~0 on most B&W palettes). */
function paletteMedianWeightedChroma(rows: PaletteRow[]): number | null {
  type CW = { c: number; w: number };
  const buckets: CW[] = [];
  let wsum = 0;
  for (const row of rows.slice(0, 16)) {
    const rgb = hexToRgb(row.hex_color);
    if (!rgb) continue;
    const w = Math.max(1e-4, Number(row.percentage));
    buckets.push({ c: rgbChromaticity(rgb), w });
    wsum += w;
  }
  if (buckets.length === 0 || wsum <= 0) return null;
  buckets.sort((a, b) => a.c - b.c);
  const mid = wsum / 2;
  let cum = 0;
  for (const b of buckets) {
    cum += b.w;
    if (cum >= mid) return Math.max(0, Math.min(1, b.c));
  }
  return Math.max(0, Math.min(1, buckets[buckets.length - 1]!.c));
}

/** Highest chromaticity among swatches accounting for meaningful weight (drops micro-outliers below 2.5%). */
function paletteDominantPeakChroma(rows: PaletteRow[]): number | null {
  let raw = 0;
  for (const row of rows.slice(0, 16)) {
    const rgb = hexToRgb(row.hex_color);
    if (!rgb) continue;
    raw += Math.max(1e-4, Number(row.percentage));
  }
  if (raw <= 0) return null;
  let peak = 0;
  for (const row of rows.slice(0, 16)) {
    const rgb = hexToRgb(row.hex_color);
    if (!rgb) continue;
    const w = Number(row.percentage) / raw;
    if (!(w >= 0.025)) continue;
    peak = Math.max(peak, rgbChromaticity(rgb));
  }
  if (peak === 0 && rows.length > 0) return weightedPaletteChroma(rows);
  return peak > 0 ? Math.max(0, Math.min(1, peak)) : null;
}

/** How strongly the focal embedding aligns with the vivid text vs grayscale prompts (fallback when palettes lie). */
function vividWeightFromEmbeddingVsPrompts(
  queryVec: Float32Array,
  vividVec: Float32Array | null,
  neutralVec: Float32Array | null,
  achromeVec: Float32Array | null,
): number {
  if (!vividVec || !neutralVec) return 0.5;
  const v = normCosine(dotNormalized(vividVec, queryVec));
  const ach = achromeVec != null ? normCosine(dotNormalized(achromeVec, queryVec)) : null;
  const n = normCosine(dotNormalized(neutralVec, queryVec));
  const calm = Math.max(n, ach ?? n);
  return Math.max(0, Math.min(1, v / (v + calm + 1e-6)));
}

/** Palette-derived vivid weight once `effectiveChroma = min(median, peak-or-median)` resolved. */
function vividWeightFromEffectiveChroma(effect: number): number {
  if (effect <= 0.055) return 0;
  return Math.max(0, Math.min(1, (effect - 0.055) / 0.34));
}

/** Final λ blending vivid vs calm CLIP probes. `λEmb` = vivid / (vivid+calm) on the focal thumbnail. */
function blendVividClipLambda(λEmb: number, paletteEff: number | null): number {
  if (paletteEff !== null && paletteEff <= FOCAL_MONOCHROME_MAX_CHROMA) {
    return Math.min(λEmb * 0.068, 0.052);
  }
  if (paletteEff === null) {
    return Math.min(λEmb * 0.27 + 0.068, 0.19);
  }
  const λPal = vividWeightFromEffectiveChroma(paletteEff);
  return Math.max(0, Math.min(1, λPal * 0.46 + λEmb * 0.54));
}

/** Estimate candidate saturation when swatches absent; amplifies vivid–calm spread. */
function candChromaSurrogateClip(vividS: number | null, calmS: number | null): number | null {
  if (vividS == null || calmS == null) return null;
  return Math.max(0, Math.min(1, 0.17 + vividS - calmS));
}

/** Harmony [0,1] between focal and candidate chroma fingerprints. */
function chromaAgreementFactor(src: number | null, cand: number | null): number {
  if (src === null || cand === null) return 1;
  const d = Math.abs(src - cand);
  return Math.max(0, Math.min(1, 1 - d * d * 2.52));
}

/** When focal chroma is tiny, exponentially down-rank candidates with higher saturation. */
function achromaticPenalty(focalMedian: number, candChrom: number): number {
  if (focalMedian > FOCAL_MONOCHROME_MAX_CHROMA + 0.01) return 1;
  const d = Math.max(0, candChrom - focalMedian);
  const k = focalMedian < 0.06 ? 4.95 : 4.05;
  return Math.max(0.03, Math.min(1, Math.exp(-d * k)));
}

/** When thumb-time classification exists, soften cross-type matches in Similar colors (unknown stays neutral). */
function indexedChromaticAgreement(focal: number | null | undefined, cand: number | null | undefined): number {
  const f = focal === 0 ? 0 : focal === 1 ? 1 : null;
  const c = cand === 0 ? 0 : cand === 1 ? 1 : null;
  if (f === null || c === null) return 1;
  if (f === 0 && c === 1) return 0.098;
  if (f === 1 && c === 0) return 0.38;
  return 1;
}

/** Quick palette sniff when `indexed_chromatic` missing; tuned to avoid wrongly blocking true B&W thumbs. */
const PALETTE_GATE_CHROMATIC_UPPER = 0.105;
const PALETTE_GATE_ACHROME_UPPER = 0.068;

/** True ⇒ drop from pool (“Similar colors” on a monochrome focal should not promote rainbow neighbors). */
async function chromaticNeighborSkipForAchromaticSimilarColors(
  db: Database.Database,
  cand: DbImageRecord,
  paletteChromStmt: { all: (...args: unknown[]) => unknown[] },
): Promise<boolean> {
  if (cand.indexed_chromatic === 1) return true;
  if (cand.indexed_chromatic === 0) return false;
  const cp = paletteChromStmt.all(cand.id) as PaletteRow[];
  const pc = weightedPaletteChroma(cp);
  if (pc !== null && pc >= PALETTE_GATE_CHROMATIC_UPPER) return true;
  if (pc !== null && pc <= PALETTE_GATE_ACHROME_UPPER) return false;
  const c = await persistThumbColorIndex(db, cand.id, cand.thumbnail_path);
  return c?.chromatic === 1;
}

function coarseMime(ft: string | null): string {
  if (!ft) return 'unknown';
  const s = ft.toLowerCase();
  if (/jpe?g/.test(s)) return 'jpeg';
  if (/png/.test(s)) return 'png';
  if (/webp/.test(s)) return 'webp';
  if (/gif/.test(s)) return 'gif';
  if (/svg/.test(s)) return 'svg';
  if (/pdf/.test(s)) return 'pdf';
  return 'other';
}

function orientationBucket(ar: number): 'portrait' | 'landscape' | 'squarish' {
  if (ar < 0.88) return 'portrait';
  if (ar > 1.15) return 'landscape';
  return 'squarish';
}

/** Overlap score for aspect similarity in (0 1]; `null` if dimensions missing on either row. */
function aspectOverlapScore(
  ws: number | null,
  hs: number | null,
  wc: number | null,
  hc: number | null,
): number | null {
  if (!ws || !hs || !wc || !hc || ws <= 0 || hs <= 0 || wc <= 0 || hc <= 0) return null;
  const rs = ws / hs;
  const rc = wc / hc;
  const d = Math.abs(Math.log(rs) - Math.log(rc));
  const k = 9;
  return 1 / (1 + k * d);
}

function metadataFormatAgreement(src: DbImageRecord, cand: DbImageRecord): number {
  const mimeS = coarseMime(src.file_type);
  const mimeC = coarseMime(cand.file_type);
  const mimeBonus = mimeS !== 'unknown' && mimeS === mimeC ? 1 : mimeS !== 'unknown' && mimeC !== 'unknown' ? 0.55 : 0.72;

  const asp = aspectOverlapScore(src.width, src.height, cand.width, cand.height);
  if (asp !== null) {
    const sw = src.width;
    const sh = src.height;
    const cw = cand.width;
    const ch = cand.height;
    if (sw !== null && sh !== null && cw !== null && ch !== null && sh > 0 && ch > 0) {
      const bs = orientationBucket(sw / sh);
      const bc = orientationBucket(cw / ch);
      const orient = bs === bc ? 1 : 0.5;
      return 0.5 * mimeBonus + 0.35 * asp + 0.15 * orient;
    }
  }
  return mimeBonus;
}

function normCosine(dot: number): number {
  return Math.max(0, Math.min(1, (dot + 1) / 2));
}

async function waitSidecarTick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setTimeout(r, 380));
}

async function loadRefinePromptVectors(
  modes: SimilarRefineMode[],
  cache: Map<string, Float32Array | null>,
): Promise<void> {
  const needLayout = modes.includes('layout');
  const needFormat = modes.includes('format');
  const needColors = modes.includes('colors');
  if (!needLayout && !needFormat && !needColors) return;
  if (!clipArtifactsPresent()) return;

  if (!isSidecarRunning()) {
    if (!startSidecar()) return;
    await waitSidecarTick();
  }
  if (!isSidecarRunning()) return;

  const prompts: string[] = [];
  if (needLayout) prompts.push(CLIP_PROMPT_LAYOUT);
  if (needFormat) prompts.push(CLIP_PROMPT_FORMAT);
  if (needColors) {
    prompts.push(CLIP_PROMPT_COLORS_VIVID);
    prompts.push(CLIP_PROMPT_COLORS_NEUTRAL);
    prompts.push(CLIP_PROMPT_COLORS_ACHROME);
  }

  for (const prompt of prompts) {
    if (cache.has(prompt)) continue;
    const raw = await getTextEmbedding(prompt);
    cache.set(prompt, raw?.length ? Float32Array.from(raw) : null);
  }
}

function fuseRankScore(
  modeSet: Set<SimilarRefineMode>,
  imgNorm: number,
  paletteScore: number | null,
  layoutComposite: number | null,
  formatComposite: number | null,
): number {
  const colorsChipOnlyDom = modeSet.has('colors') && paletteScore !== null && modeSet.size === 1;
  if (colorsChipOnlyDom) {
    return PALETTE_DOMINANT_CLIP * imgNorm + PALETTE_DOMINANT_PAL * paletteScore;
  }

  let num = W_FUSE_IMG * imgNorm;
  let den = W_FUSE_IMG;
  if (modeSet.has('colors') && paletteScore != null) {
    num += W_FUSE_MODE * paletteScore;
    den += W_FUSE_MODE;
  }
  if (modeSet.has('layout') && layoutComposite != null) {
    num += W_FUSE_MODE * layoutComposite;
    den += W_FUSE_MODE;
  }
  if (modeSet.has('format') && formatComposite != null) {
    num += W_FUSE_MODE * formatComposite;
    den += W_FUSE_MODE;
  }
  let fused = den > 1e-9 ? num / den : imgNorm;

  /** Legacy: multi-mode fusion could penalise weak palettes; radio UI sends at most one chip. */
  if (modeSet.has('colors') && paletteScore != null && !colorsChipOnlyDom && modeSet.size > 1) {
    fused *= Math.max(0.05, 0.28 + 0.72 * paletteScore);
  }
  return fused;
}

interface RefinedScoredRow {
  fused: number;
  similarity: number;
  layoutComposite: number | null;
  formatComposite: number | null;
  paletteScore: number | null;
  item: VisualSimilarItem;
}

/** Single active refine chip: layout/format sort by facet; colors prioritizes fused (palette + CLIP hue) within the pool. */
function refinedSortCmp(a: RefinedScoredRow, b: RefinedScoredRow, soleMode: SimilarRefineMode): number {
  const facetRank = (x: number | null): number =>
    x != null && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : -1;

  if (soleMode === 'colors') {
    const df = b.fused - a.fused;
    if (df !== 0) return df;
    return b.similarity - a.similarity;
  }
  if (soleMode === 'layout') {
    const df = facetRank(b.layoutComposite) - facetRank(a.layoutComposite);
    if (df !== 0) return df;
    return b.similarity - a.similarity;
  }
  if (soleMode === 'format') {
    const df = facetRank(b.formatComposite) - facetRank(a.formatComposite);
    if (df !== 0) return df;
    return b.similarity - a.similarity;
  }
  return b.similarity - a.similarity;
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
    rating: r.rating,
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

/** Cosine similarity of L2-normalized vectors equals dot product. */
function dotNormalized(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  if (b.length !== n) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Color-prompt alignment with the embedding component of `cand` that is orthogonal to `query`.
 * Top CLIP NN neighbors hug the focal direction so dot(prompt,cand) ≈ dot(prompt,query)—flat signal;
 * orthogonal residual supplies per-neighbour variance needed to re-rank.
 */
function clipColorChordScore(prompt: Float32Array, cand: Float32Array, query: Float32Array): number | null {
  const cosQC = dotNormalized(query, cand);
  if (!Number.isFinite(cosQC)) return null;
  let magSq = 0;
  const n = cand.length;
  for (let i = 0; i < n; i++) {
    const r = cand[i] - cosQC * query[i];
    magSq += r * r;
  }
  const mag = Math.sqrt(magSq);
  if (!(mag >= 1e-5 && Number.isFinite(mag))) return null;
  let dotP = 0;
  for (let i = 0; i < n; i++) {
    dotP += prompt[i] * ((cand[i] - cosQC * query[i]) / mag);
  }
  return normCosine(dotP);
}

function clipColorHybridScore(prompt: Float32Array, cand: Float32Array, query: Float32Array): number | null {
  const chord = clipColorChordScore(prompt, cand, query);
  const plain = dotNormalized(prompt, cand);
  const plainN = Number.isFinite(plain) ? normCosine(plain) : null;
  if (chord != null && plainN != null) return 0.74 * chord + 0.26 * plainN;
  return chord ?? plainN ?? null;
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
  if (!isSidecarRunning()) {
    startSidecar();
    await new Promise((r) => setTimeout(r, 3000));
  }

  const embedding = await getTextEmbedding(query);
  if (!embedding) return [];

  return searchByEmbedding(db, embedding, limit);
}

/** Visually similar non-trashed images (excludes reference). Honors saved prefs (max results & min cosine). Optional `refineModes` fused re-ranking (CLIP text + palettes + metadata). */
export async function findSimilarImagesWithPreviews(
  db: Database.Database,
  imageId: string,
  options?: FindSimilarOptions,
): Promise<SimilarMatchesResponse> {
  const refineModes = options?.refineModes?.filter((m) => m === 'colors' || m === 'layout' || m === 'format') ?? [];
  const prefs = loadSimilarityPrefs(db);
  const limit = prefs.maxResults;
  const hadEmbeddingAlready = Boolean(db.prepare('SELECT 1 FROM image_embeddings WHERE image_id = ?').get(imageId));

  if (!clipArtifactsPresent()) {
    return { matches: [], emptyHint: 'python_venv_missing' };
  }

  const ensured = await ensureImageEmbedding(db, imageId).catch(() => false);
  if (!ensured) {
    return { matches: [], emptyHint: 'clip_embed_failed' };
  }

  const row = db.prepare('SELECT embedding FROM image_embeddings WHERE image_id = ?').get(imageId) as
    | { embedding: Buffer }
    | undefined;
  if (!row) {
    return { matches: [], emptyHint: 'clip_embed_failed' };
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

  /** Radio UI: fuse/sort considers at most one chip (IPC may still send a list). */
  const refineModesSole = refineModes.slice(0, 1);

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

  let neighborPrefetchCap =
    prefs.similarityFloor !== null ? Math.min(800, Math.max(limit + 64, limit * 36)) : limit + 8;
  if (refineModesSole.length > 0) {
    neighborPrefetchCap = Math.min(800, Math.max(neighborPrefetchCap, Math.max(limit * 40, REFINE_POOL_CAP)));
  }
  if (refineModesSole.length === 1 && refineModesSole[0] === 'colors') {
    const peerN = peerRow?.c ?? 0;
    neighborPrefetchCap = Math.min(Math.max(peerN + 240, REFINE_POOL_CAP * 14, limit * 160), 4000);
  }

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

  if (refineModesSole.length === 0) {
    const out: VisualSimilarItem[] = [];
    const seen = new Set<string>();
    for (const hit of ranked) {
      if (hit.image_id === imageId || seen.has(hit.image_id)) continue;
      if (
        prefs.similarityFloor !== null &&
        hit.similarity < MATCH_STRENGTH_TO_MIN_COSINE[prefs.similarityFloor]
      )
        continue;
      if (likenessDisplayPercentRounded(hit.similarity, floorForDisplay) === 0) continue;
      const rec = imageRepo.getById(hit.image_id);
      if (!rec || rec.is_trashed !== 0) continue;
      const preview = previewFromRecord(rec);
      if (!preview) continue;
      out.push({ image: preview, similarity: hit.similarity });
      seen.add(hit.image_id);
      if (out.length >= limit) break;
    }

    if (out.length === 0 && prefs.similarityFloor !== null && ranked.length > 0) {
      return { matches: [], emptyHint: 'similarity_below_threshold', meta: metaPayload };
    }

    return { matches: out, meta: metaPayload };
  }

  const soleMode = refineModesSole[0];
  const modeSet = new Set(refineModesSole);

  const srcRecord = imageRepo.getById(imageId);

  const paletteStmt = db.prepare(
    'SELECT hex_color, percentage FROM image_colors WHERE image_id = ? ORDER BY sort_order LIMIT 14',
  );
  const srcPalette = paletteStmt.all(imageId) as PaletteRow[];

  let focalHueBucket: number | null =
    typeof srcRecord?.indexed_hue_bucket === 'number' ? srcRecord.indexed_hue_bucket : null;
  let focalHueStrength: number | null =
    typeof srcRecord?.indexed_hue_strength === 'number' ? srcRecord.indexed_hue_strength : null;
  let focalHueBucket2: number | null =
    typeof srcRecord?.indexed_hue_bucket_2 === 'number' ? srcRecord.indexed_hue_bucket_2 : null;
  let focalHueStrength2: number | null =
    typeof srcRecord?.indexed_hue_strength_2 === 'number' ? srcRecord.indexed_hue_strength_2 : null;

  let focalResolvedChrom: number | null =
    srcRecord?.indexed_chromatic === 0 || srcRecord?.indexed_chromatic === 1
      ? srcRecord.indexed_chromatic
      : null;

  const needFocalThumbIx =
    refineModesSole.length === 1 &&
    refineModesSole[0] === 'colors' &&
    srcRecord?.thumbnail_path &&
    (focalResolvedChrom === null ||
      (focalResolvedChrom === 1 &&
        (focalHueBucket === null ||
          focalHueStrength == null ||
          (typeof focalHueBucket === 'number' &&
            focalHueStrength != null &&
            focalHueStrength >= 0.11 &&
            srcRecord?.indexed_hue_bucket_2 == null))));

  if (needFocalThumbIx) {
    const ix = await persistThumbColorIndex(db, imageId, srcRecord.thumbnail_path);
    if (ix) {
      if (ix.chromatic === 0 || ix.chromatic === 1) focalResolvedChrom = ix.chromatic;
      focalHueBucket = ix.hueBucket;
      focalHueStrength = ix.hueStrength;
      focalHueBucket2 = ix.hueBucketSecondary ?? null;
      focalHueStrength2 = ix.hueStrengthSecondary ?? null;
    }
  }

  const focalMedianChroma =
    paletteMedianWeightedChroma(srcPalette) ?? weightedPaletteChroma(srcPalette);
  const focalPeakChroma = paletteDominantPeakChroma(srcPalette);
  const focalPaletteEffectiveChroma: number | null =
    focalMedianChroma != null ? Math.min(focalMedianChroma, focalPeakChroma ?? focalMedianChroma) : null;
  const focalChromaTune = focalMedianChroma ?? focalPaletteEffectiveChroma;

  const textCache = new Map<string, Float32Array | null>();
  await loadRefinePromptVectors(refineModesSole, textCache);

  const layoutVec = refineModesSole.includes('layout') ? textCache.get(CLIP_PROMPT_LAYOUT) ?? null : null;
  const formatVec = refineModesSole.includes('format') ? textCache.get(CLIP_PROMPT_FORMAT) ?? null : null;
  const colorPromptVecVivid = refineModesSole.includes('colors') ? textCache.get(CLIP_PROMPT_COLORS_VIVID) ?? null : null;
  const colorPromptVecNeutral =
    refineModesSole.includes('colors') ? textCache.get(CLIP_PROMPT_COLORS_NEUTRAL) ?? null : null;
  const colorPromptVecAchrome =
    refineModesSole.includes('colors') ? textCache.get(CLIP_PROMPT_COLORS_ACHROME) ?? null : null;

  const λEmbedColorCue = vividWeightFromEmbeddingVsPrompts(
    queryVec,
    colorPromptVecVivid,
    colorPromptVecNeutral,
    colorPromptVecAchrome,
  );
  const focalPaletteForClipBlend =
    focalResolvedChrom === 0
      ? 0
      : focalResolvedChrom === 1
        ? Math.max(focalPaletteEffectiveChroma ?? 0.16, FOCAL_MONOCHROME_MAX_CHROMA + 0.05)
        : focalPaletteEffectiveChroma;
  const λVividClip = blendVividClipLambda(λEmbedColorCue, focalPaletteForClipBlend);

  const focalTreatAsMono =
    focalResolvedChrom === 0
      ? true
      : focalResolvedChrom === 1
        ? false
        : focalPaletteEffectiveChroma !== null
          ? focalPaletteEffectiveChroma <= FOCAL_MONOCHROME_MAX_CHROMA
          : focalChromaTune !== null
            ? focalChromaTune <= FOCAL_MONOCHROME_MAX_CHROMA
            : λEmbedColorCue <= 0.375;

  const focalChromaForColorsRow =
    focalResolvedChrom === 0
      ? Math.min(focalChromaTune ?? FOCAL_MONOCHROME_MAX_CHROMA * 0.45, FOCAL_MONOCHROME_MAX_CHROMA)
      : focalResolvedChrom === 1
        ? Math.max(focalChromaTune ?? 0.14, FOCAL_MONOCHROME_MAX_CHROMA + 0.035)
        : focalChromaTune;

  const colorsSimilarStrictAchromatic = soleMode === 'colors' && modeSet.size === 1 && focalTreatAsMono;

  type PoolEntry = {
    similarity: number;
    preview: VisualSimilarItem['image'];
    candRow: DbImageRecord;
    id: string;
  };
  const pool: PoolEntry[] = [];

  let poolScans = 0;
  for (const hit of ranked) {
    if (hit.image_id === imageId) continue;
    if (
      prefs.similarityFloor !== null &&
      hit.similarity < MATCH_STRENGTH_TO_MIN_COSINE[prefs.similarityFloor]
    )
      continue;
    if (likenessDisplayPercentRounded(hit.similarity, floorForDisplay) === 0) continue;

    const rec = imageRepo.getById(hit.image_id);
    if (!rec || rec.is_trashed !== 0) continue;
    const preview = previewFromRecord(rec);
    if (!preview) continue;

    if (colorsSimilarStrictAchromatic) {
      if (await chromaticNeighborSkipForAchromaticSimilarColors(db, rec, paletteStmt)) {
        poolScans++;
        if (poolScans % 40 === 0) await yieldToEventLoop();
        continue;
      }
    }

    pool.push({ id: hit.image_id, similarity: hit.similarity, preview, candRow: rec });
    if (pool.length >= REFINE_POOL_CAP) break;

    poolScans++;
    if (poolScans % 48 === 0) await yieldToEventLoop();
  }

  /** If every NN is saturated,relax once so sparse B&W libraries do not blank the strip entirely. */
  if (colorsSimilarStrictAchromatic && pool.length === 0 && ranked.length > 0) {
    for (const hit of ranked) {
      if (hit.image_id === imageId) continue;
      if (
        prefs.similarityFloor !== null &&
        hit.similarity < MATCH_STRENGTH_TO_MIN_COSINE[prefs.similarityFloor]
      )
        continue;
      if (likenessDisplayPercentRounded(hit.similarity, floorForDisplay) === 0) continue;
      const rec = imageRepo.getById(hit.image_id);
      if (!rec || rec.is_trashed !== 0) continue;
      const preview = previewFromRecord(rec);
      if (!preview) continue;
      pool.push({ id: hit.image_id, similarity: hit.similarity, preview, candRow: rec });
      if (pool.length >= REFINE_POOL_CAP) break;
    }
  }

  const embStmt = db.prepare('SELECT embedding FROM image_embeddings WHERE image_id = ?');

  const scored: RefinedScoredRow[] = [];
  let proc = 0;

  for (const p of pool) {
    const embRow = embStmt.get(p.id) as { embedding: Buffer } | undefined;
    if (!embRow) continue;
    const candVec = blobToFloat32Vector(Buffer.from(embRow.embedding));

    const imgNorm = normCosine(p.similarity);

    let paletteScore: number | null = null;
    if (modeSet.has('colors')) {
      const cp = paletteStmt.all(p.id) as PaletteRow[];
      const { symmetric: _dbSymmetric, boosted: dbPaletteBoosted, ab: palAb, ba: palBa } =
        paletteCompositionForSimilarColors(srcPalette, cp);

      const embedPaletteGateRescue =
        p.similarity >= SIMILAR_COLORS_PALETTE_GATE_BYPASS_EMBED_MIN;

      const splitTwoTonePal =
        palAb != null &&
        palBa != null &&
        Math.min(palAb, palBa) < 0.31 &&
        Math.max(palAb, palBa) > 0.44;

      const dbBlendMutable = dbPaletteBoosted;

      const candPaletteChroma = weightedPaletteChroma(cp);

      const vividS =
        colorPromptVecVivid != null ? clipColorHybridScore(colorPromptVecVivid, candVec, queryVec) : null;
      const neutralS =
        colorPromptVecNeutral != null
          ? clipColorHybridScore(colorPromptVecNeutral, candVec, queryVec)
          : null;
      const achromeS =
        colorPromptVecAchrome != null
          ? clipColorHybridScore(colorPromptVecAchrome, candVec, queryVec)
          : null;
      const calmPool = [neutralS, achromeS].filter((x): x is number => x != null && Number.isFinite(x));
      const calmSBlend = calmPool.length > 0 ? Math.max(...calmPool) : null;

      const surrogateChrom = candChromaSurrogateClip(vividS, calmSBlend);

      let dbBlend = dbBlendMutable;
      if (focalTreatAsMono && dbBlend != null) {
        const chromProxyForDb = candPaletteChroma ?? surrogateChrom ?? 0.44;
        dbBlend *= Math.exp(-Math.max(0, chromProxyForDb - 0.055) * 3.72);
      }

      let clipColorScore: number | null = null;
      if (vividS != null && calmSBlend != null) {
        clipColorScore = λVividClip * vividS + (1 - λVividClip) * calmSBlend;
      } else {
        clipColorScore = vividS ?? calmSBlend ?? null;
      }

      let paletteScoreStage =
        dbBlend != null && clipColorScore != null
          ? 0.41 * dbBlend + 0.59 * clipColorScore
          : dbBlend ?? clipColorScore ?? null;

      const candChromEstimate = candPaletteChroma ?? surrogateChrom ?? null;

      if (paletteScoreStage != null && focalChromaForColorsRow != null && candChromEstimate !== null) {
        paletteScoreStage *= 0.22 + 0.78 * chromaAgreementFactor(focalChromaForColorsRow, candChromEstimate);
      }

      if (
        paletteScoreStage !== null &&
        focalChromaForColorsRow !== null &&
        focalChromaForColorsRow <= FOCAL_MONOCHROME_MAX_CHROMA &&
        candChromEstimate !== null
      ) {
        paletteScoreStage *= achromaticPenalty(focalChromaForColorsRow, candChromEstimate);
      }

      if (paletteScoreStage != null)
        paletteScoreStage *= indexedChromaticAgreement(focalResolvedChrom, p.candRow.indexed_chromatic);

      if (
        paletteScoreStage != null &&
        soleMode === 'colors' &&
        modeSet.size === 1 &&
        !focalTreatAsMono &&
        !embedPaletteGateRescue &&
        !splitTwoTonePal
      ) {
        const DUAL_PRI = 0.17;
        const DUAL_SEC = 0.036;
        const DUAL_SEP = 3;

        const focalDual =
          typeof focalHueBucket === 'number' &&
          focalHueStrength != null &&
          focalHueStrength >= DUAL_PRI &&
          typeof focalHueBucket2 === 'number' &&
          focalHueStrength2 != null &&
          focalHueStrength2 >= DUAL_SEC &&
          hueBinRingSteps(focalHueBucket, focalHueBucket2) >= DUAL_SEP;
        const candDual =
          typeof p.candRow.indexed_hue_bucket === 'number' &&
          p.candRow.indexed_hue_strength != null &&
          p.candRow.indexed_hue_strength >= DUAL_PRI &&
          typeof p.candRow.indexed_hue_bucket_2 === 'number' &&
          p.candRow.indexed_hue_strength_2 != null &&
          p.candRow.indexed_hue_strength_2 >= DUAL_SEC &&
          hueBinRingSteps(p.candRow.indexed_hue_bucket, p.candRow.indexed_hue_bucket_2) >= DUAL_SEP;

        if (focalDual && candDual) {
          paletteScoreStage *= dualDominantHueBoost(
            focalHueBucket,
            focalHueStrength,
            focalHueBucket2,
            focalHueStrength2,
            p.candRow.indexed_hue_bucket,
            p.candRow.indexed_hue_strength,
            p.candRow.indexed_hue_bucket_2,
            p.candRow.indexed_hue_strength_2,
          );
        } else {
          paletteScoreStage *= dominantHueAxisMultiplier(
            focalHueBucket,
            focalHueStrength,
            p.candRow.indexed_hue_bucket,
            p.candRow.indexed_hue_strength,
          );
        }
      }

      paletteScore = paletteScoreStage;

      if (
        soleMode === 'colors' &&
        modeSet.size === 1 &&
        embedPaletteGateRescue &&
        paletteScore != null &&
        paletteScore < imgNorm * 0.88
      ) {
        paletteScore = Math.max(paletteScore, imgNorm * 0.9);
      }

      if (
        dbPaletteBoosted != null &&
        dbPaletteBoosted < PALETTE_COMPOSITION_GATE &&
        !embedPaletteGateRescue
      ) {
        continue;
      }
    }

    let layoutComposite: number | null = null;
    if (modeSet.has('layout')) {
      const parts: number[] = [];
      const asp =
        srcRecord?.width != null &&
        srcRecord?.height != null &&
        typeof srcRecord.width === 'number' &&
        typeof srcRecord.height === 'number'
          ? aspectOverlapScore(srcRecord.width, srcRecord.height, p.candRow.width, p.candRow.height)
          : null;
      if (asp != null && Number.isFinite(asp)) parts.push(Math.max(0, Math.min(1, asp)));
      if (layoutVec) {
        const d = dotNormalized(layoutVec, candVec);
        if (Number.isFinite(d)) parts.push(normCosine(d));
      }
      if (parts.length > 0) {
        layoutComposite = parts.reduce((a, x) => a + x, 0) / parts.length;
      }
    }

    let formatComposite: number | null = null;
    if (modeSet.has('format') && srcRecord) {
      const metaPart = metadataFormatAgreement(srcRecord, p.candRow);
      let clipPart = 0;
      let clipN = 0;
      if (formatVec) {
        const fd = dotNormalized(formatVec, candVec);
        if (Number.isFinite(fd)) {
          clipPart += normCosine(fd);
          clipN += 1;
        }
      }
      formatComposite = clipN > 0 ? 0.5 * metaPart + 0.5 * (clipPart / clipN) : metaPart;
    }

    let fused = fuseRankScore(modeSet, imgNorm, paletteScore, layoutComposite, formatComposite);
    if (modeSet.has('colors') && paletteScore === null && modeSet.size === 1) {
      fused = imgNorm * 0.38;
    }
    scored.push({
      fused,
      similarity: p.similarity,
      layoutComposite,
      formatComposite,
      paletteScore,
      item: { image: p.preview, similarity: p.similarity },
    });

    proc++;
    if (proc % 72 === 0) await yieldToEventLoop();
  }

  scored.sort((a, b) => refinedSortCmp(a, b, soleMode));

  const outRefined = scored.slice(0, limit).map((s) => s.item);

  if (outRefined.length === 0 && prefs.similarityFloor !== null && ranked.length > 0) {
    return { matches: [], emptyHint: 'similarity_below_threshold', meta: metaPayload };
  }

  return { matches: outRefined, meta: metaPayload };
}

export function warmImageEmbedding(db: Database.Database, imageId: string): void {
  setImmediate(() => {
    ensureImageEmbedding(db, imageId).catch(() => undefined);
  });
}

export async function findSimilarImages(db: Database.Database, imageId: string, limit = 20): Promise<SimilarResult[]> {
  const row = db.prepare('SELECT embedding FROM image_embeddings WHERE image_id = ?').get(imageId) as { embedding: Buffer } | undefined;
  if (!row) return [];
  const floats = blobToFloat32Vector(Buffer.from(row.embedding));
  const buffer = Buffer.from(new Float32Array(floats).buffer);
  try {
    return db.prepare(`SELECT image_id, distance FROM image_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`).all(buffer, limit) as SimilarResult[];
  } catch {
    return [];
  }
}

export async function generateAndStoreEmbedding(db: Database.Database, imageId: string, imagePath: string): Promise<boolean> {
  const embedding = await getImageEmbedding(imagePath);
  if (!embedding) return false;
  upsertImageEmbedding(db, imageId, embedding);
  return true;
}

export function getEmbeddingCount(db: Database.Database): number {
  const row = db.prepare('SELECT count(*) as cnt FROM image_embeddings').get() as { cnt: number };
  return row.cnt;
}
