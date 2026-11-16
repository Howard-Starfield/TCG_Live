import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type Capability, type GuildMetaDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../../app/testing';
import { ToastProvider } from '../../../ui';
import { AdminDataProvider } from '../../../data';
import { json, type FakeServer } from '../../../data/test/fakes';
import { StickiesTab, stickyRequest } from '../stickies/StickiesTab';
import type { StickyListItemDto } from '../stickies/types';
import { ChannelsTab, purgeMessage } from './ChannelsTab';

MotionGlobalConfig.skipAnimations = true;

const guildId = '100000000000000001';
const GENERAL = '200000000000000302';
const SIGNUP = '200000000000000303';
const guild: GuildMetaDto = { guildId, name: 'Demo', memberCount: 3, emojis: [],
  roles: [{ id: guildId, name: '@everyone', color: 0, position: 0, managed: false, aboveBot: false }],
  channels: [{ id: GENERAL, name: 'general', type: 'text', parentId: null, position: 0, reserved: false },
    { id: SIGNUP, name: 'tournament-signup', type: 'text', parentId: null, position: 1, reserved: true }] };

const sticky = (patch: Partial<StickyListItemDto> = {}): StickyListItemDto => ({ id: '11111111-1111-4111-8111-111111111111', guildId, channelId: GENERAL,
  content: 'Read the rules', embed: null, enabled: true, debounceMs: 15_000, lastMessageId: null, updatedAtMs: 1,
  status: { state: 'missing-permissions', message: 'The bot needs Manage Messages in this channel.', atMs: 1 }, ...patch });

function routes(server: FakeServer, capabilities: readonly Capability[] = CAPABILITIES) {
  server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...capabilities], adminTools: true }));
  server.always('GET /admin-tools/settings', () => json(200, { guildId, version: 0, updatedAtMs: null,
    ...(structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto) }));
  server.always('GET /admin-tools/guild', () => json(200, guild));
}
function mountWith(ui: ReactNode, setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  render(<ToastProvider><AdminDataProvider data={harness.data}>{ui}</AdminDataProvider></ToastProvider>);
  return harness;
}

