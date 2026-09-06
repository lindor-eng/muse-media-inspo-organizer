import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getOllamaHost } from './ollama-server';

const getBaseUrl = () => getOllamaHost();

export interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Vision + generation model. Qwen3-VL replaces LLaVA for its far stronger OCR and
 * screenshot/layout understanding — most of this library is UI shots and graphic design,
 * and caption text is what search embeddings are built from. Must be the -instruct
 * variant: the base qwen3-vl:8b is a thinking model and Ollama 0.23 ignores
 * `think: false` for it, burning the whole num_predict budget on chain-of-thought
 * (~58s/image with empty responses vs ~7s with instruct).
 */
export const VISION_MODEL = 'qwen3-vl:8b-instruct';

export async function unloadModel(): Promise<void> {
  try {
    await fetch(`${getBaseUrl()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: VISION_MODEL, keep_alive: 0 }),
    });
  } catch {
    // Non-critical
  }
}

const EMBED_MODEL = 'nomic-embed-text';
/** nomic-embed-text returns 768-dim vectors. Cached from the first successful call. */
let cachedEmbedDim: number | null = null;

/**
 * nomic-embed-text is trained with task-instruction prefixes: corpus text must be embedded
 * as `search_document: …` and queries as `search_query: …`. Omitting them puts both sides
 * in the same (wrong) region of the space and measurably degrades retrieval.
 */
export const EMBED_QUERY_PREFIX = 'search_query: ';
export const EMBED_DOCUMENT_PREFIX = 'search_document: ';

/** Embed user query text (prompt, search bar input) for retrieval against document embeddings. */
export function embedQuery(text: string): Promise<number[] | null> {
  return embedText(text ? EMBED_QUERY_PREFIX + text : text);
}

/** Embed corpus text (caption + notes + tags) for storage in the search index. */
export function embedDocument(text: string): Promise<number[] | null> {
  return embedText(text ? EMBED_DOCUMENT_PREFIX + text : text);
}

export function getEmbedDim(): number | null {
  return cachedEmbedDim;
}

export async function embedText(text: string): Promise<number[] | null> {
  if (!text) return null;
  try {
    const res = await fetch(`${getBaseUrl()}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!res.ok) {
      console.warn('[ollama] embed failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = (await res.json()) as { embedding?: number[] };
    if (!data.embedding?.length) return null;
    if (cachedEmbedDim === null) cachedEmbedDim = data.embedding.length;
    return data.embedding;
  } catch (err) {
    console.warn('[ollama] embed error:', err);
    return null;
  }
}

/**
 * HyDE-style prompt expansion: ask the vision model's LLM side (text-only call) to write
 * hypothetical alt-text captions for images that would match the moodboard brief. Library
 * embeddings are built from model-written captions, so matching that register closes the
 * design-brief → caption vocabulary gap. Returns [] on any failure — callers fall back to
 * the direct query embedding.
 */
export async function generateHypotheticalCaptions(brief: string, count = 3): Promise<string[]> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: `You write alt-text captions for images in a design library.
A user is building a moodboard described as: "${brief}"

Write ${count} captions, each describing a DIFFERENT image that would fit this moodboard perfectly. Write in plain alt-text style: 1-2 sentences naming concrete subjects, setting, colors, and lighting. No preamble.

Respond with exactly ${count} lines, numbered like "1. ..."`,
        stream: false,
        options: { temperature: 0.7, num_predict: 260 },
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { response?: string };
    if (!data.response) return [];
    return data.response
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, '').trim())
      .filter((line) => line.length >= 20 && line.length <= 400)
      .slice(0, count);
  } catch (err) {
    console.warn('[ollama] caption expansion failed:', err);
    return [];
  }
}

export interface MoodboardIntent {
  /** 1-3 distinct positive visual themes; single coherent brief = 1 facet. */
  facets: string[];
  /** Subjects the brief says to avoid, as short lowercase keywords. */
  exclusions: string[];
  /** Colors the brief expresses intent about, with representative hexes. */
  colors: Array<{ name: string; hex: string }>;
  monochrome: boolean;
}

