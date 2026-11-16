import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { SetupCheckDto, SetupSelectionDto } from '@tcg-live/core';
import { renderConsole, sessionFixture } from '../../app/testing';
import { json } from '../../data/test/fakes';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333',
  '444444444444444444', '555555555555555555'];
const selection: SetupSelectionDto = { guildId: ids[0]!, channelId: ids[1]!,
  matchChannels: { M1: ids[2]!, M2: ids[3]! }, adminId: ids[4]!, publicMatchRooms: true };
const ready: SetupCheckDto = { valid: true, frozen: false, botName: 'BoBoAssist', issues: [],
  guide: 'Edit each named match channel → Permissions → add/select the bot member itself → Manage Permissions: green Allow → Save Changes.',
  notice: 'posted', capabilities: [
    { slot: 'signup', channelId: ids[1]!, channelName: 'signup', missing: [] },
    { slot: 'M1', channelId: ids[2]!, channelName: 'TCG Match 1', missing: [] },
    { slot: 'M2', channelId: ids[3]!, channelName: 'TCG Match 2', missing: [] }
  ] };
const guilds = [{ id: ids[0]!, name: 'TCG Test', ownerId: ids[4]! }];
const channels = [
  { id: ids[1]!, name: 'signup', category: 'Tournament', type: 'text' },
  { id: ids[2]!, name: 'TCG Match 1', category: 'Tournament', type: 'voice' },
  { id: ids[3]!, name: 'TCG Match 2', category: 'Tournament', type: 'voice' }
];

function mountSetup(status: object, check = ready) {
  return renderConsole({ setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, setup: true }));
    server.always('GET /setup', () => json(200, status));
    server.always('GET /setup/guilds', () => json(200, guilds));
    server.always('GET /setup/channels', () => json(200, channels));
    server.always('POST /setup/check', () => json(200, check));
    server.always('POST /setup/finish', () => json(200, { openingDashboard: true, eventId: 'event' }));
  } });
}

it('guided setup chooses server and channels, checks readiness, then starts once', async () => {
  const user = userEvent.setup();
  const { server } = mountSetup({ prerequisite: null, activeEventId: null, selection: null,
    frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false });
  expect(await screen.findByRole('heading', { name: 'Connect your tournament' })).toBeInTheDocument();
  await user.selectOptions(await screen.findByRole('combobox', { name: /Discord server/ }), ids[0]!);
  expect(screen.getByRole('textbox', { name: /Organizer Discord ID/ })).toHaveValue(ids[4]);
  await user.click(screen.getByRole('button', { name: 'Next: channels' }));
  await user.selectOptions(await screen.findByRole('combobox', { name: /Signup text channel/ }), ids[1]!);
  await user.selectOptions(screen.getByRole('combobox', { name: /M1 match voice room/ }), ids[2]!);
  await user.selectOptions(screen.getByRole('combobox', { name: /M2 match voice room/ }), ids[3]!);
  await user.click(screen.getByRole('button', { name: 'Check readiness' }));
  expect(await screen.findByText(/Manage Permissions: green Allow/)).toBeInTheDocument();
  expect(screen.getAllByText('Ready')).toHaveLength(3);
  expect(server.callsTo('POST /setup/check')[0]?.body).toEqual(selection);
  await user.click(screen.getByRole('button', { name: 'Save and Start' }));
  expect(await screen.findByText('Setup complete. Opening dashboard…')).toBeInTheDocument();
  expect(server.callsTo('POST /setup/finish')[0]?.body).toEqual(selection);
});

it('frozen active setup locks saved destinations and preserves private mode', async () => {
  const user = userEvent.setup();
  mountSetup({ prerequisite: null, activeEventId: 'event', selection: { ...selection, publicMatchRooms: false },
    frozen: true, botName: 'BoBoAssist', check: { ...ready, frozen: true }, openingDashboard: false });
  expect(await screen.findByText(/Active event event is preserved/)).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: /Discord server/ })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Next: channels' }));
  expect(screen.getByRole('combobox', { name: /Signup text channel/ })).toBeDisabled();
  expect(screen.getByRole('switch', { name: 'Public match rooms' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByRole('switch', { name: 'Public match rooms' })).toBeDisabled();
});

it('missing prerequisites remain visible without proposing fake channels or a start action', async () => {
  mountSetup({ prerequisite: 'Set TCG_DISCORD_TOKEN in the local .env file.', activeEventId: null,
    selection: null, frozen: false, botName: null, check: null, openingDashboard: false });
  expect(await screen.findByText('Set TCG_DISCORD_TOKEN in the local .env file.')).toHaveAttribute('role', 'alert');
  expect(screen.queryByRole('button', { name: 'Save and Start' })).not.toBeInTheDocument();
});

it('ordinary signed-in sessions never call setup routes', async () => {
  const { server } = renderConsole();
  await screen.findByRole('heading', { name: /Needs you/ });
  await waitFor(() => expect(server.callsTo('GET /session').length).toBeGreaterThan(0));
  expect(server.calls.filter(call => call.url.includes('/setup'))).toHaveLength(0);
});

