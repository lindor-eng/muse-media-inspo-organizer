import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import type { SyncSummary } from '../../../shared/sync-state';
import { api } from '../../lib/ipc';
import { useAppStore } from '../../stores/app-store';

const GATHER_MS = 1500;
const SHOW_MS = 5000;

interface Shown {
  names: string[];
  added: number;
  removed: number;
  changed: number;
}

/** "412 added · 3 removed · 7 changed", leaving out the parts that are zero. */
export function describeSummary(s: { added: number; removed: number; changed: number }): string {
  return [
    s.added ? `${s.added.toLocaleString()} added` : '',
    s.removed ? `${s.removed.toLocaleString()} removed` : '',
    s.changed ? `${s.changed.toLocaleString()} changed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What a finished sync brought in, at the bottom of the grid for five seconds. Syncs that finish
 * close together (several Macs at once) make one toast. Sits above the AI progress toast when
 * that's showing.
 */
export function SyncToast() {
  const aiToastVisible = useAppStore((s) => s.aiToastVisible);
  const [shown, setShown] = useState<Shown | null>(null);
  const pending = useRef<SyncSummary[]>([]);
  const gather = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stop = api.onSyncSummary((summary) => {
      pending.current.push(summary);
      if (gather.current) return;
      gather.current = setTimeout(() => {
        gather.current = null;
        const batch = pending.current.splice(0);
        const names = [...new Set(batch.map((b) => b.name))];
        const total = batch.reduce((t, b) => ({ added: t.added + b.added, removed: t.removed + b.removed, changed: t.changed + b.changed }), { added: 0, removed: 0, changed: 0 });
        if (!total.added && !total.removed && !total.changed) return;
        setShown({ names, ...total });
        if (hide.current) clearTimeout(hide.current);
        hide.current = setTimeout(() => setShown(null), SHOW_MS);
      }, GATHER_MS);
    });
    return () => {
      stop();
      if (gather.current) clearTimeout(gather.current);
      if (hide.current) clearTimeout(hide.current);
    };
  }, []);

  if (!shown) return null;
  const title = shown.names.length === 1 ? `Synced with ${shown.names[0]}` : `Synced with ${shown.names.length} Macs`;

  return (
    <div
      role="status"
      className="absolute left-1/2 -translate-x-1/2 z-50 transition-[bottom] duration-200"
      style={{ bottom: aiToastVisible ? 116 : 24 }}
    >
      <div className="animate-fade-in-y bg-gray-800 border border-gray-700 rounded-lg shadow-xl px-4 py-3 min-w-[300px] max-w-[380px] flex items-start gap-2.5">
        <Check size={15} className="text-green-400 mt-0.5 shrink-0" />
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm text-gray-200 truncate">{title}</span>
          <span className="text-xs text-gray-400 tabular-nums">{describeSummary(shown)}</span>
        </div>
      </div>
    </div>
  );
}
