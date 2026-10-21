// Live preview canvas: Event and Match views, node and edge states, and the ways into the Match view.
// Each block runs a held scenario: the real demo script replayed quickly up to a step, then frozen.
import { expect, test, type Page } from '@playwright/test';
import { canvas, listPreviewToggle, livePreviewToggle, openConsole } from './support/console';
import { startDemo, type DemoProcess } from './support/demo';

test.use({ viewport: { width: 1440, height: 900 } });

const node = (page: Page, id: string) => canvas(page).locator(`[data-node="${id}"]`);
const viewButton = (page: Page, name: 'Event' | 'Match M1' | 'Match M2') =>
  page.getByRole('group', { name: 'Canvas view' }).getByRole('button', { name, exact: true });

async function expectRing(page: Page, id: string, kind: 'live' | 'waiting' | null): Promise<void> {
  const rings = node(page, id).locator('svg.tcg-flow-ring');
  if (kind === null) await expect(rings).toHaveCount(0);
  else await expect(node(page, id).locator(`svg.tcg-flow-ring.is-${kind}`)).toHaveCount(1);
}

test.describe('judge called on M1, M2 running (script step 19)', () => {
  let demo: DemoProcess;
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 19 } }); });
  test.afterAll(async () => { await demo?.kill(); });

  test('Event view: done stages, a slow red judge ring, a clay live ring and flowing edges', async ({ page }) => {
    await openConsole(page, { origin: demo.origin, token: demo.token });
    await expect(canvas(page)).toHaveAttribute('data-view', 'event');
    await expect(viewButton(page, 'Event')).toHaveAttribute('aria-pressed', 'true');

    for (const stage of ['signup', 'checkin']) {
      await expect(node(page, stage)).toHaveAttribute('data-state', 'done');
      await expectRing(page, stage, null);
    }
    await expect(node(page, 'M1')).toHaveAttribute('data-state', 'waiting');
    await expectRing(page, 'M1', 'waiting');
    await expect(node(page, 'M1')).toContainText('Needs judge');
    await expect(node(page, 'M1')).toHaveAttribute('aria-label', /judge/i);
    await expect(node(page, 'M2')).toHaveAttribute('data-state', 'live');
    await expectRing(page, 'M2', 'live');
    await expect(node(page, 'standings')).toHaveAttribute('data-state', 'pending');

    // Edges: green done edges, a red waiting edge into M1 and a clay active edge (with a traveling dot) into M2.
    await expect(canvas(page).locator('path.tcg-flow-edge.is-done').first()).toBeAttached();
    await expect(canvas(page).locator('path.tcg-flow-edge.is-waiting')).not.toHaveCount(0);
    await expect(canvas(page).locator('path.tcg-flow-edge.is-active')).not.toHaveCount(0);
    await expect(canvas(page).locator('g.tcg-flow-traveler')).not.toHaveCount(0);
    await expect(canvas(page)).not.toHaveAttribute('data-reduced-motion', /.*/);

    // Motion: the judge ring and the judge edge move slowly; live ones quickly; done edges are static.
    const animation = (selector: string) => canvas(page).locator(selector).first()
      .evaluate(element => { const style = getComputedStyle(element); return `${style.animationName} ${style.animationDuration}`; });
    expect(await animation('[data-node="M1"] .tcg-flow-ring-head')).toMatch(/ 6s$/);
    expect(await animation('[data-node="M2"] .tcg-flow-ring-head')).toMatch(/ 2\.2s$/);
    expect(await animation('path.tcg-flow-edge.is-waiting')).toMatch(/ 2\.4s$/);
    expect(await animation('path.tcg-flow-edge.is-active')).toMatch(/ 0\.9s$/);
    expect(await animation('path.tcg-flow-edge.is-done')).toMatch(/^none /);

    // Clocks and counts use tabular numbers.
    expect(await canvas(page).getByTestId('clock-M2').evaluate(element => getComputedStyle(element).fontVariantNumeric)).toContain('tabular-nums');

    // The running clock ticks; the paused one is frozen.
    await expect(canvas(page).getByTestId('clock-M2')).toHaveAttribute('data-clock-state', 'running');
    await expect(canvas(page).getByTestId('clock-M1')).toHaveAttribute('data-clock-state', 'frozen');
    const shown = await canvas(page).getByTestId('clock-M2').textContent();
    await expect(canvas(page).getByTestId('clock-M2')).not.toHaveText(shown ?? '', { timeout: 5_000 });
  });

  test('the view switcher shows each match lifecycle and back', async ({ page }) => {
    await openConsole(page, { origin: demo.origin, token: demo.token });
    await viewButton(page, 'Match M1').click();
    await expect(canvas(page)).toHaveAttribute('data-view', 'match');
    await expect(canvas(page)).toHaveAttribute('data-match', 'M1');
    await expect(viewButton(page, 'Match M1')).toHaveAttribute('aria-pressed', 'true');
    await expect(node(page, 'judge')).toHaveAttribute('data-state', 'waiting');
    await expectRing(page, 'judge', 'waiting');
    await expect(node(page, 'paused')).toHaveAttribute('data-state', 'current');
    await expect(node(page, 'final')).toHaveAttribute('data-state', 'pending');
    await expect(canvas(page).locator('.tcg-flow-edge-label.is-waiting')).toContainText(['called']);

    await viewButton(page, 'Match M2').click();
    await expect(canvas(page)).toHaveAttribute('data-match', 'M2');
    await expect(node(page, 'running')).toHaveAttribute('data-state', 'live');
    await expectRing(page, 'running', 'live');
    await expect(canvas(page).locator('g.tcg-flow-traveler')).toHaveCount(1);

    await viewButton(page, 'Event').click();
    await expect(canvas(page)).toHaveAttribute('data-view', 'event');
    // Clicking a match node in the Event view opens its lifecycle too, and Enter does from the keyboard.
    await node(page, 'M2').click();
    await expect(canvas(page)).toHaveAttribute('data-match', 'M2');
    await viewButton(page, 'Event').click();
    await node(page, 'M1').focus();
    await page.keyboard.press('Enter');
    await expect(canvas(page)).toHaveAttribute('data-match', 'M1');
    await expect(viewButton(page, 'Match M1')).toBeFocused();
  });

  test('"Open in live preview" on a needs-you card opens the Match view, even with the pane closed', async ({ page }) => {
    await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: false, list: false } } });
    const card = page.locator('li[data-match="M1"]');
    await expect(card).toContainText('M1 needs a judge');
    await expect(card).toContainText('Judge called');
    await expect(card).toContainText(/Ben Ortiz/);
    await expect(page.getByTestId('live-pane')).toHaveCount(0);

    await card.getByRole('button', { name: 'Open M1 in live preview' }).click();
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas(page)).toHaveAttribute('data-view', 'match');
    await expect(canvas(page)).toHaveAttribute('data-match', 'M1');
    await expect(node(page, 'judge')).toHaveAttribute('data-state', 'waiting');
  });

  test('a match row in the Matches list opens it in the Match view (click and Enter)', async ({ page }) => {
    await openConsole(page, { origin: demo.origin, token: demo.token,
      preferences: { panes: { live: false, list: true }, listTab: 'matches' } });
    const table = page.getByRole('table', { name: /^Matches/ });
    const row = (id: string) => table.getByRole('row').filter({ hasText: id }).filter({ has: page.getByRole('cell') });
    await expect(row('M1')).toBeVisible();

    await row('M2').click();
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(listPreviewToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas(page)).toHaveAttribute('data-match', 'M2');

    await viewButton(page, 'Event').click();
    await row('M1').focus();
    await page.keyboard.press('Enter');
    await expect(canvas(page)).toHaveAttribute('data-view', 'match');
    await expect(canvas(page)).toHaveAttribute('data-match', 'M1');
  });
});

