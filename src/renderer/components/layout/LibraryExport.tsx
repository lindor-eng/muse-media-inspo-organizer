import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, AlertCircle } from 'lucide-react';
import { api } from '../../lib/ipc';

type Phase = 'snapshot' | 'archive' | 'finalize';

type State =
  | { kind: 'idle' }
  | { kind: 'exporting'; phase: Phase; current: number; total: number }
  | { kind: 'done'; bytes: number; originals: number }
  | { kind: 'error'; message: string };

export function LibraryExport() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [coords, setCoords] = useState<{ centerX: number; bottom: number } | null>(null);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Hook the File menu trigger.
  useEffect(() => {
    const cleanup = api.onMenuEvent('menu:exportLibrary', () => {
      void start();
    });
    return cleanup;
  }, []);

  // Live progress while archiving — updated in place so the toast doesn't re-mount per tick.
  useEffect(() => {
    const cleanup = api.onLibraryExportProgress((p) => {
      const s = stateRef.current;
      if (s.kind !== 'exporting') return;
      setState({ kind: 'exporting', phase: p.phase, current: p.current, total: p.total });
    });
    return cleanup;
  }, []);

  // Mirror EmbeddingProgress positioning logic so the export toast lands on the same baseline.
  const visible = state.kind === 'exporting' || state.kind === 'done' || state.kind === 'error';
  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const tick = () => {
      const el = document.querySelector('[data-grid-canvas]') as HTMLElement | null;
      if (el) {
        const r = el.getBoundingClientRect();
        setCoords((prev) => {
          const cx = r.left + r.width / 2;
          const b = window.innerHeight - r.bottom;
          if (prev && Math.abs(prev.centerX - cx) < 0.5 && Math.abs(prev.bottom - b) < 0.5) return prev;
          return { centerX: cx, bottom: b };
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  // Auto-hide on success/error after 3s.
  useEffect(() => {
    if (state.kind !== 'done' && state.kind !== 'error') return;
    const t = setTimeout(() => setState({ kind: 'idle' }), 3000);
    return () => clearTimeout(t);
  }, [state]);

  async function start() {
    if (stateRef.current.kind === 'exporting') return;
    const dest = await api.chooseSaveLibraryBundle();
    if (!dest) return;
    setState({ kind: 'exporting', phase: 'snapshot', current: 0, total: 1 });
    try {
      const result = await api.exportLibrary(dest);
      setState({ kind: 'done', bytes: result.bytes, originals: result.originalsCount });
    } catch (err) {
      setState({ kind: 'error', message: String(err) });
    }
  }

  if (!visible || !coords) return null;

  return createPortal(
    <div
      className="fixed z-50"
      style={{ left: coords.centerX, bottom: coords.bottom + 24, transform: 'translateX(-50%)' }}
    >
      <div className="animate-fade-in-y">
        <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl px-5 py-3 min-w-[300px] max-w-[360px]">
          {state.kind === 'exporting' ? <ExportingBody state={state} /> : null}
          {state.kind === 'done' ? <DoneBody bytes={state.bytes} originals={state.originals} /> : null}
          {state.kind === 'error' ? <ErrorBody message={state.message} /> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ExportingBody({
  state,
}: {
  state: Extract<State, { kind: 'exporting' }>;
}) {
  const pct = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
  const label =
    state.phase === 'snapshot'
      ? 'Snapshotting library…'
      : state.phase === 'archive'
        ? `Packaging files (${state.current} / ${state.total})…`
        : 'Finalizing bundle…';
  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <Archive size={14} className="text-blue-400 animate-pulse" />
        <p className="text-sm text-gray-200">{label}</p>
      </div>
      <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </>
  );
}

function DoneBody({ bytes, originals }: { bytes: number; originals: number }) {
  return (
    <>
      <div className="flex items-center gap-2 mb-1">
        <Archive size={14} className="text-green-400" />
        <p className="text-sm text-gray-200">Library exported</p>
      </div>
      <p className="text-xs text-gray-500">
        {originals} {originals === 1 ? 'image' : 'images'} · {formatBytes(bytes)}
      </p>
    </>
  );
}

function ErrorBody({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2">
      <AlertCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
      <p className="text-sm text-gray-200">{message}</p>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
