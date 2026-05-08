/** Ephemeral refinement for similar-image ranking (session-only UI). At most one mode per request. */

export const SIMILAR_REFINE_MODES = ['colors'] as const;

export type SimilarRefineMode = (typeof SIMILAR_REFINE_MODES)[number];

/** Long-form help for refinement chips / inspector tooltips. */
export const REFINE_MODE_HELP: Record<SimilarRefineMode, string> = {
  colors:
    'Similar colors: Re-ranks by extracted palette overlap and dominant-hue agreement. Useful when you want to find images that share the same chromatic mood, even if their subjects differ.',
};

export function combinedRefinementHelp(): string {
  return SIMILAR_REFINE_MODES.map((m) => REFINE_MODE_HELP[m]).join('\n\n');
}

/** At most one mode — similar-strip radio (first recognized entry wins if callers send extras). */
export function parseSimilarRefineModes(raw: unknown): SimilarRefineMode[] {
  if (!Array.isArray(raw)) return [];
  for (const x of raw) {
    if (x === 'colors') {
      return [x];
    }
  }
  return [];
}
