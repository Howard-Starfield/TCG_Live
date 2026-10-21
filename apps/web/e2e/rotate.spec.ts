// Rotate console link: account menu > confirm dialog > toast; the demo prints a new link on stdout, the old
// link stops working and the new one works. Runs on a private demo so the shared launch token survives.
import { expect, test } from '@playwright/test';
import { accountMenuButton, apiLogin, expectConsole, loginHeading } from './support/console';
import { startDemo, type DemoProcess } from './support/demo';
import { rawRequest } from './support/http';

let demo: DemoProcess;
test.beforeAll(async () => { demo = await startDemo(); });
test.afterAll(async () => { await demo?.kill(); });

const LINK = /Admin console: (http:\/\/127\.0\.0\.1:\d+\/#login=([A-Za-z0-9_-]+))/;

test('rotating the link from the account menu replaces the launch token', async ({ page, context }) => {
  await page.goto(demo.loginUrl());
  await expectConsole(page);
  const printedBefore = demo.stdout().length;

  await accountMenuButton(page).click();
  await page.getByRole('menuitem', { name: 'Rotate console link' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Rotate the console link?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('the current link stops working');

  // Cancel first: nothing is rotated.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(demo.stdout().length).toBe(printedBefore);

  await accountMenuButton(page).click();
  await page.getByRole('menuitem', { name: 'Rotate console link' }).click();
  await dialog.getByRole('button', { name: 'Rotate link' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'New console link printed in the terminal' })).toBeVisible();

  // The demo prints the fresh link on stdout, exactly like the startup line.
  const [, newUrl, newToken] = await demo.waitForStdout(LINK, 10_000, printedBefore);
  expect(newToken).not.toBe(demo.token);
  expect(newUrl).toBe(demo.loginUrl(newToken));
  expect(demo.stdout().slice(printedBefore)).not.toContain(demo.token);

  // This tab stays signed in.
  await page.reload();
  await expectConsole(page);

  // The old link is refused in a new tab; the new one signs in.
  const oldTab = await context.newPage();
  await oldTab.goto(demo.loginUrl());
  await expect(oldTab.getByRole('alert').filter({ hasText: 'Sign-in failed' })).toContainText(/rotated/);
  await expect(loginHeading(oldTab)).toBeVisible();

  const newTab = await context.newPage();
  await newTab.goto(newUrl!);
  await expectConsole(newTab);

  // Same through the API.
  await expect(apiLogin(demo.origin, demo.token)).rejects.toThrow(/401/);
  await expect(apiLogin(demo.origin, newToken!)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test('rotate-link needs a session and a same-origin request', async () => {
  const anonymous = await rawRequest(demo.origin, 'POST', '/api/v1/session/rotate-link', { Origin: demo.origin });
  expect(anonymous.status).toBe(401);
  const current = /#login=([A-Za-z0-9_-]+)/.exec(demo.stdout().trim().split('\n').reverse().find(line => line.includes('#login=')) ?? '')![1]!;
  const bearer = await apiLogin(demo.origin, current);
  const noOrigin = await rawRequest(demo.origin, 'POST', '/api/v1/session/rotate-link', { Authorization: `Bearer ${bearer}` });
  expect(noOrigin.status).toBe(403);
  const before = demo.stdout().length;
  const ok = await rawRequest(demo.origin, 'POST', '/api/v1/session/rotate-link', { Authorization: `Bearer ${bearer}`, Origin: demo.origin });
  expect(ok.status).toBe(204);
  const [, , rotated] = await demo.waitForStdout(LINK, 10_000, before);
  expect(rotated).not.toBe(current);
});
