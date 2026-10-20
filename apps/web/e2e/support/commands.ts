// Wave 3 helpers: raw command requests (POST /api/v1/commands, /panels/refresh), the preconditions a
// console builds from a snapshot, the interactive demo's pause state, and the console's command controls.
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import type { DemoPause, DemoProcess } from './demo';
import { apiGet } from './console';
import { rawRequest } from './http';

/** Demo members (apps/server/src/admin/runtime/demo-runtime.ts DEMO_MEMBERS). */
export const MEMBER = {
  ava: '910000000000000011', ben: '910000000000000012', cy: '910000000000000013',
  dee: '910000000000000014', eli: '910000000000000015'
} as const;

/** The subset of EventSnapshotDto the specs read. */
export interface Snapshot {
  eventId: string;
  status: 'active' | 'retired';
  version: number;
  panelRevision: number;
  stage: string;
  adminActions: string[];
  signup: { status: 'open' | 'assigned'; roster: string[] } | null;
  matches: Array<{ id: 'M1' | 'M2'; phase: string; finalWinner: string | null; pauseGeneration: number;
    proposal: { revision: number } | null; adminActions: string[] }>;
}

export interface AuditEntry {
  sequence: number; commandId: string; via: string; principalId: string | null;
  actor: { kind: string }; command: { type: string; matchId?: string; winner?: string; reason?: string; memberId?: string };
}

export interface JsonResponse<T = any> { status: number; headers: Record<string, unknown>; body: T; text: string }

export const newCommandId = (): string => randomUUID();

async function post<T>(origin: string, bearer: string | null, path: string, body: unknown,
  headers: Record<string, string> = {}): Promise<JsonResponse<T>> {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const response = await rawRequest(origin, 'POST', `/api/v1${path}`, {
    'Content-Type': 'application/json', Origin: origin, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers
  }, body === undefined ? undefined : text);
  let parsed: any = null;
  try { parsed = response.body ? JSON.parse(response.body) : null; } catch { parsed = null; }
  return { status: response.status, headers: response.headers, body: parsed, text: response.body };
}

/** POST /api/v1/commands with any body (a string is sent verbatim). */
export const postCommand = <T = any>(origin: string, bearer: string | null, body: unknown, headers?: Record<string, string>) =>
  post<T>(origin, bearer, '/commands', body, headers);

/** POST /api/v1/panels/refresh. */
export const postRefresh = <T = any>(origin: string, bearer: string | null, body: unknown) =>
  post<T>(origin, bearer, '/panels/refresh', body);

export async function activeSnapshot(origin: string, bearer: string): Promise<Snapshot> {
  const events = await apiGet<Array<{ eventId: string; status: string }>>(origin, bearer, '/events');
  const active = events.find(event => event.status === 'active');
  if (!active) throw new Error('No active event.');
  return apiGet<Snapshot>(origin, bearer, `/events/${active.eventId}/snapshot`);
}

export const eventAudit = (origin: string, bearer: string, eventId: string) =>
  apiGet<AuditEntry[]>(origin, bearer, `/events/${eventId}/audit?limit=500`);

/** What the console sends as the precondition (apps/web/src/features/commands/model.ts preconditionFor). */
export const signupOf = (snapshot: Snapshot) =>
  ({ signup: { status: snapshot.signup!.status, rosterSize: snapshot.signup!.roster.length } });
export const matchOf = (snapshot: Snapshot, matchId: 'M1' | 'M2') => {
  const match = snapshot.matches.find(item => item.id === matchId)!;
  return { match: { matchId, phase: match.phase, proposalRevision: match.proposal?.revision ?? null,
    finalWinner: match.finalWinner, pauseGeneration: match.pauseGeneration } };
};

/** Waits until the interactive scenario pauses for `decision` (and `matchId` when given). */
export async function waitForPause(demo: DemoProcess, decision: string, matchId?: 'M1' | 'M2' | null,
  timeout = 30_000): Promise<DemoPause> {
  const key = (pause: DemoPause | null) => (pause ? `${pause.decision}:${matchId === undefined ? '*' : pause.matchId}` : 'playing');
  const wanted = `${decision}:${matchId === undefined ? '*' : matchId}`;
  await expect.poll(async () => key((await demo.state()).pausedAt),
    { timeout, message: `the scenario pauses for ${wanted}` }).toBe(wanted);
  return (await demo.state()).pausedAt!;
}

