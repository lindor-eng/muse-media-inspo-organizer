import { app, BrowserWindow, ipcMain, powerMonitor, safeStorage } from 'electron';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getLibraryPath } from '../database/connection';
import type { SyncState, SyncSummary } from '../../shared/sync-state';
import { BonjourDiscovery } from './discovery';
import { SyncEngine } from './engine';
import type { Sealer } from './config';
import { claimDeviceIdentity } from './schema';

/** The hardware UUID, which a copied library doesn't bring with it. */
function machineId(): string | null {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf-8' });
    return /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The name in System Settings › General › Sharing, as AirDrop shows it. */
function computerName(): string {
  try {
    return execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf-8' }).trim() || 'Mac';
  } catch {
    return os.hostname().replace(/\.local$/, '') || 'Mac';
  }
}

/** The group key is kept encrypted by the keychain (safeStorage). */
const keychainSealer: Sealer = {
  seal(secret) {
    if (safeStorage.isEncryptionAvailable()) {
      return `ss:${safeStorage.encryptString(secret.toString('base64')).toString('base64')}`;
    }
    console.warn('[sync] keychain encryption unavailable; storing the group key unencrypted');
    return `b64:${secret.toString('base64')}`;
  },
  open(sealed) {
    if (sealed.startsWith('ss:')) return Buffer.from(safeStorage.decryptString(Buffer.from(sealed.slice(3), 'base64')), 'base64');
    if (sealed.startsWith('b64:')) return Buffer.from(sealed.slice(4), 'base64');
    throw new Error('unrecognised key format');
  },
};

/** Starts library sync (if it was left on) and its IPC. Call once the app is ready. */
export function startSync(db: Database.Database): SyncEngine {
  claimDeviceIdentity(db, machineId());
  const name = computerName();
  const engine = new SyncEngine({
    db,
    libraryPath: getLibraryPath(),
    configFile: path.join(app.getPath('userData'), 'sync.json'),
    sealer: keychainSealer,
    defaultName: () => name,
    createDiscovery: () => new BonjourDiscovery(),
  });

  const send = (channel: string, ...args: unknown[]) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args);
  };

  let askedBefore = false;
  engine.on('state', (state: SyncState) => {
    send('sync:state', state);
    // Someone is standing at another Mac waiting for an answer: get noticed.
    const asking = state.incomingPair?.phase === 'ask';
    if (asking && !askedBefore) app.dock?.bounce('critical');
    askedBefore = asking;
  });

  // The grid reloads on the same event a finished import sends: at most every few seconds
  // while a big sync streams in, so the grid doesn't churn under you, and once at the end.
  let refresh: ReturnType<typeof setTimeout> | null = null;
  const refreshNow = () => {
    if (refresh) clearTimeout(refresh);
    refresh = null;
    send('files-imported');
  };
  engine.on('libraryChanged', () => {
    if (!refresh) refresh = setTimeout(refreshNow, 3000);
  });
  engine.on('synced', (summary: SyncSummary) => {
    refreshNow();
    send('sync:summary', summary);
  });

  // Back from sleep: other Macs may have moved on meanwhile.
  powerMonitor.on('resume', () => engine.nudge('wake'));

  ipcMain.handle('sync:getState', () => engine.getState());
  ipcMain.handle('sync:setEnabled', async (_, enabled: unknown) => {
    await engine.setEnabled(enabled === true);
    return engine.getState();
  });
  ipcMain.handle('sync:setName', (_, value: unknown) => engine.setName(String(value ?? '')));
  ipcMain.handle('sync:syncNow', () => engine.syncNow());
  ipcMain.handle('sync:pair', (_, deviceId: unknown) => engine.pair(String(deviceId)));
  ipcMain.handle('sync:confirmPair', () => engine.confirmPair());
  ipcMain.handle('sync:cancelPair', () => engine.cancelPair());
  ipcMain.handle('sync:respondToPair', (_, session: unknown, allow: unknown) => engine.respondToPair(String(session), allow === true));
  ipcMain.handle('sync:leave', () => engine.leave());

  app.on('before-quit', () => void engine.stop());
  void engine.start();
  return engine;
}
