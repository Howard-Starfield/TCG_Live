import type { IncomingMessage } from 'node:http';
import { HttpError } from './respond.js';

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_BODY_DEPTH = 8;

const badRequest = (message: string, headers = {}) => new HttpError(400, 'bad_request', message, headers);
const tooLarge = () => badRequest('Request body is too large.', { Connection: 'close' });

function isJsonContentType(raw: string | undefined): boolean {
  if (!raw) return false;
  const [type, ...params] = raw.split(';').map(part => part.trim().toLowerCase());
  if (type !== 'application/json') return false;
  return params.every(param => param === '' || param === 'charset=utf-8' || param === 'charset="utf-8"');
}

function checkDepth(source: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (++depth > MAX_BODY_DEPTH) throw badRequest('Request body is nested too deeply.');
    } else if (char === '}' || char === ']') depth -= 1;
  }
}

/** Reads a JSON body within the size and depth limits. Resolves undefined for an empty body. */
export function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      request.resume();
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settle(() => reject(tooLarge()));
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', () => settle(() => reject(badRequest('Request body could not be read.'))));
    request.on('close', () => settle(() => reject(badRequest('Request body could not be read.'))));
    request.on('end', () => settle(() => {
      if (total === 0) {
        resolve(undefined);
        return;
      }
      if (!isJsonContentType(request.headers['content-type'])) {
        reject(badRequest('Request bodies must be application/json.'));
        return;
      }
      let source: string;
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        reject(badRequest('Request body must be UTF-8.'));
        return;
      }
      try {
        checkDepth(source);
        resolve(JSON.parse(source) as unknown);
      } catch (error) {
        reject(error instanceof HttpError ? error : badRequest('Request body is not valid JSON.'));
      }
    }));
  });
}

/** A plain object holding only `allowed` keys. */
export function strictObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('Request body must be a JSON object.');
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw badRequest('Request body has unknown fields.');
  return value as Record<string, unknown>;
}

/** Routes without a body accept nothing, or an empty JSON object. */
export async function readEmptyBody(request: IncomingMessage): Promise<void> {
  const body = await readJsonBody(request);
  if (body !== undefined) strictObject(body, []);
}

export async function readLoginBody(request: IncomingMessage): Promise<string> {
  const body = await readJsonBody(request);
  if (body === undefined) throw badRequest('Request body is required.');
  const { token } = strictObject(body, ['token']);
  if (typeof token !== 'string' || token.length < 1 || token.length > 256) throw badRequest('token must be a string.');
  return token;
}
