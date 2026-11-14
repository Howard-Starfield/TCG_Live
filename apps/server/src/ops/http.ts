// Route-table types shared by the evidence and moderation routes. Structurally compatible with the
// admin handler's own Route type, so the tables spread straight into createAdminHttp's route list.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Capability } from '@tcg-live/core';
import { HttpError } from '../admin/http/respond.js';
import type { Session } from '../admin/http/sessions.js';

export type OpsAccess = 'public' | 'session' | Capability;
export interface OpsContext {
  request: IncomingMessage;
  response: ServerResponse;
  query: URLSearchParams;
  params: string[];
  /** Null only on 'public' endpoints. */
  session: Session | null;
}
export interface OpsEndpoint { access: OpsAccess; run(context: OpsContext): Promise<void> }
export interface OpsRoute { pattern: RegExp; methods: Partial<Record<string, OpsEndpoint>> }

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const notImplemented = (what: string) => new HttpError(501, 'unavailable', `${what} is not available in this version yet.`);

export function onlyParams(query: URLSearchParams, allowed: readonly string[]): void {
  for (const key of new Set(query.keys())) {
    if (!allowed.includes(key)) throw badRequest(`Unknown query parameter ${key.slice(0, 32)}.`);
    if (query.getAll(key).length > 1) throw badRequest(`${key} may be given once.`);
  }
}

export function integerQuery(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,16}$/.test(raw)) throw badRequest(`${name} must be an integer from ${min} to ${max}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw badRequest(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SNOWFLAKE = /^[1-9]\d{14,21}$/;

/** Plain text up to `max` code points, without control or format characters (newlines allowed when asked). */
export function readableText(value: string, max: number, multiline = false): boolean {
  const body = multiline ? value.replace(/\r?\n/g, '') : value;
  return [...value].length <= max && !/[\p{Cc}\p{Cf}]/u.test(body);
}
