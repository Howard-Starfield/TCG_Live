import { CAPABILITIES, DEFAULT_MODERATION_SETTINGS, type ModerationSettingsBodyDto, type ModerationSettingsDto, type VoiceBotPoolDto,
  type VoiceBotVerifyReportDto } from '@tcg-live/core';
import { FIXTURE_NOW_MS } from '@tcg-live/core/fixtures';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createHarness, sessionFixture } from '../../../app/testing';
import { ToastProvider } from '../../../ui';
import { AdminDataProvider } from '../../../data';
import { json, type FakeServer } from '../../../data/test/fakes';
import { RecordingSection } from '../../moderation/VoiceSections';
import { BOT_POLL_MS, BotsTab } from './BotsTab';
import { capacity } from './CapacityBanner';

MotionGlobalConfig.skipAnimations = true;

const HELPER = '00000000-0000-4000-8000-000000000009';
const SETTINGS: ModerationSettingsDto = { ...structuredClone(DEFAULT_MODERATION_SETTINGS) as ModerationSettingsBodyDto,
  guildId: '100000000000000001', version: 3, updatedAtMs: FIXTURE_NOW_MS };
const helperDto = { id: HELPER, label: 'Helper 1', kind: 'helper' as const, userId: '300000000000000001', connected: false,
  assignedChannelId: null, assignedMatchId: null, addedAtMs: 1, enabled: true, applicationId: '300000000000000001', nickname: null,
  inviteUrl: 'https://discord.com/oauth2/authorize?client_id=300000000000000001&scope=bot&permissions=1049600', status: 'login failed' as const,
  lastErrorCode: 'invalid-token' as const };
const POOL: VoiceBotPoolDto = { runtime: 'running',
  rooms: [{ matchId: 'M1', channelId: '200000000000000001', botId: 'main', status: 'recording' },
    { matchId: 'M2', channelId: '200000000000000002', botId: null, status: 'unmonitored' }],
  bots: [{ id: 'main', label: 'TCG Live', kind: 'main', userId: null, connected: true, assignedChannelId: '200000000000000001',
    assignedMatchId: 'M1', addedAtMs: null, status: 'connected' }] };
const REPORT: VoiceBotVerifyReportDto = { botId: HELPER, checkedAtMs: 1, tokenValid: true, applicationId: '300000000000000001', inServer: true,
  nickname: null, channels: [{ channelId: '200000000000000001', viewChannel: true, connect: false, state: 'problem' }],
  warnings: ['Public Bot is on: anyone with the link could add this helper. Turn it off on the Bot page.'],
  problems: ['The helper lacks View Channel or Connect in 1 match room.'], errorCode: null, inviteUrl: null };

function mount(ui: ReactNode, setup?: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...CAPABILITIES], evidence: true, moderation: true }));
    server.always('GET /moderation/settings', () => json(200, SETTINGS));
    setup?.(server);
  } });
  render(<ToastProvider><AdminDataProvider data={harness.data}>{ui}</AdminDataProvider></ToastProvider>);
  return harness;
}

