// Live updates: the stock demo (demo.js, unmodified script) advances on its own; the activity stream,
// stepper, sidebar and canvas follow over the one open stream, without a reload.
//
// Demo timing (apps/server/src/admin/runtime/demo-runtime.ts demoScript): first join at 2 s, signup
// closes at 18 s, check-ins until 28 s, pairings published at 31 s, both matches running by 38.5 s.
import { expect, test } from '@playwright/test';
import { activityLog, canvas, expectConsole } from './support/console';
import { startDemo, type DemoProcess } from './support/demo';

let demo: DemoProcess;

test.beforeAll(async () => { demo = await startDemo(); });
test.afterAll(async () => { await demo?.kill(); });

test.use({ viewport: { width: 1440, height: 900 } });

test('activity, stepper, sidebar and canvas update from the stream without a reload', async ({ page }) => {
  test.setTimeout(120_000);
  const streams: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/v1/stream')) streams.push(request.url()); });

  await page.goto(demo.loginUrl());
  await expectConsole(page);
  await page.evaluate(() => { (window as unknown as { e2eMarker: string }).e2eMarker = 'same-document'; });

  const lines = activityLog(page).locator('[data-sequence]');
  const step = (id: string) => page.locator(`.console-step[data-step="${id}"]`);
  const node = (id: string) => canvas(page).locator(`[data-node="${id}"]`);

  // Signup: entries arrive one by one and the joined count climbs.
  await expect(lines.first()).toBeVisible({ timeout: 20_000 });
  await expect(lines.first()).toContainText('Joined signup');
  await expect.poll(() => lines.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  await expect(step('signup')).toHaveAttribute('aria-current', 'step');
  await expect(node('signup')).toHaveAttribute('data-state', 'live');
  await expect(step('signup')).toContainText(/[1-4]\/4 joined/);

  // Signup closes and check-in starts (about 18 s after boot).
  await expect(step('checkin')).toHaveAttribute('aria-current', 'step', { timeout: 40_000 });
  await expect(step('signup')).toContainText('done');
  await expect(node('signup')).toHaveAttribute('data-state', 'done');
  await expect(node('checkin')).toHaveAttribute('data-state', 'live');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).locator('[aria-current="page"]')).toHaveText('Check-in');
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toContainText('Check-in · live');

  // Pairings published and both matches running (about 38.5 s after boot): clay rings and a ticking clock.
  await expect(step('live')).toHaveAttribute('aria-current', 'step', { timeout: 40_000 });
  await expect(node('M1')).toHaveAttribute('data-state', 'live', { timeout: 20_000 });
  await expect(node('M2')).toHaveAttribute('data-state', 'live', { timeout: 20_000 });
  const clock = canvas(page).getByTestId('clock-M2');
  await expect(clock).toHaveAttribute('data-clock-state', 'running', { timeout: 20_000 });
  const first = await clock.textContent();
  await expect(clock).not.toHaveText(first ?? '', { timeout: 5_000 });

  // The activity log kept growing in the same document, pinned to the newest entry.
  expect(await lines.count()).toBeGreaterThanOrEqual(14);
  await expect(lines.last()).toBeInViewport();

  // Scrolled up, new entries do not move the view; "Jump to latest" says there is news and goes back down.
  // Only user input unpins (useScrollPin): scroll up with the mouse wheel.
  const logBox = (await activityLog(page).boundingBox())!;
  await page.mouse.move(logBox.x + logBox.width / 2, logBox.y + logBox.height / 2);
  await page.mouse.wheel(0, -4000);
  await expect.poll(() => activityLog(page).evaluate(element => element.scrollTop)).toBeLessThan(50);
  const jump = page.getByRole('button', { name: /Jump to latest/ });
  await expect(jump).toBeVisible();
  const before = await lines.count();
  await expect.poll(() => lines.count(), { timeout: 30_000 }).toBeGreaterThan(before);   // A pauses M1 at ~50 s
  await expect(jump).toHaveText(/New activity · Jump to latest/);
  expect(await activityLog(page).evaluate(element => element.scrollTop)).toBeLessThan(50);
  await jump.click();
  await expect(lines.last()).toBeInViewport();
  await expect(jump).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { e2eMarker?: string }).e2eMarker)).toBe('same-document');
  expect(streams).toHaveLength(1);
});
