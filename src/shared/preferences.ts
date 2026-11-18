/** This Mac's settings, shared so preload and the renderer can type them. See main/preferences.ts. */

export const TRASH_DAY_CHOICES = [0, 7, 30, 90] as const;

export interface UpdateCheckRecord {
  /** Epoch ms. */
  at: number;
  upToDate: boolean;
  /** Set when a newer release was found. */
  latestVersion: string | null;
  error: string | null;
}

export interface Preferences {
  /** Look for a new release each time Muse opens (packaged builds only). */
  checkUpdatesOnLaunch: boolean;
  /** 0 = never; otherwise items are deleted for good after this many days in the Trash. */
  emptyTrashAfterDays: (typeof TRASH_DAY_CHOICES)[number];
  /** Run the vision model on new imports. */
  describeImports: boolean;
  /** Listen for the Send to Muse browser extension. */
  acceptCaptures: boolean;
  /** Where captures from the extension land; null = no folder. */
  captureFolderId: string | null;
  lastUpdateCheck: UpdateCheckRecord | null;
}

export const DEFAULT_PREFERENCES: Preferences = {
  checkUpdatesOnLaunch: true,
  emptyTrashAfterDays: 0,
  describeImports: true,
  acceptCaptures: true,
  captureFolderId: null,
  lastUpdateCheck: null,
};

/** What Settings › Library shows. */
export interface LibraryInfo {
  path: string;
  items: number;
  trashed: number;
  /** null while still being measured. */
  bytes: number | null;
}

/** What Settings › AI shows. */
export interface AiStatus {
  engineRunning: boolean;
  visionModel: string;
  visionReady: boolean;
  embedModel: string;
  embedReady: boolean;
}
