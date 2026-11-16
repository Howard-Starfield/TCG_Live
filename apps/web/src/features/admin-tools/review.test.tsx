// Cross-tab behaviour added in review: tab persistence, Logs -> member profile, confirm steps that name
// their target, no duplicate panels after a failed post, server-clock scheduling, intent badges.
import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type AdminToolsSettingsDto,
  type AdminToolsStatusDto, type GuildMetaDto, type LogPageDto, type MemberProfileDto, type TicketPageDto } from '@tcg-live/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../app/testing';
import { ToastProvider } from '../../ui';
import { AdminDataProvider, ServerClock } from '../../data';
import { ServerClockContext } from '../../data/clock';
import { json, type FakeServer } from '../../data/test/fakes';
import { AdminToolsPage } from './AdminToolsPage';
import { AnnouncementComposer, AnnouncementsTab, newDraft, pingSummary, toLocalInput } from './announcements/AnnouncementsTab';
import type { AnnouncementView } from './announcements/api';
import { emptyEmbed } from './announcements/embed';
import { ModActionDialog } from './members/ModActionDialog';
import { ADMIN_TOOLS_TAB_KEY } from './navigation';
import { rolePanelWarnings } from './roles/api';
import { RolesTab } from './roles/RolesTab';
import { intentBadge } from './SettingsTab';
import { TicketsTab } from './tickets/TicketsTab';

MotionGlobalConfig.skipAnimations = true;

const guildId = '100000000000000001';
const USER = '200000000000000001';
const LFG = '200000000000000205';
const CHANNEL = '200000000000000302';
const guild: GuildMetaDto = { guildId, name: 'Demo', memberCount: 3, emojis: [],
  roles: [{ id: guildId, name: '@everyone', color: 0, position: 0, managed: false, aboveBot: false },
    { id: LFG, name: 'LFG', color: 0, position: 1, managed: false, aboveBot: false }],
  channels: [{ id: CHANNEL, name: 'general', type: 'text', parentId: null, position: 0, reserved: false },
    { id: '200000000000000404', name: 'Tickets', type: 'category', parentId: null, position: 1, reserved: false }] };
const settings = (patch: (body: AdminToolsSettingsBodyDto) => void = () => {}, version = 1): AdminToolsSettingsDto => {
  const body = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
  patch(body);
  return { guildId, version, updatedAtMs: 1, ...body };
};
const status = (patch: Partial<AdminToolsStatusDto> = {}): AdminToolsStatusDto => ({
  runtime: 'running', privilegedIntents: { guildMembers: 'off', messageContent: 'off' },
  wantedIntents: { guildMembers: false, messageContent: false }, restartRequired: false, restartReason: null, features: [], ...patch });
const profile: MemberProfileDto = { id: USER, username: 'ash', displayName: 'Ash', avatarUrl: null, roleIds: [], joinedAtMs: 1,
  accountCreatedAtMs: 1, flags: { banned: false, timedOutUntilMs: null, newAccount: false, bot: false, left: false },
  caseCount: 0, noteCount: 0, cases: [], notes: [], tournaments: [] };

function base(server: FakeServer, saved = settings()) {
  server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...CAPABILITIES], adminTools: true }));
  server.always('GET /admin-tools/settings', () => json(200, saved));
  server.always('GET /admin-tools/status', () => json(200, status()));
  server.always('GET /admin-tools/guild', () => json(200, guild));
  server.always('GET /admin-tools/logs/message-store', () => json(200, { storedMessages: 4, loggedEntries: 1, oldestMs: 1 }));
  server.always('GET /admin-tools/logs', () => json(200, { entries: [{ id: 3, guildId, userId: USER, occurredAtMs: 3, stream: 'member',
    kind: 'join', detail: {} }], nextAfter: 0 } satisfies LogPageDto));
  server.always(`GET /admin-tools/members/${USER}`, () => json(200, profile));
}
function mount(ui: ReactNode, setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  const view = render(<ToastProvider><AdminDataProvider data={harness.data}>{ui}</AdminDataProvider></ToastProvider>);
  return { harness, view };
}

beforeEach(() => { localStorage.removeItem(ADMIN_TOOLS_TAB_KEY); });

