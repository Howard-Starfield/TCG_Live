// List preview: Players, Matches, Audit (filters, search, raw JSON) and Discord tabs, plus tab keyboard.
// Runs on a held scenario (script step 25: M2 resolved by the judge, M1 still waiting on its judge call),
// so the audit holds a fixed 24 applied entries: 5 by the admin, 7 on M2, two disputes.
import { expect, test, type Page } from '@playwright/test';
import { openConsole } from './support/console';
import { startDemo, type DemoProcess } from './support/demo';

let demo: DemoProcess;
test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 25 } }); });
test.afterAll(async () => { await demo?.kill(); });

test.use({ viewport: { width: 1440, height: 900 } });

const tab = (page: Page, name: RegExp) => page.getByRole('tablist', { name: 'List views' }).getByRole('tab', { name });
const panel = (page: Page) => page.getByTestId('list-pane').getByRole('tabpanel');
const bodyRows = (page: Page, table: RegExp) =>
  panel(page).getByRole('table', { name: table }).locator('tbody tr');

async function openList(page: Page, listTab: 'players' | 'matches' | 'audit' | 'panels'): Promise<void> {
  await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: false, list: true }, listTab } });
  await expect(page.getByTestId('list-pane')).toBeVisible();
}

test('Players: seated players by name with check-in and match', async ({ page }) => {
  await openList(page, 'players');
  await expect(tab(page, /^Players/)).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page)).toContainText('4 seated · 4 checked in · round published');
  const rows = bodyRows(page, /^Players by seat/);
  await expect(rows).toHaveCount(4);
  for (const name of ['Ava Chen', 'Ben Ortiz', 'Cy Park', 'Dee Ross']) await expect(panel(page)).toContainText(name);
  await expect(panel(page)).not.toContainText('Eli Moss');   // joined, then removed by the admin
  await expect(panel(page).getByRole('img', { name: 'Checked in' })).toHaveCount(4);
});

test('Matches: both matches with judge state and results; the tab badge counts judge calls', async ({ page }) => {
  await openList(page, 'matches');
  await expect(tab(page, /^Matches/)).toContainText('1');
  const rows = bodyRows(page, /^Matches/);
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'M1' })).toContainText(/called/i);
  await expect(rows.filter({ hasText: 'M2' })).toContainText('Dee Ross');
});

test('Audit: filters, search, Enter on a row shows the raw JSON', async ({ page }) => {
  await openList(page, 'audit');
  const rows = bodyRows(page, /^Audit log/);
  await expect(rows).toHaveCount(24);
  const search = page.getByRole('search', { name: 'Filter audit entries' });
  await expect(search).toContainText('24 loaded');
  // Newest first.
  await expect(rows.first()).toContainText('24');
  await expect(rows.first()).toContainText('resolve');

  await search.getByRole('combobox', { name: 'Actor kind' }).selectOption('admin');
  await expect(rows).toHaveCount(5);
  await expect(search).toContainText('5 of 24');
  for (const type of ['signupRemove', 'signupClose', 'publish', 'judgeResume', 'resolve']) {
    await expect(rows.filter({ hasText: type })).toHaveCount(1);
  }

  await search.getByRole('button', { name: 'Clear' }).click();
  await expect(rows).toHaveCount(24);
  await search.getByRole('combobox', { name: 'Match' }).selectOption('M2');
  await expect(rows).toHaveCount(7);
  await search.getByRole('combobox', { name: 'Command type' }).selectOption('dispute');
  await expect(rows).toHaveCount(2);

  await search.getByRole('button', { name: 'Clear' }).click();
  await search.getByRole('searchbox', { name: 'Search audit' }).fill('no-such-entry-xyz');
  await expect(panel(page).getByText('No entries match')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows).toHaveCount(24);
  await search.getByRole('searchbox', { name: 'Search audit' }).fill('publish');
  await expect(rows).toHaveCount(1);

  // Raw JSON: Enter on the focused row opens the detail; its close button (and Enter again) hides it.
  await rows.first().focus();
  await page.keyboard.press('Enter');
  const detail = panel(page).locator('section').filter({ has: page.getByRole('heading', { name: /#12/ }) });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('Raw JSON')).toBeVisible();
  await expect(detail.locator('pre, code').first()).toContainText('"type": "publish"');
  await expect(detail.locator('pre, code').first()).toContainText('"sequence": 12');
  await expect(rows.first()).toHaveAttribute('aria-current', 'true');
  await detail.getByRole('button', { name: 'Close entry 12' }).click();
  await expect(detail).toHaveCount(0);
  await rows.first().click();
  const rawJson = panel(page).getByRole('button', { name: /^Raw JSON/ });
  await expect(rawJson).toBeVisible();
  await expect(rawJson).toHaveAttribute('aria-expanded', 'true');
  await rows.first().press('Enter');
  await expect(rawJson).toHaveCount(0);
});

test('Discord: posted cards, IDs and the panel revision', async ({ page }) => {
  await openList(page, 'panels');
  await expect(tab(page, /Discord/)).toHaveAttribute('aria-selected', 'true');
  const cards = bodyRows(page, /^Discord cards/);
  await expect(cards).toHaveCount(3);
  await expect(panel(page)).toContainText('910000000000000100');   // demo guild ID
  await expect(panel(page)).toContainText('Panel revision');
  await expect(panel(page).getByRole('button', { name: /Copy guild ID/ })).toBeVisible();
});

test('tabs: arrow keys, Home and End move the selection; the choice persists', async ({ page }) => {
  await openList(page, 'players');
  await tab(page, /^Players/).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, /^Matches/)).toBeFocused();
  await expect(tab(page, /^Matches/)).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByRole('table', { name: /^Matches/ })).toBeVisible();
  await page.keyboard.press('End');
  await expect(tab(page, /Discord/)).toBeFocused();
  await expect(tab(page, /Discord/)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, /^Players/)).toBeFocused();                 // wraps around
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, /Discord/)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tab(page, /^Players/)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, /^Audit/)).toHaveAttribute('aria-selected', 'true');
  // Only the selected tab is in the Tab order.
  await expect(page.getByRole('tablist', { name: 'List views' }).locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

  await page.reload();
  await expect(tab(page, /^Audit/)).toHaveAttribute('aria-selected', 'true');
});
