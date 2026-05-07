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

export async function unloadModel(): Promise<void> {
  try {
    await fetch(`${getBaseUrl()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llava:7b-v1.6-mistral-q4_K_M', keep_alive: 0 }),
    });
  } catch {
    // Non-critical
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

async function getImageAsBase64(imagePath: string): Promise<string> {
  // Always convert through sharp to ensure compatible format and reasonable size
  const buffer = await sharp(imagePath)
    .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return buffer.toString('base64');
}

export async function analyzeImage(imagePath: string): Promise<ImageAnalysis> {
  console.log('[ollama] analyzeImage:', imagePath);
  const base64Image = await getImageAsBase64(imagePath);
  console.log('[ollama] base64 length:', base64Image.length);

  const res = await fetch(`${getBaseUrl()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llava:7b-v1.6-mistral-q4_K_M',
      prompt: `Analyze this image and respond in exactly this format:
Alt: [1-2 sentences describing the image for accessibility, under 200 characters. Be specific about subjects, actions, and setting.]
Description: [2-3 sentences describing the content, style, and mood]
Tags: [5-10 comma-separated keyword tags for subject, style, mood, colors, medium]`,
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

function cleanField(raw: string): string {
  return raw
    .replace(/^\**\s*/, '')        // strip leading markdown bold
    .replace(/\**\s*$/, '')        // strip trailing markdown bold
    .replace(/^\[|\]$/g, '')       // strip wrapping brackets
    .replace(/^["']|["']$/g, '')   // strip wrapping quotes
    .trim();
}

function parseAnalysis(response: string): ImageAnalysis {
  // Match "Alt:", "**Alt:**", "Alt text:", or "Alt-text:" at start of a line.
  const altMatch = response.match(/^\s*\**\s*alt(?:[\s-]?text)?\s*:\**\s*(.+)/im);
  const descMatch = response.match(/^\s*\**\s*description\s*:\**\s*(.+?)(?=\n\s*\**\s*tags?\s*:|\n\n|$)/ims);
  const tagsMatch = response.match(/^\s*\**\s*tags?\s*:\**\s*(.+)/im);

  let altText = altMatch ? cleanField(altMatch[1]) : '';
  let description = descMatch ? cleanField(descMatch[1]) : '';
  const tags = tagsMatch
    ? cleanField(tagsMatch[1])
        .split(/[,;]+/)
        .map((t) => t.trim().toLowerCase().replace(/^[#*-]\s*/, ''))
        .filter((t) => t.length > 1 && t.length < 30)
        .slice(0, 10)
    : [];

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