/**
 * Decompose a moodboard brief via structured output (Ollama JSON-schema `format`).
 * Facets let multi-theme briefs search each theme separately; exclusions feed the
 * lexical filter and vision rerank; colors replace the static regex lexicon (which
 * can't parse "pastel", "jewel tones", etc.). Returns null on any failure — callers
 * fall back to whole-brief search + regex color detection.
 */
export async function parseMoodboardIntent(brief: string): Promise<MoodboardIntent | null> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: `You parse moodboard briefs for a design-library image search.
Brief: "${brief}"

Decompose it. Rules:
- facets: the DISTINCT visual themes the user EXPLICITLY asks for, each a self-contained positive search phrase. Split ONLY on an explicit conjunction of different subjects ("X and Y", "X, Y"). A single theme = exactly 1 facet equal to the brief. NEVER invent variations or paraphrases of one theme. Never put a negation in facets.
- exclusions: the X from every explicit negation in the brief — "no X", "without X", "avoid X" — as short lowercase phrases (e.g. brief ends "..., no people" → exclusions ["people"]). Extract every negated X, but NEVER add anything the brief doesn't negate; no negations → empty array.
- colors: ONLY colors the brief itself mentions, each with a representative hex. No color words in the brief → empty array. monochrome=true only for black-and-white/grayscale briefs.`,
        stream: false,
        format: {
          type: 'object',
          properties: {
            facets: { type: 'array', items: { type: 'string' }, maxItems: 3 },
            exclusions: { type: 'array', items: { type: 'string' } },
            colors: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, hex: { type: 'string' } },
                required: ['name', 'hex'],
              },
            },
            monochrome: { type: 'boolean' },
          },
          required: ['facets', 'exclusions', 'colors', 'monochrome'],
        },
        options: { temperature: 0.2, num_predict: 300 },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    if (!data.response) return null;
    const parsed = JSON.parse(data.response) as MoodboardIntent;
    const facets = (parsed.facets ?? [])
      .map((f) => String(f).trim())
      .filter((f) => f.length >= 3 && !/^(no|without)\s/i.test(f))
      .slice(0, 3);
    return {
      facets: facets.length > 0 ? facets : [brief],
      exclusions: (parsed.exclusions ?? []).map((e) => String(e).trim().toLowerCase()).filter((e) => e.length >= 2),
      colors: (parsed.colors ?? []).filter((c) => /^#?[0-9a-f]{6}$/i.test(String(c?.hex ?? '').trim())),
      monochrome: Boolean(parsed.monochrome),
    };
  } catch (err) {
    console.warn('[ollama] intent parse failed:', err);
    return null;
  }
}

/**
 * Show the vision model a candidate thumbnail and ask how well it fits the brief (0-10,
 * exclusions force low scores). ~3-5s/image — only called for the uncertainty band in
 * high-accuracy mode. Returns null on failure so callers keep the image (fail-open:
 * a broken scorer must never empty a board).
 */
