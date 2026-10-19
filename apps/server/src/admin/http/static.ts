import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { HttpError, SECURITY_HEADERS, sendError } from './respond.js';

export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
};

export const INDEX_CACHE_CONTROL = 'no-cache';
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** True for `/livez`, `/readyz` and every path that merely starts with them; the server owns those. */
export function isHealthPath(pathname: string): boolean {
  return pathname.startsWith('/livez') || pathname.startsWith('/readyz');
}

/** URL path segments safe to join under the root, or null for traversal and other malformed paths. */
export function safeSegments(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || /[\\:\u0000-\u001f\u007f]/.test(decoded)) return null;
  const segments = decoded.slice(1).split('/');
  const last = segments.length - 1;
  for (const [index, segment] of segments.entries()) {
    if (segment === '' ? index !== last : segment.startsWith('.')) return null;
  }
  return segments.filter(Boolean);
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function statFile(file: string): fs.Stats | null {
  const stats = fs.statSync(file, { throwIfNoEntry: false });
  return stats?.isFile() ? stats : null;
}

export interface StaticFiles {
  /** Whether the web build exists; when it does not, non-API paths fall through to the server's 404. */
  enabled(): boolean;
  /** Serves a GET or HEAD for a non-API path. Never throws. */
  serve(request: IncomingMessage, response: ServerResponse, pathname: string): void;
}

export function createStaticFiles(webDist: string | undefined): StaticFiles {
  const root = webDist ? path.resolve(webDist) : null;
  const notFound = new HttpError(404, 'not_found', 'Not found.');

  function serveFile(request: IncomingMessage, response: ServerResponse, file: string, stats: fs.Stats, cacheControl: string): void {
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': cacheControl
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }

  return {
    enabled() {
      if (!root) return false;
      try {
        return fs.statSync(root).isDirectory();
      } catch {
        return false;
      }
    },
    serve(request, response, pathname) {
      try {
        if (!root) throw notFound;
        const segments = safeSegments(pathname);
        if (!segments) throw new HttpError(400, 'bad_request', 'Invalid path.');
        const realRoot = fs.realpathSync(root);
        const requested = path.join(realRoot, ...segments);
        const stats = segments.length ? statFile(requested) : null;
        if (stats) {
          const real = fs.realpathSync(requested);
          if (!within(realRoot, real)) throw notFound;
          const cacheControl = path.basename(real) === 'index.html' ? INDEX_CACHE_CONTROL
            : segments[0] === 'assets' ? ASSET_CACHE_CONTROL : INDEX_CACHE_CONTROL;
          serveFile(request, response, real, stats, cacheControl);
          return;
        }
        const last = segments.at(-1);
        if (last && !pathname.endsWith('/') && path.extname(last)) throw notFound;
        const index = path.join(realRoot, 'index.html');
        const indexStats = statFile(index);
        if (!indexStats) throw notFound;
        serveFile(request, response, index, indexStats, INDEX_CACHE_CONTROL);
      } catch (error) {
        if (response.headersSent) response.destroy();
        else sendError(response, error instanceof HttpError ? error : notFound);
      }
    }
  };
}
