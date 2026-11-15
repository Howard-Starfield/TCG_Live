import { CAPABILITIES, DEFAULT_MODERATION_SETTINGS, MODERATION_LIMITS, type Capability, type ModerationFlagDto,
  type ModerationSettingsDto, type VoiceBotPoolDto } from '@tcg-live/core';
import { FIXTURE_NOW_MS, liveDispute } from '@tcg-live/core/fixtures';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../app/testing';
import { AdminDataProvider } from '../../data';
import { json, type FakeServer } from '../../data/test/fakes';
import { AuditTab } from '../lists/AuditTab';
import { ListTabStrip } from '../lists';
import { FlagsTab } from './FlagsTab';
import { ModerationSettings } from './ModerationSettings';
import { splitTerms, validateSettings } from './validate';

MotionGlobalConfig.skipAnimations = true;

const SETTINGS: ModerationSettingsDto = { ...structuredClone(DEFAULT_MODERATION_SETTINGS), guildId: '100000000000000001', version: 3, updatedAtMs: FIXTURE_NOW_MS };
const POOL: VoiceBotPoolDto = { runtime: 'running', rooms: [{ matchId: 'M1', channelId: '200000000000000001', botId: 'main' },
  { matchId: 'M2', channelId: '200000000000000002', botId: null }],
bots: [{ id: 'main', label: 'TCG Live', kind: 'main', userId: null, connected: true, assignedChannelId: '200000000000000001', assignedMatchId: 'M1', addedAtMs: null }] };

function mount(ui: ReactNode, options: { capabilities?: Capability[]; flags?: { evidence?: boolean; moderation?: boolean };
  setup?: (server: FakeServer) => void } = {}) {
  const { capabilities = [...CAPABILITIES], flags = { evidence: true, moderation: true } } = options;
  const harness = createHarness({ stream: false, setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, capabilities,
      ...(flags.evidence ? { evidence: true } : {}), ...(flags.moderation ? { moderation: true } : {}) }));
    server.always('GET /moderation/settings', () => json(200, SETTINGS));
    server.always('GET /moderation/voice-bots', () => json(200, POOL));
    options.setup?.(server);
  } });
  render(<AdminDataProvider data={harness.data}>{ui}</AdminDataProvider>);
  return harness;
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

