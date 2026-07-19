import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Check, Loader2, ArrowUpCircle, AlertTriangle, RefreshCw, X } from 'lucide-react';
import { api } from '../../lib/ipc';

interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  pkgUrl: string;
  size: number;
  filename: string;
}

type State =
  | 'closed'
  | 'checking'
  | 'up-to-date'
  | 'check-failed'
  | 'available'
  | 'downloading'
  | 'download-failed'
  | 'installing'
  | 'install-failed';

const formatSize = (bytes: number) => {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
};

/**
 * Very light renderer for the GitHub release body. We don't want a full markdown dependency for a
 * small changelog, so we handle just what release notes actually use: headings (#…), bullet lines
 * (-, *), and blank-line spacing. Everything else renders as a plain line.
 */
function Changelog({ notes }: { notes: string }) {
  if (!notes) {
    return <p className="text-sm text-gray-500 italic">No release notes provided.</p>;
  }
  const lines = notes.split(/\r?\n/);
  return (
    <div className="space-y-1">
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <div key={i} className="h-2" />;
        const heading = line.match(/^#{1,6}\s+(.*)$/);
        if (heading) {
          return (
            <p key={i} className="text-xs font-semibold uppercase tracking-wide text-gray-400 mt-2">
              {heading[1]}
            </p>
          );
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        if (bullet) {
          return (
            <div key={i} className="flex gap-2 text-sm text-gray-300">
              <span className="text-purple-400 shrink-0">•</span>
              <span>{bullet[1]}</span>
            </div>
          );
        }
        return (
          <p key={i} className="text-sm text-gray-300">
            {line}
          </p>
        );
      })}
    </div>
  );
}

