// Wave 3 admin actions through the real UI, on the interactive demo: the scenario's players act on their
// own and the script pauses at each admin decision (DemoAdminRuntime.pausedAt) until the console's command
// lands. Every test checks three things: the stream's `change` updates the UI in the same document (no
// reload), the activity stream shows the admin acting via the console (audit `via: 'web'`), and the
// scenario resumes from its pause.
//
// One serial walkthrough of the full demo script (remove → close → publish → judge-resume → resolve →
// expiry resolve → correct → restart), plus a short scenario for signup close and reopen.
import { expect, test, type Page } from '@playwright/test';
import {
  activeSnapshot, answerUntilJudgeResume, composer, dismissToasts, eventActions, eventAudit, expectConsoleActivity, expectToast, mainConsole, stageStep,
  suggestions, waitForPause
} from './support/commands';
import { apiLogin, canvas, openConsole } from './support/console';
import { startDemo, type DemoProcess } from './support/demo';

test.use({ viewport: { width: 1440, height: 900 } });

const listTab = (page: Page, name: RegExp) => page.getByRole('tablist', { name: 'List views' }).getByRole('tab', { name });
const listPanel = (page: Page) => page.getByTestId('list-pane').getByRole('tabpanel');
const crumb = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' }).locator('[aria-current="page"]');

/** Marks the document; `sameDocument` proves no reload happened since. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { e2eDoc?: string }).e2eDoc = 'same'; });
}
async function expectSameDocument(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { e2eDoc?: string }).e2eDoc)).toBe('same');
}

/** The newest audit entry of the active event, via the API. */
async function lastAdminEntry(demo: DemoProcess, bearer: string) {
  const snapshot = await activeSnapshot(demo.origin, bearer);
  const audit = await eventAudit(demo.origin, bearer, snapshot.eventId);
  return audit.filter(entry => entry.actor.kind === 'admin').at(-1)!;
}

