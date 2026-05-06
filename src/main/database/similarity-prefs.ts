import type Database from 'better-sqlite3';
import {
  MATCH_STRENGTH_TO_MIN_COSINE,
  type MatchStrengthTier,
} from '../../shared/visual-similarity';

export { MATCH_STRENGTH_TO_MIN_COSINE };
export type { MatchStrengthTier };

export const VISUAL_SIMILARITY_PREFS_KEY = 'visual_similarity_prefs';

export interface SimilarityPrefs {
  /** null = no minimum likeness filter (rank-only list) */
  similarityFloor: MatchStrengthTier | null;
  /** Applied cosine/dot floor when similarityFloor is set */
  minCosine: number;
  maxResults: number;
}

export const DEFAULT_SIMILARITY_PREFS: SimilarityPrefs = {
  similarityFloor: null,
  minCosine: 0,
  maxResults: 14,
};

function isTier(x: unknown): x is MatchStrengthTier {
  return x === 'broad' || x === 'balanced' || x === 'strict';
}

/** Maps legacy slider-era cosine to the closest current tier */
function tierFromLegacyMinCosine(c: number): MatchStrengthTier {
  if (c <= 0.425) return 'broad';
  if (c <= 0.52) return 'balanced';
  return 'strict';
}

function normalizeLegacyTier(raw: unknown): MatchStrengthTier | undefined {
  if (isTier(raw)) return raw;
  if (raw === 'low') return 'broad';
  if (raw === 'medium') return 'balanced';
  if (raw === 'high') return 'strict';
  return undefined;
}

function resolveFloor(parsed: Record<string, unknown>, mergedFloor: unknown): MatchStrengthTier | null {
  if (Object.prototype.hasOwnProperty.call(parsed, 'similarityFloor')) {
    const v = parsed.similarityFloor;
    if (v === null) return null;
    const n = normalizeLegacyTier(v);
    return n ?? DEFAULT_SIMILARITY_PREFS.similarityFloor;
  }

  const hasLegacyFloorKeys =
    Object.prototype.hasOwnProperty.call(parsed, 'minCosineEnabled') ||
    Object.prototype.hasOwnProperty.call(parsed, 'matchStrength');

  if (hasLegacyFloorKeys) {
    if (parsed.minCosineEnabled === false) return null;
    const fromName = normalizeLegacyTier(parsed.matchStrength);
    return fromName ?? tierFromLegacyMinCosine(Number(parsed.minCosine) || MATCH_STRENGTH_TO_MIN_COSINE.balanced);
  }

  if (isTier(mergedFloor)) return mergedFloor;
  return DEFAULT_SIMILARITY_PREFS.similarityFloor;
}

function clampPrefs(p: Partial<SimilarityPrefs> & Record<string, unknown>): SimilarityPrefs {
  const merged = { ...DEFAULT_SIMILARITY_PREFS, ...p };
  const floor = resolveFloor(p, merged.similarityFloor);
  const minCosine = floor ? MATCH_STRENGTH_TO_MIN_COSINE[floor] : 0;

  const maxNr = merged.maxResults;
  return {
    similarityFloor: floor,
    minCosine,
    maxResults: Math.min(48, Math.max(4, Math.round(Number(maxNr)) || DEFAULT_SIMILARITY_PREFS.maxResults)),
  };
}

export function loadSimilarityPrefs(db: Database.Database): SimilarityPrefs {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(VISUAL_SIMILARITY_PREFS_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return { ...DEFAULT_SIMILARITY_PREFS };
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    return clampPrefs(parsed as Partial<SimilarityPrefs> & Record<string, unknown>);
  } catch {
    return { ...DEFAULT_SIMILARITY_PREFS };
  }
}

/** Merge persisted prefs + patch. Only applies `similarityFloor` / `maxResults` when those keys appear on `prefs` — avoids stale full-object coercion on repeated saves (see ipc partial updates). */
export function saveSimilarityPrefs(db: Database.Database, prefs: Partial<SimilarityPrefs>): SimilarityPrefs {
  const cur = loadSimilarityPrefs(db);
  const inc = prefs as Partial<SimilarityPrefs> & Record<string, unknown>;

  let similarityFloor: MatchStrengthTier | null = cur.similarityFloor;
  if (Object.prototype.hasOwnProperty.call(inc, 'similarityFloor')) {
    const v = inc.similarityFloor;
    if (v === null) {
      similarityFloor = null;
    } else if (v === undefined) {
      similarityFloor = cur.similarityFloor;
    } else {
      const n = normalizeLegacyTier(v);
      similarityFloor = n !== undefined ? n : cur.similarityFloor;
    }
  }

  let maxResults = cur.maxResults;
  if (Object.prototype.hasOwnProperty.call(inc, 'maxResults')) {
    const raw = Number(inc.maxResults);
    maxResults = Math.min(
      48,
      Math.max(
        4,
        Number.isFinite(raw) && Math.round(raw) > 0
          ? Math.round(raw)
          : DEFAULT_SIMILARITY_PREFS.maxResults,
      ),
    );
  }

  const next: SimilarityPrefs = {
    similarityFloor,
    minCosine: similarityFloor !== null ? MATCH_STRENGTH_TO_MIN_COSINE[similarityFloor] : 0,
    maxResults,
  };

  db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    VISUAL_SIMILARITY_PREFS_KEY,
    JSON.stringify(next),
  );
  return next;
}
