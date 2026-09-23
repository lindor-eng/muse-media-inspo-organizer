# Send to Muse (Chrome extension)

Capture images and videos from any web page straight into your Muse library.

## Install

In Muse, choose **File → Install Browser Extension…** and click **Open**. Muse opens your browser's Extensions page and copies the extension folder's path to your clipboard. Then, in the browser:

1. Turn on **Developer mode** (top right).
2. Click **Load unpacked**, press **⌘⇧G**, paste the path, press Return, and click **Select**.
3. Pin **Send to Muse** to the toolbar.

Works in Chrome, Arc, Brave, Edge, and Vivaldi. Muse must be running for captures to arrive. It listens on `127.0.0.1:47821`.

### Why not the Chrome Web Store?

On macOS, Chrome won't install a `.crx` from outside the Web Store, but it will load an unpacked folder. Muse bundles this folder and copies it to `~/Library/Application Support/Muse/browser-extension` on every launch. Chrome can't browse inside `Muse.app` from its folder picker, which is why the copy is needed.

The folder is overwritten on each launch, so a Muse update is also an extension update. Chrome picks up the new version the next time it restarts.

The `key` in `manifest.json` gives the extension the same ID on every machine: `aohkpccbgegppeopebiglcdfpncleoia`. Muse only accepts captures from that ID. The matching private key is in `.keys/send-to-muse.pem`. It's gitignored, so back it up yourself. You'd only need it to publish to the Web Store under the same ID later.

### Developing the extension

When you load this repo folder unpacked, edits take effect after you click reload on `chrome://extensions`. Don't load both this folder and the `Application Support` copy at the same time: they share an ID.

## Use

1. Click the toolbar icon (or press **Alt+Shift+M**). The badge shows **ON**.
2. Hover the page. The image or video under the cursor gets outlined, even when the site puts a transparent layer over it.
3. Click to send it to Muse. Clicks on media don't open links or lightboxes while capture is on, and you can capture as many items as you like.
4. Press **Esc** or click the icon again to stop.

New captures land in **All** and go through the same colors and AI tagging as a drop.

## What it captures

| Source | Notes |
|--------|-------|
| `<img>` | Picks the largest `srcset` / `<picture>` candidate, not just the size currently shown |
| CSS `background-image` | Any element 32px or larger |
| `<video>` with a file URL | MP4 / MOV / M4V |
| `<canvas>` | Only when the site hasn't tainted it with cross-origin pixels |

The extension **can't capture streaming video** (YouTube, most social feeds). Those sites play from a MediaSource `blob:` URL, and there's no file behind it to download. The outline turns grey for them.

AVIF images are converted to PNG on import. WebM video is refused because Muse only stores MP4/MOV/M4V.

## How it works

- `content.js` is injected when you click the icon. It finds media under the cursor with `elementsFromPoint`, draws the outline in a closed shadow root, and handles your clicks.
- `background.js` fetches the file using your browser cookies, so signed-in and hotlink-protected CDNs work. If that fails, the page fetches the file itself. The bytes are then POSTed to Muse.
- On the Muse side, `src/main/capture-server.ts` accepts only loopback `Host` headers, requests from this extension's fixed ID, and requests that carry an `X-Muse-Capture` header. Web pages and other extensions can't send files to it.