test.describe('Event view fits its pane (script step 19)', () => {
  let demo: DemoProcess;
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 19 } }); });
  test.afterAll(async () => { await demo?.kill(); });

  /** Nodes that are not fully inside the canvas, or that sit under its view switcher or legend. */
  async function hiddenNodes(page: Page): Promise<string[]> {
    return canvas(page).evaluate(root => {
      const box = root.getBoundingClientRect();
      const panels = [...root.querySelectorAll('.react-flow__panel')].map(panel => panel.getBoundingClientRect());
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return [...root.querySelectorAll<HTMLElement>('.react-flow__node')].filter(node => {
        const rect = node.getBoundingClientRect();
        const inside = rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
        return !inside || panels.some(panel => overlaps(rect, panel));
      }).map(node => node.querySelector('[data-node]')?.getAttribute('data-node') ?? '?');
    });
  }

  test('live pane alone at 1440 px: every node is visible', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: true, list: false } } });
    await expect(node(page, 'M2')).toHaveAttribute('data-state', 'live');
    await expect.poll(() => hiddenNodes(page)).toEqual([]);
  });

  const shortPanes = [['both panes at 1440x900', 1440, 900], ['the sheet at 1000x800', 1000, 800]] as const;

  async function openShortPane(page: Page, width: number, height: number): Promise<void> {
    await page.setViewportSize({ width, height });
    await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: true, list: true } } });
    if (width < 1100) {
      await livePreviewToggle(page).click();
      await expect(page.getByRole('dialog', { name: 'Previews' })).toBeVisible();
    }
    await expect(node(page, 'M2')).toHaveAttribute('data-state', 'live');
  }

  for (const [name, width, height] of shortPanes) {
    test(`${name}: Fit view shows every node`, async ({ page }) => {
      await openShortPane(page, width, height);
      await canvas(page).getByRole('button', { name: 'Fit view' }).click();
      await expect.poll(() => hiddenNodes(page)).toEqual([]);
    });

    // Regression: the first automatic fit once clipped stage nodes in short panes (outside the pane or
    // under the view switcher and legend) until Fit view was pressed. The canvas now picks a compact
    // layout there and fits it whole, clear of the overlays.
    test(`${name}: the first automatic fit shows every node`, async ({ page }) => {
      await openShortPane(page, width, height);
      await expect.poll(() => hiddenNodes(page), { timeout: 5_000 }).toEqual([]);
    });
  }
});

