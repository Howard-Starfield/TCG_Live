// Wave 0 toolchain smoke test: Playwright drives the installed Chrome (channel 'chrome'); no server needed.
import { expect, test } from '@playwright/test';

test('installed Chrome runs a page', async ({ page, browserName }) => {
  expect(browserName).toBe('chromium');
  await page.setContent('<main><h1>TCG Live</h1></main>');
  await expect(page.getByRole('heading', { name: 'TCG Live' })).toBeVisible();
  expect(await page.evaluate(() => navigator.userAgent)).toContain('Chrome');
});