describe('ModerationSettings', () => {
  it('validates against Discord limits before saving', async () => {
    const { server } = mount(<ModerationSettings open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Keyword filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add list' }));
    const add = screen.getByRole('textbox', { name: 'Add to Words in Custom list 1' });
    fireEvent.change(add, { target: { value: 'x'.repeat(MODERATION_LIMITS.wordLength + 1) } });
    fireEvent.keyDown(add, { key: 'Enter' });
    expect(await screen.findByText(/longer than 60 characters/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Fix 1 problem before saving.')).toBeInTheDocument();
    expect(server.callsTo('PUT /moderation/settings')).toHaveLength(0);
  });

  it('pastes several words at once and saves with the loaded version', async () => {
    const { server } = mount(<ModerationSettings open onClose={() => {}} />, { setup: server => {
      server.always('PUT /moderation/settings', call => json(200, { ...SETTINGS, ...(call.body as { settings: object }).settings, version: 4 }));
    } });
    fireEvent.click(await screen.findByRole('switch', { name: 'Keyword filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add list' }));
    const add = screen.getByRole('textbox', { name: 'Add to Words in Custom list 1' });
    fireEvent.paste(add, { clipboardData: { getData: () => 'noob\nscrub, tilt\nnoob' } });
    expect(within(screen.getByRole('list', { name: 'Words in Custom list 1' })).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.callsTo('PUT /moderation/settings')).toHaveLength(1));
    const body = server.callsTo('PUT /moderation/settings')[0]!.body as { expectedVersion: number; settings: typeof SETTINGS };
    expect(body.expectedVersion).toBe(3);
    expect(body.settings.text.enabled).toBe(true);
    expect(body.settings.text.customLists[0]!.words).toEqual(['noob', 'scrub', 'tilt']);
    expect(body.settings).not.toHaveProperty('version');
    expect(await screen.findByText(/^Saved\./)).toBeInTheDocument();
  });

  it('on 409 loads the fresh state and offers to reapply the edits', async () => {
    const theirs: ModerationSettingsDto = { ...SETTINGS, version: 4, text: { ...SETTINGS.text, blockMessage: 'Changed in another tab' } };
    const { server } = mount(<ModerationSettings open onClose={() => {}} />, { setup: server => {
      server.once('PUT /moderation/settings', () => json(409, { error: { code: 'conflict', message: 'Settings changed.' }, current: theirs }));
      server.always('PUT /moderation/settings', call => json(200, { ...theirs, ...(call.body as { settings: object }).settings, version: 5 }));
    } });
    fireEvent.click(await screen.findByRole('switch', { name: 'Keyword filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings changed elsewhere.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Message shown when blocked/ })).toHaveValue('Changed in another tab');
    expect(screen.getByRole('switch', { name: 'Keyword filter' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Reapply my edits' }));
    expect(screen.getByRole('switch', { name: 'Keyword filter' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.callsTo('PUT /moderation/settings')).toHaveLength(2));
    expect((server.callsTo('PUT /moderation/settings')[1]!.body as { expectedVersion: number }).expectedVersion).toBe(4);
  });

  it('shows AutoMod sync status, including a preset managed elsewhere, and 501 as not available', async () => {
    mount(<ModerationSettings open onClose={() => {}} />, { setup: server => {
      server.once('POST /moderation/automod/sync', () => json(501, { error: { code: 'unavailable', message: 'Discord AutoMod sync is not available in this version yet.' } }));
      server.always('POST /moderation/automod/sync', () => json(200, { status: 'synced', presetManagedElsewhere: true, ruleIds: ['300000000000000001'] }));
    } });
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText(/^Not available yet\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Synced to Discord (1 rule).')).toBeInTheDocument();
    expect(screen.getByText(/Preset lists are managed elsewhere/)).toBeInTheDocument();
  });

  it('sends a helper bot token once, clears the field and never shows it', async () => {
    const token = 'MTAwMDAwMDAwMDAwMDAwMDAx.secret-part.signature';
    const { server } = mount(<ModerationSettings open onClose={() => {}} />, { setup: server => {
      server.always('POST /moderation/voice-bots', () => json(201, { ...POOL, bots: [...POOL.bots, { id: '00000000-0000-4000-8000-000000000009',
        label: 'Helper 1', kind: 'helper', userId: '100000000000000001', connected: false, assignedChannelId: null, assignedMatchId: null,
        addedAtMs: FIXTURE_NOW_MS }] }));
    } });
    fireEvent.click(await screen.findByRole('tab', { name: 'Voice bots' }));
    expect(await screen.findByText(/one voice room at a time/)).toBeInTheDocument();
    expect(screen.getByText('Not monitored (no free bot): M2.')).toBeInTheDocument();
    const field = screen.getByLabelText(/Bot token/);
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Helper 1' } });
    fireEvent.change(field, { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'Add bot' }));
    await waitFor(() => expect(server.callsTo('POST /moderation/voice-bots')).toHaveLength(1));
    expect(server.callsTo('POST /moderation/voice-bots')[0]!.body).toEqual({ label: 'Helper 1', token });
    expect(field).toHaveValue('');
    expect(await screen.findByText('Helper 1')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('secret-part');
  });

  it('clears the token even when adding the bot fails', async () => {
    mount(<ModerationSettings open onClose={() => {}} />, { setup: server => {
      server.always('POST /moderation/voice-bots', () => json(400, { error: { code: 'bad_request', message: 'That token was refused.' } }));
    } });
    fireEvent.click(await screen.findByRole('tab', { name: 'Voice bots' }));
    const field = await screen.findByLabelText(/Bot token/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Helper 1' } });
    fireEvent.change(field, { target: { value: 'abc.def.ghi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add bot' }));
    expect(await screen.findByText('That token was refused.')).toBeInTheDocument();
    expect(field).toHaveValue('');
  });

  it('keeps the tab row in place: fixed body height, the panel scrolls, the tab list never scrolls vertically', async () => {
    mount(<ModerationSettings open onClose={() => {}} />);
    const tabs = await screen.findByRole('tablist', { name: 'Moderation sections' });
    expect(tabs).toHaveClass('overflow-y-hidden', 'shrink-0');
    expect(screen.getByTestId('moderation-body').className).toMatch(/(^| )h-\[/);
    for (const name of ['Volume flags', 'Recording', 'Voice bots', 'Keyword filter']) {
      fireEvent.click(within(tabs).getByRole('tab', { name }));
      expect(screen.getByRole('tabpanel')).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    }
  });

  it('describes the alert channel as required for Flag only rules', async () => {
    mount(<ModerationSettings open onClose={() => {}} />);
    expect(await screen.findByText(/Required for "Flag only" rules; flags also appear in the dashboard/)).toBeInTheDocument();
    expect(screen.queryByText(/Leave empty for dashboard flags only/)).not.toBeInTheDocument();
  });

  it('does not load settings without moderation.manage', async () => {
    const { server } = mount(<ModerationSettings open onClose={() => {}} />, { capabilities: ['dashboard.read', 'evidence.read'] });
    await settle();
    expect(screen.getByText('This session cannot change moderation settings.')).toBeInTheDocument();
    expect(server.callsTo('GET /moderation/settings')).toHaveLength(0);
  });
});

describe('validateSettings', () => {
  it('checks preset rules, timeouts, exemptions and retention', () => {
    const settings = structuredClone(DEFAULT_MODERATION_SETTINGS);
    expect(validateSettings(settings)).toEqual({});
    settings.text.exemptRoleIds = Array.from({ length: 21 }, (_, index) => `1000000000000000${String(index).padStart(2, '0')}`);
    settings.text.alertChannelId = 'general';
    settings.text.customLists = [{ id: 'a', name: 'A', enabled: true, words: ['x'], regexPatterns: ['('], allowList: [],
      action: 'timeout', timeoutSeconds: 10 }];
    settings.retention.days = 400;
    settings.voice.thresholdDbfs = 5;
    const errors = validateSettings(settings);
    expect(Object.keys(errors).sort()).toEqual(['retention.days', 'text.alertChannelId', 'text.customLists.0.regexPatterns',
      'text.customLists.0.timeoutSeconds', 'text.exemptRoleIds', 'voice.thresholdDbfs']);
  });

  it('splits pasted terms on lines and commas', () => {
    expect(splitTerms(' a ,b\n\nc,a ')).toEqual(['a', 'b', 'c']);
  });
});

function flag(id: number, kind: 'keyword' | 'volume', matchId: 'M1' | 'M2' | null): ModerationFlagDto {
  const base = { id, guildId: '100000000000000001', channelId: null, eventId: liveDispute.eventId, matchId, userId: null,
    occurredAtMs: FIXTURE_NOW_MS - (10 - id) * 1000 };
  return kind === 'keyword'
    ? { ...base, kind, detail: { ruleId: null, ruleName: `Rule ${id}`, action: 'block', matchedKeyword: 'noob', matchedContent: null } }
    : { ...base, kind, detail: { peakDbfs: -2, rmsDbfs: -6, sustainedMs: 500 + id, thresholdDbfs: -8 } };
}

describe('FlagsTab', () => {
  it('pages with the after cursor, shows newest first and filters by kind', async () => {
    const { server } = mount(<FlagsTab snapshot={liveDispute} pageLimit={2} />, { setup: server => {
      server.once('GET /moderation/flags', () => json(200, { flags: [flag(1, 'keyword', 'M1'), flag(2, 'volume', 'M2')], nextAfter: 2 }));
      server.always('GET /moderation/flags', () => json(200, { flags: [flag(3, 'keyword', null)], nextAfter: 3 }));
    } });
    const table = await screen.findByRole('table', { name: 'Moderation flags, newest first' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Load newer flags' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    const urls = server.callsTo('GET /moderation/flags').map(call => call.url);
    expect(urls[0]).toContain('after=0&limit=2');
    expect(urls[1]).toContain('after=2&limit=2');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Rule 3');
    expect(rows[2]).toHaveTextContent('Rule 1');
    expect(screen.queryByRole('button', { name: 'Load newer flags' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Flag kind' }), { target: { value: 'volume' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(within(table).getByRole('button', { name: 'Open evidence for M2' }));
    expect(await screen.findByRole('dialog', { name: 'M2 evidence' })).toBeInTheDocument();
  });

  it('is gated on moderation.manage', async () => {
    const { server } = mount(<FlagsTab snapshot={liveDispute} />, { capabilities: ['dashboard.read'] });
    await settle();
    expect(screen.getByText('Flags are not available')).toBeInTheDocument();
    expect(server.callsTo('GET /moderation/flags')).toHaveLength(0);
  });
});

describe('list tabs and audit source', () => {
  it('shows the Flags tab only with moderation access', async () => {
    mount(<ListTabStrip snapshot={liveDispute} tab="players" onTabChange={() => {}} idBase="t" />);
    expect(await screen.findByRole('tab', { name: 'Flags' })).toBeInTheDocument();
  });

  it('hides the Flags tab without the moderation runtime', async () => {
    mount(<ListTabStrip snapshot={liveDispute} tab="players" onTabChange={() => {}} idBase="t" />, { flags: { evidence: true } });
    await settle();
    expect(screen.queryByRole('tab', { name: 'Flags' })).not.toBeInTheDocument();
  });

  it('reads the ops audit for this event from the Evidence & moderation source', async () => {
    const { server } = mount(<AuditTab snapshot={liveDispute} />, { setup: server => {
      server.always('GET /ops/audit', () => json(200, { entries: [{ id: 7, eventId: liveDispute.eventId, guildId: null, kind: 'evidence.deleted',
        actorKind: 'admin', actorId: 'local-admin', payload: { evidenceId: 'x', matchId: 'M2', reason: 'Wrong match' }, occurredAtMs: FIXTURE_NOW_MS }], nextAfter: 7 }));
    } });
    fireEvent.click(await screen.findByRole('radio', { name: 'Evidence & moderation' }));
    const table = await screen.findByRole('table', { name: 'Evidence and moderation audit, newest first' });
    expect(within(table).getByText('evidence.deleted')).toBeInTheDocument();
    expect(server.callsTo('GET /ops/audit')[0]!.url).toContain(`eventId=${liveDispute.eventId}`);
  });

  it('keeps the plain audit without evidence.read', async () => {
    mount(<AuditTab snapshot={liveDispute} />, { capabilities: ['dashboard.read', 'moderation.manage'] });
    await settle();
    expect(screen.queryByRole('radio', { name: 'Evidence & moderation' })).not.toBeInTheDocument();
  });
});
