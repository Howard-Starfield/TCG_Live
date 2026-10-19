// Shared helpers for the console specs: the shared demo (playwright.config.ts webServer), API sign-in,
// and the stable selectors of the shell.
import { expect, type Locator, type Page } from '@playwright/test';
import { rawRequest } from './http';

/** The fixed launch token and port of the shared demo started by playwright.config.ts. */
export const SHARED_TOKEN = process.env.TCG_E2E_LOGIN_TOKEN ?? '';
export const SHARED_ORIGIN = `http://127.0.0.1:${process.env.TCG_E2E_PORT ?? ''}`;

/** sessionStorage key of the bearer token (apps/web/src/data/session.ts). */
export const SESSION_TOKEN_KEY = 'tcg-admin.session.v1';
/** localStorage key of the preferences (apps/web/src/data/preferences.ts). */
export const PREFERENCES_KEY = 'tcg-admin.prefs.v1';

/** Exchanges a launch token for a bearer token, as the SPA does (same-origin POST with Origin). */
export async function apiLogin(origin: string, token: string): Promise<string> {
  const response = await rawRequest(origin, 'POST', '/api/v1/session',
    { 'Content-Type': 'application/json', Origin: origin }, JSON.stringify({ token }));
  if (response.status !== 200) throw new Error(`Login failed with ${response.status}: ${response.body}`);
  return (JSON.parse(response.body) as { token: string }).token;
}

export async function apiGet<T>(origin: string, bearer: string, path: string): Promise<T> {
  const response = await rawRequest(origin, 'GET', `/api/v1${path}`, { Authorization: `Bearer ${bearer}` });
  if (response.status !== 200) throw new Error(`GET ${path} failed with ${response.status}`);
  return JSON.parse(response.body) as T;
}

// One bearer per worker for the shared demo: the server allows 60 sign-in attempts a minute in total,
// so specs that are not about signing in reuse it instead of exchanging the launch token every time.
const bearers = new Map<string, Promise<string>>();
export function sharedBearer(origin = SHARED_ORIGIN, token = SHARED_TOKEN): Promise<string> {
  let bearer = bearers.get(origin);
  if (!bearer) {
    bearer = apiLogin(origin, token);
    bearers.set(origin, bearer);
  }
  return bearer;
}

export interface OpenOptions {
  origin?: string;
  token?: string;
  /** Preferences written to localStorage before the app loads (only on the first load of the page). */
  preferences?: Record<string, unknown>;
}

/**
 * Opens the console already signed in: the bearer goes into this tab's sessionStorage before the app
 * boots (what a fragment login leaves behind), then waits for the main controls.
 */
export async function openConsole(page: Page, options: OpenOptions = {}): Promise<void> {
  const origin = options.origin ?? SHARED_ORIGIN;
  const bearer = await sharedBearer(origin, options.token ?? SHARED_TOKEN);
  await page.addInitScript(({ key, value, prefsKey, prefs }) => {
    if (!window.sessionStorage.getItem(key)) window.sessionStorage.setItem(key, value);
    if (prefs && !window.sessionStorage.getItem('e2e.prefs-seeded')) {
      window.localStorage.setItem(prefsKey, JSON.stringify(prefs));
      window.sessionStorage.setItem('e2e.prefs-seeded', '1');
    }
  }, { key: SESSION_TOKEN_KEY, value: bearer, prefsKey: PREFERENCES_KEY, prefs: options.preferences ?? null });
  await page.goto(`${origin}/`);
  await expectConsole(page);
}

/** The signed-in console with a live stream and a loaded event. */
export async function expectConsole(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: /Needs you/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.shell-stream')).toHaveAttribute('data-state', 'live', { timeout: 20_000 });
}

export const loginHeading = (page: Page): Locator => page.getByRole('heading', { name: 'Sign in to TCG Live' });
export const livePreviewToggle = (page: Page): Locator => page.getByRole('button', { name: /^Live preview/ });
export const listPreviewToggle = (page: Page): Locator => page.getByRole('button', { name: /^List preview/ });
export const accountMenuButton = (page: Page): Locator => page.getByRole('button', { name: /^Theme and account/ });
export const dock = (page: Page): Locator => page.getByTestId('preview-dock');
export const canvas = (page: Page): Locator => page.getByTestId('live-preview');
export const activityLog = (page: Page): Locator => page.getByTestId('activity-log');

/** Reads the persisted preferences. */
export async function storedPreferences(page: Page): Promise<Record<string, any>> {
  return page.evaluate(key => JSON.parse(window.localStorage.getItem(key) ?? '{}'), PREFERENCES_KEY);
}

/** Picks a theme from the account menu. */
export async function chooseTheme(page: Page, theme: 'Light' | 'Dark' | 'System'): Promise<void> {
  await accountMenuButton(page).click();
  await page.getByRole('menuitemradio', { name: theme }).click();
}
