import { useEffect, useState } from 'react';

interface ProgressState {
  current: number;
  total: number;
  status: string;
}

export function EmbeddingProgress() {
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const cleanup = window.electronAPI.onEmbeddingProgress((data) => {
      setProgress(data);
      setVisible(true);

      if (data.current >= data.total && data.total > 0) {
        setTimeout(() => setVisible(false), 2000);
      }
    });
    return cleanup;
  }, []);

  if (!progress || !visible) return null;

  const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const isDone = progress.current >= progress.total && progress.total > 0;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-fade-in">
      <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl px-5 py-3 min-w-[280px]">
        <p className="text-sm text-gray-200 mb-2">
          {isDone ? 'Indexing complete' : progress.status}
        </p>
        <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-300 ease-out"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <p className="text-xs text-gray-500 mt-1.5">
          {isDone ? `${progress.total} images indexed` : `${progress.current} / ${progress.total}`}
        </p>
      </div>
    </div>
  );
}
