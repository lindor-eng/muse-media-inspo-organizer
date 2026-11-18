import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Lock, Monitor } from 'lucide-react';
import type { SyncPeerState } from '../../../shared/sync-state';
import { api } from '../../lib/ipc';
import { formatLastSynced, useSyncState } from './useSyncState';
import { SectionTitle, Switch } from './ui';

function MacIcon({ dim }: { dim?: boolean }) {
  return (
    <span className={`w-[34px] h-[34px] rounded-lg bg-gray-800 flex items-center justify-center shrink-0 ${dim ? 'text-gray-600' : 'text-gray-400'}`}>
      <Monitor size={18} />
    </span>
  );
}

function PeerStatus({ peer }: { peer: SyncPeerState }) {
  if (peer.status === 'syncing') {
    if (peer.progress && peer.progress.total > 0) {
      const percent = Math.min(100, Math.round((peer.progress.done / peer.progress.total) * 100));
      return (
        <div className="flex items-center gap-2.5">
          <div className="w-[200px] h-1 rounded bg-gray-800 overflow-hidden">
            <div className="h-1 bg-blue-500 transition-all duration-300" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-xs text-blue-300 tabular-nums">
            {(peer.progress.total - peer.progress.done).toLocaleString()} files left
          </span>
        </div>
      );
    }
    return (
      <span className="text-xs text-blue-300 flex items-center gap-1.5">
        <Loader2 size={11} className="animate-spin" />
        Syncing…
      </span>
    );
  }
  if (peer.sending) {
    return (
      <span className="text-xs text-blue-300 flex items-center gap-1.5">
        <Loader2 size={11} className="animate-spin" />
        Sending to {peer.name}…
      </span>
    );
  }
  if (peer.status === 'error' && peer.error) {
    return <span className="text-xs text-red-400">{peer.error}</span>;
  }
  if (peer.online) {
    return (
      <span className="text-xs text-green-300 flex items-center gap-1.5">
        <span className="w-[7px] h-[7px] rounded-full bg-green-500" />
        Up to date
      </span>
    );
  }
  return (
    <span className="text-xs text-gray-400 flex items-center gap-1.5">
      <span className="w-[7px] h-[7px] rounded-full bg-gray-600" />
      Not on this network · {formatLastSynced(peer.lastSyncedAt)}
    </span>
  );
}

