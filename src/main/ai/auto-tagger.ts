import type Database from 'better-sqlite3';
import { analyzeImage, isOllamaRunning } from './ollama-client';
import { createTagRepo } from '../database/repositories/tags';
import { createImageRepo } from '../database/repositories/images';

export async function autoTagImage(db: Database.Database, imageId: string): Promise<string[]> {
  const running = await isOllamaRunning();
  if (!running) {
    console.warn('[auto-tagger] Ollama not running, skipping', imageId);
    return [];
  }

  const imageRepo = createImageRepo(db);
  const tagRepo = createTagRepo(db);
  const image = imageRepo.getById(imageId);
  if (!image) {
    console.warn('[auto-tagger] image not found', imageId);
    return [];
  }

  const imagePath = image.thumbnail_path || image.original_path;

  try {
    const analysis = await analyzeImage(imagePath);
    console.log('[auto-tagger]', imageId, 'altText:', JSON.stringify(analysis.altText.slice(0, 80)));

    if (analysis.altText) {
      const updated = imageRepo.update(imageId, { alt_text: analysis.altText });
      console.log('[auto-tagger] wrote alt_text, now:', JSON.stringify((updated.alt_text || '').slice(0, 80)));
    } else {
      console.warn('[auto-tagger] empty altText, skipping write for', imageId);
    }

    if (analysis.description && !image.notes) {
      imageRepo.update(imageId, { notes: analysis.description });
    }

    const addedTags: string[] = [];
    for (const tagName of analysis.tags) {
      const tag = tagRepo.create(tagName);
      tagRepo.addToImage(imageId, tag.id, true, 0.8);
      addedTags.push(tagName);
    }

    return addedTags;
  } catch (err) {
    console.error('Auto-tag failed for', imageId, err);
    return [];
  }
}
