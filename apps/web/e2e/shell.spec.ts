// Shell: top bar, preview toggles (click and Alt+1/Alt+2), dock persistence, sidebar and theme.
import { expect, test } from '@playwright/test';
import {
  activityLog, apiGet, apiLogin, canvas, chooseTheme, dock, listPreviewToggle, livePreviewToggle, openConsole, storedPreferences
} from './support/console';
import { startDemo, type DemoProcess } from './support/demo';

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('top bar', () => {
  test('breadcrumb, runtime chips and the account menu', async ({ page }) => {
    await openConsole(page);
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs).toContainText('TCG Live');
    await expect(crumbs).toContainText(/Signup session · \d{2}:\d{2}/);
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText(/^(Signup|Check-in|Round 1|Standings)$/);
    await expect(page.locator('header.shell-topbar')).toContainText(/Discord\s*Demo/);
    await expect(page.locator('header.shell-topbar')).toContainText(/PostgreSQL\s*Demo/);
    const group = page.getByRole('group', { name: 'Previews' });
    await expect(group.getByRole('button')).toHaveCount(2);
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-keyshortcuts', 'Alt+1');
    await expect(listPreviewToggle(page)).toHaveAttribute('aria-keyshortcuts', 'Alt+2');
  });

  test('sidebar footer shows the stream state and the account; no command composer before Wave 3', async ({ page }) => {
    await openConsole(page);
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(sidebar.locator('.shell-stream')).toContainText('Live updates');
    await expect(sidebar.getByRole('button', { name: /Local admin/ })).toContainText('demo');
    // Wave 3 adds the composer; the read-only console ships no inert input or action controls.
    await expect(page.getByRole('main', { name: 'Console' }).getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('main', { name: 'Console' }).getByRole('button', { name: /resolve|publish|remove|correct/i })).toHaveCount(0);
  });
});

