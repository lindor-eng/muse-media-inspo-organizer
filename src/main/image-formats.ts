import path from 'node:path';

/** Still formats Muse will store. */
export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.tiff', '.tif', '.bmp',
]);

/**
 * Video containers Muse will store. Deliberately narrow: these are the three the bundled
 * ffmpeg decodes reliably and that Chromium can play back natively in the focus view, which
 * is what keeps a stored clip viewable rather than just catalogued. Widening this set means
 * checking playback too, not just decode — see `src/shared/media-type.ts`.
 */
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

/** Every extension the importers and the drop scanner accept. */
export const SUPPORTED_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

/** MIME → extension fallback for buffer/URL imports where the source path is unreliable. */
export const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-m4v': '.m4v',
};

export function isSupported(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}
