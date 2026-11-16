import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type BulkRoleJobDto, type BulkRoleJobRequestDto,
  type GuildMetaDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../../app/testing';
import { ToastProvider } from '../../../ui';
import { AdminDataProvider } from '../../../data';
import { json, type FakeServer } from '../../../data/test/fakes';
import { emptyEmbed } from '../announcements/embed';
import { parseMemberIds, rolePanelWarnings, type ButtonRolePanelView, type SavePanelBody } from './api';
import { RolesTab } from './RolesTab';

MotionGlobalConfig.skipAnimations = true;

const guildId = '100000000000000001';
const LFG = '200000000000000205', ADMIN = '200000000000000201', BOT = '200000000000000206';
const guild: GuildMetaDto = { guildId, name: 'Demo', memberCount: 3, emojis: [],
  roles: [{ id: guildId, name: '@everyone', color: 0, position: 0, managed: false, aboveBot: false },
    { id: LFG, name: 'LFG', color: 0, position: 1, managed: false, aboveBot: false },
    { id: BOT, name: 'TCG Live', color: 0, position: 5, managed: true, aboveBot: true },
    { id: ADMIN, name: 'Admin', color: 0, position: 6, managed: false, aboveBot: true }],
  channels: [{ id: '200000000000000302', name: 'general', type: 'text', parentId: null, position: 0, reserved: false }] };
const panel = (patch: Partial<ButtonRolePanelView> = {}): ButtonRolePanelView => ({ id: '00000000-0000-4000-8000-0000000000aa', guildId,
  channelId: '200000000000000302', messageId: '300000000000000001', body: { content: null, embed: { ...emptyEmbed(), title: 'Game roles' } },
  mode: 'toggle', buttons: [{ roleId: LFG, label: 'LFG', emoji: null, style: 'primary' }], updatedAtMs: 1, requiredRoleId: null,
  messageState: 'posted', warnings: [], ...patch });
const job = (patch: Partial<BulkRoleJobDto> = {}): BulkRoleJobDto => ({ id: '00000000-0000-4000-8000-0000000000bb', guildId, action: 'add',
  roleId: LFG, target: { kind: 'ids', userIds: ['200000000000000001'] }, reason: 'r', status: 'running', total: 4, done: 1, failed: 1, error: null,
  createdAtMs: 1, startedAtMs: 1, finishedAtMs: null, ...patch });

function routes(server: FakeServer, panels: ButtonRolePanelView[] = [], jobs: BulkRoleJobDto[] = []) {
  server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...CAPABILITIES], adminTools: true }));
  server.always('GET /admin-tools/settings', () => json(200, { guildId, version: 0, updatedAtMs: null,
    ...structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto }));
  server.always('GET /admin-tools/guild', () => json(200, guild));
  server.always('GET /admin-tools/button-roles', () => json(200, { panels }));
  server.always('GET /admin-tools/bulk-roles', () => json(200, { jobs }));
  server.always('GET /events', () => json(200, []));
}
function mount(setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  render(<ToastProvider><AdminDataProvider data={harness.data}><RolesTab /></AdminDataProvider></ToastProvider>);
  return harness;
}

describe('roles helpers', () => {
  it('warns about managed, above-bot and deleted roles', () => {
    const warnings = rolePanelWarnings([{ roleId: LFG, label: 'LFG', emoji: null, style: 'primary' },
      { roleId: BOT, label: 'Bot', emoji: null, style: 'primary' }, { roleId: ADMIN, label: 'Admin', emoji: null, style: 'primary' },
      { roleId: '200000000000009999', label: 'Gone', emoji: null, style: 'primary' }], guild.roles, guildId);
    expect(warnings.map(item => item.problem)).toEqual(['managed', 'above-bot', 'unknown']);
  });
  it('parses pasted member IDs and mentions', () => {
    expect(parseMemberIds('200000000000000001, <@200000000000000002>\n200000000000000001 nope')).toEqual({
      ids: ['200000000000000001', '200000000000000002'], invalid: ['nope'] });
  });
});

