// The UI after the state moves under an open dialog: through the stream (another tab, a player step), the
// dialog shows what changed and asks for a review before it sends anything; without the stream, the server's
// 409 snapshot goes into the cache and the console shows the fresh state without a reload.
import { expect, test, type Page } from '@playwright/test';
import {
  activeSnapshot, answerUntilJudgeResume, expectToast, mainConsole, matchOf, newCommandId, postCommand, waitForHold, waitForPause
} from './support/commands';
import { apiLogin, openConsole, SESSION_TOKEN_KEY } from './support/console';
import { startDemo, type DemoProcess } from './support/demo';

test.use({ viewport: { width: 1440, height: 900 } });

const matchRow = (page: Page, id: string) =>
  page.getByTestId('list-pane').getByRole('table', { name: /^Matches/ }).locator('tbody tr').filter({ hasText: id });

/** Records the command POSTs a page sends and the statuses they get. */
function recordCommands(page: Page): Array<{ body: any; status?: number }> {
  const seen: Array<{ body: any; status?: number }> = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/commands')) seen.push({ body: request.postDataJSON() });
  });
  page.on('response', response => {
    if (response.request().method() === 'POST' && response.url().endsWith('/api/v1/commands')) {
      const entry = seen.find(item => item.status === undefined);
      if (entry) entry.status = response.status();
    }
  });
  return seen;
}