test.describe('preview toggles', () => {
  test('clicking the toggles opens and closes the panes with aria-pressed', async ({ page }) => {
    await openConsole(page);
    // Defaults: Live preview open, List preview closed.
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(listPreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('live-pane')).toBeVisible();
    await expect(page.getByTestId('list-pane')).toHaveCount(0);

    await listPreviewToggle(page).click();
    await expect(listPreviewToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('live-pane')).toBeVisible();
    await expect(page.getByTestId('list-pane')).toBeVisible();
    await expect(dock(page).getByRole('separator', { name: 'Resize live and list previews' })).toBeVisible();

    await livePreviewToggle(page).click();
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('live-pane')).toHaveCount(0);
    await expect(page.getByTestId('list-pane')).toBeVisible();

    await listPreviewToggle(page).click();
    await expect(listPreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(dock(page)).toHaveCount(0);

    // A pane's own close button is the same toggle.
    await livePreviewToggle(page).click();
    await expect(page.getByTestId('live-pane')).toBeVisible();
    await page.getByRole('complementary', { name: 'Previews' }).getByRole('button', { name: /^Close/ }).first().click();
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(dock(page)).toHaveCount(0);
    // Closing a pane hands focus back to its top-bar toggle (keyboard too).
    await expect(livePreviewToggle(page)).toBeFocused();
    await listPreviewToggle(page).click();
    await page.getByRole('button', { name: 'Close list preview' }).focus();
    await page.keyboard.press('Enter');
    await expect(listPreviewToggle(page)).toBeFocused();
    await expect(listPreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('Alt+1 and Alt+2 toggle the panes', async ({ page }) => {
    await openConsole(page);
    await page.locator('main.shell-main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Alt+1');
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(dock(page)).toHaveCount(0);
    await page.keyboard.press('Alt+2');
    await expect(listPreviewToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('list-pane')).toBeVisible();
    await page.keyboard.press('Alt+1');
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('live-pane')).toBeVisible();
    await page.keyboard.press('Alt+2');
    await expect(listPreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('list-pane')).toHaveCount(0);
  });

  test('shortcuts are ignored while typing in a field', async ({ page }) => {
    await openConsole(page, { preferences: { panes: { live: false, list: true }, listTab: 'audit' } });
    const search = page.getByRole('searchbox', { name: 'Search audit' });
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.click();
    await page.keyboard.press('Alt+1');
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('persistence', () => {
  test('pane state, dock width, split ratio, list tab and canvas view survive a reload', async ({ page }) => {
    await openConsole(page);
    await listPreviewToggle(page).click();
    const dockHandle = page.getByRole('separator', { name: 'Resize previews' });
    const split = page.getByRole('separator', { name: 'Resize live and list previews' });
    await expect(dockHandle).toHaveAttribute('aria-valuenow', '480');

    // Dock width: keyboard (+16 px per ArrowLeft) and a pointer drag (100 px to the left).
    await dockHandle.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(dockHandle).toHaveAttribute('aria-valuenow', '512');
    // The dock springs to its new width; grab the handle once it has settled.
    await expect.poll(async () => Math.round((await dock(page).boundingBox())!.width)).toBe(512);
    // Grab it in the top quarter: at mid-height the live/list divider overlaps it (see the fixme below).
    const box = (await dockHandle.boundingBox())!;
    const y = box.y + box.height / 4;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 50, y, { steps: 5 });
    await page.mouse.move(box.x + box.width / 2 - 100, y, { steps: 5 });
    await page.mouse.up();
    await expect(dockHandle).toHaveAttribute('aria-valuenow', '612');

    // Split ratio: ArrowDown grows the first (live) pane.
    await expect(split).toHaveAttribute('aria-valuenow', '50');
    await split.focus();
    await page.keyboard.press('Shift+ArrowDown');
    const ratio = Number(await split.getAttribute('aria-valuenow'));
    expect(ratio).toBeGreaterThan(50);

    await page.getByRole('tab', { name: /^Matches/ }).click();
    await page.getByRole('group', { name: 'Canvas view' }).getByRole('button', { name: 'Match M2' }).click();
    await expect(canvas(page)).toHaveAttribute('data-view', 'match');

    const before = await storedPreferences(page);
    expect(before).toMatchObject({ panes: { live: true, list: true }, sizes: { dockWidth: 612 }, listTab: 'matches', canvasView: 'match' });
    expect(Math.round(before.sizes.split * 100)).toBe(ratio);

    await page.reload();
    await expect(page.getByRole('heading', { name: /Needs you/ })).toBeVisible();
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(listPreviewToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('separator', { name: 'Resize previews' })).toHaveAttribute('aria-valuenow', '612');
    await expect(page.getByRole('separator', { name: 'Resize live and list previews' })).toHaveAttribute('aria-valuenow', String(ratio));
    await expect(page.getByRole('tab', { name: /^Matches/ })).toHaveAttribute('aria-selected', 'true');
    await expect(canvas(page)).toHaveAttribute('data-view', 'match');
    const width = (await dock(page).boundingBox())!.width;
    expect(Math.abs(width - 612)).toBeLessThanOrEqual(2);
  });

  test('closed panes stay closed after a reload', async ({ page }) => {
    await openConsole(page);
    await livePreviewToggle(page).click();
    await expect(dock(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: /Needs you/ })).toBeVisible();
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(dock(page)).toHaveCount(0);
  });

  test('sidebar collapse and theme persist', async ({ page }) => {
    await openConsole(page);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveAttribute('data-collapsed', 'true');
    await chooseTheme(page, 'Dark');
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
    await page.reload();
    await expect(page.getByRole('heading', { name: /Needs you/ })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveAttribute('data-collapsed', 'true');
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await chooseTheme(page, 'Light');
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/);
  });
});

test.describe('sidebar history (one retired event, a fresh active one)', () => {
  let demo: DemoProcess;
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 28, durationMs: 3_000, retireOnce: true } }); });
  test.afterAll(async () => { await demo?.kill(); });

  test('the active event is listed first with a live marker; a retired one opens read-only', async ({ page }) => {
    // Open the console once the first event has retired (see the fixme below for a tab that saw it retire).
    const bearer = await apiLogin(demo.origin, demo.token);
    await expect.poll(async () => (await apiGet<Array<{ status: string }>>(demo.origin, bearer, '/events')).map(event => event.status),
      { timeout: 20_000 }).toEqual(['active', 'retired']);
    await openConsole(page, { origin: demo.origin, token: demo.token });
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    const active = sidebar.getByRole('navigation', { name: 'Active event' });
    const history = sidebar.getByRole('navigation', { name: 'Event history' });
    await expect(active.getByRole('button')).toHaveCount(1);
    await expect(active.getByRole('button')).toHaveAttribute('aria-current', 'page');
    await expect(active).toContainText('Signup · live');
    await expect(history).toContainText('History · read-only', { timeout: 20_000 });
    await expect(history.getByRole('button')).toHaveCount(1);
    await expect(history.getByRole('button')).toContainText(/Retired \d{2}:\d{2}/);
    const order = await sidebar.getByRole('navigation').evaluateAll(navs => navs.map(nav => nav.getAttribute('aria-label')));
    expect(order).toEqual(['Active event', 'Event history']);

    // The retired event: frozen history, nothing actionable, audit labelled as history.
    await history.getByRole('button').click();
    await expect(history.getByRole('button')).toHaveAttribute('aria-current', 'page');
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('History');
    await expect(page.locator('[data-banner="retired"]')).toContainText('Retired event · read-only history.');
    await expect(page.getByTestId('needs-you-empty')).toContainText('This event is closed.');
    await expect(page.locator('.console-step[data-step="complete"]')).toContainText('Final');
    await expect(page.getByRole('heading', { name: /^Activity/ })).toContainText('history');
    await expect(activityLog(page).locator('[data-sequence]')).toHaveCount(27);
    await expect(canvas(page).locator('[data-node="standings"]')).toHaveAttribute('data-state', 'done');

    // "TCG Live" in the breadcrumb follows the live event again.
    await crumbs.getByRole('button', { name: 'TCG Live' }).click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Signup');
    await expect(active.getByRole('button')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: /^Activity/ })).toContainText('live');
    await expect(page.locator('[data-banner="retired"]')).toHaveCount(0);
  });
});