/** Settings › Sync. */
export function SyncSettings() {
  const state = useSyncState();
  const [name, setName] = useState('');
  const [nameFocused, setNameFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  // Re-render once a minute so "synced 3 minutes ago" keeps up.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!nameFocused) setName(state.name);
  }, [state.name, nameFocused]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await api.setSyncEnabled(on);
    } finally {
      setBusy(false);
    }
  };

  const saveName = () => {
    setNameFocused(false);
    if (name.trim() && name.trim() !== state.name) void api.setSyncName(name.trim());
    else setName(state.name);
  };

  const pairing = state.outgoingPair !== null;

  return (
    <section className="px-8 py-6 flex flex-col gap-5 min-h-full">
      <header className="flex items-start gap-4 pr-8">
        <div className="flex-1 flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-gray-100">Sync</h2>
          <p className="text-sm text-gray-400 max-w-[440px] leading-snug">
            Keeps this library the same on your other Macs whenever they&apos;re on the same Wi-Fi with Muse open.
          </p>
        </div>
        {state.enabled && state.paired && (
          <button
            type="button"
            onClick={() => void api.syncNow()}
            className="shrink-0 px-3 py-1.5 text-xs font-medium text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md transition-colors"
          >
            Sync now
          </button>
        )}
      </header>

      <div className="bg-gray-950/40 border border-gray-800 rounded-lg flex flex-col">
        <div className={`flex items-center gap-3 px-4 py-3 ${state.enabled ? 'border-b border-gray-800' : ''}`}>
          <label htmlFor="sync-enabled" className="flex-1 flex flex-col gap-0.5 cursor-pointer">
            <span className="text-sm font-medium text-gray-100">Sync this library</span>
            <span className="text-xs text-gray-500">
              {state.enabled
                ? 'Images, videos, folders, tags, notes and AI descriptions'
                : "Off. Nothing leaves this Mac, and other Macs can't see it."}
            </span>
          </label>
          <Switch id="sync-enabled" on={state.enabled} onChange={(on) => void toggle(on)} disabled={busy} />
        </div>
        {state.enabled && (
          <div className="flex items-center gap-3 px-4 py-2.5">
            <label htmlFor="sync-name" className="flex-1 text-sm font-medium text-gray-100">
              This Mac&apos;s name
            </label>
            <input
              id="sync-name"
              type="text"
              value={name}
              maxLength={60}
              onFocus={() => setNameFocused(true)}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setName(state.name);
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="w-[220px] px-2.5 py-1.5 text-sm bg-gray-900 border border-gray-700 rounded-md text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
        )}
      </div>

      {state.enabled && state.error && (
        <p className="flex items-start gap-2 text-sm text-red-400">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          {state.error}
        </p>
      )}

      {state.enabled ? (
        <>
          {state.peers.length > 0 && (
            <div className="flex flex-col gap-2">
              <SectionTitle>Syncing with</SectionTitle>
              <ul className="bg-gray-950/40 border border-gray-800 rounded-lg divide-y divide-gray-800">
                {state.peers.map((peer) => (
                  <li key={peer.deviceId} className="flex items-center gap-3 px-4 py-3">
                    <MacIcon dim={!peer.online} />
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      <span className={`text-sm font-medium truncate ${peer.online ? 'text-gray-100' : 'text-gray-300'}`}>{peer.name}</span>
                      <PeerStatus peer={peer} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <SectionTitle>Other Macs on this network</SectionTitle>
            {state.nearby.length > 0 ? (
              <ul className="bg-gray-950/40 border border-gray-800 rounded-lg divide-y divide-gray-800">
                {state.nearby.map((mac) => (
                  <li key={mac.deviceId} className="flex items-center gap-3 px-4 py-3">
                    <MacIcon />
                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-gray-100 truncate">{mac.name}</span>
                      <span className="text-xs text-gray-400">Has sync on, not paired with this Mac</span>
                    </div>
                    <button
                      type="button"
                      disabled={pairing}
                      onClick={() => void api.pairWith(mac.deviceId)}
                      className="shrink-0 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md transition-colors"
                    >
                      Pair…
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500 leading-relaxed max-w-[520px]">
                {state.listening ? (
                  <>
                    <Loader2 size={12} className="inline animate-spin mr-1.5 -mt-0.5" />
                    Looking… Open Muse on your other Mac, on this Wi-Fi, and turn on sync there too.
                  </>
                ) : (
                  'Not listening for other Macs.'
                )}
              </p>
            )}
          </div>

          <footer className="mt-auto pt-3.5 border-t border-gray-800">
            {confirmingLeave ? (
              <div className="flex items-center gap-3">
                <p className="flex-1 text-xs text-gray-300 leading-relaxed">
                  This Mac stops syncing and forgets the Macs it synced with. Its library stays as it is, and so do theirs.
                </p>
                <button
                  type="button"
                  onClick={() => setConfirmingLeave(false)}
                  className="px-3 py-1.5 text-xs text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingLeave(false);
                    void api.leaveSync();
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-md"
                >
                  Stop Syncing
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <p className="flex-1 flex items-start gap-2 text-xs text-gray-400 leading-relaxed">
                  <Lock size={13} className="mt-0.5 shrink-0" />
                  Only Macs you pair can connect, and everything they send each other is encrypted.
                </p>
                {state.paired && (
                  <button
                    type="button"
                    onClick={() => setConfirmingLeave(true)}
                    className="shrink-0 px-3 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 border border-red-900/60 hover:border-red-800 rounded-md transition-colors"
                  >
                    Stop syncing this Mac…
                  </button>
                )}
              </div>
            )}
          </footer>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-3 pt-1">
            <SectionTitle>How it works</SectionTitle>
            <ol className="flex flex-col gap-3 max-w-[520px]">
              {[
                'Turn sync on here and in Muse on your other Mac.',
                'Each Mac lists the other. Click Pair on one and check both show the same six digits.',
                "The two libraries merge. From then on, anything added, moved, tagged, edited or deleted on one Mac shows up on the other within seconds while both are on the same network. A Mac that was away catches up when it's back.",
              ].map((text, i) => (
                <li key={i} className="flex gap-3 items-start">
                  <span className="w-[22px] h-[22px] rounded-full bg-gray-800 text-blue-300 text-xs font-semibold flex items-center justify-center shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-sm text-gray-300 leading-relaxed">{text}</span>
                </li>
              ))}
            </ol>
          </div>
          <p className="mt-auto text-xs text-gray-400 leading-relaxed max-w-[560px]">
            The first time you turn it on, macOS asks to let Muse find devices on your local network. Choose Allow.
          </p>
        </>
      )}
    </section>
  );
}
