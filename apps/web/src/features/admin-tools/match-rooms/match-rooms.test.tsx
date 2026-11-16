import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, MATCH_ROOM_RENAME_NOTICE, type AdminToolsSettingsBodyDto, type CleanupPlanDto,
  type MatchRoomDto, type MatchRoomsDto, type MatchRoomTranscriptDto } from '@tcg-live/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROOMS_POLL_MS } from './api';
import { createHarness, sessionFixture } from '../../../app/testing';
import { AdminDataProvider } from '../../../data';
import { json, type FakeServer } from '../../../data/test/fakes';
import { ToastProvider } from '../../../ui';
import { adminToolsTabs } from '../registry';
import { transcriptRows, TranscriptExportButtons } from './TranscriptExport';
import { MatchRoomsTab, MEMORY_STORAGE_HINT } from './MatchRoomsTab';

MotionGlobalConfig.skipAnimations = true;

const GUILD = '100000000000000001';
const CAT = '300000000000000001';
const GENERAL = '300000000000000002';
const PRACTICE = '300000000000000003';
const channelOf = (table: number) => `2000000000000000${String(table).padStart(2, '0')}`;

const room = (table: number, patch: Partial<MatchRoomDto> = {}): MatchRoomDto => ({ channelId: channelOf(table), table, categoryId: CAT, origin: 'created',
  name: `🎮 M${table}`, missing: false, customName: null, templateName: `🎮 M${table}`, pendingName: null,
  rename: { state: 'synced', nextAttemptAtMs: null, error: null }, assignedMatch: null, connected: null, recording: null, removeBlockedReason: null, ...patch });

const dto = (patch: Partial<MatchRoomsDto> = {}): MatchRoomsDto => ({ guildId: GUILD, storage: 'postgres', canManageChannels: true, problem: null,
  activeEventId: 'event-1', eventName: 'Friday Night', gameLabel: 'One Piece', round: 1, freeChannelSlots: 312,
  settings: { version: 4, template: '🎮 {match}', categoryId: CAT, categoryName: 'Matches', pendingCategoryName: null, baselineChannelIds: [CAT, GENERAL],
    baselineCapturedAtMs: 1 },
  categories: [{ categoryId: CAT, name: 'Matches', from: 1, to: 50, origin: 'configured', missing: false }],
  rooms: [room(1, { assignedMatch: 'M1', connected: [{ id: '400000000000000001', displayName: 'Ann', avatarUrl: null }], recording: 'recording' }), room(2)],
  baseline: [
    { id: CAT, name: 'Matches', type: 'category', inBaseline: true, botCreated: false },
    { id: GENERAL, name: 'General voice', type: 'voice', inBaseline: true, botCreated: false },
    { id: PRACTICE, name: 'Practice', type: 'voice', inBaseline: false, botCreated: false },
    { id: channelOf(1), name: '🎮 M1', type: 'voice', inBaseline: false, botCreated: true }],
  ...patch });

function routes(server: FakeServer, state: { dto: MatchRoomsDto }, canManage = true) {
  server.always('GET /session', () => json(200, { ...sessionFixture, adminTools: true,
    capabilities: canManage ? [...CAPABILITIES] : ['members.read', 'dashboard.read'] }));
  server.always('GET /admin-tools/settings', () => json(200, { guildId: GUILD, version: 0, updatedAtMs: null,
    ...structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto }));
  server.always('GET /admin-tools/match-rooms', () => json(200, structuredClone(state.dto)));
  server.always('GET /events', () => json(200, []));
}
function mount(setup: (server: FakeServer) => void, ui = <MatchRoomsTab />) {
  const harness = createHarness({ stream: false, setup });
  render(<ToastProvider><AdminDataProvider data={harness.data}>{ui}</AdminDataProvider></ToastProvider>);
  return harness;
}
const roomRow = async (table: number) => within(await screen.findByRole('listitem', { name: `Table ${table}` }));

afterEach(() => { vi.unstubAllGlobals(); });

