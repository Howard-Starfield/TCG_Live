import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalSettings } from '../onboarding/settings.js';

export type AdminMode = 'discord' | 'demo';
/** Demo only: autoplay advances on its own; interactive pauses wherever an admin decision is required. */
export type DemoPlayMode = 'autoplay' | 'interactive';

export interface AdminConfig {
  /** Serve the console. Always true in demo mode; TCG_ADMIN_CONSOLE=1 in Discord mode. */
  console: boolean;
  /**
   * Wave 3: browser-issued admin commands. Always true in demo mode; TCG_ADMIN_COMMANDS=1 in Discord mode.
   * Under the guided start (localSettings set) this is a live getter: TCG_ADMIN_COMMANDS=1 or the
   * "Allow dashboard actions" switch, read again on every access.
   */
  readonly commandsEnabled: boolean;
  /** Guided start only (npm start): the saved local switches. Absent for direct commands and the demo. */
  localSettings?: LocalSettings;
  /** Demo only: an extra allowed Origin for the Vite dev server. */
  devOrigin: string | null;
  /** Demo only: a fixed launch token for E2E tests. */
  fixedLoginToken: string | null;
  /** Absolute path of the built web assets. */
  webDist: string;
  /** Demo only (TCG_ADMIN_DEMO_MODE): autoplay by default, or interactive. Always autoplay in Discord mode. */
  demoMode: DemoPlayMode;
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

let guidedSettings: LocalSettings | null = null;

/**
 * Guided start (onboarding/entry.ts) registers its local switches before the Discord runtime reads its
 * configuration; null unregisters. Direct commands never register, so there the .env flags alone decide.
 */
export function useGuidedSettings(settings: LocalSettings | null): void {
  guidedSettings = settings;
}

export function readAdminConfig(mode: AdminMode, env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const config = readStaticAdminConfig(mode, env);
  const local = mode === 'discord' ? guidedSettings : null;
  if (!local) return config;
  // A `1` in .env forces actions on; otherwise the switch decides, on every read (no restart, no new sign-in).
  const forced = config.commandsEnabled;
  return Object.defineProperties({ ...config, localSettings: local }, {
    commandsEnabled: { enumerable: true, get: () => forced || local.dashboardActionsEnabled() },
    localSettings: { enumerable: false, value: local }
  });
}

function readStaticAdminConfig(mode: AdminMode, env: NodeJS.ProcessEnv): AdminConfig {
  const rawToken = env.TCG_ADMIN_LOGIN_TOKEN?.trim() || null;
  const rawOrigin = env.TCG_ADMIN_DEV_ORIGIN?.trim() || null;
  if (mode === 'discord' && rawToken) throw new Error(`${ERROR} TCG_ADMIN_LOGIN_TOKEN is demo-only; unset it to run the Discord runtime.`);
  if (mode === 'discord' && rawOrigin) throw new Error(`${ERROR} TCG_ADMIN_DEV_ORIGIN is demo-only; unset it to run the Discord runtime.`);
  const rawDemoMode = env.TCG_ADMIN_DEMO_MODE?.trim() || null;
  if (mode === 'discord' && rawDemoMode) throw new Error(`${ERROR} TCG_ADMIN_DEMO_MODE is demo-only; unset it to run the Discord runtime.`);
  if (rawDemoMode && rawDemoMode !== 'autoplay' && rawDemoMode !== 'interactive')
    throw new Error(`${ERROR} TCG_ADMIN_DEMO_MODE must be autoplay or interactive.`);
  if (rawToken && !/^[A-Za-z0-9_-]{32,128}$/.test(rawToken))
    throw new Error(`${ERROR} TCG_ADMIN_LOGIN_TOKEN must be 32 to 128 URL-safe characters.`);
  const rawDist = env.TCG_ADMIN_WEB_DIST?.trim();
  return {
    console: mode === 'demo' ? true : flag(env, 'TCG_ADMIN_CONSOLE'),
    commandsEnabled: mode === 'demo' ? true : flag(env, 'TCG_ADMIN_COMMANDS'),
    devOrigin: rawOrigin ? devOrigin(rawOrigin) : null,
    fixedLoginToken: rawToken,
    webDist: rawDist ? path.resolve(rawDist) : DEFAULT_WEB_DIST,
    demoMode: rawDemoMode === 'interactive' ? 'interactive' : 'autoplay'
  };
}
