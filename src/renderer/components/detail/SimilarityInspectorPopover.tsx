import { useEffect, useState } from 'react';
import { LIKENESS_LENS_SCALE_TOOLTIP } from '../../../shared/visual-similarity';
import { REFINE_MODE_HELP, SIMILAR_REFINE_MODES } from '../../../shared/similar-refine';
import type { SimilarityPrefs } from '../../stores/app-store';

interface Props {
  prefs: SimilarityPrefs;
  onSave: (next: SimilarityPrefs) => Promise<void>;
  onCancel: () => void;
  /** Peers with embeddings (from last similar fetch), for context only */
  peerCandidatesIndexed?: number;
}

export function SimilarityInspectorPopover({ prefs, onSave, onCancel, peerCandidatesIndexed }: Props) {
  const [draft, setDraft] = useState<SimilarityPrefs>(prefs);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(prefs);
  }, [prefs]);

  const persist = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 shadow-xl px-3 py-2.5 space-y-2.5 w-[min(22rem,calc(100vw-3rem))]">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium text-gray-300 leading-tight">Similar suggestions</p>
        <button
          type="button"
          onClick={onCancel}
          className="text-[10px] text-gray-500 hover:text-gray-300 shrink-0"
        >
          Close
        </button>
      </div>

      <div>
        <div className="flex justify-between text-[10px] text-gray-500 mb-1">
          <span>Max suggestions</span>
          <span className="tabular-nums text-gray-400">{draft.maxResults}</span>
        </div>
        <input
          type="range"
          min={4}
          max={36}
          step={1}
          value={draft.maxResults}
          onChange={(e) => setDraft((d) => ({ ...d, maxResults: Number(e.target.value) }))}
          className="w-full h-1 accent-blue-500"
        />
        <div className="mt-2 space-y-2 rounded border border-gray-800 bg-gray-950/55 px-2 py-2">
          <p className="text-[10px] text-gray-600 leading-snug">
            <span className="block text-[10px] font-medium text-gray-400 mb-1">Likeness lens scale</span>
            {LIKENESS_LENS_SCALE_TOOLTIP}
          </p>
          <div className="text-[10px] text-gray-600 leading-snug space-y-1.5">
            <span className="block text-[10px] font-medium text-gray-400">Similar colors, layout & format</span>
            {SIMILAR_REFINE_MODES.map((m) => (
              <p key={m} className="leading-snug">
                {REFINE_MODE_HELP[m]}
              </p>
            ))}
          </div>
        </div>
      </div>

      <div className="flex gap-2 pt-0.5">
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setDraft(prefs);
            onCancel();
          }}
          className="flex-1 py-1 text-[11px] rounded border border-gray-700 text-gray-400 hover:bg-gray-800"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => persist()}
          className="flex-1 py-1 text-[11px] rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Apply'}
        </button>
      </div>

      <p className="text-[10px] text-gray-600 leading-snug pt-1 border-t border-gray-800">
        Trash excluded from matches.
        {typeof peerCandidatesIndexed === 'number'
          ? ` About ${peerCandidatesIndexed} indexed peer image${peerCandidatesIndexed === 1 ? '' : 's'} on the last fetch.`
          : null}
      </p>
    </div>
  );
}
