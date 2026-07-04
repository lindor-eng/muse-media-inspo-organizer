import Database from 'better-sqlite3';
const OLLAMA = 'http://127.0.0.1:11434';
async function embed(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
  });
  const { embedding } = await res.json();
  let s = 0; for (const x of embedding) s += x * x; const n = Math.sqrt(s);
  return embedding.map((x) => x / n);
}
const db = new Database(process.argv[2], { readonly: true });
const images = db.prepare(`SELECT id, filename, alt_text, notes FROM images WHERE is_trashed = 0 LIMIT 40`).all();
const tagStmt = db.prepare(`SELECT t.name FROM tags t JOIN image_tags it ON it.tag_id = t.id WHERE it.image_id = ?`);
const docs = [];
for (const img of images) {
  const tags = tagStmt.all(img.id).map((r) => r.name);
  const parts = [];
  if (img.alt_text?.trim()) parts.push(img.alt_text.trim());
  if (img.notes?.trim()) parts.push(img.notes.trim());
  if (tags.length) parts.push(`Tags: ${tags.join(', ')}`);
  if (!parts.length) parts.push(img.filename);
  const text = parts.join('\n');
  docs.push({ raw: await embed(text), pre: await embed('search_document: ' + text) });
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const rawC = [], preC = [];
for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) {
  rawC.push(dot(docs[i].raw, docs[j].raw));
  preC.push(dot(docs[i].pre, docs[j].pre));
}
rawC.sort((a,b)=>a-b); preC.sort((a,b)=>a-b);
const q = (arr, p) => arr[Math.floor(arr.length * p)].toFixed(3);
console.log('doc-doc cosine, raw:      min', q(rawC,0), 'p25', q(rawC,0.25), 'median', q(rawC,0.5), 'p75', q(rawC,0.75), 'max', q(rawC,0.999));
console.log('doc-doc cosine, prefixed: min', q(preC,0), 'p25', q(preC,0.25), 'median', q(preC,0.5), 'p75', q(preC,0.75), 'max', q(preC,0.999));
let sumAbs = 0; for (let k = 0; k < rawC.length; k++) sumAbs += Math.abs(rawC[k] - preC[k]);
console.log('mean |shift| per pair:', (sumAbs / rawC.length).toFixed(4));
