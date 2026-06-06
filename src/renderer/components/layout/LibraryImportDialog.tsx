import { useEffect, useRef, useState } from 'react';
import { X, AlertCircle, ImageOff, FolderOpen, Trash2 } from 'lucide-react';
import { useAppStore } from '../../stores/app-store';
import { api } from '../../lib/ipc';

type Decision = 'replace' | 'keep';

interface DuplicateInfo {
  hash: string;
  filename: string;
  incomingTitle: string;
  incomingFolderName: string | null;
  incomingTagNames: string[];
  incomingIsTrashed: boolean;
  localId: string;
  localTitle: string;
  localFolderName: string | null;
  localTagNames: string[];
  localIsTrashed: boolean;
  localThumbDataUrl: string | null;
  incomingThumbDataUrl: string | null;
}

interface InspectResult {
  sessionId: string;
  totalIncoming: number;
  newCount: number;
  duplicateCount: number;
  duplicates: DuplicateInfo[];
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'inspecting' }
  | { kind: 'reviewing'; data: InspectResult; idx: number; decisions: Record<string, Decision> }
  | { kind: 'applying'; data: InspectResult; decisions: Record<string, Decision> }
  | { kind: 'done'; added: number; replaced: number; kept: number; newCount: number }
  | { kind: 'error'; message: string };