test.describe('M2 resolved by the judge after a dispute (script step 25)', () => {
  let demo: DemoProcess;
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 25 } }); });
  test.afterAll(async () => { await demo?.kill(); });

  test('final match: static green node, winner by judge, done edges and no ring', async ({ page }) => {
    await openConsole(page, { origin: demo.origin, token: demo.token });
    await expect(node(page, 'M2')).toHaveAttribute('data-state', 'done');
    await expectRing(page, 'M2', null);
    await expect(node(page, 'M2')).toContainText('Final');
    await expect(node(page, 'M2')).toContainText('winner · judge');
    await expect(canvas(page).locator('.tcg-flow-edge-label.is-done')).toContainText(['D won']);
    await expect(page.locator('li[data-match="M2"]')).toHaveCount(0);
    // M1 runs again after the judge resumed it, but keeps judge attention until a result: "play resumed".
    await expect(page.locator('li[data-match="M1"]')).toContainText('M1 · play resumed');
    await expect(node(page, 'M1')).toHaveAttribute('data-state', 'waiting');

    await viewButton(page, 'Match M2').click();
    for (const step of ['ready', 'running', 'proposal', 'dispute', 'judge', 'final']) {
      await expect(node(page, step), step).toHaveAttribute('data-state', 'done');
    }
    await expect(node(page, 'confirm')).toHaveAttribute('data-state', 'muted');
    await expect(node(page, 'final')).toContainText('D won · judge');
    await expect(canvas(page).locator('svg.tcg-flow-ring')).toHaveCount(0);
    await expect(canvas(page).locator('g.tcg-flow-traveler')).toHaveCount(0);
  });
});

test.describe('event complete (script step 28)', () => {
  let demo: DemoProcess;
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 28, durationMs: 3_000 } }); });
  test.afterAll(async () => { await demo?.kill(); });

  test('standings reached: every stage done, no ring and no flowing edge', async ({ page }) => {
    await openConsole(page, { origin: demo.origin, token: demo.token });
    await expect(page.locator('.console-step[data-step="complete"]')).toContainText('Final', { timeout: 20_000 });
    for (const id of ['signup', 'checkin', 'M1', 'M2', 'standings']) {
      await expect(node(page, id), id).toHaveAttribute('data-state', 'done');
    }
    await expect(canvas(page).locator('svg.tcg-flow-ring')).toHaveCount(0);
    await expect(canvas(page).locator('path.tcg-flow-edge.is-active, path.tcg-flow-edge.is-waiting')).toHaveCount(0);
    await expect(page.getByTestId('needs-you-empty')).toBeVisible();
  });
});
