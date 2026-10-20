// The command composer (`<input role="combobox">` below the activity stream): suggestions from the whole
// line, seat and member mentions, named options, inline parse errors, and operation by keyboard alone.
// Runs on a held autoplay scenario at script step 24: M2 disputed twice (needs a ruling), M1 running again
// after the scripted judge resume. Nothing moves on its own, so every change comes from the console.
import { expect, test, type Page } from '@playwright/test';
import {
  activeSnapshot, composer, composerSection, dismissToasts, eventAudit, expectConsoleActivity, expectToast, suggestions, waitForHold
} from './support/commands';
import { apiLogin, openConsole } from './support/console';
import { startDemo, type DemoProcess } from './support/demo';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

let demo: DemoProcess;
let bearer: string;
let page: Page;
const commandPosts: string[] = [];

test.beforeAll(async ({ browser }) => {
  demo = await startDemo({ scenario: { steps: 24 } });
  await waitForHold(demo, 24);
  bearer = await apiLogin(demo.origin, demo.token);
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/v1\/(commands|panels\/refresh)$/.test(request.url())) commandPosts.push(request.postData() ?? '');
  });
  await openConsole(page, { origin: demo.origin, token: demo.token, preferences: { panes: { live: false, list: true }, listTab: 'matches' } });
  await page.evaluate(() => { (window as unknown as { e2eDoc?: string }).e2eDoc = 'same'; });
});
test.afterAll(async () => {
  await page?.close();
  await demo?.kill();
});

const options = () => suggestions(page).getByRole('option');
const matchRow = (id: string) => page.getByTestId('list-pane').getByRole('table', { name: /^Matches/ }).locator('tbody tr').filter({ hasText: id });

