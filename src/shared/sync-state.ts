/**
 * What Settings › Sync shows, sent from main on `sync:state` whenever it changes. Shared so
 * preload can type it without importing main.
 */

export interface SyncPeerState {
  deviceId: string;
  name: string;
  /** Seen on this network now. */
  online: boolean;
  status: 'idle' | 'syncing' | 'error';
  /** While receiving: files (images and videos) taken in so far, out of how many are coming.
      Null when no files are coming, only edits. */
  progress: { done: number; total: number } | null;
  /** That Mac is copying files from this one right now. */
  sending: boolean;
  /** Epoch ms of the last pull that finished, or null if never. */
  lastSyncedAt: number | null;
  error: string | null;
}

export interface SyncNearbyMac {
  deviceId: string;
  name: string;
}

export interface OutgoingPairState {
  deviceId: string;
  name: string;
  /** connecting → confirm (code shown) → waiting (for Allow there) → done | failed */
  phase: 'connecting' | 'confirm' | 'waiting' | 'done' | 'failed';
  code: string | null;
  error: string | null;
}

export interface IncomingPairState {
  session: string;
  name: string;
  code: string;
  /** ask: Allow / Don't Allow. waiting: allowed here, waiting for Codes Match there. */
  phase: 'ask' | 'waiting';
}

export interface SyncState {
  enabled: boolean;
  /** What other Macs see this one as. */
  name: string;
  deviceId: string;
  /** In a sync group (paired with at least one Mac at some point). */
  paired: boolean;
  /** Reachable by other Macs: the server is up and advertised. */
  listening: boolean;
  /** Why sync couldn't start, if it couldn't. */
  error: string | null;
  peers: SyncPeerState[];
  nearby: SyncNearbyMac[];
  outgoingPair: OutgoingPairState | null;
  incomingPair: IncomingPairState | null;
}

/** What one finished sync brought in, for the toast. Sent on `sync:summary`. */
export interface SyncSummary {
  deviceId: string;
  name: string;
  added: number;
  removed: number;
  changed: number;
}

export const SYNC_STATE_OFF: SyncState = {
  enabled: false,
  name: '',
  deviceId: '',
  paired: false,
  listening: false,
  error: null,
  peers: [],
  nearby: [],
  outgoingPair: null,
  incomingPair: null,
};
