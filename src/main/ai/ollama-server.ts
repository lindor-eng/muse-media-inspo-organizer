import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const OLLAMA_PORT = 11434;
const OLLAMA_HOST = `http://127.0.0.1:${OLLAMA_PORT}`;

let ollamaProcess: ChildProcess | null = null;

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

export async function startOllamaServer(): Promise<void> {
  if (ollamaProcess) return;

  const isRunning = await isOllamaServerRunning();
  if (isRunning) {
    console.log('[ollama-server] Already running externally');
    return;
  }

  const ollamaPath = getBundledOllamaPath();
  if (!fs.existsSync(ollamaPath)) {
    console.error('[ollama-server] Binary not found at:', ollamaPath);
    throw new Error('Ollama binary not found. Please reinstall the app.');
  }

  const modelsDir = getOllamaModelsDir();
  fs.mkdirSync(modelsDir, { recursive: true });

  console.log('[ollama-server] Starting:', ollamaPath, 'models:', modelsDir);

  ollamaProcess = spawn(ollamaPath, ['serve'], {
    env: {
      ...process.env,
      OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
      OLLAMA_MODELS: modelsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  ollamaProcess.stdout?.on('data', (data) => {
    console.log('[ollama-server]', data.toString().trim());
  });

  ollamaProcess.stderr?.on('data', (data) => {
    console.log('[ollama-server:err]', data.toString().trim());
  });

  ollamaProcess.on('exit', (code) => {
    console.log('[ollama-server] Exited with code:', code);
    ollamaProcess = null;
  });

  await waitForServer(15000);
}

export function stopOllamaServer(): void {
  if (ollamaProcess) {
    ollamaProcess.kill('SIGTERM');
    ollamaProcess = null;
    console.log('[ollama-server] Stopped');
  }
}

async function waitForServer(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isOllamaServerRunning()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Ollama server failed to start within timeout');
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
