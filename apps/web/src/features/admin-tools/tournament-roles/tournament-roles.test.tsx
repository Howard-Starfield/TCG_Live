import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, DISCORD_ROLE_COLOR_PRESETS, type AdminToolsSettingsBodyDto, type TournamentRoleDto,
  type TournamentRolesDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../../app/testing';
import { AdminDataProvider } from '../../../data';
import { json, noContent, type FakeServer } from '../../../data/test/fakes';
import { ToastProvider } from '../../../ui';
import { colorHex, parseHexColor, presetName } from './api';
import { CREATE_ROLES_EXPLANATION, TournamentRolesCard } from './TournamentRolesCard';

MotionGlobalConfig.skipAnimations = true;

const guildId = '100000000000000001';
const OWNER = '200000000000000001', BEN = '200000000000000003';
const role = (kind: 'organizer' | 'judge', patch: Partial<TournamentRoleDto> = {}): TournamentRoleDto => ({
  kind, roleId: kind === 'organizer' ? '300000000000000001' : '300000000000000002', name: kind === 'organizer' ? 'TCG Organizer' : 'TCG Judge',
  color: kind === 'organizer' ? 0xE67E22 : 0x3498DB, position: 3, problem: null, problemText: null, members: [], membersComplete: true, ...patch });
const absent = (kind: 'organizer' | 'judge') => role(kind, { roleId: null, name: null, color: null, problem: 'not-created' });
const rolesDto = (patch: Partial<TournamentRolesDto> = {}): TournamentRolesDto => ({ guildId, ownerId: OWNER, canManageRoles: true,
  botTopRole: { id: '300000000000000009', name: 'TCG Live', position: 5 },
  roles: [role('organizer', { members: [{ id: OWNER, displayName: 'Olly Owner', avatarUrl: null }] }), role('judge')], legacyStaffRoleIds: [], ...patch });
const member = (id: string, username: string, displayName: string | null) => ({ id, username, displayName, avatarUrl: null, roleIds: [],
  joinedAtMs: 1, flags: [], timeoutUntilMs: null });

function routes(server: FakeServer, state: { dto: TournamentRolesDto }, canManage = true) {
  server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: canManage ? [...CAPABILITIES] : ['members.read', 'dashboard.read'], adminTools: true }));
  server.always('GET /admin-tools/settings', () => json(200, { guildId, version: 0, updatedAtMs: null,
    ...structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto }));
  server.always('GET /admin-tools/tournament-roles', () => json(200, structuredClone(state.dto)));
  server.always('GET /admin-tools/members', call => json(200, { members: call.url.includes('q=be')
    ? [member(BEN, 'ben', 'Ben Cho'), member(OWNER, 'olly', 'Olly Owner')] : [], truncated: false }));
  server.always('GET /events', () => json(200, []));
}
function mount(setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  render(<ToastProvider><AdminDataProvider data={harness.data}><TournamentRolesCard /></AdminDataProvider></ToastProvider>);
  return harness;
}
const roleRegion = async (name: string) => within(await screen.findByRole('region', { name }));

describe('colour helpers', () => {
  it('formats and validates hex colours', () => {
    expect(colorHex(0x1ABC9C)).toBe('#1ABC9C');
    expect(colorHex(0xFF)).toBe('#0000FF');
    expect(parseHexColor('#1abc9c')).toBe(0x1ABC9C);
    expect(parseHexColor(' 1ABC9C ')).toBe(0x1ABC9C);
    for (const bad of ['', '#12', '#12345', '#1234567', '#GGGGGG', 'red']) expect(parseHexColor(bad), bad).toBeNull();
    expect(presetName(0xE67E22)).toBe('Orange');
    expect(presetName(0x123456)).toBe('#123456');
  });
});