export async function scoreImageFit(
  imagePath: string,
  brief: string,
  exclusions: string[],
): Promise<number | null> {
  try {
    const base64Image = await toBase64(imagePath);
    const excludeLine = exclusions.length > 0 ? `\nMust NOT contain: ${exclusions.join(', ')}` : '';
    const res = await fetch(`${getBaseUrl()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: `You are judging whether an image belongs on a moodboard.
Moodboard brief: "${brief}"${excludeLine}

Score how well THIS image fits the brief, 0-10 (10 = perfect fit, 0 = unrelated or contains excluded content). Reason must be ONE short sentence, under 15 words.`,
        images: [base64Image],
        stream: false,
        format: {
          type: 'object',
          properties: {
            score: { type: 'integer', minimum: 0, maximum: 10 },
            reason: { type: 'string', maxLength: 120 },
          },
          required: ['score', 'reason'],
        },
        options: { temperature: 0.1, num_predict: 220 },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    if (!data.response) return null;
    let score: number | undefined;
    try {
      score = (JSON.parse(data.response) as { score?: number }).score;
    } catch {
      // Truncated JSON (model overran the token budget mid-reason) — salvage the score,
      // which the model reliably emits first.
      const m = data.response.match(/"score"\s*:\s*(\d+)/);
      if (m) score = Number(m[1]);
    }
    return typeof score === 'number' && Number.isFinite(score)
      ? Math.max(0, Math.min(10, Math.round(score)))
      : null;
  } catch (err) {
    console.warn('[ollama] image fit scoring failed:', err);
    return null;
  }
}

export async function getAvailableModels(): Promise<string[]> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.models?.map((m: { name: string }) => m.name) ?? [];
  } catch {
    return [];
  }
}

export interface ImageAnalysis {
  altText: string;
  description: string;
  tags: string[];
}

export async function describeImage(imagePath: string): Promise<string> {
  const result = await analyzeImage(imagePath);
  return result.description + '\nTags: ' + result.tags.join(', ');
}

/**
 * 1024px: Qwen3-VL's dynamic-resolution encoder actually uses the extra pixels to read UI text
 * and small type that were illegible at 768.
 */
const VISION_MAX_DIM = 1024;

/**
 * A video contact sheet carries six frames in one image, so each cell only gets a third of the
 * width. Sending the sheet at 1536 keeps every cell at ~512px — roughly the detail a 2x2 grid
 * would get at the still budget — which is what makes on-screen text in a screen recording
 * still readable to the model.
 */
const VISION_SHEET_MAX_DIM = 1536;

async function toBase64(image: string | Buffer, maxDim = VISION_MAX_DIM): Promise<string> {
  // Always convert through sharp to ensure compatible format and reasonable size.
  const buffer = await sharp(image)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return buffer.toString('base64');
}

export async function analyzeImage(imagePath: string): Promise<ImageAnalysis> {
  console.log('[ollama] analyzeImage:', imagePath);
  const base64Image = await toBase64(imagePath);
  console.log('[ollama] base64 length:', base64Image.length);

  const res = await fetch(`${getBaseUrl()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      prompt: `Analyze this image for a designer's reference library and respond in exactly this format, with each field on its own line:
Alt: [1-2 sentences describing the image for accessibility, under 200 characters. Be specific about subjects, actions, and setting.]
Description: [3-4 sentences for design search. Name the medium (photo, UI screenshot, poster, illustration, 3D render, mockup). Quote prominent visible text verbatim. Describe typography (serif/sans, weight, size contrast), layout and composition (grid, whitespace, alignment, focal point), color palette with specific hues, lighting, texture, and any era or style influence (e.g. Swiss, brutalist, Y2K, editorial, skeuomorphic).]
Tags: [8-14 comma-separated keyword tags covering subject, medium, style movement, mood, dominant colors, typography traits, and notable techniques]`,
      images: [base64Image],
      stream: false,
      options: { temperature: 0.3, num_ctx: 4096 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  }

  const data: OllamaGenerateResponse = await res.json();
  console.log('[ollama] raw response:', data.response);
  const parsed = parseAnalysis(data.response);
  console.log('[ollama] parsed:', { altLen: parsed.altText.length, descLen: parsed.description.length, tagCount: parsed.tags.length });
  return parsed;
}

/**
 * Captions a video from a contact sheet of frames sampled across its duration.
 *
 * The prompt spends most of its effort on one problem: the model is looking at a grid, and
 * left alone it will describe the grid ("a six-panel collage…"), which is useless as alt text
 * for the clip. So the frames are named as a filmstrip, the grid is explicitly ruled out of
 * the output, and the alt line is asked for in the present tense a screen reader user expects.
 * What the extra frames buy over a single poster is change over time — a caption that says
 * what happens, not just what the first frame looked like.
 */
export async function analyzeVideo(
  sheet: Buffer,
  info: { durationLabel: string | null; frameCount: number },
): Promise<ImageAnalysis> {
  const base64Sheet = await toBase64(sheet, VISION_SHEET_MAX_DIM);
  const lengthNote = info.durationLabel ? ` The clip runs ${info.durationLabel}.` : '';

  const res = await fetch(`${getBaseUrl()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      prompt: `This image is a filmstrip: ${info.frameCount} frames taken from a single video at even intervals, in chronological order, reading left to right then top to bottom.${lengthNote}

Describe THE VIDEO, not the filmstrip. Never mention frames, panels, grids, collages, stills, or the layout of this image. Treat what changes between frames as motion within one continuous clip, and what stays the same as the scene it holds throughout.

Respond in exactly this format, with each field on its own line:
Alt: [1-2 sentences describing the video for a screen reader user, under 200 characters. Present tense. Say what is shown and what happens — the subject, the setting, and the main action or change across the clip. No "video of" or "clip showing" preamble; describe it directly.]
Description: [3-4 sentences for design search. Name the medium (screen recording, UI prototype, motion graphic, live-action footage, 3D animation, title sequence). Quote prominent on-screen text verbatim. Describe what moves and how (camera move, cut, transition, UI interaction, looping animation), plus typography, layout, color palette with specific hues, lighting, texture, and any era or style influence.]
Tags: [8-14 comma-separated keyword tags covering subject, medium, motion technique, style movement, mood, dominant colors, and typography traits]`,
      images: [base64Sheet],
      stream: false,
      options: { temperature: 0.3, num_ctx: 4096 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  }

  const data: OllamaGenerateResponse = await res.json();
  console.log('[ollama] raw video response:', data.response);
  const parsed = parseAnalysis(data.response);
  console.log('[ollama] parsed video:', {
    altLen: parsed.altText.length,
    descLen: parsed.description.length,
    tagCount: parsed.tags.length,
  });
  return parsed;
}

function cleanField(raw: string): string {
  return raw
    .replace(/^\**\s*/, '')        // strip leading markdown bold
    .replace(/\**\s*$/, '')        // strip trailing markdown bold
    .replace(/^\[|\]$/g, '')       // strip wrapping brackets
    .replace(/^["']|["']$/g, '')   // strip wrapping quotes
    .trim();
}

function parseTagList(raw: string): string[] {
  return cleanField(raw)
    .split(/[,;]+/)
    .map((t) => t.trim().toLowerCase().replace(/^[#*-]\s*/, ''))
    .filter((t) => t.length > 1 && t.length < 30)
    .slice(0, 14);
}

function parseAnalysis(response: string): ImageAnalysis {
  // Match "Alt:", "**Alt:**", "Alt text:", or "Alt-text:" at start of a line.
  const altMatch = response.match(/^\s*\**\s*alt(?:[\s-]?text)?\s*:\**\s*(.+)/im);
  const descMatch = response.match(/^\s*\**\s*description\s*:\**\s*(.+?)(?=\n\s*\**\s*tags?\s*:|\n\n|$)/ims);
  const tagsMatch = response.match(/^\s*\**\s*tags?\s*:\**\s*(.+)/im);

  let altText = altMatch ? cleanField(altMatch[1]) : '';
  let description = descMatch ? cleanField(descMatch[1]) : '';
  let tags = tagsMatch ? parseTagList(tagsMatch[1]) : [];

  // Qwen sometimes runs "Tags: ..." onto the end of the Description paragraph instead
  // of a new line — peel it off so both fields survive.
  if (tags.length === 0 && description) {
    const inline = description.match(/^(.*?)[\s.]*\btags\s*:\s*(.+)$/is);
    if (inline) {
      description = inline[1].trim();
      tags = parseTagList(inline[2]);
    }
  }

  // Fallback: model emitted free-form prose with only a Tags: line. Treat everything before Tags: as description.
  if (!description && !altText) {
    const tagsIdx = tagsMatch ? response.search(/^\s*\**\s*tags?\s*:/im) : -1;
    const body = tagsIdx >= 0 ? response.slice(0, tagsIdx) : response;
    description = body.trim().replace(/\s+/g, ' ');
  }

  // Fallback: derive alt from the first sentence of the description.
  if (!altText && description) {
    const firstSentence = description.split(/(?<=[.!?])\s+/)[0] ?? description;
    altText = firstSentence.slice(0, 200).trim();
  }

  return { altText, description, tags };
}

