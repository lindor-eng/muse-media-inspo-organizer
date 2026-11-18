import { useEffect, useState } from 'react';
import type { LibraryInfo, Preferences } from '../../../shared/preferences';
import { TRASH_DAY_CHOICES } from '../../../shared/preferences';
import { api } from '../../lib/ipc';
import { Card, Page, Row, SectionTitle, Switch, buttonSecondary, formatBytes, selectClass } from './ui';
import { usePreferences } from './usePreferences';
import { useSyncState } from './useSyncState';

/** Settings › Library. */
export function LibrarySettings() {
  const [prefs, update] = usePreferences();
  const sync = useSyncState();
  const [info, setInfo] = useState<LibraryInfo | null>(null);
  // Remembered so turning the switch back on restores the last choice.
  const [days, setDays] = useState<Exclude<Preferences['emptyTrashAfterDays'], 0>>(30);

  useEffect(() => {
    void api.getLibraryInfo().then(setInfo);
  }, []);
  useEffect(() => {
    if (prefs?.emptyTrashAfterDays) setDays(prefs.emptyTrashAfterDays);
  }, [prefs?.emptyTrashAfterDays]);

  const autoEmpty = !!prefs?.emptyTrashAfterDays;
  const shortPath = info?.path.replace(/^\/Users\/[^/]+/, '~') ?? '';

  return (
    <Page title="Library">
      <Card>
        <Row label="Stored in" note={<span className="font-mono">{shortPath}</span>}>
          <button type="button" className={buttonSecondary} onClick={() => void api.showLibraryInFinder()}>
            Show in Finder
          </button>
        </Row>
        <div className="grid grid-cols-3 gap-3 px-4 py-3.5">
          {[
            ['Items', info ? info.items.toLocaleString() : '…'],
            ['On disk', info?.bytes != null ? formatBytes(info.bytes) : '…'],
            ['In the Trash', info ? info.trashed.toLocaleString() : '…'],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wider text-gray-500">{label}</span>
              <span className="text-base font-semibold text-gray-100 tabular-nums">{value}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="flex flex-col gap-2">
        <SectionTitle>Copies</SectionTitle>
        <div className="bg-gray-950/40 border border-gray-800 rounded-lg flex items-center gap-3 px-4 py-3">
          <p className="flex-1 text-xs text-gray-400 leading-relaxed">
            A .muse file holds everything: images, videos, boards, tags, notes and AI descriptions. Importing one asks what to do about anything you already have.
          </p>
          <button type="button" className={buttonSecondary} onClick={() => api.triggerMenu('menu:exportLibrary')}>
            Export Library…
          </button>
          <button type="button" className={buttonSecondary} onClick={() => api.triggerMenu('menu:importLibrary')}>
            Import Library…
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Trash</SectionTitle>
        <Card>
          <Row
            label="Empty the Trash automatically"
            note={`Items are deleted for good once they've been in the Trash this long.${sync.enabled && sync.paired ? " With sync on, that's on every Mac." : ''}`}
            htmlFor="auto-empty"
          >
            <select
              aria-label="How long"
              className={selectClass}
              value={days}
              disabled={!prefs}
              onChange={(e) => {
                const next = Number(e.target.value) as typeof days;
                setDays(next);
                if (autoEmpty) update({ emptyTrashAfterDays: next });
              }}
            >
              {TRASH_DAY_CHOICES.filter((d) => d > 0).map((d) => (
                <option key={d} value={d}>after {d} days</option>
              ))}
            </select>
            <Switch id="auto-empty" on={autoEmpty} disabled={!prefs} onChange={(on) => update({ emptyTrashAfterDays: on ? days : 0 })} />
          </Row>
        </Card>
      </div>
    </Page>
  );
}