export function UpdateDialog() {
  const [state, setState] = useState<State>('closed');
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Path to the downloaded .pkg, held so a failed install can retry without re-downloading. */
  const pkgPath = useRef<string | null>(null);
  /** Guards against overlapping manual checks (re-clicking the menu mid-check). */
  const busy = useRef(false);

  // Manual "Check for Updates…" — surfaces every outcome, including up-to-date and errors.
  const runManualCheck = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setProgress(null);
    pkgPath.current = null;
    setState('checking');
    try {
      const result = await api.checkForUpdate();
      if (result.updateAvailable && result.info) {
        setInfo(result.info);
        setState('available');
      } else if (result.error) {
        setError(result.error);
        setState('check-failed');
      } else {
        setState('up-to-date');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update check failed');
      setState('check-failed');
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    return api.onMenuEvent('menu:checkUpdate', () => {
      void runManualCheck();
    });
  }, [runManualCheck]);

  // Silent startup check found a newer release — open straight to the confirmation.
  useEffect(() => {
    return api.onUpdateAvailable((incoming: UpdateInfo) => {
      // Don't stomp an install/download the user already kicked off.
      setState((s) => (s === 'closed' || s === 'up-to-date' || s === 'check-failed' ? 'available' : s));
      setInfo(incoming);
    });
  }, []);

  useEffect(() => {
    if (state !== 'downloading') return;
    const unsub = api.onUpdateProgress((p) => setProgress(p));
    return () => { unsub(); };
  }, [state]);

  const close = () => setState('closed');

  const handleUpdate = async () => {
    if (!info) return;
    setError(null);
    setProgress({ completed: 0, total: info.size });
    setState('downloading');
    try {
      const path = await api.downloadUpdate(info);
      pkgPath.current = path;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
      setState('download-failed');
      return;
    }
    await beginInstall();
  };

  // Split out so both the download flow and the "retry install" button can reach it.
  const beginInstall = async () => {
    if (!pkgPath.current) return;
    setState('installing');
    try {
      // On success the main process relaunches Muse and this promise never resolves. It only
      // returns/throws if the admin prompt is cancelled or the installer fails.
      await api.installUpdate(pkgPath.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Installation failed');
      setState('install-failed');
    }
  };

  if (state === 'closed') return null;

  const percent = progress && progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  const dismissable =
    state === 'available' ||
    state === 'up-to-date' ||
    state === 'check-failed' ||
    state === 'download-failed' ||
    state === 'install-failed';

  return (
    <div className="fixed inset-0 z-[100] bg-gray-950/90 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center">
            <ArrowUpCircle size={20} className="text-purple-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-gray-100">Software Update</h2>
            <p className="text-xs text-gray-500">Muse app updates</p>
          </div>
          {dismissable && (
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
            Checking for updates…
          </div>
        )}

        {state === 'up-to-date' && (
          <>
            <div className="flex items-center gap-2 py-2 mb-5 text-sm text-green-400">
              <Check size={16} />
              You&apos;re on the latest version.
            </div>
            <button
              onClick={close}
              className="w-full px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors text-sm font-medium"
            >
              Done
            </button>
          </>
        )}

        {state === 'check-failed' && (
          <>
            <div className="flex items-start gap-3 py-2 mb-5">
              <AlertTriangle size={18} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-gray-400">
                Couldn&apos;t check for updates{error ? `: ${error}` : '.'} Check your connection and try again.
              </p>
            </div>
            <button
              onClick={() => void runManualCheck()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors text-sm font-medium"
            >
              <RefreshCw size={15} />
              Try again
            </button>
          </>
        )}

        {state === 'available' && info && (
          <>
            <p className="text-sm text-gray-400 mb-1">
              <span className="text-gray-200 font-medium">Muse {info.version}</span> is available
              {info.size ? <span className="text-gray-600"> · {formatSize(info.size)}</span> : null}
            </p>
            <p className="text-xs text-gray-600 mb-4">You&apos;re on {info.currentVersion}.</p>
            <div className="max-h-48 overflow-y-auto rounded-lg bg-gray-950/60 border border-gray-800 p-3 mb-5">
              <Changelog notes={info.notes} />
            </div>
            <button
              onClick={handleUpdate}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <Download size={16} />
              Update &amp; Restart
            </button>
            <button
              onClick={close}
              className="w-full mt-2 px-4 py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Later
            </button>
          </>
        )}

        {state === 'downloading' && (
          <>
            <p className="text-sm text-gray-400 mb-4">Downloading update…</p>
            <div className="w-full bg-gray-800 rounded-full h-2 mb-2 overflow-hidden">
              <div
                className="h-full bg-purple-500 rounded-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-500">
              <span className="flex items-center gap-1.5">
                <Loader2 size={10} className="animate-spin" />
                {progress && progress.total > 0 ? `${percent}%` : 'Starting…'}
              </span>
              <span>
                {progress && progress.total > 0
                  ? `${formatSize(progress.completed)} / ${formatSize(progress.total)}`
                  : ''}
              </span>
            </div>
          </>
        )}

        {state === 'download-failed' && (
          <>
            <div className="flex items-start gap-3 py-2 mb-5">
              <AlertTriangle size={18} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-gray-400">
                The download didn&apos;t finish{error ? `: ${error}` : '.'} Check your connection and try again.
              </p>
            </div>
            <button
              onClick={handleUpdate}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <Download size={15} />
              Retry download
            </button>
          </>
        )}

        {state === 'installing' && (
          <div className="flex flex-col items-center py-4">
            <Loader2 size={28} className="text-purple-400 animate-spin mb-3" />
            <p className="text-sm text-gray-300">Installing update…</p>
            <p className="text-xs text-gray-500 mt-1 text-center">
              Enter your password when macOS asks. Muse will restart automatically.
            </p>
          </div>
        )}

        {state === 'install-failed' && (
          <>
            <div className="flex items-start gap-3 py-2 mb-5">
              <AlertTriangle size={18} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-gray-400">
                {error || 'Installation didn’t complete.'} The download is saved, so you can try installing again.
              </p>
            </div>
            <button
              onClick={() => void beginInstall()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <RefreshCw size={15} />
              Try install again
            </button>
            <button
              onClick={close}
              className="w-full mt-2 px-4 py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
