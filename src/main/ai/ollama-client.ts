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
  return parseAnalysis(data.response);
}

function parseAnalysis(response: string): ImageAnalysis {
  const altMatch = response.match(/Alt:\s*(.+)/i);
  const descMatch = response.match(/Description:\s*(.+?)(?=\nTags:|\n\n|$)/is);
  const tagsMatch = response.match(/Tags?:\s*(.+)/i);

  const altText = altMatch?.[1]?.trim() ?? '';
  const description = descMatch?.[1]?.trim() ?? response.split('\n')[0]?.trim() ?? '';
  const tags = tagsMatch
    ? tagsMatch[1].split(/[,;]+/).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1 && t.length < 30).slice(0, 10)
    : [];

  return { altText, description, tags };
}