test('suggestions: "/" lists what this session can run now; arrows move, Escape hides, typing reopens', async () => {
  const input = composer(page);
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(composerSection(page)).toContainText('commands');
  await input.focus();
  await page.keyboard.type('/');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(suggestions(page)).toHaveAttribute('aria-label', 'Commands');
  // Signup, check-in and publication are over and no match is paused or final: refresh and resolve only.
  await expect(options()).toHaveText([/^\/refresh/, /^\/resolve/]);
  await expect(options().first()).toHaveAttribute('aria-selected', 'true');
  const firstId = await options().first().getAttribute('id');
  await expect(input).toHaveAttribute('aria-activedescendant', firstId!);
  await page.keyboard.press('ArrowDown');
  await expect(options().nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveAttribute('aria-activedescendant', (await options().nth(1).getAttribute('id'))!);
  await page.keyboard.press('ArrowDown');                       // wraps
  await expect(options().first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(input).toHaveValue('/');
  await page.keyboard.type('res');
  // Prefix matches first, then (from two letters on) names containing the query: "refresh" contains "res".
  await expect(options()).toHaveText([/^\/resolve/, /^\/refresh/]);

  // Tab accepts; the next argument's suggestions follow: the matches that can be resolved.
  await page.keyboard.press('Tab');
  await expect(input).toHaveValue('/resolve ');
  await expect(suggestions(page)).toHaveAttribute('aria-label', 'Matches');
  await expect(options()).toHaveText([/^M1.*A vs B · running/, /^M2.*C vs D · running · needs a judge/]);
  await expect(composerSection(page)).toContainText('/resolve <match> <winner> <reason>');
  await page.keyboard.type('2');
  await expect(options()).toHaveText([/^M2/]);
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('/resolve M2 ');
  // Winner: the two seats of M2, by seat or by player name.
  await expect(suggestions(page)).toHaveAttribute('aria-label', 'Winner');
  await expect(options()).toHaveText([/^@C.*Seat C · Cy Park/, /^@D.*Seat D · Dee Ross/]);
  await page.keyboard.type('@De');
  await expect(options()).toHaveText([/^@D/]);
  await page.keyboard.press('Tab');
  await expect(input).toHaveValue('/resolve M2 @D ');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  // The usage hint marks the argument at the caret.
  await expect(composerSection(page).locator('.font-semibold', { hasText: '<reason>' })).toBeVisible();
  await input.fill('');
  expect(commandPosts).toEqual([]);
});

test('parse errors are shown inline, mark the input invalid, send nothing, and clear on typing', async () => {
  const input = composer(page);
  const error = composerSection(page).getByRole('alert');
  const cases: Array<[string, string]> = [
    ['/resolve M2 @A Wrong seat', 'Seat A does not play in M2 (C vs D).'],
    ['/frobnicate', 'Unknown command /frobnicate. Type / to see the commands.'],
    ['publish', 'Commands start with /. Type / to see them.'],
    ['/publish', '/publish is not available right now. It needs all four check-ins and an unpublished round.'],
    ['/resolve M3 @C x', 'Unknown match "M3". Use M1 or M2.'],
    ['/resolve M2 @Nobody x', 'No member called @Nobody in this event.'],
    ['/resolve M2 @Ava_Chen x', 'Ava Chen (Seat A) does not play in M2.'],
    ['/refresh now', '/refresh takes no options ("now"). Usage: /refresh'],
    ['/tcg-test', 'Add a subcommand after /tcg-test, for example /tcg-test publish.']
  ];
  for (const [line, message] of cases) {
    await input.fill(line);
    await input.press('Enter');
    await expect(error, line).toHaveText(message);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
  }
  await page.keyboard.type(' ');
  await expect(error).toHaveCount(0);
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
  await input.fill('');
  expect(commandPosts).toEqual([]);
});

test('an incomplete resolve opens the prefilled dialog; Escape closes it and keeps the line', async () => {
  const input = composer(page);
  await input.fill('/resolve 1 B ');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Resolve M1' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Seat B · Ben Ortiz/ })).toBeChecked();
  await expect(dialog.getByRole('textbox', { name: /Reason/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('/resolve 1 B ');
  expect(commandPosts).toEqual([]);

  // Again, finishing in the dialog: the composer clears once the command is accepted.
  await input.press('Enter');
  await dialog.getByRole('textbox', { name: /Reason/ }).fill('Both players agreed B won before time.');
  await dialog.getByRole('textbox', { name: /Reason/ }).press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expectToast(page, 'M1 resolved: Seat B · Ben Ortiz wins');
  await expect(input).toHaveValue('');
  await expect(matchRow('M1')).toContainText('Ben Ortiz');
  await dismissToasts(page);
});

test('named options and a member mention: a complete resolve runs directly', async () => {
  const input = composer(page);
  await input.fill('/resolve match:M2 winner:@Dee_Ross reason:Judge ruling after review.');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expectToast(page, 'M2 resolved: Seat D · Dee Ross wins');
  await expectConsoleActivity(page, /Resolved M2 for Seat D.*Judge ruling after review\./);
  const snapshot = await activeSnapshot(demo.origin, bearer);
  const audit = await eventAudit(demo.origin, bearer, snapshot.eventId);
  expect(audit.at(-1)).toMatchObject({ via: 'web', command: { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'Judge ruling after review.' } });
  await dismissToasts(page);
});

test('keyboard only: a correction from the composer always confirms in the danger dialog', async () => {
  const input = composer(page);
  await input.focus();
  await page.keyboard.type('/cor');
  await expect(options()).toHaveText([/^\/correct/]);
  await page.keyboard.press('Tab');
  await expect(options()).toHaveText([/^M1.*final/, /^M2.*final/]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('/correct M2 ');
  await expect(options()).toHaveText([/^@C/, /^@D.*current winner/]);
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('/correct M2 @C ');
  await page.keyboard.type('Score sheet shows Seat C won.');
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: "Correct M2's result" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Seat C · Cy Park/ })).toBeChecked();
  await expect(dialog.getByRole('textbox', { name: /Reason/ })).toHaveValue('Score sheet shows Seat C won.');
  await expect(dialog.getByRole('textbox', { name: /Reason/ })).toBeFocused();
  expect(commandPosts.filter(body => body.includes('"correct"'))).toHaveLength(0);
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('checkbox')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('checkbox')).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Correct result' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expectToast(page, 'M2 corrected: Seat C · Cy Park wins');
  await expect(input).toHaveValue('');
  await expect(matchRow('M2')).toContainText('Cy Park');
  await expectConsoleActivity(page, /Corrected M2 to Seat C/);
  await dismissToasts(page);
});

test('/tcg-test prefix: a pasted Discord command works; panel refresh from the composer', async () => {
  const before = await activeSnapshot(demo.origin, bearer);
  await composer(page).fill('/tcg-test refresh');
  await composer(page).press('Enter');
  await expectToast(page, 'Discord panels refreshed');
  await expect(composer(page)).toHaveValue('');
  expect((await activeSnapshot(demo.origin, bearer)).panelRevision).toBe(before.panelRevision + 1);
  expect(await page.evaluate(() => (window as unknown as { e2eDoc?: string }).e2eDoc)).toBe('same');
});
