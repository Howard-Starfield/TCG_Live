import { screen, waitFor } from '@testing-library/react';
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