describe('Roles tab', () => {
  it('shows a deleted panel message with Repost and server-side warnings', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server, [panel({ messageState: 'missing', warnings: [{ roleId: ADMIN, problem: 'above-bot', message: "Admin: above the bot's role" }] })]);
      server.once('POST /admin-tools/button-roles/00000000-0000-4000-8000-0000000000aa/publish', () => json(200, panel()));
    });
    const item = await screen.findByRole('listitem', { name: 'Panel Game roles' });
    expect(within(item).getByText('Message deleted')).toBeInTheDocument();
    expect(within(item).getByText(/above the bot's role/)).toBeInTheDocument();
    await user.click(within(item).getByRole('button', { name: 'Repost' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/button-roles/00000000-0000-4000-8000-0000000000aa/publish')).toHaveLength(1));
  });

  it('creates a unique panel with a preview of its buttons, then posts it', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server);
      server.once('POST /admin-tools/button-roles', call => json(201, panel({ ...(call.body as SavePanelBody), messageId: null, messageState: 'unpublished' })));
      server.once('POST /admin-tools/button-roles/00000000-0000-4000-8000-0000000000aa/publish', () => json(200, panel()));
    });
    await user.click(await screen.findByRole('button', { name: 'New panel' }));
    const editor = await screen.findByRole('dialog', { name: 'New panel' });
    await waitFor(() => expect(within(editor).getAllByRole('option', { name: '#general' }).length).toBeGreaterThan(0));
    const [channel, mode] = within(editor).getAllByRole('combobox');
    await user.selectOptions(channel!, '200000000000000302');
    await user.selectOptions(mode!, 'unique');
    const buttons = within(editor).getByRole('region', { name: 'Buttons' });
    await user.selectOptions(within(buttons).getAllByRole('combobox')[0]!, LFG);
    expect(within(buttons).getByRole('option', { name: /Admin \(above the bot\)/ })).toBeDisabled();
    await user.type(within(buttons).getByLabelText('Button 1 label'), 'Looking for game');
    expect(within(screen.getByRole('figure', { name: 'Panel preview' })).getByText('Looking for game')).toBeInTheDocument();
    await user.click(within(editor).getByRole('button', { name: 'Save and post' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/button-roles/00000000-0000-4000-8000-0000000000aa/publish')).toHaveLength(1));
    const body = harness.server.callsTo('POST /admin-tools/button-roles')[0]!.body as SavePanelBody;
    expect(body.mode).toBe('unique');
    expect(body.buttons).toEqual([{ roleId: LFG, label: 'Looking for game', emoji: null, style: 'primary' }]);
    expect(body.requiredRoleId).toBeNull();
  });

  it('previews a bulk job (dry run) before starting it, and shows progress with cancel', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server, [], [job()]);
      server.once('POST /admin-tools/bulk-roles/preview', () => json(200, { total: 2, sample: [], warning: null }));
      server.once('POST /admin-tools/bulk-roles', () => json(201, job({ status: 'queued', done: 0, failed: 0 })));
      server.once('POST /admin-tools/bulk-roles/00000000-0000-4000-8000-0000000000bb/cancel', () => json(200, job({ status: 'cancelled' })));
    });
    const section = await screen.findByRole('region', { name: 'Bulk roles' });
    await waitFor(() => expect(within(section).getAllByRole('option', { name: '@LFG' }).length).toBeGreaterThan(0));
    const [, role, members] = within(section).getAllByRole('combobox');
    await user.selectOptions(role!, LFG);
    await user.selectOptions(members!, 'ids');
    await user.type(within(section).getByLabelText('Member IDs'), '200000000000000001 200000000000000002');
    await user.type(within(section).getByLabelText('Reason'), 'Season 3');
    expect(within(section).getByRole('button', { name: 'Start job' })).toBeDisabled();
    await user.click(within(section).getByRole('button', { name: 'Preview' }));
    expect(await within(section).findByText(/would get @LFG/)).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Start job' }));
    // The confirm step names the role, the count and the target before anything is queued.
    const confirm = await screen.findByRole('alertdialog', { name: 'Give @LFG to 2 members?' });
    expect(confirm).toHaveTextContent(/Pasted member IDs/);
    expect(harness.server.callsTo('POST /admin-tools/bulk-roles')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Add role' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/bulk-roles')).toHaveLength(1));
    const queued = harness.server.callsTo('POST /admin-tools/bulk-roles')[0]!.body as BulkRoleJobRequestDto;
    expect(queued).toEqual({ action: 'add', roleId: LFG, target: { kind: 'ids', userIds: ['200000000000000001', '200000000000000002'] }, reason: 'Season 3' });
    const jobs = screen.getByRole('list', { name: 'Bulk role jobs' });
    expect(within(jobs).getByRole('progressbar', { name: 'Job progress' })).toHaveAttribute('aria-valuenow', '2');
    await user.click(within(jobs).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/bulk-roles/00000000-0000-4000-8000-0000000000bb/cancel')).toHaveLength(1));
  });
});