// ---------------------------------------------------------------- console controls

export const mainConsole = (page: Page): Locator => page.getByRole('main', { name: 'Console' });
export const eventActions = (page: Page): Locator => page.getByRole('group', { name: 'Event actions' });
export const composer = (page: Page): Locator => page.getByRole('combobox', { name: 'Admin command' });
export const composerSection = (page: Page): Locator => page.getByTestId('command-composer');
export const suggestions = (page: Page): Locator => composerSection(page).getByRole('listbox');
export const notifications = (page: Page): Locator => page.getByRole('region', { name: 'Notifications' });
/** The newest activity group (chat-style feed, newest at the bottom). */
export const lastActivityGroup = (page: Page): Locator => page.getByTestId('activity-log').locator('article.console-group').last();
export const stageStep = (page: Page, id: string): Locator => page.locator(`.console-step[data-step="${id}"]`);

/** Waits for a toast with this title, then dismisses every toast so the next assertion starts clean. */
export async function expectToast(page: Page, title: string | RegExp, description?: string | RegExp): Promise<void> {
  const toast = notifications(page).getByRole('listitem').filter({ hasText: title });
  await expect(toast.first()).toBeVisible();
  if (description) await expect(toast.first()).toContainText(description);
}

export async function dismissToasts(page: Page): Promise<void> {
  // Toasts animate in and out (unstable for a normal click); press every dismiss button directly.
  const buttons = notifications(page).getByRole('button', { name: 'Dismiss notification' });
  await expect.poll(async () => {
    await buttons.evaluateAll(list => { for (const button of list) (button as HTMLButtonElement).click(); });
    return buttons.count();
  }).toBe(0);
}

/** Asserts the activity stream shows this line in an admin group labelled "via console" (the newest such line). */
export async function expectConsoleActivity(page: Page, line: string | RegExp): Promise<void> {
  const log = page.getByTestId('activity-log');
  await expect(log.locator('li.console-line').filter({ hasText: line }).last()).toBeVisible();
  const group = log.locator('article.console-group').filter({ has: page.locator('li.console-line').filter({ hasText: line }) }).last();
  await expect(group.locator('.console-group-meta')).toContainText('admin');
  await expect(group.locator('.console-group-meta')).toContainText('via console');
}

/** Waits until a held scenario has played all its steps (the next step is the final hold). */
export async function waitForHold(demo: DemoProcess, steps: number): Promise<void> {
  await expect.poll(async () => (await demo.state()).step, { timeout: 20_000, message: 'the scenario reaches its hold' }).toBe(steps);
}

/** Answers the interactive script's admin decisions over the API until it waits for the M1 judge. */
export async function answerUntilJudgeResume(demo: DemoProcess, bearer: string): Promise<void> {
  const send = async (command: Record<string, unknown>, precondition: Record<string, unknown>) => {
    const at = await activeSnapshot(demo.origin, bearer);
    const response = await postCommand(demo.origin, bearer, { commandId: newCommandId(), eventId: at.eventId, command, precondition });
    expect(response.status, response.text).toBe(200);
  };
  const signup = async () => {
    const at = await activeSnapshot(demo.origin, bearer);
    return { signup: { status: at.signup!.status, rosterSize: at.signup!.roster.length } };
  };
  await waitForPause(demo, 'signupRemove', null);
  await send({ type: 'signupRemove', memberId: MEMBER.eli }, await signup());
  await waitForPause(demo, 'signupClose', null);
  await send({ type: 'signupClose' }, await signup());
  await waitForPause(demo, 'publish', null);
  await send({ type: 'publish' }, { eventVersion: (await activeSnapshot(demo.origin, bearer)).version });
  await waitForPause(demo, 'judgeResume', 'M1');
}
