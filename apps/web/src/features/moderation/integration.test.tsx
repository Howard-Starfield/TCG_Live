import { CAPABILITIES, DEFAULT_MODERATION_SETTINGS, type ModerationFlagDto, type ModerationSettingsBodyDto,
  type VoiceBotPoolDto } from '@tcg-live/core';
import { liveDispute } from '@tcg-live/core/fixtures';
import { render, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../app/testing';
import { AdminDataProvider } from '../../data';
import { json, type FakeServer } from '../../data/test/fakes';
import { EvidenceDrawer } from '../evidence';
import { validateSettings } from './validate';
import { VOICE_DISABLED_ENV_TEXT, VOICE_DISABLED_TEXT, VoiceBots } from './VoiceBots';

MotionGlobalConfig.skipAnimations = true;

const clone = (): ModerationSettingsBodyDto => structuredClone(DEFAULT_MODERATION_SETTINGS) as ModerationSettingsBodyDto;

function mountWith(ui: ReactNode, setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...CAPABILITIES], evidence: true, moderation: true }));
    setup(server);
  } });
  render(<AdminDataProvider data={harness.data}>{ui}</AdminDataProvider>);
  return harness;
}

describe('validateSettings matches the server AutoMod checks', () => {
  it('needs an alert channel for an active Flag only preset rule', () => {
    const settings = clone();
    settings.text.enabled = true;
    settings.text.preset.action = 'flag';
    expect(validateSettings(settings)['text.alertChannelId']).toMatch(/needs an alert channel/);
    settings.text.alertChannelId = '200000000000000009';
    expect(validateSettings(settings)['text.alertChannelId']).toBeUndefined();
  });

  it('checks custom Flag only lists, and nothing while the filter is off', () => {
    const settings = clone();
    settings.text.customLists = [{ id: 'a', name: 'A', enabled: true, words: ['x'], regexPatterns: [], allowList: [], action: 'flag', timeoutSeconds: 600 }];
    expect(validateSettings(settings)['text.alertChannelId']).toBeUndefined();
    settings.text.enabled = true;
    expect(validateSettings(settings)['text.alertChannelId']).toMatch(/"A"/);
  });

  it('refuses a timeout on the preset filter and a preset rule with no list', () => {
    const settings = clone();
    settings.text.enabled = true;
    (settings.text.preset as { action: string }).action = 'timeout';
    settings.text.preset.presets = { profanity: false, sexual: false, slurs: false };
    const errors = validateSettings(settings);
    expect(errors['text.preset.action']).toMatch(/timeout/);
    expect(errors['text.preset.presets']).toMatch(/at least one/);
  });
});

describe('VoiceBots runtime state', () => {
  it('says voice is turned off when the runtime is disabled', async () => {
    const pool: VoiceBotPoolDto = { runtime: 'disabled', rooms: [], bots: [{ id: 'main', label: 'TCG Live', kind: 'main', userId: null,
      connected: false, assignedChannelId: null, assignedMatchId: null, addedAtMs: null }] };
    mountWith(<VoiceBots disabled={false} />, server => server.always('GET /moderation/voice-bots', () => json(200, pool)));
    expect(await screen.findByText(/^Voice features are turned off/)).toBeInTheDocument();
    expect([VOICE_DISABLED_TEXT, VOICE_DISABLED_ENV_TEXT]).toContain(screen.getByText(/^Voice features are turned off/).textContent);
  });

  it('shows per-bot status such as login failed, room status, and Remove only for helpers', async () => {
    const pool: VoiceBotPoolDto = { runtime: 'running',
      rooms: [{ matchId: 'M1', channelId: '200000000000000001', botId: 'main', status: 'recording' }],
      bots: [{ id: 'main', label: 'TCG Live', kind: 'main', userId: null, connected: true, assignedChannelId: '200000000000000001',
        assignedMatchId: 'M1', addedAtMs: null, status: 'connected' },
      { id: '00000000-0000-4000-8000-000000000009', label: 'Helper 1', kind: 'helper', userId: null, connected: false,
        assignedChannelId: null, assignedMatchId: null, addedAtMs: 1, status: 'login failed' }] };
    mountWith(<VoiceBots disabled={false} />, server => server.always('GET /moderation/voice-bots', () => json(200, pool)));
    expect(await screen.findByText(/Login failed: check the token/)).toBeInTheDocument();
    expect(screen.getByText('M1: recording')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
    expect(screen.queryByText(/^Voice features are turned off/)).toBeNull();
  });
});

describe('match volume flags in the evidence drawer', () => {
  it('asks the server for this match only and pages until exhausted', async () => {
    const full: ModerationFlagDto[] = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, kind: 'keyword' as const,
      guildId: '100000000000000001', channelId: null, eventId: null, matchId: null, userId: null, occurredAtMs: 1,
      detail: { ruleId: null, ruleName: 'r', action: 'block' as const, matchedKeyword: null, matchedContent: null } }));
    const afters: string[] = [];
    const filters: string[] = [];
    mountWith(<EvidenceDrawer open onClose={() => {}} snapshot={liveDispute} matchId="M2" />, server => {
      server.always(`GET /events/${liveDispute.eventId}/matches/M2/evidence`,
        () => json(200, { eventId: liveDispute.eventId, matchId: 'M2', items: [] }));
      server.always('GET /moderation/flags', call => {
        const after = new URL(call.url, 'http://local').searchParams.get('after') ?? '';
        afters.push(after);
        const params = new URL(call.url, 'http://local').searchParams;
        filters.push(`${params.get('eventId')}:${params.get('matchId')}`);
        return after === '0' ? json(200, { flags: full, nextAfter: 200 }) : json(200, { flags: [], nextAfter: 200 });
      });
    });
    await waitFor(() => expect(afters).toEqual(['0', '200']));
    expect(new Set(filters)).toEqual(new Set([`${liveDispute.eventId}:M2`]));
  });
});
