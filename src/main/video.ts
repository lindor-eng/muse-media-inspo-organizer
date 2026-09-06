import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

/**
 * Video decoding for the import and captioning pipelines.
 *
 * Everything here goes through the bundled ffmpeg (`scripts/fetch-ffmpeg.mjs`) rather than
 * Chromium's decoder, because both callers live in the main process: the importer needs a
 * poster frame before it can write a row, and the auto-tagger needs frames long after any
 * window may have been closed.
 *
 * ffprobe isn't bundled — duration comes off ffmpeg's own stderr banner, and dimensions come
 * from sharp reading an extracted frame, which ffmpeg has already auto-rotated. That saves
 * ~66 MB in the installer for metadata we get either way.
 */

/** Frames sampled across a clip to build the contact sheet the vision model reads. */
const SHEET_FRAMES = 6;
const SHEET_COLS = 3;
/** Per-cell width in the sheet. 3 x 512 = 1536px wide, which `analyzeVideo` sends unscaled. */
const SHEET_CELL_WIDTH = 512;

/** A frame grab of a long clip decodes a lot of pixels; keep the pipe generous. */
const FRAME_MAX_BUFFER = 96 * 1024 * 1024;
/** A pathological/corrupt file must not wedge the import queue behind it forever. */
const FFMPEG_TIMEOUT_MS = 60_000;

let cachedBinary: string | null = null;
let preparedBinary: string | null = null;

/**
 * Unlike the Ollama engine, ffmpeg is a single self-contained static binary — there's no
 * runner tree beside it, so this points straight at the executable.
 */
function resolveFfmpegPath(): string {
  if (cachedBinary) return cachedBinary;

  if (app.isPackaged) {
    cachedBinary = path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg');
    return cachedBinary;
  }

  // Dev: prefer the fetched binary (scripts/fetch-ffmpeg.mjs) so dev matches production,
  // falling back to a system install for machines that already have one.
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'ffmpeg', 'ffmpeg'),
    path.join(process.cwd(), 'resources', 'ffmpeg', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  cachedBinary = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
  return cachedBinary;
}

/**
 * Same failure mode the Ollama engine hits: installing from the .zip rather than the .pkg
 * leaves the quarantine flag set and some extractors drop the executable bit, either of which
 * turns every video import into an EACCES. Both repairs are cheap and idempotent, so do them
 * once per session before the first decode.
 */
function prepareBinary(binPath: string): void {
  if (preparedBinary === binPath) return;
  preparedBinary = binPath;
  if (process.platform !== 'darwin' || !app.isPackaged) return;

  try {
    fs.chmodSync(binPath, 0o755);
  } catch (err) {
    console.warn('[video] chmod ffmpeg failed:', err);
  }
  try {
    execFileSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', binPath], { stdio: 'ignore' });
    console.log('[video] Cleared quarantine flag on ffmpeg');
  } catch {
    // Non-zero exit means the attribute wasn't there — the healthy case.
  }
}

/** Whether a decoder is actually present. Callers degrade rather than throw when it isn't. */
export function isVideoDecoderAvailable(): boolean {
  return fs.existsSync(resolveFfmpegPath());
}

/**
 * ffmpeg's own diagnosis, trimmed to something worth showing a person. Node puts the entire
 * command line into `err.message`, and ffmpeg prefixes each line with a component tag and a
 * pointer address — none of which means anything to someone who just dropped in a clip. The
 * first real line is almost always the actual cause ("moov atom not found").
 */
function summarizeFfmpegError(err: unknown): string {
  const failure = err as { stderr?: Buffer | string; killed?: boolean; code?: string };
  if (failure.killed) return 'decoding timed out';

  const stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf-8') : failure.stderr ?? '';
  const firstLine = stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
    .find((line) => line.length > 0);

  if (firstLine) return firstLine;
  if (failure.code === 'ENOENT') return 'video decoder not found';
  return err instanceof Error ? err.message : String(err);
}

/** Raised by every ffmpeg call so callers report the cause, not the command line. */
class FfmpegError extends Error {
  constructor(err: unknown) {
    super(summarizeFfmpegError(err));
    this.name = 'FfmpegError';
  }
}

async function runFfmpeg(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  const binary = resolveFfmpegPath();
  prepareBinary(binary);

  try {
    // -nostdin matters: without it ffmpeg inherits the app's stdin and can block forever
    // waiting on a prompt no one will ever answer.
    const { stdout, stderr } = await execFileAsync(binary, ['-nostdin', ...args], {
      encoding: 'buffer',
      maxBuffer: FRAME_MAX_BUFFER,
      timeout: FFMPEG_TIMEOUT_MS,
    });
    return { stdout, stderr: stderr.toString('utf-8') };
  } catch (err) {
    // `ffmpeg -i <file>` with no output always exits non-zero, so probeDurationMs reads its
    // banner off this error rather than treating it as a failure — keep the raw stderr on the
    // thrown object for it.
    const wrapped = new FfmpegError(err) as FfmpegError & { stderr?: string };
    const raw = (err as { stderr?: Buffer | string }).stderr;
    wrapped.stderr = Buffer.isBuffer(raw) ? raw.toString('utf-8') : raw;
    throw wrapped;
  }
}

/**
 * Clip length in milliseconds, or null when it can't be determined (a stream with no declared
 * duration, or a file ffmpeg can't open).
 *
 * `ffmpeg -i <file>` with no output file always exits non-zero — "At least one output file
 * must be specified" — after printing the banner we want, so the metadata is read off the
 * error path rather than a successful run.
 */
