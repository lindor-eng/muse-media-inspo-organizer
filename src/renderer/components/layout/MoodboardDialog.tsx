import { useEffect, useState } from 'react';
import { Sparkles, X, Loader2, AlertCircle } from 'lucide-react';
import { useAppStore } from '../../stores/app-store';
import { api } from '../../lib/ipc';

type Mode = 'ai' | 'empty';

type Stage =
  | { kind: 'form' }
  | { kind: 'searching' }
  | { kind: 'creating'; total: number }
  | { kind: 'done'; folderId: string; folderName: string; imageCount: number; requestedCount?: number }
  | { kind: 'error'; message: string };

const MIN_COUNT = 3;
const MAX_COUNT = 100;
const DEFAULT_COUNT = 24;

export function MoodboardDialog() {
  const open = useAppStore((s) => s.moodboardModalOpen);
  const setOpen = useAppStore((s) => s.setMoodboardModalOpen);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const refreshAll = useAppStore((s) => s.refreshAll);

  const [mode, setMode] = useState<Mode>('ai');
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [folderName, setFolderName] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'form' });

  // Reset when the modal opens/closes.
  useEffect(() => {
    if (open) {
      setMode('ai');
      setPrompt('');
      setCount(DEFAULT_COUNT);
      setFolderName('');
      setStage({ kind: 'form' });
    }
  }, [open]);

  // Escape closes the modal from any stage other than an active search/create.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (stage.kind === 'searching' || stage.kind === 'creating') return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, stage, setOpen]);

  if (!open) return null;

  const canSubmit =
    stage.kind === 'form' &&
    (mode === 'empty'
      ? folderName.trim().length > 0
      : prompt.trim().length > 0 && count >= MIN_COUNT && count <= MAX_COUNT);

  async function submit() {
    if (mode === 'empty') {
      const name = folderName.trim();
      if (!name) return;
      setStage({ kind: 'creating', total: 0 });
      try {
        const folder = await api.createFolder(name, null);
        await refreshAll();
        if (folder && typeof folder === 'object' && 'id' in folder) {
          setStage({ kind: 'done', folderId: (folder as { id: string }).id, folderName: name, imageCount: 0 });
        } else {
          setStage({ kind: 'done', folderId: '', folderName: name, imageCount: 0 });
        }
      } catch (err) {
        setStage({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to create board' });
      }
      return;
    }

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;
    setStage({ kind: 'searching' });
    try {
      const results = (await api.searchForMoodboard(trimmedPrompt, count)) as
        | { image_id: string; distance: number }[]
        | undefined;
      const ids = results?.map((r) => r.image_id) ?? [];
      if (ids.length === 0) {
        setStage({
          kind: 'error',
          message:
            'Nothing in your library matched this prompt strongly enough. Try broader wording, or check that images have finished indexing.',
        });
        return;
      }

      const derivedName = folderName.trim() || defaultNameFromPrompt(trimmedPrompt);
      setStage({ kind: 'creating', total: ids.length });
      const folder = (await api.createFolder(derivedName, null)) as { id: string } | undefined;
      if (!folder?.id) {
        setStage({ kind: 'error', message: 'Failed to create board.' });
        return;
      }

      for (const id of ids) {
        await api.updateImage(id, { folder_id: folder.id });
      }
      await refreshAll();
      setStage({ kind: 'done', folderId: folder.id, folderName: derivedName, imageCount: ids.length, requestedCount: count });
    } catch (err) {
      setStage({ kind: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
    }
  }

  function openCreatedFolder() {
    if (stage.kind !== 'done' || !stage.folderId) return;
    setViewMode('folder', stage.folderId);
    setOpen(false);
  }

  function dismiss() {
    if (stage.kind === 'searching' || stage.kind === 'creating') return;
    setOpen(false);
  }

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-sm flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[520px] max-w-[92vw]">
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="flex items-center gap-2 text-gray-100">
            <Sparkles size={16} className="text-blue-400" />
            <h2 className="text-sm font-semibold">New board</h2>
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={stage.kind === 'searching' || stage.kind === 'creating'}
            className="text-gray-500 hover:text-gray-300 disabled:opacity-40 disabled:hover:text-gray-500 p-1 -m-1 rounded"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {stage.kind === 'form' && (
          <div className="px-5 pb-5 pt-1 space-y-4">
            <div className="flex items-center gap-1 p-0.5 bg-gray-800/60 rounded-lg text-xs">
              <button
                type="button"
                onClick={() => setMode('ai')}
                className={`flex-1 py-1.5 rounded-md transition-colors ${
                  mode === 'ai' ? 'bg-gray-700 text-gray-100 shadow-sm' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                AI moodboard
              </button>
              <button
                type="button"
                onClick={() => setMode('empty')}
                className={`flex-1 py-1.5 rounded-md transition-colors ${
                  mode === 'empty' ? 'bg-gray-700 text-gray-100 shadow-sm' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Empty board
              </button>
            </div>

            {mode === 'ai' ? (
              <>
                <label className="block">
                  <span className="text-xs font-medium text-gray-400">Describe the moodboard</span>
                  <textarea
                    autoFocus
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g. moody sunset landscapes with warm oranges and silhouetted trees"
                    rows={4}
                    className="mt-1.5 w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
                  />
                  <span className="mt-1 block text-[11px] text-gray-500">
                    Muse searches your library semantically — describe subject, mood, colors, composition, or lighting.
                  </span>
                </label>

                <div className="flex items-end gap-3">
                  <label className="block flex-1">
                    <span className="text-xs font-medium text-gray-400">Number of images</span>
                    <input
                      type="number"
                      min={MIN_COUNT}
                      max={MAX_COUNT}
                      value={count}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) setCount(Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.floor(n))));
                      }}
                      className="mt-1.5 w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 focus:outline-none focus:border-blue-500"
                    />
                  </label>
                  <label className="block flex-[2]">
                    <span className="text-xs font-medium text-gray-400">
                      Board name <span className="text-gray-600">(optional)</span>
                    </span>
                    <input
                      type="text"
                      value={folderName}
                      onChange={(e) => setFolderName(e.target.value)}
                      placeholder="Derived from prompt if empty"
                      className="mt-1.5 w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                  </label>
                </div>
              </>
            ) : (
              <label className="block">
                <span className="text-xs font-medium text-gray-400">Board name</span>
                <input
                  autoFocus
                  type="text"
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && folderName.trim()) void submit();
                  }}
                  placeholder="Untitled board"
                  className="mt-1.5 w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </label>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={dismiss}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 rounded-md"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-md flex items-center gap-1.5"
              >
                {mode === 'ai' ? <Sparkles size={12} /> : null}
                {mode === 'ai' ? 'Generate moodboard' : 'Create board'}
              </button>
            </div>
          </div>
        )}

        {(stage.kind === 'searching' || stage.kind === 'creating') && (
          <div className="px-5 pb-5 pt-2 flex items-center gap-3 text-sm text-gray-300">
            <Loader2 size={16} className="animate-spin text-blue-400 shrink-0" />
            <span>
              {stage.kind === 'searching'
                ? 'Scanning your library for the best matches…'
                : stage.total > 0
                  ? `Adding ${stage.total} image${stage.total === 1 ? '' : 's'} to the board…`
                  : 'Creating board…'}
            </span>
          </div>
        )}

        {stage.kind === 'done' && (
          <div className="px-5 pb-5 pt-1 space-y-4">
            <p className="text-sm text-gray-200">
              {stage.imageCount > 0 ? (
                <>
                  Added <span className="font-semibold">{stage.imageCount}</span> image
                  {stage.imageCount === 1 ? '' : 's'} to{' '}
                  <span className="font-semibold">{stage.folderName}</span>.
                </>
              ) : (
                <>
                  Created <span className="font-semibold">{stage.folderName}</span>.
                </>
              )}
            </p>
            {stage.requestedCount != null && stage.imageCount < stage.requestedCount && (
              <p className="text-xs text-gray-500">
                Only {stage.imageCount} of your library&apos;s images matched the prompt strongly — weaker matches
                were left out to keep the board on-theme.
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 rounded-md"
              >
                Close
              </button>
              {stage.folderId && (
                <button
                  type="button"
                  onClick={openCreatedFolder}
                  className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md"
                >
                  Open board
                </button>
              )}
            </div>
          </div>
        )}

        {stage.kind === 'error' && (
          <div className="px-5 pb-5 pt-1 space-y-4">
            <div className="flex items-start gap-2 text-sm text-red-300">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{stage.message}</span>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 rounded-md"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => setStage({ kind: 'form' })}
                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md"
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Derive a short folder name from the prompt when the user leaves the name field blank.
    Take the first ~5 words, strip punctuation, title-case, and cap at 40 chars. */
function defaultNameFromPrompt(prompt: string): string {
  const words = prompt
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  if (words.length === 0) return 'Moodboard';
  const joined = words.join(' ');
  const titled = joined.replace(/\b\w/g, (c) => c.toUpperCase());
  return titled.length > 40 ? titled.slice(0, 40).trimEnd() + '…' : titled;
}
