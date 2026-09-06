/**
 * What kind of media a library row holds. Muse stores videos in the same `images` table as
 * stills — a video is a row whose original is a clip and whose thumbnail is an extracted
 * poster frame — so "is this a video?" is answered from `file_type`, the extension the
 * importer already stamped on every row.
 *
 * Lives in shared/ because both sides need it: main branches the import and captioning
 * pipelines on it, and the renderer swaps <img> for <video> on it.
 */

/** Video containers Muse will store, matching `VIDEO_EXTENSIONS` in main/image-formats.ts. */
export const VIDEO_FILE_TYPES = new Set(['mp4', 'mov', 'm4v']);

export function isVideoFileType(fileType: string | null | undefined): boolean {
  return !!fileType && VIDEO_FILE_TYPES.has(fileType.toLowerCase());
}

/**
 * Clip length as a badge string: `0:07`, `1:23`, `1:02:03`. Returns null for a missing or
 * nonsensical duration so callers can render nothing rather than a misleading `0:00`.
 */
export function formatDuration(durationMs: number | null | undefined): string | null {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return null;

  const totalSeconds = Math.round(durationMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
