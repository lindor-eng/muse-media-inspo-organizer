#!/usr/bin/env node
/**
 * Fetches the bundled ffmpeg binary into resources/ffmpeg/.
 *
 * Video import needs a decoder Muse controls: sharp reads stills only, and Chromium's decoder
 * lives in the renderer, on the wrong side of the import pipeline. ffmpeg is a single
 * self-contained static binary here — unlike the Ollama engine, there is no runner tree to
 * keep beside it — so the bundle is just `resources/ffmpeg/ffmpeg`.
 *
 * ffprobe is deliberately NOT bundled. It would add another ~66 MB to say things we already
 * get for free: duration comes off ffmpeg's own stderr banner, and frame dimensions come from
 * sharp reading the extracted PNG (which ffmpeg has already auto-rotated).
 *
 * ## Licensing — read before bumping the pin
 *
 * These builds are configured `--enable-gpl --enable-version3` and, importantly, WITHOUT
 * `--enable-nonfree`. That makes them GPLv3: redistributable, provided the corresponding
 * source is offered to anyone who receives the binary (see README). A `--enable-nonfree`
 * build — which is what most prebuilt macOS ffmpeg binaries are, including the popular
 * `ffmpeg-static` npm package — may NOT be redistributed at all. If you re-pin, run
 * `ffmpeg -buildconf | grep nonfree` on the new binary and reject it if that flag is present.
 *
 * At ~66 MB extracted it can't live in git, so it's fetched at build time, pinned to a build
 * id and checksum for reproducibility, and cached outside the tree.
 *
 * Run manually with `npm run fetch:ffmpeg`; Forge's generateAssets hook runs it for
 * `npm start` and `npm run make`. Pass --force to re-download.
 */
import { createHash } from 'node:crypto';
import fs, { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * Upstream publishes per-arch builds under immutable `<buildId>_<version>` paths, so a pin is
 * a (url, sha256) pair per arch. Bump both halves together — a URL without its matching
 * checksum will fail verification. `https://ffmpeg.martin-riedl.de/redirect/latest/macos/
 * <arm64|amd64>/release/ffmpeg.zip` resolves to the current build if you need a newer one.
 */
const FFMPEG_VERSION = '9.0.1';
const BUILDS = {
  arm64: {
    url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1787073674_9.0.1/ffmpeg.zip',
    sha256: '8287a1b2229e05eb41859f073e18e6c52c60a778f2f5e6881070fe51b79407fe',
  },
  x64: {
    url: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1787081194_9.0.1/ffmpeg.zip',
    sha256: '5bdead62ff504ab9b447cc72b212c4fb481e3f7de5877d427a51bee8136dda40',
  },
};

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEST_DIR = path.join(ROOT, 'resources', 'ffmpeg');
const CACHE_DIR = path.join(ROOT, '.cache', 'ffmpeg');
const BINARY = path.join(DEST_DIR, 'ffmpeg');
const STAMP = path.join(DEST_DIR, '.version');
const force = process.argv.includes('--force');

/** Packaging targets the host arch (see forge.config.ts), so the host's arch is what we fetch. */
const arch = process.arch === 'x64' ? 'x64' : 'arm64';
/** What the stamp has to match for a rebuild to skip the download. */
const stampValue = `${FFMPEG_VERSION}-${arch}`;

function log(msg) {
  console.log(`[fetch-ffmpeg] ${msg}`);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function download(url, destPath) {
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('download failed: empty response body');

  const total = Number(res.headers.get('content-length') ?? 0);
  let seen = 0;
  let lastPct = -1;
  const tmpPath = `${destPath}.partial`;

  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    seen += chunk.length;
    if (!total) return;
    const pct = Math.floor((seen / total) * 100);
    // Every 10% — build logs are usually non-interactive, so a progress bar is noise.
    if (pct >= lastPct + 10) {
      lastPct = pct;
      log(`  ${pct}% (${(seen / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB)`);
    }
  });

  await pipeline(source, createWriteStream(tmpPath));
  fs.renameSync(tmpPath, destPath);
}

async function main() {
  const build = BUILDS[arch];
  if (!build) throw new Error(`no pinned ffmpeg build for arch "${process.arch}"`);

  // Already fetched at this exact version+arch — the common case on rebuilds.
  if (!force && fs.existsSync(STAMP) && fs.existsSync(BINARY)) {
    const stamped = fs.readFileSync(STAMP, 'utf-8').trim();
    if (stamped === stampValue) {
      log(`${stampValue} already present — skipping (use --force to re-fetch)`);
      return;
    }
    log(`replacing ${stamped || 'unknown version'} with ${stampValue}`);
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const zipPath = path.join(CACHE_DIR, `ffmpeg-${stampValue}.zip`);

  // Reuse the cached zip only if it still matches the pinned checksum; a partial or tampered
  // file gets re-downloaded rather than silently extracted.
  let cached = false;
  if (fs.existsSync(zipPath)) {
    log('verifying cached archive…');
    cached = (await sha256File(zipPath)) === build.sha256;
    if (!cached) {
      log('cached archive failed checksum — re-downloading');
      fs.rmSync(zipPath, { force: true });
    }
  }

  if (!cached) {
    await download(build.url, zipPath);
    const actual = await sha256File(zipPath);
    if (actual !== build.sha256) {
      fs.rmSync(zipPath, { force: true });
      throw new Error(
        `checksum mismatch for ffmpeg ${arch}\n  expected ${build.sha256}\n  actual   ${actual}\n` +
          'Refusing to bundle an unverified decoder. If you re-pinned the build, update sha256 too.',
      );
    }
    log('checksum verified');
  }

  // Replace wholesale so switching arch or version can't leave a stale binary behind.
  fs.rmSync(DEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DEST_DIR, { recursive: true });
  log(`extracting to ${path.relative(ROOT, DEST_DIR)}/`);
  execFileSync('/usr/bin/unzip', ['-q', '-o', zipPath, '-d', DEST_DIR], { stdio: 'inherit' });

  if (!fs.existsSync(BINARY)) {
    throw new Error(`extraction produced no ffmpeg binary at ${BINARY}`);
  }
  fs.chmodSync(BINARY, 0o755);

  // A nonfree build is undistributable; fail the build rather than ship one by accident.
  const buildconf = execFileSync(BINARY, ['-hide_banner', '-buildconf'], { encoding: 'utf-8' });
  if (buildconf.includes('--enable-nonfree')) {
    fs.rmSync(DEST_DIR, { recursive: true, force: true });
    throw new Error(
      'pinned ffmpeg is built --enable-nonfree, which cannot be redistributed.\n' +
        'Pin a build without that flag (see the licensing note at the top of this script).',
    );
  }

  fs.writeFileSync(STAMP, `${stampValue}\n`);

  const mb = (fs.statSync(BINARY).size / 1048576).toFixed(0);
  log(`ready: ffmpeg ${FFMPEG_VERSION} (${arch}), ${mb} MB in resources/ffmpeg/`);
}

main().catch((err) => {
  console.error(`[fetch-ffmpeg] ${err.message}`);
  process.exit(1);
});
