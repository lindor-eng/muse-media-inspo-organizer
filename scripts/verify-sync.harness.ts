/**
 * End-to-end check of library sync: three libraries in temporary folders, each with its own
 * sync engine on loopback, finding each other through an in-process stand-in for Bonjour.
 * Run through `node scripts/verify-sync.mjs`, which bundles this and runs it under Electron's
 * Node (better-sqlite3 is built for Electron).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../src/main/database/schema';
import { createFolderRepo } from '../src/main/database/repositories/folders';
import { createImageRepo } from '../src/main/database/repositories/images';
import { createTagRepo } from '../src/main/database/repositories/tags';
import { upsertImageEmbedding } from '../src/main/ai/embeddings';
import { imagesNeedingCaptionUpgrade } from '../src/main/ai/caption-sweep';
import { SyncEngine } from '../src/main/sync/engine';
import type { Discovery, FoundPeer } from '../src/main/sync/discovery';
import type { Advertisement } from '../src/main/sync/protocol';
import { deriveKeys, newGroupKey, open, openStream, responseKey, seal, sealStream, signRequest } from '../src/main/sync/crypto';
import type { SyncState, SyncSummary } from '../src/shared/sync-state';

// MARK: - A network in a box

const network = new Map<string, { port: number; ad: Advertisement; owner: BusDiscovery }>();
const members = new Set<BusDiscovery>();

class BusDiscovery extends EventEmitter implements Discovery {
  constructor() {
    super();
    members.add(this);
    setTimeout(() => {
      for (const [, entry] of network) if (entry.owner !== this) this.emit('up', toPeer(entry));
    }, 10);
  }
  advertise(port: number, ad: Advertisement): void {
    network.set(ad.id, { port, ad, owner: this });
    for (const m of members) if (m !== this) setTimeout(() => m.emit('up', toPeer({ port, ad })), 5);
  }
  stop(): void {
    members.delete(this);
    for (const [id, entry] of network) {
      if (entry.owner === this) {
        network.delete(id);
        for (const m of members) m.emit('down', id);
      }
    }
  }
}

function toPeer(e: { port: number; ad: Advertisement }): FoundPeer {
  return { deviceId: e.ad.id, name: e.ad.name, tag: e.ad.tag, host: '127.0.0.1', port: e.port };
}

// MARK: - Libraries

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-sync-check-'));

interface Mac {
  name: string;
  dir: string;
  db: Database.Database;
  engine: SyncEngine;
  state: SyncState | null;
  summaries: SyncSummary[];
  logs: string[];
  sawSending: boolean;
  /** Largest countdown total seen. */
  maxTotal: number;
}