test.describe('interactive demo: the whole script answered from the console', () => {
  test.describe.configure({ mode: 'serial' });
  let demo: DemoProcess;
  let bearer: string;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // 20 s matches: M1 expires a little after M2's resolution; 1.5 s from the final correction to the restart.
    demo = await startDemo({ scenario: { steps: 28, mode: 'interactive', durationMs: 20_000, endWaitMs: 1_500, finalHoldMs: 120_000 } });
    bearer = await apiLogin(demo.origin, demo.token);
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await openConsole(page, { origin: demo.origin, token: demo.token,
      preferences: { panes: { live: true, list: true }, listTab: 'players' } });
    await markDocument(page);
  });
  test.afterAll(async () => {
    await page?.close();
    await demo?.kill();
  });

  test('signup remove: the Players row action confirms, the roster updates live, the script resumes', async () => {
    const pause = await waitForPause(demo, 'signupRemove', null);
    expect(pause.step).toBe(4);
    const players = listPanel(page);
    await expect(players).toContainText('Eli Moss');
    const remove = players.getByRole('button', { name: 'Remove Eli Moss from the signup' });

    // Escape (the escape layer) closes the confirmation without removing anyone; focus returns to the row action.
    await remove.click();
    const confirm = page.getByRole('alertdialog', { name: 'Remove Eli Moss from the signup?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('4 of 4 joined now');
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(remove).toBeFocused();
    expect((await demo.state()).pausedAt?.decision).toBe('signupRemove');

    await remove.click();
    await confirm.getByRole('button', { name: 'Remove' }).click();
    await expect(confirm).toHaveCount(0);
    await expectToast(page, 'Removed Eli Moss from the signup');
    await expectConsoleActivity(page, 'Removed Eli Moss from signup');
    // The scenario resumes: Dee Ross joins on her own and the script waits for the close.
    await waitForPause(demo, 'signupClose', null);
    await expect(players).toContainText('Dee Ross');
    await expect(players).not.toContainText('Eli Moss');
    const entry = await lastAdminEntry(demo, bearer);
    expect(entry).toMatchObject({ via: 'web', principalId: 'local-admin', command: { type: 'signupRemove', memberId: '910000000000000015' } });
    expect(entry.commandId).toMatch(/^web:[0-9a-f-]{36}$/);
    await expectSameDocument(page);
    await dismissToasts(page);
  });

  test('panel refresh: the stepper button repairs the cards and the panel revision moves live; no decision is answered', async () => {
    const before = await activeSnapshot(demo.origin, bearer);
    await listTab(page, /Discord/).click();
    const revision = listPanel(page).locator('span[title^="Process-local"]');
    await expect(revision).toHaveText(String(before.panelRevision));
    await eventActions(page).getByRole('button', { name: 'Refresh panels' }).click();
    await expectToast(page, 'Discord panels refreshed');
    await expect(revision).toHaveText(String(before.panelRevision + 1));
    // A panel refresh is not a domain command: no audit entry, and the script still waits for the close.
    const after = await activeSnapshot(demo.origin, bearer);
    expect(after.version).toBe(before.version);
    expect((await demo.state()).pausedAt?.decision).toBe('signupClose');
    await expectSameDocument(page);
    await dismissToasts(page);
    await listTab(page, /^Players/).click();
  });

  test('signup close: the stepper button assigns seats, the stage moves to check-in, the players check in', async () => {
    await eventActions(page).getByRole('button', { name: 'Close signup' }).click();
    await expectToast(page, 'Signup closed and seats assigned');
    await expect(stageStep(page, 'checkin')).toHaveAttribute('aria-current', 'step');
    await expect(crumb(page)).toHaveText('Check-in');
    await expectConsoleActivity(page, 'Closed signup and assigned seats');
    await waitForPause(demo, 'publish', null);
    await expect(listPanel(page)).toContainText('4 seated · 4 checked in');
    expect((await lastAdminEntry(demo, bearer)).via).toBe('web');
    await expectSameDocument(page);
    await dismissToasts(page);
  });

  test('publish: from the composer, keyboard only (suggestion, then Enter runs it)', async () => {
    await composer(page).focus();
    await page.keyboard.type('/pub');
    await expect(suggestions(page).getByRole('option')).toHaveText([/\/publish/]);
    await page.keyboard.press('Enter');            // accepts the suggestion
    await expect(composer(page)).toHaveValue('/publish ');
    await page.keyboard.press('Enter');            // runs it
    await expect(composer(page)).toHaveValue('');
    await expectToast(page, 'Round published');
    await expect(stageStep(page, 'live')).toHaveAttribute('aria-current', 'step');
    await expectConsoleActivity(page, 'Published the round');
    // The players get ready, A pauses M1, B calls a judge: the script waits for a judge decision on M1.
    await waitForPause(demo, 'judgeResume', 'M1');
    await expect(canvas(page).locator('[data-node="M1"]')).toHaveAttribute('data-state', 'waiting');
    await expectSameDocument(page);
    await dismissToasts(page);
  });

  test('judge-resume: the needs-you card opens the reason dialog; the reason is required; Ctrl+Enter confirms', async () => {
    const card = mainConsole(page).getByRole('button', { name: 'Resume play M1' });
    await card.click();
    const dialog = page.getByRole('dialog', { name: 'Resume M1 by judge override' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'Match details' })).toContainText('Phase paused');
    await expect(dialog.getByRole('list', { name: 'Match details' })).toContainText('judge called');
    await dialog.getByRole('button', { name: 'Resume play' }).click();
    await expect(dialog).toContainText('Enter a reason. It is stored in the audit log.');
    const reason = dialog.getByRole('textbox', { name: /Reason/ });
    await reason.fill('Judge checked the board state.');
    await expect(dialog).toContainText('30 / 500');
    await reason.press('Control+Enter');
    await expect(dialog).toHaveCount(0);
    await expectToast(page, 'M1 resumed by judge override');
    await expectConsoleActivity(page, /Resumed M1.*Judge checked the board state\./);
    // The clock runs again; the judge call stays on record, so the node keeps its judge ring ("play resumed").
    await expect(canvas(page).getByTestId('clock-M1')).toHaveAttribute('data-clock-state', 'running');
    await expect(canvas(page).locator('[data-node="M1"]')).toHaveAttribute('aria-label', /^M1, running/);
    // C proposes, D disputes, D proposes, C disputes: M2 needs a judge's ruling.
    await waitForPause(demo, 'resolve', 'M2');
    const entry = await lastAdminEntry(demo, bearer);
    expect(entry).toMatchObject({ via: 'web', command: { type: 'judgeResume', matchId: 'M1', reason: 'Judge checked the board state.' } });
    await expectSameDocument(page);
    await dismissToasts(page);
  });

  test('resolve: the Matches row menu opens the dialog; winner and the 500-character limit are enforced', async () => {
    await listTab(page, /^Matches/).click();
    await listPanel(page).getByRole('button', { name: 'Actions for M2' }).click();
    const menu = page.getByRole('menu', { name: 'Actions for M2' });
    await expect(menu.getByRole('menuitem')).toHaveText([/Resolve/]);
    await menu.getByRole('menuitem', { name: /Resolve/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Resolve M2' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'Match details' })).toContainText('result disputed');

    await dialog.getByRole('button', { name: 'Resolve match' }).click();
    await expect(dialog).toContainText('Pick the winning seat.');
    await dialog.getByRole('radio', { name: /Seat D · Dee Ross/ }).check();
    const reason = dialog.getByRole('textbox', { name: /Reason/ });
    await reason.fill(`  ${'x'.repeat(501)}  `);
    await expect(dialog).toContainText('501 / 500');
    await dialog.getByRole('button', { name: 'Resolve match' }).click();
    await expect(dialog).toContainText('Keep the reason to 500 characters (it has 501).');
    expect((await demo.state()).pausedAt).toMatchObject({ decision: 'resolve', matchId: 'M2' });
    await reason.fill('Judge ruling after review.');
    await dialog.getByRole('button', { name: 'Resolve match' }).click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, 'M2 resolved: Seat D · Dee Ross wins');
    await expectConsoleActivity(page, /Resolved M2 for Seat D.*Judge ruling after review\./);
    const row = listPanel(page).getByRole('table', { name: /^Matches/ }).locator('tbody tr').filter({ hasText: 'M2' });
    await expect(row).toContainText('Dee Ross');
    // M1's clock runs out (20 s matches): the expiry is applied by the timer and waits for a ruling.
    await waitForPause(demo, 'resolve', 'M1', 40_000);
    await expect(canvas(page).locator('[data-node="M1"]')).toHaveAttribute('data-state', 'waiting');
    await expect(mainConsole(page)).toContainText('clock expired');
    await expectSameDocument(page);
    await dismissToasts(page);
  });

  test('resolve: a complete composer line runs at once (named match, seat mention, reason last)', async () => {
    await composer(page).fill('/resolve M1 @A Clock ran out; Seat A was ahead on prizes.');
    await composer(page).press('Enter');
    await expect(composer(page)).toHaveValue('');
    await expectToast(page, 'M1 resolved: Seat A · Ava Chen wins');
    await expectConsoleActivity(page, /Resolved M1 for Seat A.*Clock ran out/);
    await expect(stageStep(page, 'complete')).toHaveClass(/is-done/);
    await expect(crumb(page)).toHaveText('Standings');
    // The finished event is held so a result can still be corrected.
    await waitForPause(demo, 'correct', null);
    await expectSameDocument(page);
    await dismissToasts(page);
  });

  test('correct: danger dialog with an explicit acknowledgement; afterwards the demo retires the event and starts over', async () => {
    const before = await activeSnapshot(demo.origin, bearer);
    await listPanel(page).getByRole('button', { name: 'Actions for M2' }).click();
    const item = page.getByRole('menu', { name: 'Actions for M2' }).getByRole('menuitem', { name: /Correct result/ });
    await expect(item).toHaveClass(/danger/);
    await item.click();
    const dialog = page.getByRole('alertdialog', { name: "Correct M2's result" });
    await expect(dialog).toBeVisible();
    // The recorded winner cannot be chosen again.
    await expect(dialog.getByRole('radio', { name: /Seat D · Dee Ross/ })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Correct result' })).toHaveClass(/danger/);
    await dialog.getByRole('radio', { name: /Seat C · Cy Park/ }).check();
    await dialog.getByRole('textbox', { name: /Reason/ }).fill('The score sheet shows Seat C won.');
    await dialog.getByRole('button', { name: 'Correct result' }).click();
    await expect(dialog).toContainText('Confirm that you mean to change a final result.');
    expect((await demo.state()).pausedAt?.decision).toBe('correct');
    await dialog.getByRole('checkbox', { name: /replaces the recorded result of M2/ }).check();
    await dialog.getByRole('button', { name: 'Correct result' }).click();
    await expect(dialog).toHaveCount(0);
    await expectToast(page, 'M2 corrected: Seat C · Cy Park wins');
    const entry = await lastAdminEntry(demo, bearer);
    expect(entry).toMatchObject({ via: 'web', command: { type: 'correct', matchId: 'M2', winner: 'C' } });

    // The scenario resumes: 1.5 s later it retires the event and a fresh one starts (and pauses again).
    await expect.poll(async () => (await demo.state()).cycles, { timeout: 15_000 }).toBe(1);
    const history = page.getByRole('navigation', { name: 'Event history' });
    await expect(history.getByRole('button')).toHaveCount(1, { timeout: 15_000 });
    await expect(crumb(page)).toHaveText('Signup');
    await waitForPause(demo, 'signupRemove', null);
    expect((await activeSnapshot(demo.origin, bearer)).eventId).not.toBe(before.eventId);

    // The retired event keeps the correction in its history; the console offers no stepper actions or
    // composer there. (Its list tabs are covered by "regressions: retired history" below.)
    await history.getByRole('button').click();
    await expect(crumb(page)).toHaveText('History');
    await expect(mainConsole(page)).toContainText('Corrected M2 to Seat C');
    await expect(eventActions(page)).toHaveCount(0);
    await expect(composer(page)).toHaveCount(0);
    await expectSameDocument(page);
  });
});

test.describe('interactive demo: signup close and reopen', () => {
  let demo: DemoProcess;
  // Joins, Eli's removal, Dee's join, the close; then the event is held.
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 7, mode: 'interactive' } }); });
  test.afterAll(async () => { await demo?.kill(); });

  test('remove by mention from the composer, close, reopen, and close again with the /tcg-test prefix', async ({ page }) => {
    await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: false, list: true }, listTab: 'players' } });
    await markDocument(page);
    await waitForPause(demo, 'signupRemove', null);

    // A removal always confirms, also from the composer.
    // The trailing space finishes the mention; with the member list open, Enter would accept a suggestion.
    await composer(page).fill('/signup-remove @Eli_Moss ');
    await composer(page).press('Enter');
    const confirm = page.getByRole('alertdialog', { name: 'Remove Eli Moss from the signup?' });
    await confirm.getByRole('button', { name: 'Remove' }).click();
    await expectToast(page, 'Removed Eli Moss from the signup');
    await expect(composer(page)).toHaveValue('');
    await waitForPause(demo, 'signupClose', null);

    await eventActions(page).getByRole('button', { name: 'Close signup' }).click();
    await expectToast(page, 'Signup closed and seats assigned');
    await expect(stageStep(page, 'checkin')).toHaveAttribute('aria-current', 'step');
    await expect.poll(async () => (await demo.state()).pausedAt).toBeNull();
    await dismissToasts(page);

    // Reopen: back to signup with the same four members, check-ins cleared.
    await eventActions(page).getByRole('button', { name: 'Reopen signup' }).click();
    await expectToast(page, 'Signup reopened');
    await expect(stageStep(page, 'signup')).toHaveAttribute('aria-current', 'step');
    await expectConsoleActivity(page, 'Reopened signup');
    await expect(listPanel(page).getByRole('button', { name: /^Remove .* from the signup$/ })).toHaveCount(4);
    await expect(eventActions(page).getByRole('button', { name: 'Reopen signup' })).toHaveCount(0);
    await dismissToasts(page);

    await composer(page).fill('/tcg-test signup-close');
    await composer(page).press('Enter');
    await expectToast(page, 'Signup closed and seats assigned');
    await expect(stageStep(page, 'checkin')).toHaveAttribute('aria-current', 'step');
    await expectConsoleActivity(page, 'Closed signup and assigned seats');
    await expectSameDocument(page);
  });
});

