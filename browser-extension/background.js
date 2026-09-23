// Send to Muse — service worker.
//
// Owns everything that needs extension privileges: toggling capture mode on the active tab,
// fetching media bytes cross-origin (with the browser's cookies, so signed-in and
// hotlink-protected CDNs work), and handing those bytes to the Muse desktop app over loopback.

// Must match CAPTURE_PORT in src/main/capture-server.ts.
const MUSE_PORT = 47821;
const MUSE_URL = `http://127.0.0.1:${MUSE_PORT}`;

// Muse stores JPG/PNG/GIF/WebP/SVG/TIFF/BMP; asking for those first keeps CDNs that negotiate
// formats from answering with AVIF. (Muse converts AVIF anyway, but the original is better.)
const IMAGE_ACCEPT = 'image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8,*/*;q=0.5';

// Toolbar click (or Alt+Shift+M): inject the capture script, which toggles itself on and off.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (err) {
    // chrome:// pages, the Web Store, the PDF viewer, etc. refuse script injection.
    console.warn('[muse] cannot capture on this page:', err);
    await flashBadge(tab.id, '✕', '#b42318');
  }
});

// A navigation throws the content script away, so the "ON" badge must go with it.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') setBadge(tabId, false);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message.type === 'muse:state') {
    if (tabId) setBadge(tabId, message.active);
    return false;
  }

  if (message.type === 'muse:ping') {
    pingMuse().then(sendResponse);
    return true;
  }

  if (message.type === 'muse:capture') {
    capture(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  return false;
});

function setBadge(tabId, active) {
  chrome.action.setBadgeText({ tabId, text: active ? 'ON' : '' }).catch(() => {});
  if (active) chrome.action.setBadgeBackgroundColor({ tabId, color: '#6d4aff' }).catch(() => {});
}

async function flashBadge(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 1500);
}

async function pingMuse() {
  try {
    const res = await fetch(`${MUSE_URL}/v1/status`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return { running: body.app === 'Muse', version: body.version };
  } catch {
    return { running: false };
  }
}

/**
 * `message` is `{ src, filename, dataUrl? }`. The content script sends `dataUrl` when it had to
 * read the bytes itself (blob: URLs, canvases, or a retry after `needsPageFetch`).
 *
 * Resolves `{ ok, duplicate?, restored?, error?, needsPageFetch? }`.
 */
async function capture(message) {
  let blob;
  if (message.dataUrl) {
    blob = await (await fetch(message.dataUrl)).blob();
  } else {
    try {
      blob = await fetchMedia(message.src);
    } catch (err) {
      // Some hosts only serve media to requests from their own pages (Referer checks, or cookies
      // partitioned to the page). Let the content script try from inside the page.
      console.warn('[muse] extension fetch failed, asking page to retry:', err);
      return { ok: false, needsPageFetch: true };
    }
  }

  return sendToMuse(blob, message.filename);
}

async function fetchMedia(src) {
  const res = await fetch(src, {
    credentials: 'include',
    headers: { Accept: IMAGE_ACCEPT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (blob.size === 0) throw new Error('empty response');
  // A login wall or error page served with 200 is not media.
  if (blob.type.startsWith('text/html')) throw new Error('got an HTML page instead of media');
  return blob;
}

async function sendToMuse(blob, filename) {
  let res;
  try {
    res = await fetch(`${MUSE_URL}/v1/capture?filename=${encodeURIComponent(filename || 'capture')}`, {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'X-Muse-Capture': '1',
      },
      body: blob,
    });
  } catch {
    throw new Error("Muse isn't running — open Muse and try again");
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Muse returned an unexpected response (${res.status})`);
  }
  return {
    ok: Boolean(body.ok),
    duplicate: Boolean(body.duplicate),
    restored: Boolean(body.restored),
    error: body.error,
  };
}
