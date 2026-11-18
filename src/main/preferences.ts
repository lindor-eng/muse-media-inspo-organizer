import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Preferences } from '../shared/preferences';
import { DEFAULT_PREFERENCES, TRASH_DAY_CHOICES } from '../shared/preferences';

/**
 * This Mac's own settings (Settings › General, Library, AI, Browser extension), kept in
 * `userData/preferences.json`. Not in the library database: they shouldn't travel with a `.muse`
 * export or sync to other Macs. (Similar-image preferences predate this and stay in the
 * database's `settings` table.)
 */

let cached: Preferences | null = null;
const listeners = new Set<(prefs: Preferences, changed: Partial<Preferences>) => void>();

function file(): string {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function coerce(raw: Partial<Preferences>): Preferences {
  const p = { ...DEFAULT_PREFERENCES };
  if (typeof raw.checkUpdatesOnLaunch === 'boolean') p.checkUpdatesOnLaunch = raw.checkUpdatesOnLaunch;
  if (TRASH_DAY_CHOICES.includes(raw.emptyTrashAfterDays as never)) p.emptyTrashAfterDays = raw.emptyTrashAfterDays as Preferences['emptyTrashAfterDays'];
  if (typeof raw.describeImports === 'boolean') p.describeImports = raw.describeImports;
  if (typeof raw.acceptCaptures === 'boolean') p.acceptCaptures = raw.acceptCaptures;
  if (typeof raw.captureFolderId === 'string' || raw.captureFolderId === null) p.captureFolderId = raw.captureFolderId ?? null;
  if (raw.lastUpdateCheck && typeof raw.lastUpdateCheck.at === 'number') p.lastUpdateCheck = raw.lastUpdateCheck;
  return p;
}

export function getPreferences(): Preferences {
  if (cached) return cached;
  try {
    cached = coerce(JSON.parse(fs.readFileSync(file(), 'utf-8')) as Partial<Preferences>);
  } catch {
    cached = { ...DEFAULT_PREFERENCES };
  }
  return cached;
}

export function setPreferences(patch: Partial<Preferences>): Preferences {
  const next = coerce({ ...getPreferences(), ...patch });
  cached = next;
  try {
    const temp = `${file()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2));
    fs.renameSync(temp, file());
  } catch (err) {
    console.warn('[prefs] could not save preferences:', err);
  }
  for (const listener of listeners) listener(next, patch);
  return next;
}

export function onPreferencesChanged(listener: (prefs: Preferences, changed: Partial<Preferences>) => void): void {
  listeners.add(listener);
}