test.describe('interactive demo: recovery and clocks while paused', () => {
  test('removing instead of closing: the script waits for the players to refill the seat, then for the close', async ({ page }) => {
    const demo = await startDemo({ scenario: { steps: 28, mode: 'interactive' } });
    try {
      const bearer = await apiLogin(demo.origin, demo.token);
      await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: false, list: true }, listTab: 'players' } });
      await markDocument(page);
      await waitForPause(demo, 'signupRemove', null);
      await listPanel(page).getByRole('button', { name: 'Remove Eli Moss from the signup' }).click();
      await page.getByRole('alertdialog', { name: 'Remove Eli Moss from the signup?' }).getByRole('button', { name: 'Remove' }).click();
      await waitForPause(demo, 'signupClose', null);

      // Remove Ben at the close decision: the close is still what is needed, but first the players act.
      await listPanel(page).getByRole('button', { name: 'Remove Ben Ortiz from the signup' }).click();
      await page.getByRole('alertdialog', { name: 'Remove Ben Ortiz from the signup?' }).getByRole('button', { name: 'Remove' }).click();
      await expectToast(page, 'Removed Ben Ortiz from the signup');
      await expect.poll(async () => (await demo.state()).pausedAt).toMatchObject({ decision: 'signupClose', waitingFor: 'players' });
      await expect(eventActions(page).getByRole('button', { name: 'Close signup' })).toHaveCount(0);
      // About 2 s later the member removed longest ago (Eli) joins again; the close is the admin's again.
      await expect(listPanel(page)).toContainText('Eli Moss', { timeout: 10_000 });
      await expect.poll(async () => (await demo.state()).pausedAt).toMatchObject({ decision: 'signupClose', waitingFor: 'admin' });
      const roster = (await activeSnapshot(demo.origin, bearer)).signup!.roster;
      expect(roster).toEqual(['910000000000000011', '910000000000000013', '910000000000000014', '910000000000000015']);

      await eventActions(page).getByRole('button', { name: 'Close signup' }).click();
      await expectToast(page, 'Signup closed and seats assigned');
      await waitForPause(demo, 'publish', null);
      await expect(listPanel(page)).toContainText('4 seated · 4 checked in');
      await expectSameDocument(page);
    } finally {
      await demo.kill();
    }
  });

  test('a running clock expires while the script waits on another match; the expired match is the next decision', async ({ page }) => {
    test.setTimeout(60_000);
    // 4 s matches: M2 runs out while the script waits for the judge on M1.
    const demo = await startDemo({ scenario: { steps: 28, mode: 'interactive', durationMs: 4_000 } });
    try {
      const bearer = await apiLogin(demo.origin, demo.token);
      await answerUntilJudgeResume(demo, bearer);
      await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: true, list: false } } });
      await markDocument(page);
      const log = page.getByTestId('activity-log');
      await expect(log.locator('li.console-line').filter({ hasText: 'Expired M2' })).toBeVisible({ timeout: 10_000 });
      await expect(log.locator('article.console-group').filter({ hasText: 'Expired M2' }).locator('.console-group-meta')).toContainText('via timer');
      const audit = await eventAudit(demo.origin, bearer, (await activeSnapshot(demo.origin, bearer)).eventId);
      expect(audit.find(entry => entry.command.type === 'clockCheck')).toMatchObject({ via: 'system', actor: { kind: 'system' }, command: { matchId: 'M2' } });
      // Still waiting on the M1 judge; the expired M2 also shows up as needing a judge.
      expect((await demo.state()).pausedAt).toMatchObject({ decision: 'judgeResume', matchId: 'M1' });
      await expect(mainConsole(page).getByRole('button', { name: 'Resolve M2' })).toBeVisible();

      await mainConsole(page).getByRole('button', { name: 'Resume play M1' }).click();
      const dialog = page.getByRole('dialog', { name: 'Resume M1 by judge override' });
      await dialog.getByRole('textbox', { name: /Reason/ }).fill('Board state checked.');
      await dialog.getByRole('button', { name: 'Resume play' }).click();
      await expectToast(page, 'M1 resumed by judge override');
      // The released script turns to the match that expired meanwhile.
      await waitForPause(demo, 'resolve', 'M2');
      await mainConsole(page).getByRole('button', { name: 'Resolve M2' }).click();
      const resolve = page.getByRole('dialog', { name: 'Resolve M2' });
      await expect(resolve.getByRole('list', { name: 'Match details' })).toContainText('clock expired');
      await resolve.getByRole('radio', { name: /Seat C · Cy Park/ }).check();
      await resolve.getByRole('textbox', { name: /Reason/ }).fill('Time; C was ahead.');
      await resolve.getByRole('button', { name: 'Resolve match' }).click();
      await expectToast(page, 'M2 resolved: Seat C · Cy Park wins');
      // M1's remaining seconds run out too; it waits for its ruling.
      await waitForPause(demo, 'resolve', 'M1', 20_000);
      await expectSameDocument(page);
    } finally {
      await demo.kill();
    }
  });
});

