#!/usr/bin/env node
/**
 * Fetches the bundled Ollama engine into resources/ollama/.
 *
 * The engine is NOT a single binary: the darwin tarball is ~44 entries (ollama, llama-server,
 * llama-quantize, the ggml/llama dylibs, and mlx_metal_* for Metal). Shipping only `ollama`
 * yields a server that answers /api/tags — so every health check passes — while being unable
 * to run a model at all. The whole tree has to sit next to the binary, which locates its
 * runner via <exeDir>/llama-server.
 *
 * At ~463 MB extracted (138 MB compressed) it can't live in git: GitHub rejects files over
 * 100 MB, and LFS's free monthly bandwidth is 1 GB. So it's fetched at build time, pinned to
 * a version and checksum for reproducibility, and cached outside the tree.
 *
 * Run manually with `npm run fetch:ollama`; Forge's generateAssets hook runs it for
 * `npm start` and `npm run make`. Pass --force to re-download.
 */
import { createHash } from 'node:crypto';
import fs, { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/** Bump these together — a version without its matching checksum will fail verification. */
const OLLAMA_VERSION = 'v0.32.6';
const ASSET = 'ollama-darwin.tgz';
const SHA256 = 'c256147703b0b24a9871ec9f94fc108f18cf87ff043aebd6f7e4a95fcfb4f042';

const URL_BASE = 'https://github.com/ollama/ollama/releases/download';
/** Executables inside the tarball — tar preserves the bit, but re-set it defensively. */
const EXECUTABLES = ['ollama', 'llama-server', 'llama-quantize'];

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEST_DIR = path.join(ROOT, 'resources', 'ollama');
const CACHE_DIR = path.join(ROOT, '.cache', 'ollama');
const STAMP = path.join(DEST_DIR, '.version');
const force = process.argv.includes('--force');

function log(msg) {
  console.log(`[fetch-ollama] ${msg}`);
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
  // Already fetched at this exact version — the common case on rebuilds.
  if (!force && fs.existsSync(STAMP) && fs.existsSync(path.join(DEST_DIR, 'ollama'))) {
    const stamped = fs.readFileSync(STAMP, 'utf-8').trim();
    if (stamped === OLLAMA_VERSION) {
      log(`${OLLAMA_VERSION} already present — skipping (use --force to re-fetch)`);
      return;
    }
    log(`replacing ${stamped || 'unknown version'} with ${OLLAMA_VERSION}`);
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tarballPath = path.join(CACHE_DIR, `${OLLAMA_VERSION}-${ASSET}`);

  // Reuse the cached tarball only if it still matches the pinned checksum; a partial or
  // tampered file gets re-downloaded rather than silently extracted.
  let cached = false;
  if (fs.existsSync(tarballPath)) {
    log('verifying cached tarball…');
    cached = (await sha256File(tarballPath)) === SHA256;
    if (!cached) {
      log('cached tarball failed checksum — re-downloading');
      fs.rmSync(tarballPath, { force: true });
    }
  }

  if (!cached) {
    await download(`${URL_BASE}/${OLLAMA_VERSION}/${ASSET}`, tarballPath);
    const actual = await sha256File(tarballPath);
    if (actual !== SHA256) {
      fs.rmSync(tarballPath, { force: true });
      throw new Error(
        `checksum mismatch for ${ASSET}\n  expected ${SHA256}\n  actual   ${actual}\n` +
          'Refusing to bundle an unverified engine. If you bumped OLLAMA_VERSION, update SHA256 too.',
      );
    }
    log('checksum verified');
  }

  // Replace wholesale so a version downgrade can't leave stale libraries behind.
  fs.rmSync(DEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DEST_DIR, { recursive: true });
  log(`extracting to ${path.relative(ROOT, DEST_DIR)}/`);
  execFileSync('/usr/bin/tar', ['-xzf', tarballPath, '-C', DEST_DIR], { stdio: 'inherit' });

  const binary = path.join(DEST_DIR, 'ollama');
  if (!fs.existsSync(binary)) {
    throw new Error(`extraction produced no ollama binary at ${binary}`);
  }

  for (const name of EXECUTABLES) {
    const p = path.join(DEST_DIR, name);
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  }

  fs.writeFileSync(STAMP, `${OLLAMA_VERSION}\n`);

  const entries = fs.readdirSync(DEST_DIR).length;
  log(`ready: ${OLLAMA_VERSION}, ${entries} entries in resources/ollama/`);
}

main().catch((err) => {
  console.error(`[fetch-ollama] ${err.message}`);
  process.exit(1);
});
