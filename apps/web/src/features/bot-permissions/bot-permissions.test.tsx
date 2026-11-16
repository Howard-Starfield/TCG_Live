import { CAPABILITIES, type PermissionReportDto, type SetupCheckDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, renderConsole, sessionFixture } from '../../app/testing';
import { AdminDataProvider } from '../../data';
import { json, type FakeServer } from '../../data/test/fakes';
import { PERMISSION_BANNER_KEY } from '../shell/Banners';
import { BotPermissionsCard } from './BotPermissionsCard';
import { BotSetupGuide, DEVELOPER_PORTAL_URL } from './BotSetupGuide';
import { groupIssues } from './PermissionIssues';

MotionGlobalConfig.skipAnimations = true;

const INVITE = 'https://discord.com/oauth2/authorize?client_id=100000000000000999&scope=bot%20applications.commands&permissions=268435456&guild_id=1&disable_guild_select=true';
const INVITE_ALL = 'https://discord.com/oauth2/authorize?client_id=100000000000000999&scope=bot%20applications.commands&permissions=1&guild_id=1&disable_guild_select=true';

const report = (patch: Partial<PermissionReportDto> = {}): PermissionReportDto => ({
  checkedAtMs: Date.UTC(2026, 10, 15, 12, 0), ok: false, inviteUrl: INVITE, inviteUrlAll: INVITE_ALL,
  permissionsInteger: '268435456', permissionsIntegerAll: '1', botRoleName: 'TCG Live', unavailable: null,
  issues: [
    { severity: 'blocking', kind: 'permission', featureId: 'roles.manage', feature: 'Roles', permission: 'Manage Roles',
      scope: { kind: 'guild' }, why: 'The bot cannot add or remove roles.', fix: 'Use "Grant missing permissions" and authorize the bot again.' },
    { severity: 'blocking', kind: 'hierarchy', featureId: 'roles.hierarchy', feature: 'Roles', permission: 'Role order',
      scope: { kind: 'role', id: '5', name: 'Admin' }, why: 'The bot can only give roles below its own highest role.',
      fix: 'In Server Settings → Roles, drag TCG Live above @Admin.' },
    { severity: 'warning', kind: 'overwrite', featureId: 'stickies.embed', feature: 'Sticky messages', permission: 'Embed Links',
      scope: { kind: 'channel', id: '6', name: 'general' }, why: 'The sticky\'s embed may not be shown.', fix: 'Edit #general → Permissions.' }
  ],
  ...patch
});

function mount(setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...CAPABILITIES], adminTools: true }));
    setup(server);
  } });
  render(<AdminDataProvider data={harness.data}><BotPermissionsCard /></AdminDataProvider>);
  return harness;
}

afterEach(() => { window.sessionStorage.clear(); });

describe('Bot permissions card', () => {
  it('shows the OK state', async () => {
    mount(server => server.always('GET /admin-tools/permissions', () => json(200, report({ ok: true, issues: [] }))));
    expect(await screen.findByText('The bot has every permission your enabled features need.')).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Bot permissions' });
    expect(within(card).getByText('OK')).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Grant missing permissions/ })).not.toBeInTheDocument();
  });

  it('groups issues by feature, links the invite safely, notes role order and re-checks', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      server.always('GET /admin-tools/permissions', () => json(200, report()));
      server.always('POST /admin-tools/permissions/recheck', () => json(200, report({ ok: true, issues: [] })));
    });
    expect(await screen.findByRole('region', { name: 'Roles' })).toHaveTextContent('Manage Roles');
    expect(screen.getByRole('region', { name: 'Sticky messages' })).toHaveTextContent('#general');
    expect(screen.getByText('2 blocking')).toBeInTheDocument();
    const grant = screen.getByRole('link', { name: /Grant missing permissions in Discord/ });
    expect(grant).toHaveAttribute('href', INVITE);
    expect(grant).toHaveAttribute('target', '_blank');
    expect(grant).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: /Grant permissions for all features/ })).toHaveAttribute('href', INVITE_ALL);
    expect(screen.getByText(/re-authorizing updates the bot's own role/)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('drag TCG Live above @Admin in Server Settings → Roles');
    await user.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(await screen.findByText('The bot has every permission your enabled features need.')).toBeInTheDocument();
    expect(harness.server.callsTo('POST /admin-tools/permissions/recheck')).toHaveLength(1);
  });

  it('explains when the check cannot run', async () => {
    mount(server => server.always('GET /admin-tools/permissions', () => json(200, report({ issues: [], checkedAtMs: null,
      unavailable: 'Discord is not connected or did not answer. Re-check when the bot is online.' }))));
    expect(await screen.findByText(/Discord is not connected/)).toBeInTheDocument();
  });

  it('groups in server order', () => {
    expect(groupIssues(report().issues).map(group => [group.feature, group.issues.length])).toEqual([['Roles', 2], ['Sticky messages', 1]]);
  });
});