describe('Rooms tab', () => {
  it('is a tab of Admin tools that anyone who can read members sees', () => {
    expect(adminToolsTabs.find(tab => tab.id === 'rooms')).toMatchObject({ label: 'Rooms', capability: 'members.read' });
  });

  it('groups rooms by category with their range, and shows names, match, who is connected and recording', async () => {
    mount(server => routes(server, { dto: dto() }));
    const group = within(await screen.findByRole('region', { name: 'Matches' }));
    expect(group.getByText('Tables 1–50')).toBeInTheDocument();
    const one = await roomRow(1);
    expect(one.getByText('🎮 M1')).toBeInTheDocument();
    expect(one.getByText('Playing M1')).toBeInTheDocument();
    expect(one.getByText('Recording')).toBeInTheDocument();
    expect(one.getByLabelText('Connected to Table 1')).toHaveTextContent('Ann');
    const two = await roomRow(2);
    expect(two.getByText('Free')).toBeInTheDocument();
    expect(two.getByText(/Who is connected: not available/)).toBeInTheDocument();
    expect(two.getByText(/Named by the template/)).toBeInTheDocument();
  });

  it('shows how many of the 500 server channels are free', async () => {
    mount(server => routes(server, { dto: dto({ freeChannelSlots: 12 }) }));
    expect(await screen.findByText('12 of 500 server channels free')).toBeInTheDocument();
    const meter = screen.getByRole('meter', { name: 'Free server channels' });
    expect(meter).toHaveAttribute('aria-valuenow', '12');
    expect(meter).toHaveAttribute('aria-valuemax', '500');
  });

  it('shows the storage hint, and the problem the server reports', async () => {
    mount(server => routes(server, { dto: dto({ storage: 'memory', problem: 'The bot lacks Manage Channels.' }) }));
    expect(await screen.findByText(MEMORY_STORAGE_HINT)).toBeInTheDocument();
    expect(screen.getByText('The bot lacks Manage Channels.').closest('[role="alert"]')).not.toBeNull();
  });

  it('answers a 503 with the server text instead of an empty tab', async () => {
    mount(server => {
      routes(server, { dto: dto() });
      server.always('GET /admin-tools/match-rooms', () => json(503, { error: { code: 'unavailable', message: 'Rooms are available once the bot is connected' } }));
    });
    expect(await screen.findByText(/Rooms are available once the bot is connected/)).toBeInTheDocument();
  });

  it('renames a room inline, then shows the queued notice and when the next attempt is', async () => {
    const user = userEvent.setup();
    const next = Date.UTC(2026, 10, 16, 20, 15, 0);
    const { server } = mount(server => routes(server, { dto: dto() }));
    server.always('PATCH /admin-tools/match-rooms/rooms/' + channelOf(2), () => json(200, room(2, { customName: 'Feature table', pendingName: 'Feature table',
      rename: { state: 'queued', nextAttemptAtMs: next, error: null } })));
    const two = await roomRow(2);
    await user.click(two.getByRole('button', { name: 'Rename Table 2' }));
    const input = two.getByRole('textbox', { name: 'New name for Table 2' });
    await user.clear(input);
    expect(two.getByRole('button', { name: 'Save name' })).toBeDisabled();
    await user.type(input, 'Feature table');
    await user.click(two.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(server.callsTo('PATCH /admin-tools/match-rooms/rooms/' + channelOf(2))[0]?.body).toEqual({ customName: 'Feature table' }));
    const status = await screen.findByText(MATCH_ROOM_RENAME_NOTICE, { exact: false });
    expect(status).toHaveTextContent('Renaming to “Feature table”');
    expect(status).toHaveTextContent(/Next attempt at \d\d:\d\d:\d\d/);
    expect(screen.queryByRole('textbox', { name: 'New name for Table 2' })).not.toBeInTheDocument();
  });

  it('refuses an unreadable room name without calling the server', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => routes(server, { dto: dto() }));
    const two = await roomRow(2);
    await user.click(two.getByRole('button', { name: 'Rename Table 2' }));
    const input = two.getByRole('textbox', { name: 'New name for Table 2' });
    fireEvent.change(input, { target: { value: 'x'.repeat(100) } });
    expect(two.getByRole('button', { name: 'Save name' })).toBeEnabled();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(two.getByRole('alert')).toHaveTextContent('Enter a room name.');
    expect(two.getByRole('button', { name: 'Save name' })).toBeDisabled();
    expect(server.callsTo('PATCH /admin-tools/match-rooms/rooms/' + channelOf(2))).toHaveLength(0);
  });

  it('"Use template" clears a custom name', async () => {
    const user = userEvent.setup();
    const state = { dto: dto({ rooms: [room(1, { customName: 'Finals', name: 'Finals' })] }) };
    const { server } = mount(server => routes(server, state));
    server.always('PATCH /admin-tools/match-rooms/rooms/' + channelOf(1), () => json(200, room(1, { name: 'Finals', pendingName: '🎮 M1',
      rename: { state: 'queued', nextAttemptAtMs: null, error: null } })));
    const one = await roomRow(1);
    expect(one.getByText('Custom name')).toBeInTheDocument();
    await user.click(one.getByRole('button', { name: 'Use template for Table 1' }));
    await waitFor(() => expect(server.callsTo('PATCH /admin-tools/match-rooms/rooms/' + channelOf(1))[0]?.body).toEqual({ customName: null }));
    expect(await screen.findByText(MATCH_ROOM_RENAME_NOTICE, { exact: false })).toHaveTextContent('Renaming to “🎮 M1”');
  });

  it('shows a failed rename and a room deleted in Discord', async () => {
    mount(server => routes(server, { dto: dto({ rooms: [
      room(1, { pendingName: '🎮 M1', rename: { state: 'failed', nextAttemptAtMs: null, error: 'Missing Manage Channels' } }),
      room(2, { name: null, missing: true })] }) }));
    expect((await (await roomRow(1)).findByRole('alert'))).toHaveTextContent('The rename failed: Missing Manage Channels');
    const two = await roomRow(2);
    expect(two.getByText('Missing in Discord')).toBeInTheDocument();
    expect(two.queryByRole('button', { name: 'Rename Table 2' })).not.toBeInTheDocument();
  });

  it('removes a room from the pool only after a confirmation, and says why it cannot when it is in use', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => routes(server, { dto: dto({ rooms: [room(1, { removeBlockedReason: 'In use by match M1.' }), room(2)] }) }));
    server.always('DELETE /admin-tools/match-rooms/rooms/' + channelOf(2), () => json(200, { applied: true }));
    const one = await roomRow(1);
    expect(one.getByRole('button', { name: 'Remove Table 1 from the pool' })).toBeDisabled();
    expect(one.getByText('In use by match M1.')).toBeInTheDocument();
    const two = await roomRow(2);
    const button = two.getByRole('button', { name: 'Remove Table 2 from the pool' });
    await user.click(button);
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Table 2 from the pool?' });
    expect(dialog).toHaveTextContent('The voice channel stays in Discord. Clean-up will no longer delete it; delete it yourself if you don’t need it.');
    await user.click(within(dialog).getByRole('button', { name: 'Remove from pool' }));
    await waitFor(() => expect(server.callsTo('DELETE /admin-tools/match-rooms/rooms/' + channelOf(2))).toHaveLength(1));
  });

  it('says an adopted room keeps its current name when removed', async () => {
    const user = userEvent.setup();
    mount(server => routes(server, { dto: dto({ rooms: [room(1, { origin: 'adopted' })] }) }));
    await user.click((await roomRow(1)).getByRole('button', { name: 'Remove Table 1 from the pool' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('It keeps its current name and permissions; clean-up will not restore its original name.');
  });

  it('polls while a rename is waiting, but not once it has failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const state = { dto: dto({ rooms: [room(1, { pendingName: 'x', rename: { state: 'failed', nextAttemptAtMs: null, error: 'no' } })] }) };
      const { server } = mount(server => routes(server, state));
      await screen.findByRole('region', { name: 'Matches' });
      await vi.advanceTimersByTimeAsync(ROOMS_POLL_MS * 3);
      expect(server.callsTo('GET /admin-tools/match-rooms')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('keeps polling while a rename is queued', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { server } = mount(server => routes(server, { dto: dto({ rooms: [room(1, { pendingName: 'x', rename: { state: 'queued', nextAttemptAtMs: null, error: null } })] }) }));
      await screen.findByRole('region', { name: 'Matches' });
      await vi.advanceTimersByTimeAsync(ROOMS_POLL_MS + 500);
      expect(server.callsTo('GET /admin-tools/match-rooms').length).toBeGreaterThanOrEqual(2);
    } finally { vi.useRealTimers(); }
  });

  it('is read-only without server.manage', async () => {
    mount(server => routes(server, { dto: dto() }, false));
    await screen.findByRole('region', { name: 'Matches' });
    expect(screen.getByText(/Changing them needs the server management capability/)).toBeInTheDocument();
    for (const name of ['Create missing rooms', 'Add an existing voice channel', 'Save settings', 'Save baseline', 'Rename Table 1'])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clean up after tournament' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /Room name template/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /General voice/ })).toBeDisabled();
  });
});

describe('room settings: template and category', () => {
  const settingsRegion = async () => within(await screen.findByRole('region', { name: 'Room settings' }));

  it('previews names from the core renderer with the event and game, and refuses {stage}', async () => {
    mount(server => routes(server, { dto: dto() }));
    const card = await settingsRegion();
    const input = card.getByRole('textbox', { name: /Room name template/ });
    const preview = within(card.getByRole('region', { name: 'Name preview' }));
    expect(preview.getAllByRole('listitem').map(item => item.textContent)).toEqual(['🎮 M1', '🎮 M2', '🎮 M3']);
    fireEvent.change(input, { target: { value: '{table} · {round} · {game}' } });
    expect(preview.getAllByRole('listitem').map(item => item.textContent)).toEqual(
      ['Table 1 · Round 1 · One Piece', 'Table 2 · Round 1 · One Piece', 'Table 3 · Round 1 · One Piece']);
    fireEvent.change(input, { target: { value: '{stage} {match}' } });
    expect(card.getByText('{stage} is coming with brackets.')).toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    expect(preview.queryByRole('listitem')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Room' } });
    expect(card.getByText(/Include \{match\}, \{n\} or \{table\}/)).toBeInTheDocument();
  });

  it('presets fill the template, and saving sends the version with the category and baseline as they were', async () => {
    const user = userEvent.setup();
    const state = { dto: dto() };
    const { server } = mount(server => routes(server, state));
    server.always('PUT /admin-tools/match-rooms/settings', () => json(200, dto({ settings: { ...state.dto.settings, version: 5, template: '⚔️ {round} · {match}' },
      rooms: [room(1, { pendingName: '⚔️ Round 1 · M1', rename: { state: 'queued', nextAttemptAtMs: null, error: null } })] })));
    const card = await settingsRegion();
    for (const preset of ['🎮 {match}', '{table} · {round}', '⚔️ {round} · {match}'])
      expect(card.getByRole('button', { name: `Use preset ${preset}` })).toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Use preset 🎮 {match}' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(card.getByRole('button', { name: 'Use preset ⚔️ {round} · {match}' }));
    expect(card.getByRole('textbox', { name: /Room name template/ })).toHaveValue('⚔️ {round} · {match}');
    expect(card.getByText(/Saving renames the rooms right away/)).toHaveTextContent(MATCH_ROOM_RENAME_NOTICE);
    expect(within(card.getByRole('region', { name: 'Name preview' })).getAllByRole('listitem')[0]).toHaveTextContent('⚔️ Round 1 · M1');
    await user.click(card.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(server.callsTo('PUT /admin-tools/match-rooms/settings')[0]?.body).toEqual({ expectedVersion: 4, template: '⚔️ {round} · {match}',
      categoryId: CAT, createCategory: null, baselineChannelIds: [CAT, GENERAL] }));
    expect(await card.findByRole('status')).toHaveTextContent(`Settings saved. ${MATCH_ROOM_RENAME_NOTICE}`);
  });

  it('creates a category from the picker', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => routes(server, { dto: dto() }));
    server.always('PUT /admin-tools/match-rooms/settings', () => json(200, dto({ settings: { ...dto().settings, version: 5, categoryId: null, categoryName: null,
      pendingCategoryName: 'Finals rooms' } })));
    const card = await settingsRegion();
    await user.selectOptions(card.getByRole('combobox', { name: /Put match rooms in/ }), 'Create a new category…');
    const name = card.getByRole('textbox', { name: 'New category name' });
    expect(name).toHaveValue('TCG Live — Matches');
    fireEvent.change(name, { target: { value: 'Finals rooms' } });
    await user.click(card.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(server.callsTo('PUT /admin-tools/match-rooms/settings')[0]?.body).toMatchObject({ categoryId: null, createCategory: 'Finals rooms' }));
    expect(await card.findByText('“Finals rooms” is created with the next rooms.')).toBeInTheDocument();
  });

  it('shows a saved category that no longer exists as missing, so it can be changed', async () => {
    mount(server => routes(server, { dto: dto({ settings: { ...dto().settings, categoryId: '300000000000009999', categoryName: null } }) }));
    const card = within(await screen.findByRole('region', { name: 'Room settings' }));
    const select = card.getByRole('combobox', { name: /Put match rooms in/ });
    expect(select).toHaveValue('300000000000009999');
    expect(within(select).getByRole('option', { name: '(missing) …9999' })).toBeInTheDocument();
  });

  it('saving the baseline does not wipe unsaved edits in the settings card', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => routes(server, { dto: dto() }));
    server.always('PUT /admin-tools/match-rooms/settings', () => json(200, dto({ settings: { ...dto().settings, version: 5, baselineChannelIds: [CAT, PRACTICE, GENERAL] } ,
      baseline: dto().baseline.map(item => item.id === PRACTICE ? { ...item, inBaseline: true } : item) })));
    const settings = within(await screen.findByRole('region', { name: 'Room settings' }));
    await user.click(settings.getByRole('button', { name: 'Use preset {table} · {round}' }));
    const baseline = within(screen.getByRole('region', { name: 'Server baseline' }));
    await user.click(baseline.getByRole('checkbox', { name: /Practice/ }));
    await user.click(baseline.getByRole('button', { name: 'Save baseline' }));
    expect(await baseline.findByText('Baseline saved.')).toBeInTheDocument();
    expect(settings.getByRole('textbox', { name: /Room name template/ })).toHaveValue('{table} · {round}');
    expect(settings.getByText(/unsaved changes/)).toBeInTheDocument();
  });

  it('a version conflict says so and keeps the latest settings', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => routes(server, { dto: dto() }));
    server.always('PUT /admin-tools/match-rooms/settings', () => json(409, { error: { code: 'conflict', message: 'Settings changed' } }));
    const card = await settingsRegion();
    await user.click(card.getByRole('button', { name: 'Use preset {table} · {round}' }));
    await user.click(card.getByRole('button', { name: 'Save settings' }));
    expect(await card.findByRole('alert')).toHaveTextContent('The settings changed in another tab');
  });
});