it('Refresh reloads the channel list without overwriting choices in progress', async () => {
  const user = userEvent.setup();
  const { server } = mountSetup({ prerequisite: null, activeEventId: null, selection: null,
    frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false });
  await user.selectOptions(await screen.findByRole('combobox', { name: /Discord server/ }), ids[0]!);
  await user.click(screen.getByRole('button', { name: 'Next: channels' }));
  await user.selectOptions(await screen.findByRole('combobox', { name: /Signup text channel/ }), ids[1]!);
  expect(server.callsTo('GET /setup/channels')).toHaveLength(1);
  // The bot was granted another channel, and the server now reports a different saved selection.
  server.always('GET /setup/channels', () => json(200, [...channels,
    { id: '666666666666666666', name: 'late-signups', category: 'Tournament', type: 'text' }]));
  server.always('GET /setup', () => json(200, { prerequisite: null, activeEventId: null, frozen: false,
    selection: { ...selection, channelId: ids[0]! }, botName: 'BoBoAssist', check: null, openingDashboard: false }));
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('option', { name: 'late-signups' })).toBeInTheDocument();
  expect(server.callsTo('GET /setup/channels')).toHaveLength(2);
  expect(screen.getByRole('combobox', { name: /Signup text channel/ })).toHaveValue(ids[1]);
});

const localSettings = (dashboardActions: boolean, voice = false) => ({
  dashboardActions: { enabled: dashboardActions, saved: dashboardActions, forcedByEnv: false },
  voiceMonitoring: { saved: voice, running: null, forcedByEnv: false, restartRequired: false } });

it('readiness offers the dashboard switches, and Save and Start ends on What’s next', async () => {
  const user = userEvent.setup();
  const { server } = renderConsole({ setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', setup: true, localSettings: true }));
    server.always('GET /setup', () => json(200, { prerequisite: null, activeEventId: null, selection,
      frozen: false, botName: 'BoBoAssist', check: ready, openingDashboard: false }));
    server.always('GET /setup/guilds', () => json(200, guilds));
    server.always('GET /setup/channels', () => json(200, channels));
    server.always('POST /setup/check', () => json(200, ready));
    server.always('POST /setup/finish', () => json(200, { openingDashboard: true, eventId: 'event' }));
    server.always('GET /settings/local', () => json(200, localSettings(true)));
    server.always('PUT /settings/local', call => json(200, localSettings(
      (call.body as { dashboardActions?: boolean }).dashboardActions ?? true, (call.body as { voiceMonitoring?: boolean }).voiceMonitoring)));
  } });
  await user.click(await screen.findByRole('button', { name: 'Next: channels' }));
  await user.click(screen.getByRole('button', { name: 'Check readiness' }));
  const actions = await screen.findByRole('switch', { name: 'Allow dashboard actions' });
  await waitFor(() => expect(actions).toHaveAttribute('aria-checked', 'true'));
  await user.click(actions);
  await waitFor(() => expect(server.callsTo('PUT /settings/local')[0]?.body).toEqual({ dashboardActions: false }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Allow dashboard actions' })).toHaveAttribute('aria-checked', 'false'));
  await user.click(screen.getByRole('switch', { name: 'Voice monitoring' }));
  await waitFor(() => expect(server.callsTo('PUT /settings/local')[1]?.body).toEqual({ voiceMonitoring: true }));
  await user.click(screen.getByRole('button', { name: 'Save and Start' }));
  const next = await screen.findByRole('region', { name: 'What’s next' });
  expect(next).toHaveTextContent('Setup complete. Opening dashboard…');
  for (const name of ['Admin tools', 'Moderation & evidence', 'Helper bots', 'Looking for a game (LFG)', 'Capabilities'])
    expect(next).toHaveTextContent(name);
  expect(within(next).getByText('Bot setup guide')).toBeInTheDocument();
});

it('sessions without local settings show no switches and never call the settings route', async () => {
  const user = userEvent.setup();
  const { server } = mountSetup({ prerequisite: null, activeEventId: null, selection,
    frozen: false, botName: 'BoBoAssist', check: ready, openingDashboard: false });
  await user.click(await screen.findByRole('button', { name: 'Next: channels' }));
  await user.click(screen.getByRole('button', { name: 'Check readiness' }));
  await screen.findByRole('button', { name: 'Save and Start' });
  expect(screen.queryByRole('switch', { name: 'Allow dashboard actions' })).not.toBeInTheDocument();
  expect(server.callsTo('GET /settings/local')).toHaveLength(0);
});

it('creates missing channels from the wizard and selects them in their slots', async () => {
  const user = userEvent.setup();
  const { server } = mountSetup({ prerequisite: null, activeEventId: null, selection: null,
    frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false });
  server.once('POST /setup/channels', () => json(201, { id: '666666666666666666', name: 'TCG Match 3', category: null, type: 'voice' }));
  server.once('POST /setup/channels', () => json(403, { error: { code: 'forbidden', message: 'The bot needs the Manage Channels permission in this server to create channels.' } }));
  await user.selectOptions(await screen.findByRole('combobox', { name: /Discord server/ }), ids[0]!);
  await user.click(screen.getByRole('button', { name: 'Next: channels' }));
  await screen.findByRole('option', { name: 'signup' });
  const m1 = screen.getAllByRole('button', { name: /New voice room/ })[0]!;
  await user.click(m1);
  const group = screen.getByRole('group', { name: 'Create a voice room' });
  const name = within(group).getByRole('textbox', { name: /New voice room name/ });
  expect(name).toHaveValue('TCG Match 1');
  await user.clear(name);
  await user.type(name, 'TCG Match 3');
  await user.click(within(group).getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: /M1 match voice room/ })).toHaveValue('666666666666666666'));
  expect(server.callsTo('POST /setup/channels')[0]?.body).toEqual({ guildId: ids[0], name: 'TCG Match 3', type: 'voice' });
  await user.click(screen.getByRole('button', { name: /New text channel/ }));
  const text = screen.getByRole('group', { name: 'Create a text channel' });
  await user.click(within(text).getByRole('button', { name: 'Create' }));
  expect(await within(text).findByRole('alert')).toHaveTextContent(/Manage Channels/);
});
