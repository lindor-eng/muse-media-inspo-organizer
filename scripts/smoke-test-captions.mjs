/**
 * Smoke-test a candidate vision model + enriched caption prompt against a handful of
 * library images, side-by-side with the caption output already stored in the DB.
 * Verifies: (a) the model answers in the Alt/Description/Tags format parseAnalysis expects,
 * (b) caption quality/design-vocabulary actually improves.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-test-captions.mjs
 */
import Database from 'better-sqlite3';
import sharp from 'sharp';
import os from 'node:os';
import path from 'node:path';

const OLLAMA = 'http://127.0.0.1:11434';
const CANDIDATE_MODEL = 'qwen3-vl:8b-instruct';

const DB_PATH = path.join(os.homedir(), 'Library/Application Support/Muse/library/library.db');

const IMAGE_IDS = [
  'ebddc66e-8063-4432-9bde-535c81748cf9', // B&W "RCM" graphic — typography/OCR
  '1f58242a-0716-4878-bd74-62f641c72c33', // product website screenshot — layout
  'dead1539-3a59-44cd-a0b1-ad10e488f9a8', // guitarist on bench — photography
  'e1b64655-f4cf-4d1e-8aaa-e1f8ccec7f0e', // phone mockups, music player — UI mockup
  '2cd704fb-0052-4752-8c2e-bab3a4b74c10', // vintage camera — product/era
];

// Enriched prompt — same 3-field envelope as production parseAnalysis, richer instructions.
const ENRICHED_PROMPT = `Analyze this image for a designer's reference library and respond in exactly this format, with each field on its own line:
Alt: [1-2 sentences describing the image for accessibility, under 200 characters. Be specific about subjects, actions, and setting.]
Description: [3-4 sentences for design search. Name the medium (photo, UI screenshot, poster, illustration, 3D render, mockup). Quote prominent visible text verbatim. Describe typography (serif/sans, weight, size contrast), layout and composition (grid, whitespace, alignment, focal point), color palette with specific hues, lighting, texture, and any era or style influence (e.g. Swiss, brutalist, Y2K, editorial, skeuomorphic).]
Tags: [8-14 comma-separated keyword tags covering subject, medium, style movement, mood, dominant colors, typography traits, and notable techniques]`;

// Production parser, copied verbatim from src/main/ai/ollama-client.ts parseAnalysis.
function cleanField(raw) {
  return raw
    .replace(/^\**\s*/, '')
    .replace(/\**\s*$/, '')
    .replace(/^\[|\]$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}
function parseTagList(raw) {
  return cleanField(raw)
    .split(/[,;]+/)
    .map((t) => t.trim().toLowerCase().replace(/^[#*-]\s*/, ''))
    .filter((t) => t.length > 1 && t.length < 30)
    .slice(0, 14);
}
function parseAnalysis(response) {
  const altMatch = response.match(/^\s*\**\s*alt(?:[\s-]?text)?\s*:\**\s*(.+)/im);
  const descMatch = response.match(/^\s*\**\s*description\s*:\**\s*(.+?)(?=\n\s*\**\s*tags?\s*:|\n\n|$)/ims);
  const tagsMatch = response.match(/^\s*\**\s*tags?\s*:\**\s*(.+)/im);
  let altText = altMatch ? cleanField(altMatch[1]) : '';
  let description = descMatch ? cleanField(descMatch[1]) : '';
  let tags = tagsMatch ? parseTagList(tagsMatch[1]) : [];
  if (tags.length === 0 && description) {
    const inline = description.match(/^(.*?)[\s.]*\btags\s*:\s*(.+)$/is);
    if (inline) {
      description = inline[1].trim();
      tags = parseTagList(inline[2]);
    }
  }
  if (!description && !altText) {
    const tagsIdx = tagsMatch ? response.search(/^\s*\**\s*tags?\s*:/im) : -1;
    const body = tagsIdx >= 0 ? response.slice(0, tagsIdx) : response;
    description = body.trim().replace(/\s+/g, ' ');
  }
  if (!altText && description) {
    const firstSentence = description.split(/(?<=[.!?])\s+/)[0] ?? description;
    altText = firstSentence.slice(0, 200).trim();
  }
  return { altText, description, tags };
}

async function toBase64(imagePath, maxDim) {
  const buf = await sharp(imagePath)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return buf.toString('base64');
}

async function generate(model, prompt, base64Image, extra = {}) {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [base64Image],
      stream: false,
      options: { temperature: 0.3, num_ctx: 4096 },
      ...extra,
    }),
  });
  if (!res.ok) throw new Error(`${model}: ${res.status} ${await res.text()}`);
  return res.json();
}

const db = new Database(DB_PATH, { readonly: true });
const getImg = db.prepare(
  'SELECT id, filename, original_path, thumbnail_path, alt_text, notes FROM images WHERE id = ?',
);

for (const id of IMAGE_IDS) {
  const img = getImg.get(id);
  if (!img) {
    console.log(`SKIP ${id} — not found`);
    continue;
  }
  const src = img.thumbnail_path || img.original_path;
  console.log('='.repeat(100));
  console.log(`IMAGE: ${img.filename}`);
  console.log(`\n--- stored alt ---\n${img.alt_text || '(none)'}`);
  console.log(`--- stored notes ---\n${(img.notes || '(none)').slice(0, 300)}`);

  const b64 = await toBase64(src, 1024);
  const t0 = Date.now();
  const data = await generate(CANDIDATE_MODEL, ENRICHED_PROMPT, b64);
  const ms = Date.now() - t0;

  const raw = data.response || '';
  const parsed = parseAnalysis(raw);
  console.log(`\n--- ${CANDIDATE_MODEL} (${ms}ms) RAW ---\n${raw.slice(0, 1200)}`);
  console.log(`\n--- PARSED ---`);
  console.log(`alt (${parsed.altText.length} ch): ${parsed.altText}`);
  console.log(`desc (${parsed.description.length} ch): ${parsed.description.slice(0, 500)}`);
  console.log(`tags (${parsed.tags.length}): ${parsed.tags.join(', ')}`);
  const ok = parsed.altText.length > 10 && parsed.description.length > 40 && parsed.tags.length >= 5;
  console.log(`PARSE ${ok ? 'OK' : '*** PROBLEM ***'}`);
}