describe('create and add rooms', () => {
  it('creates the missing rooms for the number of tables', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => routes(server, { dto: dto() }));
    server.always('POST /admin-tools/match-rooms/ensure', () => json(200, { created: [channelOf(3), channelOf(4)], rooms: dto() }));
    const tables = await screen.findByRole('spinbutton', { name: 'Tables' });
    expect(tables).toHaveValue(2);
    fireEvent.change(tables, { target: { value: '4' } });
    await user.click(screen.getByRole('button', { name: 'Create missing rooms' }));
    await waitFor(() => expect(server.callsTo('POST /admin-tools/match-rooms/ensure')[0]?.body).toEqual({ tables: 4 }));
    expect(await screen.findByText('Created 2 rooms.')).toBeInTheDocument();
  });

  it('says so when the bot cannot manage channels', async () => {
    mount(server => routes(server, { dto: dto({ canManageChannels: false }) }));
    expect(await screen.findByText('The bot needs the Manage Channels permission to create rooms.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create missing rooms' })).toBeDisabled();
  });

  it('adds an existing voice channel and returns focus to the button', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => routes(server, { dto: dto() }));
    server.always('POST /admin-tools/match-rooms/adopt', () => json(200, room(3, { origin: 'adopted', name: 'Practice' })));
    const open = await screen.findByRole('button', { name: 'Add an existing voice channel' });
    await user.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Add an existing voice channel' });
    const select = within(dialog).getByRole('combobox', { name: 'Voice channel' });
    // Channels that are already tables are not offered.
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose a voice channel', 'General voice', 'Practice']);
    expect(within(dialog).getByRole('button', { name: 'Add to pool' })).toBeDisabled();
    await user.selectOptions(select, 'Practice');
    await user.click(within(dialog).getByRole('button', { name: 'Add to pool' }));
    await waitFor(() => expect(server.callsTo('POST /admin-tools/match-rooms/adopt')[0]?.body).toEqual({ channelId: PRACTICE }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add an existing voice channel' })).not.toBeInTheDocument());
    await waitFor(() => expect(open).toHaveFocus());
  });
});

