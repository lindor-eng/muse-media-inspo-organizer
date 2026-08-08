import { app } from 'electron';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

import type { OllamaStartFailure, OllamaStartResult } from '../../shared/ollama-status';

const OLLAMA_PORT = 11434;
const OLLAMA_HOST = `http://127.0.0.1:${OLLAMA_PORT}`;
/** Generous on purpose: a first cold start of a large unsigned binary also pays for Gatekeeper
    verification, which routinely outlasts a short timeout on slower machines. */
const START_TIMEOUT_MS = 60000;

let ollamaProcess: ChildProcess | null = null;
/** Shared across concurrent callers — the launch-time start and a renderer-triggered one can
    overlap, and without this the second would see a still-starting server as wedged and kill it. */
let startInFlight: Promise<OllamaStartResult> | null = null;
/** Failure text from the most recent spawn attempt, kept so a later retry can explain itself. */
let lastSpawnError: string | null = null;
/** Rolling tail of the server's stderr — usually the only clue when it dies during startup. */
let stderrTail = '';

function getBundledOllamaPath(): string {
  const isPackaged = app.isPackaged;
  if (isPackaged) {
    const resourcesPath = path.join(process.resourcesPath, 'ollama');
    return resourcesPath;
  }
  return '/opt/homebrew/bin/ollama';
}

function getOllamaModelsDir(): string {
  return path.join(app.getPath('userData'), 'ollama-models');
}

export function getOllamaHost(): string {
  return OLLAMA_HOST;
}

/**
 * macOS ships this binary unsigned inside an unsigned app. Installing from the .zip — rather
 * than the .pkg, whose postinstall runs `xattr -cr` — leaves the quarantine flag on it, and
 * some zip extractors drop the executable bit. Either one makes `spawn` fail with EACCES and
 * the AI engine never starts. Both repairs are cheap and idempotent, so run them before every
 * spawn instead of relying on how the user happened to install.
 */
function prepareBundledBinary(binPath: string): void {
  // Only ever touch the copy we ship. In dev this path is Homebrew's ollama, which isn't
  // ours to modify — and it's installed correctly anyway.
  if (process.platform !== 'darwin' || !app.isPackaged) return;

  try {
    fs.chmodSync(binPath, 0o755);
  } catch (err) {
    // Read-only or root-owned install — spawn will report the real problem.
    console.warn('[ollama-server] chmod failed:', err);
  }

  try {
    execFileSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', binPath], { stdio: 'ignore' });
    console.log('[ollama-server] Cleared quarantine flag on binary');
  } catch {
    // Non-zero exit means the attribute wasn't there — the healthy case.
  }
}

/** Turn whatever went wrong into a reason the renderer can act on. */
function classifyFailure(exitCode: number | null): OllamaStartResult {
  if (lastSpawnError) {
    const reason: OllamaStartFailure = lastSpawnError.includes('EACCES')
      ? 'not-executable'
      : 'spawn-failed';
    return { running: false, reason, detail: lastSpawnError };
  }
  if (exitCode !== null) {
    return {
      running: false,
      reason: 'spawn-failed',
      detail: `exited with code ${exitCode}${stderrTail ? `: ${stderrTail.trim()}` : ''}`,
    };
  }
  return { running: false, reason: 'timeout', detail: stderrTail.trim() || undefined };
}

/**
 * Start the server if it isn't already up, reporting *why* it failed rather than throwing.
 * Safe to call repeatedly — the launch-time call and File → Update AI Model's "Try again"
 * both come through here, so a failed start at launch is recoverable without a relaunch.
 */
export function ensureOllamaServer(): Promise<OllamaStartResult> {
  if (!startInFlight) {
    startInFlight = startServerOnce().finally(() => {
      startInFlight = null;
    });
  }
  return startInFlight;
}

async function startServerOnce(): Promise<OllamaStartResult> {
  if (await isOllamaServerRunning()) {
    if (!ollamaProcess) console.log('[ollama-server] Already running externally');
    return { running: true };
  }

  // Tracked but not answering — it's wedged or still dying. Replace it rather than
  // returning early, which would make retries permanently no-op.
  if (ollamaProcess) {
    console.log('[ollama-server] Process not responding; restarting');
    stopOllamaServer();
  }

  const ollamaPath = getBundledOllamaPath();
  if (!fs.existsSync(ollamaPath)) {
    console.error('[ollama-server] Binary not found at:', ollamaPath);
    return { running: false, reason: 'binary-missing', detail: ollamaPath };
  }

  prepareBundledBinary(ollamaPath);

  const modelsDir = getOllamaModelsDir();
  try {
    fs.mkdirSync(modelsDir, { recursive: true });
  } catch (err) {
    return { running: false, reason: 'unknown', detail: `models dir: ${String(err)}` };
  }

  console.log('[ollama-server] Starting:', ollamaPath, 'models:', modelsDir);
  lastSpawnError = null;
  stderrTail = '';
  let exitCode: number | null = null;

  const child = spawn(ollamaPath, ['serve'], {
    env: {
      ...process.env,
      OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
      OLLAMA_MODELS: modelsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ollamaProcess = child;

  // Attach before the first await: an unhandled 'error' event on a ChildProcess throws, and
  // EACCES/ENOENT here are exactly the failures we expect — that throw would have taken the
  // main process down while hiding the cause.
  child.on('error', (err) => {
    lastSpawnError = String(err);
    console.error('[ollama-server] Spawn error:', err);
    if (ollamaProcess === child) ollamaProcess = null;
  });

  child.stdout?.on('data', (data) => {
    console.log('[ollama-server]', data.toString().trim());
  });

  child.stderr?.on('data', (data) => {
    const text = data.toString();
    stderrTail = (stderrTail + text).slice(-2000);
    console.log('[ollama-server:err]', text.trim());
  });

  child.on('exit', (code) => {
    exitCode = code ?? -1;
    console.log('[ollama-server] Exited with code:', code);
    if (ollamaProcess === child) ollamaProcess = null;
  });

  const started = await waitForServer(START_TIMEOUT_MS, () => exitCode !== null || lastSpawnError !== null);
  if (started) return { running: true };

  return classifyFailure(exitCode);
}

export function stopOllamaServer(): void {
  if (ollamaProcess) {
    ollamaProcess.kill('SIGTERM');
    ollamaProcess = null;
    console.log('[ollama-server] Stopped');
  }
}

/** Poll until the server answers. Gives up early once the child is known dead, so a failed
    spawn reports in milliseconds instead of burning the full timeout. */
async function waitForServer(timeoutMs: number, isDead: () => boolean): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isOllamaServerRunning()) return true;
    if (isDead()) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export async function isOllamaServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function isModelAvailable(modelName: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!res.ok) return false;
    const data = await res.json();
    const models: { name: string }[] = data.models ?? [];
    return models.some((m) => m.name === modelName || m.name.startsWith(modelName + ':'));
  } catch {
    return false;
  }
}

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export async function pullModel(
  modelName: string,
  onProgress?: (progress: PullProgress) => void,
): Promise<void> {
  const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, stream: true }),
  });

  if (!res.ok) {
    throw new Error(`Failed to pull model: ${res.status} ${await res.text()}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const progress: PullProgress = JSON.parse(line);
        onProgress?.(progress);
      } catch {}
    }
  }

  if (buffer.trim()) {
    try {
      const progress: PullProgress = JSON.parse(buffer);
      onProgress?.(progress);
    } catch {}
  }
}
