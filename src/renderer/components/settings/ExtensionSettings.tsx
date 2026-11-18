import { useEffect, useState } from 'react';
import { api } from '../../lib/ipc';
import { useAppStore } from '../../stores/app-store';
import { Card, Page, Row, StatusDot, Switch, buttonPrimary, selectClass } from './ui';
import { usePreferences } from './usePreferences';

/** Settings › Browser extension. */
export function ExtensionSettings() {
  const [prefs, update] = usePreferences();
  const folders = useAppStore((s) => s.folders);
  const [listening, setListening] = useState<boolean | null>(null);

  useEffect(() => {
    // The server starts or stops when the switch changes; ask again shortly after.
    const t = setTimeout(() => void api.getExtensionStatus().then((s) => setListening(s.listening)), 300);
    return () => clearTimeout(t);
  }, [prefs?.acceptCaptures]);

  // Boards nested under others are listed with their path, as "Posters / Swiss".
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (id: string): string => {
    const names: string[] = [];
    for (let f = byId.get(id), hops = 0; f && hops < 20; f = f.parent_id ? byId.get(f.parent_id) : undefined, hops++) names.unshift(f.name);
    return names.join(' / ');
  };
  const boards = folders.map((f) => ({ id: f.id, label: pathOf(f.id) })).sort((a, b) => a.label.localeCompare(b.label));
  const chosen = prefs?.captureFolderId && byId.has(prefs.captureFolderId) ? prefs.captureFolderId : '';

  return (
    <Page
      title="Browser extension"
      intro="Send to Muse adds a button to your browser: click it, hover any image or video on a page, and click to add it here."
    >
      <Card>
        <Row label="Install Send to Muse" note="Opens your browser's Extensions page and walks you through loading it. Works in Chrome, Arc, Brave, Edge and Vivaldi.">
          <button type="button" className={buttonPrimary} onClick={() => void api.installBrowserExtension()}>
            Install…
          </button>
        </Row>
      </Card>

      <Card>
        <Row
          label="Accept images from the extension"
          note={
            listening === null ? undefined : prefs?.acceptCaptures ? (
              listening ? (
                <StatusDot tone="good">Listening. Only Send to Muse, on this Mac, can reach it.</StatusDot>
              ) : (
                <StatusDot tone="warn">Couldn&apos;t start: another copy of Muse may be open.</StatusDot>
              )
            ) : (
              <StatusDot tone="off">Off. The extension says Muse isn&apos;t open.</StatusDot>
            )
          }
          htmlFor="accept-captures"
        >
          <Switch id="accept-captures" on={prefs?.acceptCaptures ?? true} disabled={!prefs} onChange={(on) => update({ acceptCaptures: on })} />
        </Row>
        <Row label="Put captures in" note="Pick a board, or leave them in All with no board." htmlFor="capture-folder">
          <select
            id="capture-folder"
            className={`${selectClass} w-[220px]`}
            value={chosen}
            disabled={!prefs}
            onChange={(e) => update({ captureFolderId: e.target.value || null })}
          >
            <option value="">No board</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
        </Row>
      </Card>
    </Page>
  );
}
