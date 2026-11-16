import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type Capability, type MemberProfileDto,
  type MemberSummaryDto, type ModCaseDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../../app/testing';
import { ToastProvider } from '../../../ui';
import { AdminDataProvider } from '../../../data';
import { json, type FakeServer } from '../../../data/test/fakes';
import { AdminToolsPage } from '../AdminToolsPage';
import { caseQueryString } from './api';
import { ModerateMemberAction } from './ModerateMemberAction';

MotionGlobalConfig.skipAnimations = true;

const guildId = '100000000000000001';
const ASH = '200000000000000001';
const summary = (patch: Partial<MemberSummaryDto> = {}): MemberSummaryDto => ({
  id: ASH, username: 'ash', displayName: 'Ash TCG', avatarUrl: null, roleIds: [], joinedAtMs: 1_700_000_000_000,
  accountCreatedAtMs: 1_600_000_000_000, flags: { banned: false, timedOutUntilMs: null, newAccount: false, bot: false, left: false },
  caseCount: 0, noteCount: 0, ...patch });
const profile = (patch: Partial<MemberProfileDto> = {}): MemberProfileDto => ({ ...summary(), cases: [], notes: [], tournaments: [], ...patch });
const modCase = (number: number, patch: Partial<ModCaseDto> = {}): ModCaseDto => ({ guildId, number, kind: 'ban', targetId: ASH,
  moderatorKind: 'admin', moderatorId: 'local-admin', reason: 'Cheating', evidenceIds: [], eventId: null, matchId: null, source: 'dashboard',
  createdAtMs: 1_700_000_000_000, expiresAtMs: null, expiryHandledAtMs: null, ...patch });

function routes(server: FakeServer, capabilities: readonly Capability[] = CAPABILITIES) {
  server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...capabilities], adminTools: true }));
  server.always('GET /admin-tools/settings', () => json(200, { guildId, version: 0, updatedAtMs: null,
    ...structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto }));
  server.always('GET /admin-tools/guild', () => json(200, { guildId, name: 'Demo', memberCount: 1, emojis: [], channels: [],
    roles: [{ id: '200000000000000203', name: 'Player', color: 0, position: 3, managed: false, aboveBot: false }] }));
  server.always('GET /admin-tools/members', () => json(200, { members: [summary()], truncated: false }));
  server.always(`GET /admin-tools/members/${ASH}`, () => json(200, profile({ roleIds: ['200000000000000203'] })));
}

function mount(ui: ReactNode, setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  render(<ToastProvider><AdminDataProvider data={harness.data}>{ui}</AdminDataProvider></ToastProvider>);
  return harness;
}

