import type Database from 'better-sqlite3';
import { createImageRepo } from '../database/repositories/images';
import { createTagRepo } from '../database/repositories/tags';
import { embedText, isOllamaRunning } from './ollama-client';

export function embeddingVectorToBlob(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function blobToFloat32Vector(buf: Buffer): Float32Array {
  const bytes = Uint8Array.from(buf);
  return new Float32Array(bytes.buffer);
}

export function l2Normalize(vec: number[]): number[] {
  let s = 0;
  for (const v of vec) s += v * v;
  const norm = Math.sqrt(s);
  if (!Number.isFinite(norm) || norm === 0) return vec.slice();
  return vec.map((v) => v / norm);
}

export function upsertImageEmbedding(db: Database.Database, imageId: string, vec: number[]): void {
  const blob = embeddingVectorToBlob(vec);
  db.prepare('DELETE FROM image_embeddings WHERE image_id = ?').run(imageId);
  db.prepare('INSERT INTO image_embeddings (image_id, embedding) VALUES (?, ?)').run(imageId, blob);
}

/**
 * Compose the text we embed for an image — alt text, description, and tag names —
 * so the resulting vector captures both subject and (LLaVA-described) visual attributes.
 */
export function composeEmbeddingText(
  altText: string,
  notes: string,
  tagNames: string[],
  filename?: string,
): string {
  const parts: string[] = [];
  if (altText && altText.trim()) parts.push(altText.trim());
  if (notes && notes.trim()) parts.push(notes.trim());
  if (tagNames.length > 0) parts.push(`Tags: ${tagNames.join(', ')}`);
  if (parts.length === 0 && filename) parts.push(filename);
  return parts.join('\n');
}

/**
 * Build the embedding text for an image from its current DB state and store the resulting vector.
 * Returns true if a vector was written.
 */
export async function embedAndStoreForImage(db: Database.Database, imageId: string): Promise<boolean> {
  const imageRepo = createImageRepo(db);
  const tagRepo = createTagRepo(db);
  const image = imageRepo.getById(imageId);
  if (!image) return false;

  const tags = tagRepo.getForImage(imageId);
  const text = composeEmbeddingText(
    image.alt_text || '',
    image.notes || '',
    tags.map((t) => t.name),
    image.filename,
  );
  if (!text.trim()) return false;

  if (!(await isOllamaRunning())) return false;

  const vec = await embedText(text);
  if (!vec?.length) return false;

  upsertImageEmbedding(db, imageId, l2Normalize(vec));
  return true;
}

/** Ensures a caption-derived embedding exists for the image. */
export async function ensureImageEmbedding(db: Database.Database, imageId: string): Promise<boolean> {
  const existing = db.prepare('SELECT 1 FROM image_embeddings WHERE image_id = ?').get(imageId);
  if (existing) return true;
  return embedAndStoreForImage(db, imageId);
}