function makeMac(name: string): Mac {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'library', 'originals'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'library', 'thumbnails'), { recursive: true });
  const db = new Database(path.join(dir, 'library', 'library.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  runMigrations(db);
  const engine = new SyncEngine({
    db,
    libraryPath: path.join(dir, 'library'),
    configFile: path.join(dir, 'sync.json'),
    sealer: { seal: (b) => `test:${b.toString('base64')}`, open: (s) => Buffer.from(s.slice(5), 'base64') },
    defaultName: () => name,
    createDiscovery: () => new BusDiscovery(),
    host: '127.0.0.1',
    log: (m) => { mac.logs.push(m); if (process.env.VERBOSE) console.log(`    ${name} ${m}`); },
  });
  const mac: Mac = { name, dir, db, engine, state: null, summaries: [], logs: [], sawSending: false, maxTotal: 0 };
  engine.on('state', (s: SyncState) => {
    mac.state = s;
    if (s.peers.some((p) => p.sending)) mac.sawSending = true;
    for (const p of s.peers) if (p.progress) mac.maxTotal = Math.max(mac.maxTotal, p.progress.total);
  });
  engine.on('synced', (summary: SyncSummary) => mac.summaries.push(summary));
  return mac;
}

/** Imports a made-up file the way the importer stores one: named by its hash. */
function addImage(mac: Mac, bytes: Buffer, title: string, folderId: string | null = null): string {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const lib = path.join(mac.dir, 'library');
  fs.writeFileSync(path.join(lib, 'originals', `${hash}.png`), bytes);
  fs.writeFileSync(path.join(lib, 'thumbnails', `${hash}.webp`), Buffer.concat([Buffer.from('thumb:'), bytes.subarray(0, 32)]));
  const image = createImageRepo(mac.db).create({
    filename: `${title}.png`, original_path: path.join(lib, 'originals', `${hash}.png`),
    thumbnail_path: path.join(lib, 'thumbnails', `${hash}.webp`), title, width: 800, height: 600,
    file_size: bytes.length, file_type: 'png', hash, folder_id: folderId, file_created_at: null, file_modified_at: null,
  });
  return image.id;
}

function count(mac: Mac, sql: string, ...args: unknown[]): number {
  return (mac.db.prepare(sql).get(...args) as { n: number }).n;
}

// MARK: - Checking

let failures = 0;
async function expect(what: string, condition: () => boolean | Promise<boolean>, within = 8000): Promise<void> {
  const deadline = Date.now() + within;
  for (;;) {
    let ok = false;
    try { ok = await condition(); } catch { ok = false; }
    if (ok) { console.log(`ok    ${what}`); return; }
    if (Date.now() > deadline) { console.log(`FAIL  ${what}`); failures += 1; return; }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const idle = (mac: Mac) => () => !!mac.state && mac.state.peers.every((p) => p.status !== 'syncing');

async function main(): Promise<void> {
  // Crypto on its own first.
  {
    const key = crypto.randomBytes(32);
    const { iv, body } = seal(key, Buffer.from('hello'));
    await expect('a sealed response opens with its key', () => open(key, iv, body).toString() === 'hello');
    body[2] ^= 1;
    await expect('and not once a byte is changed', () => { try { open(key, iv, body); return false; } catch { return true; } });
    const s = sealStream(key);
    const chunks: Buffer[] = [];
    await pipeline(Readable.from([Buffer.alloc(100_000, 7)]), s.stream, async (src) => { for await (const c of src) chunks.push(c as Buffer); });
    const sealed = Buffer.concat(chunks);
    const out: Buffer[] = [];
    await pipeline(Readable.from([sealed.subarray(0, 333), sealed.subarray(333)]), openStream(key, s.iv), async (src) => { for await (const c of src) out.push(c as Buffer); });
    await expect('a sealed stream opens in pieces', () => Buffer.concat(out).equals(Buffer.alloc(100_000, 7)));
    sealed[500] ^= 1;
    let threw = false;
    try { await pipeline(Readable.from([sealed]), openStream(key, s.iv), async (src) => { for await (const c of src) void c; }); } catch { threw = true; }
    await expect('and a damaged one fails', () => threw);
  }

  const a = makeMac('Mac mini');
  const b = makeMac('MacBook Pro');

  // A's library: two folders, three images, tags, a palette and an embedding.
  const folders = createFolderRepo(a.db);
  const posters = folders.create('Posters', null);
  const swiss = folders.create('Swiss', posters.id);
  const shared = crypto.randomBytes(5000);
  const a1 = addImage(a, crypto.randomBytes(20_000), 'Helvetica poster', swiss.id);
  const a2 = addImage(a, crypto.randomBytes(300_000), 'Big clip', posters.id);
  const aShared = addImage(a, shared, 'Same file on both', null);
  const tagsA = createTagRepo(a.db);
  const red = tagsA.create('red');
  tagsA.addToImage(a1, red.id, true, 0.9);
  tagsA.addToImage(aShared, tagsA.create('from-a').id);
  a.db.prepare("INSERT INTO image_colors (id, image_id, hex_color, percentage, sort_order) VALUES (?, ?, '#ff0000', 0.5, 0)").run(crypto.randomUUID(), a1);
  const vec = Array.from({ length: 768 }, (_, i) => Math.sin(i));
  upsertImageEmbedding(a.db, a1, vec);

  // B's: one image of its own, one that's the same file as A's under another id, and a tag.
  const b1 = addImage(b, crypto.randomBytes(9000), 'Laptop screenshot', null);
  const bShared = addImage(b, shared, 'Same file, B title', null);
  const tagsB = createTagRepo(b.db);
  tagsB.addToImage(bShared, tagsB.create('from-b').id);
  tagsB.addToImage(b1, tagsB.create('red').id);

  await a.engine.setEnabled(true);
  await b.engine.setEnabled(true);
  await expect('with sync on, each Mac sees the other nearby', () =>
    a.state?.nearby.some((n) => n.name === 'MacBook Pro') === true && b.state?.nearby.some((n) => n.name === 'Mac mini') === true);
  await expect('and neither has paired', () => a.state?.paired === false && b.state?.paired === false);

  // Unpaired, nothing is served.
  const changesUrl = `http://127.0.0.1:${a.engine.listeningPort}/v1/changes?since=0&limit=10`;
  await expect('an unpaired Mac serves nothing but pairing', async () => (await fetch(changesUrl)).status === 403);

  // Refusing.
  await b.engine.pair(a.state!.deviceId);
  await expect('asking shows a code on the asking Mac', () => b.state?.outgoingPair?.phase === 'confirm' && /^\d{6}$/.test(b.state.outgoingPair.code ?? ''));
  await expect('and the same code on the asked Mac', () => a.state?.incomingPair?.code === b.state?.outgoingPair?.code);
  const confirming = b.engine.confirmPair();
  a.engine.respondToPair(a.state!.incomingPair!.session, false);
  await confirming;
  await expect("Don't Allow fails the attempt", () => b.state?.outgoingPair?.phase === 'failed' && !b.state.paired && !a.state?.paired);
  b.engine.cancelPair();

  // Pairing.
  await b.engine.pair(a.state!.deviceId);
  await expect('asking again shows a new code', () => b.state?.outgoingPair?.phase === 'confirm');
  a.engine.respondToPair(a.state!.incomingPair!.session, true);
  await expect('Allow waits for Codes Match on the other Mac', () => a.state?.incomingPair?.phase === 'waiting');
  await b.engine.confirmPair();
  await expect('then both are paired', () => a.state?.paired === true && b.state?.paired === true && b.state.outgoingPair?.phase === 'done');
  await expect('and list each other as synced Macs', () =>
    a.state?.peers.some((p) => p.name === 'MacBook Pro' && p.online) === true && b.state?.peers.some((p) => p.name === 'Mac mini' && p.online) === true);
  await expect('and no longer as nearby', () => a.state?.nearby.length === 0 && b.state?.nearby.length === 0);

  // The libraries merge.
  await expect("B gets A's images", () => count(b, 'SELECT COUNT(*) n FROM images WHERE id IN (?, ?)', a1, a2) === 2, 15000);
  await expect("A gets B's image", () => count(a, 'SELECT COUNT(*) n FROM images WHERE id = ?', b1) === 1, 15000);
  await expect('with their files, intact', () => {
    const row = b.db.prepare('SELECT original_path, thumbnail_path, hash FROM images WHERE id = ?').get(a2) as { original_path: string; thumbnail_path: string; hash: string };
    const bytes = fs.readFileSync(row.original_path);
    return row.original_path.startsWith(b.dir) && fs.existsSync(row.thumbnail_path) && crypto.createHash('sha256').update(bytes).digest('hex') === row.hash;
  });
  await expect('in the same folders, nested the same way', () => {
    const row = b.db.prepare('SELECT f.name, p.name AS parent FROM images i JOIN folders f ON f.id = i.folder_id JOIN folders p ON p.id = f.parent_id WHERE i.id = ?').get(a1) as { name: string; parent: string } | undefined;
    return row?.name === 'Swiss' && row.parent === 'Posters';
  });
  await expect('with their tags, palette and embedding', () =>
    count(b, "SELECT COUNT(*) n FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ? AND t.name = 'red' AND it.is_auto = 1", a1) === 1
    && count(b, 'SELECT COUNT(*) n FROM image_colors WHERE image_id = ?', a1) === 1
    && count(b, 'SELECT COUNT(*) n FROM image_embeddings WHERE image_id = ?', a1) === 1);
  await expect("a tag both Macs had stays one tag", () => count(a, "SELECT COUNT(*) n FROM tags WHERE name = 'red'") === 1 && count(a, "SELECT COUNT(*) n FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE t.name = 'red'") === 2);
  const keep = aShared < bShared ? aShared : bShared;
  await expect('the file both Macs had is one image on each, with both sets of tags', () => {
    const rows = (m: Mac) => m.db.prepare('SELECT id FROM images WHERE hash = ?').all(crypto.createHash('sha256').update(shared).digest('hex')) as { id: string }[];
    const tags = (m: Mac) => (m.db.prepare('SELECT t.name FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ? ORDER BY t.name').all(keep) as { name: string }[]).map((r) => r.name).join(',');
    return rows(a).length === 1 && rows(b).length === 1 && rows(a)[0].id === keep && rows(b)[0].id === keep && tags(a) === 'from-a,from-b' && tags(b) === 'from-a,from-b';
  }, 15000);
  await expect('both settle', () => idle(a)() && idle(b)());
  const total = (m: Mac, k: 'added' | 'removed' | 'changed') => m.summaries.reduce((n, x) => n + x[k], 0);
  await expect("B's toast counts A's images as added", () => total(b, 'added') >= 2 && b.summaries.every((x) => x.name === 'Mac mini'));
  await expect('A showed it was sending while B copied its files', () => a.sawSending);
  await expect("B's countdown was 2 files: A's three images, less the one B already had", () => b.logs.some((l) => l.endsWith('receiving 2 files from Mac mini')));

  // Changes after that.
  folders.update(swiss.id, { name: 'Swiss Style' });
  tagsA.addToImage(a2, tagsA.create('motion').id);
  createImageRepo(a.db).update(a2, { notes: 'From the 1960s' });
  await expect('a rename on A shows up on B within seconds', () => count(b, "SELECT COUNT(*) n FROM folders WHERE name = 'Swiss Style'") === 1, 6000);
  await expect('so do a new tag and a note', () =>
    count(b, "SELECT COUNT(*) n FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ? AND t.name = 'motion'", a2) === 1
    && count(b, "SELECT COUNT(*) n FROM images WHERE id = ? AND notes = 'From the 1960s'", a2) === 1, 6000);
  await expect("B's toast counts the rename, the tag and the note as changes, once things go quiet", () => total(b, 'changed') >= 2, 8000);

  const removedBefore = total(a, 'removed');
  createImageRepo(b.db).trash(b1);
  await expect('moving to the Trash on B does on A', () => count(a, 'SELECT COUNT(*) n FROM images WHERE id = ? AND is_trashed = 1', b1) === 1, 6000);
  await expect("and A's toast counts it as removed", () => total(a, 'removed') === removedBefore + 1);
  createImageRepo(b.db).deletePermanently(b1);
  await expect('and emptying it', () => count(a, 'SELECT COUNT(*) n FROM images WHERE id = ?', b1) === 0, 6000);
  const motion = tagsB.getAll().find((t) => t.name === 'motion');
  if (motion) tagsB.delete(motion.id);
  await expect('deleting a tag on B removes it on A', () => count(a, "SELECT COUNT(*) n FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE t.name = 'motion'") === 0, 6000);
  folders.delete(posters.id);
  await expect('deleting a folder on A deletes it and its subfolder on B', () => count(b, 'SELECT COUNT(*) n FROM folders') === 0, 6000);
  await expect("and leaves its images, out of any folder, as on A", () => count(b, 'SELECT COUNT(*) n FROM images WHERE id IN (?, ?) AND folder_id IS NULL', a1, a2) === 2);

  // What Muse works out for itself isn't news.
  await expect('settled before the palette check', () => idle(a)() && idle(b)());
  await settle(3500); // let the last step's toast go out first
  const summariesBefore = b.summaries.length;
  const fresh = addImage(a, crypto.randomBytes(2500), 'Palette arrives later');
  await expect('the new image reaches B', () => count(b, 'SELECT COUNT(*) n FROM images WHERE id = ?', fresh) === 1, 6000);
  await expect('settled before the palette lands', () => idle(b)());
  a.db.prepare("INSERT INTO image_colors (id, image_id, hex_color, percentage, sort_order) VALUES (?, ?, '#00ff00', 1, 0)").run(crypto.randomUUID(), fresh);
  await expect('its palette follows', () => count(b, 'SELECT COUNT(*) n FROM image_colors WHERE image_id = ?', fresh) === 1, 6000);
  await settle(300);
  await expect("and B's toasts say 1 added, with the palette not counted as a change", () => {
    const later = b.summaries.slice(summariesBefore);
    return later.reduce((n, x) => n + x.added, 0) === 1 && later.reduce((n, x) => n + x.changed, 0) === 0;
  });
  await expect("B's launch-time AI sweep leaves images from A to A, even after B touches them", () => {
    b.db.prepare("UPDATE images SET phash = X'00' WHERE id = ?").run(fresh); // as B's own AI pipeline would
    const ids = imagesNeedingCaptionUpgrade(b.db, 99);
    return !ids.includes(fresh) && imagesNeedingCaptionUpgrade(a.db, 99).includes(fresh);
  });

  // A long background trickle on A (an AI pass rewriting palettes) doesn't hold B's toast back.
  await settle(3500);
  const beforeTrickle = b.summaries.length;
  const trickled = addImage(a, crypto.randomBytes(2600), 'Added during a trickle');
  const trickleStart = Date.now();
  const trickle = setInterval(() => {
    a.db.prepare('DELETE FROM image_colors WHERE image_id = ?').run(fresh);
    a.db.prepare("INSERT INTO image_colors (id, image_id, hex_color, percentage, sort_order) VALUES (?, ?, ?, 1, 0)").run(crypto.randomUUID(), fresh, `#${crypto.randomBytes(3).toString('hex')}`);
  }, 400);
  await expect('while A keeps sending palette updates, B still shows its toast within a few seconds', () =>
    b.summaries.slice(beforeTrickle).some((x) => x.added === 1) && Date.now() - trickleStart < 8000, 8000);
  clearInterval(trickle);
  void trickled;

  // Away and back.
  await expect('settled before B leaves', () => idle(a)() && idle(b)());
  await b.engine.setEnabled(false);
  const whileAway = addImage(a, crypto.randomBytes(3000), 'Added while B was away');
  await settle(400);
  await expect('B misses it while away', () => count(b, 'SELECT COUNT(*) n FROM images WHERE id = ?', whileAway) === 0);
  await b.engine.setEnabled(true);
  await expect('and gets it within seconds of coming back', () => count(b, 'SELECT COUNT(*) n FROM images WHERE id = ?', whileAway) === 1, 5000);
  const lastBefore = b.state?.peers.find((p) => p.name === 'Mac mini')?.lastSyncedAt ?? 0;
  await settle(50);
  b.engine.nudge('wake');
  await expect('waking checks the other Macs after a short wait', () =>
    b.logs.some((l) => l.includes('after waking')) && (b.state?.peers.find((p) => p.name === 'Mac mini')?.lastSyncedAt ?? 0) > lastBefore, 8000);

  // A paired Mac that can't be reached is retried quietly before anything shows.
  const groupKey = Buffer.from(JSON.parse(fs.readFileSync(path.join(a.dir, 'sync.json'), 'utf-8')).group.sealedKey.slice(5), 'base64');
  const ghostTag = deriveKeys(groupKey).tag;
  a.engine.addPeer({ deviceId: 'e'.repeat(32), name: 'Asleep', tag: ghostTag, host: '127.0.0.1', port: 9 });
  await settle(1500);
  await expect("a Mac that doesn't answer isn't shown as an error straight away", () => {
    const ghost = a.state?.peers.find((p) => p.name === 'Asleep');
    return !!ghost && ghost.status !== 'error' && ghost.error === null && a.logs.some((l) => l.includes('pull from Asleep failed'));
  });

  // Both edit the same thing: the later edit wins everywhere.
  await expect('both settle again', () => idle(a)() && idle(b)());
  createImageRepo(a.db).update(a1, { title: 'Edited on A' });
  await settle(30);
  createImageRepo(b.db).update(a1, { title: 'Edited on B, later' });
  await expect('when both edit one title, the later edit wins on both', () =>
    count(a, "SELECT COUNT(*) n FROM images WHERE id = ? AND title = 'Edited on B, later'", a1) === 1
    && count(b, "SELECT COUNT(*) n FROM images WHERE id = ? AND title = 'Edited on B, later'", a1) === 1, 6000);

  // A third Mac, paired through B, ends up with everything and syncs with A directly.
  const c = makeMac('Studio');
  await c.engine.setEnabled(true);
  await expect('a third Mac sees B nearby', () => c.state?.nearby.some((n) => n.name === 'MacBook Pro') === true);
  await c.engine.pair(b.state!.deviceId);
  await expect('pairs with B', () => !!b.state?.incomingPair);
  b.engine.respondToPair(b.state!.incomingPair!.session, true);
  await c.engine.confirmPair();
  await expect('and gets the whole library', () => count(c, 'SELECT COUNT(*) n FROM images') === count(a, 'SELECT COUNT(*) n FROM images'), 15000);
  await expect('A lists it as a synced Mac without pairing again', () => a.state?.peers.some((p) => p.name === 'Studio' && p.online) === true);
  addImage(c, crypto.randomBytes(4000), 'From the studio');
  await expect("and gets C's new image", () => count(a, "SELECT COUNT(*) n FROM images WHERE title = 'From the studio'") === 1, 8000);

  // Outsiders.
  const outsider = deriveKeys(newGroupKey());
  const signed = signRequest(outsider, 'GET', '/v1/changes?since=0&limit=10', 'f'.repeat(32));
  await expect('a Mac with another key is turned away', async () => (await fetch(changesUrl, { headers: { ...signed } })).status === 401);
  const aKey = Buffer.from(JSON.parse(fs.readFileSync(path.join(a.dir, 'sync.json'), 'utf-8')).group.sealedKey.slice(5), 'base64');
  const good = signRequest(deriveKeys(aKey), 'GET', '/v1/changes?since=0&limit=10', 'f'.repeat(32));
  const res = await fetch(changesUrl, { headers: { ...good } });
  const body = Buffer.from(await res.arrayBuffer());
  await expect('what a paired Mac is sent is encrypted', () => {
    const plain = open(responseKey(deriveKeys(aKey), good['x-muse-nonce']), res.headers.get('x-muse-iv')!, body);
    const page = JSON.parse(plain.toString('utf-8')) as { rows: Array<{ key: string }> };
    return res.status === 200 && page.rows.length === 10 && !body.includes(Buffer.from('"rows"')) && !body.includes(Buffer.from(page.rows[0].key));
  });
  await expect("and the same request can't be replayed", async () => (await fetch(changesUrl, { headers: { ...good } })).status === 401);
  const traversal = signRequest(deriveKeys(aKey), 'GET', '/v1/files/originals/..%2Flibrary.db', 'f'.repeat(32));
  await expect('nor can it ask for files outside the library', async () => {
    const r = await fetch(`http://127.0.0.1:${a.engine.listeningPort}/v1/files/originals/..%2Flibrary.db`, { headers: { ...traversal } });
    return r.status === 400 || r.status === 404;
  });

  // Leaving.
  c.engine.leave();
  await expect('a Mac that stops syncing forgets the pairing', () => c.state?.paired === false && c.state.peers.length === 0);
  await expect('and shows up as nearby again', () => c.state?.nearby.length === 2);

  for (const m of [a, b, c]) await m.engine.stop();
  for (const m of [a, b, c]) m.db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
