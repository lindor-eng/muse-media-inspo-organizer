import { Vibrant } from 'node-vibrant/node';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';

import { INDEXED_HUE_BIN_COUNT, hueBinRingSteps } from '../shared/image-color-index';

export interface ExtractedColor {
  hex_color: string;
  percentage: number;
}

export interface ThumbColorIndex {
  /** 0 ≈ grayscale, 1 ≈ visibly chromatic, null if decode failed. */
  chromatic: number | null;
  /** 0–11 (30° bins), null when achromatic or no clear dominant. */
  hueBucket: number | null;
  /** Fraction of thumb pixels (excl. near-black) in the dominant bin; null when not applicable. */
  hueStrength: number | null;
  /** Mean hue (°) within dominant bin; null when `hueBucket` is null. */
  hueDegrees: number | null;
  /** Second-strongest separated hue bin (e.g. orange next to dominant blue). */
  hueBucketSecondary: number | null;
  /** Share of lit pixels in secondary bin. */
  hueStrengthSecondary: number | null;
}

const MIN_LUMA = 18;
const CHROMA_VIVID = 32;
const CHROMA_HUE_MIN = 14;
const CHROMATIC_RATIO_THRESHOLD = 0.032;
/** Min share of image in winning hue bin to treat axis as “dominant” (e.g. mostly blue). */
const DOMINANT_HUE_FRACTION_MIN = 0.165;
/** Secondary peak must be separated on the wheel from primary (skip adjacent-bin noise). */
const SECONDARY_MIN_RING_STEPS = 3;
/** Secondary mass vs primary mass in the histogram. */
const SECONDARY_RATIO_TO_PRIMARY_MIN = 0.18;
/** Min absolute share of image in secondary bin. */
const SECONDARY_SHARE_MIN = 0.038;

function rgbToHue255(r: number, g: number, b: number): number | null {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d < 4) return null;
  let h: number;
  if (mx === r) {
    let x = ((g - b) / d) % 6;
    if (x < 0) x += 6;
    h = 60 * x;
  } else if (mx === g) {
    h = 60 * ((b - r) / d + 2);
  } else {
    h = 60 * ((r - g) / d + 4);
  }
  return ((h % 360) + 360) % 360;
}

function argMaxHist(hist: number[]): number {
  let m = -1;
  let ib = 0;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] > m) {
      m = hist[i];
      ib = i;
    }
  }
  return ib;
}

const achromeIx = (): Omit<ThumbColorIndex, 'chromatic'> => ({
  hueBucket: null,
  hueStrength: null,
  hueDegrees: null,
  hueBucketSecondary: null,
  hueStrengthSecondary: null,
});

/**
 * Single decode of the thumbnail: chromatic-vs-mono + dominant hue axis (+ optional second peak for two-tone art).
 */
