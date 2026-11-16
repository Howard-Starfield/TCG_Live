import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type AdminToolsSettingsDto,
  type AdminToolsStatusDto, type Capability, type GuildMetaDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createHarness, renderConsole, sessionFixture } from '../../app/testing';
import { ToastProvider } from '../../ui';
import { AdminDataProvider } from '../../data';
import { json, type FakeServer } from '../../data/test/fakes';
import { AdminToolsPage } from './AdminToolsPage';
import { adminToolsTabs, visibleAdminToolsTabs, type AdminToolsTab } from './registry';

MotionGlobalConfig.skipAnimations = true;

const guildId = '100000000000000001';
const body = (): AdminToolsSettingsBodyDto => structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
const settings = (version = 0, patch: Partial<AdminToolsSettingsBodyDto> = {}): AdminToolsSettingsDto =>
  ({ guildId, version, updatedAtMs: version ? 1 : null, ...body(), ...patch });
const status = (patch: Partial<AdminToolsStatusDto> = {}): AdminToolsStatusDto => ({
  runtime: 'running', privilegedIntents: { guildMembers: 'off', messageContent: 'off' },
  wantedIntents: { guildMembers: false, messageContent: false }, restartRequired: false, restartReason: null, features: [], ...patch });
const guild: GuildMetaDto = { guildId, name: 'Demo', memberCount: 3, emojis: [],
  roles: [{ id: guildId, name: '@everyone', color: 0, position: 0, managed: false, aboveBot: false }],
  channels: [{ id: '200000000000000302', name: 'general', type: 'text', parentId: null, position: 0, reserved: false },
    { id: '200000000000000303', name: 'tournament-signup', type: 'text', parentId: null, position: 1, reserved: true },
    { id: '200000000000000305', name: 'mod-log', type: 'text', parentId: null, position: 2, reserved: false }] };

function routes(server: FakeServer, capabilities: readonly Capability[] = CAPABILITIES) {
  server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...capabilities], adminTools: true }));
  server.always('GET /admin-tools/settings', () => json(200, settings()));
  server.always('GET /admin-tools/status', () => json(200, status()));
  server.always('GET /admin-tools/guild', () => json(200, guild));
}

function mountWith(ui: ReactNode, setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  render(<ToastProvider><AdminDataProvider data={harness.data}>{ui}</AdminDataProvider></ToastProvider>);
  return harness;
}

describe('admin tools tab registry', () => {
  it('lists the initial tabs once each, with Settings last', () => {
    const ids = adminToolsTabs.map(tab => tab.id);
    expect(ids).toEqual(['members', 'bans', 'cases', 'stickies', 'channels', 'tickets', 'roles', 'announcements', 'lfg', 'bots', 'rooms', 'logs', 'settings']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hides tabs whose capability the session lacks', () => {
    const can = (capability: Capability) => capability === 'members.read';
    expect(visibleAdminToolsTabs(can).map(tab => tab.id)).not.toContain('stickies');
    expect(visibleAdminToolsTabs(can).map(tab => tab.id)).toContain('members');
  });
});

describe('Admin tools page', () => {
  it('renders registry tabs and switches between them', async () => {
    const user = userEvent.setup();
    const probe: AdminToolsTab = { id: 'probe', label: 'Probe', icon: adminToolsTabs[0]!.icon, capability: 'members.read',
      Component: () => <p>probe body</p> };
    mountWith(<AdminToolsPage tabs={[...adminToolsTabs, probe]} />, server => routes(server));
    expect(await screen.findByRole('textbox', { name: 'Search members' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Admin tools' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Probe/ }));
    expect(screen.getByText('probe body')).toBeInTheDocument();
  });

  it('shows privileged-intent status, Developer Portal guidance and restart required', async () => {
    mountWith(<AdminToolsPage initialTab="settings" />, server => {
      routes(server);
      server.always('GET /admin-tools/status', () => json(200, status({
        privilegedIntents: { guildMembers: 'missing', messageContent: 'off' },
        wantedIntents: { guildMembers: true, messageContent: false }, restartRequired: true,
        restartReason: 'Discord refused the Server Members Intent.',
        features: [{ name: 'admin-tools', state: 'intent-missing', missingIntents: ['guildMembers'] }] })));
    });
    const card = await screen.findByRole('region', { name: 'Bot status' });
    expect(within(card).getByText('Refused by Discord')).toBeInTheDocument();
    expect(within(card).getByText(/Developer Portal/)).toBeInTheDocument();
    expect(within(card).getByText(/Restart required/)).toBeInTheDocument();
    expect(within(card).getByText('admin-tools: missing an intent (Server Members Intent)')).toBeInTheDocument();
  });

  it('saves a settings section and keeps edits aside on a 409', async () => {
    const user = userEvent.setup();
    const harness = mountWith(<AdminToolsPage initialTab="settings" />, server => {
      routes(server);
      server.once('PUT /admin-tools/settings', () => json(409, { error: { code: 'conflict', message: 'Changed elsewhere.' },
        current: settings(4, { cases: { dmMembers: true, logChannelId: '200000000000000302' } }) }));
      server.once('PUT /admin-tools/settings', call => json(200, { ...settings(5), ...(call.body as { settings: object }).settings }));
    });
    const section = await screen.findByRole('region', { name: 'Cases' });
    await user.click(within(section).getByRole('switch'));
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    expect(await within(section).findByText(/changed elsewhere/i)).toBeInTheDocument();
    const first = harness.server.callsTo('PUT /admin-tools/settings')[0]!.body as { expectedVersion: number; settings: AdminToolsSettingsBodyDto };
    expect(first.expectedVersion).toBe(0);
    expect(first.settings.cases.dmMembers).toBe(false);
    // The server's state is shown; reapplying puts the edit back on top of version 4 only for this section.
    expect(within(section).getByText(/Version 4/)).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Reapply my edits' }));
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(harness.server.callsTo('PUT /admin-tools/settings')).toHaveLength(2));
    const second = harness.server.callsTo('PUT /admin-tools/settings')[1]!.body as { expectedVersion: number; settings: AdminToolsSettingsBodyDto };
    expect(second.expectedVersion).toBe(4);
    expect(second.settings.cases).toEqual({ dmMembers: false, logChannelId: null });
    expect(await within(section).findByText(/Version 5/)).toBeInTheDocument();
  });

  it('a read-only session sees the settings without a Save button', async () => {
    mountWith(<AdminToolsPage initialTab="settings" />, server => routes(server, ['dashboard.read', 'members.read']));
    const section = await screen.findByRole('region', { name: 'Cases' });
    expect(within(section).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Stickies/ })).toBeNull();
  });
});

describe('shell entry', () => {
  it('opens the Admin tools page from the sidebar only when the runtime mounts it', async () => {
    const user = userEvent.setup();
    renderConsole({ setup: server => routes(server) });
    const sidebar = await screen.findByRole('complementary', { name: 'Sidebar' });
    await user.click(await within(sidebar).findByRole('button', { name: 'Admin tools' }));
    expect(await screen.findByRole('heading', { name: 'Admin tools' })).toBeInTheDocument();
    await user.click(within(sidebar).getByRole('button', { name: 'Home' }));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
  });

  it('has no Admin tools entry without the session flag', async () => {
    renderConsole();
    const sidebar = await screen.findByRole('complementary', { name: 'Sidebar' });
    await within(sidebar).findByRole('button', { name: 'Home' });
    expect(within(sidebar).queryByRole('button', { name: 'Admin tools' })).toBeNull();
  });
});