test.describe('an event that retires while the tab is open', () => {
  let demo: DemoProcess;
  // Steps 40 ms apart, M1's clock runs out after 3 s, the event completes, and it retires 4 s later.
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 28, durationMs: 3_000, retireOnce: true, retireGapMs: 4_000 } }); });
  test.afterAll(async () => { await demo?.kill(); });

  // Regression guard: before the Wave 2 review fixes the snapshot cache never refetched (staleTime: Infinity)
  // and the stream only pushes the new active event, so a tab that watched an event retire kept showing it
  // as active ("Standings" instead of "History"). Fixed on feat/admin-dashboard (cache.ts releasePreviousActive).
  test('selecting the just-retired event shows it as read-only history', async ({ page }) => {
    await openConsole(page, { origin: demo.origin, token: demo.token });
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Standings', { timeout: 15_000 });
    const history = page.getByRole('navigation', { name: 'Event history' });
    await expect(history.getByRole('button')).toHaveCount(1, { timeout: 15_000 });
    await history.getByRole('button').click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('History');
    await expect(page.locator('[data-banner="retired"]')).toContainText('read-only');
    await expect(page.getByTestId('needs-you-empty')).toContainText('This event is closed.');
    await expect(activityLog(page).locator('[data-sequence]')).toHaveCount(27);
  });
});

test.describe('regressions', () => {
  // Fixed: the live/list divider (.ui-split-handle) once covered the dock resize handle where they
  // cross, so a drag starting there resized the split instead of the dock.
  test('the dock resize handle can be grabbed where the live/list divider meets it', async ({ page }) => {
    await openConsole(page, { preferences: { panes: { live: true, list: true } } });
    const handle = page.getByRole('separator', { name: 'Resize previews' });
    const split = page.getByRole('separator', { name: 'Resize live and list previews' });
    const splitBox = (await split.boundingBox())!;
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = splitBox.y + splitBox.height / 2;
    const hit = await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.getAttribute('aria-label'), [x, y]);
    expect(hit).toBe('Resize previews');
  });
});
