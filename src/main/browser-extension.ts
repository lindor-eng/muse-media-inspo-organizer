import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { app, clipboard, dialog, type BrowserWindow } from 'electron';

/**
 * Distribution for the "Send to Muse" Chrome extension without the Web Store: Chrome won't
 * install an off-store .crx on macOS, but it will load an unpacked folder in Developer mode.
 *
 * The bundled copy can't be the folder users load — Chrome's folder picker won't step inside
 * `Muse.app` (macOS shows app bundles as files). So each launch mirrors it into `userData`,
 * which also makes every Muse update an extension update: Chrome re-reads unpacked extensions
 * from disk when it restarts.
 */

/** Chromium browsers that load unpacked extensions and resolve `chrome://extensions`. */
const CHROMIUM_BROWSERS = ['Google Chrome', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Vivaldi', 'Chromium'];

function bundledExtensionDir(): string {
  // Dev: app.getAppPath() is the repo root (where package.json lives).
  return app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension')
    : path.join(app.getAppPath(), 'browser-extension');
}

export function installedExtensionDir(): string {
  return path.join(app.getPath('userData'), 'browser-extension');
}

/**
 * Chrome derives an extension's ID from the public key in its manifest: the first 128 bits of
 * the key's SHA-256, written with the letters a–p. The `key` field is what keeps that ID the
 * same on every machine for an unpacked install — and what lets the capture server accept
 * this one extension rather than any.
 */
function idFromManifestKey(publicKeyBase64: string): string {
  const digest = crypto.createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
  return digest
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
    .join('');
}

let cachedId: string | null | undefined;

/** The extension's fixed ID, or null if the bundled manifest is missing or has no key. */
export function browserExtensionId(): string | null {
  if (cachedId !== undefined) return cachedId;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundledExtensionDir(), 'manifest.json'), 'utf-8'));
    cachedId = typeof manifest.key === 'string' ? idFromManifestKey(manifest.key) : null;
  } catch (err) {
    console.warn('[extension] could not read bundled manifest:', err);
    cachedId = null;
  }
  return cachedId;
}

/** Copy the bundled extension over the installed one. Non-fatal: at worst the user keeps the
    previous version until next launch. */
export function syncBrowserExtension(): void {
  const src = bundledExtensionDir();
  if (!fs.existsSync(src)) {
    console.warn('[extension] bundled extension missing at', src);
    return;
  }
  try {
    fs.cpSync(src, installedExtensionDir(), { recursive: true, force: true });
  } catch (err) {
    console.warn('[extension] sync failed:', err);
  }
}

function findApp(name: string): string | null {
  for (const dir of ['/Applications', path.join(app.getPath('home'), 'Applications')]) {
    const candidate = path.join(dir, `${name}.app`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The default browser when it's Chromium-based, else the first Chromium browser installed. */
async function pickBrowser(): Promise<{ name: string; path: string } | null> {
  try {
    const info = await app.getApplicationInfoForProtocol('https://');
    if (CHROMIUM_BROWSERS.includes(info.name) && info.path) return { name: info.name, path: info.path };
  } catch {
    // No default handler registered; fall through to scanning.
  }
  for (const name of CHROMIUM_BROWSERS) {
    const appPath = findApp(name);
    if (appPath) return { name, path: appPath };
  }
  return null;
}

function openExtensionsPage(browserPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', browserPath, 'chrome://extensions'], (err) => (err ? reject(err) : resolve()));
  });
}

/** File → Install Browser Extension… */
export async function showInstallBrowserExtension(win: BrowserWindow | null): Promise<void> {
  syncBrowserExtension();
  const folder = installedExtensionDir();
  const browser = await pickBrowser();

  const steps = [
    `1. Turn on Developer mode (top right of the Extensions page).`,
    `2. Click Load unpacked, press ⌘⇧G, paste, and press Return. Then click Select.`,
    `3. Pin Send to Muse to your toolbar.`,
    ``,
    `The folder path will be on your clipboard, ready to paste:`,
    folder,
    ``,
    `Muse updates the extension when Muse updates. Restart your browser afterwards to load the new version.`,
  ].join('\n');

  const options = {
    type: 'info' as const,
    title: 'Install Browser Extension',
    message: 'Add Send to Muse to your browser',
    detail: browser
      ? `Muse will open ${browser.name}'s Extensions page.\n\n${steps}`
      : `Muse couldn't find Chrome, Arc, Brave, Edge, or Vivaldi. In your browser, open chrome://extensions, then:\n\n${steps}`,
    buttons: [browser ? `Open ${browser.name}` : 'Copy Folder Path', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response !== 0) return;

  clipboard.writeText(folder);
  if (!browser) return;
  try {
    await openExtensionsPage(browser.path);
  } catch (err) {
    console.warn('[extension] could not open extensions page:', err);
    dialog.showErrorBox(
      'Could not open your browser',
      `Open chrome://extensions in ${browser.name} yourself. The folder path is already on your clipboard.`,
    );
  }
}