test.describe('regressions: activity attribution', () => {
  let demo: DemoProcess;
  // Autoplay, held right after the scripted (Discord) admin closed signup.
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 7 } }); });
  test.afterAll(async () => { await demo?.kill(); });

  // Wave 3 QA bug 5 (fixed): activity groups used to merge by actor only and showed the first entry's channel.
  test('a console action right after a Discord action by the same admin is labelled "via console"', async ({ page }) => {
    await expect.poll(async () => (await demo.state()).step, { timeout: 20_000 }).toBe(7);
    await openConsole(page, { origin: demo.origin, token: demo.token });
    const log = page.getByTestId('activity-log');
    const closed = log.locator('article.console-group').filter({ hasText: 'Closed signup and assigned seats' });
    await expect(closed.locator('.console-group-meta')).toContainText('via Discord');
    await eventActions(page).getByRole('button', { name: 'Reopen signup' }).click();
    await expectToast(page, 'Signup reopened');
    await expect(log.locator('li.console-line').filter({ hasText: 'Reopened signup' })).toBeVisible();
    await expectConsoleActivity(page, 'Reopened signup');
  });
});

test.describe('regressions: retired history', () => {
  let demo: DemoProcess;
  // Steps 40 ms apart, M1's clock runs out after 3 s, the event completes, and it retires 4 s later while watched.
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 28, durationMs: 3_000, retireOnce: true, retireGapMs: 4_000 } }); });
  test.afterAll(async () => { await demo?.kill(); });

  // Wave 3 QA bug 3 (fixed): at the same version a retired snapshot (panel revision 0) lost to the cached active copy,
  // so the shell refetched it in a tight loop and the history list tabs kept their actions.
  test('a just-retired event, once selected, is read a bounded number of times and offers no row actions', async ({ page }) => {
    const reads: string[] = [];
    page.on('request', request => { if (/\/api\/v1\/events\/[^/]+\/snapshot$/.test(request.url())) reads.push(request.url()); });
    await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: false, list: true }, listTab: 'matches' } });
    const history = page.getByRole('navigation', { name: 'Event history' });
    await expect(history.getByRole('button')).toHaveCount(1, { timeout: 20_000 });
    await history.getByRole('button').click();
    await expect(crumb(page)).toHaveText('History');
    const before = reads.length;
    await page.waitForTimeout(2_000);
    expect(reads.length - before, 'snapshot reads in 2 s while History is shown').toBeLessThanOrEqual(2);
    await expect(listPanel(page).getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
  });
});
