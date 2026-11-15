import { CAPABILITIES, DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type GuildMetaDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../../app/testing';
import { AdminDataProvider } from '../../../data';
import { json, type FakeServer } from '../../../data/test/fakes';
import type { AnnouncementView, SaveAnnouncementBody } from './api';
import { AnnouncementsTab } from './AnnouncementsTab';
import { DiscordPreview } from './DiscordPreview';
import { bodyProblems, embedProblems, emptyEmbed, parseMarkdown } from './embed';

MotionGlobalConfig.skipAnimations = true;

const guildId = '100000000000000001';
const guild: GuildMetaDto = { guildId, name: 'Demo', memberCount: 3, emojis: [],
  roles: [{ id: guildId, name: '@everyone', color: 0, position: 0, managed: false, aboveBot: false },
    { id: '200000000000000203', name: 'Player', color: 0, position: 3, managed: false, aboveBot: false },
    { id: '200000000000000201', name: 'Admin', color: 0, position: 6, managed: false, aboveBot: true }],
  channels: [{ id: '200000000000000307', name: 'announcements', type: 'announcement', parentId: null, position: 0, reserved: false }] };

const view = (patch: Partial<AnnouncementView> = {}): AnnouncementView => ({ id: '00000000-0000-4000-8000-000000000001', guildId,
  channelId: '200000000000000307', body: { content: null, embed: { ...emptyEmbed(), title: 'Season 3 kickoff' } }, mentionRoleIds: [],
  mentionEveryone: false, scheduledAtMs: null, status: 'sent', messageId: '300000000000000001', sentAtMs: 1, error: null, createdAtMs: 1,
  updatedAtMs: 1, missed: false, ...patch });

function routes(server: FakeServer, list: AnnouncementView[] = []) {
  server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...CAPABILITIES], adminTools: true }));
  server.always('GET /admin-tools/settings', () => json(200, { guildId, version: 0, updatedAtMs: null,
    ...structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto }));
  server.always('GET /admin-tools/guild', () => json(200, guild));
  server.always('GET /admin-tools/announcements', () => json(200, { announcements: list }));
}
function mount(setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  render(<AdminDataProvider data={harness.data}><AnnouncementsTab /></AdminDataProvider>);
  return harness;
}

describe('embed helpers', () => {
  it('flags Discord limits and http images', () => {
    expect(embedProblems({ ...emptyEmbed(), title: 't'.repeat(257) }).title).toMatch(/257\/256/);
    expect(embedProblems({ ...emptyEmbed(), description: 'd'.repeat(4097) }).description).toBeTruthy();
    expect(embedProblems({ ...emptyEmbed(), title: 'x', fields: Array(26).fill({ name: 'a', value: 'b', inline: false }) }).fields).toMatch(/25/);
    expect(embedProblems({ ...emptyEmbed(), description: 'd'.repeat(4000), fields: Array(3).fill({ name: 'n'.repeat(200), value: 'v'.repeat(600), inline: false }) }).total)
      .toMatch(/6000/);
    expect(embedProblems({ ...emptyEmbed(), title: 'x', imageUrl: 'http://x.test/a.png' }).imageUrl).toMatch(/https/);
    expect(embedProblems(emptyEmbed()).empty).toBeTruthy();
    expect(bodyProblems({ content: 'hi', embed: null })).toEqual([]);
  });

  it('parses markdown into safe tokens', () => {
    expect(parseMarkdown('**bold** and [site](https://x.test) <b>')).toEqual([
      { kind: 'bold', children: [{ kind: 'text', text: 'bold' }] }, { kind: 'text', text: ' and ' },
      { kind: 'link', text: 'site', href: 'https://x.test' }, { kind: 'text', text: ' <b>' }]);
    expect(parseMarkdown('[bad](javascript:alert(1))')[0]).toEqual({ kind: 'text', text: '[bad](javascript:alert(1))' });
  });

  it('renders a Discord-like preview with mentions, markdown, fields and https images only', () => {
    render(<DiscordPreview content="Hello" mentionEveryone mentionRoleIds={['200000000000000203']} roles={guild.roles}
      embed={{ ...emptyEmbed(), title: 'Title', description: '**Bold** text', color: 0xff0000, imageUrl: 'http://insecure.test/a.png',
        thumbnailUrl: 'https://ok.test/t.png', fields: [{ name: 'F1', value: 'v1', inline: true }, { name: 'F2', value: 'v2', inline: true }] }} />);
    const preview = screen.getByRole('figure', { name: 'Discord preview' });
    expect(within(preview).getByText('@everyone')).toBeInTheDocument();
    expect(within(preview).getByText('@Player')).toBeInTheDocument();
    expect(within(preview).getByText('Bold').tagName).toBe('STRONG');
    expect(within(preview).getByText('F2')).toBeInTheDocument();
    expect(within(preview).queryByAltText('Embed image')).toBeNull();
    expect(within(preview).getByAltText('Thumbnail')).toHaveAttribute('src', 'https://ok.test/t.png');
    expect(within(preview).getByTestId('embed')).toHaveStyle({ borderLeftColor: '#ff0000' });
  });
});

