import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type Database from 'better-sqlite3';
import type { SyncPeerState, SyncState, SyncSummary } from '../../shared/sync-state';
import { applyRows, missingFiles, missingReferences, pendingFiles, readChanges, readRows, wanted } from './changes';
import { loadConfig, saveConfig, type Sealer, type SyncConfig } from './config';
import {
  commitment,
  deriveKeys,
  newGroupKey,
  newPairKeys,
  NonceCache,
  open,
  openStream,
  pairingCode,
  pairingWrapKey,
  responseKey,
  seal,
  sealStream,
  sharedSecret,
  signRequest,
  verifyRequest,
  type GroupKeys,
  type PairKeys,
} from './crypto';
import type { Discovery, FoundPeer } from './discovery';
import { FILE_NAME_PATTERN, PROTOCOL_VERSION, type ChangeRow, type ChangesPage, type ImageData, type PairGrant, type RowRef } from './protocol';
import { deviceId as readDeviceId } from './schema';

export interface EngineOptions {
  db: Database.Database;
  libraryPath: string;
  configFile: string;
  sealer: Sealer;
  /** The Mac's own name, used until someone types another. */
  defaultName: () => string;
  createDiscovery: () => Discovery;
  /** Where the server listens. Everything on the network by default; tests use loopback. */
  host?: string;
  log?: (message: string) => void;
}

/** Thrown when a peer turns this Mac away: it isn't in that Mac's sync group. */
class NotPairedError extends Error {}

interface PeerRuntime {
  status: SyncPeerState['status'];
  progress: SyncPeerState['progress'];
  error: string | null;
  running: Promise<void> | null;
  again: boolean;
  /** Pulls that failed in a row. The first few are retried quietly. */
  failures: number;
  retry: ReturnType<typeof setTimeout> | null;
  /** Totals for the toast, kept across pulls that follow straight on from each other. */
  brought: { added: number; removed: number; changed: number };
  /** The toast waits for things to go quiet; this is that wait, and the count it carries. */
  settle: ReturnType<typeof setTimeout> | null;
  /** When the toast is due, unless something more worth counting arrives first. */
  settleAt: number;
  carriedDone: number;
}

/** The toast goes out once a Mac has had nothing more to send for this long. */
const SUMMARY_SETTLE_MS = 3_000;

/** Waits before quiet retries; after these run out, the failure shows. */
const RETRY_AFTER_MS = [5_000, 15_000, 30_000];
/** After waking or a network change, give Wi-Fi a moment to come back before pulling. */
const SETTLE_MS = 3_000;
/** A Mac counts as "sending" for this long after its last file goes out. */
const SENDING_LINGER_MS = 2_500;

interface Outgoing {
  deviceId: string;
  name: string;
  phase: 'connecting' | 'confirm' | 'waiting' | 'done' | 'failed';
  code: string | null;
  error: string | null;
  peer: FoundPeer;
  session: string | null;
  wrapKey: Buffer | null;
}

interface Incoming {
  session: string;
  device: string;
  name: string;
  commit: string;
  keys: PairKeys;
  phase: 'started' | 'ask' | 'waiting';
  code: string | null;
  wrapKey: Buffer | null;
  decision: 'pending' | 'allow' | 'deny';
  waiters: Array<() => void>;
  expires: ReturnType<typeof setTimeout>;
}

// Small enough that items appear in the grid steadily over Wi-Fi, not in big jumps.
const PAGE_SIZE = 50;
const WATCH_MS = 1500;
const PERIODIC_MS = 60_000;
const PAIR_TTL_MS = 2 * 60_000;
const DOWNLOADS_AT_ONCE = 3;

/**
 * Library sync between Muse apps on the same network.
 *
 * Every Mac runs a small HTTP server and advertises it over Bonjour. Paired Macs share a group
 * key; each one pulls from the others: "what changed since the last change I saw from you?",
 * then the files those changes need, then applies them in one transaction (see `changes.ts`).
 * A Mac that changes something tells the others (a "poke") so they pull straight away, and
 * every minute each pulls anyway in case a poke was missed. Changes pass along: if A and C
 * can't see each other but both see B, B carries them.
 *
 * Events: `state` (SyncState) whenever what Settings shows changes; `libraryChanged` after a
 * peer's changes were applied, so the window can reload.
 */
export class SyncEngine extends EventEmitter {
  private readonly db: Database.Database;
  private readonly opts: EngineOptions;
  private config: SyncConfig;
  private keys: GroupKeys | null = null;

  private server: http.Server | null = null;
  private port = 0;
  private discovery: Discovery | null = null;
  private found = new Map<string, FoundPeer>();
  private runtime = new Map<string, PeerRuntime>();
  private nonces = new NonceCache();
  private startError: string | null = null;

  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private pokeTimer: ReturnType<typeof setTimeout> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq = 0;

