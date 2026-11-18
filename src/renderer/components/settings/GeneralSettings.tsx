import { useEffect, useState } from 'react';
import { api } from '../../lib/ipc';
import { Card, Page, Row, StatusDot, Switch, buttonSecondary } from './ui';
import { usePreferences } from './usePreferences';

function describeCheck(at: number): string {
  const then = new Date(at);
  const time = then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (then.toDateString() === new Date().toDateString()) return `today at ${time}`;
  if (then.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return `yesterday at ${time}`;
  return then.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Settings › General. */
export function GeneralSettings() {
  const [prefs, update] = usePreferences();
  const [info, setInfo] = useState<{ version: string; packaged: boolean } | null>(null);
  useEffect(() => {
    void api.getAppInfo().then(setInfo);
  }, []);

  const last = prefs?.lastUpdateCheck ?? null;

  return (
    <Page title="General">
      <div className="bg-gray-950/40 border border-gray-800 rounded-lg flex items-center gap-4 px-4 py-4">
        <span className="w-[52px] h-[52px] rounded-xl bg-gray-800 text-gray-50 text-[26px] font-bold flex items-center justify-center shrink-0">m</span>
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="text-[15px] font-semibold text-gray-100">Muse {info?.version ?? ''}</span>
          {last ? (
            last.error ? (
              <StatusDot tone="warn">Couldn&apos;t check {describeCheck(last.at)}</StatusDot>
            ) : last.upToDate ? (
              <StatusDot tone="good">Up to date · checked {describeCheck(last.at)}</StatusDot>
            ) : (
              <StatusDot tone="warn">Muse {last.latestVersion} is out</StatusDot>
            )
          ) : (
            <StatusDot tone="off">Not checked yet</StatusDot>
          )}
        </div>
        <button type="button" className={buttonSecondary} onClick={() => api.triggerMenu('menu:checkUpdate')}>
          Check for Updates
        </button>
      </div>

      <Card>
        <Row
          label="Check for updates when Muse opens"
          note="Muse tells you when one is out. It never installs without asking."
          htmlFor="auto-check"
        >
          <Switch id="auto-check" on={prefs?.checkUpdatesOnLaunch ?? true} disabled={!prefs} onChange={(on) => update({ checkUpdatesOnLaunch: on })} />
        </Row>
        <Row label={`What's new in ${info?.version ?? 'this version'}`} note="The release notes on GitHub">
          <button type="button" className="text-xs text-blue-400 hover:text-blue-300" onClick={() => void api.openReleaseNotes()}>
            Release notes
          </button>
        </Row>
      </Card>
      {info && !info.packaged && (
        <p className="text-xs text-gray-500">This is a development copy, so it never checks on its own.</p>
      )}
    </Page>
  );
}
