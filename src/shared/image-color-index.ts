/** 12 bins × 30° — matches main-process thumb indexing (OpenCV-style hue wheel, red at 0°). */
export const INDEXED_HUE_BIN_COUNT = 12;
export const INDEXED_HUE_BIN_WIDTH_DEG = 360 / INDEXED_HUE_BIN_COUNT;

/** Center of bin in degrees (e.g. bin 8 ≈ blue at 255°). */
export function indexedHueBucketCenterDegrees(bucket: number): number {
  const b = ((bucket % INDEXED_HUE_BIN_COUNT) + INDEXED_HUE_BIN_COUNT) % INDEXED_HUE_BIN_COUNT;
  return (b + 0.5) * INDEXED_HUE_BIN_WIDTH_DEG;
}

/** Ring distance between hue bins 0–11 (0 = same bin, 6 = opposite on the wheel). */
export function hueBinRingSteps(binA: number, binB: number): number {
  const d = Math.abs(binA - binB);
  return Math.min(d, INDEXED_HUE_BIN_COUNT - d);
}

/**
 * SQL-friendly range for “blues” (bins 7–9 ≈ 210°–300°). Tune per product if needed.
 */
export const INDEXED_HUE_SQL_BLUE_BINS_MIN = 7;
export const INDEXED_HUE_SQL_BLUE_BINS_MAX = 9;

/**
 * Fusion multiplier for Similar colors when both images report a strong dominant hue axis.
 * · Same / adjacent bins → ~1.0
 * · Opposite on the wheel → ~0.74
 * · Weak/unknown (null or strength &lt; floor) → 1.0 (no change)
 */
export function dominantHueAxisMultiplier(
  focalBucket: number | null | undefined,
  focalStrength: number | null | undefined,
  candBucket: number | null | undefined,
  candStrength: number | null | undefined,
  strengthFloor = 0.3,
): number {
  if (focalBucket == null || candBucket == null) return 1;
  if (focalStrength == null || candStrength == null) return 1;
  if (focalStrength < strengthFloor || candStrength < strengthFloor) return 1;
  const ring = hueBinRingSteps(focalBucket, candBucket);
  const mis = ring / (INDEXED_HUE_BIN_COUNT / 2);
  return 0.72 + 0.28 * (1 - mis);
}

/**
 * Boost when both images have a clear two-hue fingerprint (e.g. cobalt + orange split)
 * and those peaks align (order-invariant across orange/blue swaps).
 */
export function dualDominantHueBoost(
  focalB1: number | null | undefined,
  focalS1: number | null | undefined,
  focalB2: number | null | undefined,
  focalS2: number | null | undefined,
  candB1: number | null | undefined,
  candS1: number | null | undefined,
  candB2: number | null | undefined,
  candS2: number | null | undefined,
  sepMinBins = 3,
  primaryFloor = 0.17,
  secondaryFloor = 0.038,
): number {
  const dualF =
    typeof focalB1 === 'number' &&
    focalS1 != null &&
    focalS1 >= primaryFloor &&
    typeof focalB2 === 'number' &&
    focalS2 != null &&
    focalS2 >= secondaryFloor &&
    hueBinRingSteps(focalB1, focalB2) >= sepMinBins;
  const dualC =
    typeof candB1 === 'number' &&
    candS1 != null &&
    candS1 >= primaryFloor &&
    typeof candB2 === 'number' &&
    candS2 != null &&
    candS2 >= secondaryFloor &&
    hueBinRingSteps(candB1, candB2) >= sepMinBins;
  if (!dualF || !dualC) return 1;

  const cost12 = hueBinRingSteps(focalB1, candB1) + hueBinRingSteps(focalB2!, candB2!);
  const costX = hueBinRingSteps(focalB1, candB2!) + hueBinRingSteps(focalB2!, candB1);
  const bestPairs = Math.min(cost12, costX);
  const norm = Math.max(0, 1 - Math.min(bestPairs / 16, 1));
  return 1 + 0.158 * norm;
}
