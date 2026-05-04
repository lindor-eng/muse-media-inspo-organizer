/**
 * Tier keys for likeness floors (CLIP dot score on normalized thumbnail embeddings).
 * Strict tightest cutoff, Close and Narrow progressively looser — `Wide` UI = no cutoff (null floor).
 *
 * Cosine/dot is similarity in roughly [-1, 1]; higher cutoff = fewer matches / higher bar.
 */
export type MatchStrengthTier = 'broad' | 'balanced' | 'strict';

/** Minimum raw CLIP cosine/dot kept for each lens (ranked list skips below cutoff). */
export const MATCH_STRENGTH_TO_MIN_COSINE: Record<MatchStrengthTier, number> = {
  /** Narrow tier — looser cutoff (formerly broad). */
  broad: 0.41,
  /** Close tier — mid cutoff (formerly balanced). */
  balanced: 0.44,
  /** Strict tier — tighter cutoff. */
  strict: 0.6,
};

/** Chip label beside metadata */
export const MATCH_TIER_LABEL: Record<MatchStrengthTier, string> = {
  broad: 'Narrow',
  balanced: 'Close',
  strict: 'Strict',
};

/** Button copy (metaphor-first) */
export const MATCH_TIER_PRESENTATION: Record<
  MatchStrengthTier,
  { heading: string; hint: string }
> = {
  broad: {
    heading: 'Narrow',
    hint: 'Looser lens — pulls in more distant visual cousins',
  },
  balanced: {
    heading: 'Close',
    hint: 'Mid cutoff — likeness without starving the strip',
  },
  strict: {
    heading: 'Strict',
    hint: 'Tighter lens — nearer neighbors only',
  },
};

/** Short headings for cramped horizontal pills */
export const MATCH_TIER_PILL_LABEL: Record<MatchStrengthTier, string> = {
  broad: 'Narrow',
  balanced: 'Close',
  strict: 'Strict',
};

/** Native tooltip text for likeness lens dropdown / scale (shown beside settings in the strip). */
export const LIKENESS_LENS_SCALE_TOOLTIP =
  'Strict tightest likeness cutoff (fewer neighbors). Close and Narrow are progressively looser. Wide (Default) applies no cutoff. With a lens, thumbnail % is headroom above that cutoff (0% at the floor). With Wide, % uses the full library scale. OpenCLIP ViT-B-32 on indexed thumbnails.';

/**
 * Rounded 0–100 badge value (floor `null` = library-scale mapping; else headroom above cutoff).
 * Used both for thumb labels and to drop 0%-display neighbors from results.
 */
export function likenessDisplayPercentRounded(
  rawCosineSimilarity: number,
  floorCosine: number | null,
): number {
  if (floorCosine === null) {
    const g = Math.max(0, Math.min(1, (rawCosineSimilarity + 1) / 2));
    return Math.round(g * 100);
  }
  const span = 1 - floorCosine;
  if (span <= 1e-6) return 100;
  const residual = Math.max(0, Math.min(1, (rawCosineSimilarity - floorCosine) / span));
  return Math.round(residual * 100);
}

/**
 * Badge %: with a likeness floor `f`, show headroom above the cutoff (at f → 0%, at 1.0 dot → 100%).
 * With no floor, map raw dot (−1…1 style) onto 0–100% as before.
 */
export function displayLikenessPercent(rawCosineSimilarity: number, floorCosine: number | null): string {
  return `${likenessDisplayPercentRounded(rawCosineSimilarity, floorCosine)}%`;
}
