import type { ServerResponse } from 'node:http';
import type { ErrorCode, ErrorDto } from '@tcg-live/core';
import { AdminNotFoundError, AdminUnavailableError } from '../runtime-types.js';

export const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com; " +
  "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};

export type HeaderMap = Record<string, string | number>;

/** An error whose code and message are safe to show to the admin. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string, readonly headers: HeaderMap = {}) {
    super(message);
  }
}

export const unavailable = () => new HttpError(503, 'unavailable', 'The admin console is unavailable.');

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: HeaderMap = {}): void {
  if (response.headersSent || response.destroyed) {
    if (!response.writableEnded) response.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers
  });
  response.end(payload);
}

export function sendNoContent(response: ServerResponse): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(204, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
  response.end();
}

export function sendError(response: ServerResponse, error: HttpError): void {
  const body: ErrorDto = { error: { code: error.code, message: error.message } };
  sendJson(response, error.status, body, error.headers);
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof AdminNotFoundError) return new HttpError(404, 'not_found', 'Not found.');
  if (error instanceof AdminUnavailableError) return new HttpError(503, 'unavailable', 'The event store is unavailable.');
  // The contract has no internal-error code; the message stays generic.
  return new HttpError(500, 'unavailable', 'Internal error.');
}

/** Answers with a mapped error, or drops the connection when a response is already under way. Never throws. */
export function fail(response: ServerResponse, error: unknown): void {
  try {
    if (response.headersSent) {
      if (!response.writableEnded) response.destroy();
      return;
    }
    sendError(response, toHttpError(error));
  } catch {
    response.destroy();
  }
}