describe('sticky form', () => {
  it('validates before sending', () => {
    const base = { id: null, channelId: GENERAL, enabled: true, delaySeconds: '15', content: 'Hi', useEmbed: false, title: '', description: '', color: '' };
    expect(stickyRequest(base)).toEqual({ request: { channelId: GENERAL, enabled: true, debounceMs: 15_000, content: 'Hi', embed: null } });
    expect(stickyRequest({ ...base, channelId: null })).toEqual({ error: 'Choose a channel.' });
    expect('error' in stickyRequest({ ...base, delaySeconds: '2' })).toBe(true);
    expect('error' in stickyRequest({ ...base, content: ' ' })).toBe(true);
    expect('error' in stickyRequest({ ...base, useEmbed: true, title: 'T', color: 'blue' })).toBe(true);
    const embed = stickyRequest({ ...base, content: '', useEmbed: true, title: 'Rules', color: '#3b82f6' });
    expect('request' in embed && embed.request.embed?.color).toBe(0x3b82f6);
  });

  it('lists stickies with their status, creates one, and deletes after confirming', async () => {
    const user = userEvent.setup();
    const harness = mountWith(<StickiesTab />, server => {
      routes(server);
      server.always('GET /admin-tools/stickies', () => json(200, { stickies: [sticky()] }));
      server.once('POST /admin-tools/stickies', call => json(201, { ...sticky(), ...(call.body as object), status: null }));
      server.once('DELETE /admin-tools/stickies/11111111-1111-4111-8111-111111111111', () => json(200, { deleted: sticky().id }));
    });
    const list = await screen.findByRole('list', { name: 'Sticky messages' });
    expect(within(list).getByText('Missing permissions')).toBeInTheDocument();
    expect(within(list).getByText(/Manage Messages/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /New sticky/ }));
    const form = await screen.findByRole('dialog', { name: 'New sticky' });
    const channel = within(form).getByRole('combobox');
    await waitFor(() => expect(within(channel).getByRole('option', { name: /tournament-signup/ })).toBeDisabled());
    await user.click(within(form).getByRole('button', { name: 'Save sticky' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Choose a channel.');
    await user.selectOptions(channel, GENERAL);
    await user.type(within(form).getByRole('textbox'), 'Be kind');
    await user.click(within(form).getByRole('button', { name: 'Save sticky' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/stickies')).toHaveLength(1));
    expect(harness.server.callsTo('POST /admin-tools/stickies')[0]!.body).toEqual({ channelId: GENERAL, enabled: true, debounceMs: 15_000, content: 'Be kind', embed: null });

    await user.click(within(list).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/#/);
    await user.click(within(dialog).getByRole('button', { name: 'Delete sticky' }));
    await waitFor(() => expect(harness.server.callsTo('DELETE /admin-tools/stickies/11111111-1111-4111-8111-111111111111')).toHaveLength(1));
  });

  it('creates through the dialog with a live preview, then highlights the new sticky', async () => {
    const user = userEvent.setup();
    const created = sticky({ id: '22222222-2222-4222-8222-222222222222', content: 'Be kind', status: null });
    const stickies = [sticky()];
    mountWith(<StickiesTab />, server => {
      routes(server);
      server.always('GET /admin-tools/stickies', () => json(200, { stickies: [...stickies] }));
      server.once('POST /admin-tools/stickies', () => { stickies.push(created); return json(201, created); });
    });
    await screen.findByRole('list', { name: 'Sticky messages' });
    await user.click(screen.getByRole('button', { name: /New sticky/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New sticky' });
    const preview = within(dialog).getByRole('figure', { name: 'Discord preview' });
    await user.selectOptions(within(dialog).getByRole('combobox'), GENERAL);
    await user.type(within(dialog).getByRole('textbox'), 'Be kind');
    expect(within(preview).getByText('Be kind')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('switch', { name: 'Add an embed' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Embed title' }), 'House rules');
    expect(within(preview).getByText('House rules')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save sticky' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New sticky' })).toBeNull());
    expect(await screen.findByText('Sticky created')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Sticky messages' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    const item = within(list).getAllByRole('listitem')[1]!;
    expect(item).toHaveTextContent('Be kind');
    expect(item).toHaveClass('ring-2');
    expect(within(list).getAllByRole('listitem')[0]).not.toHaveClass('ring-2');
  });
});

describe('channel controls', () => {
  it('formats purge results with the 14-day note', () => {
    expect(purgeMessage({ deleted: 1, skippedTooOld: 0 })).toBe('Deleted 1 message.');
    expect(purgeMessage({ deleted: 3, skippedTooOld: 2 })).toMatch(/2 older than 14 days/);
  });

  it('locks with a confirmed reason, then purges by member', async () => {
    const user = userEvent.setup();
    const harness = mountWith(<ChannelsTab />, server => {
      routes(server);
      server.always(`GET /admin-tools/channels/state/${GENERAL}`, () => json(200, { channelId: GENERAL, locked: false, slowmodeSeconds: 0 }));
      server.once('POST /admin-tools/channels/lock', () => json(200, { channelId: GENERAL, locked: true, slowmodeSeconds: 0 }));
      server.once('POST /admin-tools/channels/purge', () => json(200, { deleted: 4, skippedTooOld: 1 }));
    });
    await screen.findByRole('option', { name: '#general' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Channel' }), GENERAL);
    const controls = await screen.findByRole('region', { name: 'Channel controls' });
    await within(controls).findByText('Open');
    await user.click(within(controls).getByRole('button', { name: /^Lock/ }));
    let dialog = await screen.findByRole('alertdialog');
    const confirmLock = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirmLock).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'Round 3');
    await user.click(confirmLock);
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/channels/lock')).toHaveLength(1));
    expect(harness.server.callsTo('POST /admin-tools/channels/lock')[0]!.body).toEqual({ channelId: GENERAL, locked: true, reason: 'Round 3' });
    expect(await within(controls).findByText('Channel locked.')).toBeInTheDocument();
    expect(within(controls).getByText('Locked')).toBeInTheDocument();

    await user.click(within(controls).getByRole('radio', { name: 'By member' }));
    await user.click(within(controls).getByRole('button', { name: /Purge/ }));
    expect(within(controls).getByRole('alert')).toHaveTextContent(/Discord ID/);
    await user.type(within(controls).getByPlaceholderText('Discord ID'), '300000000000000050');
    await user.click(within(controls).getByRole('button', { name: /Purge/ }));
    dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Spam');
    await user.click(within(dialog).getByRole('button', { name: 'Delete messages' }));
    expect(await within(controls).findByText(/Deleted 4 messages\. 1 older than 14 days/)).toBeInTheDocument();
    expect(harness.server.callsTo('POST /admin-tools/channels/purge')[0]!.body)
      .toEqual({ channelId: GENERAL, mode: 'user', userId: '300000000000000050', count: 20, reason: 'Spam' });
  });

  it('hides the action buttons without members.moderate', async () => {
    mountWith(<ChannelsTab />, server => {
      routes(server, ['dashboard.read', 'members.read']);
      server.always(`GET /admin-tools/channels/state/${GENERAL}`, () => json(200, { channelId: GENERAL, locked: false, slowmodeSeconds: 0 }));
    });
    await screen.findByRole('option', { name: '#general' });
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Channel' }), GENERAL);
    const controls = await screen.findByRole('region', { name: 'Channel controls' });
    expect(within(controls).queryByRole('button', { name: /^Lock/ })).toBeNull();
  });

  it('creates a channel after a confirmed reason and selects it', async () => {
    const user = userEvent.setup();
    const NEW = '200000000000000399';
    const harness = mountWith(<ChannelsTab />, server => {
      routes(server);
      server.once('POST /admin-tools/channels/create', () => json(201, { id: NEW, name: 'side-events', type: 'text', parentId: null, position: 2, reserved: false }));
      server.always(`GET /admin-tools/channels/state/${NEW}`, () => json(200, { channelId: NEW, locked: false, slowmodeSeconds: 0 }));
    });
    await user.click(await screen.findByRole('button', { name: 'New channel' }));
    const dialog = await screen.findByRole('dialog', { name: 'New channel' });
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Side Events');
    // The reason is required, in the same step: nothing is sent without it.
    await user.click(within(dialog).getByRole('button', { name: 'Create channel' }));
    expect(await within(dialog).findByText('A reason is required.')).toBeInTheDocument();
    expect(harness.server.callsTo('POST /admin-tools/channels/create')).toHaveLength(0);
    await user.type(within(dialog).getByRole('textbox', { name: /^Reason/ }), 'New format');
    await user.click(within(dialog).getByRole('button', { name: 'Create channel' }));
    // One step: there is no second confirm dialog.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('Created #side-events')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New channel' })).toBeNull());
    expect(harness.server.callsTo('POST /admin-tools/channels/create')[0]!.body)
      .toEqual({ name: 'Side Events', type: 'text', parentId: null, reason: 'New format' });
    expect(await screen.findByRole('region', { name: 'Channel controls' })).toBeInTheDocument();
  });

  it('hides channel creation without server.manage', async () => {
    mountWith(<ChannelsTab />, server => routes(server, ['dashboard.read', 'members.read', 'members.moderate']));
    await screen.findByRole('option', { name: '#general' });
    expect(screen.queryByRole('button', { name: 'New channel' })).toBeNull();
  });
});
