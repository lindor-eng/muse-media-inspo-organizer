// One-shot palette + hue-index backfill mirroring the FIXED extractAndStoreColors
// (sharp→png before Vibrant). Run while Muse is closed.
import { Vibrant } from 'node-vibrant/node';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const db = new Database(process.argv[2] ?? path.join(os.homedir(), 'Library/Application Support/Muse/library/library.db'));
const rows = db.prepare(`
  SELECT i.id, i.thumbnail_path FROM images i
  LEFT JOIN image_colors c ON c.image_id = i.id
  WHERE i.is_trashed = 0 AND i.thumbnail_path IS NOT NULL AND length(trim(i.thumbnail_path)) > 0 AND c.image_id IS NULL
  GROUP BY i.id
`).all();
console.log(`backfilling ${rows.length} images`);
const ins = db.prepare('INSERT INTO image_colors (id, image_id, hex_color, percentage, sort_order) VALUES (?, ?, ?, ?, ?)');
let ok = 0, fail = 0;
for (const r of rows) {
  try {
    const png = await sharp(r.thumbnail_path).png().toBuffer();
    const p = await Vibrant.from(png).getPalette();
    const swatches = [p.Vibrant, p.DarkVibrant, p.LightVibrant, p.Muted, p.DarkMuted, p.LightMuted].filter(Boolean);
    const total = swatches.reduce((s, x) => s + (x?.population ?? 0), 0);
    const colors = swatches
      .map((s) => ({ hex: s.hex, pct: total > 0 ? s.population / total : 0 }))
      .sort((a, b) => b.pct - a.pct).slice(0, 6);
    db.transaction(() => {
      db.prepare('DELETE FROM image_colors WHERE image_id = ?').run(r.id);
      colors.forEach((c, i) => ins.run(randomUUID(), r.id, c.hex, c.pct, i));
    })();
    ok++;
  } catch (err) {
    fail++;
    console.log('  fail:', r.thumbnail_path.split('/').pop(), String(err).slice(0, 80));
  }
}
console.log(`done: ${ok} ok, ${fail} failed`);
console.log('image_colors coverage:', db.prepare('SELECT COUNT(DISTINCT image_id) c FROM image_colors').get().c, '/', db.prepare('SELECT COUNT(*) c FROM images WHERE is_trashed=0').get().c);
