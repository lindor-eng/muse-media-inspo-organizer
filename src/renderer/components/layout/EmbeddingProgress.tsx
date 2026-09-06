import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Brain } from 'lucide-react';

interface ProgressState {
  current: number;
  total: number;
  status: string;
  type: 'autotag' | 'embedding';
}

const AUTO_TAG_MESSAGES = [
  'Analyzing your items...',
  'Generating descriptions & tags...',
  'Teaching AI about your collection...',
  'Looking at the details...',
  'Writing alt text...',
];

export function EmbeddingProgress() {
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [visible, setVisible] = useState(false);
  /** Bumped each time the queue grows — drives the re-mount of the pulse + glow animations. */
  const [flourishKey, setFlourishKey] = useState(0);
  /** Measured visible canvas bounds — drives portal positioning so the toast cannot drift. */
  const [coords, setCoords] = useState<{ centerX: number; bottom: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTotal = useRef(0);

  // Position via portal, measuring the actual on-screen canvas every animation frame while visible.
  // This bypasses every flex-layout edge case — we just read getBoundingClientRect.
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

  useEffect(() => {
    const onProgress = (data: { current: number; total: number; status: string }, type: 'autotag' | 'embedding') => {
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }

      // Flourish fires on:
      //   1. The toast appearing from hidden (first image of any fresh batch)
      //   2. Any later image that grows the in-flight total
      setVisible((wasVisible) => {
        if (!wasVisible || data.total > lastTotal.current) {
          setFlourishKey((k) => k + 1);
        }
        return true;
      });
      lastTotal.current = data.total;

      const status = type === 'autotag'
        ? (data.current < data.total ? AUTO_TAG_MESSAGES[data.current % AUTO_TAG_MESSAGES.length] : 'Auto-tagging complete')
        : data.status;
      setProgress({ ...data, status, type });

      if (data.current >= data.total && data.total > 0) {
        hideTimer.current = setTimeout(() => {
          setVisible(false);
          lastTotal.current = 0;
        }, 2500);
      }
    };

    const cleanupAutotag = window.electronAPI.onAutotagProgress((d: { current: number; total: number; status: string }) => onProgress(d, 'autotag'));
    const cleanupEmbedding = window.electronAPI.onEmbeddingProgress((d: { current: number; total: number; status: string }) => onProgress(d, 'embedding'));

    return () => { cleanupAutotag(); cleanupEmbedding(); };
  }, []);

  if (!progress || !visible || !coords) return null;

  const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const isDone = progress.current >= progress.total && progress.total > 0;
  const remaining = progress.total - progress.current;

  return createPortal(
    <div
      className="fixed z-50"
      style={{
        left: coords.centerX,
        bottom: coords.bottom + 24,
        transform: 'translateX(-50%)',
      }}
    >
      <div className="relative animate-fade-in-y">
        {/* Persistent gradient halo — flows continuously the entire time the toast is up. */}
        <div className="ai-glow-base" aria-hidden />
        {/* One-shot burst layer that expands the blur in sync with the card's scale pulse;
            re-mounts on each flourishKey bump so the burst restarts on every new image. */}
        <div key={`burst-${flourishKey}`} className="ai-glow-burst" aria-hidden />
        <div
          key={`card-${flourishKey}`}
          className="relative bg-gray-800 border border-gray-700 rounded-lg shadow-xl px-5 py-3 min-w-[300px] max-w-[360px] animate-toast-pulse"
        >
          <div className="flex items-center gap-2 mb-2">
            {progress.type === 'autotag' ? (
              <Sparkles size={14} className={`text-purple-400 ${!isDone ? 'animate-pulse' : ''}`} />
            ) : (
              <Brain size={14} className={`text-blue-400 ${!isDone ? 'animate-pulse' : ''}`} />
            )}
            <p className="text-sm text-gray-200">
              {isDone ? progress.status : progress.status}
            </p>
          </div>
          <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ease-out ${progress.type === 'autotag' ? 'bg-purple-500' : 'bg-blue-500'}`}
              style={{ width: `${percentage}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-1.5">
            {isDone
              ? `${progress.total} items processed`
              : `${remaining} item${remaining === 1 ? '' : 's'} remaining`
            }
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
