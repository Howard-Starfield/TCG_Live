import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type AdminMode = 'discord' | 'demo';

export interface AdminConfig {
  /** Serve the console. Always true in demo mode; TCG_ADMIN_CONSOLE=1 in Discord mode. */
  console: boolean;
  /** Wave 3: browser-issued admin commands. Always true in demo mode; TCG_ADMIN_COMMANDS=1 in Discord mode. */
  commandsEnabled: boolean;
  /** Demo only: an extra allowed Origin for the Vite dev server. */
  devOrigin: string | null;
  /** Demo only: a fixed launch token for E2E tests. */
  fixedLoginToken: string | null;
  /** Absolute path of the built web assets. */
  webDist: string;
}

const ERROR = 'Invalid configuration:';

// dist/admin/config.js -> apps/web/dist; independent of the working directory.
export const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '' || raw.trim() === '0') return false;
  if (raw.trim() === '1') return true;
  throw new Error(`${ERROR} ${name} must be 0 or 1.`);
}

function devOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${ERROR} TCG_ADMIN_DEV_ORIGIN must be an http loopback origin.`); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !url.port ||
      url.origin !== raw.replace(/\/$/, '')) {
    throw new Error(`${ERROR} TCG_ADMIN_DEV_ORIGIN must be an http loopback origin such as http://localhost:5173.`);
  }
  return url.origin;
}

export function readAdminConfig(mode: AdminMode, env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const rawToken = env.TCG_ADMIN_LOGIN_TOKEN?.trim() || null;
  const rawOrigin = env.TCG_ADMIN_DEV_ORIGIN?.trim() || null;
  if (mode === 'discord' && rawToken) throw new Error(`${ERROR} TCG_ADMIN_LOGIN_TOKEN is demo-only; unset it to run the Discord runtime.`);
  if (mode === 'discord' && rawOrigin) throw new Error(`${ERROR} TCG_ADMIN_DEV_ORIGIN is demo-only; unset it to run the Discord runtime.`);
  if (rawToken && !/^[A-Za-z0-9_-]{32,128}$/.test(rawToken))
    throw new Error(`${ERROR} TCG_ADMIN_LOGIN_TOKEN must be 32 to 128 URL-safe characters.`);
  const rawDist = env.TCG_ADMIN_WEB_DIST?.trim();
  return {
    console: mode === 'demo' ? true : flag(env, 'TCG_ADMIN_CONSOLE'),
    commandsEnabled: mode === 'demo' ? true : flag(env, 'TCG_ADMIN_COMMANDS'),
    devOrigin: rawOrigin ? devOrigin(rawOrigin) : null,
    fixedLoginToken: rawToken,
    webDist: rawDist ? path.resolve(rawDist) : DEFAULT_WEB_DIST
  };
}
