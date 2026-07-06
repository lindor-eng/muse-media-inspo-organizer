import { Vibrant } from 'node-vibrant/node';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const db = new Database(path.join(os.homedir(), 'Library/Application Support/Muse/library/library.db'), { readonly: true });
const { thumbnail_path } = db.prepare("SELECT thumbnail_path FROM images WHERE thumbnail_path LIKE '%.webp' AND is_trashed=0 LIMIT 1").get();
console.log('thumb:', thumbnail_path.split('/').pop());

try {
  const p = await Vibrant.from(thumbnail_path).getPalette();
  console.log('direct webp: OK,', Object.values(p).filter(Boolean).length, 'swatches');
} catch (err) {
  console.log('direct webp FAILED:', String(err).slice(0, 140));
}

try {
  const png = await sharp(thumbnail_path).png().toBuffer();
  const p = await Vibrant.from(png).getPalette();
  const swatches = Object.values(p).filter(Boolean);
  console.log('sharp→png buffer: OK,', swatches.length, 'swatches, e.g.', swatches[0]?.hex);
} catch (err) {
  console.log('sharp→png buffer FAILED:', String(err).slice(0, 140));
}
