import { useEffect, useState } from 'react';
import type { AiStatus } from '../../../shared/preferences';
import type { MatchStrengthTier } from '../../../shared/visual-similarity';
import { api } from '../../lib/ipc';
import { useAppStore } from '../../stores/app-store';
import { Card, Page, Row, SectionTitle, StatusDot, Switch, buttonSecondary } from './ui';
import { usePreferences } from './usePreferences';

/** The strip's own names for its cutoffs, loosest first. */
const STRENGTHS: Array<{ value: MatchStrengthTier | null; label: string }> = [
  { value: null, label: 'Wide' },
  { value: 'broad', label: 'Narrow' },
  { value: 'balanced', label: 'Close' },
  { value: 'strict', label: 'Strict' },
];

/** Settings › AI. */
export function AiSettings() {
  const [prefs, update] = usePreferences();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [started, setStarted] = useState(false);
  const similarity = useAppStore((s) => s.similarityPrefs);
  const loadSimilarityPrefs = useAppStore((s) => s.loadSimilarityPrefs);
  const saveSimilarity = useAppStore((s) => s.saveSimilarityPrefsAndRefresh);
  const [maxDraft, setMaxDraft] = useState<number | null>(null);

  useEffect(() => {
    void api.getAiStatus().then(setStatus);
    void api.getAnalyzableCount().then(setCount);
    void loadSimilarityPrefs();
  }, [loadSimilarityPrefs]);

  const model = (ready: boolean | undefined) =>
    status === null ? <span className="text-xs text-gray-500">…</span> : ready ? <span className="text-xs text-gray-400">Installed</span> : <span className="text-xs text-amber-300">Not downloaded</span>;

  return (
    <Page title="AI" intro="Runs entirely on this Mac. Nothing is sent anywhere to describe or search your library.">
      <Card>
        <Row label="AI engine">
          {status === null ? (
            <span className="text-xs text-gray-500">Checking…</span>
          ) : status.engineRunning ? (
            <StatusDot tone="good">Running</StatusDot>
          ) : (
            <StatusDot tone="warn">Not running</StatusDot>
          )}
        </Row>
        <Row label="Qwen3-VL 8B" note="Describes and tags images and clips · about 6 GB">{model(status?.visionReady)}</Row>
        <Row label="nomic-embed-text" note="Search and similar images · 274 MB">{model(status?.embedReady)}</Row>
        <div className="flex items-center gap-2.5 px-4 py-3">
          {confirming ? (
            <>
              <p className="flex-1 text-xs text-gray-300 leading-relaxed">
                Rebuild descriptions, tags and search data for all {count?.toLocaleString() ?? ''} images? It runs in the background, and your own tags and edited notes are kept.
              </p>
              <button type="button" className={buttonSecondary} onClick={() => setConfirming(false)}>Cancel</button>
              <button
                type="button"
                className="shrink-0 px-3 py-1.5 text-xs font-medium text-white bg-purple-600 hover:bg-purple-500 rounded-md"
                onClick={() => {
                  setConfirming(false);
                  setStarted(true);
                  void api.reanalyzeAll();
                }}
              >
                Re-analyze
              </button>
            </>
          ) : (
            <>
              <p className="flex-1 text-xs text-gray-400 leading-relaxed">
                {started
                  ? 'Re-analysis started. Progress shows at the bottom of the window.'
                  : 'Re-analyzing rebuilds descriptions, tags and search data in the background. Your own tags and edited notes are kept.'}
              </p>
              <button type="button" className={buttonSecondary} onClick={() => api.triggerMenu('menu:updateModel')}>
                Update AI Model…
              </button>
              <button type="button" className={buttonSecondary} disabled={!status?.engineRunning || !count} onClick={() => setConfirming(true)}>
                Re-analyze Library…
              </button>
            </>
          )}
        </div>
      </Card>

      <Card>
        <Row label="Describe and tag new imports" note="Off: imports skip the AI and stay out of search until you re-analyze them." htmlFor="describe-imports">
          <Switch id="describe-imports" on={prefs?.describeImports ?? true} disabled={!prefs} onChange={(on) => update({ describeImports: on })} />
        </Row>
      </Card>

      <div className="flex flex-col gap-2">
        <SectionTitle>Similar images</SectionTitle>
        <Card>
          <Row label="How alike they have to be" note="The strip under an image starts here. You can still change it there.">
            <div role="radiogroup" aria-label="Match strength" className="flex bg-gray-900 border border-gray-700 rounded-md p-0.5 gap-0.5 shrink-0">
              {STRENGTHS.map(({ value, label }) => {
                const on = similarity.similarityFloor === value;
                return (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => void saveSimilarity({ similarityFloor: value })}
                    className={`px-2.5 py-1 text-xs rounded ${on ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </Row>
          <Row label="How many to show" htmlFor="max-suggestions">
            <input
              id="max-suggestions"
              type="range"
              min={4}
              max={36}
              value={maxDraft ?? similarity.maxResults}
              onChange={(e) => setMaxDraft(Number(e.target.value))}
              onPointerUp={() => {
                if (maxDraft !== null) void saveSimilarity({ maxResults: maxDraft });
                setMaxDraft(null);
              }}
              onKeyUp={() => {
                if (maxDraft !== null) void saveSimilarity({ maxResults: maxDraft });
                setMaxDraft(null);
              }}
              className="w-[180px] accent-blue-500"
            />
            <span className="w-6 text-right text-sm text-gray-300 tabular-nums">{maxDraft ?? similarity.maxResults}</span>
          </Row>
        </Card>
      </div>
    </Page>
  );
}
