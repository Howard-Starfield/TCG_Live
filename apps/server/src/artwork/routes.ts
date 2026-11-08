import type { IncomingMessage, ServerResponse } from 'node:http';
import { artworkGame, artworkSlot, ArtworkInputError, MAX_ARTWORK_BYTES, type ArtworkStore } from './store.js';
import { readEmptyBody, readJsonBody, strictObject } from '../admin/http/body.js';
import { HttpError, SECURITY_HEADERS, sendJson } from '../admin/http/respond.js';

type Context = { request: IncomingMessage; response: ServerResponse; params: string[] };
type Endpoint = { access: 'session'; run(context: Context): Promise<void> };
export type ArtworkRoute = { pattern: RegExp; methods: Partial<Record<string, Endpoint>> };

function invalid(error: unknown): never {
  if (error instanceof ArtworkInputError) throw new HttpError(400, 'bad_request', error.message);
  throw error;
}

/** A separate bounded binary reader; the normal JSON body cap stays at 16 KiB. */
export function readArtworkBody(request: IncomingMessage): Promise<Buffer> {
  const type = request.headers['content-type'];
  if (type !== 'image/gif' && type !== 'image/png' && type !== 'image/jpeg')
    throw new HttpError(400, 'bad_request', 'Send a GIF, PNG or JPEG image.');
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_ARTWORK_BYTES))
    throw new HttpError(413, 'bad_request', 'Artwork must be at most 4 MB.', { Connection: 'close' });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (action: () => void) => { if (!settled) { settled = true; action(); } };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_ARTWORK_BYTES) {
        chunks.length = 0;
        finish(() => reject(new HttpError(413, 'bad_request', 'Artwork must be at most 4 MB.', { Connection: 'close' })));
      } else chunks.push(chunk);
    });
    request.on('end', () => finish(() => total === 0 ? reject(new HttpError(400, 'bad_request', 'Choose an image to upload.'))
      : resolve(Buffer.concat(chunks, total))));
    request.on('error', () => finish(() => reject(new HttpError(400, 'bad_request', 'Artwork could not be read.'))));
    request.on('close', () => finish(() => reject(new HttpError(400, 'bad_request', 'Artwork could not be read.'))));
  });
}

function game(value: string | undefined) {
  try { return artworkGame(value ?? ''); } catch (error) { return invalid(error); }
}
function slot(value: string | undefined) {
  try { return artworkSlot(value ?? ''); } catch (error) { return invalid(error); }
}

export function artworkRoutes(store: ArtworkStore): ArtworkRoute[] {
  return [
    { pattern: /^\/api\/v1\/artwork$/, methods: {
      GET: { access: 'session', run: async ({ response }) => sendJson(response, 200, store.describe()) }
    } },
    { pattern: /^\/api\/v1\/artwork\/active-game$/, methods: {
      PUT: { access: 'session', run: async ({ request, response }) => {
        const body = strictObject(await readJsonBody(request), ['game']);
        if (body.game !== null && typeof body.game !== 'string')
          throw new HttpError(400, 'bad_request', 'Choose a supported game or clear the choice.');
        let selected;
        try { selected = body.game === null ? null : artworkGame(body.game); } catch (error) { return invalid(error); }
        sendJson(response, 200, await store.selectGame(selected));
      } }
    } },
    { pattern: /^\/api\/v1\/artwork\/([^/]+)\/(banner|thumbnail)\/preview$/, methods: {
      GET: { access: 'session', run: async ({ response, params }) => {
        const selected = await store.preview(game(params[0]), slot(params[1]));
        if (!selected) { response.writeHead(204, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' }); response.end(); return; }
        response.writeHead(200, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store',
          'Content-Type': selected.image.contentType, 'Content-Length': selected.bytes.length });
        response.end(selected.bytes);
      } }
    } },
    { pattern: /^\/api\/v1\/artwork\/([^/]+)\/(banner|thumbnail)$/, methods: {
      PUT: { access: 'session', run: async ({ request, response, params }) => {
        const selectedGame = game(params[0]);
        const selectedSlot = slot(params[1]);
        const bytes = await readArtworkBody(request);
        try { sendJson(response, 200, await store.upload(selectedGame, selectedSlot, bytes, request.headers['content-type'])); }
        catch (error) { invalid(error); }
      } },
      DELETE: { access: 'session', run: async ({ request, response, params }) => {
        await readEmptyBody(request);
        sendJson(response, 200, await store.reset(game(params[0]), slot(params[1])));
      } }
    } }
  ];
}
