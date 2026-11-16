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
// A selection made after the room pool: no M1 and M2, and a category choice instead.
const roomsSelection: SetupSelectionDto = { guildId: ids[0]!, channelId: ids[1]!, matchChannels: null,
  matchRooms: { categoryId: ids[2]!, createCategory: false }, adminId: ids[4]!, publicMatchRooms: true };
const roomsReady: SetupCheckDto = { ...ready, capabilities: [
  { slot: 'signup', channelId: ids[1]!, channelName: 'signup', missing: [] },
  { slot: 'rooms', channelId: ids[2]!, channelName: 'Matches', missing: [] }] };
const guilds = [{ id: ids[0]!, name: 'TCG Test', ownerId: ids[4]! }];
const channels = [
  { id: ids[1]!, name: 'signup', category: 'Tournament', type: 'text' },
  { id: ids[2]!, name: 'TCG Match 1', category: 'Tournament', type: 'voice' },
  { id: ids[3]!, name: 'TCG Match 2', category: 'Tournament', type: 'voice' },
  { id: '777777777777777777', name: 'Matches', category: null, type: 'category' }
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

it('guided setup chooses server, signup channel and a room category, checks readiness, then starts once', async () => {
  const user = userEvent.setup();
  const { server } = mountSetup({ prerequisite: null, activeEventId: null, selection: null,
    frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false }, roomsReady);
  expect(await screen.findByRole('heading', { name: 'Connect your tournament' })).toBeInTheDocument();
  await user.selectOptions(await screen.findByRole('combobox', { name: /Discord server/ }), ids[0]!);
  expect(screen.getByRole('textbox', { name: /Organizer Discord ID/ })).toHaveValue(ids[4]);
  await user.click(screen.getByRole('button', { name: 'Next: channels' }));
  await user.selectOptions(await screen.findByRole('combobox', { name: /Signup text channel/ }), ids[1]!);
  // No M1 or M2 pickers; a category picker (categories only) and the create switch instead.
  expect(screen.queryByRole('combobox', { name: /match voice room/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /New voice room/ })).not.toBeInTheDocument();
  const category = screen.getByRole('combobox', { name: /Put match rooms in/ });
  expect(within(category).getAllByRole('option').map(option => option.textContent)).toEqual(['No category', 'Matches']);
  await user.selectOptions(category, '777777777777777777');
  expect(screen.queryByText(/Your current rooms join the pool/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Check readiness' }));
  expect(await screen.findByText(/Manage Permissions: green Allow/)).toBeInTheDocument();
  expect(screen.getAllByText('Ready')).toHaveLength(2);
  expect(screen.getByText('Match rooms', { selector: 'p' })).toBeInTheDocument();
  const expected = { ...roomsSelection, matchRooms: { categoryId: '777777777777777777', createCategory: false } };
  expect(server.callsTo('POST /setup/check')[0]?.body).toEqual(expected);
  await user.click(screen.getByRole('button', { name: 'Save and Start' }));
  expect(await screen.findByText('Setup complete. Opening dashboard…')).toBeInTheDocument();
  expect(server.callsTo('POST /setup/finish')[0]?.body).toEqual(expected);
});

it('"Create a TCG Live — Matches category" replaces the picked category', async () => {
  const user = userEvent.setup();
  const { server } = mountSetup({ prerequisite: null, activeEventId: null, selection: null,
    frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false }, roomsReady);
  await user.selectOptions(await screen.findByRole('combobox', { name: /Discord server/ }), ids[0]!);
  await user.click(screen.getByRole('button', { name: 'Next: channels' }));
  await user.selectOptions(await screen.findByRole('combobox', { name: /Signup text channel/ }), ids[1]!);
  await screen.findByRole('option', { name: 'Matches' });
  await user.selectOptions(screen.getByRole('combobox', { name: /Put match rooms in/ }), '777777777777777777');
  const create = screen.getByRole('switch', { name: 'Create a “TCG Live — Matches” category' });
  await user.click(create);
  expect(create).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('combobox', { name: /Put match rooms in/ })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Check readiness' }));
  await screen.findByText(/Manage Permissions: green Allow/);
  expect(server.callsTo('POST /setup/check')[0]?.body).toEqual({ ...roomsSelection, matchRooms: { categoryId: null, createCategory: true } });
});

it('bot-managed rooms are always public: a new setup has no Public match rooms switch, a legacy one keeps it', async () => {
  const user = userEvent.setup();
  mountSetup({ prerequisite: null, activeEventId: null, selection: roomsSelection, frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false });
  await user.click(await screen.findByRole('button', { name: 'Next: channels' }));
  await screen.findByRole('combobox', { name: /Put match rooms in/ });
  expect(screen.queryByRole('switch', { name: 'Public match rooms' })).not.toBeInTheDocument();
  expect(screen.getByText(/always public/)).toBeInTheDocument();
});

it('a legacy selection keeps the Public match rooms switch', async () => {
  const user = userEvent.setup();
  mountSetup({ prerequisite: null, activeEventId: null, selection, frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false });
  await user.click(await screen.findByRole('button', { name: 'Next: channels' }));
  expect(await screen.findByRole('switch', { name: 'Public match rooms' })).toBeEnabled();
});

it('a legacy selection shows the pool note, no pickers, and is sent back unchanged', async () => {
  const user = userEvent.setup();
  const { server } = mountSetup({ prerequisite: null, activeEventId: null, selection,
    frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false });
  await user.click(await screen.findByRole('button', { name: 'Next: channels' }));
  expect(await screen.findByText('Your current rooms join the pool and get the room naming at the next event.')).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: /match voice room/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Check readiness' }));
  expect(await screen.findByText(/Manage Permissions: green Allow/)).toBeInTheDocument();
  // The server still reports the old rows for a legacy check.
  expect(screen.getAllByText('Ready')).toHaveLength(3);
  expect(server.callsTo('POST /setup/check')[0]?.body).toEqual(selection);
});

it('a check without a room row still shows a Match rooms row for the chosen category', async () => {
  const user = userEvent.setup();
  mountSetup({ prerequisite: null, activeEventId: null, selection: roomsSelection, frozen: false, botName: 'BoBoAssist', check: null,
    openingDashboard: false }, { ...roomsReady, capabilities: [] });
  await user.click(await screen.findByRole('button', { name: 'Next: channels' }));
  await user.click(screen.getByRole('button', { name: 'Check readiness' }));
  const readiness = await screen.findByRole('region', { name: 'Readiness' });
  expect(within(readiness).getByText('Match rooms', { selector: 'p' })).toBeInTheDocument();
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

it('creates a missing signup channel from the wizard and selects it', async () => {
  const user = userEvent.setup();
  const { server } = mountSetup({ prerequisite: null, activeEventId: null, selection: null,
    frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false });
  server.once('POST /setup/channels', () => json(201, { id: '666666666666666666', name: 'tcg-signups', category: null, type: 'text' }));
  server.once('POST /setup/channels', () => json(403, { error: { code: 'forbidden', message: 'The bot needs the Manage Channels permission in this server to create channels.' } }));
  await user.selectOptions(await screen.findByRole('combobox', { name: /Discord server/ }), ids[0]!);
  await user.click(screen.getByRole('button', { name: 'Next: channels' }));
  await screen.findByRole('option', { name: 'signup' });
  await user.click(screen.getByRole('button', { name: /New text channel/ }));
  const text = await screen.findByRole('dialog', { name: 'New text channel' });
  const name = within(text).getByRole('textbox', { name: /New text channel name/ });
  await user.clear(name);
  await user.type(name, 'tcg-signups');
  await user.click(within(text).getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: /Signup text channel/ })).toHaveValue('666666666666666666'));
  expect(server.callsTo('POST /setup/channels')[0]?.body).toEqual({ guildId: ids[0], name: 'tcg-signups', type: 'text' });
  await user.click(screen.getByRole('button', { name: /New text channel/ }));
  const again = await screen.findByRole('dialog', { name: 'New text channel' });
  await user.click(within(again).getByRole('button', { name: 'Create' }));
  expect(await within(again).findByRole('alert')).toHaveTextContent(/Manage Channels/);
});

it('pressing Enter twice while Discord is creating a channel sends one request', async () => {
  const user = userEvent.setup();
  const { server } = mountSetup({ prerequisite: null, activeEventId: null, selection: null,
    frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  server.once('POST /setup/channels', async () => { await gate; return json(201, { id: '666666666666666667', name: 'tcg-signup', category: null, type: 'text' }); });
  await user.selectOptions(await screen.findByRole('combobox', { name: /Discord server/ }), ids[0]!);
  await user.click(screen.getByRole('button', { name: 'Next: channels' }));
  await screen.findByRole('option', { name: 'signup' });
  await user.click(screen.getByRole('button', { name: /New text channel/ }));
  const group = await screen.findByRole('dialog', { name: 'New text channel' });
  const name = within(group).getByRole('textbox', { name: /New text channel name/ });
  await user.type(name, '{Enter}{Enter}');
  await user.click(within(group).getByRole('button', { name: 'Create' }));
  release();
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New text channel' })).not.toBeInTheDocument());
  expect(server.callsTo('POST /setup/channels')).toHaveLength(1);
});

it('the organizer field says it gets the TCG Organizer role and may play', async () => {
  const user = userEvent.setup();
  mountSetup({ prerequisite: null, activeEventId: null, selection: null,
    frozen: false, botName: 'BoBoAssist', check: null, openingDashboard: false });
  await user.selectOptions(await screen.findByRole('combobox', { name: /Discord server/ }), ids[0]!);
  expect(screen.getByText(/Gets the TCG Organizer role and may also play/)).toBeInTheDocument();
  expect(screen.queryByText(/cannot join as a player/)).not.toBeInTheDocument();
});

it('step 3 reports the roles result, with the fallback when creation failed', async () => {
  const user = userEvent.setup();
  renderConsole({ setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, setup: true }));
    server.always('GET /setup', () => json(200, { prerequisite: null, activeEventId: null, selection,
      frozen: false, botName: 'BoBoAssist', check: ready, openingDashboard: false }));
    server.always('GET /setup/guilds', () => json(200, guilds));
    server.always('GET /setup/channels', () => json(200, channels));
    server.always('POST /setup/check', () => json(200, ready));
    server.always('POST /setup/finish', () => json(200, { openingDashboard: true, eventId: 'event',
      roles: { organizer: 'created', judge: 'failed', assigned: ids[4], problem: 'The bot needs Manage Roles.' } }));
  } });
  await user.click(await screen.findByRole('button', { name: 'Next: channels' }));
  await user.click(screen.getByRole('button', { name: 'Check readiness' }));
  expect(await screen.findByText(/also creates the/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save and Start' }));
  const roles = await screen.findByRole('alert', { name: 'Tournament roles' });
  expect(roles).toHaveTextContent('TCG Organizer: created.');
  expect(roles).toHaveTextContent('TCG Judge: could not be created.');
  expect(roles).toHaveTextContent('The bot needs Manage Roles.');
  expect(roles).toHaveTextContent('only the server owner and this dashboard act as organizer');
});

it('step 3 shows a room settings problem without failing setup', async () => {
  const user = userEvent.setup();
  renderConsole({ setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, setup: true }));
    server.always('GET /setup', () => json(200, { prerequisite: null, activeEventId: null, selection: roomsSelection,
      frozen: false, botName: 'BoBoAssist', check: roomsReady, openingDashboard: false }));
    server.always('GET /setup/guilds', () => json(200, guilds));
    server.always('GET /setup/channels', () => json(200, channels));
    server.always('POST /setup/check', () => json(200, roomsReady));
    server.always('POST /setup/finish', () => json(200, { openingDashboard: true, eventId: 'event',
      rooms: { problem: 'The bot needs Manage Channels to create the category.' } }));
  } });
  await user.click(await screen.findByRole('button', { name: 'Next: channels' }));
  await user.click(screen.getByRole('button', { name: 'Check readiness' }));
  await user.click(await screen.findByRole('button', { name: 'Save and Start' }));
  const rooms = await screen.findByRole('alert', { name: 'Match rooms' });
  expect(rooms).toHaveTextContent('The bot needs Manage Channels to create the category.');
  expect(screen.getByText('Setup complete. Opening dashboard…')).toBeInTheDocument();
});
