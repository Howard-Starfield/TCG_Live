// Login, sessions and sign-out against the shared demo (plan: Security > Login).
import { expect, test } from '@playwright/test';
import {
  accountMenuButton, apiLogin, expectConsole, loginHeading, SESSION_TOKEN_KEY, SHARED_ORIGIN, SHARED_TOKEN
} from './support/console';
import { rawRequest } from './support/http';

test.describe('login', () => {
  test('the console link signs in and the fragment is stripped from the URL', async ({ page }) => {
    await page.goto(`${SHARED_ORIGIN}/#login=${SHARED_TOKEN}`);
    await expectConsole(page);
    expect(page.url()).toBe(`${SHARED_ORIGIN}/`);
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    // The launch token is not kept anywhere in the tab; only the bearer token is, in sessionStorage.
    const stored = await page.evaluate(key => ({
      bearer: window.sessionStorage.getItem(key),
      local: JSON.stringify(window.localStorage),
      history: window.history.length
    }), SESSION_TOKEN_KEY);
    expect(stored.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.bearer).not.toBe(SHARED_TOKEN);
    expect(stored.local).not.toContain(SHARED_TOKEN);
    // A reload keeps the session (sessionStorage survives reloads in the same tab).
    await page.reload();
    await expectConsole(page);
  });

  test('without a session the login screen is shown', async ({ page }) => {
    await page.goto(`${SHARED_ORIGIN}/`);
    await expect(loginHeading(page)).toBeVisible();
    await expect(page.getByLabel('Console link')).toBeFocused();
    await expect(page.getByText(/Each new tab signs in through the link again/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Needs you/ })).toHaveCount(0);
  });

  test('a bad token shows an actionable error', async ({ page }) => {
    await page.goto(`${SHARED_ORIGIN}/#login=not-the-launch-token-0123456789abcdef`);
    const alert = page.getByRole('alert').filter({ hasText: 'Sign-in failed' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/not accepted/);
    expect(page.url()).not.toContain('#login');
    await expect(loginHeading(page)).toBeVisible();
  });

  test('pasting the console link into the form signs in', async ({ page }) => {
    await page.goto(`${SHARED_ORIGIN}/`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Paste the console link printed in the server terminal.')).toBeVisible();
    await page.getByLabel('Console link').fill(`${SHARED_ORIGIN}/#login=${SHARED_TOKEN}`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expectConsole(page);
  });

  test('a new tab needs the console link; the first tab stays signed in', async ({ context }) => {
    const first = await context.newPage();
    await first.goto(`${SHARED_ORIGIN}/#login=${SHARED_TOKEN}`);
    await expectConsole(first);

    const second = await context.newPage();
    await second.goto(`${SHARED_ORIGIN}/`);
    await expect(loginHeading(second)).toBeVisible();
    expect(await second.evaluate(key => window.sessionStorage.getItem(key), SESSION_TOKEN_KEY)).toBeNull();

    await first.bringToFront();
    await first.reload();
    await expectConsole(first);
  });

  test('sign out returns to the login screen and revokes the bearer', async ({ page }) => {
    await page.goto(`${SHARED_ORIGIN}/#login=${SHARED_TOKEN}`);
    await expectConsole(page);
    const bearer = await page.evaluate(key => window.sessionStorage.getItem(key), SESSION_TOKEN_KEY);

    await accountMenuButton(page).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(loginHeading(page)).toBeVisible();
    await expect(page.getByText(/You signed out/)).toBeVisible();
    expect(await page.evaluate(key => window.sessionStorage.getItem(key), SESSION_TOKEN_KEY)).toBeNull();

    const response = await rawRequest(SHARED_ORIGIN, 'GET', '/api/v1/session', { Authorization: `Bearer ${bearer}` });
    expect(response.status).toBe(401);

    await page.reload();
    await expect(loginHeading(page)).toBeVisible();
  });

  test('a revoked stored session explains why the console signed out', async ({ page }) => {
    const bearer = await apiLogin(SHARED_ORIGIN, SHARED_TOKEN);
    const revoked = await rawRequest(SHARED_ORIGIN, 'DELETE', '/api/v1/session', { Authorization: `Bearer ${bearer}`, Origin: SHARED_ORIGIN });
    expect(revoked.status).toBe(204);
    await page.addInitScript(({ key, value }) => window.sessionStorage.setItem(key, value), { key: SESSION_TOKEN_KEY, value: bearer });
    await page.goto(`${SHARED_ORIGIN}/`);
    await expect(loginHeading(page)).toBeVisible();
    await expect(page.getByText(/Your session ended/)).toBeVisible();
  });

  test('opening the console link again in a signed-in tab strips it and keeps the session', async ({ page }) => {
    await page.goto(`${SHARED_ORIGIN}/#login=${SHARED_TOKEN}`);
    await expectConsole(page);
    const bearer = await page.evaluate(key => window.sessionStorage.getItem(key), SESSION_TOKEN_KEY);
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/session')) posts.push(request.url()); });
    // Same document, fragment change only (what pasting the link into the address bar of this tab does).
    await page.evaluate(token => { window.location.hash = `login=${token}`; }, SHARED_TOKEN);
    await expect(page.getByRole('status').filter({ hasText: 'Already signed in' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
    expect(page.url()).not.toContain(SHARED_TOKEN);
    expect(posts).toEqual([]);
    expect(await page.evaluate(key => window.sessionStorage.getItem(key), SESSION_TOKEN_KEY)).toBe(bearer);
    await expectConsole(page);
  });

  test('a pasted link for another console origin is refused without a request', async ({ page }) => {
    await page.goto(`${SHARED_ORIGIN}/`);
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/v1/session')) posts.push(request.url()); });
    const otherPort = Number(new URL(SHARED_ORIGIN).port) + 1;
    await page.getByLabel('Console link').fill(`http://127.0.0.1:${otherPort}/#login=${SHARED_TOKEN}`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(`That link belongs to the console at http://127.0.0.1:${otherPort}`)).toBeVisible();
    await expect(loginHeading(page)).toBeVisible();
    expect(posts).toEqual([]);
  });
});