describe('Members tab', () => {
  it('debounces the search and opens a profile with roles, cases and notes', async () => {
    const user = userEvent.setup();
    const harness = mount(<AdminToolsPage initialTab="members" />, server => routes(server));
    await user.type(await screen.findByRole('textbox', { name: 'Search members' }), 'ash');
    await user.click(await screen.findByRole('button', { name: /Ash TCG/ }));
    const searches = harness.server.callsTo('GET /admin-tools/members');
    expect(searches).toHaveLength(1);
    expect(searches[0]!.url).toContain('q=ash');
    const panel = await screen.findByRole('region', { name: 'Member Ash TCG' });
    expect(within(panel).getByText('Player')).toBeInTheDocument();
    expect(within(panel).getByText('No cases.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Ban' })).toBeInTheDocument();
  });

  it('a members.read session sees profiles without moderation buttons or note editing', async () => {
    const user = userEvent.setup();
    mount(<AdminToolsPage initialTab="members" />, server => routes(server, ['dashboard.read', 'members.read']));
    await user.type(await screen.findByRole('textbox', { name: 'Search members' }), '200000000000000001');
    await user.click(await screen.findByRole('button', { name: /Ash TCG/ }));
    const panel = await screen.findByRole('region', { name: 'Member Ash TCG' });
    expect(within(panel).queryByRole('group', { name: 'Moderation actions' })).toBeNull();
    expect(within(panel).queryByRole('textbox', { name: 'New note' })).toBeNull();
  });

  it('ban asks for a confirmed reason and delete window, and shows hierarchy errors inside the dialog', async () => {
    const user = userEvent.setup();
    const harness = mount(<AdminToolsPage initialTab="members" />, server => {
      routes(server);
      server.once('POST /admin-tools/actions', () => json(422, { error: { code: 'rule', message: "The bot's highest role must be above this member's highest role." } }));
      server.once('POST /admin-tools/actions', () => json(200, { case: modCase(7), dm: 'failed' }));
    });
    await user.type(await screen.findByRole('textbox', { name: 'Search members' }), 'a');
    await user.click(await screen.findByRole('button', { name: /Ash TCG/ }));
    await user.click(await screen.findByRole('button', { name: 'Ban' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Ban Ash TCG?' });
    const confirm = within(dialog).getByRole('button', { name: 'Ban' });
    expect(confirm).toBeDisabled();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Delete their recent messages' }), 'Previous 24 hours');
    await user.type(within(dialog).getByRole('textbox'), 'Cheating at table 3');
    await user.click(confirm);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/highest role/);
    expect(harness.server.callsTo('POST /admin-tools/actions')[0]!.body).toEqual({ action: 'ban', userId: ASH, reason: 'Cheating at table 3',
      deleteMessageSeconds: 86_400, durationMs: null });
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText(/Case #7 saved\. The member could not be messaged/)).toBeInTheDocument();
  });

  it('timeout offers lengths up to Discord\'s 28 days', async () => {
    const user = userEvent.setup();
    const harness = mount(<AdminToolsPage initialTab="members" />, server => {
      routes(server);
      server.once('POST /admin-tools/actions', () => json(200, { case: modCase(1, { kind: 'timeout' }), dm: 'sent' }));
    });
    await user.type(await screen.findByRole('textbox', { name: 'Search members' }), 'a');
    await user.click(await screen.findByRole('button', { name: /Ash TCG/ }));
    await user.click(await screen.findByRole('button', { name: 'Timeout' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.selectOptions(within(dialog).getByRole('combobox'), '28 days (Discord maximum)');
    await user.type(within(dialog).getByRole('textbox'), 'Spam');
    await user.click(within(dialog).getByRole('button', { name: 'Timeout' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/actions')).toHaveLength(1));
    expect(harness.server.callsTo('POST /admin-tools/actions')[0]!.body).toMatchObject({ action: 'timeout', durationMs: 28 * 86_400_000 });
  });

  it('ban can be temporary: the chosen length is sent as durationMs', async () => {
    const user = userEvent.setup();
    const harness = mount(<AdminToolsPage initialTab="members" />, server => {
      routes(server);
      server.once('POST /admin-tools/actions', () => json(200, { case: modCase(1, { kind: 'ban', expiresAtMs: 1_700_604_800_000 }), dm: 'sent' }));
    });
    await user.type(await screen.findByRole('textbox', { name: 'Search members' }), 'a');
    await user.click(await screen.findByRole('button', { name: /Ash TCG/ }));
    await user.click(await screen.findByRole('button', { name: 'Ban' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Ban length' }), '7 days');
    await user.type(within(dialog).getByRole('textbox'), 'Cooling off');
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/actions')).toHaveLength(1));
    expect(harness.server.callsTo('POST /admin-tools/actions')[0]!.body).toMatchObject({ action: 'ban', durationMs: 7 * 86_400_000,
      deleteMessageSeconds: 0 });
  });
});

describe('Bans tab', () => {
  it('pages the ban list, filters it in the browser, and unbans with a reason', async () => {
    const user = userEvent.setup();
    const ban = (n: number, username: string, reason: string | null, caseNumber: number | null = null) =>
      ({ userId: `20000000000000010${n}`, username, avatarUrl: null, reason, caseNumber, expiresAtMs: null });
    const harness = mount(<AdminToolsPage initialTab="bans" />, server => {
      routes(server);
      server.once('GET /admin-tools/bans', () => json(200, { bans: [ban(1, 'spam-bot', 'Spam links', 3)], nextAfter: '200000000000000101' }));
      server.once('GET /admin-tools/bans', () => json(200, { bans: [ban(2, 'noshow', 'No-show')], nextAfter: null }));
      server.always('GET /admin-tools/bans', () => json(200, { bans: [ban(2, 'noshow', 'No-show')], nextAfter: null }));
      server.once('POST /admin-tools/actions', () => json(200, { case: modCase(9, { kind: 'unban' }), dm: 'skipped' }));
    });
    const list = await screen.findByRole('region', { name: 'Ban list' });
    expect(within(list).getByText(/Case #3/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Load more' }));
    expect(await within(list).findByText(/noshow/)).toBeInTheDocument();
    expect(harness.server.callsTo('GET /admin-tools/bans')[1]!.url).toContain('after=200000000000000101');
    await user.type(within(list).getByRole('textbox', { name: 'Filter bans' }), 'spam');
    expect(within(list).queryByText(/noshow/)).toBeNull();
    await user.click(within(list).getByRole('button', { name: 'Unban' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Unban spam-bot?' });
    expect(within(dialog).getByRole('button', { name: 'Unban' })).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'Appeal accepted');
    await user.click(within(dialog).getByRole('button', { name: 'Unban' }));
    expect(await screen.findByText('Unbanned. Case #9 saved.')).toBeInTheDocument();
    expect(harness.server.callsTo('POST /admin-tools/actions')[0]!.body).toEqual({ action: 'unban', userId: '200000000000000101', reason: 'Appeal accepted' });
  });
});

describe('Cases tab', () => {
  it('lists cases, edits a reason, deletes with a reason and hints when the audit log is not readable', async () => {
    const user = userEvent.setup();
    const harness = mount(<AdminToolsPage initialTab="cases" />, server => {
      routes(server);
      server.always('GET /admin-tools/cases', () => json(200, { cases: [modCase(2, { kind: 'warn', reason: 'Late' }), modCase(1)], nextBefore: null }));
      server.always('GET /admin-tools/mod-audit', () => json(200, { entries: [{ id: 'case:2', kind: 'warn', targetId: ASH, moderatorId: 'local-admin',
        reason: 'Late', caseNumber: 2, source: 'dashboard', occurredAtMs: 1_700_000_000_000 }], nextBefore: null, discordAudit: 'missing-permission' }));
      server.once('PUT /admin-tools/cases/2', () => json(200, modCase(2, { kind: 'warn', reason: 'Late twice' })));
      server.once('DELETE /admin-tools/cases/1', () => json(200, { deleted: 1 }));
    });
    expect(await screen.findByText(/View Audit Log permission/)).toBeInTheDocument();
    const log = await screen.findByRole('list', { name: 'Cases' });
    await user.click(within(log).getByRole('button', { name: /#2/ }));
    const detail = await screen.findByRole('dialog', { name: 'Case #2' });
    const reason = within(detail).getByRole('textbox', { name: /Reason/ });
    await user.clear(reason);
    await user.type(reason, 'Late twice');
    await user.click(within(detail).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(harness.server.callsTo('PUT /admin-tools/cases/2')).toHaveLength(1));
    expect(harness.server.callsTo('PUT /admin-tools/cases/2')[0]!.body).toEqual({ reason: 'Late twice', evidenceIds: [] });

    await user.click(within(log).getByRole('button', { name: /#1/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Case #1' })).getByRole('button', { name: 'Delete case' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete case #1?' });
    await user.type(within(confirm).getByRole('textbox'), 'Duplicate');
    await user.click(within(confirm).getByRole('button', { name: 'Delete case' }));
    await waitFor(() => expect(harness.server.callsTo('DELETE /admin-tools/cases/1')).toHaveLength(1));
    expect(harness.server.callsTo('DELETE /admin-tools/cases/1')[0]!.body).toEqual({ reason: 'Duplicate' });
  });

  it('builds case filters, leaving invalid member IDs out', () => {
    expect(caseQueryString({ targetId: '123', kind: 'ban', moderatorId: 'local-admin' }, 40)).toBe('limit=50&kind=ban&moderatorId=local-admin&before=40');
    expect(caseQueryString({ targetId: ASH, kind: '', moderatorId: '' }, null)).toBe(`limit=50&targetId=${ASH}`);
  });
});

describe('Moderate row menu', () => {
  it('attaches the tournament and match to the case, and hides without members.moderate', async () => {
    const user = userEvent.setup();
    const eventId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const harness = mount(<ModerateMemberAction memberId={ASH} name="Ash" eventId={eventId} matchId="M2" />, server => {
      routes(server);
      server.once('POST /admin-tools/actions', () => json(200, { case: modCase(4, { kind: 'warn' }), dm: 'sent' }));
    });
    await user.click(await screen.findByRole('button', { name: 'Moderate Ash' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Warn' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Warn Ash?' });
    await user.type(within(dialog).getByRole('textbox'), 'No-show');
    await user.click(within(dialog).getByRole('button', { name: 'Warn' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/actions')).toHaveLength(1));
    expect(harness.server.callsTo('POST /admin-tools/actions')[0]!.body).toEqual({ action: 'warn', userId: ASH, reason: 'No-show', eventId, matchId: 'M2' });
  });

  it('renders nothing for a read-only session', async () => {
    const harness = mount(<ModerateMemberAction memberId={ASH} name="Ash" eventId="x" />, server => routes(server, ['dashboard.read', 'members.read']));
    await waitFor(() => expect(harness.server.callsTo('GET /session').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Moderate Ash' })).toBeNull();
  });
});
