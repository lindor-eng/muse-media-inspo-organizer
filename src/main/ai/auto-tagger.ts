import type Database from 'better-sqlite3';
import { analyzeImage, analyzeVideo, isOllamaRunning } from './ollama-client';
import { createTagRepo } from '../database/repositories/tags';
import { createImageRepo } from '../database/repositories/images';
import { buildContactSheet, isVideoDecoderAvailable } from '../video';
import { formatDuration, isVideoFileType } from '../../shared/media-type';

/** Bump when the vision model or caption prompt changes — rows below this get re-analyzed on startup. */
export const CAPTIONS_VERSION = 2;

export interface AutoTagOptions {
  /**
   * Refresh mode (model/prompt upgrades): stale auto-tags and the model-written description
   * are replaced instead of accumulated. Manual tags and user-edited notes are never touched —
   * we only overwrite notes when they exactly match the previous model's description.
   */
  refresh?: boolean;
}

export async function autoTagImage(
  db: Database.Database,
  imageId: string,
  options?: AutoTagOptions,
): Promise<string[]> {
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

  // Stills are captioned from the thumbnail; videos need the original, since the thumbnail is
  // a single poster frame and the whole point is to read the clip's motion.
  const isVideo = isVideoFileType(image.file_type);
  const imagePath = image.thumbnail_path || image.original_path;

  try {
    let analysis;
    if (isVideo) {
      if (!isVideoDecoderAvailable()) {
        console.warn('[auto-tagger] video decoder unavailable, skipping', imageId);
        return [];
      }
      const sheet = await buildContactSheet(image.original_path, image.duration_ms);
      analysis = await analyzeVideo(sheet.png, {
        durationLabel: formatDuration(image.duration_ms),
        frameCount: sheet.timestampsSeconds.length,
      });
    } else {
      analysis = await analyzeImage(imagePath);
    }
    console.log('[auto-tagger]', imageId, 'altText:', JSON.stringify(analysis.altText.slice(0, 80)));

    if (analysis.altText) {
      const updated = imageRepo.update(imageId, { alt_text: analysis.altText });
      console.log('[auto-tagger] wrote alt_text, now:', JSON.stringify((updated.alt_text || '').slice(0, 80)));
    } else {
      console.warn('[auto-tagger] empty altText, skipping write for', imageId);
    }

    // Notes have no edit UI — they're always model-written, so refresh can safely replace them.
    if (analysis.description && (!image.notes || options?.refresh)) {
      imageRepo.update(imageId, { notes: analysis.description });
    }

    if (options?.refresh) {
      db.prepare('DELETE FROM image_tags WHERE image_id = ? AND is_auto = 1').run(imageId);
    }

    const addedTags: string[] = [];
    for (const tagName of analysis.tags) {
      const tag = tagRepo.create(tagName);
      tagRepo.addToImage(imageId, tag.id, true, 0.8);
      addedTags.push(tagName);
    }

    imageRepo.setCaptionsVersion(imageId, CAPTIONS_VERSION);
    return addedTags;
  } catch (err) {
    console.error('Auto-tag failed for', imageId, err);
    return [];
  }
}
