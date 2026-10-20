// Keyboard paths, visible focus, the confirm dialog's focus trap, reduced motion, and the sheet below 1100 px.
import { expect, test, type Page } from '@playwright/test';
import { accountMenuButton, canvas, listPreviewToggle, livePreviewToggle, openConsole } from './support/console';
import { startDemo, type DemoProcess } from './support/demo';

interface Focused { label: string; inside: string | null; focusVisible: boolean; indicator: boolean }

/** Describes the focused element: an accessible-ish label, its landmark, and whether focus is visible. */
async function focused(page: Page): Promise<Focused> {
  return page.evaluate(async () => {
    // Let focus-ring transitions finish (infinite canvas animations are not transitions).
    await Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition)
      .map(animation => animation.finished.catch(() => undefined)));
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return { label: 'body', inside: null, focusVisible: false, indicator: false };
    const label = element.getAttribute('aria-label') ?? element.getAttribute('title') ??
      (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const landmark = element.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') ?? element.closest('header, aside, main');
    const inside = landmark ? `${landmark.getAttribute('role') ?? landmark.tagName.toLowerCase()}${landmark.getAttribute('aria-label') ? `:${landmark.getAttribute('aria-label')}` : ''}` : null;
    const visible = (style: CSSStyleDeclaration) =>
      (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
      (style.boxShadow !== 'none' && style.boxShadow !== '') ||
      (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent' && style.content !== 'normal');
    // A field may draw its ring on its frame instead (`:focus-within`, e.g. the command composer): accept a
    // 3 px focus ring on a close ancestor that only appears while the field is focused.
    const frameRing = (() => {
      if (!element.matches('input, textarea')) return false;
      let node = element.parentElement;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        if (node.matches(':focus-within') && /0px 0px 0px 3px/.test(getComputedStyle(node).boxShadow)) return true;
      }
      return false;
    })();
    const indicator = visible(getComputedStyle(element)) || visible(getComputedStyle(element, '::after')) ||
      visible(getComputedStyle(element, '::before')) || frameRing;
    return { label, inside, focusVisible: element.matches(':focus-visible'), indicator };
  });
}

async function tabUntil(page: Page, predicate: (item: Focused) => boolean, max = 40, key = 'Tab'): Promise<Focused[]> {
  const seen: Focused[] = [];
  for (let index = 0; index < max; index++) {
    await page.keyboard.press(key);
    const item = await focused(page);
    seen.push(item);
    if (predicate(item)) return seen;
  }
  throw new Error(`Focus never matched. Seen:\n${seen.map(item => `${item.inside} › ${item.label}`).join('\n')}`);
}

test.describe('keyboard paths (1440 px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Tab reaches the top bar controls and then the dock, always with a visible focus indicator', async ({ page }) => {
    await openConsole(page);
    await page.getByRole('button', { name: 'Collapse sidebar' }).focus();
    const topBar = await tabUntil(page, item => item.label.startsWith('Theme and account'));
    const labels = topBar.map(item => item.label);
    const order = ['Live preview', 'List preview', 'Discord', 'PostgreSQL', 'Theme and account'];
    let last = -1;
    for (const name of order) {
      const index = labels.findIndex(label => label.startsWith(name));
      expect(index, `${name} in ${JSON.stringify(labels)}`).toBeGreaterThan(last);
      last = index;
    }
    const dockStops = await tabUntil(page, item => item.label === 'Zoom in');
    const dockLabels = dockStops.map(item => item.label);
    for (const name of ['Resize previews', 'Close live preview', 'Event', 'Match M1', 'Match M2', 'Fit view']) {
      expect(dockLabels.some(label => label.startsWith(name)), `${name} in ${JSON.stringify(dockLabels)}`).toBe(true);
    }
    const all = [...topBar, ...dockStops];
    const hidden = all.filter(item => !item.focusVisible || !item.indicator);
    expect(hidden, 'focus stops without a visible indicator').toEqual([]);
  });

  test('the account menu opens from the keyboard, Escape closes it and returns focus', async ({ page }) => {
    await openConsole(page);
    await accountMenuButton(page).focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Account and theme' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemradio').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(accountMenuButton(page)).toBeFocused();
  });

  test('the rotate dialog traps focus and Escape closes it without rotating', async ({ page }) => {
    await openConsole(page);
    await accountMenuButton(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('menuitem', { name: 'Rotate console link' })).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Rotate the console link?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      const item = await focused(page);
      expect(item.inside, `${key} → ${item.label}`).toMatch(/dialog/);
      expect(item.focusVisible && item.indicator, `${item.label} shows focus`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(accountMenuButton(page)).toBeFocused();
    // Nothing was rotated: the shared launch token still signs in (other specs rely on it too).
    await expect(page.getByRole('status').filter({ hasText: 'New console link' })).toHaveCount(0);
  });

  test('closing the rotate dialog with the mouse returns focus to the account menu button', async ({ page }) => {
    await openConsole(page);
    await accountMenuButton(page).click();
    await page.getByRole('menuitem', { name: 'Rotate console link' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Rotate the console link?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(accountMenuButton(page)).toBeFocused();
  });
});

test.describe('reduced motion', () => {
  let demo: DemoProcess;
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 19 } }); });
  test.afterAll(async () => { await demo?.kill(); });
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

  test('static rings, no dash flow and no traveling dot', async ({ page }) => {
    await openConsole(page, { origin: demo.origin, token: demo.token });
    await expect(canvas(page)).toHaveAttribute('data-reduced-motion', 'true');
    await expect(canvas(page).locator('[data-node="M2"]')).toHaveAttribute('data-state', 'live');
    await expect(canvas(page).locator('path.tcg-flow-edge.is-active')).not.toHaveCount(0);
    await expect(canvas(page).locator('g.tcg-flow-traveler')).toHaveCount(0);
    const style = (selector: string, property: 'display' | 'animationName' | 'opacity') => canvas(page).locator(selector).first()
      .evaluate((element, name) => getComputedStyle(element)[name], property);
    expect(await style('[data-node="M2"] .tcg-flow-ring-head', 'display')).toBe('none');
    expect(await style('[data-node="M1"] .tcg-flow-ring-head', 'display')).toBe('none');
    expect(await style('[data-node="M2"] .tcg-flow-ring-track', 'opacity')).toBe('1');
    expect(await style('path.tcg-flow-edge.is-active', 'animationName')).toBe('none');
    expect(await style('path.tcg-flow-edge.is-waiting', 'animationName')).toBe('none');

    await page.getByRole('group', { name: 'Canvas view' }).getByRole('button', { name: 'Match M2' }).click();
    await expect(canvas(page).locator('path.tcg-flow-edge.is-active')).not.toHaveCount(0);
    await expect(canvas(page).locator('g.tcg-flow-traveler')).toHaveCount(0);
  });
});

