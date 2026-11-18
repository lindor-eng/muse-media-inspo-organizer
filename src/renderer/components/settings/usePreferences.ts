import { useCallback, useEffect, useState } from 'react';
import type { Preferences } from '../../../shared/preferences';
import { api } from '../../lib/ipc';

/** This Mac's preferences, and a way to change them. Null until loaded. */
export function usePreferences(): [Preferences | null, (patch: Partial<Preferences>) => void] {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  useEffect(() => {
    let live = true;
    void api.getPreferences().then((p) => { if (live) setPrefs(p); });
    return () => { live = false; };
  }, []);
  const update = useCallback((patch: Partial<Preferences>) => {
    setPrefs((p) => (p ? { ...p, ...patch } : p));
    void api.setPreferences(patch).then(setPrefs);
  }, []);
  return [prefs, update];
}