export async function probeDurationMs(filePath: string): Promise<number | null> {
  let banner: string;
  try {
    const { stderr } = await runFfmpeg(['-i', filePath]);
    banner = stderr;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    if (stderr === undefined) {
      console.warn('[video] duration probe failed for', filePath, err);
      return null;
    }
    banner = stderr;
  }

  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(banner);
  if (!match) return null;

  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + parseFloat(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/**
 * Decodes a single frame at `atSeconds` to a PNG buffer. `-ss` before `-i` is the fast seek:
 * ffmpeg jumps to the nearest keyframe and decodes forward to the exact timestamp, so it
 * stays accurate without scanning the whole file — the difference between a snappy import and
 * a minute-long one on a large clip.
 */
export async function extractFrame(filePath: string, atSeconds: number): Promise<Buffer> {
  const { stdout } = await runFfmpeg([
    '-loglevel', 'error',
    '-ss', Math.max(0, atSeconds).toFixed(3),
    '-i', filePath,
    '-frames:v', '1',
    '-f', 'image2',
    '-vcodec', 'png',
    '-',
  ]);
  if (stdout.length === 0) throw new Error(`no frame decoded at ${atSeconds}s`);
  return stdout;
}

/**
 * Timestamps to sample, spread evenly and offset half a step in from each end. The first and
 * last frames of a clip are usually the least representative — fades, black, a title card —
 * so sampling at the midpoint of N equal slices describes the video better than sampling its
 * edges.
 */
function sampleTimestamps(durationSeconds: number | null, count: number): number[] {
  if (!durationSeconds || durationSeconds <= 0) {
    // Unknown length: sample the first few seconds, which is all we can rely on existing.
    return Array.from({ length: count }, (_, i) => i * 0.5);
  }
  return Array.from({ length: count }, (_, i) => (durationSeconds * (i + 0.5)) / count);
}

export interface PosterResult {
  /** Frame chosen to represent the clip, as a PNG buffer. */
  png: Buffer;
  width: number;
  height: number;
}

/**
 * The frame that stands in for the clip everywhere a still would be: grid card, similar-image
 * strip, color extraction, perceptual hash. Taken from the middle of the video rather than the
 * start, for the same reason as `sampleTimestamps`.
 */
export async function extractPoster(filePath: string, durationMs: number | null): Promise<PosterResult> {
  const durationSeconds = durationMs ? durationMs / 1000 : null;
  const midpoint = durationSeconds ? durationSeconds / 2 : 0;

  let png: Buffer;
  try {
    png = await extractFrame(filePath, midpoint);
  } catch (err) {
    // A clip shorter than the seek target, or one whose midpoint lands on an undecodable
    // frame, still deserves a poster — fall back to the very first frame.
    console.warn('[video] midpoint frame failed, falling back to first frame:', err);
    png = await extractFrame(filePath, 0);
  }

  const metadata = await sharp(png).metadata();
  return { png, width: metadata.width ?? 0, height: metadata.height ?? 0 };
}

export interface ContactSheet {
  /** Grid of sampled frames, chronological left-to-right, top-to-bottom. */
  png: Buffer;
  /** Timestamps each cell was taken from, in the same order. */
  timestampsSeconds: number[];
}

/**
 * Flattens a clip into one still the vision model can read: N frames sampled across the
 * duration, tiled into a grid.
 *
 * A grid rather than N separate vision calls because it costs one pass instead of N, and
 * because it puts the whole clip in front of the model at once — a description of how a video
 * changes over time is exactly what a caption of any single frame can't give you. Cells are
 * `cover`-cropped to a uniform size so a clip whose aspect ratio shifts mid-stream still
 * tiles cleanly.
 */
export async function buildContactSheet(
  filePath: string,
  durationMs: number | null,
): Promise<ContactSheet> {
  const durationSeconds = durationMs ? durationMs / 1000 : null;
  const timestamps = sampleTimestamps(durationSeconds, SHEET_FRAMES);

  const frames: Buffer[] = [];
  const captured: number[] = [];
  for (const timestamp of timestamps) {
    try {
      frames.push(await extractFrame(filePath, timestamp));
      captured.push(timestamp);
    } catch (err) {
      // A clip can end before a computed timestamp (VBR duration estimates drift), and a
      // single undecodable frame shouldn't cost us the other five.
      console.warn('[video] sheet frame failed at', timestamp.toFixed(2), 's:', err);
    }
  }
  if (frames.length === 0) throw new Error('no frames could be decoded for contact sheet');

  const first = await sharp(frames[0]).metadata();
  const aspect = first.width && first.height ? first.height / first.width : 9 / 16;
  const cellWidth = SHEET_CELL_WIDTH;
  const cellHeight = Math.max(1, Math.round(cellWidth * aspect));

  const cols = Math.min(SHEET_COLS, frames.length);
  const rows = Math.ceil(frames.length / cols);

  const tiles = await Promise.all(
    frames.map((frame) => sharp(frame).resize(cellWidth, cellHeight, { fit: 'cover' }).toBuffer()),
  );

  const png = await sharp({
    create: {
      width: cellWidth * cols,
      height: cellHeight * rows,
      channels: 3,
      background: '#000000',
    },
  })
    .composite(
      tiles.map((input, i) => ({
        input,
        left: (i % cols) * cellWidth,
        top: Math.floor(i / cols) * cellHeight,
      })),
    )
    .png()
    .toBuffer();

  return { png, timestampsSeconds: captured };
}
