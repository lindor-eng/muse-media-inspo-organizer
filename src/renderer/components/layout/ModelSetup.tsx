import { useEffect, useState } from 'react';
import { Download, Check, Loader2, Sparkles } from 'lucide-react';
import { api } from '../../lib/ipc';

const VISION_MODEL = 'qwen3-vl:8b-instruct';
const EMBED_MODEL = 'nomic-embed-text';

interface PullProgress {
  model: string;
  status: string;
  total: number;
  completed: number;
}

export function ModelSetup() {
  const [state, setState] = useState<'checking' | 'ready' | 'needs-download' | 'downloading' | 'done'>('checking');
  const [progress, setProgress] = useState<PullProgress | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const serverUp = await api.isOllamaServerRunning();
        if (!serverUp) {
          await new Promise((r) => setTimeout(r, 3000));
          const retry = await api.isOllamaServerRunning();
          if (!retry) {
            if (!cancelled) setState('ready');
            return;
          }
        }

        const [hasVision, hasEmbed] = await Promise.all([
          api.isModelReady(VISION_MODEL),
          api.isModelReady(EMBED_MODEL),
        ]);
        if (!cancelled) setState(hasVision && hasEmbed ? 'ready' : 'needs-download');
      } catch {
        if (!cancelled) setState('ready');
      }
    };

    check();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (state !== 'downloading') return;
    const unsub = api.onPullProgress((data: PullProgress) => {
      setProgress(data);
    });
    return () => { unsub(); };
  }, [state]);

  const handleDownload = async () => {
    setState('downloading');
    try {
      const [hasVision, hasEmbed] = await Promise.all([
        api.isModelReady(VISION_MODEL),
        api.isModelReady(EMBED_MODEL),
      ]);
      if (!hasVision) await api.pullModel(VISION_MODEL);
      if (!hasEmbed) await api.pullModel(EMBED_MODEL);
      setState('done');
      setTimeout(() => setState('ready'), 1500);
    } catch (err) {
      console.error('Model pull failed:', err);
      setState('needs-download');
    }
  };

  if (state === 'checking' || state === 'ready') return null;

  const percent = progress && progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  };

  return (
    <div className="fixed inset-0 z-[100] bg-gray-950/90 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center">
            <Sparkles size={20} className="text-purple-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-100">AI Setup</h2>
            <p className="text-xs text-gray-500">One-time download</p>
          </div>
        </div>

        {state === 'needs-download' && (
          <>
            <p className="text-sm text-gray-400 mb-6">
              Muse uses local AI models for auto-tagging, alt text, and search:
              Qwen3-VL for vision (~6 GB) and nomic-embed-text for similarity (~274 MB).
            </p>
            <button
              onClick={handleDownload}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <Download size={16} />
              Download AI Model
            </button>
            <p className="text-xs text-gray-600 mt-3 text-center">
              You can skip this and use Muse without AI features
            </p>
            <button
              onClick={() => setState('ready')}
              className="w-full mt-2 px-4 py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Skip for now
            </button>
          </>
        )}

        {state === 'downloading' && (
          <>
            <p className="text-sm text-gray-400 mb-4">
              Downloading {progress?.model === EMBED_MODEL ? 'embedding' : 'vision'} model... This may take a few minutes.
            </p>
            <div className="w-full bg-gray-800 rounded-full h-2 mb-2 overflow-hidden">
              <div
                className="h-full bg-purple-500 rounded-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-500">
              <span className="flex items-center gap-1.5">
                <Loader2 size={10} className="animate-spin" />
                {progress?.status || 'Starting...'}
              </span>
              <span>
                {progress && progress.total > 0
                  ? `${formatSize(progress.completed)} / ${formatSize(progress.total)}`
                  : `${percent}%`}
              </span>
            </div>
          </>
        )}

        {state === 'done' && (
          <div className="flex flex-col items-center py-4">
            <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mb-3">
              <Check size={24} className="text-green-400" />
            </div>
            <p className="text-sm text-gray-300">AI model ready!</p>
          </div>
        )}
      </div>
    </div>
  );
}