export async function computeThumbColorIndex(imagePath: string): Promise<ThumbColorIndex | null> {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  try {
    const { data, info } = await sharp(imagePath)
      .resize({
        width: 112,
        height: 112,
        fit: 'inside',
        withoutEnlargement: false,
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const ch = info.channels;
    const pixelCount = info.width * info.height;
    if (pixelCount <= 0) return null;

    if (ch === 1) {
      return { chromatic: 0, ...achromeIx() };
    }
    if (ch < 3) return null;

    const step = ch;
    let weightedStrong = 0;
    let weightSum = 0;
    const hist = new Array<number>(INDEXED_HUE_BIN_COUNT).fill(0);
    const sinB = new Array<number>(INDEXED_HUE_BIN_COUNT).fill(0);
    const cosB = new Array<number>(INDEXED_HUE_BIN_COUNT).fill(0);
    let totalLit = 0;

    for (let i = 0; i < pixelCount; i++) {
      const o = i * step;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      if (mx < MIN_LUMA) continue;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const delta = mx - mn;
      const wPx = mx / 255;
      weightSum += wPx;
      totalLit++;
      if (delta >= CHROMA_VIVID) weightedStrong += wPx;
      if (delta >= CHROMA_HUE_MIN) {
        const hue = rgbToHue255(r, g, b);
        if (hue != null) {
          const bin = Math.floor(hue / (360 / INDEXED_HUE_BIN_COUNT)) % INDEXED_HUE_BIN_COUNT;
          hist[bin]++;
          const rad = (hue * Math.PI) / 180;
          sinB[bin] += Math.sin(rad);
          cosB[bin] += Math.cos(rad);
        }
      }
    }

    if (weightSum <= 1e-6) return null;
    const chromFrac = weightedStrong / weightSum;
    const chromatic: 0 | 1 = chromFrac >= CHROMATIC_RATIO_THRESHOLD ? 1 : 0;

    if (chromatic === 0) {
      return { chromatic: 0, ...achromeIx() };
    }

    const best = argMaxHist(hist);
    const hPri = hist[best];
    const rawStrength = totalLit > 0 ? hPri / totalLit : 0;
    const hueStrength = rawStrength > 0 ? rawStrength : null;

    if (rawStrength < DOMINANT_HUE_FRACTION_MIN || hueStrength == null) {
      return {
        chromatic: 1,
        hueBucket: null,
        hueStrength,
        hueDegrees: null,
        hueBucketSecondary: null,
        hueStrengthSecondary: null,
      };
    }

    let hueDegrees: number | null = null;
    const sB = sinB[best];
    const cB = cosB[best];
    if (Math.abs(sB) > 1e-6 || Math.abs(cB) > 1e-6) {
      let deg = (Math.atan2(sB, cB) * 180) / Math.PI;
      if (deg < 0) deg += 360;
      hueDegrees = deg % 360;
    }

    const histMask = [...hist];
    histMask[best] = 0;
    const secondBest = argMaxHist(histMask);
    const hSec = hist[secondBest];
    const secondaryShare = totalLit > 0 ? hSec / totalLit : 0;
    let hueBucketSecondary: number | null = null;
    let hueStrengthSecondary: number | null = null;
    if (
      hPri > 0 &&
      secondaryShare >= SECONDARY_SHARE_MIN &&
      hSec / hPri >= SECONDARY_RATIO_TO_PRIMARY_MIN &&
      hueBinRingSteps(best, secondBest) >= SECONDARY_MIN_RING_STEPS
    ) {
      hueBucketSecondary = secondBest;
      hueStrengthSecondary = secondaryShare;
    }

    return {
      chromatic: 1,
      hueBucket: best,
      hueStrength,
      hueDegrees,
      hueBucketSecondary,
      hueStrengthSecondary,
    };
  } catch {
    return null;
  }
}

export async function classifyIndexedChromatic(imagePath: string): Promise<number | null> {
  const ix = await computeThumbColorIndex(imagePath);
  return ix?.chromatic ?? null;
}

export async function extractColors(imagePath: string): Promise<ExtractedColor[]> {
  try {
    const palette = await Vibrant.from(imagePath).getPalette();
    const colors: ExtractedColor[] = [];

    const swatches = [
      palette.Vibrant,
      palette.DarkVibrant,
      palette.LightVibrant,
      palette.Muted,
      palette.DarkMuted,
      palette.LightMuted,
    ].filter(Boolean);

    const totalPopulation = swatches.reduce((sum, s) => sum + (s?.population ?? 0), 0);

    for (const swatch of swatches) {
      if (swatch) {
        colors.push({
          hex_color: swatch.hex,
          percentage: totalPopulation > 0 ? swatch.population / totalPopulation : 0,
        });
      }
    }

    return colors.sort((a, b) => b.percentage - a.percentage).slice(0, 6);
  } catch {
    return [];
  }
}

const upsertThumbColorIndexSql = `
UPDATE images SET
  indexed_chromatic = ?,
  indexed_hue_bucket = ?,
  indexed_hue_strength = ?,
  indexed_hue_degrees = ?,
  indexed_hue_bucket_2 = ?,
  indexed_hue_strength_2 = ?,
  updated_at = datetime('now')
WHERE id = ?
`;

export async function persistThumbColorIndex(
  db: Database.Database,
  imageId: string,
  thumbPath: string | null,
): Promise<ThumbColorIndex | null> {
  if (!thumbPath) return null;
  const ix = await computeThumbColorIndex(thumbPath);
  if (!ix || (ix.chromatic !== 0 && ix.chromatic !== 1)) return ix;
  db.prepare(upsertThumbColorIndexSql).run(
    ix.chromatic,
    ix.hueBucket,
    ix.hueStrength,
    ix.hueDegrees,
    ix.hueBucketSecondary,
    ix.hueStrengthSecondary,
    imageId,
  );
  return ix;
}

export async function extractAndStoreColors(db: Database.Database, imageId: string, imagePath: string): Promise<void> {
  const [colors, ix] = await Promise.all([extractColors(imagePath), computeThumbColorIndex(imagePath)]);

  const insertStmt = db.prepare(
    'INSERT INTO image_colors (id, image_id, hex_color, percentage, sort_order) VALUES (?, ?, ?, ?, ?)',
  );

  const insertMany = db.transaction((rows: ExtractedColor[]) => {
    db.prepare('DELETE FROM image_colors WHERE image_id = ?').run(imageId);
    rows.forEach((color, index) => {
      insertStmt.run(uuid(), imageId, color.hex_color, color.percentage, index);
    });
  });

  insertMany(colors);

  if (ix && (ix.chromatic === 0 || ix.chromatic === 1)) {
    db.prepare(upsertThumbColorIndexSql).run(
      ix.chromatic,
      ix.hueBucket,
      ix.hueStrength,
      ix.hueDegrees,
      ix.hueBucketSecondary,
      ix.hueStrengthSecondary,
      imageId,
    );
  }
}

/** Retrofit chromatic + dominant-hue fields from thumbnails. */
export async function reindexAllThumbColorIndex(
  db: Database.Database,
): Promise<{ scanned: number; chromaticWritten: number }> {
  const rows = db
    .prepare(
      `
    SELECT id, thumbnail_path FROM images
    WHERE is_trashed = 0 AND thumbnail_path IS NOT NULL AND length(trim(thumbnail_path)) > 0
    `,
    )
    .all() as Array<{ id: string; thumbnail_path: string }>;

  const upd = db.prepare(upsertThumbColorIndexSql);
  let chromaticWritten = 0;
  for (let i = 0; i < rows.length; i++) {
    const ix = await computeThumbColorIndex(rows[i].thumbnail_path);
    if (ix && (ix.chromatic === 0 || ix.chromatic === 1)) {
      upd.run(
        ix.chromatic,
        ix.hueBucket,
        ix.hueStrength,
        ix.hueDegrees,
        ix.hueBucketSecondary,
        ix.hueStrengthSecondary,
        rows[i].id,
      );
      chromaticWritten++;
    }
    if (i % 48 === 47) await new Promise<void>((r) => setImmediate(r));
  }
  return { scanned: rows.length, chromaticWritten };
}

/** @deprecated use reindexAllThumbColorIndex */
export async function reindexAllIndexedChromatic(db: Database.Database) {
  const r = await reindexAllThumbColorIndex(db);
  return { scanned: r.scanned, updated: r.chromaticWritten };
}