  private outgoing: Outgoing | null = null;
  private incoming: Incoming | null = null;

  /** Files being served to each Mac right now, and when the last one finished. */
  private sending = new Map<string, { active: number; lastAt: number; timer: ReturnType<typeof setTimeout> | null }>();
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private networkTimer: ReturnType<typeof setInterval> | null = null;
  private networkSignature = '';

  constructor(opts: EngineOptions) {
    super();
    this.opts = opts;
    this.db = opts.db;
    this.config = loadConfig(opts.configFile);
    if (this.config.group) {
      try {
        this.keys = deriveKeys(opts.sealer.open(this.config.group.sealedKey));
      } catch (err) {
        // The keychain item is gone (a restored backup, say): the pairing has to be done again.
        this.log(`couldn't unseal the group key, forgetting the pairing: ${String(err)}`);
        this.config.group = null;
        this.save();
      }
    }
  }

  private log(message: string): void {
    (this.opts.log ?? ((m: string) => console.log(m)))(`[sync] ${message}`);
  }

  private save(): void {
    saveConfig(this.opts.configFile, this.config);
  }

  get deviceId(): string {
    return readDeviceId(this.db);
  }

  get name(): string {
    return this.config.name.trim() || this.opts.defaultName();
  }

  /** The port the server took, once listening. */
  get listeningPort(): number {
    return this.port;
  }

  // MARK: - Turning it on and off