describe('Bots tab', () => {
  it('polls the pool so bot status updates while the tab is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let calls = 0;
      mount(<BotsTab />, server => server.always('GET /moderation/voice-bots', () => {
        calls += 1;
        return json(200, { ...POOL, bots: [...POOL.bots, calls > 1 ? { ...helperDto, status: 'connected', lastErrorCode: null } : helperDto] });
      }));
      expect(await screen.findByText(/Login failed: check the token/)).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(BOT_POLL_MS + 10);
      await waitFor(() => expect(screen.queryByText(/Login failed: check the token/)).toBeNull());
      expect(screen.getAllByText(/^Connected/)).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('shows cards, health and the capacity shortfall that matches the unmonitored rooms', async () => {
    mount(<BotsTab />, server => server.always('GET /moderation/voice-bots', () => json(200, { ...POOL, bots: [...POOL.bots, helperDto] })));
    expect(await screen.findByText(/Login failed: check the token/)).toBeInTheDocument();
    expect(screen.getByText(/Discord refused the token/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Capacity' })).toHaveTextContent('2 rooms · 2 bots → 1 room unmonitored now.');
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/Speak/);
  });

  it('guides adding a helper: the token is sent once and cleared, then the invite link and Verify report show', async () => {
    const token = 'MzAwMDAwMDAwMDAwMDAwMDAx.secret-part.signature-signature-signature';
    const { server } = mount(<BotsTab />, server => {
      server.always('GET /moderation/voice-bots', () => json(200, POOL));
      server.always('POST /moderation/voice-bots', () => json(201, { ...POOL, bots: [...POOL.bots, { ...helperDto, status: 'idle', lastErrorCode: null }] }));
      server.always(`POST /moderation/voice-bots/${HELPER}/verify`, () => json(200, REPORT));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add helper bot' }));
    const wizard = await screen.findByRole('dialog', { name: 'Add a helper bot' });
    expect(wizard).toHaveTextContent('Public Bot');
    expect(wizard).toHaveTextContent('View Channel');
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Helper 1' } });
    const field = screen.getByLabelText(/Bot token/);
    fireEvent.change(field, { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'Add helper' }));
    await waitFor(() => expect(server.callsTo('POST /moderation/voice-bots')).toHaveLength(1));
    expect(server.callsTo('POST /moderation/voice-bots')[0]!.body).toEqual({ label: 'Helper 1', token });
    expect(field).toHaveValue('');
    const invite = await screen.findByRole('link', { name: /Invite it to the server/ });
    expect(invite).toHaveAttribute('href', helperDto.inviteUrl);
    fireEvent.click(screen.getAllByRole('button', { name: 'Verify' }).at(-1)!);
    expect(await screen.findAllByText(/missing View Channel or Connect/)).not.toHaveLength(0);
    expect(server.callsTo(`POST /moderation/voice-bots/${HELPER}/verify`)[0]!.body).toEqual({ channelIds: ['200000000000000001', '200000000000000002'] });
    expect(document.body.textContent).not.toContain('secret-part');
  });

  it('toggles a helper and saves room policies through the versioned settings', async () => {
    const { server } = mount(<BotsTab />, server => {
      server.always('GET /moderation/voice-bots', () => json(200, { ...POOL, bots: [...POOL.bots, helperDto] }));
      server.always(`PATCH /moderation/voice-bots/${HELPER}`, () => json(200, { ...POOL, bots: [...POOL.bots, { ...helperDto, enabled: false }] }));
      server.always('PUT /moderation/settings', call => json(200, { ...SETTINGS, ...(call.body as { settings: object }).settings, version: 4 }));
    });
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable Helper 1' }));
    await waitFor(() => expect(server.callsTo(`PATCH /moderation/voice-bots/${HELPER}`)[0]?.body).toEqual({ enabled: false }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Coverage of 200000000000000002' }), { target: { value: 'never' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Pinned bot of 200000000000000001' }), { target: { value: HELPER } });
    fireEvent.click(screen.getByRole('button', { name: 'Save rooms' }));
    await waitFor(() => expect(server.callsTo('PUT /moderation/settings')).toHaveLength(1));
    const body = server.callsTo('PUT /moderation/settings')[0]!.body as { expectedVersion: number; settings: ModerationSettingsBodyDto };
    expect(body.expectedVersion).toBe(3);
    expect(body.settings.voice.rooms).toEqual({
      '200000000000000001': { coverage: 'auto', recording: 'inherit', priority: 'normal', pinnedBotId: HELPER },
      '200000000000000002': { coverage: 'never', recording: 'inherit', priority: 'normal', pinnedBotId: null } });
    expect(await screen.findByText('Room settings saved.')).toBeInTheDocument();
  });

  it('capacity: rooms minus enabled bots while the runtime is off', () => {
    const off: VoiceBotPoolDto = { ...POOL, runtime: 'disabled', rooms: [], bots: [...POOL.bots, { ...helperDto, enabled: false }] };
    expect(capacity(off, 3)).toEqual({ bots: 1, rooms: 3, shortfall: 2 });
  });
});

describe('recording opt-outs in the Recording section', () => {
  it('adds and removes Discord user IDs in the settings draft', () => {
    function Host() {
      const [settings, setSettings] = useState<ModerationSettingsBodyDto>(structuredClone(DEFAULT_MODERATION_SETTINGS) as ModerationSettingsBodyDto);
      return <><RecordingSection settings={settings} onChange={setSettings} errors={{}} disabled={false} />
        <output data-testid="ids">{(settings.recording.optOutUserIds ?? []).join(',')}</output></>;
    }
    render(<Host />);
    const input = screen.getByRole('textbox', { name: 'Discord user ID' });
    fireEvent.change(input, { target: { value: 'nope' } });
    expect(screen.getByText(/Paste a Discord user ID/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '600000000000000009' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add opt-out' }));
    expect(screen.getByTestId('ids')).toHaveTextContent('600000000000000009');
    fireEvent.click(screen.getByRole('button', { name: 'Remove opt-out 600000000000000009' }));
    expect(screen.getByTestId('ids')).toHaveTextContent('');
  });
});
