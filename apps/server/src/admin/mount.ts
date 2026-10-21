import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminMode } from './config.js';
import { createAdminHttp } from './http/handler.js';
import type { AdminRuntime } from './runtime-types.js';

export interface AdminHandlerOptions {
  runtime: AdminRuntime;
  /** The bound loopback port; Host must name it. */
  port: number;
  mode: AdminMode;
  commandsEnabled: boolean;
  /** Built web assets. Static serving is skipped when absent. */
  webDist?: string;
  /** Demo only: an extra allowed Origin. */
  devOrigin?: string | null;
  /** Demo only: a fixed launch token for E2E tests. */
  fixedLoginToken?: string | null;
  /** Where rotate-link prints the fresh console link. Defaults to stdout. */
  printLoginUrl?: (url: string) => void;
}

export interface AdminHandler {
  /** Returns true when the request was handled (including error responses), false to fall through to 404. */
  handle(request: IncomingMessage, response: ServerResponse): boolean;
  /** `http://127.0.0.1:PORT/#login=<token>`, or null before a launch token exists. */
  loginUrl(): string | null;
  /** Replaces the launch token, invalidating the old one, and returns the new link. */
  rotateLoginUrl(): string;
  /** Ends streams, answers new requests with 503, clears timers, unsubscribes. Idempotent. */
  close(): Promise<void>;
}

/** The admin console's HTTP layer: auth, read routes, the live stream and the static web build. */
export function createAdminHandler(options: AdminHandlerOptions): AdminHandler {
  return createAdminHttp(options);
}