describe('server baseline', () => {
  it('keeps a category that is still waiting to be created when it saves the baseline', async () => {
    const user = userEvent.setup();
    const pending = dto({ settings: { ...dto().settings, categoryId: null, categoryName: null, pendingCategoryName: 'Finals rooms' } });
    const { server } = mount(server => routes(server, { dto: pending }));
    server.always('PUT /admin-tools/match-rooms/settings', () => json(200, pending));
    const card = within(await screen.findByRole('region', { name: 'Server baseline' }));
    await user.click(card.getByRole('checkbox', { name: /Practice/ }));
    await user.click(card.getByRole('button', { name: 'Save baseline' }));
    await waitFor(() => expect(server.callsTo('PUT /admin-tools/match-rooms/settings')[0]?.body).toMatchObject({ categoryId: null, createCategory: 'Finals rooms' }));
  });

  it('lists channels and categories with bot-created badges, and saves only the baseline', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => routes(server, { dto: dto() }));
    server.always('PUT /admin-tools/match-rooms/settings', () => json(200, dto({ settings: { ...dto().settings, version: 5, baselineChannelIds: [CAT, PRACTICE] } })));
    const card = within(await screen.findByRole('region', { name: 'Server baseline' }));
    expect(card.getByText('These are kept after every tournament. The bot only ever deletes channels it created.')).toBeInTheDocument();
    expect(card.getByRole('checkbox', { name: /Matches/ })).toBeChecked();
    expect(card.getByRole('checkbox', { name: /General voice/ })).toBeChecked();
    expect(card.getByRole('checkbox', { name: /Practice/ })).not.toBeChecked();
    const botCreated = card.getByRole('checkbox', { name: /🎮 M1/ });
    expect(within(botCreated.closest('label')!).getByText('bot-created')).toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Save baseline' })).toBeDisabled();
    await user.click(card.getByRole('checkbox', { name: /General voice/ }));
    await user.click(card.getByRole('checkbox', { name: /Practice/ }));
    expect(card.getByText(/unsaved changes/)).toBeInTheDocument();
    await user.click(card.getByRole('button', { name: 'Save baseline' }));
    await waitFor(() => expect(server.callsTo('PUT /admin-tools/match-rooms/settings')[0]?.body).toEqual({ expectedVersion: 4, template: '🎮 {match}',
      categoryId: CAT, createCategory: null, baselineChannelIds: [CAT, PRACTICE] }));
    expect(await card.findByText('Baseline saved.')).toBeInTheDocument();
  });
});