test.describe('a held event (script step 24: M2 disputed, M1 running)', () => {
  test.describe.configure({ mode: 'serial' });
  let demo: DemoProcess;
  let bearer: string;
  test.beforeAll(async () => {
    demo = await startDemo({ scenario: { steps: 24 } });
    await waitForHold(demo, 24);
    bearer = await apiLogin(demo.origin, demo.token);
  });
  test.afterAll(async () => { await demo?.kill(); });

  test('two tabs: a resolution in one shows up under the other tab\'s open dialog, which then sends nothing', async ({ browser }) => {
    const prefs = { panes: { live: false, list: true }, listTab: 'matches' };
    const first = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const second = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const firstPosts = recordCommands(first);
      await openConsole(first, { origin: demo.origin, token: demo.token, preferences: prefs });
      await openConsole(second, { origin: demo.origin, token: demo.token, preferences: prefs });

      await mainConsole(first).getByRole('button', { name: 'Resolve M2' }).click();
      const stale = first.getByRole('dialog', { name: 'Resolve M2' });
      await stale.getByRole('radio', { name: /Seat C · Cy Park/ }).check();
      await stale.getByRole('textbox', { name: /Reason/ }).fill('C had lethal on board.');

      await mainConsole(second).getByRole('button', { name: 'Resolve M2' }).click();
      const winner = second.getByRole('dialog', { name: 'Resolve M2' });
      await winner.getByRole('radio', { name: /Seat D · Dee Ross/ }).check();
      await winner.getByRole('textbox', { name: /Reason/ }).fill('Judge ruling after review.');
      await winner.getByRole('button', { name: 'Resolve match' }).click();
      await expectToast(second, 'M2 resolved: Seat D · Dee Ross wins');

      // The first tab learns it from the stream, inside the open dialog.
      await expect(stale.getByTestId('changed-notice')).toContainText('M2 changed since you opened this. Now:');
      await expect(stale.getByTestId('changed-notice')).toContainText('Phase final');
      await expect(stale.getByTestId('changed-notice')).toContainText('Recorded winner: Seat D · Dee Ross');
      await expect(stale).toContainText('This action is no longer available: M2 is final now.');
      await expect(stale.getByRole('button', { name: 'Resolve match' })).toBeDisabled();
      await stale.getByRole('textbox', { name: /Reason/ }).press('Control+Enter');
      await stale.getByRole('button', { name: 'Cancel' }).click();
      await expect(stale).toHaveCount(0);
      await expect(matchRow(first, 'M2')).toContainText('Dee Ross');
      await expect(mainConsole(first).getByRole('button', { name: 'Resolve M2' })).toHaveCount(0);
      expect(firstPosts).toEqual([]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('no stream: an API command races the dialog; the 409 snapshot shows the fresh state without a reload', async ({ page }) => {
    // This tab never gets a stream, so its cache only learns about the API's resolution from the 409.
    await page.route('**/api/v1/stream', route => route.abort());
    const posts = recordCommands(page);
    const tabBearer = await apiLogin(demo.origin, demo.token);
    await page.addInitScript(({ key, value }) => { window.sessionStorage.setItem(key, value); }, { key: SESSION_TOKEN_KEY, value: tabBearer });
    await page.addInitScript(() => {
      window.localStorage.setItem('tcg-admin.prefs.v1', JSON.stringify({ panes: { live: false, list: true }, listTab: 'matches' }));
    });
    await page.goto(`${demo.origin}/`);
    await expect(page.getByRole('heading', { name: /Needs you/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.shell-stream')).not.toHaveAttribute('data-state', 'live');
    await expect(matchRow(page, 'M1')).toBeVisible();

    await page.getByTestId('list-pane').getByRole('button', { name: 'Actions for M1' }).click();
    await page.getByRole('menu', { name: 'Actions for M1' }).getByRole('menuitem', { name: /Resolve/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Resolve M1' });
    await dialog.getByRole('radio', { name: /Seat A · Ava Chen/ }).check();
    await dialog.getByRole('textbox', { name: /Reason/ }).fill('Seat A was ahead when time was called.');

    const at = await activeSnapshot(demo.origin, bearer);
    const raced = await postCommand(demo.origin, bearer, { commandId: newCommandId(), eventId: at.eventId,
      command: { type: 'resolve', matchId: 'M1', winner: 'B', reason: 'Resolved over the API first.' }, precondition: matchOf(at, 'M1') });
    expect(raced.status).toBe(200);

    await dialog.getByRole('button', { name: 'Resolve match' }).click();
    await expect(dialog).toContainText('M1 changed while you were deciding. M1 is final now (it was running).');
    await expect(dialog.getByTestId('changed-notice')).toContainText('Recorded winner: Seat B · Ben Ortiz');
    await expect(dialog).toContainText('This action is no longer available: M1 is final now.');
    expect(posts).toEqual([expect.objectContaining({ status: 409 })]);
    expect(posts[0]!.body).toMatchObject({ command: { type: 'resolve', matchId: 'M1', winner: 'A' }, precondition: { match: { matchId: 'M1', phase: 'running' } } });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // The rest of the console shows the 409's snapshot: M1 final for Ben Ortiz, still without a stream.
    await expect(matchRow(page, 'M1')).toContainText('Ben Ortiz');
    await expect(page.locator('.shell-stream')).not.toHaveAttribute('data-state', 'live');
    expect(posts).toHaveLength(1);
  });
});

test.describe('interactive: a player step under an open dialog', () => {
  let demo: DemoProcess;
  let bearer: string;
  test.beforeAll(async () => {
    demo = await startDemo({ scenario: { steps: 28, mode: 'interactive' } });
    bearer = await apiLogin(demo.origin, demo.token);
  });
  test.afterAll(async () => { await demo?.kill(); });

  test('"Review the change" adopts the new proposal; Enter only reviews; then the resolve sends the fresh precondition', async ({ page }) => {
    await answerUntilJudgeResume(demo, bearer);
    const posts = recordCommands(page);
    await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: false, list: true }, listTab: 'matches' } });
    await page.getByTestId('list-pane').getByRole('button', { name: 'Actions for M2' }).click();
    await page.getByRole('menu', { name: 'Actions for M2' }).getByRole('menuitem', { name: /Resolve/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Resolve M2' });
    await dialog.getByRole('radio', { name: /Seat D · Dee Ross/ }).check();
    const reason = dialog.getByRole('textbox', { name: /Reason/ });
    await reason.fill('Judge ruling after review.');
    await expect(dialog.getByRole('list', { name: 'Match details' }).first()).not.toContainText('reported');

    // The judge decision on M1 lands over the API; the script resumes and the M2 players report and dispute.
    const at = await activeSnapshot(demo.origin, bearer);
    expect((await postCommand(demo.origin, bearer, { commandId: newCommandId(), eventId: at.eventId,
      command: { type: 'judgeResume', matchId: 'M1', reason: 'Checked.' }, precondition: matchOf(at, 'M1') })).status).toBe(200);
    await waitForPause(demo, 'resolve', 'M2');

    await expect(dialog.getByTestId('changed-notice')).toContainText('M2 changed since you opened this. Now:');
    await expect(dialog.getByTestId('changed-notice')).toContainText(/reported Seat D won \(disputed, rev 2\)/);
    const review = dialog.getByRole('button', { name: 'Review the change' });
    await expect(review).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Resolve match' })).toHaveCount(0);
    await reason.press('Control+Enter');          // reviews, does not send
    await expect(dialog.getByTestId('changed-notice')).toHaveCount(0);
    await expect(dialog.getByRole('list', { name: 'Match details' })).toContainText(/reported Seat D won \(disputed, rev 2\)/);
    expect(posts).toEqual([]);
    await dialog.getByRole('button', { name: 'Resolve match' }).click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, 'M2 resolved: Seat D · Dee Ross wins');
    expect(posts).toEqual([expect.objectContaining({ status: 200 })]);
    expect(posts[0]!.body.precondition).toMatchObject({ match: { matchId: 'M2', proposalRevision: 2 } });
  });
});
