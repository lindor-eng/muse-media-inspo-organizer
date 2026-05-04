import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { createImageRepo } from '../database/repositories/images';
import { getImageEmbedding, isSidecarRunning, startSidecar } from './python-sidecar';

export function embeddingVectorToBlob(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function blobToFloat32Vector(buf: Buffer): Float32Array {
  const bytes = Uint8Array.from(buf);
  return new Float32Array(bytes.buffer);
}

export function upsertImageEmbedding(db: Database.Database, imageId: string, vec: number[]): void {
  const blob = embeddingVectorToBlob(vec);
  db.prepare(
    `
    INSERT INTO image_embeddings (image_id, embedding)
    VALUES (?, ?)
    ON CONFLICT(image_id) DO UPDATE SET
      embedding = excluded.embedding,
      created_at = datetime('now')
    `
  ).run(imageId, blob);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Ensures CLIP embedding exists for the image; triggers Python sidecar if needed. */
export async function ensureImageEmbedding(db: Database.Database, imageId: string): Promise<boolean> {
  const existing = db.prepare('SELECT 1 FROM image_embeddings WHERE image_id = ?').get(imageId);
  if (existing) return true;

  const imageRepo = createImageRepo(db);
  const row = imageRepo.getById(imageId);
  if (!row) return false;

  const imagePath = row.thumbnail_path || row.original_path;
  if (!imagePath || !fs.existsSync(imagePath)) return false;

  if (!isSidecarRunning()) {
    startSidecar();
    await sleep(2800);
  }

  let vec = await getImageEmbedding(imagePath);
  if (!vec?.length) {
    await sleep(1500);
    vec = await getImageEmbedding(imagePath);
  }

  if (!vec?.length) return false;

  upsertImageEmbedding(db, imageId, vec);
  return true;
}
