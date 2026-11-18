import { useEffect, useState } from 'react';
import { SYNC_STATE_OFF, type SyncState } from '../../../shared/sync-state';
import { api } from '../../lib/ipc';

/** Sync's state from main, kept current. */
export function useSyncState(): SyncState {
  const [state, setState] = useState<SyncState>(SYNC_STATE_OFF);
  useEffect(() => {
    let live = true;
    void api.getSyncState().then((s) => { if (live) setState(s); });
    const stop = api.onSyncState((s) => setState(s));
    return () => {
      live = false;
      stop();
    };
  }, []);
  return state;
}

/** "482913" → "482 913", easier to read aloud and compare. */
export function formatCode(code: string | null): string {
  return code ? `${code.slice(0, 3)} ${code.slice(3)}` : '';
}

export function formatLastSynced(at: number | null, now = Date.now()): string {
  if (!at) return 'never synced';
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'synced just now';
  if (minutes < 60) return `synced ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const then = new Date(at);
  const time = then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (then.toDateString() === today.toDateString()) return `synced today at ${time}`;
  if (then.toDateString() === yesterday.toDateString()) return `synced yesterday at ${time}`;
  return `last synced ${then.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}
