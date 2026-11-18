// Bundles scripts/verify-sync.harness.ts and runs it under Electron's Node, which is what
// better-sqlite3 in node_modules is built for:  node scripts/verify-sync.mjs
// VERBOSE=1 prints each engine's log.
import { build } from 'rolldown';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(path.join(tmpdir(), 'muse-verify-sync-'));
const file = path.join(out, 'harness.cjs');
try {
  await build({
    input: path.join(project, 'scripts/verify-sync.harness.ts'),
    platform: 'node',
    external: ['better-sqlite3', 'sqlite-vec', 'bonjour-service', 'electron'],
    output: { file, format: 'cjs' },
    logLevel: 'warn',
  });
  const electron = path.join(project, 'node_modules/.bin/electron');
  const run = spawnSync(electron, [file], {
    stdio: 'inherit',
    cwd: project,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: path.join(project, 'node_modules') },
  });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
