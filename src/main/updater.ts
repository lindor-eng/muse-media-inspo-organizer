import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Muse ships as an UNSIGNED .pkg (it bundles Ollama), which rules out the standard Squirrel /
// electron-updater silent binary swap — that path requires code signing. So updates are delivered
// as a new .pkg attached to a GitHub Release: we read the latest release for the version + changelog,
// download the .pkg asset, then hand it to macOS `installer` (via osascript, one admin prompt) and
// relaunch. The repo is public, so the Releases API needs no auth token.
const REPO = 'lindor-eng/muse-media-inspo-organizer';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface UpdateInfo {
  /** Latest published version, e.g. "1.4.3" (tag with any leading "v" stripped). */
  version: string;
  /** Currently running version. */
  currentVersion: string;
  /** Release notes / changelog (the GitHub release body, markdown). */
  notes: string;
  /** Direct download URL for the .pkg asset. */
  pkgUrl: string;
  /** Asset size in bytes (0 if GitHub didn't report it). */
  size: number;
  /** Asset filename, e.g. "Muse-Installer-1.4.3-arm64.pkg". */
  filename: string;
}

export interface UpdateCheckResult {
  /** True when the latest release is newer than the running app. */
  updateAvailable: boolean;
  /** Populated only when updateAvailable is true. */
  info?: UpdateInfo;
  /** Set when the check couldn't complete (offline, API error). Callers decide whether to surface it. */
  error?: string;
}

export interface DownloadProgress {
  /** Bytes downloaded so far. */
  completed: number;
  /** Total bytes expected (0 until known). */
  total: number;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

/**
 * Parse a version string into numeric segments for comparison. Tolerates a leading "v" and any
 * trailing pre-release/build suffix (e.g. "v1.4.3-beta.1" -> [1,4,3]). Missing segments read as 0.
 */
function parseVersion(v: string): number[] {
  const core = v.trim().replace(/^v/i, '').split(/[-+]/)[0];
  return core.split('.').map((n) => {
    const parsed = parseInt(n, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

/** Returns true when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** Pick the .pkg asset from a release's asset list, preferring one whose name mentions the arch. */
function pickPkgAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
  const pkgs = assets.filter((a) => a.name.toLowerCase().endsWith('.pkg'));
  if (pkgs.length === 0) return undefined;
  const arch = process.arch; // "arm64" | "x64"
  return pkgs.find((a) => a.name.toLowerCase().includes(arch)) ?? pkgs[0];
}

/**
 * Query GitHub for the latest release and decide whether it's newer than the running app.
 * A 404 (no releases published yet) is treated as "up to date", not an error — that's the
 * expected state until the first release is cut. Network/API failures return { error } so the
 * caller can stay quiet on a silent startup check but surface it on a manual check.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Muse-Updater',
      },
    });

    // No releases yet — nothing to update to. Not an error worth showing the user.
    if (res.status === 404) return { updateAvailable: false };
    if (!res.ok) return { updateAvailable: false, error: `GitHub API returned ${res.status}` };

    const release = (await res.json()) as GitHubRelease;
    if (release.draft) return { updateAvailable: false };

    const version = release.tag_name.replace(/^v/i, '');
    if (!isNewerVersion(version, currentVersion)) return { updateAvailable: false };

    const asset = pickPkgAsset(release.assets);
    if (!asset) {
      return { updateAvailable: false, error: 'Latest release has no .pkg installer attached.' };
    }

    return {
      updateAvailable: true,
      info: {
        version,
        currentVersion,
        notes: (release.body || '').trim(),
        pkgUrl: asset.browser_download_url,
        size: asset.size ?? 0,
        filename: asset.name,
      },
    };
  } catch (err) {
    return {
      updateAvailable: false,
      error: err instanceof Error ? err.message : 'Update check failed',
    };
  }
}

/**
 * Download the .pkg to a temp file, streaming progress. Returns the local path. Downloads to a
 * fresh per-run temp dir so a failed/partial download can't be mistaken for a good one, and so we
 * never overwrite a file the user might have open.
 */
export async function downloadUpdate(
  info: UpdateInfo,
  onProgress?: (p: DownloadProgress) => void,
): Promise<string> {
  const res = await fetch(info.pkgUrl, {
    headers: { 'User-Agent': 'Muse-Updater' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status}`);
  }

  // Prefer the size we already learned from the release; fall back to Content-Length.
  const headerLen = Number(res.headers.get('content-length') ?? 0);
  const total = info.size || headerLen || 0;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-update-'));
  const destPath = path.join(dir, info.filename);
  const fileHandle = fs.createWriteStream(destPath);

  const reader = res.body.getReader();
  let completed = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        completed += value.length;
        fileHandle.write(Buffer.from(value));
        onProgress?.({ completed, total });
      }
    }
  } finally {
    fileHandle.end();
  }

  // Ensure the stream is fully flushed to disk before installer touches it.
  await new Promise<void>((resolve, reject) => {
    fileHandle.on('finish', resolve);
    fileHandle.on('error', reject);
  });

  onProgress?.({ completed, total: total || completed });
  return destPath;
}

/**
 * Install the downloaded .pkg and relaunch Muse into the new version. macOS `installer` needs root
 * to write /Applications, so we go through osascript's `with administrator privileges`, which shows
 * the native password prompt (unavoidable for an unsigned pkg going to /Applications). We escape the
 * path for AppleScript, then relaunch. If the user cancels the prompt, osascript exits non-zero and
 * we throw so the UI can recover instead of quitting.
 */
export async function installAndRestart(pkgPath: string): Promise<void> {
  if (!fs.existsSync(pkgPath)) {
    throw new Error('Downloaded installer is missing.');
  }

  // AppleScript string escaping: backslash and double-quote.
  const escaped = pkgPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const shellCmd = `installer -pkg "${escaped}" -target /`;
  const appleScript = `do shell script "${shellCmd}" with administrator privileges`;

  await new Promise<void>((resolve, reject) => {
    execFile('osascript', ['-e', appleScript], (error, _stdout, stderr) => {
      if (error) {
        // -128 is the AppleScript "user cancelled" code.
        const cancelled = /User canceled|-128/.test(stderr) || /-128/.test(String(error));
        reject(new Error(cancelled ? 'Installation was cancelled.' : stderr || error.message));
        return;
      }
      resolve();
    });
  });

  // New bundle is in place — relaunch into it. relaunch() queues a fresh instance to start after
  // this one exits; exit(0) triggers before-quit (stops the Ollama server) cleanly.
  app.relaunch();
  app.exit(0);
}