describe('TournamentRolesCard', () => {
  it('shows both roles with their members, the legacy note and the /tcg-staff note', async () => {
    mount(server => routes(server, { dto: rolesDto({ legacyStaffRoleIds: ['300000000000000077'] }) }));
    const organizer = await roleRegion('TCG Organizer');
    expect(organizer.getByRole('list', { name: 'Members of TCG Organizer' })).toHaveTextContent('Olly Owner');
    expect(await roleRegion('TCG Judge')).toBeTruthy();
    expect(screen.getByText(/count as TCG Judge; give TCG Organizer to anyone who needs more/)).toBeInTheDocument();
    expect(screen.getByText(/\/tcg-staff is visible to everyone/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Create TCG roles' })).toBeNull();
  });

  it('renames a role and sends only the name', async () => {
    const user = userEvent.setup();
    const { server } = mount(srv => {
      routes(srv, { dto: rolesDto() });
      srv.always('PATCH /admin-tools/tournament-roles/judge', () => json(200, role('judge', { name: 'Rules Judge' })));
    });
    const judge = await roleRegion('TCG Judge');
    await user.click(judge.getByRole('button', { name: 'Rename TCG Judge' }));
    const input = judge.getByRole('textbox', { name: 'New name for TCG Judge' });
    await user.clear(input);
    expect(judge.getByRole('button', { name: 'Save name' })).toBeDisabled();
    await user.type(input, 'Rules Judge');
    await user.click(judge.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(server.callsTo('PATCH /admin-tools/tournament-roles/judge')[0]?.body).toEqual({ name: 'Rules Judge' }));
  });

  it('offers the 20 presets as named radios, marks the current one and patches the picked colour', async () => {
    const user = userEvent.setup();
    const { server } = mount(srv => {
      routes(srv, { dto: rolesDto() });
      srv.always('PATCH /admin-tools/tournament-roles/judge', () => json(200, role('judge')));
    });
    const group = within(await screen.findByRole('radiogroup', { name: 'Colour for TCG Judge' }));
    expect(group.getAllByRole('radio')).toHaveLength(DISCORD_ROLE_COLOR_PRESETS.length);
    expect(group.getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    expect(group.getByRole('radio', { name: 'Red' })).toHaveAttribute('aria-checked', 'false');
    await user.click(group.getByRole('radio', { name: 'Red' }));
    await waitFor(() => expect(server.callsTo('PATCH /admin-tools/tournament-roles/judge')[0]?.body).toEqual({ color: 0xE74C3C }));
  });

  it('applies a valid custom hex and rejects an invalid one with an announced error', async () => {
    const user = userEvent.setup();
    const { server } = mount(srv => {
      routes(srv, { dto: rolesDto() });
      srv.always('PATCH /admin-tools/tournament-roles/judge', () => json(200, role('judge')));
    });
    const judge = await roleRegion('TCG Judge');
    const hex = judge.getByRole('textbox', { name: 'Custom colour for TCG Judge' });
    await user.type(hex, '#12345');
    await user.click(judge.getByRole('button', { name: 'Apply colour' }));
    expect(hex).toBeInvalid();
    expect(hex).toHaveAccessibleDescription('Use six hex digits, for example #1ABC9C.');
    expect(server.callsTo('PATCH /admin-tools/tournament-roles/judge')).toHaveLength(0);
    await user.clear(hex);
    await user.type(hex, '#12345A');
    await user.click(judge.getByRole('button', { name: 'Apply colour' }));
    await waitFor(() => expect(server.callsTo('PATCH /admin-tools/tournament-roles/judge')[0]?.body).toEqual({ color: 0x12345A }));
  });

  it('adds a member found by search, hides existing holders, and removes a member', async () => {
    const user = userEvent.setup();
    const { server } = mount(srv => {
      routes(srv, { dto: rolesDto() });
      srv.always(`PUT /admin-tools/tournament-roles/organizer/members/${BEN}`, () => noContent());
      srv.always(`DELETE /admin-tools/tournament-roles/organizer/members/${OWNER}`, () => noContent());
    });
    const organizer = await roleRegion('TCG Organizer');
    await user.type(organizer.getByRole('textbox', { name: 'Search members to add to TCG Organizer' }), 'be');
    const results = await organizer.findByRole('list', { name: 'Members to add to TCG Organizer' });
    expect(within(results).queryByText(/Olly Owner/)).toBeNull();
    await user.click(within(results).getByRole('button', { name: 'Add Ben Cho to TCG Organizer' }));
    await waitFor(() => expect(server.callsTo(`PUT /admin-tools/tournament-roles/organizer/members/${BEN}`)).toHaveLength(1));
    await user.click(organizer.getByRole('button', { name: 'Remove Olly Owner from TCG Organizer' }));
    await waitFor(() => expect(server.callsTo(`DELETE /admin-tools/tournament-roles/organizer/members/${OWNER}`)).toHaveLength(1));
  });

  it('explains a problem with the server text and stops offering member adds', async () => {
    const text = 'Move the TCG Live role above TCG Judge in Server Settings > Roles.';
    mount(server => routes(server, { dto: rolesDto({ roles: [role('organizer'), role('judge', { problem: 'above-bot', problemText: text })] }) }));
    const judge = await roleRegion('TCG Judge');
    expect(judge.getByRole('alert')).toHaveTextContent(text);
    expect(judge.getByText('Needs attention')).toBeInTheDocument();
    expect(judge.queryByRole('textbox', { name: /Search members to add/ })).toBeNull();
    expect((await roleRegion('TCG Organizer')).getByRole('textbox', { name: /Search members to add/ })).toBeInTheDocument();
  });

  it('says when the member list may be incomplete', async () => {
    mount(server => routes(server, { dto: rolesDto({ roles: [role('organizer', { membersComplete: false }), role('judge')] }) }));
    const organizer = await roleRegion('TCG Organizer');
    expect(organizer.getByRole('status')).toHaveTextContent('List may be incomplete');
    expect((await roleRegion('TCG Judge')).queryByText(/List may be incomplete/)).toBeNull();
  });

  it('shows a prominent Create TCG roles call to action until the roles exist, then creates them', async () => {
    const user = userEvent.setup();
    const state = { dto: rolesDto({ roles: [absent('organizer'), absent('judge')] }) };
    const { server } = mount(srv => {
      routes(srv, state);
      srv.always('POST /admin-tools/tournament-roles/ensure', () => {
        state.dto = rolesDto();
        return json(200, { organizer: 'created', judge: 'created', assigned: OWNER, problem: null });
      });
    });
    const cta = await roleRegion('Create TCG roles');
    expect(cta.getByText(CREATE_ROLES_EXPLANATION)).toBeInTheDocument();
    expect(screen.getAllByText('Not created')).toHaveLength(2);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    await user.click(cta.getByRole('button', { name: 'Create TCG roles' }));
    await waitFor(() => expect(server.callsTo('POST /admin-tools/tournament-roles/ensure')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Create TCG roles' })).toBeNull());
    expect(await screen.findByRole('radiogroup', { name: 'Colour for TCG Organizer' })).toBeInTheDocument();
  });

  it('offers Create TCG roles for a deleted role and stops editing it', async () => {
    const user = userEvent.setup();
    const state = { dto: rolesDto({ roles: [role('organizer'), role('judge', { problem: 'missing',
      problemText: 'TCG Judge was deleted in Discord. Use Create TCG roles to make it again.' })] }) };
    const { server } = mount(srv => {
      routes(srv, state);
      srv.always('POST /admin-tools/tournament-roles/ensure', () => { state.dto = rolesDto(); return json(200, { organizer: 'adopted', judge: 'created', assigned: OWNER, problem: null }); });
    });
    const judge = await roleRegion('TCG Judge');
    expect(judge.getByRole('alert')).toHaveTextContent('Use Create TCG roles');
    expect(judge.queryByRole('radiogroup')).toBeNull();
    expect(judge.queryByRole('button', { name: /Rename/ })).toBeNull();
    expect(judge.queryByRole('textbox')).toBeNull();
    await user.click((await roleRegion('Create TCG roles')).getByRole('button', { name: 'Create TCG roles' }));
    await waitFor(() => expect(server.callsTo('POST /admin-tools/tournament-roles/ensure')).toHaveLength(1));
    expect(await screen.findByText('The roles are ready.')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('region', { name: 'Create TCG roles' })).toBeNull();
  });

  it('warns, and does not say ready, when the roles exist but the organizer was not assigned', async () => {
    const user = userEvent.setup();
    const state = { dto: rolesDto({ roles: [absent('organizer'), absent('judge')] }) };
    mount(srv => {
      routes(srv, state);
      srv.always('POST /admin-tools/tournament-roles/ensure', () => { state.dto = rolesDto(); return json(200, { organizer: 'created', judge: 'created',
        assigned: null, problem: 'The organizer is not in this server.' }); });
    });
    await user.click((await roleRegion('Create TCG roles')).getByRole('button', { name: 'Create TCG roles' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Create TCG roles' })).toBeNull());
    const warning = await screen.findByText(/The roles exist, but the organizer was not assigned/);
    expect(warning).toHaveAttribute('role', 'alert');
    expect(warning).toHaveTextContent('The organizer is not in this server.');
    expect(screen.queryByText('The roles are ready.')).toBeNull();
  });

  it('reports a failed creation', async () => {
    const user = userEvent.setup();
    const { server } = mount(srv => {
      routes(srv, { dto: rolesDto({ roles: [absent('organizer'), absent('judge')] }) });
      srv.always('POST /admin-tools/tournament-roles/ensure', () => json(200, { organizer: 'failed', judge: 'failed', assigned: null,
        problem: 'Discord refused: Missing Permissions.' }));
    });
    const cta = await roleRegion('Create TCG roles');
    await user.click(cta.getByRole('button', { name: 'Create TCG roles' }));
    expect(await cta.findByRole('alert')).toHaveTextContent('Discord refused: Missing Permissions.');
    expect(server.callsTo('POST /admin-tools/tournament-roles/ensure')).toHaveLength(1);
  });

  it('disables creation when the bot lacks Manage Roles', async () => {
    mount(srv => routes(srv, { dto: rolesDto({ roles: [absent('organizer'), absent('judge')], canManageRoles: false }) }));
    const cta = await roleRegion('Create TCG roles');
    expect(cta.getByRole('button', { name: 'Create TCG roles' })).toBeDisabled();
    expect(cta.getByText(/needs the Manage Roles permission/)).toBeInTheDocument();
  });

  it('is read-only without server.manage', async () => {
    mount(srv => routes(srv, { dto: rolesDto() }, false));
    const judge = await roleRegion('TCG Judge');
    expect(judge.queryByRole('button', { name: /Rename/ })).toBeNull();
    expect(judge.queryByRole('textbox')).toBeNull();
    expect(judge.getAllByRole('radio')[0]).toBeDisabled();
    expect((await roleRegion('TCG Organizer')).queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('surfaces a failed save inside the role', async () => {
    const user = userEvent.setup();
    mount(srv => {
      routes(srv, { dto: rolesDto() });
      srv.always('PATCH /admin-tools/tournament-roles/judge', () => json(409, { error: { code: 'rule', message: 'The role no longer exists.' } }));
    });
    const group = within(await screen.findByRole('radiogroup', { name: 'Colour for TCG Judge' }));
    await user.click(group.getByRole('radio', { name: 'Red' }));
    expect(await screen.findByText('The role no longer exists.')).toBeInTheDocument();
  });
});
