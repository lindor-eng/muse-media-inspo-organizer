import type Database from 'better-sqlite3';
import { BrowserWindow } from 'electron';
import { getTextEmbedding, getImageEmbedding } from './python-sidecar';

export interface SimilarResult {
  image_id: string;
  distance: number;
}

export async function searchByText(db: Database.Database, query: string, limit = 20): Promise<SimilarResult[]> {
  const embeddingCount = getEmbeddingCount(db);
  if (embeddingCount === 0) {
    console.log('[search] No embeddings found, generating for existing images...');
    await generateAllEmbeddings(db);
  }

  const embedding = await getTextEmbedding(query);
  if (!embedding) {
    console.log('[search] Failed to get text embedding for query:', query);
    return [];
  }

  return searchByVector(db, embedding, limit);
}

export async function findSimilarImages(db: Database.Database, imageId: string, limit = 20): Promise<SimilarResult[]> {
  const row = db.prepare('SELECT embedding FROM image_embeddings WHERE image_id = ?').get(imageId) as { embedding: Buffer } | undefined;
  if (!row) return [];

  const floats = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  return searchByVector(db, Array.from(floats), limit);
}

export async function generateAndStoreEmbedding(db: Database.Database, imageId: string, imagePath: string): Promise<boolean> {
  const embedding = await getImageEmbedding(imagePath);
  if (!embedding) return false;

  const buffer = Buffer.from(new Float32Array(embedding).buffer);
  db.prepare('INSERT OR REPLACE INTO image_embeddings (image_id, embedding) VALUES (?, ?)').run(imageId, buffer);
  return true;
}

function sendProgress(current: number, total: number, status: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send('embedding:progress', { current, total, status });
  }
}

async function generateAllEmbeddings(db: Database.Database): Promise<void> {
  const images = db.prepare(
    'SELECT id, original_path FROM images WHERE is_trashed = 0 AND id NOT IN (SELECT image_id FROM image_embeddings)'
  ).all() as { id: string; original_path: string }[];

  console.log(`[search] Generating embeddings for ${images.length} images...`);
  sendProgress(0, images.length, 'Loading CLIP model...');

  for (let i = 0; i < images.length; i++) {
    sendProgress(i, images.length, `Indexing image ${i + 1} of ${images.length}`);
    const ok = await generateAndStoreEmbedding(db, images[i].id, images[i].original_path);
    if (!ok) {
      console.log('[search] Failed to generate embedding, stopping batch');
      sendProgress(i, images.length, 'Embedding generation failed');
      break;
    }
  }

  sendProgress(images.length, images.length, 'Indexing complete');
  console.log('[search] Embedding generation complete, count:', getEmbeddingCount(db));
}

export function hasEmbedding(db: Database.Database, imageId: string): boolean {
  const row = db.prepare('SELECT 1 FROM image_embeddings WHERE image_id = ?').get(imageId);
  return !!row;
}

export function getEmbeddingCount(db: Database.Database): number {
  const row = db.prepare('SELECT count(*) as cnt FROM image_embeddings').get() as { cnt: number };
  return row.cnt;
}

function searchByVector(db: Database.Database, embedding: number[], limit: number): SimilarResult[] {
  const buffer = Buffer.from(new Float32Array(embedding).buffer);
  try {
    const results = db.prepare(`
      SELECT image_id, distance
      FROM image_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(buffer, limit) as SimilarResult[];
    return results;
  } catch (err) {
    console.log('[search] Vector search error:', err);
    return [];
  }
}