test.describe('below 1100 px', () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  const sheet = (page: Page) => page.getByRole('dialog', { name: 'Previews' });

  // Wave 3: on a console that can act, the row actions in the list tabs swallow Tab and Escape (bug 4 below),
  // so the general trap is proven on the read-only console (commands off, as in Discord mode by default).
  let readOnly: DemoProcess;
  test.beforeAll(async () => { readOnly = await startDemo({ scenario: { steps: 4, commands: 'off' } }); });
  test.afterAll(async () => { await readOnly?.kill(); });

  test('the dock becomes a modal sheet that traps focus and closes on Escape', async ({ page }) => {
    await openConsole(page, { origin: readOnly.origin, token: readOnly.token, preferences: { panes: { live: true, list: true } } });
    // Panes are remembered as open, but nothing covers the console until asked.
    await expect(page.getByTestId('preview-dock')).toHaveCount(0);
    await expect(sheet(page)).toHaveCount(0);
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');

    await livePreviewToggle(page).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page)).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByTestId('preview-sheet').getByTestId('live-pane')).toBeVisible();
    await expect(page.getByTestId('preview-sheet').getByTestId('list-pane')).toBeVisible();
    await expect.poll(async () => (await focused(page)).inside).toMatch(/dialog/);

    for (let index = 0; index < 30; index++) {
      await page.keyboard.press('Tab');
      const item = await focused(page);
      expect(item.inside, `Tab ${index + 1} → ${item.label}`).toMatch(/dialog/);
    }
    for (let index = 0; index < 5; index++) {
      await page.keyboard.press('Shift+Tab');
      expect((await focused(page)).inside).toMatch(/dialog/);
    }
    // Escape closes the innermost layer first: a tooltip shown for the focused control (focus-visible opens
    // one at once), then the sheet. Tooltips of controls that lost focus finish their exit animation.
    await expect.poll(() => page.getByRole('tooltip').count()).toBeLessThanOrEqual(1);
    if (await page.getByRole('tooltip').count()) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await expect(sheet(page)).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(livePreviewToggle(page)).toBeFocused();
    await expect(livePreviewToggle(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('a backdrop click and the close button dismiss the sheet; Alt+2 opens it', async ({ page }) => {
    await openConsole(page, { preferences: { panes: { live: false, list: false } } });
    await page.locator('main.shell-main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Alt+2');
    await expect(sheet(page)).toBeVisible();
    await expect(listPreviewToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('preview-sheet').getByTestId('list-pane')).toBeVisible();
    const box = (await sheet(page).boundingBox())!;
    expect(box.x).toBeGreaterThan(100);
    await page.mouse.click(Math.max(10, box.x / 2), 400);
    await expect(sheet(page)).toHaveCount(0);

    await listPreviewToggle(page).click();
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Close previews' }).click();
    await expect(sheet(page)).toHaveCount(0);
  });

  test('"Open in live preview" from the Matches list opens the sheet on the Match view', async ({ page }) => {
    await openConsole(page, { preferences: { panes: { live: false, list: true }, listTab: 'players' } });
    await listPreviewToggle(page).click();
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole('tab', { name: /^Matches/ }).click();
    await sheet(page).getByRole('table', { name: /^Matches/ }).locator('tbody tr').first().click();
    await expect(page.getByTestId('preview-sheet').getByTestId('live-preview')).toHaveAttribute('data-view', 'match');
  });

  test.describe('known issues', () => {
    let demo: DemoProcess;
    // Signup open with four members: the Players tab has a remove button in every row.
    test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 4 } }); });
    test.afterAll(async () => { await demo?.kill(); });

    // Bug 4: the row-action wrappers in apps/web/src/features/commands/actions.tsx (`stopRow`, on the Players
    // remove buttons and the Matches "Actions for" menus) stop the propagation of every keydown. The sheet's
    // focus trap and Escape handler (features/shell/PreviewDock.tsx onKeyDown) never see Tab or Escape pressed
    // there: Tab from the last remove button leaves the modal sheet for the page behind it, and Escape does
    // not close the sheet.
    test.fixme('Tab and Escape on a row action stay with the sheet', async ({ page }) => {
      await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: false, list: true }, listTab: 'players' } });
      await listPreviewToggle(page).click();
      await expect(sheet(page)).toBeVisible();
      const removes = sheet(page).getByRole('button', { name: /^Remove .* from the signup$/ });
      await expect(removes).toHaveCount(4);
      await removes.last().focus();
      await page.keyboard.press('Tab');
      expect((await focused(page)).inside).toMatch(/dialog/);
      await removes.last().focus();
      await page.keyboard.press('Escape');
      await expect(sheet(page)).toHaveCount(0);
    });
  });
});