describe('Announcements tab', () => {
  it('sends with no mentions by default and shows the title in the live preview', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server);
      server.once('POST /admin-tools/announcements', call => json(201, view({ body: (call.body as SaveAnnouncementBody).body })));
    });
    const composer = await screen.findByRole('region', { name: 'Compose announcement' });
    await waitFor(() => expect(within(composer).getByRole('option', { name: '#announcements' })).toBeInTheDocument());
    await user.selectOptions(within(composer).getAllByRole('combobox')[0]!, '200000000000000307');
    await user.type(within(composer).getByLabelText('Title'), 'Season 3 kickoff');
    expect(within(screen.getByRole('figure', { name: 'Discord preview' })).getByText('Season 3 kickoff')).toBeInTheDocument();
    expect(within(composer).getByRole('switch', { name: 'Ping @everyone' })).not.toBeChecked();
    await user.click(within(composer).getByRole('button', { name: 'Send now' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/Nobody is pinged/);
    expect(harness.server.callsTo('POST /admin-tools/announcements')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/announcements')).toHaveLength(1));
    const sent = harness.server.callsTo('POST /admin-tools/announcements')[0]!.body as SaveAnnouncementBody;
    expect(sent.mentionRoleIds).toEqual([]);
    expect(sent.mentionEveryone).toBe(false);
    expect(sent.scheduledAtMs).toBeNull();
    expect(sent.body.embed!.title).toBe('Season 3 kickoff');
  });

  it('blocks sending while the embed is over the limits', async () => {
    const user = userEvent.setup();
    mount(server => routes(server));
    const composer = await screen.findByRole('region', { name: 'Compose announcement' });
    await user.click(within(composer).getByLabelText('Title'));
    await user.paste('t'.repeat(257));
    expect(within(composer).getAllByText(/257\/256/).length).toBeGreaterThan(0);
    expect(within(composer).getByRole('button', { name: 'Send now' })).toBeDisabled();
  });

  it('schedules with a chosen role mention', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server);
      server.once('POST /admin-tools/announcements', () => json(201, view({ status: 'scheduled' })));
    });
    const composer = await screen.findByRole('region', { name: 'Compose announcement' });
    await waitFor(() => expect(within(composer).getByRole('option', { name: '#announcements' })).toBeInTheDocument());
    await user.selectOptions(within(composer).getAllByRole('combobox')[0]!, '200000000000000307');
    await user.type(within(composer).getByLabelText('Title'), 'Later');
    await user.click(within(composer).getByRole('checkbox', { name: '@Player' }));
    await user.click(within(composer).getByRole('switch', { name: 'Schedule for later' }));
    const future = new Date(Date.now() + 86_400_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    await user.type(within(composer).getByLabelText('Send at'),
      `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T10:00`);
    await user.click(within(composer).getByRole('button', { name: 'Schedule' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/Pings @/);
    await user.click(within(confirm).getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(harness.server.callsTo('POST /admin-tools/announcements')).toHaveLength(1));
    const body = harness.server.callsTo('POST /admin-tools/announcements')[0]!.body as SaveAnnouncementBody;
    expect(body.mentionRoleIds).toEqual(['200000000000000203']);
    expect(body.scheduledAtMs).toBeGreaterThan(Date.now());
  });

  it('lists history with missed and sent entries, and deletes after confirming', async () => {
    const user = userEvent.setup();
    const harness = mount(server => {
      routes(server, [view(), view({ id: '00000000-0000-4000-8000-000000000002', status: 'failed', missed: true, messageId: null,
        error: 'Missed: the bot was offline at the scheduled time.', body: { content: 'Old news', embed: null } })]);
      server.once('DELETE /admin-tools/announcements/00000000-0000-4000-8000-000000000001', () => json(200, { deleted: true, messageDeleted: true }));
    });
    const history = await screen.findByRole('region', { name: 'Announcement history' });
    expect(await within(history).findByText('Missed')).toBeInTheDocument();
    expect(within(history).getByText(/offline at the scheduled time/)).toBeInTheDocument();
    await user.click(within(history).getAllByRole('button', { name: 'Delete' })[0]!);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(harness.server.callsTo('DELETE /admin-tools/announcements/00000000-0000-4000-8000-000000000001')).toHaveLength(1));
  });
});