  async start(): Promise<void> {
    if (this.config.enabled) await this.goOnline();
    this.emitState();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.config.enabled && (enabled ? this.server !== null : true)) return;
    this.config.enabled = enabled;
    this.save();
    if (enabled) await this.goOnline();
    else await this.goOffline();
    this.emitState();
  }

  async stop(): Promise<void> {
    await this.goOffline();
  }

  private async goOnline(): Promise<void> {
    if (this.server) return;
    this.startError = null;
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        this.log(`request failed: ${String(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
        else res.destroy();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, this.opts.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      this.startError = `Couldn't start: ${err instanceof Error ? err.message : String(err)}`;
      this.log(this.startError);
      return;
    }
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    this.log(`listening on port ${this.port} as ${this.deviceId.slice(0, 8)} (${this.name})`);

    try {
      this.discovery = this.opts.createDiscovery();
      this.discovery.on('up', (peer: FoundPeer) => this.peerUp(peer));
      this.discovery.on('down', (id: string) => this.peerDown(id));
      this.advertise();
    } catch (err) {
      this.startError = `Couldn't look for other Macs: ${err instanceof Error ? err.message : String(err)}`;
      this.log(this.startError);
    }

    this.lastSeq = this.maxSeq();
    this.networkSignature = networkSignature();
    this.networkTimer = setInterval(() => {
      const now = networkSignature();
      if (now === this.networkSignature) return;
      this.networkSignature = now;
      this.nudge('network');
    }, 5_000);
    this.watchTimer = setInterval(() => this.watchForLocalChanges(), WATCH_MS);
    this.periodicTimer = setInterval(() => {
      (this.discovery as { refresh?: () => void } | null)?.refresh?.();
      for (const peer of this.groupPeers()) this.schedulePull(peer.deviceId);
    }, PERIODIC_MS);
  }

  private async goOffline(): Promise<void> {
    for (const t of [this.watchTimer, this.periodicTimer, this.networkTimer]) if (t) clearInterval(t);
    for (const t of [this.pokeTimer, this.nudgeTimer]) if (t) clearTimeout(t);
    this.watchTimer = this.periodicTimer = this.networkTimer = this.pokeTimer = this.nudgeTimer = null;
    for (const r of this.runtime.values()) {
      if (r.retry) clearTimeout(r.retry);
      if (r.settle) clearTimeout(r.settle);
    }
    for (const s of this.sending.values()) if (s.timer) clearTimeout(s.timer);
    this.sending.clear();
    this.discovery?.stop();
    this.discovery = null;
    this.found.clear();
    this.clearIncoming();
    this.outgoing = null;
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Promise.allSettled([...this.runtime.values()].map((r) => r.running));
    this.runtime.clear();
  }

  setName(name: string): void {
    this.config.name = name.trim().slice(0, 60);
    this.save();
    this.advertise();
    this.emitState();
  }

  /** Pull from every paired Mac now. */
  syncNow(): void {
    (this.discovery as { refresh?: () => void } | null)?.refresh?.();
    for (const peer of this.groupPeers()) this.schedulePull(peer.deviceId, true);
    this.pokeAll();
  }

  /**
   * The Mac woke up or changed networks: other Macs may have moved on meanwhile. Waits a few
   * seconds for Wi-Fi to settle, starts Bonjour afresh (its sockets may belong to the old
   * network), and pulls from every paired Mac it knows.
   */
  nudge(reason: 'wake' | 'network'): void {
    if (!this.server) return;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      if (!this.server) return;
      this.log(`checking for changes after ${reason === 'wake' ? 'waking' : 'a network change'}`);
      this.restartDiscovery();
      this.syncNow();
    }, SETTLE_MS);
  }

  private restartDiscovery(): void {
    try {
      this.discovery?.stop();
      this.discovery = this.opts.createDiscovery();
      this.discovery.on('up', (peer: FoundPeer) => this.peerUp(peer));
      this.discovery.on('down', (id: string) => this.peerDown(id));
      this.advertise();
    } catch (err) {
      this.log(`couldn't restart Bonjour: ${String(err)}`);
    }
  }

  /** Leaves the sync group: this Mac forgets the key and the Macs it synced with. */
  leave(): void {
    this.config.group = null;
    this.config.peers = {};
    this.config.cursors = {};
    this.keys = null;
    this.runtime.clear();
    this.save();
    this.advertise();
    this.emitState();
  }

  private advertise(): void {
    if (!this.discovery || !this.port) return;
    this.discovery.advertise(this.port, { id: this.deviceId, name: this.name, tag: this.keys?.tag ?? '', v: '1' });
  }

  /** Lets a test (or a Mac Bonjour can't see) be reached directly. */
  addPeer(peer: FoundPeer): void {
    this.peerUp(peer);
  }

  // MARK: - Other Macs

  private peerUp(peer: FoundPeer): void {
    if (peer.deviceId === this.deviceId) return;
    const before = this.found.get(peer.deviceId);
    this.found.set(peer.deviceId, peer);
    const inGroup = this.keys !== null && peer.tag === this.keys.tag;
    if (inGroup) {
      // Any announcement from a paired Mac is worth a look: it may be back from sleep or another
      // network with changes, even at the same address. Pulls that overlap fold into one.
      if (!before || before.host !== peer.host || before.port !== peer.port) this.log(`${peer.name} is here (${peer.host}:${peer.port})`);
      this.schedulePull(peer.deviceId, true);
    }
    this.emitState();
  }

  private peerDown(id: string): void {
    if (this.found.delete(id)) this.emitState();
  }

  private groupPeers(): FoundPeer[] {
    const tag = this.keys?.tag;
    if (!tag) return [];
    return [...this.found.values()].filter((p) => p.tag === tag);
  }

  private rt(id: string): PeerRuntime {
    let r = this.runtime.get(id);
    if (!r) {
      r = { status: 'idle', progress: null, error: null, running: null, again: false, failures: 0, retry: null, brought: { added: 0, removed: 0, changed: 0 }, settle: null, settleAt: 0, carriedDone: 0 };
      this.runtime.set(id, r);
    }
    return r;
  }

  // MARK: - State for Settings

  getState(): SyncState {
    const ids = new Set<string>([...Object.keys(this.config.peers), ...this.groupPeers().map((p) => p.deviceId)]);
    if (this.keys) for (const id of this.sending.keys()) ids.add(id);
    const peers: SyncPeerState[] = [...ids].map((id) => {
      const live = this.found.get(id);
      const online = !!live && !!this.keys && live.tag === this.keys.tag;
      const r = this.runtime.get(id);
      return {
        deviceId: id,
        name: live?.name ?? this.config.peers[id]?.name ?? 'Mac',
        online,
        status: r?.status ?? 'idle',
        progress: r?.progress ?? null,
        sending: this.isSending(id),
        lastSyncedAt: this.config.peers[id]?.lastSyncedAt ?? null,
        error: r?.error ?? null,
      };
    });
    peers.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    const nearby = [...this.found.values()]
      .filter((p) => !this.keys || p.tag !== this.keys.tag)
      .map((p) => ({ deviceId: p.deviceId, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const out = this.outgoing;
    const inc = this.incoming;
    return {
      enabled: this.config.enabled,
      name: this.name,
      deviceId: this.deviceId,
      paired: this.config.group !== null,
      listening: this.server !== null,
      error: this.startError,
      peers,
      nearby,
      outgoingPair: out ? { deviceId: out.deviceId, name: out.name, phase: out.phase, code: out.code, error: out.error } : null,
      incomingPair:
        inc && inc.code && (inc.phase === 'ask' || inc.phase === 'waiting')
          ? { session: inc.session, name: inc.name, code: inc.code, phase: inc.phase }
          : null,
    };
  }

  private emitState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.emit('state', this.getState());
    }, 50);
  }

  // MARK: - Noticing local changes

  private maxSeq(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM sync_rows').get() as { s: number }).s;
  }

  private watchForLocalChanges(): void {
    const seq = this.maxSeq();
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      this.pokeAll();
    }, 800);
  }

  private pokeAll(): void {
    for (const peer of this.groupPeers()) {
      this.call(peer, 'POST', '/v1/poke', 5000)
        .then(({ res }) => res.arrayBuffer())
        .catch(() => undefined);
    }
  }

  // MARK: - Pulling

  /** `fresh`: a new reason to try, so a Mac waiting out quiet retries tries now. */
  private schedulePull(id: string, fresh = false): void {
    const r = this.rt(id);
    if (fresh && r.retry) {
      clearTimeout(r.retry);
      r.retry = null;
    }
    if (r.retry) return; // a quiet retry is already booked
    if (r.running) {
      r.again = true;
      return;
    }
    r.running = this.pull(id).finally(() => {
      r.running = null;
      if (r.again && this.server) {
        r.again = false;
        this.schedulePull(id);
      }
    });
  }

  private async pull(id: string): Promise<void> {
    const peer = this.found.get(id);
    if (!peer || !this.keys || peer.tag !== this.keys.tag) return;
    const r = this.rt(id);
    r.status = 'syncing';
    r.error = null;
    this.emitState();
    // A pull that follows straight on from the last one (more arrived meanwhile) carries on its
    // countdown and its toast totals, so the count never jumps back and there's one toast.
    // The toast's timer waits while a pull runs, so it can't go out with half a pull's counts.
    if (r.settle) {
      clearTimeout(r.settle);
      r.settle = null;
    }
    let done = r.progress?.done ?? r.carriedDone;
    let total: number | null = null;
    const brought = r.brought;
    const countedBefore = brought.added + brought.removed + brought.changed;
    const flush = () => {
      if (r.settle) clearTimeout(r.settle);
      r.settle = null;
      r.settleAt = 0;
      r.carriedDone = 0;
      const b = r.brought;
      if (b.added || b.removed || b.changed) this.emit('synced', { deviceId: id, name: peer.name, ...b } satisfies SyncSummary);
      r.brought = { added: 0, removed: 0, changed: 0 };
    };
    // The toast waits until that Mac has had nothing more worth counting for a few seconds, so
    // a long import over there makes one toast. Background trickle (palettes, an AI pass) doesn't
    // hold it back.
    const report = (now: boolean) => {
      if (now) return flush();
      const countedNow = brought.added + brought.removed + brought.changed;
      if (countedNow > countedBefore || !r.settleAt) r.settleAt = Date.now() + SUMMARY_SETTLE_MS;
      r.settle = setTimeout(flush, Math.max(0, r.settleAt - Date.now()));
    };
    try {
      for (;;) {
        const cursor = this.config.cursors[id];
        const since = cursor?.seq ?? 0;
        const page = await this.callJson<ChangesPage>(peer, 'GET', `/v1/changes?since=${since}&limit=${PAGE_SIZE}`);
        if (cursor && cursor.epoch !== page.epoch && since > 0) {
          // That library's log started over (a new install, a replaced database): read it all.
          this.log(`${peer.name} has a new change log; reading it from the start`);
          this.config.cursors[id] = { epoch: page.epoch, seq: 0 };
          continue;
        }
        // The countdown is in files: how many originals that Mac has that this one doesn't yet.
        if (total === null) {
          const names = await this.callJson<string[]>(peer, 'GET', `/v1/pending?since=${since}`);
          const originals = path.join(this.opts.libraryPath, 'originals');
          const incoming = names.filter((n) => FILE_NAME_PATTERN.test(n) && !fs.existsSync(path.join(originals, n))).length;
          total = done + incoming;
          if (incoming) this.log(`receiving ${incoming} file${incoming === 1 ? '' : 's'} from ${peer.name}`);
        }
        r.progress = total > 0 ? { done, total } : null;
        this.emitState();

        let rows = wanted(this.db, page.rows);
        if (rows.length) {
          rows = await this.resolveReferences(peer, rows);
          rows = await this.fetchFiles(peer, rows, () => {
            done += 1;
            // Files imported over there after the count started make it grow.
            if (total !== null && done > total) total = done;
            r.progress = total ? { done, total } : null;
            this.emitState();
          });
          const result = applyRows(this.db, this.opts.libraryPath, rows);
          brought.added += result.added;
          brought.removed += result.removed;
          brought.changed += result.changed;
          if (result.applied) {
            this.log(`took ${result.applied} change${result.applied === 1 ? '' : 's'} from ${peer.name}`);
            this.emit('libraryChanged');
          }
        }
        r.progress = total > 0 ? { done, total } : null;
        this.config.cursors[id] = { epoch: page.epoch, seq: page.next };
        this.save();
        if (!page.more) break;
      }
      this.config.peers[id] = { name: peer.name, lastSyncedAt: Date.now() };
      this.save();
      // Another pull follows straight away: stay "syncing" so the icon doesn't blink off.
      r.status = r.again ? 'syncing' : 'idle';
      r.failures = 0;
      if (r.again) {
        r.progress = total ? { done, total: done } : r.progress;
      } else {
        r.progress = null;
        r.carriedDone = done;
        report(false);
      }
    } catch (err) {
      r.progress = null;
      const message = err instanceof Error ? err.message : String(err);
      this.log(`pull from ${peer.name} failed: ${message}`);
      // Whatever was applied before the failure still happened; say so.
      report(true);
      if (err instanceof NotPairedError) {
        r.status = 'error';
        r.error = `${peer.name} isn't paired with this Mac any more. Pair them again.`;
      } else if (r.failures < RETRY_AFTER_MS.length) {
        // Usually Wi-Fi coming back or the other Mac waking up: try again quietly.
        r.status = 'idle';
        const wait = RETRY_AFTER_MS[r.failures];
        r.failures += 1;
        r.retry = setTimeout(() => {
          r.retry = null;
          if (this.server) this.schedulePull(id);
        }, wait);
      } else {
        r.status = 'error';
        r.error = `Couldn't reach ${peer.name}. Muse keeps trying.`;
      }
    }
    this.emitState();
  }

  /** Brings in the rows a page refers to but doesn't carry (see `missingReferences`). */
  private async resolveReferences(peer: FoundPeer, rows: ChangeRow[]): Promise<ChangeRow[]> {
    const asked = new Set<string>();
    for (let round = 0; round < 8; round += 1) {
      const refs = missingReferences(this.db, rows).filter((r) => !asked.has(`${r.tbl}:${r.key}`));
      if (!refs.length) break;
      for (const r of refs) asked.add(`${r.tbl}:${r.key}`);
      for (let i = 0; i < refs.length; i += 40) {
        const batch: RowRef[] = refs.slice(i, i + 40);
        const fetched = await this.callJson<ChangeRow[]>(peer, 'GET', `/v1/rows?refs=${encodeURIComponent(JSON.stringify(batch))}`);
        rows = [...wanted(this.db, fetched), ...rows];
      }
    }
    return rows;
  }

  /**
   * Downloads the originals and thumbnails the rows need. An image whose original the other Mac
   * no longer has can't be shown here, so it's left out; one without a thumbnail comes anyway,
   * as an SVG with no thumbnail does.
   */
  private async fetchFiles(peer: FoundPeer, rows: ChangeRow[], onOriginal: () => void): Promise<ChangeRow[]> {
    const needed = missingFiles(this.opts.libraryPath, rows);
    const lost = new Set<string>();
    let next = 0;
    const worker = async () => {
      while (next < needed.length) {
        const file = needed[next++];
        const ok = await this.download(peer, file.kind, file.name, file.hash);
        if (!ok) lost.add(`${file.kind}/${file.name}`);
        if (file.kind === 'originals') onOriginal();
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, needed.length) }, worker));
    if (!lost.size) return rows;
    return rows.flatMap((row) => {
      if (row.tbl !== 'images' || row.deleted || !row.data) return [row];
      const d = row.data as ImageData;
      if (lost.has(`originals/${d.original}`)) {
        this.log(`${peer.name} no longer has the file for ${d.filename}; skipping it`);
        return [];
      }
      if (d.thumbnail && lost.has(`thumbnails/${d.thumbnail}`)) return [{ ...row, data: { ...d, thumbnail: null } }];
      return [row];
    });
  }

  /** False if the other Mac doesn't have the file; throws on anything else. */
  private async download(peer: FoundPeer, kind: 'originals' | 'thumbnails', name: string, hash: string | null): Promise<boolean> {
    const dest = path.join(this.opts.libraryPath, kind, name);
    // Development only: MUSE_SYNC_SLOW_MS slows each file, to watch the countdown on one Mac
    // where loopback would otherwise finish in a blink.
    const slow = Number(process.env.MUSE_SYNC_SLOW_MS) || 0;
    if (slow > 0) await new Promise((r) => setTimeout(r, slow));
    const { res, key } = await this.call(peer, 'GET', `/v1/files/${kind}/${name}`, 10 * 60_000, true);
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
      return false;
    }
    const iv = res.headers.get('x-muse-iv');
    if (!iv || !res.body) throw new Error(`bad response for ${name}`);
    const temp = `${dest}.part-${crypto.randomBytes(4).toString('hex')}`;
    const digest = crypto.createHash('sha256');
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        digest.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), openStream(key, iv), tap, fs.createWriteStream(temp));
      // Originals are named after their own sha256; check it arrived intact.
      if (kind === 'originals' && hash && digest.digest('hex') !== hash) throw new Error(`${name} arrived damaged`);
      fs.renameSync(temp, dest);
      return true;
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
  }

  // MARK: - Talking to a paired Mac

  private async call(
    peer: FoundPeer,
    method: 'GET' | 'POST',
    target: string,
    timeoutMs = 30_000,
    allowMissing = false,
  ): Promise<{ res: Response; key: Buffer }> {
    if (!this.keys) throw new NotPairedError();
    const signed = signRequest(this.keys, method, target, this.deviceId);
    const res = await fetch(`http://${hostForUrl(peer.host)}:${peer.port}${target}`, {
      method,
      headers: { ...signed, 'x-muse-port': String(this.port), 'x-muse-name': encodeURIComponent(this.name) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      await res.arrayBuffer().catch(() => undefined);
      throw new NotPairedError();
    }
    if (!res.ok && !(allowMissing && res.status === 404)) {
      await res.arrayBuffer().catch(() => undefined);
      throw new Error(`${peer.name} answered ${res.status}`);
    }
    return { res, key: responseKey(this.keys, signed['x-muse-nonce']) };
  }

  private async callJson<T>(peer: FoundPeer, method: 'GET' | 'POST', target: string): Promise<T> {
    const { res, key } = await this.call(peer, method, target);
    const iv = res.headers.get('x-muse-iv');
    if (!iv) throw new Error('unsealed response');
    const body = Buffer.from(await res.arrayBuffer());
    return JSON.parse(open(key, iv, body).toString('utf-8')) as T;
  }

  // MARK: - Serving

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://muse');
    const target = url.pathname + url.search;
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/v1/hello') {
      return sendJson(res, 200, { device: this.deviceId, name: this.name, protocol: PROTOCOL_VERSION });
    }
    if (method === 'POST' && url.pathname.startsWith('/v1/pair/')) {
      return this.handlePairing(url.pathname.slice('/v1/pair/'.length), req, res);
    }

    if (!this.keys) return sendJson(res, 403, { error: 'not paired' });
    const verified = verifyRequest(this.keys, method, target, req.headers, this.nonces);
    if (!verified.ok) return sendJson(res, 401, { error: verified.reason });
    const key = responseKey(this.keys, verified.nonce);
    this.noteContact(verified.device, req);

    if (method === 'GET' && url.pathname === '/v1/changes') {
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || PAGE_SIZE));
      return sendSealed(res, key, readChanges(this.db, since, limit));
    }
    if (method === 'GET' && url.pathname === '/v1/pending') {
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      return sendSealed(res, key, pendingFiles(this.db, since));
    }
    if (method === 'GET' && url.pathname === '/v1/rows') {
      let refs: RowRef[] = [];
      try {
        refs = (JSON.parse(url.searchParams.get('refs') ?? '[]') as RowRef[]).slice(0, 100);
      } catch {
        return sendJson(res, 400, { error: 'bad refs' });
      }
      return sendSealed(res, key, readRows(this.db, refs.filter((r) => ['folders', 'images', 'image_tags'].includes(r.tbl))));
    }
    const file = /^\/v1\/files\/(originals|thumbnails)\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && file) {
      const [, kind, name] = file;
      if (!FILE_NAME_PATTERN.test(name)) return sendJson(res, 400, { error: 'bad name' });
      const full = path.join(this.opts.libraryPath, kind, name);
      if (!fs.existsSync(full)) return sendJson(res, 404, { error: 'missing' });
      const { iv, stream } = sealStream(key);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-muse-iv': iv });
      this.startedSending(verified.device);
      try {
        await pipeline(fs.createReadStream(full), stream, res);
      } finally {
        this.finishedSending(verified.device);
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/poke') {
      this.schedulePull(verified.device, true);
      return sendSealed(res, key, { ok: true });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  private startedSending(device: string): void {
    const entry = this.sending.get(device) ?? { active: 0, lastAt: 0, timer: null };
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.active += 1;
    this.sending.set(device, entry);
    if (entry.active === 1) this.emitState();
  }

  private finishedSending(device: string): void {
    const entry = this.sending.get(device);
    if (!entry) return;
    entry.active = Math.max(0, entry.active - 1);
    entry.lastAt = Date.now();
    if (entry.active > 0) return;
    // Files go one after another; don't flicker off between them.
    entry.timer = setTimeout(() => {
      if (this.sending.get(device) === entry && entry.active === 0) {
        this.sending.delete(device);
        this.emitState();
      }
    }, SENDING_LINGER_MS);
  }

  private isSending(device: string): boolean {
    return this.sending.has(device);
  }

  /**
   * A paired Mac said where it listens. Bonjour usually says the same thing first, but this
   * keeps two Macs syncing on a network where multicast doesn't get through.
   */
  private noteContact(device: string, req: http.IncomingMessage): void {
    const port = Number(req.headers['x-muse-port']);
    const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (!this.keys || !address || !Number.isInteger(port) || port <= 0 || port > 65535) return;
    let name = this.config.peers[device]?.name ?? 'Mac';
    try {
      name = decodeURIComponent(String(req.headers['x-muse-name'] ?? '')) || name;
    } catch {
      /* keep the name we had */
    }
    const known = this.found.get(device);
    if (!known || known.host !== address || known.port !== port || known.tag !== this.keys.tag) {
      this.found.set(device, { deviceId: device, name: known?.name ?? name, tag: this.keys.tag, host: address, port });
      if (!this.config.peers[device]) {
        this.config.peers[device] = { name, lastSyncedAt: null };
        this.save();
      }
      this.emitState();
    }
  }

  // MARK: - Pairing: asking another Mac

  /** Starts pairing with a Mac in `nearby`. Settings then shows the code to compare. */
  async pair(targetId: string): Promise<void> {
    const peer = this.found.get(targetId);
    if (!peer || this.outgoing) return;
    const keys = newPairKeys();
    const out: Outgoing = { deviceId: targetId, name: peer.name, phase: 'connecting', code: null, error: null, peer, session: null, wrapKey: null };
    this.outgoing = out;
    this.emitState();
    try {
      const start = await postJson<{ session: string; pub: string; device: string; name: string }>(peer, '/v1/pair/start', {
        device: this.deviceId,
        name: this.name,
        commit: commitment(keys.publicKey),
      });
      if (start.device !== targetId) throw new Error('A different Mac answered.');
      out.session = start.session;
      out.name = start.name || out.name;
      await postJson(peer, '/v1/pair/reveal', { session: start.session, pub: keys.publicKey.toString('base64') });
      const theirs = Buffer.from(start.pub, 'base64');
      const shared = sharedSecret(keys, theirs);
      out.code = pairingCode(shared, keys.publicKey, theirs);
      out.wrapKey = pairingWrapKey(shared, keys.publicKey, theirs);
      if (this.outgoing === out) out.phase = 'confirm';
    } catch (err) {
      if (this.outgoing === out) {
        out.phase = 'failed';
        out.error = err instanceof Error ? err.message : String(err);
      }
    }
    this.emitState();
  }

  /** The person here says the codes match. Waits for Allow on the other Mac. */
  async confirmPair(): Promise<void> {
    const out = this.outgoing;
    if (!out || out.phase !== 'confirm' || !out.session || !out.wrapKey) return;
    out.phase = 'waiting';
    this.emitState();
    try {
      const reply = await postJson<{ iv: string; payload: string }>(out.peer, '/v1/pair/finish', { session: out.session }, 130_000);
      const grant = JSON.parse(open(out.wrapKey, reply.iv, Buffer.from(reply.payload, 'base64')).toString('utf-8')) as PairGrant;
      if (grant.device !== out.deviceId) throw new Error('A different Mac answered.');
      const tag = this.joinGroup(grant);
      if (this.outgoing === out) out.phase = 'done';
      this.log(`paired with ${grant.name}`);
      this.found.set(out.deviceId, { ...out.peer, name: grant.name, tag });
      this.schedulePull(out.deviceId);
      setTimeout(() => {
        if (this.outgoing === out) {
          this.outgoing = null;
          this.emitState();
        }
      }, 2500);
    } catch (err) {
      if (this.outgoing === out) {
        out.phase = 'failed';
        out.error = err instanceof Error ? err.message : String(err);
      }
    }
    this.emitState();
  }

  /** Stops pairing from this side, or dismisses a finished or failed attempt. */
  cancelPair(): void {
    const out = this.outgoing;
    if (!out) return;
    this.outgoing = null;
    if (out.session && (out.phase === 'confirm' || out.phase === 'waiting' || out.phase === 'connecting')) {
      postJson(out.peer, '/v1/pair/cancel', { session: out.session }).catch(() => undefined);
    }
    this.emitState();
  }

  /** Returns the group's public tag. */
  private joinGroup(grant: PairGrant): string {
    const key = Buffer.from(grant.groupKey, 'base64');
    const keys = deriveKeys(key);
    this.config.group = { id: grant.groupId, sealedKey: this.opts.sealer.seal(key) };
    this.keys = keys;
    this.config.peers[grant.device] = { name: grant.name, lastSyncedAt: this.config.peers[grant.device]?.lastSyncedAt ?? null };
    for (const m of grant.members) {
      if (m.deviceId !== this.deviceId && !this.config.peers[m.deviceId]) this.config.peers[m.deviceId] = { name: m.name, lastSyncedAt: null };
    }
    this.save();
    this.advertise();
    for (const peer of this.groupPeers()) this.schedulePull(peer.deviceId);
    return keys.tag;
  }

  // MARK: - Pairing: being asked

  /** The person here allows or refuses the Mac asking to pair. */
  respondToPair(session: string, allow: boolean): void {
    const inc = this.incoming;
    if (!inc || inc.session !== session || inc.decision !== 'pending') return;
    if (!allow) {
      inc.decision = 'deny';
      inc.waiters.splice(0).forEach((w) => w());
      this.clearIncoming();
      this.emitState();
      return;
    }
    if (!this.config.group) {
      const key = newGroupKey();
      this.config.group = { id: crypto.randomUUID(), sealedKey: this.opts.sealer.seal(key) };
      this.keys = deriveKeys(key);
      this.save();
      this.advertise();
    }
    inc.decision = 'allow';
    inc.phase = 'waiting';
    inc.waiters.splice(0).forEach((w) => w());
    this.emitState();
  }

  private clearIncoming(): void {
    if (this.incoming) clearTimeout(this.incoming.expires);
    this.incoming = null;
  }

  private async handlePairing(step: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf-8')) as Record<string, unknown>;
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
    const inc = this.incoming;
    const sameSession = inc && body.session === inc.session;

    if (step === 'start') {
      if (!this.config.enabled) return sendJson(res, 403, { error: 'Sync is off on that Mac.' });
      if (inc || this.outgoing) return sendJson(res, 409, { error: 'That Mac is busy pairing with another. Try again in a minute.' });
      const device = String(body.device ?? '');
      const name = String(body.name ?? 'A Mac').slice(0, 60);
      const commit = String(body.commit ?? '');
      if (!/^[a-f0-9]{32}$/.test(device) || !/^[a-f0-9]{64}$/.test(commit)) return sendJson(res, 400, { error: 'bad request' });
      const keys = newPairKeys();
      const session = crypto.randomBytes(16).toString('hex');
      this.incoming = {
        session, device, name, commit, keys, phase: 'started', code: null, wrapKey: null, decision: 'pending', waiters: [],
        expires: setTimeout(() => {
          if (this.incoming?.session === session) {
            this.incoming.waiters.splice(0).forEach((w) => w());
            this.clearIncoming();
            this.emitState();
          }
        }, PAIR_TTL_MS),
      };
      return sendJson(res, 200, { session, pub: keys.publicKey.toString('base64'), device: this.deviceId, name: this.name });
    }

    if (!inc || !sameSession) return sendJson(res, 404, { error: 'That pairing request has ended.' });

    if (step === 'reveal') {
      if (inc.phase !== 'started') return sendJson(res, 409, { error: 'out of order' });
      const pub = Buffer.from(String(body.pub ?? ''), 'base64');
      if (pub.length !== 32 || commitment(pub) !== inc.commit) {
        this.clearIncoming();
        this.emitState();
        return sendJson(res, 400, { error: 'bad key' });
      }
      const shared = sharedSecret(inc.keys, pub);
      inc.code = pairingCode(shared, pub, inc.keys.publicKey);
      inc.wrapKey = pairingWrapKey(shared, pub, inc.keys.publicKey);
      inc.phase = 'ask';
      this.log(`${inc.name} is asking to pair`);
      this.emitState();
      return sendJson(res, 200, { ok: true });
    }

    if (step === 'finish') {
      if (inc.phase === 'started') return sendJson(res, 409, { error: 'out of order' });
      if (inc.decision === 'pending') {
        await new Promise<void>((resolve) => inc.waiters.push(resolve));
      }
      if (inc.decision !== 'allow' || !this.keys || !this.config.group || !inc.wrapKey) {
        return sendJson(res, 403, { error: `${this.name} didn't allow it.` });
      }
      const grant: PairGrant = {
        groupId: this.config.group.id,
        groupKey: this.opts.sealer.open(this.config.group.sealedKey).toString('base64'),
        device: this.deviceId,
        name: this.name,
        members: Object.entries(this.config.peers).map(([deviceId, p]) => ({ deviceId, name: p.name })),
      };
      const sealed = seal(inc.wrapKey, Buffer.from(JSON.stringify(grant)));
      this.config.peers[inc.device] = { name: inc.name, lastSyncedAt: this.config.peers[inc.device]?.lastSyncedAt ?? null };
      this.save();
      this.log(`paired with ${inc.name}`);
      this.clearIncoming();
      this.emitState();
      return sendJson(res, 200, { iv: sealed.iv, payload: sealed.body.toString('base64') });
    }

    if (step === 'cancel') {
      inc.decision = 'deny';
      inc.waiters.splice(0).forEach((w) => w());
      this.clearIncoming();
      this.emitState();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'not found' });
  }
}

// MARK: - Helpers

/** This Mac's addresses, to notice it changing networks. */
function networkSignature(): string {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && !a.internal && a.family === 'IPv4')
    .map((a) => a.address)
    .sort()
    .join(',');
}

function hostForUrl(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}

function sendSealed(res: http.ServerResponse, key: Buffer, body: unknown): void {
  const { iv, body: sealed } = seal(key, Buffer.from(JSON.stringify(body)));
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-muse-iv': iv, 'content-length': sealed.length });
  res.end(sealed);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Pairing requests: plain JSON, before there's anything to sign with. */
async function postJson<T>(peer: FoundPeer, target: string, body: unknown, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://${hostForUrl(peer.host)}:${peer.port}${target}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Couldn't reach ${peer.name}. ${err instanceof Error && err.name === 'TimeoutError' ? 'It took too long to answer.' : ''}`.trim());
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${peer.name} answered ${res.status}`);
  return json as T;
}
