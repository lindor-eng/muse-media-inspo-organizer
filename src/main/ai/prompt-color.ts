/**
 * Detect color intent in a moodboard prompt and score image palettes against it.
 * Caption text only mentions color when LLaVA happened to notice it; the stored
 * palettes (image_colors) know the truth, so color-heavy prompts blend both.
 */

export interface PromptColorIntent {
  targets: Array<{ name: string; rgb: { r: number; g: number; b: number } }>;
  wantsMonochrome: boolean;
}

type PaletteRow = { hex_color: string; percentage: number };

/** Representative RGB anchor per color family, with the words that map to it. */
const COLOR_LEXICON: Array<{ names: string[]; rgb: [number, number, number] }> = [
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

const MONOCHROME_RE = /\b(black[\s-]?and[\s-]?white|b&w|monochromes?|monochromatic|gr[ae]yscale)\b/gi;

export function extractColorIntent(prompt: string): PromptColorIntent {
  const wantsMonochrome = MONOCHROME_RE.test(prompt);
  MONOCHROME_RE.lastIndex = 0;
  // Strip monochrome phrases so "black and white" doesn't also register black + white targets.
  const stripped = prompt.replace(MONOCHROME_RE, ' ');

  const targets: PromptColorIntent['targets'] = [];
  for (const entry of COLOR_LEXICON) {
    for (const name of entry.names) {
      const re = new RegExp(`\\b${name}(?:s|es)?\\b`, 'i');
      if (re.test(stripped)) {
        targets.push({ name: entry.names[0], rgb: { r: entry.rgb[0], g: entry.rgb[1], b: entry.rgb[2] } });
        break;
      }
    }
  }
  return { targets, wantsMonochrome };
}

function hexToRgb(hexRaw: string): { r: number; g: number; b: number } | null {
  const cleaned = hexRaw.trim().replace(/^#/, '').replace(/^0x/i, '');
  if (cleaned.length !== 6) return null;
  const n = parseInt(cleaned, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbSim(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const dr = (a.r - b.r) / 255;
  const dg = (a.g - b.g) / 255;
  const db = (a.b - b.b) / 255;
  return 1 - Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3));
}

/**
 * 0..1: how much of the palette sits close to the target color, weighted by coverage.
 * Similarity below the dead zone contributes nothing so a navy UI doesn't half-match "orange".
 */
function targetCoverage(target: { r: number; g: number; b: number }, palette: PaletteRow[]): number {
  let covered = 0;
  let total = 0;
  for (const row of palette) {
    const rgb = hexToRgb(row.hex_color);
    if (!rgb) continue;
    const closeness = Math.max(0, (rgbSim(target, rgb) - 0.55) / 0.45);
    covered += closeness * row.percentage;
    total += row.percentage;
  }
  if (total <= 0) return 0;
  return Math.min(1, covered / total);
}

function weightedChroma(palette: PaletteRow[]): number | null {
  let chrom = 0;
  let weight = 0;
  for (const row of palette) {
    const rgb = hexToRgb(row.hex_color);
    if (!rgb) continue;
    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    chrom += (max === 0 ? 0 : (max - min) / max) * row.percentage;
    weight += row.percentage;
  }
  if (weight <= 0) return null;
  return chrom / weight;
}

/**
 * Score a palette against the prompt's color intent, 0..1 (0.5 ≈ neutral).
 * Returns null when the intent has no color terms or the palette is empty/unparseable.
 */
export function paletteIntentScore(intent: PromptColorIntent, palette: PaletteRow[]): number | null {
  if (palette.length === 0) return null;

  if (intent.wantsMonochrome) {
    const chroma = weightedChroma(palette);
    if (chroma == null) return null;
    // ≤0.08 chroma reads as B&W; fades out by 0.3.
    return 1 - Math.min(1, Math.max(0, (chroma - 0.08) / 0.22));
  }

  if (intent.targets.length === 0) return null;
  let sum = 0;
  for (const t of intent.targets) sum += targetCoverage(t.rgb, palette);
  return sum / intent.targets.length;
}
