import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType, Collection, PermissionFlagsBits, type Client } from 'discord.js';
import { discordSetupDiscovery } from './discord.js';

const guildId = '111111111111111111';
const textId = '222222222222222222';
const voiceId = '333333333333333333';
const adminId = '444444444444444444';
const botId = '555555555555555555';
const fileId = '666666666666666666';

function fixture(allowed: bigint[]) {
  const calls: string[] = [];
  const sends: unknown[] = [];
  const edits: unknown[] = [];
  let authorId = botId;
  let attachmentUrl = `https://cdn.discordapp.com/attachments/${textId}/${fileId}/tcg-notice-v1.gif?signature=private`;
  let messageId = fileId;
  const permissionsFor = () => ({ has(flags: bigint | bigint[]) {
    return (Array.isArray(flags) ? flags : [flags]).every(flag => allowed.includes(flag));
  } });
  const text = { id: textId, guildId, type: ChannelType.GuildText, name: 'signup', parent: null,
    permissionsFor, async send(options: unknown) { sends.push(options); return { id: fileId }; },
    messages: { async fetch() { calls.push('message-fetch'); return {
      id: messageId, author: { id: authorId }, attachments: new Collection(),
      embeds: [{ thumbnail: { url: attachmentUrl } }],
      async edit(options: unknown) { edits.push(options); }
    }; } } };
  const voice = { id: voiceId, guildId, type: ChannelType.GuildVoice, name: 'TCG Match 1',
    parent: null, permissionsFor };
  const all = new Collection([[textId, text], [voiceId, voice]]);
  const guild = { id: guildId, name: 'TCG Test', ownerId: adminId, afkChannelId: null,
    roles: { async fetch() { calls.push('roles-fetch'); } },
    members: { async fetchMe(options: unknown) { calls.push(`member-fetch:${JSON.stringify(options)}`); return { id: botId }; } },
    channels: { async fetch(id?: string) { calls.push(id ? `channel-fetch:${id}` : 'channel-list');
      return id ? all.get(id) : all;
    } } };
  const client = { user: { id: botId, username: 'BoBoAssist' }, application: { id: botId },
    guilds: { cache: new Collection([[guildId, guild]]), async fetch() { return guild; } },
    channels: { async fetch() { calls.push('direct-channel-fetch'); return text; } } } as unknown as Client;
  return { client, calls, sends, edits, setAuthor(id: string) { authorId = id; },
    setThumbnail(url: string) { attachmentUrl = url; }, setMessage(id: string) { messageId = id; } };
}

test('discovery refreshes roles and self member while listing channels in one fresh guild read', async () => {
  const f = fixture([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  const discovery = discordSetupDiscovery(f.client);
  const channels = await discovery.channels(guildId);
  assert.deepEqual(channels.map(channel => channel.name), ['signup', 'TCG Match 1']);
  assert.equal(f.calls.filter(call => call === 'channel-list').length, 1);
  assert.equal(f.calls.filter(call => call.startsWith('channel-fetch:')).length, 0);
  assert(f.calls.includes('roles-fetch'));
  assert(f.calls.includes('member-fetch:{"force":true}'));
  assert.equal(channels[0]?.permissions.includes('Manage Permissions'), false);
});

test('guide falls back to plain text, mentions organizer only on new warning and refuses foreign edits', async () => {
  const f = fixture([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  const discovery = discordSetupDiscovery(f.client);
  const id = await discovery.guide(textId, adminId, 'Setup needs attention.', null, true);
  assert.equal(id, fileId);
  const sent = f.sends[0] as { content: string; embeds: unknown[]; allowedMentions: { parse: []; users: string[] } };
  assert.match(sent.content, new RegExp(`<@${adminId}>`));
  assert.deepEqual(sent.embeds, []);
  assert.deepEqual(sent.allowedMentions, { parse: [], users: [adminId] });
  await discovery.guide(textId, adminId, 'Setup ready.', id, false);
  const edited = f.edits[0] as { content: string; attachments: unknown[]; allowedMentions: { users: string[] } };
  assert.equal(edited.content, 'Setup ready.');
  assert.deepEqual(edited.attachments, []);
  assert.deepEqual(edited.allowedMentions.users, []);
  f.setAuthor('777777777777777777');
  await assert.rejects(() => discovery.guide(textId, adminId, 'Do not edit.', id, false), /no longer bot-authored/);
  assert.equal(f.edits.length, 1);
});

test('rich guide retains only matching owned embed upload and replaces a foreign thumbnail', async () => {
  const f = fixture([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles]);
  const discovery = discordSetupDiscovery(f.client);
  await discovery.guide(textId, adminId, 'Setup ready.', fileId, false);
  const retained = f.edits[0] as { files?: unknown; attachments?: unknown;
    embeds: Array<{ thumbnail: { url: string } }> };
  assert.equal(retained.files, undefined);
  assert.equal(retained.attachments, undefined);
  assert.equal(retained.embeds[0]?.thumbnail.url, 'attachment://tcg-notice-v1.gif');
  f.setThumbnail(`https://cdn.discordapp.com/attachments/${voiceId}/${fileId}/tcg-notice-v1.gif`);
  await discovery.guide(textId, adminId, 'Setup ready.', fileId, false);
  const replaced = f.edits[1] as { files: Array<{ name: string }>; attachments: unknown[] };
  assert.deepEqual(replaced.attachments, []);
  assert.deepEqual(replaced.files.map(file => file.name), ['tcg-notice-v1.gif']);
});
