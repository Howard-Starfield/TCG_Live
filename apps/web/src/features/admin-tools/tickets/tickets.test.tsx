import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type AdminToolsSettingsDto, type AdminToolsStatusDto,
  type Capability, type GuildMetaDto, type TicketDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../../app/testing';
import { ToastProvider } from '../../../ui';
import { AdminDataProvider } from '../../../data';
import { json, type FakeServer } from '../../../data/test/fakes';
import { TicketsTab, ticketSettingsProblem } from './TicketsTab';

MotionGlobalConfig.skipAnimations = true;

const guildId = '100000000000000001';
const SUPPORT = '200000000000000304';
const CATEGORY = '200000000000000404';
const JUDGE = '200000000000000202';
const guild: GuildMetaDto = { guildId, name: 'Demo', memberCount: 3, emojis: [{ id: '200000000000000501', name: 'tcg_ticket', animated: false }],
  roles: [{ id: guildId, name: '@everyone', color: 0, position: 0, managed: false, aboveBot: false },
    { id: JUDGE, name: 'Judge', color: 0, position: 4, managed: false, aboveBot: false }],
  channels: [{ id: SUPPORT, name: 'support', type: 'text', parentId: null, position: 0, reserved: false },
    { id: '200000000000000303', name: 'tournament-signup', type: 'text', parentId: null, position: 1, reserved: true },
    { id: CATEGORY, name: 'Tickets', type: 'category', parentId: null, position: 2, reserved: false }] };
const body = (): AdminToolsSettingsBodyDto => structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
const settings = (version = 0, tickets: Partial<AdminToolsSettingsBodyDto['tickets']> = {}): AdminToolsSettingsDto => {
  const value = body();
  return { guildId, version, updatedAtMs: version ? 1 : null, ...value, tickets: { ...value.tickets, ...tickets } };
};
const status: AdminToolsStatusDto = { runtime: 'running', privilegedIntents: { guildMembers: 'off', messageContent: 'off' },
  wantedIntents: { guildMembers: false, messageContent: false }, restartRequired: false, restartReason: null, features: [] };
const now = Date.now();
const ticket = (patch: Partial<TicketDto>): TicketDto => ({ id: '22222222-2222-4222-8222-222222222222', guildId, number: 1, openerId: '300000000000000050',
  name: 'ticket-ash-1', channelId: '300000000000000060', status: 'open', createdAtMs: now - 3_600_000, closedAtMs: null, closedBy: null,
  reopenableUntilMs: null, messageCount: 0, ...patch });
const CLOSED = ticket({ id: '33333333-3333-4333-8333-333333333333', number: 2, name: 'ticket-misty-2', status: 'closed', channelId: null,
  closedAtMs: now - 3_600_000, reopenableUntilMs: now + 20 * 3_600_000, messageCount: 2 });

function routes(server: FakeServer, capabilities: readonly Capability[] = CAPABILITIES, saved = settings()) {
  server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...capabilities], adminTools: true }));
  server.always('GET /admin-tools/settings', () => json(200, saved));
  server.always('GET /admin-tools/status', () => json(200, status));
  server.always('GET /admin-tools/guild', () => json(200, guild));
  server.always('GET /admin-tools/tickets', call => json(200, { tickets: call.url.includes('status=open') ? [ticket({})]
    : call.url.includes('status=closed') ? [CLOSED] : [], nextBefore: null }));
}
function mount(setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  render(<ToastProvider><AdminDataProvider data={harness.data}><TicketsTab /></AdminDataProvider></ToastProvider>);
  return harness;
}

