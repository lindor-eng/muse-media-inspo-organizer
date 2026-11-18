import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';
import type { SyncPeerState } from '../../../shared/sync-state';
import { useAppStore } from '../../stores/app-store';
import { StatusDot } from './ui';
import { useSyncState } from './useSyncState';

function PeerLine({ peer }: { peer: SyncPeerState }) {
  if (peer.status === 'syncing' && peer.progress && peer.progress.total > 0) {
    const { done, total } = peer.progress;
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-gray-100 truncate">From {peer.name}</span>
          <span className="text-xs text-blue-300 tabular-nums shrink-0">
            {(total - done).toLocaleString()} {total - done === 1 ? 'file' : 'files'} left
          </span>
        </div>
        <div className="h-1 rounded bg-gray-800 overflow-hidden">
          <div className="h-1 bg-blue-500 transition-all duration-300" style={{ width: `${Math.round((done / total) * 100)}%` }} />
        </div>
        <span className="text-[11px] text-gray-500 tabular-nums">
          {done.toLocaleString()} of {total.toLocaleString()} received
        </span>
      </div>
    );
  }
  let status: React.ReactNode;
  if (peer.status === 'syncing') status = <span className="text-xs text-blue-300">Receiving changes…</span>;
  else if (peer.sending) status = <span className="text-xs text-blue-300">Sending…</span>;
  else if (peer.status === 'error') status = <StatusDot tone="warn">{peer.error ?? "Couldn't sync"}</StatusDot>;
  else if (peer.online) status = <StatusDot tone="good">Up to date</StatusDot>;
  else status = <StatusDot tone="off">Not on this network</StatusDot>;
  const name = peer.sending && peer.status !== 'syncing' ? `To ${peer.name}` : peer.name;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-gray-200 truncate">{name}</span>
      <span className="shrink-0 max-w-[60%] text-right">{status}</span>
    </div>
  );
}

/**
 * The sync icon right of the username. Hidden unless something is happening: blue double arrows
 * spin while this Mac receives or sends; they turn amber and stop if a paired Mac can't be
 * reached after the quiet retries. Hovering shows what's left to come.
 */
export function SyncIndicator() {
  const state = useSyncState();
  const openSettings = useAppStore((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = state.peers.some((p) => p.status === 'syncing' || p.sending);
  // Stays a moment after the last item lands, so quick pulls in a row don't make it blink, and a
  // hover card that's open doesn't vanish between them.
  const [lingering, setLingering] = useState(false);
  useEffect(() => {
    if (active) {
      setLingering(true);
      return;
    }
    const t = setTimeout(() => setLingering(false), 1500);
    return () => clearTimeout(t);
  }, [active]);
  const busy = active || lingering;
  const failing = state.peers.some((p) => p.status === 'error');
  const visible = state.enabled && (busy || failing);

  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = button.current?.getBoundingClientRect();
      if (r) setAnchor({ top: r.bottom + 8, left: r.left + r.width / 2 });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  if (!visible) return null;

  // Hovering moves from the icon to the card without it closing in between.
  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  const shown = state.peers.filter((p) => p.status !== 'idle' || p.sending || p.online);
  const label = busy ? 'Syncing' : 'Sync needs attention';

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => openSettings('sync')}
        className={`p-0.5 -m-0.5 mr-2.5 rounded block ${busy ? 'text-blue-400' : 'text-amber-400'}`}
      >
        <RefreshCw size={14} className={busy ? 'animate-spin [animation-duration:1.1s]' : undefined} />
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            role="tooltip"
            onMouseEnter={show}
            onMouseLeave={hide}
            style={{ position: 'fixed', top: anchor.top, left: Math.max(12, anchor.left - 150) }}
            className="z-[9999] w-[300px] rounded-lg border border-gray-700 bg-gray-900/95 backdrop-blur-sm shadow-xl px-4 py-3.5 flex flex-col gap-3 animate-fade-in-y"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{busy ? 'Syncing' : 'Sync'}</span>
              <button type="button" className="text-[11px] text-blue-400 hover:text-blue-300" onClick={() => openSettings('sync')}>
                Sync settings
              </button>
            </div>
            <div className="flex flex-col gap-3 divide-y divide-gray-800 [&>*+*]:pt-3">
              {shown.map((peer) => (
                <PeerLine key={peer.deviceId} peer={peer} />
              ))}
            </div>
            {busy && <p className="text-[11px] text-gray-500 leading-relaxed">Keep using Muse. New items appear as they arrive.</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
