import type Database from 'better-sqlite3';
import { analyzeImage, isOllamaRunning } from './ollama-client';
import { createTagRepo } from '../database/repositories/tags';
import { createImageRepo } from '../database/repositories/images';

export async function autoTagImage(db: Database.Database, imageId: string): Promise<string[]> {
  const running = await isOllamaRunning();
  if (!running) return [];

  const imageRepo = createImageRepo(db);
  const tagRepo = createTagRepo(db);
  const image = imageRepo.getById(imageId);
  if (!image) return [];

  const imagePath = image.thumbnail_path || image.original_path;

  try {
    const analysis = await analyzeImage(imagePath);

    if (analysis.altText) {
      imageRepo.update(imageId, { alt_text: analysis.altText });
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
