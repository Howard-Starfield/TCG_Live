import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, DEFAULT_LFG_SETTINGS, type AdminToolsSettingsBodyDto, type GuildMetaDto, type LfgPostDto,
  type LfgSettingsBodyDto, type LfgSettingsDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../../app/testing';
import { AdminDataProvider } from '../../../data';
import { json, type FakeServer } from '../../../data/test/fakes';
import { lfgSettingsProblems } from './api';
import { LfgTab } from './LfgTab';

MotionGlobalConfig.skipAnimations = true;

const guildId = '100000000000000001';
const GENERAL = '200000000000000302', LFG = '200000000000000205';
const guild: GuildMetaDto = { guildId, name: 'Demo', memberCount: 3, emojis: [],
  roles: [{ id: guildId, name: '@everyone', color: 0, position: 0, managed: false, aboveBot: false },
    { id: LFG, name: 'LFG', color: 0, position: 1, managed: false, aboveBot: false }],
  channels: [{ id: GENERAL, name: 'general', type: 'text', parentId: null, position: 0, reserved: false }] };
const body = (patch: Partial<LfgSettingsBodyDto> = {}): LfgSettingsBodyDto => ({ ...structuredClone(DEFAULT_LFG_SETTINGS) as LfgSettingsBodyDto, enabled: true,
  channels: [{ channelId: GENERAL, panel: null, games: [], pingRoleId: null, voiceChannelIds: null }],
  games: [{ name: 'Pokémon TCG', emoji: null, pingRoleId: null }], formats: ['Standard'], pingRoleId: LFG, ...patch });
const saved = (version = 1, patch: Partial<LfgSettingsBodyDto> = {}): LfgSettingsDto => ({ guildId, version, updatedAtMs: 1, ...body(patch) });
const post = (patch: Partial<LfgPostDto> = {}): LfgPostDto => ({ id: '00000000-0000-4000-8000-0000000000aa', guildId, channelId: GENERAL, messageId: '300000000000000001',
  authorId: '200000000000000001', game: 'Pokémon TCG', format: 'Standard', note: 'Chill games', voiceChannelId: null, status: 'open', pingedRoleId: LFG,
  createdAtMs: 1, expiresAtMs: 2, closedAtMs: null, closedBy: null, players: ['200000000000000002'], ...patch });

function routes(server: FakeServer, settings = saved(), posts: LfgPostDto[] = [post()]) {
  server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...CAPABILITIES], adminTools: true }));
  server.always('GET /admin-tools/settings', () => json(200, { guildId, version: 0, updatedAtMs: null,
    ...structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto }));
  server.always('GET /admin-tools/guild', () => json(200, guild));
  server.always('GET /admin-tools/lfg/settings', () => json(200, settings));
  server.always('GET /admin-tools/lfg/posts', () => json(200, { posts }));
  server.always('GET /admin-tools/lfg/stats', () => json(200, { sinceMs: 0, posts: 3, joins: 7, open: 1,
    games: [{ game: 'Pokémon TCG', posts: 3, joins: 7, open: 1 }] }));
  server.always('GET /admin-tools/lfg/panels', () => json(200, { panels: [{ channelId: GENERAL, state: 'posted', message: null, atMs: 1 }] }));
}
function mount(setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  render(<AdminDataProvider data={harness.data}><LfgTab /></AdminDataProvider>);
  return harness;
}

describe('LFG settings checks', () => {
  it('accepts the defaults with a channel and names template and limit problems', () => {
    expect(lfgSettingsProblems(body())).toEqual([]);
    expect(lfgSettingsProblems(body({ channels: [] }))).toContain('Choose at least one LFG channel before turning LFG on.');
    const messages = { ...DEFAULT_LFG_SETTINGS.messages, cardBody: 'Hi {nope}', pingText: 'no role', cardTitle: '{note}' };
    const problems = lfgSettingsProblems(body({ messages }));
    expect(problems).toContain('Card text uses unknown placeholders: {nope}.');
    expect(problems).toContain('Ping text must contain {role}.');
    expect(problems.some(problem => /Card title can reach \d+ characters/.test(problem))).toBe(true);
  });
});

describe('LFG tab', () => {
  it('previews the card and panel live and saves with the loaded version', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server);
      server.once('PUT /admin-tools/lfg/settings', call => json(200, { ...saved(2), ...(call.body as { settings: LfgSettingsBodyDto }).settings }));
    });
    const preview = await screen.findByRole('figure', { name: 'Card preview' });
    expect(within(preview).getByText(/looking for a Pokémon TCG game/)).toBeInTheDocument();
    expect(within(preview).getByText('Join')).toBeInTheDocument();
    const title = screen.getByLabelText('Card title');
    await user.clear(title);
    await user.type(title, 'LFG: {{game}');
    await waitFor(() => expect(within(screen.getByRole('figure', { name: 'Card preview' })).getByText('LFG: Pokémon TCG')).toBeInTheDocument());
    const panelTitle = screen.getByLabelText('Panel title');
    await user.clear(panelTitle);
    await user.type(panelTitle, 'Find a game');
    expect(within(screen.getByRole('figure', { name: 'Panel preview' })).getByText('Find a game')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(harness.server.callsTo('PUT /admin-tools/lfg/settings')).toHaveLength(1));
    const sent = harness.server.callsTo('PUT /admin-tools/lfg/settings')[0]!.body as { expectedVersion: number; settings: LfgSettingsBodyDto };
    expect(sent.expectedVersion).toBe(1);
    expect(sent.settings.messages.cardTitle).toBe('LFG: {game}');
    expect(sent.settings.panel.title).toBe('Find a game');
    expect('guildId' in sent.settings).toBe(false);
  });

  it('blocks saving while a template is invalid', async () => {
    const user = userEvent.setup();
    mount(server => routes(server));
    const ping = await screen.findByLabelText('Ping text');
    await user.clear(ping);
    await user.type(ping, 'Hello');
    expect(screen.getByRole('list', { name: 'Problems' })).toHaveTextContent('Ping text must contain {role}.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('lists posts with stats and closes or deletes a post', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server);
      server.once('POST /admin-tools/lfg/posts/00000000-0000-4000-8000-0000000000aa/close', () => json(200, post({ status: 'closed' })));
      server.once('DELETE /admin-tools/lfg/posts/00000000-0000-4000-8000-0000000000aa', () => json(200, post({ status: 'deleted' })));
    });
    const item = await screen.findByRole('listitem', { name: /Post Pokémon TCG by/ });
    expect(within(item).getByText(/2 players/)).toBeInTheDocument();
    expect(await screen.findByText('3 posts · 7 joins · 1 open')).toBeInTheDocument();
    await user.click(within(item).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/lfg/posts/00000000-0000-4000-8000-0000000000aa/close')).toHaveLength(1));
    await user.click(within(item).getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(harness.server.callsTo('DELETE /admin-tools/lfg/posts/00000000-0000-4000-8000-0000000000aa')).toHaveLength(1));
  });
});
