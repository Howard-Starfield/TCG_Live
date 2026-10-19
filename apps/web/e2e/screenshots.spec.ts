// Visual record: light and dark at 1280 and 1440 px (login, console without panes, Live only, both panes)
// and the narrow sheet at 1000 px. Files go outside the repository (TCG_E2E_SHOTS_DIR, default
// %TEMP%/l8-shots) for a human to review. The specs also check for page-level horizontal overflow.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { canvas, dock, livePreviewToggle, loginHeading, openConsole } from './support/console';
import { startDemo, type DemoProcess } from './support/demo';

const SHOTS = process.env.TCG_E2E_SHOTS_DIR ?? path.join(tmpdir(), 'l8-shots');
mkdirSync(SHOTS, { recursive: true });

let demo: DemoProcess;
// Judge called on M1 while M2 runs: both ring kinds, a needs-you card and a full activity log.
test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 19 } }); });
test.afterAll(async () => { await demo?.kill(); });

type Theme = 'light' | 'dark';
type Panes = { live: boolean; list: boolean };

async function settle(page: Page): Promise<void> {
  // Wait for the dock spring and the canvas fit to come to rest.
  const dockWidth = () => dock(page).count().then(async count => (count ? Math.round((await dock(page).boundingBox())!.width) : 0));
  let previous = -1;
  await expect.poll(async () => { const width = await dockWidth(); const stable = width === previous; previous = width; return stable; },
    { intervals: [150] }).toBe(true);
  if (await canvas(page).count()) {
    const transform = () => canvas(page).locator('.react-flow__viewport').getAttribute('style');
    let last: string | null = '';
    await expect.poll(async () => { const now = await transform(); const stable = now === last; last = now; return stable; },
      { intervals: [150] }).toBe(true);
  }
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${name}: page-level horizontal overflow`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: 'disabled' });
}

for (const theme of ['light', 'dark'] as Theme[]) {
  for (const width of [1280, 1440]) {
    test.describe(`${theme} ${width}`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: theme });

      test('login', async ({ page }) => {
        await page.goto(`${demo.origin}/`);
        await expect(loginHeading(page)).toBeVisible();
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*\bdark\b).*$/);
        await shoot(page, `${theme}-${width}-login`);
      });

      const layouts: Array<[string, Panes]> = [
        ['console-no-panes', { live: false, list: false }],
        ['live-only', { live: true, list: false }],
        ['both-panes', { live: true, list: true }]
      ];
      for (const [name, panes] of layouts) {
        test(name, async ({ page }) => {
          await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { theme, panes, listTab: 'matches' } });
          await expect(page.locator('li[data-match="M1"]')).toBeVisible();
          if (panes.live) await expect(canvas(page).locator('[data-node="M2"]')).toHaveAttribute('data-state', 'live');
          await shoot(page, `${theme}-${width}-${name}`);
        });
      }
    });
  }

  test.describe(`${theme} 1000 sheet`, () => {
    test.use({ viewport: { width: 1000, height: 800 }, colorScheme: theme });
    test('narrow sheet', async ({ page }) => {
      await openConsole(page, { origin: demo.origin, token: demo.token,
        preferences: { theme, panes: { live: true, list: true }, listTab: 'audit' } });
      await livePreviewToggle(page).click();
      await expect(page.getByRole('dialog', { name: 'Previews' })).toBeVisible();
      // The sheet slides in from the right; wait until it stops moving.
      let lastX = -1;
      await expect.poll(async () => { const x = Math.round((await page.getByTestId('preview-sheet').boundingBox())!.x); const stable = x === lastX; lastX = x; return stable; },
        { intervals: [150] }).toBe(true);
      await shoot(page, `${theme}-1000-sheet`);
    });
  });
}
