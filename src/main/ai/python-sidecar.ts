import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { app } from 'electron';

let sidecarProcess: ChildProcess | null = null;
let responseResolvers: Map<string, (value: unknown) => void> = new Map();
let requestId = 0;
let readyPromise: Promise<boolean> | null = null;

function getProjectRoot(): string {
  const appPath = app.getAppPath();
  const candidates = [
    appPath,
    path.resolve(appPath, '..'),
    path.resolve(appPath, '../..'),
    '/Users/brian.lin/design-organizer',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'python', 'embed_server.py'))) {
      return candidate;
    }
  }
  return '/Users/brian.lin/design-organizer';
}

function getVenvPython(): string {
  const projectRoot = getProjectRoot();
  return path.join(projectRoot, 'python', '.venv', 'bin', 'python3');
}

function getScriptPath(): string {
  const projectRoot = getProjectRoot();
  return path.join(projectRoot, 'python', 'embed_server.py');
}

export function startSidecar(): Promise<boolean> {
  if (sidecarProcess && readyPromise) return readyPromise;

  const pythonPath = getVenvPython();
  const scriptPath = getScriptPath();

  console.log('[sidecar] Starting:', pythonPath, scriptPath);

  if (!fs.existsSync(pythonPath)) {
    console.log('[sidecar] Python not found at:', pythonPath);
    return Promise.resolve(false);
  }

  readyPromise = new Promise<boolean>((resolveReady) => {
    try {
      sidecarProcess = spawn(pythonPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      sidecarProcess.on('error', (err) => {
        console.log('[sidecar] Spawn error:', err.message);
        sidecarProcess = null;
        readyPromise = null;
        responseResolvers.clear();
        resolveReady(false);
      });

      sidecarProcess.stderr?.on('data', (data: Buffer) => {
        console.log('[sidecar stderr]', data.toString().trim());
      });

      const rl = readline.createInterface({ input: sidecarProcess.stdout! });
      rl.on('line', (line) => {
        try {
          const response = JSON.parse(line);
          if (response.id === 'ready') {
            console.log('[sidecar] Ready');
            resolveReady(true);
            return;
          }
          const resolver = responseResolvers.get(response.id);
          if (resolver) {
            resolver(response);
            responseResolvers.delete(response.id);
          }
        } catch {
          // Ignore non-JSON output
        }
      });

      sidecarProcess.on('exit', (code) => {
        console.log('[sidecar] Exited with code:', code);
        sidecarProcess = null;
        readyPromise = null;
        responseResolvers.clear();
        resolveReady(false);
      });

      // Timeout if model takes too long to load
      setTimeout(() => resolveReady(false), 120000);
    } catch (err) {
      console.log('[sidecar] Failed to spawn:', err);
      resolveReady(false);
    }
  });

  return readyPromise;
}

export function stopSidecar(): void {
  if (sidecarProcess) {
    sidecarProcess.kill();
    sidecarProcess = null;
    readyPromise = null;
    responseResolvers.clear();
  }
}

export function isSidecarRunning(): boolean {
  return sidecarProcess !== null && !sidecarProcess.killed;
}

async function ensureReady(): Promise<boolean> {
  if (!readyPromise) {
    return startSidecar();
  }
  return readyPromise;
}

function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!sidecarProcess?.stdin) {
      reject(new Error('Sidecar not running'));
      return;
    }

    const id = String(++requestId);
    const request = JSON.stringify({ id, method, params }) + '\n';

    responseResolvers.set(id, resolve);
    sidecarProcess.stdin.write(request);

    setTimeout(() => {
      if (responseResolvers.has(id)) {
        responseResolvers.delete(id);
        reject(new Error('Sidecar request timeout'));
      }
    }, 60000);
  });
}

export async function getImageEmbedding(imagePath: string): Promise<number[] | null> {
  try {
    const ready = await ensureReady();
    if (!ready) return null;
    const response = await sendRequest('embed_image', { path: imagePath }) as { embedding?: number[] };
    return response.embedding ?? null;
  } catch {
    return null;
  }
}

export async function getTextEmbedding(text: string): Promise<number[] | null> {
  try {
    const ready = await ensureReady();
    if (!ready) return null;
    const response = await sendRequest('embed_text', { text }) as { embedding?: number[] };
    return response.embedding ?? null;
  } catch {
    return null;
  }
}