export function LibraryImportDialog() {
  const refreshAll = useAppStore((s) => s.refreshAll);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [applyToRest, setApplyToRest] = useState(false);
  /** Live progress emitted from main during apply. */
  const [applyProgress, setApplyProgress] = useState<{ current: number; total: number } | null>(null);
  const stageRef = useRef(stage);
  useEffect(() => { stageRef.current = stage; }, [stage]);

  // Listen for the File → Import Library… menu item.
  useEffect(() => {
    const cleanup = api.onMenuEvent('menu:importLibrary', () => {
      void start();
    });
    return cleanup;
  }, []);

  // Subscribe to import progress for apply-phase ticks (extract/inspect ticks come through too
  // but the dialog already shows its own "Inspecting…" copy during that brief window).
  useEffect(() => {
    const cleanup = api.onLibraryImportProgress((p) => {
      if (p.phase === 'apply') {
        setApplyProgress({ current: p.current, total: p.total });
      }
    });
    return cleanup;
  }, []);

  async function start() {
    if (stageRef.current.kind !== 'idle' && stageRef.current.kind !== 'done' && stageRef.current.kind !== 'error') {
      return;
    }
    const filePath = await api.chooseOpenLibraryBundle();
    if (!filePath) return;
    setStage({ kind: 'inspecting' });
    setApplyToRest(false);
    setApplyProgress(null);
    try {
      const data = (await api.inspectImportLibrary(filePath)) as InspectResult;
      if (data.duplicateCount === 0) {
        await applyAll(data, {});
        return;
      }
      setStage({ kind: 'reviewing', data, idx: 0, decisions: {} });
    } catch (err) {
      setStage({ kind: 'error', message: String(err) });
    }
  }

  async function applyAll(data: InspectResult, decisions: Record<string, Decision>) {
    setStage({ kind: 'applying', data, decisions });
    setApplyProgress({ current: 0, total: data.totalIncoming });
    try {
      const result = await api.applyImportLibrary(data.sessionId, decisions);
      await refreshAll();
      setStage({
        kind: 'done',
        added: result.added,
        replaced: result.replaced,
        kept: result.kept,
        newCount: data.newCount,
      });
    } catch (err) {
      setStage({ kind: 'error', message: String(err) });
    }
  }

  async function decide(choice: Decision) {
    if (stage.kind !== 'reviewing') return;
    const { data, idx, decisions } = stage;
    const dup = data.duplicates[idx];
    const next: Record<string, Decision> = { ...decisions, [dup.hash]: choice };

    if (applyToRest) {
      // Fill the remainder with this choice and proceed.
      for (let i = idx + 1; i < data.duplicates.length; i++) {
        next[data.duplicates[i].hash] = choice;
      }
      await applyAll(data, next);
      return;
    }

    if (idx + 1 >= data.duplicates.length) {
      await applyAll(data, next);
      return;
    }
    setStage({ kind: 'reviewing', data, idx: idx + 1, decisions: next });
  }

  async function cancel() {
    if (stage.kind === 'reviewing' || stage.kind === 'inspecting') {
      const sessionId = stage.kind === 'reviewing' ? stage.data.sessionId : null;
      if (sessionId) await api.cancelImportLibrary(sessionId).catch(() => undefined);
    }
    setStage({ kind: 'idle' });
  }

  // Escape closes any modal-backed stage (review, error, done).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (stage.kind === 'reviewing') void cancel();
      else if (stage.kind === 'done' || stage.kind === 'error') setStage({ kind: 'idle' });
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [stage]);

  if (stage.kind === 'idle') return null;

  if (stage.kind === 'inspecting') {
    return (
      <Backdrop>
        <Card>
          <p className="text-sm text-gray-200">Reading library bundle…</p>
        </Card>
      </Backdrop>
    );
  }

  if (stage.kind === 'applying') {
    const total = applyProgress?.total ?? stage.data.totalIncoming;
    const current = applyProgress?.current ?? 0;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    return (
      <Backdrop>
        <Card>
          <p className="text-sm text-gray-200 mb-2">Importing library…</p>
          <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-200" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-gray-500 mt-1.5 tabular-nums">{current} / {total}</p>
        </Card>
      </Backdrop>
    );
  }

  if (stage.kind === 'done') {
    const lines: string[] = [];
    if (stage.added > 0) lines.push(`${stage.added} added`);
    if (stage.replaced > 0) lines.push(`${stage.replaced} replaced`);
    if (stage.kept > 0) lines.push(`${stage.kept} kept`);
    return (
      <Backdrop onDismiss={() => setStage({ kind: 'idle' })}>
        <Card>
          <p className="text-sm text-gray-200 mb-1">Import complete</p>
          <p className="text-xs text-gray-400">{lines.join(' · ') || 'Nothing changed'}</p>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setStage({ kind: 'idle' })}
              className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md"
            >
              Done
            </button>
          </div>
        </Card>
      </Backdrop>
    );
  }

  if (stage.kind === 'error') {
    return (
      <Backdrop onDismiss={() => setStage({ kind: 'idle' })}>
        <Card>
          <div className="flex items-start gap-2 mb-2">
            <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-sm text-gray-200">{stage.message}</p>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setStage({ kind: 'idle' })}
              className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md"
            >
              Close
            </button>
          </div>
        </Card>
      </Backdrop>
    );
  }

  // Reviewing duplicate — full UI with side-by-side preview.
  const { data, idx } = stage;
  const dup = data.duplicates[idx];
  const remaining = data.duplicates.length - idx - 1;

  return (
    <Backdrop onDismiss={() => void cancel()}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[640px] max-w-[92vw]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <div>
            <p className="text-sm font-medium text-gray-200">Duplicate found</p>
            <p className="text-xs text-gray-500">{idx + 1} of {data.duplicates.length} · {dup.filename}</p>
          </div>
          <button
            type="button"
            onClick={() => void cancel()}
            aria-label="Cancel import"
            className="text-gray-500 hover:text-gray-200 p-0.5 rounded"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4 px-5 py-4">
          <DuplicateColumn
            label="Keep this (current)"
            title={dup.localTitle}
            folderName={dup.localFolderName}
            tags={dup.localTagNames}
            isTrashed={dup.localIsTrashed}
            thumbDataUrl={dup.localThumbDataUrl}
          />
          <DuplicateColumn
            label="Replace with this (incoming)"
            title={dup.incomingTitle}
            folderName={dup.incomingFolderName}
            tags={dup.incomingTagNames}
            isTrashed={dup.incomingIsTrashed}
            thumbDataUrl={dup.incomingThumbDataUrl}
          />
        </div>

        <div className="px-5 pb-4">
          <label className="flex items-center gap-2 text-xs text-gray-400 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={applyToRest}
              onChange={(e) => setApplyToRest(e.target.checked)}
              className="accent-blue-500"
            />
            {remaining > 0
              ? `Apply this choice to the remaining ${remaining} duplicate${remaining === 1 ? '' : 's'}`
              : 'Apply this choice (no further duplicates)'}
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-800 bg-gray-950/40 rounded-b-xl">
          <button
            type="button"
            onClick={() => void cancel()}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200"
          >
            Cancel import
          </button>
          <button
            type="button"
            onClick={() => void decide('keep')}
            className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md"
          >
            Keep current
          </button>
          <button
            type="button"
            onClick={() => void decide('replace')}
            className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md"
          >
            Replace with incoming
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function Backdrop({ children, onDismiss }: { children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/55 backdrop-blur-sm flex items-center justify-center"
      onMouseDown={(e) => {
        if (onDismiss && e.target === e.currentTarget) onDismiss();
      }}
    >
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl px-5 py-4 min-w-[320px] max-w-[92vw]">
      {children}
    </div>
  );
}

function DuplicateColumn({
  label,
  title,
  folderName,
  tags,
  isTrashed,
  thumbDataUrl,
}: {
  label: string;
  title: string;
  folderName: string | null;
  tags: string[];
  isTrashed: boolean;
  thumbDataUrl: string | null;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <div className="aspect-square w-full bg-gray-800 rounded-md border border-gray-700 overflow-hidden flex items-center justify-center">
        {thumbDataUrl ? (
          <img src={thumbDataUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <ImageOff size={20} className="text-gray-600" />
        )}
      </div>
      <p className="text-xs text-gray-200 truncate" title={title}>
        {title || 'Untitled'}
      </p>
      <div className="flex items-center gap-1.5 text-[10px] text-gray-500 min-h-[1rem]">
        {folderName ? (
          <span className="inline-flex items-center gap-1 truncate">
            <FolderOpen size={10} className="text-yellow-500/80 shrink-0" />
            <span className="truncate">{folderName}</span>
          </span>
        ) : null}
        {isTrashed ? (
          <span className="inline-flex items-center gap-1 text-red-400/80">
            <Trash2 size={10} className="shrink-0" /> Trashed
          </span>
        ) : null}
      </div>
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 6).map((tag) => (
            <span
              key={tag}
              className="text-[10px] text-gray-300 bg-gray-800 border border-gray-700 px-1.5 py-0.5 rounded-full truncate max-w-[8rem]"
              title={tag}
            >
              {tag}
            </span>
          ))}
          {tags.length > 6 ? <span className="text-[10px] text-gray-500">+{tags.length - 6}</span> : null}
        </div>
      ) : (
        <p className="text-[10px] text-gray-600 italic">No tags</p>
      )}
    </div>
  );
}
