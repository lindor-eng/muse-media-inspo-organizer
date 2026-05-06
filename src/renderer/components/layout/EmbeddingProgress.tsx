import { useEffect, useState, useRef } from 'react';
import { Sparkles, Brain } from 'lucide-react';

interface ProgressState {
  current: number;
  total: number;
  status: string;
  type: 'autotag' | 'embedding';
}

const AUTO_TAG_MESSAGES = [
  'Analyzing your images...',
  'Generating descriptions & tags...',
  'Teaching AI about your collection...',
  'Looking at the details...',
  'Writing alt text...',
];

export function EmbeddingProgress() {
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const cleanupAutotag = window.electronAPI.onAutotagProgress((data) => {
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
      const msgIndex = data.current % AUTO_TAG_MESSAGES.length;
      setProgress({ ...data, status: data.current < data.total ? AUTO_TAG_MESSAGES[msgIndex] : 'Auto-tagging complete', type: 'autotag' });
      setVisible(true);

      if (data.current >= data.total && data.total > 0) {
        hideTimer.current = setTimeout(() => setVisible(false), 2500);
      }
    });

    const cleanupEmbedding = window.electronAPI.onEmbeddingProgress((data) => {
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
      setProgress({ ...data, type: 'embedding' });
      setVisible(true);

      if (data.current >= data.total && data.total > 0) {
        hideTimer.current = setTimeout(() => setVisible(false), 2500);
      }
    });

    return () => { cleanupAutotag(); cleanupEmbedding(); };
  }, []);

  if (!progress || !visible) return null;

  const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const isDone = progress.current >= progress.total && progress.total > 0;
  const remaining = progress.total - progress.current;

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 animate-fade-in">
      <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl px-5 py-3 min-w-[300px] max-w-[360px]">
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
            ? `${progress.total} images processed`
            : `${remaining} image${remaining === 1 ? '' : 's'} remaining`
          }
        </p>
      </div>
    </div>
  );
}
