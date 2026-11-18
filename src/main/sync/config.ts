import fs from 'node:fs';
import path from 'node:path';

/**
 * Sync's own settings, kept in `userData/sync.json` rather than the library database: the
 * database is what File › Export Library copies into a `.muse` bundle, and the group key must
 * never travel in one. The key is stored sealed (Electron's safeStorage, i.e. the keychain).
 */

export interface KnownPeer {
  name: string;
  lastSyncedAt: number | null;
}

export interface SyncConfig {
  enabled: boolean;
  /** Empty means "use the Mac's name". */
  name: string;
  group: { id: string; sealedKey: string } | null;
  peers: Record<string, KnownPeer>;
  /** Per peer device: how far through its change log this library has got. */
  cursors: Record<string, { epoch: string; seq: number }>;
}

export interface Sealer {
  seal(secret: Buffer): string;
  open(sealed: string): Buffer;
}

export const DEFAULT_CONFIG: SyncConfig = { enabled: false, name: '', group: null, peers: {}, cursors: {} };

export function loadConfig(file: string): SyncConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SyncConfig>;
    return {
      enabled: raw.enabled === true,
      name: typeof raw.name === 'string' ? raw.name : '',
      group: raw.group && typeof raw.group.id === 'string' && typeof raw.group.sealedKey === 'string' ? raw.group : null,
      peers: raw.peers && typeof raw.peers === 'object' ? raw.peers : {},
      cursors: raw.cursors && typeof raw.cursors === 'object' ? raw.cursors : {},
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** Written to a temporary file and renamed, so a crash mid-write can't leave half a file. */
export function saveConfig(file: string, config: SyncConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