describe('clean up after tournament', () => {
  const plan = (token: string, patch: Partial<CleanupPlanDto> = {}): CleanupPlanDto => ({ eventId: 'event-1', transcriptsToArchive: 2, planToken: token, items: [
    { channelId: channelOf(1), name: '🎮 M1', kind: 'room', action: 'delete', reason: 'Created by the bot.' },
    { channelId: '300000000000000010', name: 'One Piece 51–100', kind: 'category', action: 'delete', reason: 'Created by the bot and empty.' },
    { channelId: channelOf(2), name: '🎮 M2', kind: 'room', action: 'restore', reason: 'Adopted room.', restoreName: 'Old voice' },
    { channelId: GENERAL, name: 'General voice', kind: 'room', action: 'keep', reason: 'In the server baseline.' },
    { channelId: channelOf(3), name: '🎮 M3', kind: 'room', action: 'skip', reason: 'Someone is connected.' }], ...patch });

  it('previews the groups with reasons and the archive count, and confirms only on the danger button', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => routes(server, { dto: dto() }));
    server.always('GET /admin-tools/match-rooms/cleanup', () => json(200, plan('tok1')));
    server.always('POST /admin-tools/match-rooms/cleanup', () => json(200, { deleted: [channelOf(1), '300000000000000010'], restored: [channelOf(2)],
      skipped: [{ channelId: channelOf(3), reason: 'Someone is connected.' }], archived: 2 }));
    const open = await screen.findByRole('button', { name: 'Clean up after tournament' });
    await user.click(open);
    const dialog = within(await screen.findByRole('dialog', { name: 'Clean up after tournament' }));
    expect(await dialog.findByText('2 room chats will be archived first.')).toBeInTheDocument();
    expect(dialog.getByRole('region', { name: 'Will be deleted' })).toHaveTextContent('One Piece 51–100');
    expect(dialog.getByRole('region', { name: 'Will be restored' })).toHaveTextContent('back to “Old voice”');
    expect(dialog.getByRole('region', { name: 'Kept' })).toHaveTextContent('In the server baseline.');
    expect(dialog.getByRole('region', { name: 'Skipped' })).toHaveTextContent('Someone is connected.');
    // Nothing happens until Confirm.
    expect(server.callsTo('POST /admin-tools/match-rooms/cleanup')).toHaveLength(0);
    await user.click(dialog.getByRole('button', { name: 'Confirm clean-up' }));
    await waitFor(() => expect(server.callsTo('POST /admin-tools/match-rooms/cleanup')[0]?.body).toEqual({ planToken: 'tok1' }));
    const done = within(await screen.findByRole('dialog', { name: 'Clean-up finished' }));
    expect(done.getByRole('region', { name: 'Clean-up result' })).toHaveTextContent('2 deleted');
    expect(done.getByRole('region', { name: 'Clean-up result' })).toHaveTextContent('1 restored');
    expect(done.getByRole('region', { name: 'Clean-up result' })).toHaveTextContent('2 room chats archived');
    expect(done.getByRole('region', { name: 'Clean-up result' })).toHaveTextContent('Someone is connected.');
    expect(done.getByRole('region', { name: 'Clean-up result' })).toHaveTextContent('🎮 M3');
    expect(done.getByRole('region', { name: 'Clean-up result' })).toHaveTextContent(MATCH_ROOM_RENAME_NOTICE);
    await user.click(done.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(open).toHaveFocus());
  });

  it('a plan that changed is refused: it says to review again and loads the new plan', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => routes(server, { dto: dto() }));
    server.once('GET /admin-tools/match-rooms/cleanup', () => json(200, plan('tok1')));
    server.once('GET /admin-tools/match-rooms/cleanup', () => json(200, plan('tok2', { items: plan('x').items.slice(0, 1), transcriptsToArchive: 1 })));
    server.once('POST /admin-tools/match-rooms/cleanup', () => json(409, { error: { code: 'conflict', message: 'The plan changed' } }));
    server.once('POST /admin-tools/match-rooms/cleanup', () => json(200, { deleted: [channelOf(1)], restored: [], skipped: [], archived: 1 }));
    await user.click(await screen.findByRole('button', { name: 'Clean up after tournament' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Clean up after tournament' }));
    await dialog.findByText('2 room chats will be archived first.');
    await user.click(dialog.getByRole('button', { name: 'Confirm clean-up' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('The rooms changed; review again.');
    expect(await dialog.findByText('1 room chat will be archived first.')).toBeInTheDocument();
    expect(dialog.queryByRole('region', { name: 'Will be restored' })).not.toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Confirm clean-up' }));
    await waitFor(() => expect(server.callsTo('POST /admin-tools/match-rooms/cleanup').map(call => call.body)).toEqual([{ planToken: 'tok1' }, { planToken: 'tok2' }]));
    expect(await screen.findByRole('dialog', { name: 'Clean-up finished' })).toBeInTheDocument();
  });

  it('with nothing to delete or restore there is nothing to confirm', async () => {
    const user = userEvent.setup();
    mount(server => {
      routes(server, { dto: dto() });
      server.always('GET /admin-tools/match-rooms/cleanup', () => json(200, plan('tok0', { transcriptsToArchive: 0, items: plan('x').items.slice(3) })));
    });
    await user.click(await screen.findByRole('button', { name: 'Clean up after tournament' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Clean up after tournament' }));
    expect(await dialog.findByText('Nothing to delete or restore.')).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Confirm clean-up' })).toBeDisabled();
  });

  it('shows why a preview could not load, and Cancel closes without changing anything', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => {
      routes(server, { dto: dto() });
      server.always('GET /admin-tools/match-rooms/cleanup', () => json(409, { error: { code: 'conflict', message: 'An event is still running.' } }));
    });
    await user.click(await screen.findByRole('button', { name: 'Clean up after tournament' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Clean up after tournament' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('An event is still running.');
    expect(dialog.getByRole('button', { name: 'Confirm clean-up' })).toBeDisabled();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(server.callsTo('POST /admin-tools/match-rooms/cleanup')).toHaveLength(0);
  });
});

describe('transcript export', () => {
  const transcript: MatchRoomTranscriptDto = { id: 't1', eventId: 'event-1234567', matchId: 'M1', channelId: channelOf(1), channelName: '🎮 M1', startedAtMs: 1,
    archivedAtMs: Date.UTC(2026, 10, 16, 20), reason: 'reassigned', messageCount: 1, contentAvailable: true, skippedOld: 0, hold: false,
    messages: [{ id: '1', authorId: '400000000000000001', authorName: 'Ann', createdAtMs: Date.UTC(2026, 10, 16, 19), content: '=SUM(1)', attachments: [{ name: 'a.png', url: 'https://cdn/a.png', size: 3 }] }] };

  it('flattens one row per message, and one row for an empty transcript', () => {
    expect(transcriptRows(transcript)).toEqual([expect.objectContaining({ matchId: 'M1', room: '🎮 M1', author: 'Ann', content: '=SUM(1)', attachments: ['https://cdn/a.png'] })]);
    expect(transcriptRows({ ...transcript, messages: [] })).toHaveLength(1);
  });

  it('collects every transcript of the event into one file', async () => {
    const user = userEvent.setup();
    let saved = '';
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => { void blob.text().then(text => { saved = text; }); return 'blob:x'; }, revokeObjectURL: () => undefined }));
    const { server } = mount(server => {
      routes(server, { dto: dto() });
      server.always('GET /admin-tools/match-rooms/transcripts', () => json(200, [{ ...transcript, messages: undefined }]));
      server.always('GET /admin-tools/match-rooms/transcripts/t1', () => json(200, transcript));
    }, <TranscriptExportButtons eventId="event-1234567" />);
    await user.click(await screen.findByRole('button', { name: 'Export room chat transcripts as JSON' }));
    await waitFor(() => expect(saved).not.toBe(''));
    expect(server.callsTo('GET /admin-tools/match-rooms/transcripts')[0]?.url).toContain('eventId=event-1234567');
    expect(JSON.parse(saved).rows).toHaveLength(1);
  });
});
