import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type AdminToolsSettingsDto,
  type AdminToolsStatusDto, type Capability, type GuildMetaDto, type LogEntryDto, type LogPageDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../../app/testing';
import { ToastProvider } from '../../../ui';
import { AdminDataProvider } from '../../../data';
import { json, type FakeServer } from '../../../data/test/fakes';
import { AdminToolsPage } from '../AdminToolsPage';
import { DEFAULT_LOG_FILTER, logQueryString } from './api';
import { intentProblem } from './LogsTab';
import { renderTemplatePreview } from './template';

MotionGlobalConfig.skipAnimations = true;

const guildId = '100000000000000001';
const USER = '200000000000000001';
const GENERAL = '200000000000000302';
const ROLE = '200000000000000204';
const settings = (patch: (body: AdminToolsSettingsBodyDto) => void = () => {}, version = 1): AdminToolsSettingsDto => {
  const body = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
  patch(body);
  return { guildId, version, updatedAtMs: 1, ...body };
};
const status = (patch: Partial<AdminToolsStatusDto> = {}): AdminToolsStatusDto => ({
  runtime: 'running', privilegedIntents: { guildMembers: 'off', messageContent: 'off' },
  wantedIntents: { guildMembers: false, messageContent: false }, restartRequired: false, restartReason: null, features: [], ...patch });
const guild: GuildMetaDto = { guildId, name: 'Demo Server', memberCount: 41, emojis: [],
  roles: [{ id: guildId, name: '@everyone', color: 0, position: 0, managed: false, aboveBot: false },
    { id: ROLE, name: 'Season 3', color: 0, position: 2, managed: false, aboveBot: false },
    { id: '200000000000000206', name: 'TCG Live', color: 0, position: 5, managed: true, aboveBot: true }],
  channels: [{ id: GENERAL, name: 'general', type: 'text', parentId: null, position: 0, reserved: false },
    { id: '200000000000000305', name: 'mod-log', type: 'text', parentId: null, position: 2, reserved: false }] };
const memberEntries: LogEntryDto[] = [
  { id: 3, guildId, userId: USER, occurredAtMs: 3, stream: 'member', kind: 'role', detail: { addedRoleIds: [ROLE], removedRoleIds: [] } },
  { id: 2, guildId, userId: USER, occurredAtMs: 2, stream: 'member', kind: 'join', detail: { newAccount: true, accountCreatedAtMs: 1 } }
];
const messageEntries: LogEntryDto[] = [{ id: 7, guildId, userId: USER, occurredAtMs: 7, stream: 'message', kind: 'delete',
  channelId: GENERAL, messageId: '300000000000000001', before: 'secret trade offer', after: null, attachmentCount: 1 }];

function routes(server: FakeServer, options: { capabilities?: readonly Capability[]; saved?: AdminToolsSettingsDto; status?: AdminToolsStatusDto } = {}) {
  server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...options.capabilities ?? CAPABILITIES], adminTools: true }));
  server.always('GET /admin-tools/settings', () => json(200, options.saved ?? settings()));
  server.always('GET /admin-tools/status', () => json(200, options.status ?? status()));
  server.always('GET /admin-tools/guild', () => json(200, guild));
  server.always('GET /admin-tools/logs/message-store', () => json(200, { storedMessages: 4, loggedEntries: 1, oldestMs: 1 }));
  server.always('GET /admin-tools/logs', call => {
    const query = new URL(call.url, 'http://x').searchParams;
    const page: LogPageDto = query.get('stream') === 'message' ? { entries: messageEntries, nextAfter: 0 }
      : query.get('before') ? { entries: [memberEntries[1]!], nextAfter: 0 } : { entries: [memberEntries[0]!], nextAfter: 3 };
    return json(200, page);
  });
}

function mount(setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  render(<ToastProvider><AdminDataProvider data={harness.data}><AdminToolsPage initialTab="logs" /></AdminDataProvider></ToastProvider>);
  return harness;
}

describe('logs helpers', () => {
  it('renders template previews in one pass', () => {
    expect(renderTemplatePreview('Hi {user} {username} {server} #{memberCount} {x}', { user: '@a', username: '{server}', server: 'S', memberCount: null }))
      .toBe('Hi @a {server} S #? {x}');
  });

  it('builds the log query from filters', () => {
    const query = new URLSearchParams(logQueryString({ ...DEFAULT_LOG_FILTER, stream: 'message', kind: 'edit', userId: USER,
      channelId: GENERAL, from: '2026-11-01', to: '2026-11-02' }, 9));
    expect(Object.fromEntries(query)).toMatchObject({ stream: 'message', order: 'newest', before: '9', kind: 'edit', userId: USER, channelId: GENERAL });
    expect(Number(query.get('fromMs'))).toBe(new Date(2026, 10, 1).getTime());
    expect(Number(query.get('toMs'))).toBe(new Date(2026, 10, 3).getTime() - 1);
    const member = new URLSearchParams(logQueryString({ ...DEFAULT_LOG_FILTER, userId: 'abc', channelId: GENERAL }, 0));
    expect(member.has('userId')).toBe(false);
    expect(member.has('channelId')).toBe(false);
    expect(member.has('before')).toBe(false);
  });

  it('asks for the Developer Portal switch only when an enabled feature lacks its intent', () => {
    expect(intentProblem(status({ privilegedIntents: { guildMembers: 'missing', messageContent: 'off' } }), 'guildMembers', true))
      .toMatch(/Turn on Server Members Intent in the Discord Developer Portal → Bot, then restart/);
    expect(intentProblem(status(), 'messageContent', false)).toBeNull();
    expect(intentProblem(status({ privilegedIntents: { guildMembers: 'on', messageContent: 'on' } }), 'messageContent', true)).toBeNull();
    expect(intentProblem(status({ runtime: 'demo' }), 'messageContent', true)).toBeNull();
  });
});