describe('Admin tools navigation', () => {
  it('opens a member profile from a log entry and remembers the tab', async () => {
    const user = userEvent.setup();
    const { harness, view } = mount(<AdminToolsPage initialTab="logs" />, server => base(server));
    const log = await screen.findByRole('list', { name: 'Log' });
    await user.click(within(log).getByRole('button', { name: 'Open profile' }));
    expect(await screen.findByRole('region', { name: 'Member Ash' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Members/ })).toHaveAttribute('aria-selected', 'true');
    expect(harness.server.callsTo(`GET /admin-tools/members/${USER}`).length).toBeGreaterThan(0);
    expect(localStorage.getItem(ADMIN_TOOLS_TAB_KEY)).toBe('members');

    // A fresh page (no initialTab) opens the remembered tab.
    view.unmount();
    const second = mount(<AdminToolsPage />, server => base(server));
    expect(await screen.findByRole('tab', { name: /Members/ })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: /Logs/ }));
    second.view.unmount();
    mount(<AdminToolsPage />, server => base(server));
    expect(await screen.findByRole('tab', { name: /Logs/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('ignores an inverted date range instead of sending it, and flags it', async () => {
    const { harness } = mount(<AdminToolsPage initialTab="logs" />, server => base(server));
    await screen.findByRole('list', { name: 'Log' });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-05' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-01' } });
    expect(await screen.findByText('Must not be before From.')).toBeInTheDocument();
    await waitFor(() => expect(harness.server.callsTo('GET /admin-tools/logs').some(call => call.url.includes('fromMs='))).toBe(true));
    expect(harness.server.callsTo('GET /admin-tools/logs').every(call => !call.url.includes('toMs='))).toBe(true);
  });

  it('shows a failed history deletion inside the confirm dialog', async () => {
    const user = userEvent.setup();
    mount(<AdminToolsPage initialTab="logs" />, server => {
      base(server);
      server.once('DELETE /admin-tools/logs/messages', () => json(503, { error: { code: 'unavailable', message: 'Storage is down.' } }));
    });
    await user.click(await screen.findByRole('button', { name: 'Delete stored message history' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete history' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Storage is down.');
  });
});

describe('confirm steps name their target', () => {
  it('moderation actions say what happens', () => {
    mount(<ModActionDialog target={{ id: USER, name: 'Ash' }} action="ban" onClose={() => {}} />, server => base(server));
    const dialog = screen.getByRole('alertdialog', { name: 'Ban Ash?' });
    expect(dialog).toHaveTextContent(/unable to rejoin until unbanned/);
  });

  it('sending a saved announcement from the history asks first and names @everyone', async () => {
    const user = userEvent.setup();
    const draft: AnnouncementView = { id: '00000000-0000-4000-8000-000000000001', guildId, channelId: CHANNEL,
      body: { content: null, embed: { ...emptyEmbed(), title: 'Finals' } }, mentionRoleIds: [LFG], mentionEveryone: true, scheduledAtMs: null,
      status: 'draft', messageId: null, sentAtMs: null, error: null, createdAtMs: 1, updatedAtMs: 1, missed: false };
    const { harness } = mount(<AnnouncementsTab />, server => {
      base(server);
      server.always('GET /admin-tools/announcements', () => json(200, { announcements: [draft] }));
      server.once(`POST /admin-tools/announcements/${draft.id}/send`, () => json(200, { ...draft, status: 'sent' }));
    });
    const history = await screen.findByRole('region', { name: 'Announcement history' });
    await user.click(await within(history).findByRole('button', { name: 'Send now' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Send "Finals" to #general now?' });
    expect(dialog).toHaveTextContent('@everyone (every member of the server), @LFG');
    expect(harness.server.callsTo(`POST /admin-tools/announcements/${draft.id}/send`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(harness.server.callsTo(`POST /admin-tools/announcements/${draft.id}/send`)).toHaveLength(1));
  });

  it('summarises pings', () => {
    expect(pingSummary(false, [])).toBe('Nobody is pinged.');
    expect(pingSummary(false, ['LFG', 'Judge'])).toBe('Pings @LFG, @Judge.');
  });
});

describe('announcement scheduling uses the server clock', () => {
  it('rejects a time that is future locally but past on the server', async () => {
    const clock = new ServerClock(() => Date.now());
    clock.observe(Date.now() + 2 * 3_600_000);   // the server runs two hours ahead
    const draft = { ...newDraft(), channelId: CHANNEL, body: { content: 'Hi', embed: null }, when: 'schedule' as const,
      scheduledAt: toLocalInput(Date.now() + 3_600_000) };
    mount(<ServerClockContext.Provider value={clock}>
      <AnnouncementComposer draft={draft} open onChange={() => {}} onDone={() => {}} canEdit />
    </ServerClockContext.Provider>, server => base(server));
    expect(await screen.findByText('Choose a time in the future.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeDisabled();
  });
});

describe('button-role panels', () => {
  it('a failed post after a successful save updates the saved panel on retry instead of creating a second one', async () => {
    const user = userEvent.setup();
    const saved = { id: '00000000-0000-4000-8000-0000000000aa', guildId, channelId: CHANNEL, messageId: null, mode: 'toggle',
      body: { content: null, embed: { ...emptyEmbed(), title: 'Pick your roles', description: 'Click a button to add or remove a role.' } },
      buttons: [{ roleId: LFG, label: 'LFG', emoji: null, style: 'primary' }], updatedAtMs: 1, requiredRoleId: null, messageState: 'unpublished', warnings: [] };
    const { harness } = mount(<RolesTab />, server => {
      base(server);
      server.always('GET /admin-tools/button-roles', () => json(200, { panels: [] }));
      server.always('GET /admin-tools/bulk-roles', () => json(200, { jobs: [] }));
      server.always('GET /events', () => json(200, []));
      server.once('POST /admin-tools/button-roles', () => json(201, saved));
      server.once(`POST /admin-tools/button-roles/${saved.id}/publish`, () => json(503, { error: { code: 'unavailable', message: 'Discord did not answer.' } }));
      server.once(`PUT /admin-tools/button-roles/${saved.id}`, () => json(200, saved));
      server.once(`POST /admin-tools/button-roles/${saved.id}/publish`, () => json(200, { ...saved, messageState: 'posted' }));
    });
    await user.click(await screen.findByRole('button', { name: 'New panel' }));
    const editor = await screen.findByRole('dialog', { name: 'New panel' });
    await waitFor(() => expect(within(editor).getAllByRole('option', { name: '#general' }).length).toBeGreaterThan(0));
    const [channel, , , buttonRole] = within(editor).getAllByRole('combobox');
    await user.selectOptions(channel!, CHANNEL);
    await user.selectOptions(buttonRole!, LFG);
    await user.type(within(editor).getByLabelText('Button 1 label'), 'LFG');
    await user.click(within(editor).getByRole('button', { name: 'Save and post' }));
    expect(await within(editor).findByText(/Saved, but not posted: Discord did not answer/)).toBeInTheDocument();
    await user.click(within(editor).getByRole('button', { name: 'Save and post' }));
    await waitFor(() => expect(harness.server.callsTo(`POST /admin-tools/button-roles/${saved.id}/publish`)).toHaveLength(2));
    expect(harness.server.callsTo('POST /admin-tools/button-roles')).toHaveLength(1);
    expect(harness.server.callsTo(`PUT /admin-tools/button-roles/${saved.id}`)).toHaveLength(1);
  });
});

describe('ticket settings', () => {
  it('Undo resets the panel colour field', async () => {
    const user = userEvent.setup();
    mount(<TicketsTab />, server => {
      base(server, settings(body => { body.tickets.panel.color = 0x3b82f6; }));
      server.always('GET /admin-tools/tickets', () => json(200, { tickets: [], nextBefore: null } satisfies TicketPageDto));
    });
    const colour = await screen.findByRole('textbox', { name: 'Panel colour' });
    expect(colour).toHaveValue('#3b82f6');
    await user.clear(colour);
    await user.type(colour, '#ff0000');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('textbox', { name: 'Panel colour' })).toHaveValue('#3b82f6');
  });

  it('pages older tickets', async () => {
    const user = userEvent.setup();
    const ticket = (number: number) => ({ id: `22222222-2222-4222-8222-${String(number).padStart(12, '0')}`, guildId, number, openerId: USER,
      name: `ticket-ash-${number}`, channelId: null, status: 'closed' as const, createdAtMs: 1, closedAtMs: 2, closedBy: 'local-admin',
      reopenableUntilMs: null, messageCount: 0 });
    mount(<TicketsTab />, server => {
      base(server);
      server.always('GET /admin-tools/tickets', call => json(200, call.url.includes('before=5')
        ? { tickets: [ticket(4)], nextBefore: null } : { tickets: [ticket(6), ticket(5)], nextBefore: 5 }));
    });
    const tickets = await screen.findByRole('region', { name: 'Tickets' });
    await user.click(within(tickets).getByRole('radio', { name: 'All' }));
    await user.click(await within(tickets).findByRole('button', { name: 'Older tickets' }));
    expect(await within(tickets).findByRole('listitem', { name: 'Ticket #4' })).toBeInTheDocument();
    expect(within(tickets).getByRole('listitem', { name: 'Ticket #6' })).toBeInTheDocument();
  });
});

describe('privileged intent badges', () => {
  it('reads the running state against the saved settings', () => {
    const wanted = { guildMembers: true, messageContent: false };
    expect(intentBadge(status({ wantedIntents: wanted, privilegedIntents: { guildMembers: 'on', messageContent: 'off' } }), 'guildMembers'))
      .toEqual({ label: 'On', tone: 'success' });
    expect(intentBadge(status({ wantedIntents: wanted, privilegedIntents: { guildMembers: 'missing', messageContent: 'off' } }), 'guildMembers').label)
      .toBe('Refused by Discord');
    expect(intentBadge(status({ wantedIntents: wanted }), 'guildMembers').label).toBe('Restart to request');
    expect(intentBadge(status({ wantedIntents: wanted }), 'messageContent').label).toBe('Not needed');
    expect(intentBadge(status({ privilegedIntents: { guildMembers: 'missing', messageContent: 'off' } }), 'guildMembers').label)
      .toBe('Refused (no longer needed)');
    expect(intentBadge(status({ runtime: 'offline', wantedIntents: wanted }), 'guildMembers').label).toBe('Requested at next start');
  });
});

describe('staff-level roles', () => {
  it('warns about roles the server marks elevated', () => {
    const roles = [...guild.roles, { id: '200000000000000209', name: 'Mods', color: 0, position: 1, managed: false, aboveBot: false, elevated: true }];
    const warnings = rolePanelWarnings([{ roleId: '200000000000000209', label: 'Mods', emoji: null, style: 'primary' },
      { roleId: LFG, label: 'LFG', emoji: null, style: 'primary' }], roles, guildId);
    expect(warnings).toEqual([{ roleId: '200000000000000209', problem: 'elevated',
      message: 'Mods: it has staff-level permissions, so the bot refuses to hand it out.' }]);
  });
});
