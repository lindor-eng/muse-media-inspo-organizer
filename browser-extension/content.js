// Send to Muse — capture mode, injected into the page by the toolbar button.
//
// Injected fresh on every toolbar click, so the first run installs capture mode and every
// later run just toggles it. While active: hovering outlines the image or video under the
// cursor, clicking sends it to Muse, Esc (or the toolbar button) exits.

(() => {
  if (window.__museCapture) {
    window.__museCapture.toggle();
    return;
  }

  const MIN_SIZE = 32; // Skip icons, avatars-in-a-row, tracking pixels.
  const ACCENT = '#6d4aff';

  let active = false;
  let hovered = null; // { el, kind, src?, unsupported? }
  let lastPoint = null;

  // --- UI, isolated in a shadow root so page CSS can't touch it -------------------------------

  const host = document.createElement('muse-capture');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box, .bar, .toasts { font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .box {
        position: fixed; display: none; box-sizing: border-box;
        border: 3px solid ${ACCENT}; border-radius: 6px;
        background: color-mix(in srgb, ${ACCENT} 12%, transparent);
        box-shadow: 0 0 0 1px rgba(255,255,255,.6), 0 8px 24px rgba(0,0,0,.25);
        transition: top .06s, left .06s, width .06s, height .06s;
      }
      .box.blocked { border-color: #8a8a8a; background: rgba(0,0,0,.18); }
      .box.sent { border-color: #12b76a; background: rgba(18,183,106,.18); }
      .pill {
        position: absolute; top: 8px; left: 8px; padding: 5px 10px; border-radius: 999px;
        background: ${ACCENT}; color: #fff; white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0,0,0,.3);
      }
      .box.blocked .pill { background: #3d3d3d; }
      .box.sent .pill { background: #12b76a; }
      .bar {
        position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        display: flex; gap: 10px; align-items: center; padding: 8px 14px; border-radius: 999px;
        background: rgba(20,20,24,.92); color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.35);
        max-width: calc(100vw - 32px);
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: ${ACCENT}; flex: none; }
      .bar.offline .dot { background: #f04438; }
      kbd {
        font: inherit; padding: 1px 6px; border-radius: 4px;
        background: rgba(255,255,255,.14); color: #fff;
      }
      .toasts {
        position: fixed; right: 16px; bottom: 16px;
        display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
      }
      .toast {
        padding: 9px 14px; border-radius: 10px; max-width: 320px;
        background: rgba(20,20,24,.94); color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.35);
        animation: in .15s ease-out;
      }
      .toast.ok { border-left: 4px solid #12b76a; }
      .toast.info { border-left: 4px solid #8a8a8a; }
      .toast.err { border-left: 4px solid #f04438; }
      @keyframes in { from { opacity: 0; transform: translateY(6px); } }
    </style>
    <div class="box"><span class="pill"></span></div>
    <div class="bar"><span class="dot"></span><span class="bar-text"></span></div>
    <div class="toasts"></div>
  `;
  const box = root.querySelector('.box');
  const pill = root.querySelector('.pill');
  const bar = root.querySelector('.bar');
  const barText = root.querySelector('.bar-text');
  const toasts = root.querySelector('.toasts');

  function setBar(online) {
    bar.classList.toggle('offline', !online);
    barText.innerHTML = online
      ? 'Muse capture — click an image or video to send it · <kbd>Esc</kbd> to stop'
      : "Muse isn't running — open Muse, then click to capture · <kbd>Esc</kbd> to stop";
  }

  function toast(text, tone) {
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.textContent = text;
    toasts.append(el);
    setTimeout(() => el.remove(), tone === 'err' ? 5000 : 2500);
    while (toasts.children.length > 4) toasts.firstChild.remove();
  }

  // --- Finding media under the cursor ---------------------------------------------------------

  /** Every element under the point, descending into open shadow roots. */
  function elementsAt(x, y, scope = document, seen = new Set()) {
    const out = [];
    for (const el of scope.elementsFromPoint(x, y)) {
      if (seen.has(el) || el === host) continue;
      seen.add(el);
      if (el.shadowRoot) out.push(...elementsAt(x, y, el.shadowRoot, seen));
      out.push(el);
    }
    return out;
  }

  function isBigEnough(el) {
    const r = el.getBoundingClientRect();
    return r.width >= MIN_SIZE && r.height >= MIN_SIZE;
  }

  /** Largest candidate from a srcset, by `w` descriptor (or `x` density). */
  function largestFromSrcset(srcset) {
    let best = null;
    let bestScore = 0;
    for (const part of srcset.split(/,\s+/)) {
      const [url, descriptor = '1x'] = part.trim().split(/\s+/);
      const score = parseFloat(descriptor) || 0;
      if (url && score > bestScore) {
        best = url;
        bestScore = score;
      }
    }
    return best ? new URL(best, document.baseURI).href : null;
  }

  function bestImageSrc(img) {
    const sets = [img.srcset];
    if (img.parentElement?.tagName === 'PICTURE') {
      for (const source of img.parentElement.querySelectorAll('source')) sets.push(source.srcset);
    }
    for (const set of sets) {
      const url = set && largestFromSrcset(set);
      if (url) return url;
    }
    const src = img.currentSrc || img.src;
    // Lazy loaders often leave a placeholder in src and the real URL in a data attribute.
    if (!src || (src.startsWith('data:') && src.length < 200)) {
      const lazy = img.dataset.src || img.dataset.original || img.dataset.lazySrc;
      if (lazy) return new URL(lazy, document.baseURI).href;
    }
    return src || null;
  }

  function videoSrc(video) {
    const direct = video.currentSrc || video.src;
    if (direct) return direct;
    const source = video.querySelector('source[src]');
    return source ? source.src : null;
  }

  function backgroundSrc(el) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') return null;
    const match = /url\(["']?(.+?)["']?\)/.exec(bg);
    return match ? new URL(match[1], document.baseURI).href : null;
  }

  function candidateFor(el) {
    if (!isBigEnough(el)) return null;

    if (el instanceof HTMLImageElement) {
      const src = bestImageSrc(el);
      return src ? { el, kind: 'image', src } : null;
    }

    if (el instanceof HTMLVideoElement) {
      const src = videoSrc(el);
      // MediaSource streams (YouTube, most social feeds) play from a blob: URL that isn't a file
      // at all — there's nothing to download.
      if (!src || src.startsWith('blob:')) {
        return { el, kind: 'video', unsupported: "Streaming video — can't be captured" };
      }
      return { el, kind: 'video', src };
    }

    if (el instanceof HTMLCanvasElement) return { el, kind: 'canvas' };

    if (el !== document.documentElement && el !== document.body) {
      const src = backgroundSrc(el);
      if (src) return { el, kind: 'image', src };
    }
    return null;
  }

  function mediaAt(x, y) {
    for (const el of elementsAt(x, y)) {
      const c = candidateFor(el);
      if (c) return c;
    }
    return null;
  }

  // --- Hover highlight --------------------------------------------------------------------------

  function render() {
    if (!hovered) {
      box.style.display = 'none';
      return;
    }
    const r = hovered.el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      top: `${r.top}px`,
      left: `${r.left}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    box.classList.toggle('blocked', Boolean(hovered.unsupported));
    if (!box.classList.contains('sent')) {
      pill.textContent = hovered.unsupported ?? (hovered.kind === 'video' ? 'Send video to Muse' : 'Send to Muse');
    }
  }

  function updateHover() {
    if (!lastPoint) return;
    const next = mediaAt(lastPoint.x, lastPoint.y);
    if (next?.el !== hovered?.el) box.classList.remove('sent');
    hovered = next;
    render();
  }

  let frame = 0;
  function scheduleHover() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      updateHover();
    });
  }

  // --- Capture ----------------------------------------------------------------------------------

  function filenameFor(src, kind) {
    try {
      const url = new URL(src);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const last = decodeURIComponent(url.pathname.split('/').pop() || '');
        if (last) return last;
      }
    } catch {
      // fall through
    }
    const host = location.hostname.replace(/^www\./, '') || 'capture';
    return `${host}-${kind}`;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /** Reads the bytes from inside the page: same-origin requests carry the page's own Referer
      and cookies, and blob: URLs only resolve here. */
  async function pageDataUrl(src) {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return blobToDataUrl(await res.blob());
  }

  async function send(target) {
    const kind = target.kind === 'canvas' ? 'image' : target.kind;
    const message = { type: 'muse:capture', filename: filenameFor(target.src ?? '', kind) };

    if (target.kind === 'canvas') {
      try {
        message.dataUrl = target.el.toDataURL('image/png');
      } catch {
        throw new Error("This canvas is protected by the site and can't be captured");
      }
    } else if (target.src.startsWith('blob:')) {
      message.dataUrl = await pageDataUrl(target.src);
    } else {
      message.src = target.src;
    }

    let result = await chrome.runtime.sendMessage(message);
    if (result?.needsPageFetch) {
      try {
        message.dataUrl = await pageDataUrl(target.src);
      } catch {
        throw new Error("This site won't let the file be downloaded");
      }
      result = await chrome.runtime.sendMessage(message);
    }
    return result;
  }

  async function captureHovered() {
    const target = hovered;
    if (!target) return;
    if (target.unsupported) {
      toast(target.unsupported, 'err');
      return;
    }

    pill.textContent = 'Sending…';
    try {
      const result = await send(target);
      if (result?.ok) {
        toast(result.restored ? 'Restored from Trash in Muse' : 'Added to Muse', 'ok');
        if (hovered?.el === target.el) {
          box.classList.add('sent');
          pill.textContent = 'Added ✓';
        }
      } else if (result?.duplicate) {
        toast('Already in your Muse library', 'info');
        if (hovered?.el === target.el) pill.textContent = 'Already in Muse';
      } else {
        throw new Error(result?.error || 'Muse could not import this');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
      render();
    }
  }

  // --- Event wiring -----------------------------------------------------------------------------

  function onMove(e) {
    lastPoint = { x: e.clientX, y: e.clientY };
    scheduleHover();
  }

  /** Swallow the page's own reaction (opening a lightbox, following a link) to a capture click. */
  function block(e) {
    if (e.button !== 0 || !hovered) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (e.button !== 0 || !hovered) return;
    block(e);
    void captureHovered();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      deactivate();
    }
  }

  const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick'];

  function activate() {
    active = true;
    document.documentElement.append(host);
    bar.style.display = '';
    setBar(true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('scroll', scheduleHover, true);
    window.addEventListener('resize', scheduleHover, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    for (const type of BLOCKED) window.addEventListener(type, block, true);
    chrome.runtime.sendMessage({ type: 'muse:state', active: true });
    chrome.runtime.sendMessage({ type: 'muse:ping' }).then((status) => {
      if (active) setBar(Boolean(status?.running));
    });
  }

  function deactivate() {
    active = false;
    hovered = null;
    lastPoint = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('scroll', scheduleHover, true);
    window.removeEventListener('resize', scheduleHover, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    for (const type of BLOCKED) window.removeEventListener(type, block, true);
    box.classList.remove('sent');
    bar.style.display = 'none';
    render();
    // Keep the host up briefly so a result toast from an in-flight capture can still land.
    setTimeout(() => {
      if (!active) host.remove();
    }, 2600);
    chrome.runtime.sendMessage({ type: 'muse:state', active: false });
  }

  window.__museCapture = {
    toggle() {
      if (active) deactivate();
      else activate();
    },
  };
  activate();
})();
