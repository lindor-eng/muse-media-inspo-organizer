import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import sharp from 'sharp';
import type { ImportResult } from './importer';
import { MIME_TO_EXT, SUPPORTED_EXTENSIONS } from './image-formats';
import { browserExtensionId } from './browser-extension';

/**
 * Loopback endpoint for the "Send to Muse" browser extension (`browser-extension/`).
 *
 * The extension fetches the media itself — with the browser's cookies, so signed-in and
 * hotlink-protected CDNs work — and POSTs the raw bytes here. Muse never fetches on the
 * extension's behalf, which keeps this server from being a URL-fetching proxy.
 *
 * Any web page can aim a request at 127.0.0.1, so every write is gated on:
 *  - the socket binding to loopback only;
 *  - a `Host` of 127.0.0.1/localhost (defeats DNS rebinding);
 *  - an `Origin` of Send to Muse's own extension ID, fixed by the `key` in its manifest (pages
 *    can't forge an Origin, and other installed extensions don't share the ID);
 *  - a custom `X-Muse-Capture` header, which forces a CORS preflight that this server never
 *    grants to a page origin.
 *
 * The port is fixed because the extension has no other way to find it — keep it in sync with
 * `MUSE_PORT` in `browser-extension/background.js`.
 */
export const CAPTURE_PORT = 47821;

/** Big enough for a long screen recording; the importer holds buffer imports in memory whole. */
const MAX_BODY_BYTES = 512 * 1024 * 1024;

type CaptureImporter = (buffer: Buffer, filename: string) => Promise<ImportResult>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function isExtensionOrigin(origin: string | undefined): origin is string {
  const id = browserExtensionId();
  return id !== null && origin === `chrome-extension://${id}`;
}

function isLoopbackHost(host: string | undefined): boolean {
  return host === `127.0.0.1:${CAPTURE_PORT}` || host === `localhost:${CAPTURE_PORT}`;
}

function send(res: http.ServerResponse, status: number, body: unknown, origin?: string): void {
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json' };
  if (isExtensionOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, 'File is too large to capture'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'File is too large to capture'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Settles the storage extension for a capture. `importFromBuffer` falls back to `.png` for any
 * name it doesn't recognize, which would mislabel a WebP served from an extensionless CDN path —
 * so the response's Content-Type decides whenever the filename can't.
 *
 * Stills Muse doesn't store (AVIF, mostly — CDNs negotiate it aggressively) are converted to
 * PNG rather than refused: the user pointed at a picture, not at a file format.
 */
async function normalizeCapture(
  buffer: Buffer,
  rawName: string,
  contentType: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const base = path.basename(rawName).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'capture';
  const nameExt = path.extname(base).toLowerCase();

  if (SUPPORTED_EXTENSIONS.has(nameExt) && (!MIME_TO_EXT[mime] || MIME_TO_EXT[mime] === nameExt)) {
    return { buffer, filename: base };
  }
  const stem = nameExt ? base.slice(0, -nameExt.length) : base;

  const mimeExt = MIME_TO_EXT[mime];
  if (mimeExt) return { buffer, filename: `${stem}${mimeExt}` };

  // Unrecognized image type (or a server that says application/octet-stream): let sharp decide.
  if (!mime.startsWith('video/')) {
    try {
      const png = await sharp(buffer, { animated: false }).png().toBuffer();
      return { buffer: png, filename: `${stem}.png` };
    } catch {
      // Not an image sharp can read.
    }
  }
  throw new HttpError(415, `Muse can't store ${mime || 'this file type'}`);
}

export function startCaptureServer(importCaptured: CaptureImporter): void {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;

    if (!isLoopbackHost(req.headers.host)) {
      send(res, 403, { ok: false, error: 'Forbidden' });
      return;
    }

    if (req.method === 'OPTIONS') {
      if (!isExtensionOrigin(origin)) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, X-Muse-Capture',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${CAPTURE_PORT}`);

    if (req.method === 'GET' && url.pathname === '/v1/status') {
      send(res, 200, { app: 'Muse', version: app.getVersion() }, origin);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/capture') {
      if (!isExtensionOrigin(origin) || req.headers['x-muse-capture'] !== '1') {
        send(res, 403, { ok: false, error: 'Forbidden' });
        return;
      }

      void (async () => {
        try {
          const body = await readBody(req);
          if (body.length === 0) throw new HttpError(400, 'Empty file');
          const { buffer, filename } = await normalizeCapture(
            body,
            url.searchParams.get('filename') ?? 'capture',
            req.headers['content-type'] ?? '',
          );
          console.log('[capture] received', filename, buffer.length, 'bytes');
          const result = await importCaptured(buffer, filename);
          send(
            res,
            200,
            {
              ok: result.success,
              duplicate: Boolean(result.duplicate),
              restored: Boolean(result.restored),
              filename: result.filename,
              error: result.error,
            },
            origin,
          );
        } catch (err) {
          const status = err instanceof HttpError ? err.status : 500;
          const message = err instanceof Error ? err.message : String(err);
          if (status === 500) console.error('[capture] import failed:', err);
          if (!res.headersSent) send(res, status, { ok: false, error: message }, origin);
        }
      })();
      return;
    }

    send(res, 404, { ok: false, error: 'Not found' }, origin);
  });

  // Non-fatal: a second Muse instance (or anything else) holding the port only costs the
  // extension, never the app.
  server.on('error', (err) => console.warn('[capture] server unavailable:', err.message));
  server.listen(CAPTURE_PORT, '127.0.0.1', () => {
    console.log(`[capture] listening on 127.0.0.1:${CAPTURE_PORT}`);
  });
}
