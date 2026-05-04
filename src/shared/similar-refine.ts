/** Ephemeral refinement for CLIP NN similar-image ranking (session-only UI). At most one mode per request. */

export const SIMILAR_REFINE_MODES = ['colors', 'layout', 'format'] as const;

export type SimilarRefineMode = (typeof SIMILAR_REFINE_MODES)[number];

/** Long-form help for refinement chips / inspector tooltips. */
export const REFINE_MODE_HELP: Record<SimilarRefineMode, string> = {
  colors:
    'Similar colors: Compares exported palettes and three CLIP probes (vivid, neutral, achromatic) blended from the focal median chroma and embedding. Monochrome sources down-rank saturated neighbors; median chroma resists one bright accidental swatch.',
  layout:
    'Similar layout: Re-ranks with CLIP “layout/composition” text plus aspect-ratio overlap. CLIP is approximate; this only refines the shortlist.',
  format:
    'Similar format: Re-ranks with CLIP “format” cues plus aspect ratio and MIME-type heuristics.',
};

export function combinedRefinementHelp(): string {
  return SIMILAR_REFINE_MODES.map((m) => REFINE_MODE_HELP[m]).join('\n\n');
}

/** At most one mode — similar-strip radio (first recognized entry wins if callers send extras). */
export function parseSimilarRefineModes(raw: unknown): SimilarRefineMode[] {
  if (!Array.isArray(raw)) return [];
  for (const x of raw) {
    if (x === 'colors' || x === 'layout' || x === 'format') {
      return [x];
    }
  }
  return [];
}