describe('Bot setup guide', () => {
  it('is collapsed until opened, then lists the steps with safe external links', async () => {
    const user = userEvent.setup();
    render(<BotSetupGuide inviteUrl={INVITE} />);
    const toggle = screen.getByRole('button', { name: /Bot setup guide/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    const steps = await screen.findByRole('list', { name: 'Bot setup steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(6);
    expect(steps).toHaveTextContent('DISCORD_BOT_TOKEN');
    expect(steps).toHaveTextContent('Presence Intent is not needed');
    expect(steps).toHaveTextContent('Server Members Intent');
    expect(steps).toHaveTextContent('Message Content Intent');
    const portal = within(steps).getByRole('link', { name: /discord.com\/developers\/applications/ });
    expect(portal).toHaveAttribute('href', DEVELOPER_PORTAL_URL);
    expect(portal).toHaveAttribute('rel', 'noopener noreferrer');
    const invite = within(steps).getByRole('link', { name: /Open the invite link/ });
    expect(invite).toHaveAttribute('href', INVITE);
    expect(invite).toHaveAttribute('target', '_blank');
  });
});

describe('permission banner', () => {
  const adminSession = (server: FakeServer) =>
    server.always('GET /session', () => json(200, { ...sessionFixture, adminTools: true }));
  const permissions = { checkedAtMs: 1, blocking: 2, warnings: 1 };

  it('shows blocking issues, opens Admin tools, and stays dismissed for the session', async () => {
    const user = userEvent.setup();
    renderConsole({ status: { permissions }, setup: adminSession });
    const banner = await waitFor(() => {
      const found = document.querySelector('[data-banner="permissions"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(banner).toHaveTextContent('The bot is missing permissions (2 blocking).');
    await user.click(within(banner).getByRole('button', { name: 'Dismiss for this session' }));
    await waitFor(() => expect(document.querySelector('[data-banner="permissions"]')).toBeNull());
    expect(window.sessionStorage.getItem(PERMISSION_BANNER_KEY)).toBe('2');
  });

  it('is hidden without blocking issues or without admin tools access', async () => {
    renderConsole({ status: { permissions: { ...permissions, blocking: 0 } }, setup: adminSession });
    await screen.findByRole('region', { name: 'Status' });
    expect(document.querySelector('[data-banner="permissions"]')).toBeNull();
  });

  it('links to Admin tools → Settings', async () => {
    const user = userEvent.setup();
    renderConsole({ status: { permissions }, setup: server => {
      adminSession(server);
      server.always('GET /admin-tools/permissions', () => json(200, report()));
    } });
    const banner = await waitFor(() => {
      const found = document.querySelector('[data-banner="permissions"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await user.click(within(banner).getByRole('button', { name: 'Review in Admin tools' }));
    expect(await screen.findByRole('heading', { name: 'Admin tools' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Bot permissions' })).toBeInTheDocument();
  });
});

describe('setup readiness', () => {
  it('shows the permission issues and the invite link', async () => {
    const user = userEvent.setup();
    const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444', '555555555555555555'];
    const check: SetupCheckDto = { valid: false, frozen: false, botName: 'Bot', issues: ['Grant the bot the missing permissions shown for each channel.'],
      guide: 'guide', notice: 'cannot_post', capabilities: [
        { slot: 'signup', channelId: ids[1]!, channelName: 'signup', missing: ['Embed Links'] },
        { slot: 'rooms', channelId: ids[2]!, channelName: 'Matches', missing: ['Manage Channels'] }],
      permissions: report({ issues: [{ severity: 'blocking', kind: 'permission', featureId: 'tournament.signup', feature: 'Tournament',
        permission: 'Embed Links', scope: { kind: 'channel', id: ids[1]!, name: 'signup' },
        why: 'The bot cannot post or update the signup, check-in and match cards.', fix: 'Use "Grant missing permissions".' }] }) };
    const selection = { guildId: ids[0]!, channelId: ids[1]!, matchChannels: null, matchRooms: { categoryId: ids[2]!, createCategory: false },
      adminId: ids[4]!, publicMatchRooms: true };
    renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, setup: true }));
      server.always('GET /setup', () => json(200, { prerequisite: null, activeEventId: null, selection, frozen: false, botName: 'Bot',
        check: null, openingDashboard: false }));
      server.always('GET /setup/guilds', () => json(200, [{ id: ids[0]!, name: 'TCG Test', ownerId: ids[4]! }]));
      server.always('GET /setup/channels', () => json(200, [
        { id: ids[1]!, name: 'signup', category: null, type: 'text' },
        { id: ids[2]!, name: 'Matches', category: null, type: 'category' }]));
      server.always('POST /setup/check', () => json(200, check));
    } });
    expect(await screen.findByRole('button', { name: /Bot setup guide/ })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Next: channels' }));
    await user.click(await screen.findByRole('button', { name: 'Check readiness' }));
    const section = await screen.findByRole('region', { name: 'Bot permissions' });
    expect(within(section).getByRole('region', { name: 'Tournament' })).toHaveTextContent('Embed Links');
    expect(screen.getByText('Missing: Manage Channels')).toBeInTheDocument();
    const grant = within(section).getByRole('link', { name: /Grant missing permissions in Discord/ });
    expect(grant).toHaveAttribute('href', INVITE);
    expect(grant).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