describe('Logs tab', () => {
  it('lists, pages and filters log entries', async () => {
    const user = userEvent.setup();
    const harness = mount(server => routes(server));
    const list = await screen.findByRole('list', { name: 'Log' });
    expect(within(list).getByText('+ @Season 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await within(list).findByText('New account')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();

    await user.selectOptions(screen.getByLabelText('Kind'), 'message:delete');
    expect(await screen.findByText('secret trade offer')).toBeInTheDocument();
    const last = harness.server.callsTo('GET /admin-tools/logs').at(-1)!;
    expect(new URL(last.url, 'http://x').searchParams.get('kind')).toBe('delete');

    // Clicking a member ID filters by that member.
    await user.click(within(screen.getByRole('list', { name: 'Log' })).getByRole('button', { name: USER }));
    await waitFor(() => expect(new URL(harness.server.callsTo('GET /admin-tools/logs').at(-1)!.url, 'http://x').searchParams.get('userId')).toBe(USER));
    expect(screen.getByLabelText('Member ID')).toHaveValue(USER);
  });

  it('flags an invalid member ID without querying it', async () => {
    const user = userEvent.setup();
    mount(server => routes(server));
    await screen.findByRole('list', { name: 'Log' });
    await user.type(screen.getByLabelText('Member ID'), 'abc');
    expect(screen.getByText('Enter a Discord user ID.')).toBeInTheDocument();
  });

  it('saves the logging section with a live welcome preview and shows restart required afterwards', async () => {
    const user = userEvent.setup();
    let saved = false;
    const harness = mount(server => {
      routes(server);
      server.always('GET /admin-tools/status', () => json(200, saved
        ? status({ wantedIntents: { guildMembers: true, messageContent: false }, restartRequired: true,
          restartReason: 'The saved settings need the Server Members Intent.' }) : status()));
      server.once('PUT /admin-tools/settings', call => { saved = true; return json(200, { ...settings(), version: 2, ...(call.body as { settings: object }).settings }); });
    });
    const form = await screen.findByRole('region', { name: 'Logging settings' });
    const welcome = within(form).getByRole('group', { name: 'Welcome messages' });
    await user.click(within(welcome).getByRole('switch'));
    await user.selectOptions(within(welcome).getByLabelText('Welcome channel'), GENERAL);
    const message = within(welcome).getByLabelText('Welcome message');
    await user.clear(message);
    await user.type(message, 'Hi {{user} at {{server} #{{memberCount}');
    expect(within(welcome).getByLabelText('Welcome preview')).toHaveTextContent('Hi @NewMember at Demo Server #41');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(harness.server.callsTo('PUT /admin-tools/settings')).toHaveLength(1));
    const body = harness.server.callsTo('PUT /admin-tools/settings')[0]!.body as { settings: AdminToolsSettingsBodyDto };
    expect(body.settings.logging.welcome).toMatchObject({ enabled: true, channelId: GENERAL, message: 'Hi {user} at {server} #{memberCount}' });
    expect(await screen.findByText(/Restart required/)).toBeInTheDocument();
  });

  it('shows the intent notice for an enabled message log and offers an audited history delete', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server, { saved: settings(body => { body.logging.messageLog.enabled = true; }),
        status: status({ privilegedIntents: { guildMembers: 'off', messageContent: 'missing' }, wantedIntents: { guildMembers: false, messageContent: true } }) });
      server.once('DELETE /admin-tools/logs/messages', () => json(200, { storedMessages: 4, loggedEntries: 1 }));
    });
    const form = await screen.findByRole('region', { name: 'Logging settings' });
    expect(within(form).getByText(/Turn on Message Content Intent in the Discord Developer Portal/)).toBeInTheDocument();
    expect(within(form).getByText(/Privacy:/)).toBeInTheDocument();
    await user.click(await within(form).findByRole('button', { name: 'Delete stored message history' }));
    await user.click(await screen.findByRole('button', { name: 'Delete history' }));
    expect(await within(form).findByText('Deleted 4 message copies and 1 log entries.')).toBeInTheDocument();
    expect(harness.server.callsTo('DELETE /admin-tools/logs/messages')).toHaveLength(1);
  });

  it('warns about auto-roles the bot cannot assign, and read-only sessions cannot edit or delete', async () => {
    mount(server => routes(server, { capabilities: ['dashboard.read', 'members.read'],
      saved: settings(body => { body.logging.autoRole = { enabled: true, roleIds: ['200000000000000206'] }; }) }));
    const form = await screen.findByRole('region', { name: 'Logging settings' });
    expect(await within(form).findByText(/cannot be assigned by the bot/)).toBeInTheDocument();
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(form).queryByRole('button', { name: 'Delete stored message history' })).toBeNull();
  });
});