describe('ticket settings', () => {
  it('validates the pattern and the enable requirements', () => {
    const value = settings().tickets;
    expect(ticketSettingsProblem(value)).toBeNull();
    expect(ticketSettingsProblem({ ...value, namingPattern: 'Ticket {name}' })).toMatch(/must include \{n\}/);
    expect(ticketSettingsProblem({ ...value, enabled: true })).toMatch(/support channel/);
    expect(ticketSettingsProblem({ ...value, enabled: true, supportChannelId: SUPPORT, categoryId: CATEGORY, staffRoleIds: [JUDGE] })).toBeNull();
  });

  it('edits and saves the tickets section, and explains the Message Content intent', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server);
      server.once('PUT /admin-tools/settings', call => json(200, { ...settings(1), ...(call.body as { settings: object }).settings }));
    });
    const section = await screen.findByRole('region', { name: 'Ticket settings' });
    expect(within(section).getByText(/Message Content intent/)).toBeInTheDocument();
    const [support, category] = within(section).getAllByRole('combobox');
    await waitFor(() => expect(within(support!).getByRole('option', { name: /tournament-signup/ })).toBeDisabled());
    await user.selectOptions(support!, SUPPORT);
    await user.selectOptions(category!, CATEGORY);
    await user.selectOptions(within(section).getAllByRole('combobox').find(item => within(item).queryByRole('option', { name: '@Judge' }))!, JUDGE);
    await user.click(within(section).getByRole('button', { name: 'Add' }));
    await user.click(within(section).getByRole('switch'));
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(harness.server.callsTo('PUT /admin-tools/settings')).toHaveLength(1));
    const sent = harness.server.callsTo('PUT /admin-tools/settings')[0]!.body as { expectedVersion: number; settings: AdminToolsSettingsBodyDto };
    expect(sent.expectedVersion).toBe(0);
    expect(sent.settings.tickets).toMatchObject({ enabled: true, supportChannelId: SUPPORT, categoryId: CATEGORY, staffRoleIds: [JUDGE] });
    expect(sent.settings.cases).toEqual(body().cases);
  });

  it('posts the panel once tickets are saved as enabled', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server, CAPABILITIES, settings(3, { enabled: true, supportChannelId: SUPPORT, categoryId: CATEGORY, staffRoleIds: [JUDGE] }));
      server.once('POST /admin-tools/tickets/panel', () => json(200, { ok: true, messageId: '1', message: 'The ticket panel is at the bottom of the support channel.' }));
    });
    const section = await screen.findByRole('region', { name: 'Ticket settings' });
    await user.click(within(section).getByRole('button', { name: 'Post / refresh panel' }));
    expect(await within(section).findByText(/panel is at the bottom/)).toBeInTheDocument();
    expect(harness.server.callsTo('POST /admin-tools/tickets/panel')).toHaveLength(1);
  });
});

describe('ticket list', () => {
  it('closes an open ticket after confirming, reopens a closed one, and shows transcripts', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server);
      server.once(`POST /admin-tools/tickets/${ticket({}).id}/close`, () => json(200, { ticket: { ...ticket({}), status: 'closed' }, warning: null }));
      server.once(`POST /admin-tools/tickets/${CLOSED.id}/reopen`, () => json(200, { ...CLOSED, status: 'open' }));
      server.always(`GET /admin-tools/tickets/${CLOSED.id}/transcript`, () => json(200, { ticket: CLOSED, messages: [
        { seq: 1, messageId: '1', authorId: '2', authorName: 'misty', authorBot: false, content: 'Help please', attachments: [], createdAtMs: now },
        { seq: 2, messageId: '3', authorId: '2', authorName: 'misty', authorBot: false, content: '', attachments: [], createdAtMs: now }] }));
    });
    const tickets = await screen.findByRole('region', { name: 'Tickets' });
    const open = await within(tickets).findByRole('listitem', { name: 'Ticket #1' });
    await user.click(within(open).getByRole('button', { name: 'Close' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/reopen it for 24 hours/);
    await user.click(within(dialog).getByRole('button', { name: 'Close ticket' }));
    expect(await within(tickets).findByText(/Ticket #1 closed; transcript saved/)).toBeInTheDocument();

    await user.click(within(tickets).getByRole('radio', { name: 'Closed' }));
    const closed = await within(tickets).findByRole('listitem', { name: 'Ticket #2' });
    await user.click(within(closed).getByRole('button', { name: 'Transcript' }));
    const transcript = await screen.findByRole('list', { name: 'Transcript' });
    expect(within(transcript).getByText('Help please')).toBeInTheDocument();
    expect(within(transcript).getByText(/Text not available/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(within(closed).getByRole('button', { name: 'Reopen' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(harness.server.callsTo(`POST /admin-tools/tickets/${CLOSED.id}/reopen`)).toHaveLength(1));
  });

  it('read-only sessions see tickets without close, reopen or save', async () => {
    mount(server => routes(server, ['dashboard.read', 'members.read']));
    const tickets = await screen.findByRole('region', { name: 'Tickets' });
    const open = await within(tickets).findByRole('listitem', { name: 'Ticket #1' });
    expect(within(open).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Ticket settings' })).queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
