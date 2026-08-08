import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Check, Loader2, Sparkles, AlertTriangle, RefreshCw, X } from 'lucide-react';
import { api } from '../../lib/ipc';
import { OLLAMA_FAILURE_MESSAGE, type OllamaStartResult } from '../../../shared/ollama-status';

const VISION_MODEL = 'qwen3-vl:8b-instruct';
const EMBED_MODEL = 'nomic-embed-text';
/** Rough per-image cost of the vision pass — only used to set expectations in the prompt. */
const SECONDS_PER_IMAGE = 7;

interface PullProgress {
  model: string;
  status: string;
  total: number;
  completed: number;
}

type State =
  | 'closed'
  | 'checking'
  | 'server-down'
  | 'downloading'
  | 'download-failed'
  | 'confirm'
  | 'started';

function formatDuration(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0
    ? `about ${hours} hour${hours === 1 ? '' : 's'}`
    : `about ${hours}h ${rem}m`;
}

const formatSize = (bytes: number) => {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
};

export function ModelUpdateDialog() {
  const [state, setState] = useState<State>('closed');
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [imageCount, setImageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [serverFailure, setServerFailure] = useState<OllamaStartResult | null>(null);
  /** Guards against overlapping opens (e.g. re-clicking the menu mid-check). */
  const busy = useRef(false);

  // Ensure both models are present, pulling only what's missing/incomplete. Ollama's pull
  // verifies existing layers and fetches only the gaps, so re-running is cheap when the model
  // is already good — exactly what we want for the "never downloaded the new model" case.
  const ensureModels = useCallback(async (): Promise<boolean> => {
    // Actively (re)start the engine rather than just probing it — the launch-time start is a
    // single attempt, so for anyone it failed on, probing here could never come back true.
    const start = await api.ensureOllamaServer();
    if (!start.running) {
      setServerFailure(start);
      setState('server-down');
      return false;
    }

    const [hasVision, hasEmbed] = await Promise.all([
      api.isModelReady(VISION_MODEL),
      api.isModelReady(EMBED_MODEL),
    ]);

    if (hasVision && hasEmbed) return true;

    setState('downloading');
    try {
      if (!hasVision) await api.pullModel(VISION_MODEL);
      if (!hasEmbed) await api.pullModel(EMBED_MODEL);
      return true;
    } catch (err) {
      console.error('[model-update] pull failed:', err);
      setError(err instanceof Error ? err.message : 'Download failed');
      setState('download-failed');
      return false;
    }
  }, []);

  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setServerFailure(null);
    setProgress(null);
    setState('checking');
    try {
      const ok = await ensureModels();
      if (!ok) return;
      const count = await api.getAnalyzableCount();
      setImageCount(count);
      setState('confirm');
    } finally {
      busy.current = false;
    }
  }, [ensureModels]);

  useEffect(() => {
    return api.onMenuEvent('menu:updateModel', () => {
      void run();
    });
  }, [run]);

  useEffect(() => {
    if (state !== 'downloading') return;
    const unsub = api.onPullProgress((data: PullProgress) => setProgress(data));
    return () => { unsub(); };
  }, [state]);

  const close = () => setState('closed');

  const handleReanalyze = async () => {
    setState('started');
    try {
      await api.reanalyzeAll();
    } catch (err) {
      console.error('[model-update] re-analyze failed:', err);
    }
    // The standard auto-tag/embedding toast reports progress from here on.
    setTimeout(() => setState('closed'), 1800);
  };

  if (state === 'closed') return null;

  const percent = progress && progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  return (
    <div className="fixed inset-0 z-[100] bg-gray-950/90 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center">
            <Sparkles size={20} className="text-purple-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-gray-100">Update AI Model</h2>
            <p className="text-xs text-gray-500">Vision model &amp; library re-analysis</p>
          </div>
          {(state === 'confirm' || state === 'server-down' || state === 'download-failed') && (
            <button
              onClick={close}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {state === 'checking' && (
          <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
            <Loader2 size={16} className="animate-spin" />
            Starting the local AI engine…
          </div>
        )}

        {state === 'server-down' && (
          <>
            <div className="flex items-start gap-3 py-2 mb-5">
              <AlertTriangle size={18} className="text-amber-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm text-gray-400">
                  {OLLAMA_FAILURE_MESSAGE[serverFailure?.reason ?? 'unknown']}
                </p>
                {serverFailure?.detail && (
                  <p className="mt-2 text-xs text-gray-600 font-mono break-words">
                    {serverFailure.detail}
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={() => void run()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors text-sm font-medium"
            >
              <RefreshCw size={15} />
              Try again
            </button>
          </>
        )}

        {state === 'downloading' && (
          <>
            <p className="text-sm text-gray-400 mb-4">
              Downloading {progress?.model === EMBED_MODEL ? 'embedding' : 'vision'} model… This may take a few minutes.
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
                {progress?.status || 'Starting…'}
              </span>
              <span>
                {progress && progress.total > 0
                  ? `${formatSize(progress.completed)} / ${formatSize(progress.total)}`
                  : `${percent}%`}
              </span>
            </div>
          </>
        )}

        {state === 'download-failed' && (
          <>
            <div className="flex items-start gap-3 py-2 mb-5">
              <AlertTriangle size={18} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-gray-400">
                The model download didn&apos;t finish{error ? `: ${error}` : '.'} Check your connection and try again.
              </p>
            </div>
            <button
              onClick={() => void run()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <Download size={15} />
              Retry download
            </button>
          </>
        )}

        {state === 'confirm' && (
          <>
            <div className="flex items-center gap-2 mb-4 text-sm text-green-400">
              <Check size={16} />
              Vision model is installed and up to date.
            </div>
            {imageCount > 0 ? (
              <>
                <p className="text-sm text-gray-400 mb-2">
                  Re-analyze your library with the current model? This rebuilds AI descriptions,
                  tags, and search data for all <span className="text-gray-200 font-medium">{imageCount}</span> image
                  {imageCount === 1 ? '' : 's'}.
                </p>
                <p className="text-xs text-gray-600 mb-6">
                  Takes {formatDuration(imageCount * SECONDS_PER_IMAGE)} and runs in the background.
                  Your manual tags and edited notes are kept.
                </p>
                <button
                  onClick={handleReanalyze}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors text-sm font-medium"
                >
                  <RefreshCw size={16} />
                  Re-analyze all {imageCount} image{imageCount === 1 ? '' : 's'}
                </button>
                <button
                  onClick={close}
                  className="w-full mt-2 px-4 py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Not now
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-gray-400 mb-6">
                  Your library is empty — nothing to re-analyze yet. New images are analyzed
                  automatically as you add them.
                </p>
                <button
                  onClick={close}
                  className="w-full px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors text-sm font-medium"
                >
                  Done
                </button>
              </>
            )}
          </>
        )}

        {state === 'started' && (
          <div className="flex flex-col items-center py-4">
            <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mb-3">
              <Check size={24} className="text-green-400" />
            </div>
            <p className="text-sm text-gray-300">Re-analysis started</p>
            <p className="text-xs text-gray-500 mt-1">Progress shows in the status toast.</p>
          </div>
        )}
      </div>
    </div>
  );
}
